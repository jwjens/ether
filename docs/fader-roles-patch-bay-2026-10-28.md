# Fader roles in the Patch Bay: where "D = jingle, E = announcement" comes from (2026-10-28)

**Jeff (verbatim):** "The board is clear right now, yet the Patch Bay inputs say "Fader D: a jingle source" and "Fader E: a
announcement source". That means a fader letter is being given a role nobody set. Every fader is whatever the user sets it
to. Find where D = jingles and E = announcements (or any letter = any role) comes from, in the Patch Bay and anywhere else
in the code, and show me before changing it. The Patch Bay must show only what the user actually set, or "no source set"
when nothing is. Own commit with a test that fails on the current code."

Investigation only. Nothing changed.

## What the Patch Bay reads

`src/components/PatchBayInputs.tsx` lists, for EVERY station (not only the one on the board), the rows
`deck_configs WHERE type='source' AND enabled=1`, and says each row's stored `kind`. It prints the raw stored value:
`a ${kind} source (set on the board)`, so the stored key `jingle` (the board calls it "Sweeper") appears as "a jingle
source", and "a announcement".

## No code gives a letter a role

- Startup seeding (`electron/main.js` `DEFAULT_DECKS` / `seedDeckConfigsForStation`, ~line 3208) writes type, label,
  colour and enabled. It writes **no** `kind`.
- A search of `src/`, `audiod/`, `electron/`, `scripts/` for any of D/E/F paired with jingle, sweeper, announcement,
  cart or jukebox found none, apart from a migration's self-test probe row (`scripts/migrate-play-log-source-phase-sync-39.js:119`,
  a scratch database, not a station).
- `audiod/show-presets.js` can write `kind` (a show preset Take writes the whole board), and sync carries `kind` from
  other computers (`deck_configs.kind` is a synced column).

## What the database on OVEVENTS holds (read-only, 2026-10-28)

| Station | D | E | F |
|---|---|---|---|
| 1 Open Format | `link` (enabled) | `announcement` (enabled) | off |
| **2 halloVeen** (active) | **`jingle` (enabled)** | **`announcement` (enabled)** | `cart` (enabled) |
| 3 Magical Forest | `""` (enabled) | music, off | guest, off |
| 4 Christmas in Jully | `mic` (off) | `cart` (off) | — |

halloVeen's last role changes, from the sync log (`mutations`):

```
2026-10-16T22:57:02.716Z remote 041ceb96 update E: kind "cart" → "announcement"
2026-10-20T00:12:12.432Z remote 041ceb96 update D: kind "mic" → "jingle"
```

`041ceb96` is the OV machine. So halloVeen's D and E roles were set on OV's board and arrived here by sync. Over the whole
history the same three faders have been set to every kind, by hand, on both computers (85 changes since 2026-08-23).

## What does not fit

The Patch Bay shows what is stored. If the board on this computer is clear for the same station, the board and the
stored rows disagree. That needs one look at the screen: which station the board shows, and what D's and E's SOURCE
dropdowns say. The Patch Bay also lists every station, so a "Fader D" line can belong to a station the board is not
showing.

## Proposed change (waits for Jeff)

1. The Patch Bay names each station's faders under the station, and shows a source by its board name ("Sweeper",
   "Announcement", from `src/lib/sourceKinds.ts`), never the stored key, and "no source set" when `kind` is empty.
2. Depending on the screen check: if the board shows "— no source —" for a row whose stored `kind` is set, that is a
   board defect to find, not a Patch Bay one.
