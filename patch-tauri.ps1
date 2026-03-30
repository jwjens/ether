# patch-tauri.ps1
# Run from C:\openair — patches all remaining @tauri-apps imports in src/components
# Usage: cd C:\openair; .\patch-tauri.ps1

$srcDir = "C:\openair\src"

# ── Helper ────────────────────────────────────────────────────
function Patch($file, $old, $new) {
  $content = Get-Content $file -Raw
  if ($content -match [regex]::Escape($old)) {
    $content.Replace($old, $new) | Set-Content $file -NoNewline
    Write-Host "  PATCHED: $([System.IO.Path]::GetFileName($file))"
  }
}

# ── Shim block we inject at the top of each file ─────────────
# Instead of editing every import individually, we replace the specific
# import lines with inline shims.

$files = Get-ChildItem -Path $srcDir -Recurse -Filter "*.tsx"

foreach ($f in $files) {
  $path = $f.FullName
  $content = Get-Content $path -Raw
  if (-not ($content -match "@tauri-apps")) { continue }

  Write-Host "Patching: $($f.Name)"

  # ── invoke (static import) ───────────────────────────────
  $content = $content -replace 'import \{ invoke \} from "@tauri-apps/api/core";', 'const invoke = (cmd: string, args?: any) => (window as any).ether.invoke(cmd, args);'
  $content = $content -replace "import \{ invoke \} from '@tauri-apps/api/core';", 'const invoke = (cmd: string, args?: any) => (window as any).ether.invoke(cmd, args);'

  # ── invoke (dynamic import) ───────────────────────────────
  $content = $content -replace 'const \{ invoke \} = await import\("@tauri-apps/api/core"\);', 'const invoke = (cmd: string, args?: any) => (window as any).ether.invoke(cmd, args);'
  $content = $content -replace 'const \{ invoke: inv \} = await import\("@tauri-apps/api/core"\);', 'const inv = (cmd: string, args?: any) => (window as any).ether.invoke(cmd, args);'

  # ── emit / listen (static) ────────────────────────────────
  $content = $content -replace 'import \{ emit, listen \} from "@tauri-apps/api/event";', 'const emit = (e: string, p?: any): Promise<void> => Promise.resolve((window as any).ether.emit(e, p));
const listen = (e: string, cb: (ev: any) => void): Promise<() => void> => { const h = (window as any).ether.on(e, (p: any) => cb({ payload: p })); return Promise.resolve(() => (window as any).ether.off(e, h)); };'
  $content = $content -replace 'import \{ listen \} from "@tauri-apps/api/event";', 'const listen = (e: string, cb: (ev: any) => void): Promise<() => void> => { const h = (window as any).ether.on(e, (p: any) => cb({ payload: p })); return Promise.resolve(() => (window as any).ether.off(e, h)); };'
  $content = $content -replace 'import \{ emit \} from "@tauri-apps/api/event";', 'const emit = (e: string, p?: any): Promise<void> => Promise.resolve((window as any).ether.emit(e, p));'

  # ── dynamic event imports ─────────────────────────────────
  $content = $content -replace 'import\("@tauri-apps/api/event"\)\.then\(\(\{ emit: e \}\) => \{([^}]+)\}\);', 'setTimeout(() => { (window as any).ether.emit("now-playing-request", {}); }, 500);'
  $content = $content -replace 'import\("@tauri-apps/api/event"\)\.then\(\(\{listen\}\) => \{', '(async () => { const listen = (e: string, cb: (ev: any) => void) => { (window as any).ether.on(e, (p: any) => cb({ payload: p })); }; {'
  $content = $content -replace "import\(`"@tauri-apps/api/event`"\)\.then\(\(\{listen\}\) => \{", '(async () => { const listen = (e: string, cb: (ev: any) => void) => { (window as any).ether.on(e, (p: any) => cb({ payload: p })); }; {'

  # ── open dialog (static) ──────────────────────────────────
  $content = $content -replace 'import \{ open \} from "@tauri-apps/api/plugin-dialog";', 'const open = (opts?: any) => opts?.directory ? (window as any).ether.dialog.openDirectory() : (window as any).ether.dialog.openFile(opts);'
  $content = $content -replace 'import \{ open \} from "@tauri-apps/plugin-dialog";', 'const open = (opts?: any) => opts?.directory ? (window as any).ether.dialog.openDirectory() : (window as any).ether.dialog.openFile(opts);'
  $content = $content -replace 'import \{ save \} from "@tauri-apps/plugin-dialog";', 'const save = (opts?: any) => (window as any).ether.dialog.saveFile(opts);'
  $content = $content -replace 'import \{ open, save \} from "@tauri-apps/plugin-dialog";', 'const open = (opts?: any) => opts?.directory ? (window as any).ether.dialog.openDirectory() : (window as any).ether.dialog.openFile(opts);
const save = (opts?: any) => (window as any).ether.dialog.saveFile(opts);'
  $content = $content -replace 'import \{ save, open as openDialog \} from "@tauri-apps/plugin-dialog";', 'const openDialog = (opts?: any) => opts?.directory ? (window as any).ether.dialog.openDirectory() : (window as any).ether.dialog.openFile(opts);
const save = (opts?: any) => (window as any).ether.dialog.saveFile(opts);'

  # ── dynamic dialog ────────────────────────────────────────
  $content = $content -replace 'const \{ open \} = await import\("@tauri-apps/plugin-dialog"\);', 'const open = (opts?: any) => opts?.directory ? (window as any).ether.dialog.openDirectory() : (window as any).ether.dialog.openFile(opts);'

  # ── fs: readDir (static) ──────────────────────────────────
  $content = $content -replace 'import \{ readDir \} from "@tauri-apps/plugin-fs";', 'const readDir = (p: string) => (window as any).ether.fs.readDir(p);'
  $content = $content -replace 'import \{ readFile \} from "@tauri-apps/plugin-fs";', 'const readFile = (p: string) => (window as any).ether.fs.readFile(p);'
  $content = $content -replace 'import \{ readFile, writeFile \} from "@tauri-apps/plugin-fs";', 'const readFile = (p: string) => (window as any).ether.fs.readFile(p);
const writeFile = (p: string, data: any) => (window as any).ether.fs.writeFile(p, data);'
  $content = $content -replace 'import \{ writeFile \} from "@tauri-apps/plugin-fs";', 'const writeFile = (p: string, data: any) => (window as any).ether.fs.writeFile(p, data);'

  # ── dynamic fs imports ────────────────────────────────────
  $content = $content -replace 'const \{ readFile \} = await import\("@tauri-apps/plugin-fs"\);', 'const readFile = (p: string) => (window as any).ether.fs.readFile(p);'
  $content = $content -replace 'const \{ readTextFile \} = await import\("@tauri-apps/plugin-fs"\);', 'const readTextFile = (p: string) => (window as any).ether.fs.readFile(p).then((r: any) => new TextDecoder().decode(new Uint8Array(r.data ?? r)));'
  $content = $content -replace 'const \{ writeTextFile \} = await import\("@tauri-apps/plugin-fs"\);', 'const writeTextFile = (p: string, data: string) => (window as any).ether.fs.writeFile(p, data);'
  $content = $content -replace 'const \{ writeTextFile, BaseDirectory \} = await import\("@tauri-apps/plugin-fs"\);', 'const writeTextFile = (p: string, data: string) => (window as any).ether.fs.writeFile(p, data); const BaseDirectory = {};'

  # ── convertFileSrc ────────────────────────────────────────
  $content = $content -replace 'import \{ convertFileSrc \} from "@tauri-apps/api/core";', 'const convertFileSrc = (p: string) => `file:///${p.replace(/\\/g, "/")}`;'
  $content = $content -replace 'const \{ convertFileSrc \} = await import\("@tauri-apps/api/core"\);', 'const convertFileSrc = (p: string) => `file:///${p.replace(/\\/g, "/")}`;'

  # ── WebviewWindow ─────────────────────────────────────────
  $content = $content -replace 'import \{ WebviewWindow \} from "@tauri-apps/api/webviewWindow";', '// WebviewWindow replaced by Electron IPC'
  $content = $content -replace 'const \{ WebviewWindow \} = await import\("@tauri-apps/api/webviewWindow"\);', '// WebviewWindow replaced — use ether.invoke("open_desk_window")'

  # ── getCurrentWindow ──────────────────────────────────────
  $content = $content -replace 'import \{ getCurrentWindow \} from "@tauri-apps/api/window";', 'const getCurrentWindow = () => ({ setTitle: (t: string) => document.title = t, close: () => window.close() });'

  # ── autostart (dynamic) ───────────────────────────────────
  $content = $content -replace 'const \{ enable \} = await import\("@tauri-apps/plugin-autostart"\); await enable\(\);', 'await (window as any).ether.autostart.enable();'
  $content = $content -replace 'const \{ disable \} = await import\("@tauri-apps/plugin-autostart"\); await disable\(\);', 'await (window as any).ether.autostart.disable();'
  $content = $content -replace 'import\("@tauri-apps/plugin-autostart"\)\.then\(\(\{ isEnabled \}\) => isEnabled\(\)\.then\(setAutostart\)\.catch\(\(\) => \{\}\)\)\.catch\(\(\) => \{\}\);', '(window as any).ether.autostart.isEnabled().then((v: boolean) => setAutostart(v)).catch(() => {});'
  $content = $content -replace 'import\("@tauri-apps/plugin-autostart"\)\.then\(\(\{ isEnabled \}\) => \{', '(async () => { const isEnabled = () => (window as any).ether.autostart.isEnabled(); {'

  # ── updater / process ─────────────────────────────────────
  $content = $content -replace 'import \{ check \} from "@tauri-apps/plugin-updater";', '// Updater: use electron auto-updater via IPC'
  $content = $content -replace 'import \{ relaunch \} from "@tauri-apps/plugin-process";', 'const relaunch = () => (window as any).ether.invoke("relaunch");'

  # ── NowPlayingWindow WebviewWindow usage ──────────────────
  $content = $content -replace 'import \{ WebviewWindow \} from "@tauri-apps/api/webviewWindow";', '// WebviewWindow replaced by Electron IPC'

  Set-Content $path $content -NoNewline
}

Write-Host ""
Write-Host "Done! Checking remaining @tauri-apps refs..."
$remaining = Get-ChildItem -Path $srcDir -Recurse -Filter "*.tsx" | Select-String "@tauri-apps" | Where-Object { $_.Line -notmatch "^//" -and $_.Line -notmatch "^\s*//" }
if ($remaining) {
  Write-Host "Still remaining:"
  $remaining | ForEach-Object { Write-Host "  $($_.Filename):$($_.LineNumber): $($_.Line.Trim())" }
} else {
  Write-Host "All clean!"
}
