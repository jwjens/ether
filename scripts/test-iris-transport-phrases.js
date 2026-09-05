#!/usr/bin/env node
/**
 * TEST: the operator transport phrase matcher + the capability token store.
 *
 * Two properties are under test, and they are the two that make the gate real rather than
 * decorative:
 *
 *   1. EVERY phrase in the reviewed list resolves to its own verb — and a NEGATED variant of every
 *      phrase resolves to nothing. "Don't skip this" must never mint a skip token. That is one test
 *      per phrase, per Jeff's instruction (2026-09-04), generated from the list itself so a phrase
 *      cannot be added without being tested.
 *
 *   2. A token is verb-scoped, single-use, expiring, and unforgeable.
 *
 * Run: npm run test:iris-phrases
 */
const phrases = require('../electron/iris-transport-phrases');
const store = require('../electron/iris-operator-tokens');

let pass = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  failures.push(`${name}\n      expected: ${e}\n      actual:   ${a}`);
}

const verbOf = (text) => { const r = phrases.resolve(text); return r ? r.verb : null; };

// ── 1 · every phrase resolves to its own verb ───────────────────────────────────────────────────
console.log('\n── every phrase in the reviewed list → its own verb ──');
let phraseCount = 0;
for (const entry of phrases.TRANSPORT_PHRASES) {
  for (const p of entry.phrases) {
    phraseCount++;
    check(`  "${p}" → ${entry.verb}`, verbOf(p), entry.verb);
  }
}
console.log(`   ${phraseCount} phrases`);

// ── 2 · NEGATION: every phrase, negated, authorises nothing ─────────────────────────────────────
console.log('\n── every phrase, negated → null ──');
const NEGATION_PREFIXES = ["dont", "do not", "never", "please dont", "id rather you didnt"];
for (const entry of phrases.TRANSPORT_PHRASES) {
  for (const p of entry.phrases) {
    for (const neg of NEGATION_PREFIXES) {
      check(`  "${neg} ${p}" → null`, verbOf(`${neg} ${p}`), null);
    }
  }
}
console.log(`   ${phraseCount} phrases x ${NEGATION_PREFIXES.length} negations`);

// ── 3 · the specific traps ──────────────────────────────────────────────────────────────────────
console.log('\n── traps ──');
const TRAPS = [
  // [utterance, expected verb or null, why]
  ['skip this song',                'skip',     'longest phrase wins at the same position'],
  ['stop automation',               'auto-off', 'NOT stop — leaving automation must not kill audio'],
  ['stop the music',                'stop',     'plain stop still works'],
  ['turn automation off',           'auto-off', 'multi-word, contains a shorter phrase'],
  ['next track',                    'skip',     '"next track" is a skip, not the next verb'],
  ['next',                          'next',     'bare next is the next verb'],
  ['stop and skip',                 null,       'AMBIGUOUS — two distinct verbs fails closed'],
  ['play then pause',               null,       'ambiguous compound'],
  ['should we skip this',           null,       'deliberative opener — thinking out loud'],
  ['do you think we should stop',   null,       'deliberative opener'],
  ['what happens if i skip this',   null,       'deliberative opener'],
  ['skip this, should i?',          'skip',     'instruction with a tag question still counts'],
  ['dont skip this',                null,       'negation'],
  ['do not stop the music',         null,       'negation, two-token'],
  ['no skip it',                    null,       'documented false veto — fails CLOSED, acceptable'],
  ['whats playing right now',       null,       'a question mints nothing'],
  ['how is the show going',         null,       'ordinary chat mints nothing'],
  ['',                              null,       'empty'],
  [null,                            null,       'null-safe'],
  ['   ',                           null,       'whitespace'],
  ['SKIP THIS TRACK',               'skip',     'case-insensitive'],
  ["don't skip this",               null,       'real apostrophe normalises to the negator'],
  ['skip!!!',                       'skip',     'punctuation stripped'],
];
for (const [text, expected, why] of TRAPS) {
  check(`  ${JSON.stringify(text)} → ${expected} (${why})`, verbOf(text), expected);
}

// ── 4 · the token store ─────────────────────────────────────────────────────────────────────────
console.log('\n── capability tokens ──');
store._reset();

const minted = store.mintFromUtterance('skip this track', 'utt-1');
check('  an authorising utterance mints', minted && minted.verb, 'skip');

const nothing = store.mintFromUtterance('what is playing right now', 'utt-2');
check('  a non-authorising utterance mints NOTHING', nothing, null);

const negated = store.mintFromUtterance('dont skip this', 'utt-3');
check('  a negated utterance mints NOTHING', negated, null);

// verb scoping — the token from "skip" cannot be widened
const widen = store.consume(minted.token, 'stop');
check('  a skip token cannot fire stop', widen.ok, false);
check('  ...and says why', widen.reason, 'token_verb_mismatch');

// the correct verb works
const good = store.consume(minted.token, 'skip');
check('  the skip token fires skip', good.ok, true);

// single use
const again = store.consume(minted.token, 'skip');
check('  the same token cannot be reused', again.ok, false);
check('  ...and says why', again.reason, 'unknown_or_spent_token');

// forgery
check('  an invented token is refused', store.consume('deadbeef'.repeat(8), 'skip').reason, 'unknown_or_spent_token');
check('  no token at all is refused',   store.consume(null, 'skip').reason, 'no_operator_token');
check('  empty string is refused',      store.consume('', 'skip').reason, 'no_operator_token');

// expiry — reach in and age it, rather than sleeping 90s
const aged = store.mintFromUtterance('stop the music', 'utt-4');
check('  minted a stop token', aged && aged.verb, 'stop');
const outstandingBefore = store.outstanding().length;
check('  it is outstanding', outstandingBefore >= 1, true);
// Simulate the clock moving past the TTL.
const realNow = Date.now;
Date.now = () => realNow() + store.TTL_MS + 1000;
const expired = store.consume(aged.token, 'stop');
Date.now = realNow;
check('  an expired token is refused', expired.ok, false);
check('  ...and says why', expired.reason, 'token_expired');

// ── report ──────────────────────────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(70));
if (failures.length) {
  console.log(`FAILED — ${failures.length} of ${pass + failures.length} checks\n`);
  for (const f of failures) console.log('  ✗ ' + f);
  console.log('');
  process.exit(1);
}
console.log(`PASS — all ${pass} checks\n`);
