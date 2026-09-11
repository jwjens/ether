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

console.log("\n== 8. the FILES half is not a flag at all ==");
{
  // Jeff, 2026-09-11: "Delete the second flag — the files half reads sync_enabled for the active
  // station. One flag, one writer." And on the literal that armed it: "that's the thing that's been
  // arming the gate all along."
  //
  // The first attempt kept a stored `enabled` boolean and made toggleKeepSynced its single writer.
  // That failed three ways at once, confirmed on a real install:
  //   1. the toggle only writes on a CLICK, so an install already off never wrote anything;
  //   2. the write threw SQLITE_CONSTRAINT_NOTNULL every time — the hand-rolled INSERT omitted
  //      station_id (INTEGER NOT NULL, PK) and uuid (TEXT NOT NULL), reported via console.error,
  //      which a packaged build discards;
  //   3. so the row never existed, nothing was read back, and the hardcoded `enabled: true` decided
  //      everything.
  // A flag that is derived cannot be stale, cannot need seeding, and cannot be written wrong.

  const cb = code("electron/cloud-backup.js");

  // (a) NOTHING passes `enabled` to setR2Config. Not one writer — none.
  const writers = [];
  for (const f of RENDERER) {
    const src = code(f);
    const re = /setR2Config\s*\(\s*\{[\s\S]*?\}\s*\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (/\benabled\s*:/.test(m[0])) writers.push(`${f}:${src.slice(0, m.index).split("\n").length}`);
    }
  }
  if (writers.length === 0) pass("no caller passes enabled: to setR2Config — there is no second flag to set");
  else fail(`${writers.length} caller(s) still set the files half independently (${writers.join(", ")})`);

  // (b) the gate is derived from the one flag.
  if (/function\s+filesHalfEnabled\s*\(/.test(cb) && /sync_enabled/.test(cb)) {
    pass("cloud-backup derives the files half from sync_enabled");
  } else {
    fail("cloud-backup has no filesHalfEnabled() reading sync_enabled — the files half is a flag again");
  }
  const ready = cb.slice(cb.indexOf("function r2Ready"), cb.indexOf("function r2Ready") + 400);
  if (/filesHalfEnabled\s*\(\s*\)/.test(ready)) pass("r2Ready() asks filesHalfEnabled()");
  else fail("r2Ready() does not consult filesHalfEnabled() — the gate is reading something else");

  // (c) the literal that armed it is gone.
  if (!/let\s+r2Config\s*=\s*\{[^}]*\benabled\s*:/.test(cb)) {
    pass("the hardcoded enabled: true is gone from the r2Config literal");
  } else {
    fail("r2Config still declares an `enabled` default — that literal is what armed the gate on every install");
  }

  // (d) THE PROOF LINE MUST BE FINDABLE.
  //
  // Jeff, 2026-09-11: "it's a tiny grey word next to a dropdown — I didn't find it. That's the line
  // that proves the whole fix and it reads like a typo."
  //
  // Every other label on that screen states an intention. This one reports what the backup
  // machinery answers when asked, so it is the only thing on the card that can contradict the
  // switch — which makes it the line an operator needs when a switch only LOOKS like it worked.
  // It shipped as a 12px lowercase span wedged between a dropdown and a Save button, and went
  // unfound by the person who asked for it. It now has its own row and its own label.
  //
  // Keyed to the DEFECT's shape, not to styling numbers that will drift: the bare lowercase form is
  // what was unreadable, and the row must carry a label naming what is being reported.
  const sp2 = code("src/components/SettingsPanel.tsx");
  if (/Going to the cloud right now/.test(sp2)) {
    pass("the files-half status has its own labelled row");
  } else {
    fail("the files-half status has no label of its own — it is the line that proves the fix and it must be findable");
  }
  if (!/\{\s*r2Enabled\s*\?\s*"on"\s*:\s*"off"\s*\}/.test(sp2)) {
    pass("the tiny lowercase on/off beside the interval dropdown is gone");
  } else {
    fail("the status is still a bare lowercase on/off next to the dropdown — that is the form Jeff could not find");
  }

  // (e) the retired master switches, by their own labels.
  for (const [needle, where] of [
    ["Toggle automatic backup", "Advanced"],
    ["Save Credentials", "the Cloud Backup panel"],
  ]) {
    const hits = RENDERER.filter((f) => code(f).includes(needle));
    if (hits.length === 0) pass(`"${needle}" is gone from ${where}`);
    else fail(`"${needle}" still renders in ${hits.join(", ")} — a second writer of the files half`);
  }
}

console.log("\n== 9. nothing hand-rolls an INSERT into station_config_kv ==");
{
  // Jeff, 2026-09-11: "Nothing hand-rolls an INSERT into station_config_kv anywhere. That's twice now."
  //
  // It was three times: cloud_backup_r2, cloud_backup_config (two copies) and ai_voice_config, plus
  // the designation upsert bug before them. The table declares station_id INTEGER NOT NULL PRIMARY
  // KEY and uuid TEXT NOT NULL, so any INSERT that does not name both throws
  // SQLITE_CONSTRAINT_NOTNULL — and every one of these callers swallowed it, so the settings simply
  // never persisted and nobody saw an error. AI Voice lost the operator's API key on every restart
  // for as long as that code has existed.
  //
  // The sanctioned writers are in sync/handlers/station_config_kv.js: stationConfigKvUpsertByKey for
  // an ordinary synced key, stationConfigKvSetLocal for a LOCAL_ONLY_KEYS key. Both generate the uuid
  // and require the station id, so neither can be written wrong.
  //
  // This is a RATCHET, not a baseline: the only way past it is the sanctioned writer or a
  // GUARD-EXEMPT marker with a reason on the line above.
  const OWNER = "electron/sync/handlers/station_config_kv.js";
  const files = [];
  const walkJs = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== "node_modules") walkJs(rel); }
      else if (/\.(js|ts|tsx)$/.test(e.name)) files.push(rel);
    }
  };
  walkJs("electron");
  for (const f of RENDERER) files.push(f);

  const offenders = [];
  for (const f of files) {
    if (f === OWNER) continue;
    // DETECT on the comment-stripped text, so a comment QUOTING the old broken statement (several
    // now do, by way of explaining it) is not itself an offence. But read the MARKER off the raw
    // lines: code() strips comments, which deleted the exemption before the check could see it.
    // Both views keep the same line numbering, so one index serves both.
    const lines = code(f).split("\n");
    const raw   = read(f).replace(/\r/g, "").split("\n");
    lines.forEach((l, i) => {
      if (!/(INSERT|REPLACE)\s+(OR\s+\w+\s+)?INTO\s+station_config_kv/i.test(l)) return;
      const prev = raw.slice(Math.max(0, i - 5), i).join("\n");
      if (/GUARD-EXEMPT\(station_config_kv-insert\)/.test(prev)) return;
      offenders.push(`${f}:${i + 1}`);
    });
  }
  if (offenders.length === 0) {
    pass(`no hand-rolled INSERT into station_config_kv outside ${OWNER}`);
  } else {
    fail(`hand-rolled INSERT into station_config_kv at ${offenders.join(", ")} — use stationConfigKvUpsertByKey / stationConfigKvSetLocal, which name station_id and uuid`);
  }

  // The two keys this commit reclassified must be refused by the synced path.
  const owner = read(OWNER);
  for (const k of ["cloud_backup_config", "ai_voice_config"]) {
    if (new RegExp(`LOCAL_ONLY_KEYS[\\s\\S]{0,600}'${k}'`).test(owner)) pass(`${k} is local-only — it never enters the mutation stream`);
    else fail(`${k} is not in LOCAL_ONLY_KEYS — machine-local bookkeeping and an API key would sync to every peer`);
  }
}

console.log(failures === 0
  ? "\nVERDICT: PASS — one engine, one switch, and every count says what it counted.\n"
  : `\nVERDICT: FAIL — ${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
