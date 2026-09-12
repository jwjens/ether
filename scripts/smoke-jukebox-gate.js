'use strict';
// scripts/smoke-jukebox-gate.js
//
// THE CONTRACT: the jukebox has ONE admission gate, and both paths go through it.
//
// WHY THIS EXISTS. Two paths reach jukebox_requests — the kiosk (typed at the Jukebox window) and the
// web (a phone that scanned the QR). The pending cap and the duplicate check lived only in the kiosk
// renderer, so the guards protected the person standing in front of the operator and not the room.
// Anyone with the QR could request the same song twenty times and every one of them landed.
//
// And `jukebox_repeat_minutes` enforced NOTHING for the life of the feature: read into React state at
// Jukebox.tsx:411, never compared against anything, on either path. A configured cooldown that does
// nothing is worse than no setting, because the screen implies a rule the system is not applying.
//
// Jeff, 2026-09-11: "One song at a time is the rule."
//
// The gate now lives in electron/main.js jukeboxAdmit(), called from jukebox:request-create, which
// both paths already funnel through. This guard keeps it that way: one enforcement site, no renderer
// re-implementing a rule, and the limits read from config rather than accepted from a caller.

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const code = (p) => read(p)
  .replace(/\r/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .split('\n')
  .map((l) => l.replace(/(^|\s)\/\/.*$/, ''))
  .join('\n');

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures++; console.log(`  FAIL  ${m}`); };

const main = code('electron/main.js');

console.log('\n== the jukebox admission gate ==');

// (a) it exists, and the create handler consults it.
if (/function\s+jukeboxAdmit\s*\(/.test(main)) pass('jukeboxAdmit() exists in main');
else fail('there is no jukeboxAdmit() — the rules have no single home');

const handlerAt = main.indexOf('ipcMain.handle("jukebox:request-create"');
const handler = handlerAt === -1 ? '' : main.slice(handlerAt, handlerAt + 2200);
if (/jukeboxAdmit\s*\(/.test(handler)) pass('jukebox:request-create calls the gate before inserting');
else fail('request-create does not call jukeboxAdmit() — a request can reach the table ungated');

// The gate must run BEFORE the INSERT, not after it.
const gateIdx = handler.indexOf('jukeboxAdmit(');
const insIdx  = handler.indexOf('INSERT INTO jukebox_requests');
if (gateIdx !== -1 && insIdx !== -1 && gateIdx < insIdx) pass('the gate runs before the INSERT');
else fail('the gate does not precede the INSERT — a refused request would already be recorded');

// (b) all four rules are in it.
const gAt = main.indexOf('function jukeboxAdmit');
const gate = gAt === -1 ? '' : main.slice(gAt, gAt + 5000);
for (const [needle, what] of [
  ['one_at_a_time',   'one song at a time'],
  ['queue_full',      'the pending cap'],
  ['already_queued',  'the duplicate check'],
  ['played_recently', 'the repeat window'],
]) {
  if (gate.includes(needle)) pass(`the gate enforces ${what}`);
  else fail(`the gate does not enforce ${what} (no "${needle}" refusal)`);
}

// (c) THE REPEAT WINDOW ASKS REAL AIRPLAY. Checking only the jukebox's own played rows would let a
//     song that just aired from rotation be requested again immediately — which is exactly the "we
//     just heard that" complaint the setting exists for.
if (/play_log/.test(gate)) pass('the repeat window consults play_log, not only jukebox history');
else fail('the repeat window ignores play_log — a song that aired from rotation would be requestable at once');

// (d) THE LIMITS COME FROM CONFIG, NOT FROM THE CALLER. A limit a caller supplies is a limit a caller
//     can omit, and the web caller is a phone.
if (/function\s+_jukeboxLimits/.test(main) && /station_config_kv/.test(main.slice(main.indexOf('function _jukeboxLimits'), main.indexOf('function _jukeboxLimits') + 900))) {
  pass('the limits are read from station_config_kv inside main');
} else {
  fail('the limits are not read from config in main — a caller could supply its own');
}

// (e) NO RENDERER RE-IMPLEMENTS THE RULES. This is the defect that was here: two enforcement sites,
//     one of which the web path never reached. Keyed on the shapes the old checks actually had.
const juke = code('src/components/Jukebox.tsx');
const reimpl = [];
if (/pendingCount\s*>=\s*maxPending/.test(juke)) reimpl.push('the pending cap');
if (/requests\.some\([^)]*file_path[^)]*status\s*===\s*"queued"/.test(juke)) reimpl.push('the duplicate check');
if (reimpl.length === 0) pass('the Jukebox window does not re-implement the gate');
else fail(`Jukebox.tsx still enforces ${reimpl.join(' and ')} locally — two sites, and the web path reaches only one`);

// (f) and the dead constants are gone, so nothing reads like a setting that is not one.
for (const dead of ['DEFAULT_REPEAT_MINUTES', 'DEFAULT_MAX_PENDING']) {
  if (!new RegExp(`const\\s+${dead}\\s*=`).test(juke)) pass(`${dead} no longer declared in the renderer`);
  else fail(`${dead} is still declared in Jukebox.tsx — a limit that lives in two places drifts`);
}

// (g) the web path carries the requester token, or "one at a time" is defeated by a different name.
const app = code('src/App.tsx');
const wAt = app.indexOf('case "jukebox:request"');
const web = wAt === -1 ? '' : app.slice(wAt, wAt + 2600);
if (/requesterToken/.test(web)) pass('the web path passes the requester token to the gate');
else fail('the web path drops the requester token — one-at-a-time falls back to a typed name');

console.log(failures === 0
  ? '\nVERDICT: PASS — one gate, both paths, and every rule it claims to enforce.\n'
  : `\nVERDICT: FAIL — ${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
