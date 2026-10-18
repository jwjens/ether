// node scripts/lib/log-checker.test.js — the checker is the gate's judge, so it is proven on its own.
"use strict";
const assert = require("assert");
const C = require("./log-checker");

let n = 0; const ok = (name, fn) => { fn(); n++; console.log("ok  " + name); };
const split = C.artistSplitter();
const ev = (ts, file, artist, title, ref) => C.makeEvent({ ts, file, artist, title, kind: "aired", ref }, split);

ok("recording = stored file name, any folder, any case", () => {
  assert.strictEqual(C.recordingKey("C:\\Music\\HV\\Thriller.MP3"), "thriller.mp3");
  assert.strictEqual(C.recordingKey("/Users/x/Thriller.mp3"), "thriller.mp3");
  assert.strictEqual(C.recordingKey(null), null);
});
ok("title normalised: case, punctuation, bracket tail, '- From' tail", () => {
  assert.strictEqual(C.normaliseTitle("Spooky, Scary Skeletons"), "spooky scary skeletons");
  assert.strictEqual(C.normaliseTitle("Thriller (2008 Remaster)"), "thriller");
  assert.strictEqual(C.normaliseTitle("This Is Halloween - From \"The Nightmare Before Christmas\""), "this is halloween");
  assert.strictEqual(C.normaliseTitle("Monster Mash [Live] (2010)"), "monster mash");
});
ok("artists split on / & , feat. ft. f/ x with — whole words only", () => {
  assert.deepStrictEqual(split("Monsters (feat. Demi Lovato and blackbear)".replace(/[()]/g, "")), ["monsters", "demi lovato and blackbear"]);
  assert.deepStrictEqual(split("Danny Elfman & Catherine O'Hara"), ["danny elfman", "catherine o'hara"]);
  assert.deepStrictEqual(split("Calvin Harris x Dua Lipa"), ["calvin harris", "dua lipa"]);
  assert.deepStrictEqual(split("Xzibit"), ["xzibit"]);
  assert.deepStrictEqual(split("Bing Crosby with The Andrews Sisters"), ["bing crosby", "the andrews sisters"]);
});
ok("a gap shorter than the rule breaks it; equal passes; both sides; off = never", () => {
  const tl = new C.Timeline();
  tl.add(ev(1000, "a.mp3", "X", "Song A", "p1"));
  tl.add(ev(1000 + 7200 + 600, "a.mp3", "X", "Song A", "p2"));
  const rules = { songMin: 120, artistMin: 60, titleMin: null };
  const at = (ts) => C.breaches(tl, ev(ts, "a.mp3", "Y", "Other", "probe"), rules);
  assert.strictEqual(at(1000 + 7200).length, 1);          // 2 h after p1 passes, but 10 min before p2 breaks (after side)
  assert.strictEqual(at(1000 + 7200)[0].side, "after");
  assert.strictEqual(at(1000 + 7199).length, 2);          // 1 s short of p1 and 10 min before p2
  const offTitle = C.breaches(tl, ev(1001, "z.mp3", "Q", "Song A", "probe"), rules);
  assert.strictEqual(offTitle.length, 0);                  // title rule off
  const artist = C.breaches(tl, ev(1000 + 3599, "z.mp3", "X & Y", "Zed", "probe"), rules);
  assert.deepStrictEqual(artist.map(b => b.rule), ["artist"]);
});
ok("the pick: longest waiting among those that pass; never aired waits longest; ties reported", () => {
  const tl = new C.Timeline();
  tl.add(ev(100, "old.mp3", "A", "Old", "p1"));
  tl.add(ev(5000, "new.mp3", "B", "New", "p2"));
  const pool = [{ rec: "old.mp3", artists: ["a"], title: "old" }, { rec: "new.mp3", artists: ["b"], title: "new" }];
  let d = C.rederivePick(tl, pool, 10000, { songMin: 60, artistMin: null, titleMin: null });
  assert.deepStrictEqual(d.longestWaiting.map(s => s.rec), ["old.mp3"]);
  d = C.rederivePick(tl, [...pool, { rec: "n1.mp3", artists: [], title: "n1" }, { rec: "n2.mp3", artists: [], title: "n2" }], 10000, { songMin: 60, artistMin: null, titleMin: null });
  assert.deepStrictEqual(d.longestWaiting.map(s => s.rec).sort(), ["n1.mp3", "n2.mp3"]);   // exact tie: never aired
  d = C.rederivePick(tl, pool, 5100, { songMin: 60, artistMin: null, titleMin: null });
  assert.deepStrictEqual(d.passing.map(s => s.rec), ["old.mp3"]);                         // new.mp3 blocked
});
ok("count proof: spread 2 fails unless every lower-count song was blocked (D1)", () => {
  const pools = new Map([[1, new Set(["a", "b", "c"])]]);
  const p = new C.CountProof(pools);
  p.onAir(1, "a", 1, () => null); p.onAir(1, "b", 2, () => null);
  p.onAir(1, "a", 3, () => null);                         // a=2, b=1, c=0 → spread 2, c was free → failure
  assert.strictEqual(p.failures.length, 1);
  const q = new C.CountProof(pools);
  q.onAir(1, "a", 1, () => null); q.onAir(1, "b", 2, () => null);
  q.onAir(1, "a", 3, (r) => r === "c" ? "artist 22/60 min" : null);   // c blocked by a named rule → exception
  assert.strictEqual(q.failures.length, 0); assert.strictEqual(q.exceptions.length, 1);
  const z = new C.CountProof(pools);
  for (const r of ["a", "b", "c", "b", "a", "c"]) z.onAir(1, r, 0, () => null);         // even rounds pass
  assert.strictEqual(z.failures.length, 0); assert.strictEqual(z.maxSpread.get(1), 1);
});
ok("per-song no repeat hours: its own window, on the recording, only when longer than the song rule", () => {
  const tl = new C.Timeline();
  tl.add(ev(0, "a.mp3", "X", "A", "p1"));
  const probe = (ts, h) => C.breaches(tl, C.makeEvent({ ts, file: "a.mp3", artist: "Y", title: "B", kind: "probe", ref: null, noRepeatHours: h }, split), { songMin: 120, artistMin: null, titleMin: null });
  assert.deepStrictEqual(probe(3 * 3600, 4).map(b => b.rule), ["no-repeat-hours"]);   // 3 h < 4 h
  assert.strictEqual(probe(4 * 3600, 4).length, 0);                                    // exactly 4 h passes
  assert.strictEqual(probe(3 * 3600, null).length, 0);                                 // no per-song value: song rule only
  assert.deepStrictEqual(probe(3600, 1).map(b => b.rule), ["song"]);                   // shorter than the song rule: song rule decides
});
console.log(`\nlog-checker: ${n} passed`);
