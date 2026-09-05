# Give Ether its own folder — the dedicated catalogue · PLAN

**Status: CURRENT · last verified 2026-09-04 · PLAN + MEASUREMENTS. NOTHING MOVED.**
Supersedes the folder-driven premise in `docs/r2-backup-whole-library-plan-2026-09-04.md` §3.2.

Jeff, 2026-09-04:
> The folder is shared — Ether pulls from it but doesn't own everything in it. I have files there for
> other purposes… Better idea: give Ether its own folder. Copy the files Ether actually uses out of
> my shared music folder into a dedicated Ether catalogue folder, and repoint the rows there. Then
> Ether owns that folder, folder-driven backup is correct, and my shared music folder goes back to
> being mine.

**The earlier ruling to preserve the 1,113 unreferenced files is DROPPED** at Jeff's instruction:
they were never part of Ether.

---

## 0 · The premise I got wrong, stated plainly

The folder-driven backup built earlier today rests on "the folder IS the library". **I asserted that
without ever checking that Ether owns the folder.** It does not — it is Jeff's shared music folder.

The measurement below is the cost of that assumption: a folder-driven backup would have uploaded
**13.15 GB**, of which **9.99 GB is not Ether's**. This plan makes the premise true instead of
abandoning it, which is why the folder-driven code survives — it just needs a folder that is actually
Ether's.

---

## 1 · What gets copied — measured on the dev machine, 2026-09-04

```
shared folder today : C:\Users\jensj\Music\ether music library
  audio files       : 1,880   (13.15 GB)

── WHAT ETHER ACTUALLY USES ──
  rows with a path  : 600
  DISTINCT files    : 486
  total size        : 3.15 GB
  rows whose file is MISSING: 0

  by table:
    songs                471 files
    library_asset         57 files
    cart_slots            10 files
    announcements          5 files
    spots                  2 files

  STAYS BEHIND: 1,394 files (9.99 GB) — not referenced by any row
```

**486 files, 3.15 GB.** 600 rows resolve to 486 files because ~114 rows share a file (the same track
in two stations' categories, a cart that is also a song). The copy de-duplicates automatically.

Free space on C:, measured: **68.7 GB.** A 3.15 GB copy is comfortable.

**Zero rows are missing their file** on this machine, so nothing is left behind unresolved here. The
tool must still handle it (§4), because OV will not be so clean.

---

## 2 · Where the folder lives, and how the switch lands

**Default: `%LOCALAPPDATA%\Ether\catalogue`**

- `LOCALAPPDATA`, never Roaming — Roaming is redirected to a network share on managed boxes like OV,
  where SQLite WAL already failed. The same reasoning that put the database there puts the audio
  there.
- It sits beside the profile data Ether already owns, so "Ether's folder" is true by construction
  rather than by convention.
- **Operator-changeable.** Some machines will not want GB on C:. The existing picker
  (Settings → Catalogue Folder, `library:relocate`) already chooses this folder; the move should
  offer the same choice, defaulting to the above.

**The switch is a LOCAL change and nothing else.** `music_dir` became `LOCAL_ONLY` this morning, so
setting it writes no mutation and no peer ever hears about this machine's new folder. That property
is what makes this safe to do per-machine, at different times, on OV and here.

**ORDER MATTERS.** Copy and repoint against an EXPLICIT target first, then flip `music_dir` last:

1. `planMigration(db, NEW_ROOT)` — plan the copy (dry run, safe on air).
2. `applyMigration` — copy → verify → repoint, all local-only.
3. **Then** set `music_dir = NEW_ROOT`.

Flipping first would point the resolver and the health classifier at an empty folder, and the
catalogue dot would go red across the board until the copy finished. Doing it last means the machine
is never in a state where its own signal is lying.

---

## 3 · Copy, not move — and the tool already does this

**Jeff's ruling: copy.** The shared folder loses nothing.

Cost: 3.15 GB exists twice until Jeff deletes the originals himself, which is his call and not
Ether's business.

**The machinery is already built.** `planMigration(db, root)` given the NEW root does exactly the
required thing per row:

| row state | plan | why |
|---|---|---|
| file exists in the shared folder | **COPY** into the new root, then repoint | it is not inside the new root, and the new root's index is empty |
| a second row naming the SAME file | **REPOINT** only | after the first copy, `destinationFor` sees same-name/same-size and reuses — this is what de-duplicates 600 rows into 486 files |
| already inside the new root | ALREADY_INSIDE | re-runs are no-ops |
| file gone | **GONE** — reported, row untouched | §4 |

So the work is: a **target-folder argument** on the existing plan/migrate IPCs and the door, plus the
`music_dir` flip. Not a new tool.

---

## 4 · Rows whose file is missing

**Reported, never blanked** — already the behaviour and already gated (test M-7). A row keeps its
title, its identity and its stale path; the operator re-imports. A blanked row is lost work.

Zero on this machine. On OV the number will not be zero, so the move's report must list them by table
and title, and stay on screen.

---

## 5 · OV — the same operation, with two differences

OV did the same thing (Ether pointed at a folder OV does not exclusively own), so it needs the same
move. Two things that differ and must be checked THERE, not assumed from here:

1. **Its numbers are its own.** Run the dry run on OV first and read its counts — how many files, how
   much disk, and crucially how many rows are missing their audio after this morning's hand repair.
2. **Its disk.** A managed box may not have 3 GB spare on C:. If not, the operator-chosen target
   (§2) is the answer, not LocalAppData.

**Sequencing on OV:** install the build → run the dry run → read the counts → move → then turn sync
back on. Sync last, because the resolver tier makes inbound foreign paths harmless only once the
catalogue actually holds the audio.

---

## 6 · What this fixes downstream

- **Folder-driven backup becomes correct**, not presumptuous: the folder is Ether's, so walking it is
  walking the catalogue. 3.15 GB uploads instead of 13.15 GB, and none of it is Jeff's personal music.
- **The five-table migration is not needed** for backup. It remains needed for per-row
  *materialization* (`file_key`), which is a separate concern riding with the protocol amendment.
- **`defaultLibraryDir()` should change too** — a NEW install should default to the dedicated
  catalogue folder rather than `<Music>\ether music library`, or every fresh install repeats this.

---

## 7 · OPEN — needs Jeff before anything moves

1. **Target folder:** `%LOCALAPPDATA%\Ether\catalogue`, or somewhere you choose? On this machine
   either works (68.7 GB free); OV may decide it.
2. **New installs:** change `defaultLibraryDir()` to the dedicated folder in this release, or leave
   fresh installs pointing at `<Music>\ether music library` for now?
3. **After the copy, do you want anything to tidy the shared folder?** My recommendation is NO —
   Ether should not delete from a folder it has just established it does not own. Deleting the 1,394
   is yours to do, by hand, whenever you like.
