'use strict';
// scripts/smoke-ipc-payload-contract.js
//
// THE CONTRACT: a component may only read fields the producer actually broadcasts.
//
// WHY THIS EXISTS. OV, 4.6.27: "Cannot read properties of undefined (reading 'toLocaleString')" —
// the UI went down on install while audio kept running. LibrarySyncProgressBar subscribed to
// catalogue:backup:download:done and read `e.done` and `e.total`. That channel carries
// downloadCatalogue's result object, which names those two numbers `downloaded` and `toDownload`.
// Both reads were undefined, `finished` went true, and the label called .toLocaleString() on nothing.
//
// It survived review because the handler carried a HAND-WRITTEN TYPE ANNOTATION —
// `(e: { done: number; total: number; ... })` — asserting a shape nothing had ever checked against
// the producer. tsc typechecks the claim, not the wire. Two more instances of the same defect sat
// beside it, silent rather than loud: CloudBackup read `v.done` off the UPLOAD result (which names it
// `uploaded`), so a successful upload of any size reported "0 files"; and SettingsPanel read `total`,
// `consolidated` and `notFound` — fields belonging to the LEGACY library:sync-r2 uploader that step 4
// retired — so it printed "Uploaded 12 of 0" and two clauses that could never render.
//
// Jeff, 2026-09-11: "A hand-written type standing in for a checked contract is the defect class, not
// this one instance."
//
// HOW IT WORKS. Both sides are object literals in source, so both are readable from an AST:
//   producer — the `result` literal a catalogue engine resolves with, plus keys assigned to it after
//              construction, plus whatever main adds on the fatal path.
//   consumer — every `param.key` read inside a subscription's callback, optional chaining included.
// A read of a key no producer can send is a failure. No runtime, no Electron, no network.
//
// The TypeScript compiler API does the parsing rather than acorn: the consumers are .tsx and acorn
// cannot read them. Parsing only — no type checking, no program, no tsconfig.
//
// SCOPE: the catalogue channels, because their payload is an engine result rather than a literal
// written next to the send. Channels whose payload is built inline at the call site are a much
// smaller hazard; they are listed with their fields so a reader can see they were considered.

const fs   = require('fs');
const path = require('path');
const ts   = require('typescript');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures++; console.log(`  FAIL  ${m}`); };
const info = (m) => console.log(`        ${m}`);

const sourceFile = (rel) => {
  const src = read(rel);
  const kind = rel.endsWith('.tsx') ? ts.ScriptKind.TSX : rel.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return { sf: ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, kind), src };
};
const lineOf = (sf, pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

function eachNode(node, visit) {
  visit(node);
  node.forEachChild((c) => eachNode(c, visit));
}

// ── producer side ────────────────────────────────────────────────────────────────────────────────
// The `result` object a named engine function resolves with, including keys bolted on afterwards
// (`result.notInCloud = …`) — those are part of the payload just as much as the literal's own.
function producerKeys(fnName) {
  const { sf } = sourceFile('electron/audio-library-r2.js');
  let fnNode = null;
  eachNode(sf, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name && n.name.text === fnName) fnNode = n;
  });
  if (!fnNode) return null;

  const keys = [];
  eachNode(fnNode, (n) => {
    if (!ts.isVariableDeclaration(n)) return;
    if (!n.name || !ts.isIdentifier(n.name) || n.name.text !== 'result') return;
    if (!n.initializer || !ts.isObjectLiteralExpression(n.initializer)) return;
    for (const p of n.initializer.properties) {
      const nm = p.name && (p.name.text || (p.name.escapedText && String(p.name.escapedText)));
      if (nm) keys.push(nm);
    }
  });
  if (!keys.length) return null;

  eachNode(fnNode, (n) => {
    if (!ts.isBinaryExpression(n) || n.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
    const l = n.left;
    if (!ts.isPropertyAccessExpression(l)) return;
    if (!ts.isIdentifier(l.expression) || l.expression.text !== 'result') return;
    const k = l.name.text;
    if (!keys.includes(k)) keys.push(k);
  });
  return keys;
}

// ── consumer side ────────────────────────────────────────────────────────────────────────────────
// Every `param.key` inside the callback handed to a subscription, `param?.key` included.
function consumerReads(rel, subName) {
  const { sf } = sourceFile(rel);
  const out = [];
  eachNode(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    const callee = n.expression;
    let name = null;
    if (ts.isPropertyAccessExpression(callee)) name = callee.name.text;
    if (name !== subName) return;
    const cb = n.arguments && n.arguments[0];
    if (!cb || !(ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) return;
    const param = cb.parameters && cb.parameters[0];
    // A destructured parameter would need its own pass; say so rather than pass silently.
    if (param && ts.isObjectBindingPattern(param.name)) {
      out.push({ key: '<destructured — unchecked>', line: lineOf(sf, param.pos), destructured: true });
      return;
    }
    if (!param || !ts.isIdentifier(param.name)) return;
    const pname = param.name.text;
    eachNode(cb.body || cb, (m) => {
      if (!ts.isPropertyAccessExpression(m)) return;
      const obj = m.expression;
      if (!ts.isIdentifier(obj) || obj.text !== pname) return;
      out.push({ key: m.name.text, line: lineOf(sf, m.pos) });
    });
  });
  return out;
}

// ── the map ──────────────────────────────────────────────────────────────────────────────────────
const CONTRACTS = [
  { sub: 'onDownloadDone',     resultOf: 'downloadCatalogue', extra: ['fatal'] },
  { sub: 'onUploadDone',       resultOf: 'uploadCatalogue',   extra: ['fatal'] },
  { sub: 'onDownloadProgress', inline: ['phase', 'done', 'total', 'errors', 'current', 'in_progress', 'started_at'] },
  { sub: 'onUploadProgress',   inline: ['phase', 'done', 'total', 'errors', 'current'] },
  { sub: 'onDownloadState',    inline: ['in_progress', 'phase', 'done', 'total', 'errors', 'started_at'] },
];

const CONSUMERS = [
  'src/components/LibrarySyncProgressBar.tsx',
  'src/components/CloudBackup.tsx',
  'src/components/SettingsPanel.tsx',
  'src/components/CloudInstallPrompt.tsx',
  'src/components/OnboardingFlow.tsx',
  'src/App.tsx',
];

console.log('\n== every field a component reads off an IPC payload exists in what the producer sends ==');

for (const c of CONTRACTS) {
  let allowed;
  if (c.resultOf) {
    const keys = producerKeys(c.resultOf);
    if (!keys) { fail(`could not read ${c.resultOf}()'s result shape — the guard cannot check ${c.sub}`); continue; }
    allowed = new Set([...keys, ...(c.extra || [])]);
    info(`${c.sub} ← ${c.resultOf}(): ${keys.join(', ')}${c.extra ? `  (+${c.extra.join(', ')} on the failure path)` : ''}`);
  } else {
    allowed = new Set(c.inline);
    info(`${c.sub} ← built inline: ${c.inline.join(', ')}`);
  }

  let seen = 0;
  const bad = [];
  for (const file of CONSUMERS) {
    for (const r of consumerReads(file, c.sub)) {
      if (r.destructured) { bad.push(`${file}:${r.line} destructures the payload — the guard cannot check it`); continue; }
      seen++;
      if (!allowed.has(r.key)) bad.push(`${file}:${r.line} reads .${r.key}`);
    }
  }
  if (seen === 0 && bad.length === 0) { info(`  (no consumer reads a named field off ${c.sub})`); continue; }
  if (bad.length === 0) pass(`${c.sub}: all ${seen} field read(s) exist on the payload`);
  else fail(`${c.sub}: ${bad.length} bad read(s) — ${bad.join('; ')}`);
}

// The guard has to be able to fail, or it is decoration. Two self-tests: the producer really does
// name its counts the way the fix assumes, and a fabricated read is caught.
{
  const keys = producerKeys('downloadCatalogue');
  const ok = keys && keys.includes('downloaded') && keys.includes('toDownload') && !keys.includes('done') && !keys.includes('total');
  if (ok) pass('self-test: downloadCatalogue names its counts downloaded/toDownload — never done/total');
  else fail(`self-test broken — downloadCatalogue's result keys are ${JSON.stringify(keys)}`);

  const allowed = new Set(keys || []);
  if (!allowed.has('done') && !allowed.has('total')) pass('self-test: a read of .done or .total on that channel would be reported');
  else fail('self-test broken — the guard would not catch the 4.6.27 defect');
}

console.log(failures === 0
  ? '\nVERDICT: PASS — no component reads a field its producer does not send.\n'
  : `\nVERDICT: FAIL — ${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
