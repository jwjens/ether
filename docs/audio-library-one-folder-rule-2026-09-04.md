# The AUDIO LIBRARY rule — every audio file lives in one folder

**Status: CURRENT · last verified 2026-09-04 · READ-ONLY AUDIT. NOTHING BUILT.**
Supersedes the `cart_slots` carve-out in `docs/sync-health-foreign-paths-plan-2026-09-04.md` §2 and
contradicts `docs/design-machine-local-paths-2026-09-04.md` **T-new-4** — see §4.

**The rule (Jeff, 2026-09-04):**
> Every audio file that enters Ether is copied into the audio library on import. That is the first
> and only place audio files live. Nothing points outside it. An audio file is an audio file — it is
> not the code's job to decide what kind it is. Type is metadata on the row, never a reason to store
> the file somewhere else.

---

## 1 · Q1 — what copies today? **NOTHING.**

Every file-picker in the app stores the path the operator browsed to. Not one copies into the
library.

| path | `file:line` | behaviour |
|---|---|---|
| Cart assign | `DeckConfigurator.tsx:1058-1063` | stores browsed path |
| **Library import (songs)** | `ImportDialog.tsx:85-87` — `songs.create({ file_path: filePath })` | **stores browsed path** |
| Announcements | `Announcements.tsx:809, 823` | stores browsed path |
| Spots | `Spots.tsx` (via `library_asset.file_path`) | stores browsed path |
| Deck load from disk | `App.tsx:3575` | stores browsed path |
| Track editor (intro/version) | `TrackEditor.tsx:138, 166` | stores browsed path |
| Clip editor · StudioPro · BroadcastEditor · PublishEpisode · Widgets · GSelectorImport | various | stores browsed path |
| Library folder designation | `OnboardingFlow.tsx:2452` | picks the folder itself — not an import |

**The only copy-into-library code in the entire tree** is `electron/main.js:10657-10670` — Phase 1 of
`library:sync-r2:upload`, which consolidates files into the folder **at upload time**.

### The finding, in one line

**The audio library is a destination the UPLOADER consolidates into, and never a destination the
IMPORTER writes to.**

That single gap explains every symptom of the last two days:

- 1,113 audio files in the library folder with no row, and 510 rows whose files were only ever
  consolidated there by an upload;
- 10 of 10 carts pointing at `Downloads`;
- OV receiving 382 rows naming a directory it cannot open.

The rule closes it at the door instead of repairing downstream, which is why it is the right rule.

---

## 2 · The rename — AUDIO library, not music library

**60 user-facing occurrences across ~20 files** (`src/App.tsx`, `SettingsPanel`, `OnboardingFlow`,
`FirstRunWizard`, `ImportDialog`, `HelpPanel`, `SplashScreen`, `TrackEditor`, `OnboardingTour`,
`GSelectorImport`, `WidgetRegistry`, `useLibraryBorrowed`, plus the help docs).

- **The stored key `music_dir` stays**, with a comment saying why: it is matched by existing configs,
  the repair scripts, and `MUSIC_DIR_FILE` on every install in the field. Renaming the key would
  orphan every existing installation's library setting.
- **Internal identifiers** (`getMusicDir`, `musicDirFn`, `defaultLibraryDir`) may keep their names for
  the same reason; nothing user-facing says "music" again.

### ⚠ The trap: the DEFAULT FOLDER NAME is itself user-facing

`electron/main.js:8083`:

```js
function defaultLibraryDir() {
  try { const m = app.getPath('music'); if (m) return path.join(m, 'ether music library'); } catch {}
```

**Renaming this string would point every existing install at a folder that does not exist**, orphaning
its entire library — 1,878 files on this machine alone. The folder name must NOT change on existing
installs. Options: leave the folder name as-is everywhere (recommended — a folder name is not a
label), or rename only for brand-new installs, which fragments support ("which folder do you have?").
**Recommendation: keep the folder, rename the labels.** Flagged for a ruling.

---

## 3 · Q2 — the 10 cart rows pointing at Downloads

**Migrate, do not leave as legacy.** Under the rule a row pointing outside the library is a defect,
and leaving ten of them means the very first thing the new health signal reports is a permanent red
the operator cannot clear.

Measured on this machine: all 10 have absolute paths, all 10 files currently exist, 0 are under the
library. Jeff has since moved the cart files into the library folder by hand, so most will resolve by
basename already.

**Migration shape** (per row, ordered):

1. Basename already in the audio library → **repoint only**, no copy.
2. Source file exists outside → **copy in, verify, then repoint**.
3. Source gone → **leave the row, mark it loudly**; the operator re-imports. Never silently blank it.

**All repoints are LOCAL-ONLY writes** — no mutation — for the reason established in
`docs/change-file-location-plan-2026-09-04.md` §2: `cart_slots` has a handler, so a normal save would
push this machine's absolute path to peers and re-create the OV incident in reverse.

**Reuse, do not rebuild:** `electron/library-folders.js` already implements `station-folder:analyze`
(`:127`, a dry run), `station-folder:resync` (`:138`) and `library:relocate` (`:150`). This migration
is close to what they already do and should extend them rather than become a fourth implementation.
*I have not read those three handlers in depth — that is the first thing to do when this is built.*

---

## 4 · Q3 — the `cart_slots` carve-out goes. What changes:

Confirmed. Under the rule, carts are like everything else.

| what | change |
|---|---|
| `library-health.js` `AUDIO_TABLES` | drop `neverForeign: true` from the `cart_slots` entry |
| `classifyRow(row, opts)` | the `opts.neverForeign` branch becomes dead — remove the option entirely rather than leave an unused escape hatch |
| test **H-5** | inverts: a cart outside the library is now `foreign`, not `dead`-but-local |
| test **H-5b** | a cart resolving outside the library is still `resolves`, but is **also** `foreign` — the file being reachable does not make its location legitimate |
| **immediate effect here** | this machine's 10 carts read `foreign: 10` → **red**, until §3's migration runs. That is correct and is the alarm doing its job. |

### ⚠ This contradicts a binding design doc

`docs/design-machine-local-paths-2026-09-04.md` **T-new-4**:

> *a `cart_slots` row pointing outside the music dir is **not** rebased into it*

That gate exists because carts *could* legitimately live outside the library. **The new rule removes
that premise**, so T-new-4 must be amended, not quietly ignored. Proposed replacement:

> **T-new-4 (revised).** A `cart_slots` row pointing outside the audio library is reported `foreign`
> like any other table. Rebasing happens at import and by explicit migration — never silently on
> mutation apply, which would still invent a path the operator did not choose.

The second sentence preserves what T-new-4 was actually protecting: *the sync layer* must still never
rebase on its own. That protection was right; only the "carts are special" premise is gone.

---

## 5 · Q4 — import failures must be loud, at the door

**The invariant: copy → verify → *then* write the row. Never write a row for a file that is not yet
in the library.** Today the row is written first and the file's absence is discovered hours later,
mid-show — which is exactly the failure mode being eliminated.

| failure | what must happen |
|---|---|
| **Disk full** (`ENOSPC`) | refuse the import, name the free space needed, no row |
| **Permissions** (`EPERM`/`EACCES`) | refuse, name the folder. **The precedent: 2,443 silent `EPERM mkdir` failures on OV over two days** (`library-health.js:487`) — every one a track that never aired |
| **Name collision, identical bytes** | reuse the existing library file, repoint, do **not** copy. This is the good case and it dedupes |
| **Name collision, different bytes** | copy under a disambiguated name (` (2)`). **Never overwrite** — another row may point at the existing file |
| **Source vanished mid-copy** | refuse, no row, no partial file left behind |
| **Partial/short copy** | verify size after copy; on mismatch delete the partial and refuse |
| **Source already inside the library** | no copy, just use it — importing from the library must not duplicate |
| **Windows long paths** (>260) | detect before copying and refuse with the reason, rather than a truncated write |

**"Loudly" means the operator sees it in the import dialog**, with the file named and the reason in
plain language — not a console line and not a toast that disappears. An import that partially
succeeded must say which files did not make it, and that list must remain on screen.

---

## 6 · What this rule buys, and why it is the root fix

> *"If every audio file is in the library, a basename plus the local audio dir always resolves, on
> any machine."* — Jeff

That is exactly right, and it collapses the sync problem:

- `resolvesElsewhere` becomes the **normal** resolution path rather than a fallback;
- the protocol amendment's `[N-23a]` (receiver takes the basename, discards the directory) becomes
  **sufficient**, not merely transitional;
- design doc **Option B** (`file_path` local-only, `file_key` as identity) becomes reachable, because
  a basename is a real identity once every file is in one folder.

It does not remove the need for the resolver tier or the amendment — rows already in the wild still
carry foreign paths — but it stops the supply.

---

## 7 · OPEN — needs Jeff before building

1. **The default folder name** (§2). Keep `ether music library` on disk and rename only labels — my
   recommendation — or rename the folder and migrate existing installs?
2. **T-new-4 amendment** (§4) — accept the revised wording, or write your own?
3. **Order.** This rule touches ~12 import paths. Do the copy-on-import gate and the cart migration
   land first (they stop the bleeding), with the 60-string rename as its own pass? Splitting keeps
   each diff reviewable.

---

## 8 · `library-folders.js` read in full (164 lines) — what extending it must reckon with

Read before extending, per Jeff's instruction. Four findings, two of them blocking.

### 8.1 · ⚠ THERE ARE TWO DIFFERENT `music_dir` NOTIONS

| notion | storage | scope | read by |
|---|---|---|---|
| **per-station** | `station_config_kv` key `music_dir` | one folder **per station** | `library-folders.js:38` |
| **per-machine** | the `MUSIC_DIR_FILE` on disk | one folder **per install** | `main.js:8086` `getMusicDir()`, and `library-health.js` via `musicDirFn` |

The R2 uploader, the prefetch, and the new foreign-path classifier all use the **per-machine** one.
Test sync / Re-sync / Relocate all use the **per-station** one. They can hold different paths and
nothing reconciles them.

**"One audio library" cannot be implemented until this is settled**, because "the audio library" does
not currently name one thing. The rule's own wording — *"the station's audio library folder"* vs
*"this machine's"* — has to pick. **Needs a ruling; see §9.**

### 8.2 · ⚠ RE-SYNC CURRENTLY LEAKS ABSOLUTE PATHS TO PEERS

`applyRelink` (`:88-104`), with its own comment saying so:

```js
// songs.file_path goes through the sync-logged writer; generated_schedule.file_path is local play state.
try { deps.songsUpdateById(db, m.songId, { file_path: m.file }); } catch { … }
```

**Every Re-sync and every Relocate pushes this machine's absolute paths to every peer** — the exact
OV mechanism, from a button an operator is expected to press after moving their library. This is a
second live source of the defect, independent of the ones already found, and it should become a
local-only write for the same reason established in
`docs/change-file-location-plan-2026-09-04.md` §2.

### 8.3 · The matcher here is TITLE-normalised; 2.3's is exact-basename

- `library-folders.js:14` — `norm()` lowercases, strips `_spotdown.org`, drops all punctuation, and
  matches the **song title** against the **filename stem**.
- `library-health.js` (2.3) — exact, lower-cased **basename** membership.

They will disagree: 2.3 can call a row `dead` that Re-sync would happily relink. **This is the
"fourth implementation" risk in a subtler form** — not a duplicate function, but two different
definitions of "the same file". They must be reconciled into one matcher before either grows.
`norm()` is the more forgiving and battle-tested of the two; 2.3's is the cheaper. Likely answer:
one module exporting both an exact index and a normalised index, built in the same walk.

### 8.4 · Scope — it only ever considered music

`matchStation` (`:64-77`) filters `content_class IS NULL OR = 'MUSIC'` and restricts to the station's
format categories. **It has never looked at announcements, spots, carts, voice tracks or episodes** —
precisely the tables the new rule covers. Extending it means widening its scope from "this station's
music" to "every audio-bearing row", which is a real change to what Re-sync means, not an addition.

### 8.5 · Silent failure to fix while we are here

`applyRelink` NULLs `generated_schedule.file_path` for every miss (`:101`) so the scheduler skips
them. That is deliberate and better than stalling — but it is **silent**, and it is the same class of
defect as the prefetch's silent defer. Under *No silent failures* it should count and report what it
nulled.

---

## 9 · OPEN — added by §8

4. **Which `music_dir` is THE audio library** (§8.1) — per-station or per-machine? Everything else
   depends on this answer, and it should be decided before any copy-on-import code is written.
5. **Confirm Re-sync/Relocate become local-only writes** (§8.2). This is a bug fix in its own right,
   independent of the new rule.

---

## 10 · SHIPPED 2026-09-04 (local, uncommitted) — the path leaks

### 10.1 · `applyRelink` no longer syncs a path
`library-folders.js` writes `songs.file_path` directly. `songsUpdateById` is no longer passed to the
module (`main.js`), so the guarantee is structural rather than remembered. `updated_at` is not bumped
— a relink is not an edit peers should see. Misses were silently NULLed; they are now counted and
returned as `unlinked`.

### 10.2 · `music_dir` is LOCAL_ONLY, and the library converged on the machine
`station_config_kv.js:51` now includes `music_dir`. `getFolder()` reads through to the per-machine
`MUSIC_DIR_FILE`, falling back to the stale per-station row only when the machine has none, so no
install loses its library on upgrade. Both writers now call `setMachineMusicDir`.
`stationConfigKvUpsertByKey` is no longer passed to the module either.

### ⚠ 10.3 · THE FINDING THAT FORCED THESE TO LAND TOGETHER

`stationConfigKvUpsertByKey` **silently no-ops on a local-only key** and returns a SUCCESS shape
(`station_config_kv.js:220`):

```js
if (isLocalOnlyKey(key)) return { ok: true, skippedLocalOnly: true };
```

So adding `music_dir` to `LOCAL_ONLY_KEYS` *by itself* — the "two-line change" — would have made
Relocate and station-folder:choose **stop saving the operator's folder while still reporting
success**. A silent regression, introduced by a fix for a silent defect.

The general hazard is worth naming: **a guard that returns a success shape converts a refusal into a
lie.** It is the same defect as the ledger's `{id:null,...evt}` catch (fixed 2026-09-04) and the
prefetch's silent defer. There are two more `isLocalOnlyKey` early-returns on this pattern
(`:120`, `:156`) — **flagged, not touched.**

### 10.4 · Gates
`npm run test:relink` — 13 checks: the relink still relinks, the mutation log stays empty, a
`deps.songsUpdateById` getter throws if anything reaches for the sync writer again, `updated_at` is
untouched, `getFolder` read-through in all four cases, and `isLocalOnlyKey('music_dir') === true`.

---

## 11 · SHIPPED 2026-09-04 — the migration, the door, and copy-on-import

### 11.1 · The migration ran on the dev machine
`✓ repointed 167 (copied 2) · 433 already inside` — matching the dry run exactly. Verified against a
baseline captured beforehand:

| | before | after |
|---|---|---|
| rows pointing OUTSIDE the library | 167 | **0** |
| audio files in the library | 1,878 | **1,880** (exactly the 2 copies) |
| mutations for songs/carts/announcements/spots/library_asset | — | **0 in the whole hour** |

The `+2` mutations in the global count were `station_config_kv` updates timestamped three minutes
BEFORE the migration — ambient boot activity, not the repointer. 167 rows had `file_path` rewritten
and the sync log recorded nothing.

**C-6 (the repair and the signal must agree):** the classifier now returns
`resolves 600 · elsewhere 0 · dead 0 · foreign 0` → "AUDIO OK". Proven at the data level rather than
waited for.

### 11.2 · The door
`AudioLibraryFixer` in the Health Monitor's Library & Rotation panel — where the red content dot
lands. SCAN is a dry run and says so; the fix button names the count; repoints and copies are listed
separately (a repoint is instant and creates nothing, a copy uses disk); `GONE` rows are reported as
needing re-import and left alone.

### 11.3 · Copy-on-import — the rule, enforced at the door
`importIntoLibrary()` (main) + `importIntoAudioLibrary()` (renderer). **Every picker stores the path
it returns, never the browsed one.** Wired: carts, the songs import (folder + files), announcements,
spots (both the single and folder-import paths).

**Order is the invariant: copy → verify size → and only then may the caller write a row.** A refusal
returns null and the caller writes NOTHING.

Failure handling, each with an operator-readable reason: `ENOSPC` ("not enough free disk space"),
`EPERM`/`EACCES` ("permission was denied"), a missing source, a name too long for the folder, a
short copy (partial file deleted, never left behind), same-name-same-size (reused — no duplicate),
same-name-different-bytes (disambiguated, **never** overwriting), and importing from inside the
library (no-op).

The songs importer **collects** refusals and shows them on the completion screen, because "Import
Complete" over a silent partial failure is how an operator discovers at 4pm that this morning's
track was never really added.

### 11.4 · Gates
`npm run test:audio-library` — 41 checks. The ones that matter: REPOINT copies nothing (8 duplicates
avoided on real data), a second run is a no-op, same-name/different-bytes never overwrites,
re-importing the same file reuses it, and the mutation log stays empty throughout.

### 11.5 · NOT yet wired to copy-on-import
Deck load-from-disk (`App.tsx:3575`), TrackEditor intro/version, ClipEditor, StudioPro,
BroadcastEditor, PublishEpisode, Widgets, GSelectorImport. These are one-off loads and production
surfaces rather than library imports; each needs its own decision about whether a hand-load should
enter the library. **Named so it is a known gap rather than a forgotten one.**
