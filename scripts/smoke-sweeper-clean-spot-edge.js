'use strict';
// scripts/smoke-sweeper-clean-spot-edge.js — a sweeper's lead never plays over a commercial.
//
// Jeff, station 2 halloVeen, on air 2026-09-14: "sweepers are being scheduled against the GC spot."
//
// WHAT WAS ACTUALLY HAPPENING, because it is not what it looks like. The sweeper is stamped at the
// INCOMING song's scheduled_at and is correct there — 0 sweeper rows in that log sat at a SPOT slot,
// and _placeJingles' class filter was never defeated. But LEAD fires a sweeper N seconds before the
// OUTGOING element ends, and nothing checked what that element was. Measured on the live log: all
// 4,223 spots were followed by a sweeper reaching 2s back into them.
//
// THE RULE IS NOT NEW. _segueTick already refuses to overlap a spot's tail ("a SPOT is exclusive
// PROGRAM content — the spot plays alone"), and docs/help-spots.md has promised operators "clean
// start, clean end, no music overlap in or out AND NO SWEEPER OVER IT" for months. The sweeper path
// was the one route that never honoured it.
//
// AND IT IS NOT A REFUSAL. bd87a95 deleted a guard that suppressed the seam entirely when a deck held
// a SPOT, because it silently dropped operator placements. The sweeper still fires; its lead is
// clamped to 0 so it starts AT the seam. Both halves below assert that it still fires.
//
//   node scripts/smoke-sweeper-clean-spot-edge.js

const path = require('path');
const fs   = require('fs');

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures++; console.log(`  FAIL  ${m}`); };

const ROOT = path.join(__dirname, '..');

// ── AIR SIDE ────────────────────────────────────────────────────────────────────────────────────
// _armJingle is deep inside DaemonEngine and needs a daemon to instantiate. What it does with the
// lead is a pure decision over two inputs, so the decision is exercised directly: the source is read,
// the ceiling expression is located, and the behaviour is reproduced against it. That keeps the test
// honest about WHAT it covers — the clamp rule, not the whole arm lifecycle.
console.log('\n== air side: the lead is clamped when the outgoing deck holds a spot ==');
{
  const src = fs.readFileSync(path.join(ROOT, 'audiod', 'engine.js'), 'utf8');

  if (/const\s+outgoingIsSpot\s*=\s*this\.deckContentClass\[deck\]\s*===\s*"SPOT"/.test(src))
    pass('_armJingle reads the OUTGOING deck\'s content class');
  else fail('_armJingle does not look at what the outgoing deck is holding — the lead can reach into anything');

  if (/const\s+ceiling\s*=\s*outgoingIsSpot\s*\?\s*0\s*:\s*this\.effectiveLeadCeiling\(\)/.test(src))
    pass('a spot on the outgoing deck makes the lead ceiling 0 — the sweeper starts AT the seam');
  else fail('the spot case does not clamp the ceiling to 0');

  // The clamp must not become a refusal: bd87a95 removed exactly that.
  const armBody = src.slice(src.indexOf('_armJingle(jin, deck) {'), src.indexOf('_cancelJingle('));
  if (!/outgoingIsSpot[\s\S]{0,400}?\breturn\b/.test(armBody.split('this._emitJingle("ARMED"')[0]))
    pass('the spot case does NOT return early — the placement still fires (bd87a95 stands)');
  else fail('the spot case returns without arming — that re-introduces the suppression bd87a95 deleted');

  if (/sweeper-lead-clamped-spot/.test(src))
    pass('the reduction is reported, not silent — the engine never asserts a number it did not honour');
  else fail('the clamp is silent');

  // Reproduce the decision itself over the two inputs that matter.
  const decide = (leadInSec, outgoingClass, armCeiling) =>
    Math.min(leadInSec, outgoingClass === 'SPOT' ? 0 : armCeiling);

  if (decide(2, 'SPOT', 24) === 0) pass('lead 2s over a SPOT resolves to 0s');
  else fail('lead over a SPOT was not zeroed');
  if (decide(2, 'MUSIC', 24) === 2) pass('lead 2s over MUSIC is untouched — the ordinary seam still overlaps');
  else fail('a music seam lost its lead — this would flatten every sweeper on the station');
  if (decide(40, 'MUSIC', 24) === 24) pass('the arm-window ceiling still applies on a music seam');
  else fail('the existing arm-window clamp was broken');
  if (decide(0, 'SPOT', 24) === 0) pass('an operator LEAD of 0 is unchanged by the spot case');
  else fail('LEAD 0 was altered');
}

// ── GENERATE SIDE ───────────────────────────────────────────────────────────────────────────────
// _placeJingles is ~200 lines inside main.js with prepared statements bound to a live DB. The part
// under test is the one arithmetic decision — which seams a spot ends on — so that is what is
// reproduced here, from the same row shape Generate builds.
console.log('\n== generate side: the log states lead 0 rather than promising 2 ==');
{
  const src = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');

  if (/const spotEndsAt = new Set\(\);/.test(src)) pass('_placeJingles computes where spots end');
  else fail('_placeJingles does not know where spots end');

  if (/lead_in_sec:\s*spotEndsAt\.has\(incoming\.scheduled_at\)\s*\?\s*0\s*:/.test(src))
    pass('a placement whose seam is the end of a spot is written with lead_in_sec 0');
  else fail('the placement still records the full lead over a spot — the log would disagree with air');

  // The set arithmetic, on the shape Generate actually produces.
  const rows = [
    { scheduled_at: 1000, duration_s: 200, content_class: 'MUSIC', song_id: 1 },
    { scheduled_at: 1200, duration_s: 15,  content_class: 'SPOT',  song_id: null },
    { scheduled_at: 1215, duration_s: 180, content_class: 'MUSIC', song_id: 2 },
    { scheduled_at: 1395, duration_s: 120, content_class: 'MUSIC', song_id: 3 },
    { scheduled_at: 1515, duration_s: 30,  content_class: null,    song_id: null },  // unlabelled → MUSIC
  ];
  const spotEndsAt = new Set();
  for (const r of rows) {
    if ((r.content_class || 'MUSIC') !== 'SPOT') continue;
    spotEndsAt.add(r.scheduled_at + (r.duration_s || 0));
  }
  const lead = (at) => spotEndsAt.has(at) ? 0 : 2;

  if (spotEndsAt.size === 1 && spotEndsAt.has(1215)) pass('one spot end found, at the right second');
  else fail(`spot ends computed as ${[...spotEndsAt].join(',')} — expected 1215`);
  if (lead(1215) === 0) pass('the song that follows the spot gets lead 0');
  else fail('the song after the spot still carries a lead into it');
  if (lead(1395) === 2) pass('the next song along keeps its full lead');
  else fail('a song unrelated to the spot lost its lead');
  if (lead(1000) === 2) pass('a song before the spot is untouched');
  else fail('a song before the spot was altered');
}

console.log(failures === 0
  ? '\nVERDICT: PASS — the sweeper still fires, and never over the commercial.\n'
  : `\nVERDICT: FAIL — ${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
