'use strict';
// LOCAL PLAYBACK GUARD — every sound a window makes passes the MONITOR gain (2026-10-07, mandatory in CI).
//
// Jeff's rule: the MONITOR fader is the local master output; nothing reaches a local device without it. The engine
// half is enforced by type (native/src/localout.rs). The renderer half is ONE module — src/audio/localOutput.ts —
// and this guard fails the build if any other file in src/ makes sound around it:
//   • `.destination`                 — connecting a Web Audio graph to the speakers (use localDestination(ctx))
//   • `new Audio(`                   — an audio element (use localAudio(src))
//   • `speechSynthesis.speak`        — TTS (use speakLocal(u))
//   • an <audio> / <video> JSX tag    — must be `muted` or carry ref={localMediaRef} / bindLocalMedia
//   • document.createElement("audio"|"video") — must set `.muted = true` or be bound with bindLocalMedia
// Strict: zero violations. Comment lines are ignored. docs/monitor-bypass-diagnosis.md.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const ALLOWED = new Set(['src/audio/localOutput.ts']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

/** Returns [{ line, rule, text }] for one file's source. Exported for the self-test. */
function check(src) {
  const lines = src.split(/\r?\n/);
  const bad = [];
  lines.forEach((line, i) => {
    if (isComment(line)) return;
    const code = line.replace(/\/\/.*$/, '');   // drop a trailing line comment
    if (/\.destination\b/.test(code)) bad.push({ line: i + 1, rule: 'connects to .destination (use localDestination(ctx))', text: line.trim() });
    if (/new Audio\(/.test(code)) bad.push({ line: i + 1, rule: 'new Audio( (use localAudio(src))', text: line.trim() });
    if (/speechSynthesis\.speak\b/.test(code)) bad.push({ line: i + 1, rule: 'speechSynthesis.speak (use speakLocal(u))', text: line.trim() });
    if (/<(audio|video)\b/.test(code)) {
      // The whole tag, up to its end (it may span lines).
      let tag = code.slice(code.search(/<(audio|video)\b/));
      for (let j = i + 1; j < Math.min(lines.length, i + 20) && !/\/?>/.test(tag.replace(/=>/g, '')); j++) tag += ' ' + lines[j];
      if (!/\bmuted\b/.test(tag) && !/localMediaRef|bindLocalMedia/.test(tag)) {
        bad.push({ line: i + 1, rule: '<audio>/<video> that is not muted and not bound to MONITOR (ref={localMediaRef})', text: line.trim() });
      }
    }
    const ce = code.match(/createElement\(\s*["'](audio|video)["']\s*\)/);
    if (ce) {
      const near = lines.slice(i, i + 8).join(' ');
      if (!/\.muted\s*=\s*true/.test(near) && !/bindLocalMedia/.test(near)) {
        bad.push({ line: i + 1, rule: 'createElement("' + ce[1] + '") not muted and not bound to MONITOR', text: line.trim() });
      }
    }
  });
  return bad;
}

// ── self-test: the guard must catch each way of making sound ─────────────────────────────────────────────────────
const SELF = [
  ['src.connect(ctx.destination);', 1],
  ['const a = new Audio(url);', 1],
  ['window.speechSynthesis.speak(u);', 1],
  ['<audio src={x} controls autoPlay />', 1],
  ['<video\n  src={clip}\n  controls\n/>', 1],
  ['const v = document.createElement("video");\nv.src = x;', 1],
  // allowed shapes
  ['src.connect(localDestination(ctx));', 0],
  ['<video ref={vidRef} autoPlay playsInline muted />', 0],
  ['<audio ref={localMediaRef} src={x} controls />', 0],
  ['const v = document.createElement("video");\nv.muted = true;', 0],
  ['// src.connect(ctx.destination) in a comment', 0],
];
let selfOk = true;
for (const [snippet, want] of SELF) {
  const got = check(snippet).length;
  if (got !== want) { selfOk = false; console.error(`  SELF-TEST FAIL: expected ${want}, got ${got}: ${JSON.stringify(snippet)}`); }
}
if (!selfOk) { console.error('❌ LOCAL PLAYBACK GUARD: self-test failed — the guard itself is broken'); process.exit(1); }
console.log('  PASS  self-test: every way of making sound is caught, the allowed shapes are not');

let total = 0;
for (const f of walk(SRC)) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  if (ALLOWED.has(rel)) continue;
  for (const b of check(fs.readFileSync(f, 'utf8'))) {
    total++;
    console.error(`  ✗ ${rel}:${b.line}  ${b.rule}\n      ${b.text.slice(0, 140)}`);
  }
}
if (total > 0) {
  console.error(`\n❌ LOCAL PLAYBACK GUARD FAILED: ${total} place(s) in src/ make sound without the MONITOR gain.`);
  console.error('   Route them through src/audio/localOutput.ts (localDestination / localAudio / localMediaRef / speakLocal).');
  process.exit(1);
}
console.log('VERDICT: PASS — every sound a window makes passes the MONITOR gain (src/audio/localOutput.ts).');
module.exports = { check };
