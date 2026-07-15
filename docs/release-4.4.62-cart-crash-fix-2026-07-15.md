# Release 4.4.62 — CART-exhaustion crash fixed, jingles re-enabled + proven (2026-07-15)

The real fix, not a band-aid. Native `audio.rs:988` guard + off-air proof + jingles back on. Committed,
signed installer `dist-electron/Ether Setup 4.4.62.exe`. **STOP before install — the install IS the test.**

## (1) Fix — native, root cause
`native/src/audio.rs` mixer "source exhausted" loop indexed `DECK_LETTERS` (`[&str;6]`, decks A–F) by the
deck-slot number. Slot **6 = the CART overlay channel** (`decks: [DeckSlot;7]`), not in `DECK_LETTERS`. When a
CART source played to **natural end** (first done by the maiden jingle fire), `DECK_LETTERS[6]` → index OOB →
`cpal_wasapi_out` thread panicked and died → permanent dead air. Fix: `deck_finished_key(i)` returns the CART
slot's own `"CART"` key (bounds-safe for any i), used in place of `DECK_LETTERS[i]`. Native addon rebuilt
(`native/ether-audio.node`).

## (2) Proven OFF-AIR first (no live daemon touched — receipts)
- **Rust unit test** — `cargo test deck_finished_key`:
  `test audio::deck_finished_key_tests::cart_slot_is_bounds_safe_and_keyed_cart ... ok`
  (index 6 → "CART", 99 → "CART", no panic).
- **Isolated runtime harness** — `node scripts/test-cart-exhaustion.js` (spawns its OWN daemon on a DB COPY,
  private pipe, monitor muted — the live daemon is never touched). Plays a 2s source to natural end on CART:
  ```
  PASS CART is firing (level_cart 0.18 mid-play)
  PASS NO panic in the daemon log (CART-exhaustion OOB fixed)
  PASS output thread ALIVE after CART exhaustion (frames 456377→485172 advancing)
  PASS cpal callback fresh (610ms since last callback — thread not frozen)
  PASS CART finished-flag set via CART key (deckCart=ended)
  PASS station STILL rotating (a deck playing after the fire)
  ✅ CART-EXHAUSTION PROOF — ALL PASS
  ```
  No proof, no ship → proof obtained → ship.

## (3) Re-enable
`audiod/loggen.js`: `JINGLES_ENABLED = true`. Jingles arm/fire again; the CART-exhaustion path is now safe.

## (4) Install = zero-interruption test
The only air transition is the update's own daemon restart — **nothing else touches playout**. All airing
stations must resume unattended within seconds (the 4.4.60/61 respawn machinery: persisted + observed-live
intent, no-adopt-silent-deck). If any station stays silent, capture the onset window — that's the signal.

## (5) The maiden fire, take two (the release's proof, post-install)
After install, at the first assigned-category seam on the Christmas/jingle station: the jingle fires, the CART
source runs to its natural end, the output thread survives, and the station keeps rotating. That moment is
jingles' permanent clearance.

## Gates
`cargo test` PASS · `scripts/test-cart-exhaustion.js` ALL PASS · `node --check` (loggen/engine) clean · native
rebuilt (`cargo build --release`, staged to `native/ether-audio.node`, committed) · schema pre-commit gate ·
installer built `--publish never`.

## Not in this release (scoped separately, per instruction)
- **MIC source-audit** (findings table: source × [device] × [program bus], covering decks A/B/C, CART, mic) —
  its own deliverable; explicitly NOT folded into this release.
- Backlog **dead-thread recovery** (detect a killed mixer/output thread + rebuild the stream) remains open —
  today's crash is now prevented at the source, but the general "a dead thread must not equal permanent dead
  air" defense is still unbuilt.
