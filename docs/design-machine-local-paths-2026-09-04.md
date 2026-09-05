# Design — An absolute path must never cross machines

**Date:** 2026-09-04 · **Status:** PROPOSED — requires amendment to `sync-protocol-v0.md` §4.3 before any code
**Author:** Claude Code, from the OV incident of 2026-09-04
**Amends:** `sync-protocol-v0.md` §4.3 [N-22] / [N-23] (blob-ref column representation)
**Related:** `docs/library-exclusion-diagnosis-2026-07-20.md`, `docs/library-exclusion-slice-b-2026-07-20.md`

> Per the two-commit boundary: this doc locks in commit 1. No code lands until it is accepted or
> amended. If the implementation would differ from what is written here, this doc is amended first.

---

## 1. The defect, in one sentence

`file_path` is a `blob-ref` column, the blob-ref envelope carries the **originating machine's absolute
path**, and the receiver writes that path verbatim into its own database — so a row synced from one
machine names a file location that exists only on a different computer.

## 2. Evidence (OV, 2026-09-04)

A `songs` mutation received on OV at 16:17:12Z, originating from the dev machine:

```json
"file_key": "Wolves_spotdown.org.mp3",
"file_path": {
  "__blob_ref":    "C:\\Users\\jensj\\Music\\ether music library\\Wolves_spotdown.org.mp3",
  "__blob_size":   null,
  "__blob_origin": "C:\\Users\\jensj\\Music\\ether music library\\Wolves_spotdown.org.mp3"
}
```

The round-trip in `electron/sync/mutation-writer.js`:

- `serializePayload` → `__blob_ref: String(val)` — *"[N-23]: use original path as opaque ref in v0"*
- `deserializePayload` → `row[col] = val.__blob_origin` — *"extract path from [N-22] envelope"*

There is no rebase step in either direction. The envelope is decorative: three fields, two of which are
the same string, and no consumer anywhere in the tree reads `__blob_ref` or `__blob_size`. A grep for
`__blob_ref` finds it in the protocol doc, the writer, tests, and dev scripts — **in no handler and no
merge path**.

### Measured blast radius on OV

382 rows across four tables pointed at `C:\Users\jensj\...`, a profile that exists on OV as a
permission-denied shell (`Music`/`Downloads` are `EPERM`; everything beneath them reports `ENOENT`).
Consequences observed:

| Symptom | Mechanism |
|---|---|
| Announcements refused to load — *"needs re-import"* | `resolveLocalAudioPath` queries `FROM songs` only; `announcements` has no row **and no `file_key` column**, so the R2 fallback can never fire |
| Sweepers/spots absent from air | daemon `_fileOk()` tests only the stored path; a row with a `file_key` is classified R2-only and **silently deferred forever** |
| Rotation reduced to a 133-song pool | only the rows whose `file_path` already happened to be local were `_fileOk`-eligible |
| 375 duplicate audio files on disk | `fetchR2Track` builds its cache path from a *sanitised* basename, misses a file already present under its real name, and downloads a second copy |

`library-health` reported `r2Only: 163/163` on one station — every song in the library classified
"not local" while the bytes sat in the music folder under the right name.

### Why it stayed invisible

The deferral is **silent by design**: `refillIfNeeded` only emits a `loadskip` when a row has *no*
`file_key`. A row with a `file_key` is assumed to be prefetch-lag that will resolve on a later pass.
But the prefetch writes to the music dir and **never updates the row**, so the next pass fails
identically. `dead=0`, `skipped=0`, health green-ish, and no element ever airs. This is a violation of
*No silent failures* (roadmap, Cross-Cutting Design Principles → UX).

## 3. Why the current design is wrong in principle

Two of the roadmap's own commitments are contradicted by shipping absolute paths through sync:

- **"The machine is just a terminal. The account is everything."** (CLAUDE.md) — a path rooted at
  `C:\Users\<someone>\` is machine identity leaking into account-scoped data.
- **"Local state is authoritative; cloud is the log."** — a *location* is local state. It is precisely
  the class of fact that must not be replicated.

`is_active`, `icecast_password`, `stream_key`, `monitor_routing` and the playhead columns are already
`local-only` for exactly this reason, each with a comment explaining that syncing per-machine state
clobbers the other machine. `file_path` is the same category and was not classified with them.

## 4. Options considered

### Option A — Rebase on deserialize
`deserializePayload` rewrites a `blob-ref` to `<this machine's music_dir>\<basename>` on apply.

- ✔ One function; fixes every table at once; no schema change.
- ✔ Inbound rows self-heal on arrival, permanently.
- ✘ The writer still *sends* a private absolute path — an information leak and a lie on the wire.
- ✘ Rebasing needs a music dir; `cart_slots` files legitimately live outside it (OV's carts point at
  `Downloads`), so a blind rebase invents a wrong path for them.

### Option B — `file_path` becomes `local-only`; `file_key` is the synced identity
The wire carries only the content identity; every machine owns its own location.

- ✔ Structurally correct: the bug becomes unrepresentable.
- ✔ Matches the existing `local-only` precedent and its stated rationale.
- ✘ **Blocked on a schema gap:** `announcements`, `spots`, `cart_slots`, `voice_tracks` and
  `published_episodes` have **no `file_key` column**. Without one they'd sync a title and no way to
  find the audio. This is a numbered migration across five tables.
- ✘ Existing rows in the wild still carry absolute paths; needs a transitional read path.

### Option C — Resolver tier only (already authorised, shipping separately)
Try `music_dir\basename` before reaching for R2, in both `main.js` and `audiod/engine.js`.

- ✔ Repairs the symptom on every machine without touching the protocol.
- ✘ Does not stop bad data propagating; each new install still receives foreign paths.

## 5. Recommendation

**Adopt B as the target; ship A as the bridge; keep C regardless.**

- **C** is the operational floor — it makes any machine self-healing against the paths already in the
  wild, including the ones on every install today. It needs no protocol change and is already approved.
- **A** stops inbound rows from *writing* foreign paths, and is a small, testable change.
- **B** is the correct end state and is what this amendment reserves. It should not be attempted until
  the `file_key` migration exists for all five tables.

Sequencing matters: **C before A.** With C in place, a row carrying a foreign path is already
harmless, so A can land without a flag day.

## 6. Proposed protocol amendment (§4.3)

Replace [N-22]/[N-23] with:

> **[N-22] (revised).** A `blob-ref` column identifies a *content object*, never a filesystem location.
> Its payload representation is `{__blob_key, __blob_size}` where `__blob_key` is the R2 object
> basename (`file_key` semantics). It MUST NOT carry an absolute path.
>
> **[N-23] (revised).** On apply, the receiver resolves `__blob_key` to a local path using its own
> configuration. The resolution order is: existing local `file_path` if it resolves → `music_dir` +
> `__blob_key` → R2 fetch by `__blob_key`. A receiver MUST NOT store a path it did not construct
> itself.
>
> **[N-23a] (new, transitional).** A payload whose `blob-ref` carries the legacy
> `{__blob_ref,__blob_origin}` shape is accepted for backward compatibility. The receiver MUST take
> only the **basename** from it and MUST discard the directory component. Emitting the legacy shape is
> deprecated as of this amendment.

`[N-23a]` is what makes the amendment deployable: an old sender and a new receiver interoperate, and
the new receiver is immune to the defect from the moment it ships.

## 7. Transformer / schema-version obligations

This is the first **non-identity** payload transformer on the chain — the one case
`sync-protocol-v0.md` §23 (I) and roadmap Item 1 Step 7 flag as "still unexercised". It must:

- carry a `schema_version` bump and a numbered migration script;
- ship a transformer that maps the legacy envelope forward (basename extraction) so quarantined and
  replayed mutations convert correctly;
- be exercised by a real (not synthetic) fixture — this closes the open caveat on Step 7.

## 8. Test requirements (gates, not suggestions)

1. **T-new-1** — legacy `{__blob_ref,__blob_origin}` inbound → row stores a path under the *receiver's*
   `music_dir`, never the sender's directory.
2. **T-new-2** — round-trip on one machine is lossless (no path churn when sender and receiver share a
   music dir).
3. **T-new-3** — a row whose audio is absent locally but present in R2 resolves via `__blob_key`, and
   the resulting local path is written by the receiver, not the sender.
4. **T-new-4** — a `cart_slots` row pointing outside the music dir is **not** rebased into it; absent
   audio surfaces as a loud, operator-visible refusal.
5. **T-new-5** — regression: with C in place, a row carrying a foreign absolute path still airs.
6. **T-new-6** — no silent defer: a row that cannot be resolved by any tier emits a `loadskip`. The
   "has a `file_key`, therefore assume prefetch-lag" branch must be bounded — after N failed passes it
   escalates to loud.

Gate 6 is the one that would have caught this incident on day one.

## 8a. Scope correction (2026-09-04, measured)

`play_log.file_path` is **also** a blob-ref and ships the same envelope — sampled mutations carry
`__blob_origin: "C:\Users\projector\Music\..."`. That makes **eight** audio-bearing tables, not
seven; this doc understated the amendment's scope. It is a log rather than a playout source, so it
cannot cause silence — but it is the same defect and the amendment must cover it. Not investigated
further.

### 8b. A ninth surface: StudioPro session snapshots (2026-09-04)

`saveSession` deliberately keeps each region's `filePath` ("so we can re-fetch on load",
`StudioPro.tsx:1195`), and those snapshots persist into `studio_session_versions`. So a saved DAW
session carries absolute audio paths too — a **ninth** surface shipping paths, after the eight in §8a.
It is the DAW's own persistence model rather than an import path, and a session is not a playout
source, so it cannot cause silence. Recorded so the amendment's scope is not understated again.
Not investigated further.

## 9. Out of scope

- The `fetchR2Track` sanitisation twin-making. Real, separate, already approved as its own fix.
- Backfilling the 375 duplicate files on OV. Data cleanup, separately sequenced.
- `cart_slots` re-import on OV. Operator task.
- Whether `scheduled_log.file_path` should exist at all — the registry declares it `blob-ref` but the
  live table has no such column. Registry/schema mismatch; flagged, not addressed here.

## 10. Open questions for Jeff

1. Is `music_dir` guaranteed present at apply time on a fresh restore, or can inbound rows arrive
   before the station is configured? If the latter, A needs a deferred-resolution path.
2. Should `cart_slots` gain a `file_key` and move its audio into the managed library, or stay as
   free-path references the operator maintains?
3. Does the amendment need to hold for `intro_version_path` (also `blob-ref` on `songs`) in the same
   release, or can it follow?
