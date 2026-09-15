'use strict';
// scripts/smoke-calendar-anchor.js — the decks follow the calendar, and the on-air deck is never touched.
//
// Jeff, 2026-09-14: "the calendar is always supposed to be running no matter what. the queue and decks
// are a slave to the calendar so it should anchor back to the calendar if it's off."
//
// THREE PLACES THE RULE WAS BROKEN:
//   1. automationStart took queue[0] — whatever was queued — and played it. It never asked what should
//      be on air at this second, so engaging AUTO after any break resumed where the queue had been left
//      rather than where the clock is.
//   2. A cued deck holding a stale row was never re-synced, so an overdue spot could not take the next
//      slot — the rows in front of it were already cued and nothing would replace them.
//      FIXED BY RE-CUEING (_resyncCuedDecks), not by changing what the bound head contains. My first
//      attempt filtered the bound head down to playing decks and had to be reverted the same night;
//      see the section below for why that emptied it.
//   3. (left in place, now redundant) the top-of-hour hard cut re-anchors once an hour.
//
// §2.4a of docs/log-reader-single-source-playout-design-2026-07-20.md has said since 2026-07-20 that
// "only the currently-playing deck is committed". The code committed every cued deck.
//
// WHAT THIS COVERS. The guards are a pure decision over deck state, so the decision is reproduced here
// and the wiring is asserted against the source. Re-cueing a loaded deck is the one thing in this change
// that could take a station off the air, so every refusal it depends on is pinned.
//
//   node scripts/smoke-calendar-anchor.js

const path = require('path'), fs = require('fs');
let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures++; console.log(`  FAIL  ${m}`); };
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'audiod', 'engine.js'), 'utf8');

console.log('\n== AUTO anchors to the calendar ==');
{
  const body = src.slice(src.indexOf('automationStart'), src.indexOf('JINGLES overlay v1 — CART overlay'));
  if (/await this\._refillFromLog\(\{ force: true \}\)/.test(body))
    pass('automationStart re-anchors before it picks anything');
  else fail('AUTO still plays whatever is at the head of the queue');

  if (/if \(!opts\.force && now - \(this\._lastRefillAt \|\| 0\) < 2000\) return;/.test(src))
    pass('the 2s throttle is bypassable, so AUTO anchors to THIS second');
  else fail('the forced refill cannot bypass the throttle — AUTO could anchor up to 2s late');

  // Against the WHOLE file, and to the dequeue that FOLLOWS the anchor: `const first = this.dequeue()`
  // also appears in resume-playout and the top-of-hour cut, so slicing on the function name alone
  // picked up an unrelated one and failed a correct ordering.
  const i = src.indexOf('_refillFromLog({ force: true })');
  const j = src.indexOf('const first = this.dequeue();', i);
  if (i > 0 && j > i && (j - i) < 1200) pass('the anchor happens BEFORE the first track is taken');
  else fail(`the anchor runs after the track is chosen — it would correct nothing (i=${i}, j=${j})`);
}

console.log('\n== the cued decks stay IN the queue (hunk reverted the same night) ==');
{
  // I first filtered the bound head down to playing decks. dequeue() splices an item out of the
  // queue AND out of boundQids the moment its deck goes live, so the playing row is never in the
  // queue at all — the filter made the bound head ALWAYS EMPTY, dropped the cued decks' items while
  // the decks still held them, and rows went out stamped `missed` while audibly on air.
  // §2.4a is honoured by RE-CUEING a diverged deck, not by evicting it from the queue that tracks it.
  if (/const boundHead = this\.queue\.filter\(q => this\.boundQids\.has\(q\.qid\)\);/.test(src))
    pass('the bound head is the cued decks — they stay represented in the queue');
  else fail('the bound head no longer tracks the cued decks; dequeue() would desync from the decks');

  if (!/const playingDecks = \["A", "B", "C"\]\.filter/.test(src))
    pass('the playing-decks-only filter that emptied the bound head is gone');
  else fail('the filter that emptied the bound head is still there');
}
console.log('\n== the re-cue refuses whenever the seam is in motion ==');
{
  const fn = src.slice(src.indexOf('_resyncCuedDecks() {'), src.indexOf('_nextRotateDeck(fromDeck)'));

  const guards = [
    [/if \(!this\._started \|\| !this\._logReaderOn\(\)\) return;/, 'automation off, or a legacy station'],
    [/if \(this\._jingle\) return;/,                                'a sweeper is ARMED or FIRING for this seam'],
    [/if \(playing && this\.segueTriggered\.has\(playing\)\) return;/, 'the rotate has already begun'],
    [/remaining > \(this\.segueOverlap \|\| 0\) \+ 2/,                 'a margin over the segue point'],
    [/if \(this\.manualCue\.has\(d\)\) continue;/,                     'an operator-cued deck is left alone'],
  ];
  for (const [re, what] of guards) {
    if (re.test(fn)) pass('refuses on: ' + what);
    else fail('MISSING refusal: ' + what);
  }

  // The one that matters most, asserted twice: before the chain and again inside it.
  const outer = /if \(this\._deckState\(d\)\.status === "playing" \|\| this\._deckState\(d\)\.status === "paused"\) continue;/.test(fn);
  const inner = /if \(s2\.status === "playing" \|\| s2\.status === "paused"\) return;/.test(fn);
  if (outer && inner) pass('a PLAYING or PAUSED deck is refused twice — before the chain and inside it');
  else fail(`the on-air deck is not doubly protected (outer=${outer}, inner=${inner}) — this could cut audio`);

  if (/this\._advance\("recue:/.test(fn))
    pass('the reload runs inside _advance — it cannot interleave with a rotate');
  else fail('the reload is not serialized against the rotate chain');

  if (/_resyncCuedDecks\(\);/.test(src.slice(src.indexOf('logreader refill: '))))
    pass('it is called after the anchored rebuild');
  else fail('nothing calls it');
}

console.log('\n== the decision itself ==');
{
  // Reproduced from the guards above: may this deck be re-cued?
  const mayRecue = ({ status, isPlayingDeck, jingle, segueTriggered, remaining, overlap, manual, ready, sameFile }) => {
    if (jingle) return false;
    if (segueTriggered) return false;
    if (!(remaining > overlap + 2)) return false;
    if (isPlayingDeck) return false;
    if (status === 'playing' || status === 'paused') return false;
    if (manual) return false;
    if (!ready) return false;
    if (sameFile) return false;
    return true;
  };
  const base = { status: 'idle', isPlayingDeck: false, jingle: false, segueTriggered: false,
                 remaining: 60, overlap: 3, manual: false, ready: true, sameFile: false };

  if (mayRecue(base)) pass('an idle cued deck holding the wrong row IS re-cued');
  else fail('the normal case is refused — nothing would ever be corrected');
  if (!mayRecue({ ...base, status: 'playing' })) pass('a playing deck is never re-cued');
  else fail('a playing deck could be re-cued — this would cut audio');
  if (!mayRecue({ ...base, jingle: true })) pass('not while a sweeper is armed');
  else fail('a re-cue could pull the file from under an armed sweeper');
  if (!mayRecue({ ...base, remaining: 4 })) pass('not inside the segue margin (4s left, overlap 3)');
  else fail('a re-cue could land in the same tick as the rotate');
  if (!mayRecue({ ...base, sameFile: true })) pass('a deck already holding the right row is left alone');
  else fail('a correct deck would be needlessly reloaded every refill');
  if (!mayRecue({ ...base, manual: true })) pass("an operator's own cue is never overridden");
  else fail('a hand-cued deck would be stolen');
}

console.log(failures === 0
  ? '\nVERDICT: PASS — the decks follow the calendar, and the on-air deck is untouchable.\n'
  : `\nVERDICT: FAIL — ${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
