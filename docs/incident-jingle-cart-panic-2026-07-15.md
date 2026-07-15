# Incident — maiden jingle fire crashed the CART mixer (2026-07-15)

**The first-ever live jingle overlay played to its natural end on the CART channel and triggered a native
Rust panic that killed station 3's (Christmas / Magical Forest) audio output thread → frozen mix + dead air.
Other stations unaffected. NOT the JS advance chain — a latent native array-bounds bug on the CART-source-
exhausted path, first exposed by the jingle feature.** Recovery needs a restart (the output thread died).

## 1. Capture (receipts)

JS side clean — every `jingle-fire` `_advance` completed in 1-2ms; fires went ARMED→FIRING→CLEARED normally:
```
[RUST] Station 3 drain: real=354210 B/s          (healthy, mid-fire)
thread 'cpal_wasapi_out' (110732) panicked at src\audio.rs:988:21:
index out of bounds: the len is 6 but the index is 6
19:54:12  [engine s3] jingle CLEARED (done) — "…Transition…01"
… then [mix s3] active=1 frames=+0 peak=0.036 …  → drain real=0 B/s   (DEAD AIR, frozen)
```

## 2. Verdict — exact hang point

The maiden jingle overlay played to natural end on the **CART channel (mixer slot 6)**, and the mixer's
"source exhausted" cleanup panicked with an out-of-bounds — killing the `cpal_wasapi_out` thread for s3.

- `native/src/audio.rs:296` — `decks: [DeckSlot; 7]` (slot **6 = CART**).
- `native/src/audio.rs:577` — `DECK_LETTERS: [&str; 6] = ["A","B","C","D","E","F"]` (**len 6**).
- `native/src/audio.rs:985-988` — the exhaustion loop iterates all **7** decks; when the CART deck (i=6)
  source exhausts, `fin.set(DECK_LETTERS[6])` → **index out of bounds (len 6, index 6) → panic** → mixer
  callback dies → `[mix s3] frames=+0`, `drain=0` → dead air / frozen JINGLES VU.

**Why now / jingle path implicated (honestly, yes):** latent native bug never hit before because a CART
source had never played to **natural exhaustion** — manual carts are stopped/reloaded, never run to their
end. The jingle overlay is the first thing to let a CART source finish on its own, so the maiden fire tripped
it. The jingle CODE is fine; it exposed a real Rust array-bounds bug on the CART-exhaustion path.

## Minimal fix (native, `audio.rs:988`)

Guard the index — the CART deck (slot 6) is not in `DECK_LETTERS`:
```rust
if i < DECK_LETTERS.len() { fin.set(DECK_LETTERS[i]); eprintln!("[RUST] Deck {} finished …", DECK_LETTERS[i]); }
else { fin.set("CART"); }   // slot 6 = CART, tracked by the "CART" key (lib.rs:130), not DECK_LETTERS
```
This is a **native rebuild** (cargo + repackage).

## 3. Restore + safest disable

**Restore:** the `cpal_wasapi_out` thread PANICKED (died) — AUTO cannot revive a dead output thread (which is
why AUTO-cycling isn't working). s3 needs a **daemon/app restart** to respawn the audio thread. Do NOT just
reinstall 4.4.60 (recovers s3 but jingles re-fire → re-panic).

**Safest disable — recommend the JS kill-switch, not clearing assignments:**
- **Kill-switch (recommend):** one guard in the daemon (`engine.js _jingleTick` early-return, or
  `loggen.readJingleForSeam` → null) so jingles never arm/fire — the CART-exhaustion path is never reached.
  JS-only, no native rebuild, universal, can't leak, fast.
- **Clear the assignment (worse):** per-station; already-placed JIN rows in `generated_schedule` keep firing
  until a regen — leaky and slow.

**Recommended combined release (awaiting GO):** 4.4.60 respawn fix + JS jingle kill-switch → installing it
restarts everything (s3's dead thread respawns → all three audible, per the respawn fix) AND jingles stand
down (no re-panic). Then land the native `audio.rs:988` guard, prove the CART-exhaustion path, and re-enable
jingles.

## Backlog
- **Native: `audio.rs:988` CART-exhaustion out-of-bounds** — `DECK_LETTERS` (len 6) indexed by the 7-deck
  loop at the CART slot (6). Guard it (fix above). This is the root fix; jingles re-enable after it ships + proves.
- Jingles remain **stood down** (kill-switch) until the CART-exhaustion path is proven end-to-end.
