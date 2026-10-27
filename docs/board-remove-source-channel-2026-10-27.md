# Board "−" does nothing on a patched source channel (2026-10-27)

**Jeff (verbatim):** "Bug: on the mixer board, the "−" (Remove source channel) button does nothing for a source channel
that has an input patched. Seen on ovowforestmusic: SOURCE G (Link input, status "LIN…") and SOURCE H (Park patch
"park:N", status "PAR…", "Last: Admin…") can't be removed. Clicking "−" shows the tooltip "Remove source channel G from
the board", but the column stays. Fix the root cause. No workaround that relies on the operator unpatching first."

Target: 4.6.68 (OV is on 4.6.67). Commit `0cf7fe8`. Not built yet (per Jeff: no build until all 4.6.68 items are done).

## Cause (source, release/1019)

`src/components/FaderSection.tsx` `onRemoveSourceChannel` only did `configs.map(c => c.slot === slot ? {...c, enabled:false} : c)`
and saved. Three things kept the column:
1. **The patch stayed.** The engine kept the input open (`source_present`), and `src/lib/boardSlots.ts` appends every
   slot the engine reports live.
2. **A slot with no `deck_configs` row** was not in the list: nothing changed and an unchanged list was saved. The board
   had made up a default row with `enabled:true` for it.
3. **Link auto-patch.** `SourceChannelStrip`'s effect (`linkNeedsPatch`) re-patches a Link-kind channel whenever no
   Link input is set, and it re-arms after each successful patch, so another window could undo a release.

Park: the patch is `mic_input_<slot>` = `{"device":"park:<n>"}`. It is machine-local (`LOCAL_ONLY_PREFIXES`) and written
only by main's `mic:set`. The Park page does not assign it; "Last: Admin…" is the talk history (`park_talk_last_<n>`).
Clearing the patch is therefore the whole Park fix; there is no server-side assignment to undo.

## Fix

`src/lib/removeSourceChannel.ts`, in this order:
1. The row is marked OFF, added if missing. From then the channel is "explicitly removed": `boardSlots(…, removed)`
   never brings it back on the engine's word, and `linkNeedsPatch` never patches a disabled channel.
2. Its Park/mic patch is cleared, the Link is released if it is on this slot, and its deck is stopped. The engine
   refuses Stop while a mic or Link is live, hence the order.
3. If the engine refuses a step, the row is put back and the reason is shown on the channel.

Only that slot is touched: no other channel, programme or air. The 2026-09-03 invariant ("a slot the engine carries is
always on the board") still holds for slots the config does not mention (CART).

## Verification

- Unit tests: `src/lib/removeSourceChannel.test.ts`. 13 tests; 6 fail on the previous code.
- **Runtime: UNVERIFIED.** The check: on ovowforestmusic with 4.6.68, press "−" on SOURCE G (Link) and SOURCE H
  (park:N). Both columns go and stay gone after a few seconds and after reopening the board; the other channels and the
  programme carry on.
