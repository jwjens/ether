// scripts/smoke-one-switch.js
//
// THE CONTRACT: one engine, one switch, and no label that lies about what it counted.
//
// WHY THIS EXISTS. The Backup & Restore screen grew six controls driving three jobs, and the reason
// was structural rather than cosmetic: step 4 (e36d675) replaced the songs-table uploader with a
// folder-driven catalogue engine and NOTHING in the renderer was moved onto it. So the screen went
// on calling library:cloud-status — which counts `songs` rows carrying r2_uploaded_at — and printed
// "All 510 songs are in the cloud" over a catalogue of 483 files, from the very column whose seed
// defects step 4 had to repair. Two engines behind one screen is what made it unreadable.
//
// Jeff's ruling, 2026-09-09: "catalogue:backup:* becomes the one path. I'm not shipping two engines
// and a card that reads one while the buttons drive the other — that's how this screen got confusing."
//
// Static on purpose: it runs in CI on a tree with no Electron, no engine and no cloud.
// Design: docs/one-switch-2026-09-09.md

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

// Normalise CRLF BEFORE stripping. `.` does not match `\r` in JavaScript, so on a CRLF file
// `//.*$` never reaches end-of-line and the comment survives — silently, and only for files the
// working tree happens to check out with CRLF. smoke-window-station.js was bitten by exactly this.
const code = (p) => read(p)
  .replace(/\r/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
  .split("\n")
  .map((l) => l.replace(/(^|\s)\/\/.*$/, ""))
  .join("\n");

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
  }
  return out;
};

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures++; console.log(`  FAIL  ${m}`); };

const RENDERER = walk("src");

console.log("\n== 1. ONE engine reaches the renderer ==");
{
  // The legacy surface, by both of its names. Comments are stripped, so a file may still EXPLAIN
  // the migration (this one does) without failing the check it describes.
  for (const [needle, why] of [
    ["libraryR2.", "the songs-table uploader"],
    ["library:cloud-status", "the songs-table status handler"],
    ["library:sync-r2:", "the songs-table IPC namespace"],
  ]) {
    const hits = [];
    for (const f of RENDERER) {
      const src = code(f);
      src.split("\n").forEach((l, i) => { if (l.includes(needle)) hits.push(`${f}:${i + 1}`); });
    }
    if (hits.length === 0) pass(`no renderer code touches \`${needle}\` (${why})`);
    else for (const h of hits) fail(`${h} still uses \`${needle}\` — ${why} was retired; use catalogueBackup.* / catalogue:backup:*`);
  }
}

console.log("\n== 2. the card reads the catalogue, and says so in files ==");
{
  const sp = code("src/components/SettingsPanel.tsx");

  if (/catalogueBackup\.status\(\)/.test(sp)) pass("the status read is catalogueBackup.status() — the folder and the real remote manifest");
  else fail("SettingsPanel does not call catalogueBackup.status() — the card would be claiming something it did not measure");

  if (/Keep my stuff synced/.test(sp)) pass("the one switch is present: \"Keep my stuff synced\"");
  else fail("\"Keep my stuff synced\" is gone — the master switch is the whole point of the surface");

  // The retired labels, each of which named the wrong mechanism or the wrong units.
  for (const [dead, why] of [
    ["songs are in the cloud", "a catalogue count reported as songs"],
    ["Send my music to the cloud", "a second primary button competing with the card"],
    ["Audio files sync separately", "states the seam the one switch exists to hide"],
    ["WHERE YOUR SONGS LIVE", "the catalogue is audio, not songs"],
    ["Re-send every song", "the catalogue is audio, not songs"],
  ]) {
    if (!sp.includes(dead)) pass(`retired label absent: "${dead}"`);
    else fail(`SettingsPanel still says "${dead}" — ${why}`);
  }
}

console.log("\n== 3. no count of catalogue FILES is called \"songs\" ==");
{
  // The catalogue is 483 files; `songs` is 510 rows. Both are honest and they are different
  // questions, so a label has to say which one it answered. This catches the pairing, not the word:
  // "510 songs" as a library figure is fine, a catalogue count wearing it is not.
  const suspicious = [];
  for (const f of RENDERER) {
    const src = code(f);
    src.split("\n").forEach((l, i) => {
      const nearCatalogue = /catalogue|localFiles|cloudFiles|audioLibraryDir/i.test(l);
      const callsThemSongs = /\bsongs?\b/i.test(l) && /toLocaleString|\{[^}]*(total|count|files)/i.test(l);
      if (nearCatalogue && callsThemSongs) suspicious.push(`${f}:${i + 1}`);
    });
  }
  if (suspicious.length === 0) pass("no line pairs a catalogue figure with the word \"songs\"");
  else for (const s of suspicious) fail(`${s} reports a catalogue figure as "songs" — say "audio files"`);
}

console.log("\n== 4. the restore reports itself, in phases ==");
{
  const bar = code("src/components/LibrarySyncProgressBar.tsx");

  if (/catalogueBackup\.getDownloadState/.test(bar)) pass("the bar seeds from catalogueBackup.getDownloadState() — a window mounting mid-restore is not blind");
  else fail("the bar has no mount-time state seed — a window opened mid-restore would show nothing");

  if (/onDownloadState/.test(bar)) pass("the bar subscribes to phase changes");
  else fail("the bar does not subscribe to phase changes — the rows phase would be invisible");

  for (const [phrase, why] of [
    ["Bringing your setup down", "the rows phase"],
    ["Bringing your audio down", "the files phase"],
  ]) {
    if (bar.includes(phrase)) pass(`phase sentence present: "${phrase}…" (${why})`);
    else fail(`the bar never says "${phrase}" — ${why} has no sentence`);
  }

  if (!/Downloading library/.test(bar)) pass("the old mechanism-shaped label is gone");
  else fail("the bar still says \"Downloading library\" — it names the mechanism, not the act");
}

console.log("\n== 5. a restore in progress is not a fault ==");
{
  const health = code("electron/library-health.js");
  if (/restoreInFlight/.test(health)) pass("library-health reports restoreInFlight alongside the dead count");
  else fail("library-health does not report restoreInFlight — Health Monitor cannot tell a transfer from damage");

  const hm = code("src/components/HealthMonitor.tsx");
  if (/restoreInFlight[\s\S]{0,200}files still arriving/.test(hm)) pass("Health Monitor says \"N files still arriving\" while a restore runs");
  else fail("Health Monitor has no \"files still arriving\" branch — mid-restore it would report hundreds of dead rows as damage");

  // The rows phase runs with the restore gate SET, so the two doors that report it must be exempt
  // or the one place that can say "bringing your setup down…" is the one place that cannot answer.
  const main = code("electron/main.js");
  const gate = /_RESTORE_SAFE_CHANNELS = new Set\(\[([\s\S]*?)\]\)/.exec(main);
  if (!gate) fail("could not find _RESTORE_SAFE_CHANNELS in main.js — this test is stale");
  else for (const ch of ["catalogue:backup:download:get-state", "catalogue:backup:phase"]) {
    if (gate[1].includes(ch)) pass(`${ch} works while the restore gate is set`);
    else fail(`${ch} is not restore-safe — the rows phase could not report itself`);
  }
}

console.log("\n== 6. the pending count is not the pushable count ==");
{
  const main = code("electron/main.js");
  if (/pendingPushable/.test(main)) pass("sync:preflight exposes pendingPushable");
  else fail("sync:preflight does not expose pendingPushable — the panel can only show a number that counts unsendable rows");

  if (/pendingJournalOnly/.test(main)) pass("sync:preflight exposes pendingJournalOnly — the remainder is named, not hidden");
  else fail("sync:preflight does not expose pendingJournalOnly");

  const sp = code("src/components/SettingsPanel.tsx");
  if (/Waiting to sync/.test(sp)) pass("the panel labels it \"Waiting to sync\"");
  else fail("the panel no longer says \"Waiting to sync\"");

  // The bar and the irreversible confirm are the two places the raw figure did real damage: a
  // permanent 49% on a drained queue, and a typed CLEAR to discard 79,341 rows of which 0 were
  // pushable.
  if (/width:[^}]*pendingPushable/.test(sp)) pass("the backlog bar measures pushable rows, so it can reach 100%");
  else fail("the backlog bar is not measured against pendingPushable — it will park partway on a drained queue");

  if (/Discard \{\(pf\?\.mutations\?\.pendingPushable/.test(sp)) pass("Clear pending names the pushable count in its confirm");
  else fail("Clear pending still names the raw pending count — an irreversible act armed against the wrong number");
}

console.log("\n== 7. sync_enabled has exactly ONE writer ==");
{
  // Jeff, 2026-09-09: "It shouldn't be settable in two places." Advanced carried its own
  // "Enable the sync engine" checkbox, which was a second master switch for HALF of what the top
  // toggle does — untick it there and the card claimed on while the rows half was off. Two writers
  // on one key is the srcChannelOn class of defect, which §6 of smoke-window-station.js already
  // guards for the board. This is the same guard for the sync flag.
  const writers = [];
  for (const f of RENDERER) {
    code(f).split("\n").forEach((l, i) => {
      if (/upsertByKey\s*\(/.test(l) && /'sync_enabled'|"sync_enabled"/.test(l)) writers.push(`${f}:${i + 1}`);
      // The multi-line form: the key sits on its own line inside the call.
      else if (/^\s*(stationId|sid)\s*,\s*'sync_enabled'/.test(l)) writers.push(`${f}:${i + 1}`);
    });
  }
  if (writers.length === 1) pass(`one writer of sync_enabled (${writers[0]})`);
  else if (writers.length === 0) fail("nothing writes sync_enabled — the master switch cannot turn the engine on");
  else fail(`sync_enabled is written in ${writers.length} places (${writers.join(", ")}) — one switch means one writer`);

  // Whoever writes the flag must write the destination in the same act.
  const sp = code("src/components/SettingsPanel.tsx");
  if (/sync_enabled[\s\S]{0,400}sync_backend_url/.test(sp)) pass("the writer sets sync_backend_url alongside it");
  else fail("sync_enabled is written without sync_backend_url — main resolves the host to '' and starts an engine with nowhere to send (4.4.202)");

  // The retired second control, by its own label.
  if (!sp.includes("Enable the sync engine")) pass("the second master switch is gone from Advanced");
  else fail("Advanced still offers \"Enable the sync engine\" — a second settable master switch");

  // And the card must not name itself twice. Counting occurrences was the WRONG test — the string
  // legitimately appears as the section title, as the switch's aria-label, and in three places that
  // point the operator at it ("turn it on with…"). What must not exist is a second VISIBLE label
  // repeating the heading next to the switch, which is the shape it had: a bare text node in the
  // toggle row. Jeff, 2026-09-09: "the card heading AND the toggle label — reads like two controls."
  // Match the DEFECT's shape, not the words. The duplicated label was a styled label element —
  // `<div style={{ fontSize: 13.5, fontWeight: 600, ... }}>Keep my stuff synced</div>`. Inline
  // <b>/<strong> mentions are the cross-references that point AT the switch, and those are wanted,
  // so keying on fontWeight is what separates a heading-weight label from a sentence.
  if (!/fontWeight[^>]*>\s*Keep my stuff synced\s*</.test(sp)) {
    pass("the switch carries no styled label repeating the section heading");
  } else {
    fail("a styled \"Keep my stuff synced\" label sits beside the heading of the same name — one control reading as two");
  }

  const titles = (sp.match(/title="Keep my stuff synced"/g) || []).length;
  const arias  = (sp.match(/aria-label="Keep my stuff synced"/g) || []).length;
  if (titles === 1 && arias === 1) pass("one section title, one accessible name — one control");
  else fail(`expected 1 title= and 1 aria-label=, found ${titles} and ${arias}`);
}

console.log("\n== 8. the FILES half has exactly ONE writer, and it survives a restart ==");
{
  // Jeff, 2026-09-10, after confirming it at runtime: "The switch never reaches main."
  //
  // Section 7 made sync_enabled single-writer — the ROWS half. The FILES half (cloud-backup's
  // r2Config.enabled, which gates r2Ready() and therefore triggerUpload()) had THREE writers and
  // the one switch was not among them: toggleKeepSynced() only called setR2Enabled(), which is
  // React state and nothing else. So "Off. Nothing is going to the cloud." moved a pill and told
  // main nothing, and the database kept going up on every backup_db (main.js:5808).
  // Receipt: getR2Config().enabled read true, the switch was flipped off, it read true again.
  //
  // Two things have to hold, and the second is the one that bites: a single writer is useless if
  // main never reads the value back. 1.3f stopped loading cloud_backup_r2 because it carried
  // credentials, which left saveR2Config() writing a key nothing consumed — so the flag reset to
  // its hardcoded `enabled: true` on every launch and the off could not survive a restart.

  // (a) exactly ONE renderer call passes `enabled` to setR2Config.
  const writers = [];
  for (const f of RENDERER) {
    const src = code(f);
    const re = /setR2Config\s*\(\s*\{[\s\S]*?\}\s*\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (/\benabled\s*:/.test(m[0])) writers.push(`${f}:${src.slice(0, m.index).split("\n").length}`);
    }
  }
  if (writers.length === 1) pass(`one writer of the files-half flag (${writers[0]})`);
  else if (writers.length === 0) fail("nothing passes enabled: to setR2Config — the switch cannot turn the files half off");
  else fail(`the files-half flag is written in ${writers.length} places (${writers.join(", ")}) — one switch means one writer`);

  // (b) it is the SAME function that writes sync_enabled. Two writers in two places is the defect;
  //     two writes in one act is the fix.
  const sp = code("src/components/SettingsPanel.tsx");
  const at = sp.indexOf("const toggleKeepSynced");
  const fn = at === -1 ? "" : sp.slice(at, at + 1400);
  if (/sync_enabled/.test(fn) && /setR2Config/.test(fn)) pass("both halves are written by toggleKeepSynced, in one act");
  else fail("toggleKeepSynced does not write both halves — the card can claim a state only one half is in");

  // (c) the retired second and third master switches, by their own labels.
  for (const [needle, where] of [
    ["Toggle automatic backup", "Advanced"],
    ["Save Credentials", "the Cloud Backup panel"],
  ]) {
    const hits = RENDERER.filter((f) => code(f).includes(needle));
    if (hits.length === 0) pass(`"${needle}" is gone from ${where}`);
    else fail(`"${needle}" still renders in ${hits.join(", ")} — a second writer of the files half`);
  }

  // (d) THE LOAD PATH. Without this the off is written and never read.
  const cb = code("electron/cloud-backup.js");
  const ci = cb.indexOf("function installCloudBackup");
  const install = ci === -1 ? "" : cb.slice(ci, ci + 4000);
  if (/cloud_backup_r2/.test(install) && /r2Config\.enabled\s*=/.test(install)) {
    pass("installCloudBackup reads cloud_backup_r2 back — the flag survives a restart");
  } else {
    fail("installCloudBackup never reads cloud_backup_r2 — r2Config.enabled resets to its hardcoded default every launch");
  }

  // (e) …and still refuses to load credentials. 1.3f's decision stands; only the operator's two
  //     fields come back.
  if (!/stored\.(accessKeyId|secretAccessKey|accountId|bucket|endpoint)/.test(install)) {
    pass("the restored load path takes no credentials — backend-signed mode is intact");
  } else {
    fail("the load path reads credential fields out of KV — 1.3f moved R2 access to the backend");
  }
}

console.log(failures === 0
  ? "\nVERDICT: PASS — one engine, one switch, and every count says what it counted.\n"
  : `\nVERDICT: FAIL — ${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
