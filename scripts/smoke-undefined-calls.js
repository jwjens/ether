// scripts/smoke-undefined-calls.js
//
// THE CONTRACT: every bare function call in these files resolves to something that exists.
//
// WHY THIS EXISTS. 873aab4 renamed saveR2Config() to saveIntervalHours() in electron/cloud-backup.js
// and updated the caller in the set-r2-config handler — but not the one at the end of runBackup().
// It shipped in 4.6.24 and 4.6.25. On OV it threw ReferenceError on every SUCCESSFUL backup: both
// PUTs completed, then the call blew up, the outer catch recorded a FAILED history row for a backup
// that had worked, run-now returned ok:false, and the caller returned early so the AUDIO half never
// ran. A rename with one missed call site, invisible until a customer hit it.
//
// tsc --noEmit does not cover electron/**: those are plain .js outside the renderer's program, so
// nothing type-checked them and nothing ever will until checkJS is turned on there. This is the
// cheap half of that — it answers one question only, "is this name defined anywhere it could be",
// and it answers it from the AST so a name inside a string or a comment cannot fool it.
//
// Jeff, 2026-09-11: "take the cheap guard now ... checkJS across electron/** is the right answer but
// it's a bigger change and I don't want it riding along with this."
//
// SCOPE: deliberately narrow. Bare Identifier callees — foo() — only. Not obj.method(), which needs
// real type information to resolve and is what checkJS is actually for.

const fs   = require('fs');
const path = require('path');
const acorn = require('acorn');

const ROOT = path.join(__dirname, '..');

// Grow this list as files earn a rename. cloud-backup.js is here because it is where the defect
// happened; main.js is not, yet, because it is 11k lines and wants the checkJS pass instead.
const FILES = [
  'electron/cloud-backup.js',
  'electron/ai-voice.js',
  'electron/library-health.js',
  'electron/audio-library-r2.js',
];

// Node + Electron main-process globals. Anything genuinely ambient goes here, with the rule that a
// name is added only when it is really provided by the runtime — never to silence a real miss.
const AMBIENT = new Set([
  'require', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'String', 'Number', 'Boolean', 'Array', 'Object',
  'Date', 'Error', 'TypeError', 'RangeError', 'Promise', 'Symbol', 'Map', 'Set', 'WeakMap',
  'WeakSet', 'JSON', 'Math', 'RegExp', 'Buffer', 'URL', 'URLSearchParams', 'TextEncoder',
  'TextDecoder', 'AbortController', 'fetch', 'queueMicrotask', 'structuredClone', 'BigInt',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'Intl', 'Proxy', 'Reflect',
]);

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures++; console.log(`  FAIL  ${m}`); };

// Collect every name a call could legally resolve to in this file: declarations at any scope,
// function parameters, catch bindings, class names, and destructured require() bindings. This is a
// FLAT collection on purpose — it over-approximates scope, so the check can report a name that does
// not exist anywhere but never invents a shadowing complaint it cannot prove.
function declaredNames(ast) {
  const names = new Set();
  const addPattern = (node) => {
    if (!node) return;
    switch (node.type) {
      case 'Identifier': names.add(node.name); break;
      case 'ObjectPattern': node.properties.forEach(p => addPattern(p.value || p.argument)); break;
      case 'ArrayPattern': node.elements.forEach(e => addPattern(e)); break;
      case 'AssignmentPattern': addPattern(node.left); break;
      case 'RestElement': addPattern(node.argument); break;
      default: break;
    }
  };
  walk(ast, (node) => {
    switch (node.type) {
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        if (node.id) names.add(node.id.name);
        node.params.forEach(addPattern);
        break;
      case 'VariableDeclarator': addPattern(node.id); break;
      case 'ClassDeclaration': if (node.id) names.add(node.id.name); break;
      case 'CatchClause': addPattern(node.param); break;
      default: break;
    }
  });
  return names;
}

function calledNames(ast) {
  const calls = [];
  walk(ast, (node) => {
    if (node.type === 'CallExpression' && node.callee && node.callee.type === 'Identifier') {
      calls.push({ name: node.callee.name, start: node.callee.start });
    }
  });
  return calls;
}

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
    const child = node[key];
    if (Array.isArray(child)) child.forEach(c => walk(c, visit));
    else if (child && typeof child.type === 'string') walk(child, visit);
  }
}

const lineOf = (src, index) => src.slice(0, index).split('\n').length;

console.log('\n== every bare call resolves to a name that exists ==');
for (const rel of FILES) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { fail(`${rel} — file not found; the guard's file list is stale`); continue; }
  const src = fs.readFileSync(abs, 'utf8');
  let ast;
  try {
    ast = acorn.parse(src, { ecmaVersion: 2023, sourceType: 'script', allowReturnOutsideFunction: true });
  } catch (e) {
    fail(`${rel} — could not parse: ${e.message}`);
    continue;
  }
  const declared = declaredNames(ast);
  const missing = [];
  for (const c of calledNames(ast)) {
    if (declared.has(c.name) || AMBIENT.has(c.name)) continue;
    missing.push(`${rel}:${lineOf(src, c.start)} ${c.name}()`);
  }
  if (missing.length === 0) pass(`${rel} — no call to an undefined name`);
  else fail(`${rel} calls ${missing.length} name(s) that are defined nowhere in it: ${missing.join(', ')}`);
}

// The guard has to be able to fail, or it is decoration. Prove it on a synthetic source rather than
// by breaking a real file.
{
  const probe = acorn.parse('function a(){} a(); ghostFn();', { ecmaVersion: 2023 });
  const declared = declaredNames(probe);
  const missing = calledNames(probe).filter(c => !declared.has(c.name) && !AMBIENT.has(c.name));
  if (missing.length === 1 && missing[0].name === 'ghostFn') pass('the guard detects a missing name (self-test)');
  else fail(`self-test broken — expected to catch ghostFn(), caught ${JSON.stringify(missing.map(m => m.name))}`);
}

console.log(failures === 0
  ? '\nVERDICT: PASS — no call in these files names a function that does not exist.\n'
  : `\nVERDICT: FAIL — ${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
