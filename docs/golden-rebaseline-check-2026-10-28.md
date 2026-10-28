# Golden re-baseline: what moved the 31 renders, checked commit by commit (2026-10-28)

**Jeff (verbatim):** "Re-baseline: go. Re-record the engine reference outputs from the commit before ba05e69, so nothing
from the Patch Bay is in the baseline. Confirm all 5 old failures, including the Aux checksum test, are the 2026-10-13
intentional changes and nothing else, then commit the new baseline. The full engine suite must pass." Then: "Let the
re-baseline finish: compare against the 2026-10-13 record, commit the new baseline from 1f63e41 and the new Aux checksum,
and run the full engine suite. It must pass."

**Status: NOT committed.** There is a third change the 2026-10-13 record (`docs/golden-review-4.6.59-2026-10-13.md`)
does not name. It waits for Jeff.

## Method

The committed baseline is manifest `7896e92`. Between it and `1f63e41` (the commit before the Patch Bay) there are 34
commits touching `native/src`. Every golden was rendered at four commits, each in its own worktree and build
(`ETHER_GOLDEN_RECAPTURE=1 cargo test --release --lib capture_goldens -- --ignored`), and the AUX checksum test was run at
each. Renders are compared by their FNV-1a hashes per tap (monitor / stream / aux). The inputs were identical at every
checkpoint.

| Checkpoint | What it is | vs the previous | AUX checksum |
|---|---|---|---|
| `7111b94` | just before the duck default | **43 of 43 identical to the baseline `7896e92`** | `0x769d4d2c7a0689d7` (the committed value) |
| `277e750` | the duck default, −28 → −22 dB | 2 differ: `music__AUXDUCK_LINKED`, `music__AUXDUCK_OFF` | unchanged |
| `7e218ca` | the limiter (BS.1770 detector, no margin) | 30 differ: every processed render; all 13 unprocessed/silence identical | `0xb8690f3e7ea3c65a` |
| `1f63e41` | the commit before the Patch Bay | **2 differ: `music__AUXDUCK_LINKED`, `music__AUXDUCK_OFF`** | unchanged |

Baseline → `1f63e41`: 31 renders differ, 12 identical, the same 31 / 12 the record lists.

## What the record covers

- The duck default (`277e750`) and the limiter (`7e218ca`): exactly the renders the record attributes to them.
- The AUX checksum: it changes at the limiter and nowhere else (`0x769d4d2c7a0689d7` → `0xb8690f3e7ea3c65a`), as the
  record says.
- The 27 commits before the duck change moved nothing (43 / 43 bit-identical).

## What the record does not cover

Between `7e218ca` and `1f63e41`, the two duck renders change again. The commit is `02e7f80` (2026-10-13 00:54 -0700,
Jeff), "duck: the amount comes only from Preferences; the engine has none of its own":

- The engine has no duck amount of its own any more, so the two duck renders now state their own values in the test:
  `TEST_DUCK = { depth_db: -20, threshold_db: -45, attack_ms: 30, hold_ms: 700, release_ms: 500 }`
  (`native/src/offline_render.rs`, parity `plan()`).
- Its message lists "5 pending goldens", so it was made knowing the goldens were pending.
- It came **after** the review set was rendered (`e3244eb`, 2026-10-12 23:45 -0700). The review's files 07, 08 and 09
  (music ducked under voice, processing off / on, and the voice on the AUX room output) were rendered with the old engine
  default, −22 dB. The new baseline would hold the −20 dB test value instead.

So the 5 failing tests are the same 5, and the 31 renders are the same 31. But the two duck renders that would be committed
are not the ones in the review folder.

## The decision for Jeff

1. Commit the baseline from `1f63e41` as it is: the duck renders at the test's −20 dB (`02e7f80`), the rest as reviewed.
2. Or first re-render the review's files 07–09 from `1f63e41` to listen to the −20 dB versions, then commit.

Ready either way: the `1f63e41` manifest and its 43 renders are in the scratch worktree, and the new AUX checksum is
`0xb8690f3e7ea3c65a`.
