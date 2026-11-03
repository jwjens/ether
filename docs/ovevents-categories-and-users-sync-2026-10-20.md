# OVEVENTS song categories don't match OV; users don't reach OV — diagnosis + plan (2026-10-20)

## Jeff's reports (verbatim)

> READ-ONLY first, change nothing yet. Every song's category on OV is correct. On OVEVENTS they keep getting rearranged wrong (right now Kids holds only "Thunder").
> 1. Find what keeps moving them on OVEVENTS: the one-time repair (read the songs-refiled-*.txt report here), sync applying OV's changes one category off, or something else. Show which change moved each song (machine, when, build).
> 2. Fix the root cause so it can't happen again on either machine.
> 3. Then make OVEVENTS's song categories match OV exactly, without sending anything back to OV that would change it.
> Tell me the cause and the plan before you change anything.

> Also: users added on OVEVENTS (Preferences → Users & Security) are not reaching OV. Find why: is the users table synced at all, and if so, where do the new users stop (not sent, refused by the server, or not applied on OV)? Same rule: cause and plan first.

Everything below is read-only (read-only connections to OVEVENTS' live database while Ether 4.6.61 ran; the profile folder's reports). Nothing was changed. "OV" here = **ovowforestmusic** (client `041ceb96…`), the other computer in this database's sync history.

## 1 · What moved the songs

### Cause A — sync applied each machine's category NUMBER as the other's own number (before 4.6.60)
halloVeen's categories are numbered **one off** between the two machines (from each machine's own category changes in the history):

| | 7 | 18 | 19 | 20 | 21 | 22 | 23 | 24 |
|---|---|---|---|---|---|---|---|---|
| ovowforestmusic | HalloVeen | — | Upbeat | **Kids** | HV Adult | Movie & TV Instrumentals | … | … |
| OVEVENTS | HalloVeen | Upbeat | **Kids** | HV Adult | Movie & TV Instrumentals | Disney Halloween | Movie Soundtrack | Closing |

Song changes sent before 4.6.60 carry only the sender's local number (`payload_after.category_id`, no category id). So ovowforestmusic's "20 = Kids" landed here as 20 = **HV Adult**, its "19 = Upbeat" as 19 = **Kids**, and so on — and OVEVENTS' own edits landed one off on ovowforestmusic the same way. Of the 41 songs ovowforestmusic last filed in Kids, 38 sat in HV Adult here (e.g. *A Nightmare On My Street*: ovowforestmusic 2026-10-19 21:49:27 UTC, schema v66, sent #20). Fixed for new changes in c2c9409 (4.6.60: references travel by uuid).

### Cause B — today's rearrangement: the 4.6.60 one-time repair, second run
- **14:15:27** (`songs-refiled-2026-10-20T21-15-27.txt`): checked 551, **moved 0**, 4 settings rewritten, **204 waiting** for ovowforestmusic's numbering.
- **14:25:27** (`songs-refiled-2026-10-20T21-25-27.txt`): ovowforestmusic had published its numbering → **120 songs re-filed** one category back (HV Adult→Kids, Closing→Movie Soundtrack, Movie Soundtrack→Disney Halloween, Disney Halloween→Movie & TV Instrumentals, Movie & TV Instrumentals→HV Adult, …) and 31 artists. Every move is listed in that file, each "(assigned on the other computer)".
- Kids here: **66 songs at ~14:1x → 93 at 14:27**, with only 2 synced song changes in that window (both to HalloVeen). The repair writes locally (not journaled, not sent). It is now `done` (0 waiting) and will not run again (`main.js:8762`).

### Not the cause
- The burst of 102 OVEVENTS song changes at 19:37–19:38 UTC 10-19: category before = after on every one (other fields changed).

### Still different now
Against ovowforestmusic's **last own word** for each song (from the history — an approximation of OV, not OV's database): of 318 songs it has filed, **168 match, 150 differ**; in **67** of those OVEVENTS changed the song later — e.g. ~60 Upbeat songs set to **no category** on OVEVENTS 2026-10-17 23:14–23:29 UTC (schema v62). The history alone cannot say what OV holds today, so the exact match must come from OV's own database (plan below).

**"Kids holds only Thunder":** not reproduced from the data — Kids (#19) held 66 songs, then 93, in OVEVENTS' database while this ran. Which screen shows only Thunder is **UNVERIFIED**; one look at that screen settles it.

**Builds:** mutations record the schema version, not the app version: v62 ≈ builds of 10-12…10-18, v65/v66 = 10-18/10-19 builds. ovowforestmusic runs 4.6.60 (installed 10-20 11:26), OVEVENTS 4.6.61.

## 2 · Fix the root cause (both machines)
1. **Both machines on ≥ 4.6.60** (category ids travel). Done here (4.6.61); ovowforestmusic is on 4.6.60 → 4.6.61.
2. **A receiver never applies a bare number from another machine.** A song change that carries a category/artist/album number without its id is **held**, not applied as a local number; it is filed when the sender's numbering is known (the repair's mechanism), or reported. So an older build anywhere can never move a song one off again.
3. **Sense:** Health Monitor line "N song changes held — waiting for <machine>'s numbering", and an alert when a held change is older than a day.

## 3 · Make OVEVENTS match OV exactly, sending nothing back
1. On ovowforestmusic, a **read-only** export (a script Jeff runs there, or from a copy of its database): every song uuid → its category **uuid + name + station**.
2. On OVEVENTS, a **dry run** first: the full list of songs that would change, from → to, plus songs only on one machine (listed, not touched). Jeff reviews.
3. On Jeff's OK: **Ether fully closed** on OVEVENTS (never write the live database while it runs), an online backup of the database, then the changes written **locally** — not journaled, so nothing is sent to OV (the repair's write path). Re-export OVEVENTS and compare: 0 differences is the receipt.

## Users — why they don't reach OV
**Not sent.** The `users` table (Preferences → Users & Security; `SettingsPanel.tsx:4166` `INSERT INTO users`) is **not a synced table**: it is absent from `electron/sync/synced-tables.js`, **0** users changes have ever been journaled here, and the table has no `uuid` / `updated_at` / `deleted_at` columns, so sync cannot carry it. Nothing is refused by the server or dropped on OV — it never leaves OVEVENTS. OVEVENTS holds: Admin (station 1), jeff (station 5), Ryan, Shawna, Donavon, Steve (station 2).

### Plan
1. Schema v67: `users` gets `uuid` (backfilled), `updated_at`, `deleted_at`; deletes become soft deletes.
2. Registry entry: station-scoped, station by uuid; a handler; every write path (add, edit, PIN change, remove) through the sanctioned writer so it journals.
3. **First sync merges, never duplicates:** a user with the same name on the same station on both machines is one user (the newer PIN wins); the merge is listed in a report.
4. **PIN hashes travel** (salted SHA-256 of a short PIN, stored on the backend's mutation log) — a 4–6 digit PIN hash is guessable offline by anyone with the backend data. Jeff decides: sync the hash as is, or move PIN hashing to a slow hash (scrypt) before it ever travels (recommended).
5. Help: `docs/help-users.md` (or the existing users help) says users sync to every computer on the account.
