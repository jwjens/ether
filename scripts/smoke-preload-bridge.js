'use strict';
// scripts/smoke-preload-bridge.js
//
// THE CONTRACT: a renderer call reaches a real handler, across all THREE joins it has to cross.
//
//   link 1  the namespace is exposed on window.ether        electron/preload.js
//   link 2  the namespace has the method                    electron/preload-handlers.js
//   link 3  the channel has an ipcMain.handle                electron/**
//
// WHY THIS EXISTS. Twice now a renderer has called a door that was not there, and both times it was
// caught by eye rather than by a gate:
//
//   2026-09-11  window.ether.openExternal — never existed; the real door is system.openUrl.
//   2026-09-14  window.ether.libraryAsset — the whole NAMESPACE was undefined. OVEVENTS 4.6.34:
//               "Could not delete 'Opportunity Village Spot': TypeError: Cannot read properties of
//               undefined (reading 'deleteOwner')". deleteOwner was present in preload-handlers.js
//               and library:delete-asset was registered in main — links 2 and 3 were verified in the
//               shipped asar and both were fine. Link 1 was never checked, and was the broken one.
//
// HOW LINK 1 BREAKS. preload-handlers.js exports buildHandlers(), and its own header says the
// consumer should do `exposeInMainWorld('ether', { ...handlers })`. preload.js does not: it
// hand-wires every namespace, one line each. A namespace added there and forgotten here exists, is
// exported, and is reachable from nothing, with no error at any layer. libraryAsset sat unwired from
// v50 until the first caller touched it four months later.
//
// tsc cannot cover this: every one of these calls is written `(window as any).ether.…`, which erases
// the type before anything can check it.
//
//   node scripts/smoke-preload-bridge.js

const fs    = require('fs');
const path  = require('path');
const acorn = require('acorn');
const ts    = require('typescript');

const ROOT = path.join(__dirname, '..');
const P  = (...a) => path.join(ROOT, ...a);
const rd = (f) => fs.readFileSync(f, 'utf8');

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures++; console.log(`  FAIL  ${m}`); };

// ── DELIBERATELY UNWIRED ────────────────────────────────────────────────────────────────────────
// Namespaces built by preload-handlers.js that preload.js intentionally does NOT expose. Being on
// this list is a DECISION someone wrote down, which is the whole point: libraryAsset was unwired by
// ACCIDENT and looked exactly like these two until it threw.
//
// Both are v50 unified-library tables whose per-station halves nothing reads yet. They are the next
// thing the assignment-model slices will reach for — at which point the fix is to wire them here and
// delete the entry, not to widen the allowlist.
const DELIBERATELY_UNWIRED = new Set([
  'assetSpotMeta',     // v50 per-station traffic terms — no reader yet
  'assetSweeperMeta',  // v50 per-station imaging treatment — no reader yet
]);

// ── KNOWN-BROKEN CHANNELS: A RATCHET, NOT AN ALLOWLIST ──────────────────────────────────────────
//
// These are exposed on the bridge and invoked by the renderer, and NOTHING HANDLES THEM. They are
// listed so that this gate can be green on the breakage that already exists while refusing to let
// it grow — the same ratchet discipline as the station-identity leak guard: the number comes DOWN
// by fixing a channel and deleting its line. It is never raised to make a new failure go away.
//
// FOUND BY THIS GUARD ON ITS FIRST RUN, 2026-09-14 — which is the argument for the guard.
// ether.fs.writeFile / mkdir / copyFile have no ipcMain.handle anywhere in electron/**. Two source
// files already record it in comments — imagingCommit.ts:7 and ReelSplitter.tsx:8 both say "dead
// stub, no handler" — so this was discovered at least twice, written down twice, and left. Five
// other call sites still use them as though they work, including StudioPro.tsx:2717, which awaits
// ether.fs.writeFile to save rendered audio.
//
// NOT FIXED HERE: giving the renderer a general "write any file" channel is a security decision
// about what the sandbox may touch, not a repair to a delete button. It needs its own pass.
// docs/preload-bridge-unwired-namespace-2026-09-14.md
const KNOWN_MISSING_HANDLERS = new Set([
  'fs:writeFile',
  'fs:mkdir',
  'fs:copyFile',
]);

// ── link 1 + 2, producer side: what the bridge actually exposes ─────────────────────────────────
//
// preload.js's exposeInMainWorld literal is read from the AST, not by regex: a namespace can be
// `name: handlers.name`, an inline object literal (stations, which main registers with custom logic
// and excludes from installAll), or a spread-plus-extras (`{ ...handlers.scheduledLog, getByDate }`).
// All three are legitimate and all three must resolve to a real set of method names.

function objectKeys(node) {
  const out = new Set();
  for (const p of node.properties || []) {
    if (p.type === 'Property' && p.key) out.add(p.key.name || p.key.value);
  }
  return out;
}

const preloadSrc = rd(P('electron', 'preload.js'));
const preloadAst = acorn.parse(preloadSrc, { ecmaVersion: 2023, sourceType: 'script' });

let bridgeLiteral = null;
(function walk(n) {
  if (!n || typeof n !== 'object' || bridgeLiteral) return;
  if (n.type === 'CallExpression' && n.callee && n.callee.property &&
      n.callee.property.name === 'exposeInMainWorld' &&
      n.arguments[0] && n.arguments[0].value === 'ether' &&
      n.arguments[1] && n.arguments[1].type === 'ObjectExpression') {
    bridgeLiteral = n.arguments[1];
    return;
  }
  for (const k of Object.keys(n)) {
    const v = n[k];
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object' && v.type) walk(v);
  }
})(preloadAst);

if (!bridgeLiteral) { console.error('could not find exposeInMainWorld("ether", {...}) in preload.js'); process.exit(2); }

// ── the handlers factory: namespace -> method names ─────────────────────────────────────────────
const handlersSrc = rd(P('electron', 'preload-handlers.js'));
const handlersAst = acorn.parse(handlersSrc, { ecmaVersion: 2023, sourceType: 'script' });

const builtNs = new Map();   // ns -> Set(method)
(function findReturn(n) {
  if (!n || typeof n !== 'object') return;
  if (n.type === 'ReturnStatement' && n.argument && n.argument.type === 'ObjectExpression') {
    for (const p of n.argument.properties || []) {
      if (p.type === 'Property' && p.value && p.value.type === 'ObjectExpression')
        builtNs.set(p.key.name || p.key.value, objectKeys(p.value));
    }
    return;
  }
  for (const k of Object.keys(n)) {
    const v = n[k];
    if (Array.isArray(v)) v.forEach(findReturn);
    else if (v && typeof v === 'object' && v.type) findReturn(v);
  }
})(handlersAst);

if (!builtNs.size) { console.error('could not read the object buildHandlers() returns'); process.exit(2); }

// Resolve each exposed namespace to the methods it really has.
const exposed = new Map();   // ns -> Set(method) | null  (null = shape we cannot statically resolve)
for (const p of bridgeLiteral.properties) {
  if (p.type !== 'Property' || !p.key) continue;
  const ns = p.key.name || p.key.value;
  const v  = p.value;
  if (v.type === 'MemberExpression' && v.object && v.object.name === 'handlers') {
    exposed.set(ns, builtNs.get(v.property.name) || new Set());
  } else if (v.type === 'ObjectExpression') {
    const keys = objectKeys(v);
    // `{ ...handlers.x, extra }` — union the spread source with the literal's own keys.
    for (const sp of v.properties || []) {
      if (sp.type === 'SpreadElement' && sp.argument && sp.argument.type === 'MemberExpression' &&
          sp.argument.object && sp.argument.object.name === 'handlers') {
        for (const k of (builtNs.get(sp.argument.property.name) || new Set())) keys.add(k);
      }
    }
    exposed.set(ns, keys);
  } else {
    exposed.set(ns, null);   // a value, a function, an identifier — not a namespace to check
  }
}

console.log('\n== link 1: every namespace built is exposed, or is a written-down decision ==');
{
  const missing = [...builtNs.keys()].filter(ns => !exposed.has(ns) && !DELIBERATELY_UNWIRED.has(ns));
  if (!missing.length) pass(`all ${builtNs.size} namespaces accounted for (${DELIBERATELY_UNWIRED.size} deliberately unwired)`);
  else fail(`built by preload-handlers.js but NOT on window.ether: ${missing.join(', ')} ` +
            `— add to preload.js, or to DELIBERATELY_UNWIRED with a reason`);

  // An allowlist that outlives its reason is its own trap.
  const stale = [...DELIBERATELY_UNWIRED].filter(ns => exposed.has(ns) || !builtNs.has(ns));
  if (!stale.length) pass('the unwired allowlist is current — every entry still exists and is still unwired');
  else fail(`stale allowlist entries (now wired, or gone): ${stale.join(', ')} — remove them`);
}

// ── link 1 + 2, consumer side: what the renderer actually calls ─────────────────────────────────
const SRC = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) SRC.push(p);
  }
})(P('src'));

// Find `<anything>.ether.<ns>.<method>` and `<anything>.ether.<ns>`, through the `(window as any)`
// casts and optional chaining the codebase uses everywhere.
const calls = [];   // {ns, method, file, line}
for (const file of SRC) {
  const src = rd(file);
  if (!src.includes('.ether')) continue;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  (function visit(node) {
    if (ts.isPropertyAccessExpression(node) && node.name && node.name.text === 'ether') {
      // node is `<expr>.ether`; its parent chain gives .<ns> then .<method>
      const nsNode = node.parent;
      if (nsNode && ts.isPropertyAccessExpression(nsNode) && nsNode.expression === node) {
        const ns = nsNode.name.text;
        let method = null;
        const mNode = nsNode.parent;
        if (mNode && ts.isPropertyAccessExpression(mNode) && mNode.expression === nsNode) method = mNode.name.text;
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
        calls.push({ ns, method, file: path.relative(ROOT, file).replace(/\\/g, '/'), line: line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  })(sf);
}

console.log('\n== link 1: every namespace the renderer calls is on the bridge ==');
{
  const bad = calls.filter(c => !exposed.has(c.ns));
  const uniq = [...new Map(bad.map(c => [c.ns, c])).values()];
  if (!uniq.length) pass(`${new Set(calls.map(c => c.ns)).size} namespace(s) called across ${SRC.length} files, all exposed`);
  else for (const c of uniq)
    fail(`window.ether.${c.ns} is NOT exposed — ${c.file}:${c.line} will throw "Cannot read properties of undefined"`);
}

console.log('\n== link 2: every method the renderer calls exists on its namespace ==');
{
  let bad = 0;
  const seen = new Set();
  for (const c of calls) {
    if (!c.method) continue;
    const methods = exposed.get(c.ns);
    if (!methods) continue;                      // unresolvable shape, or namespace already reported
    if (methods.has(c.method)) continue;
    const key = c.ns + '.' + c.method;
    if (seen.has(key)) continue;
    seen.add(key);
    bad++;
    fail(`window.ether.${c.ns}.${c.method} does not exist — ${c.file}:${c.line}`);
  }
  if (!bad) pass(`${seen.size === 0 ? calls.filter(c => c.method).length : 0} method call(s) all resolve`);
}

// ── link 3: every channel the preload invokes has a handler ─────────────────────────────────────
const invoked = new Map();   // channel -> where
for (const [label, src] of [['preload.js', preloadSrc], ['preload-handlers.js', handlersSrc]]) {
  for (const m of src.matchAll(/ipcRenderer\.(?:invoke|send)\(\s*['"]([^'"]+)['"]/g))
    if (!invoked.has(m[1])) invoked.set(m[1], label);
}

const handled = new Set();
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'tests') walk(p); }
    else if (e.name.endsWith('.js')) {
      const s = rd(p);
      for (const m of s.matchAll(/ipcMain\.(?:handle|on)\(\s*['"]([^'"]+)['"]/g)) handled.add(m[1]);
      // `for (const c of [...]) ipcMain.handle(c, ...)` and template channels are common enough to
      // matter; record the literal members of any array of strings assigned near an ipcMain.handle.
      for (const m of s.matchAll(/ipcMain\.(?:handle|on)\(\s*`([^`$]+)`/g)) handled.add(m[1]);
    }
  }
})(P('electron'));

console.log('\n== link 3: every channel the preload invokes has an ipcMain handler ==');
{
  // Channels main registers dynamically (loops, computed names) cannot be seen statically. Rather
  // than weaken the check for everything, the few known-dynamic prefixes are named here.
  const DYNAMIC_OK = [/^engine:/, /^audio:/, /^r2:/, /^system:/, /^shell:/];
  const missing = [...invoked.keys()]
    .filter(c => !handled.has(c))
    .filter(c => !DYNAMIC_OK.some(re => re.test(c)));
  const fresh = missing.filter(c => !KNOWN_MISSING_HANDLERS.has(c));
  const known = missing.filter(c =>  KNOWN_MISSING_HANDLERS.has(c));

  if (!fresh.length) pass(`${invoked.size} channel(s) invoked, ${known.length} known-broken, no NEW breakage`);
  else {
    for (const c of fresh.slice(0, 20)) fail(`no ipcMain handler for '${c}' (invoked in ${invoked.get(c)}) — a renderer call that cannot land`);
    if (fresh.length > 20) fail(`...and ${fresh.length - 20} more`);
  }

  // The ratchet only holds if a fixed channel is removed from the list. A stale entry silences a
  // channel that works, which is how a ratchet quietly becomes an allowlist.
  const healed = [...KNOWN_MISSING_HANDLERS].filter(c => !invoked.has(c) || handled.has(c));
  if (!healed.length) {
    if (known.length) console.log(`  NOTE  ${known.length} channel(s) still have no handler and are ratcheted: ${known.join(', ')}`);
  } else fail(`KNOWN_MISSING_HANDLERS is stale — ${healed.join(', ')} now resolve(s). Delete the line(s); never add.`);
}

console.log(failures === 0
  ? '\nVERDICT: PASS — every renderer call crosses all three joins.\n'
  : `\nVERDICT: FAIL — ${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
