# Announcements show like songs and spots — PLAN ONLY (2026-10-13)

Nothing is built. Nothing is deployed before 9:30 PM tonight. HalloVeen is live in the park.

## Jeff (verbatim)

> i cant see in the app or park ops if the announcement fired
>
> that needs to show just like songs and spots

## Today (read-only map of the code; file:line receipts, runtime UNVERIFIED)

A fired announcement leaves one `play_log` row (class ANN) and **nothing live**.

| Where songs/spots show | Announcement today |
|---|---|
| Console strip: title, progress, countdown (`ConsoleStrip.tsx:133-150`) | **No.** The daemon sends deck events for A/B/C only (`audiod/engine.js:892, 911-919`). The renderer drops other slots (`engine-rodio.ts:415`). The source strip has no title or countdown (`SourceChannelStrip.tsx:329`). Only the meter moves. |
| Program Log / Calendar, rows turn "played" (`ProgramLog.tsx:600, 1059`) | **No.** An ANN never gets a `generated_schedule` row (by design, `main.js:5838-5840`). |
| Up Next (`UpNext.tsx:170-210`) | Upcoming only. Gone 30 s after its time (`:202`), with no "played". |
| Now playing (app, listener page, Park ops `now`; `App.tsx:518-558`) | **No.** A/B/C only. |
| Park ops cart playing (`ccData.ts:297-320`) | **No.** Cart channels only. |
| Park ops list "· played" (`ops-core.js:119`) | **Never.** It compares epoch seconds to a date string. |
| Logs → plays, affidavit (`Logs.tsx:88-113, 320-330`) | Yes (play_log). |
| Live Activity | **Effectively no.** The fire line goes to `ether-startup.log`, which the pane doesn't read. The daemon line is hidden as routine. |
| Announcements panel | **No** played time; it shows skips only (`Announcements.tsx:1109`). |

Also, two gaps:
- A **manual** fire (Test / Park cart) never stamps the entry (`main.js:5699`, `entryUuid` null).
- An ANN row is also in the BMI/ASCAP royalty CSV (`logs/royalty.ts:10-19`).

## Proposal — an announcement shows everywhere a song or spot does

1. **Console strip:** the slot it plays on shows the **title, elapsed/remaining countdown and progress** while it plays,
   the same as a cart. The daemon sends a slot event on announcement load/play/end (it already knows the title,
   `main.js:5803`), and the source strip renders it.
2. **Program Log / Calendar:** each fire appears as a row at the time it **played**, in the announcement colour, marked
   **played** (or **FAILED: reason** / **SKIPPED**), the same as a spot.
   - The rows are read from `play_log` and merged into the day view. They are **not** written into
     `generated_schedule`, keeping the standing rule that the log reader and auto-fitter never see ANN rows.
   - Upcoming announcements show at their due time, greyed, as today in Up Next.
3. **Up Next:** a fired announcement stays, showing "Played 8:29 PM" (or failed/skipped), instead of disappearing.
4. **Now playing (app) and Park ops:**
   - While it plays, "Now playing" shows the announcement on the app and on the Park page.
   - The Park page list shows **"Played 8:29 PM"** next to it. The server check is fixed (`ops-core.js:119`) and the
     install sends the time in a form the server reads.
   - A manual fire stamps the entry too.
5. **Announcements panel:** each of today's lines shows "Played 8:29 PM", "Failed: reason" or "Skipped".
6. **Live Activity:** a fire shows as a highlighted line: "Announcement HALLOVEEN 30 MIN played on S1, 8:29:00 PM".
   A failure shows in red.

Built-in sense: every fire, failure and skip is already in the play log or the startup log. The ledger gets
`announcement-fired` / `announcement-failed` so the Health Monitor can count them.

## Questions

- **A.** The public **listener** now-playing (`listen.*` and the app's listener payload): should it show the announcement
  title while it plays ("HALLOVEEN 30 MIN"), or stay on the song?
- **B.** Royalty CSV (BMI/ASCAP): announcements are in it today. Leave them out?
- **C.** Order: the server "played" fix first (small, after 9:30 tonight), then the app pieces in the next installer?
