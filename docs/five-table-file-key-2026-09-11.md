# file_key for the other five audio tables — what it takes, and what it is actually for

**Status:** Phase 0 and Phase 1 BUILT 2026-09-11. Phase 2 not started. **Phase 3 must not be started
without asking Jeff** — his instruction, and the reason is in §4 and §5.
**Asked by Jeff:** *"what does giving cart_slots, announcements, spots, voice_tracks and
published_episodes a file_key actually take? What it costs, what it breaks, and whether
folder-driven R2 makes it simpler than it was when it got deferred."*
**Governing docs:** `one-sync-arc-2026-09-09.md` §3.2 (where it was deferred),
`audio-library-r2.js:1-39` (why folder-driven removed the original reason),
`r2-backup-whole-library-plan-2026-09-04.md`, `audio-library-one-folder-rule-2026-09-04.md`.

---

## The headline, stated before the design, because it changes what to build first

**Carts already have a cloud route. The missing `file_key` is not what stopped OV's three cart files
from arriving.**

`uploadCatalogue()` is folder-driven — it walks the catalogue and uploads every audio file, row or no
row. It already carried OV's and OVEVENTS' cart audio; the first real run uploaded 11 carts and 5
announcements (step 4, e36d675). No `file_key` is involved, by design
(`audio-library-r2.js:20-23`).

`downloadCatalogue()` is **already incremental**. It reads the remote manifest, walks the local
catalogue, and downloads only entries that are absent locally or differ in size
(`audio-library-r2.js:308-313`). Running it repeatedly costs one manifest GET plus the genuinely new
files.

So the three cart files are, in all likelihood, sitting in R2 right now, and would land in OV's
catalogue the moment a download ran — where the rows, which Jeff has confirmed resolve correctly with
`foreign: false`, would pick them up by basename. That is the entire point of [N-23a] plus the
one-catalogue rule, and both are working.

**What is missing is that nothing ever calls it.** Every trigger for `catalogue:backup:download` is
manual or first-run:

| trigger | when |
|---|---|
| `CloudBackup.tsx:225` | the operator presses a button |
| `CloudInstallPrompt.tsx:32` | first run, once per session, dismissable |
| `OnboardingFlow.tsx:680, 2442` | onboarding |
| `App.tsx:1655` | `library:syncDownload`, pushed from the dashboard |

There is no periodic incremental pull. "Keep my stuff synced" pushes files continuously and pulls
them **never**. That is the defect behind carrying three files by hand, and it needs no migration at
all.

This does not make the `file_key` question moot — it makes it a different question, answered below.
It is about **honest reporting and per-row fetch**, not about backup coverage. Notably, the "4
missing" that started this hunt was itself an artefact of the missing column: see §2.

---

## 1. Why it was deferred, and what changed

The deferral is recorded at `audio-library-r2.js:20-23`. The rejected alternative was a **wider row
query** across all seven audio tables, and it was blocked because those five tables had **neither
`file_key` nor `r2_uploaded_at`** — and even with both it would still miss files in the catalogue
that no row references.

Folder-driven R2 removed both needs from the backup path:

- **`r2_uploaded_at` is gone as a requirement.** The manifest is the resume marker
  (`audio-library-r2.js:25-29`). There is no per-row upload state to track any more, on any table.
- **`file_key` is gone as a backup requirement.** The upload keys on the file's actual name on disk,
  deliberately, because seeding from `file_key` produced two manifest entries for one file when two
  song rows carried keys differing only in case (`audio-library-r2.js:155-160`).

**So the migration is now half of what was deferred.** It was "five tables × two columns, to widen a
query". It is now "five tables × one column, for two purposes that have nothing to do with the
backup". That is a real simplification, and it is the direct answer to Jeff's third question.

## 2. What `file_key` actually buys now

### (a) Honest health reporting — and this is the one that cost time today

`library-health.js` `classifyRow()` returns `r2Only` when the row has a `file_key`, and `dead`
otherwise (`:174-175`). A cart whose audio has not arrived yet has no `file_key`, so it cannot be
classified as "in the cloud, not here yet". It is classified **dead**, and the Health Monitor says
**missing**.

That is exactly what OV reported. Three of the four were files that exist in R2 and had simply never
been pulled; the panel could only call them missing, which sent us looking for a sync defect that was
not there. **The count that started this investigation was itself the artefact of the absent column.**

No code change is needed in the classifier — `colsOf()` already reads the column generically. The
moment the column exists and is populated, carts classify as `r2Only` on their own.

### (b) Per-row materialization

`fetchR2Track(fileKey)` (`main.js:8380`) is **already table-agnostic** — it takes a bare key. Only
its callers are songs-shaped (`App.tsx:1303`, `loggen.ts:594`). With `file_key` on carts, a cart could
fetch its own audio at load time instead of waiting for a whole-catalogue pull. That is the difference
between "the cart plays in ten seconds" and "the cart plays after the next catalogue sync".

### (c) Deletion-sweep scope

`deletion-sweep.js` keys entirely on `file_key`. Carts, spots, announcements, voice tracks and
episodes are invisible to it today — their R2 objects are never released. Adding the column brings
them into scope, which is **both a benefit and the main hazard** (§4).

## 3. What the migration takes

Smaller than its reputation. `library_asset` already got `file_key` in v50, so it is five tables, not
six — Jeff's list is exact.

**Schema — one migration, v59.** `scripts/migrate-songs-r2-fields-phase-sync-17.js` is the template,
minus its `r2_uploaded_at` half:

```
ALTER TABLE <t> ADD COLUMN file_key TEXT;          -- x5, guarded by PRAGMA table_info
UPDATE <t> SET file_key = basename(file_path)      -- where file_path set and file_key still NULL
```

v17's pure-JS `basename()` handles both separators and should be reused verbatim — paths from either
host platform must backfill correctly.

**Registry — five lines.** In `synced-tables.js`, beside the existing `file_path: 'blob-ref'`:

```
file_key: 'scalar',
```

No blob-ref handling: `file_key` is content identity, not a machine path, so it syncs plainly. This
is the songs precedent exactly (`synced-tables.js`, songs entry). **No `local-only` column at all** —
`r2_uploaded_at` is not being added.

**Population — one existing hook, widened.** `onFileKey` (`main.js:11338`) fires per uploaded file and
currently fills `songs` only. Widening it to the five tables is the same `UPDATE … WHERE file_path
LIKE '%' || basename AND (file_key IS NULL OR file_key = '')` shape, five times. It already runs
inside a `try/catch` that refuses to fail a backup over bookkeeping, which is the right posture.

**Row creators.** Every place that creates one of these rows should set `file_key` at write time
rather than waiting for the next upload to fill it. Worth auditing — the copy-on-import work (step 1)
already funnels every door through the catalogue, so the basename is known at creation.

**Guard.** A smoke that asserts every audio table with a `file_path` column also has `file_key`,
registered as `'scalar'`. That is a ratchet: a new audio table cannot be added without it. Cheap, and
it is the thing that would have prevented five tables drifting apart from `songs` in the first place.

## 4. What it breaks

- **Case collisions, multiplied.** The two-rows-one-file case hazard is documented and real on
  `songs` (`audio-library-r2.js:155-160`). Five more tables enlarge that surface. The upload path
  already dodges it by keying on the local filename, but **the backfill must normalise**, and the
  smoke should assert no two rows in one table carry keys differing only in case.
- **Deletion sweep starts seeing carts.** This is the genuine risk. The sweep releases R2 objects,
  and its shared-key guard (`deletion-sweep.js:127-140`) checks `songs` and `generated_schedule`
  only. A cart and a song can legitimately name the same file; deleting the cart must not release an
  object a song still needs. **Recommend: the five tables are excluded from the sweep in Phase 1 and
  admitted only in a later phase, with the guard widened first.** Do not let this ride along.
- **Schema v59 on a live station.** Five `ALTER TABLE`s plus a backfill, on OV, mid-air. Additive
  columns with no rewrite, so it is about as safe as a migration gets — but it still needs the
  standard test: could it strand someone who can only launch the app?
- **Sync volume.** Backfilling `file_key` on every row of five tables journals one mutation per row.
  On this machine that is thousands of rows at once. Given the `designated_generator` heartbeat is
  already accumulating pushable mutations that cannot drain, this wants sequencing after that is
  understood, or the backfill should be written as a local-only UPDATE that does not journal.

## 5. Proposed sequence

**Phase 0 — BUILT.** pull, not just push. No migration. This is what stops Jeff carrying files.
Call the existing incremental `downloadCatalogue()` automatically while the switch is on: on a timer,
or on a "new files in the manifest" signal. It is already a diff, so the steady-state cost is one
manifest GET.

Two details that matter: pass **`pruneMissing: false`** on the automatic path — pruning writes the
remote manifest (`audio-library-r2.js:375-383`), and many installs pruning on a timer would race on
one object. Leave pruning to the explicit, operator-initiated run. And the Health Monitor must say
"N files still arriving" during it, exactly as the restore phase already does (step 5), rather than
reporting a transient gap as damage.

**Phase 1 — BUILT.** v59 migration + five registry lines + widen `onFileKey` + the ratchet smoke.
Sweep explicitly excluded. Outcome: the Health Monitor stops calling cloud-backed audio "missing", and
says `r2Only` — "in the cloud, not here yet" — which is the truth.

**Phase 2 — per-row materialization for non-song rows.** Point the cart/announcement/spot load paths
at `fetchR2Track(file_key)` so a single row can heal on demand instead of waiting for a catalogue
pass.

**Phase 3 — admit the five tables to the deletion sweep**, after widening the shared-key guard.
Last, deliberately, and on its own.

Phase 0 is a day. Phase 1 is a day. Phases 2 and 3 are each their own piece of work with their own
risk, and neither should be bundled.

## 6. The honest summary

Jeff's diagnosis — *"cart_slots has no file_key, so cart audio has no cloud route"* — is right about
the column and about the consequence he saw, and the fix he is asking for is worth building. But the
cart audio does have a cloud route: it is up there, and the reason it did not come down is that
nothing pulls. Building the migration first would deliver honest reporting and still leave him
carrying files. Building Phase 0 first delivers the thing the arc was for — *a cart created on one
machine plays on the other* — and does it without touching the schema.

Then build the migration, because a panel that reports "missing" for a file sitting safely in the
cloud is its own defect, and it is the one that cost this round.
