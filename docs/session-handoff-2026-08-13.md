# Session handoff — 2026-08-12/13

**Tree:** `C:\openair`, branch `log-reader-flip`, clean.
**package.json:** 4.4.207. **Last installer built:** 4.4.207 — **do not trust it, see §1.**
**Head:** `c11fca7 Health dashboard: wall-display layout`

Everything after the 4.4.207 installer is committed but **dev-only** — no installer contains it.

---

## 1. FIRST THING NEXT SESSION

**Rebuild 4.4.208 from the clean tree.** The 4.4.207 installer was packaged while `electron/main.js`
was being edited (the no-edit-during-build rule). The file has since been reverted and the tree is
clean, but that artifact is untrustworthy and nobody should install it.

```
npx tsc --noEmit && npm run build && npm run electron:build:win -- --publish never
```

Bump to 4.4.208 first. Gates as of head: **tsc 0 · vitest 315 passed · verify:schema PASS**.

---

## 2. What shipped in installers (4.4.193 → 4.4.207)

| Version | What |
|---|---|
| 4.4.193 | Designation record could never be written — `_kvPut` omitted `uuid` (NOT NULL). Fixed via the two sanctioned writers. |
| 4.4.194 | REFRESH NOW legible: per-station busy, stale-read guard, disabled state when auto-gen off |
| 4.4.195 | Refresh gets its own evidence (banner); `health:recent-events` reads the ledger back for the first time |
| 4.4.196 | **Manual log editing** — Generate stops destroying operator rows; drag/pin/delete; rule warnings |
| 4.4.198–199 | Drag ghost, drop line, scroll preservation |
| 4.4.200 | Spreadsheet log view on the shared `DataGrid` |
| 4.4.201 | **Phase B enforcement** + auto-gen migration made one-time + deleted-show sweep (11 sites) |
| 4.4.202 | Sync switch fixed — it enabled an engine with no backend URL |
| 4.4.203 | **Deleted songs stop airing** — `source='auto'` regression + `deleted_at` on all 9 pickers |
| 4.4.204–207 | Health dashboard phases 1–3 (cards, bars, chart, timeline) |

## 3. Committed since the 4.4.207 installer (dev only)

- `3fb5942` runway trend chart + **`runway_history` table** (local-only, sampled hourly on the
  existing 30-min tick, trimmed to 30 days)
- `2fe15b8` station lookup fixed (ids compared by value — `2 !== "2"` broke every card) and
  "no active show" no longer claimed for unmeasured stations
- `0893595` **VU meters** — decks in dBFS from `audio:levels` (ref-driven, never React state — that
  channel is ~90 fps and recorded as implicated in a renderer OOM), program loudness in LUFS from
  `audio:proc-meters` with a target band
- `c11fca7` wall-display layout — pairs two-across at ≥1280px, measured on the panel not the window

---

## 4. OPEN DECISIONS — these need Jeff, not more code

| # | Decision | Why it is blocked |
|---|---|---|
| 1 | **Sync: the 385k backlog** | Every mutation ever written is `pending`; enabling sync starts draining them all to a live backend |
| 2 | **Sync: `sync_uuid_identity`** | It is OFF, and the peer engine routes station rows by LOCAL INTEGER id. Two installs whose ids differ will **mix stations up**, not merge. Verify before two machines ever sync. |
| 3 | **Phase C takeover design** | `docs/phase-c-takeover-design-2026-08-12.md` — untracked, 5 open questions in §7 |
| 4 | **Unified Log View** | `docs/unified-log-view-design-2026-08-12.md` — Phase 0 is populating `programming_row_id`; everything else depends on it |
| 5 | **Hand-load rows** (§7 risk 2 of manual-log-editing) | When the log-reader flip goes on, a jock's hand-load becomes a permanent operator row. Dormant now. `isOperatorOwned()` is the one place to change. |
| 6 | **Rotation goals** | Only 1 of 10 categories on station 1 and 1 of 2 on station 2 have `spins_per_hour`. The bars are built and have almost nothing to measure against. |

## 5. UNVERIFIED — never run

**The Fix 2 §5 test plan (A–F)** in `docs/manual-log-editing-design-2026-08-10.md`. That is the
verification of the headline claim — that Generate no longer destroys manual edits. A and B are the
ones that matter. The ledger does show `generate-operator-rows-preserved` firing 5×, which is real
evidence it works, but the plan itself has never been walked.

## 6. Known problems NOT being worked

- **Icecast (2) streaming failure** — "Streaming failed after repeated ffmpeg restarts" on halloVeen,
  seen on screen 2026-08-13. Never investigated. Possibly the most operationally serious open item.
- **Railway backend intermittently unreachable** — `cloud-reconcile-down` with failure counts
  climbing 1 → 67 → 74 → 124 across the day.
- **`health-events.jsonl` has no rotation** — 39 MB after 24 days, ~1.6 MB/day, growing forever. The
  reads are bounded so the panel stays fast, but the file is not.
- **Something wrote to deleted songs on 2026-08-07** — 8 `update` mutations on rows deleted 2026-07-20.
  Did not resurrect them. Likely the library rescan or the cue/loudness pass. Unidentified.
- **Auto-gen is ON for all four stations on dev.** 4.4.201 stopped the migration re-enabling it but
  did not switch anything off. Jeff's call.

## 7. Housekeeping

- **DB backup from the runway backfill:** `openair.db.pre-runway-backfill-20260813` (636 MB) next to
  the live DB. Delete when satisfied.
- **Untracked, not mine to commit:** `check-designation.js`, `temp-extract/`, and the `.gitignore`
  credential-notes change from 08-09.
- `docs/phase-c-takeover-design-2026-08-12.md` is untracked and awaiting review.

## 8. Rules that earned their keep this session

Worth carrying forward — each of these caught a real defect:

- **A grep is a claim about the tree, never about the product.** The designation fix looked done in
  source and was provably absent from the DB.
- **Never write the live DB externally while Ether is open.** The runway backfill waited for a
  confirmed-zero process check and took a backup first.
- **"Not measured" is not "measured and empty."** Three separate bugs this session were a definite
  claim printed for an unmeasured state.
- **Check the emitter before building the UI.** The dashboard spec named three data sources that do
  not exist (`stations[].designation`, `engine:getQueue`, per-deck LUFS).
