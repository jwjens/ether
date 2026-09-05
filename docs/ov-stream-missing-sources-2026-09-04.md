# OV live: only rotation reaching the stream — trace

**Status: CURRENT · last verified 2026-09-04 · READ-ONLY, NOTHING CHANGED**
Machine: OV, v4.5, all stations on air with a stream up.
Operator report, verbatim: *"Only song rotation is reaching the stream. No announcements, no sweepers, no mics."*
Operator hypothesis: *"i think you may have only wired input sources to local monitors."*

---

## 1 · The hypothesis is falsified, and it is inverted

**The stream carries every slot. The LOCAL MONITOR is the thing that excludes source channels.**

`native/src/audio.rs:2230`, in the per-slot accumulation loop — this runs for **every** slot,
aux included, before any `is_aux` test:

```rust
mix_l[f] += lv;                       // AIR — every slot, unchanged
mix_r[f] += rv;
if !is_aux {                          // programme base — aux decks excluded entirely
    core_l[f] += lv;                  // AIR: never scaled by a monitor
    core_r[f] += rv;
    room_l[f] += lv * rg;             // ROOM: only non-aux slots
    room_r[f] += rv * rg;
    ...
}
if is_aux {
    src_l[f] += lv;                   // AIR-level source sum for the ducker
    src_r[f] += rv;
}
if is_aux && mon != 0.0 {
    aux_l[f] += lv * mon;             // the room hears aux ONLY through this tap
}
```

Chain to the encoder:

| stage | `audio.rs` | carries `src`? |
|---|---|---|
| per-slot sum | `:2230` | **yes — every slot** |
| duck rebuild | `:2369` `mix = core + src` | **yes** (and the no-duck branch leaves the loop's sum untouched) |
| air EQ | `:2412` `out = EQ(mix)` | **yes** |
| processor | `:2460` `let mut pl = out_l.clone()` | **yes** |
| stream tap | `:2489-2499` — processed if `proc_stream`, else clamped clean `out` | **yes, either way** |

`proc_local` / `proc_stream` only select **which tap**; neither changes the sum. There is no path in
which the encoder is fed a buffer that excludes `src`.

**The room is the opposite.** `room_l` accumulates only `if !is_aux` (`:2232`), and the room chain
reads `room_l` (`:2526`). Aux reaches the studio solely via the `aux_l` monitor tap. So a wiring
error of the shape suspected would present as **missing in the studio, fine on air** — the inverse of
the reported symptom.

---

## 2 · What rotation does differently — the actual candidate

Rotation is **A/B/C, hardcoded**; it never consults a config. Each missing source instead resolves
its deck by querying `deck_configs` for `type='source'` **plus a specific `kind`**:

| source | predicate | `file:line` |
|---|---|---|
| announcements | `kind = 'announcement'` | `electron/main.js:4706`, and again `:4815` |
| sweepers | `kind IN ('sweeper','jingle')` | `audiod/engine.js:2152` |
| mics | device/type-based (`type === 'mic' \| 'guest' \| 'video'`) | `src/App.tsx:2116` |

**Nothing dialed to those kinds → they never load onto any deck at all**, so they are absent from the
studio monitor as well as the stream. The announcement path states this itself
(`electron/main.js:4713`):

> `No source channel is patched to Announcement on this station. Press + on the board and choose Announcement.`

### The kind mismatch

`scripts/migrate-cart-deck-type-phase-sync-54.js` writes **`kind='cart'`** (`:17`, `:91`, `:116`).
That value matches **none** of the three predicates above. A station whose source slots were
populated by that migration has them dialed to `cart` only.

Sweepers then take the fallback at `audiod/engine.js:2157` → `["CART"]` — a channel the board no
longer carries, since `5540bd3` removed the static sweeper strip and slot 6 became addressable.

---

## 3 · THE ONE CHECK — needed from the OV box before anything changes

**Does the OV studio monitor have the announcements / sweepers / mics either?**

- **Missing there too** → a patching / `kind` problem, not a stream path. Nothing in the audio engine
  is wrong, and the fix is in `deck_configs`.
- **Present in the studio, absent from the stream** → this trace is incomplete and must be redone,
  because §1 says that combination should not be possible.

---

## 4 · Status of every claim here

**Everything above is what the SOURCE says. Runtime UNVERIFIED — there is no receipt from the OV
machine.** A grep is a claim about the tree, never about the product.

**Flagged, not chased:** if OV auto-updated to 4.5 without a **full close and reopen**, the audio
daemon is still running 4.4.x while the renderer is 4.5 (the daemon does not reload on auto-update).
`audiod/engine.js` is daemon-side, so the sweeper resolver quoted above may not be the code actually
running there.

**Nothing was changed. No fix proposed yet — the §3 answer decides which fix is even correct.**
