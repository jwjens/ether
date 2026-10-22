// electron/file-lockers-win.js — WHICH PROCESS HOLDS THESE FILES (Windows Restart Manager, the API Windows itself uses
// for "this file is in use by …"). Asked only when a database swap finds -wal/-shm still locked, so the message names
// the holder instead of guessing. Jeff, 2026-10-21: the old message blamed "something outside Ether" when it was Ether.
// → [{ pid, process, app }]; [] when nothing is reported, the check is unavailable, or this is not Windows. Never throws.
"use strict";
const { execFile } = require("child_process");

const RM_CS = `
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class EtherRm {
  [StructLayout(LayoutKind.Sequential)] struct UP { public int pid; public System.Runtime.InteropServices.ComTypes.FILETIME start; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct PI {
    public UP p; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string app;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string svc; public int type; public uint status; public uint session;
    [MarshalAs(UnmanagedType.Bool)] public bool restartable; }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint h, int f, string key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint nf, string[] f, uint na, UP[] a, uint ns, string[] s);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint need, ref uint n, [In, Out] PI[] info, ref uint why);
  public static string Who(string[] files) {
    uint h; var outp = new List<string>();
    if (RmStartSession(out h, 0, Guid.NewGuid().ToString()) != 0) return "";
    try {
      if (RmRegisterResources(h, (uint)files.Length, files, 0, null, 0, null) != 0) return "";
      uint need = 0, n = 0, why = 0;
      int r = RmGetList(h, out need, ref n, null, ref why);
      if (r == 234) { var info = new PI[need]; n = need; r = RmGetList(h, out need, ref n, info, ref why);
        if (r == 0) for (int i = 0; i < n; i++) outp.Add(info[i].p.pid + "\\t" + info[i].app); }
    } finally { RmEndSession(h); }
    return string.Join("\\n", outp);
  }
}`;

// The file list arrives in an environment variable (one path per line), never on the command line: no quoting to get wrong.
const PS = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${RM_CS}
'@
$files = $env:ETHER_LOCK_FILES -split "\`n" | Where-Object { $_ }
foreach ($line in ([EtherRm]::Who($files) -split "\`n")) {
  if (-not $line) { continue }
  $pid0, $app = $line -split "\`t", 2
  $name = try { (Get-Process -Id ([int]$pid0)).ProcessName } catch { '' }
  "$pid0\`t$name\`t$app"
}`;

function parse(stdout) {
  return String(stdout || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
    const [pid, proc, app] = l.split("\t");
    return { pid: Number(pid), process: proc || "", app: app || "" };
  }).filter(x => Number.isFinite(x.pid) && x.pid > 0);
}

function whoHolds(files, { timeoutMs = 15000 } = {}) {
  if (process.platform !== "win32" || !files || !files.length) return Promise.resolve([]);
  return new Promise((resolve) => {
    try {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PS],
        { timeout: timeoutMs, windowsHide: true, env: { ...process.env, ETHER_LOCK_FILES: files.join("\n") } },
        (err, stdout) => resolve(err ? [] : parse(stdout)));
    } catch { resolve([]); }
  });
}

/** Is this holder Ether itself? This process, the audio daemon's process, or a process named like Ether's. */
function isEther(h, { selfPid = process.pid, daemonPid = null } = {}) {
  if (h.pid === selfPid || (daemonPid && h.pid === daemonPid)) return true;
  return /^(ether|ether-engine|electron)$/i.test(h.process || "");
}

module.exports = { whoHolds, isEther, parse };
