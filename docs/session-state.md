# Session State — Roadmap Tracking

**Updated:** 2026-05-24
**Purpose:** Snapshot of where the project actually is relative to `roadmap.md`, including in-flight detours that don't show up in the roadmap doc itself. Maintained so a fresh session (or a returning operator after time away) can pick up the actual current thread without reconstructing it from chat history.

This doc supplements `roadmap.md` — it does not replace it. The roadmap is the long-arc plan; this doc is "what's actually happening right now."

---

## 1. Current roadmap position

**Officially:** Item 3 — High Availability Architecture (`roadmap.md` §3).

Items 1 (Sync Backend) and 2 (Deploy OV + 2nd Client) are complete. Item 3 is the declared next major arc. Items 4 (Iris-as-Platform), 5 (Multi-Tenant Control Center), 6 (Plugins/OSS/BYO-Cloud), 7 (AirLogger), and 8 (Onboarding & Library Distribution) follow per the roadmap.

Note: roadmap.md still shows Item 2 as "Ready to start" and Item 8 as "Not started." Both are stale — Item 2 was proven 2026-05-19 (commit 36d92dc), and Item 8's R2 schema columns landed in v17/v18 (commits 5b2afe8 et al). Roadmap update is itself a small follow-up.

---

## 2. Detours queued before Item 3

Several arcs sit in front of Item 3's actual execution. None are in roadmap.md by name — they're support work for the main path.

### UI tooling — Phase 1 (debug panel)

**Status:** Built & verified, BUT still uncommitted in the working tree as of 2026-05-24 — it was never folded into a commit this session (every commit deliberately worked around it). The 5 files below remain dirty/untracked. Commit it as its own change next session (or whenever convenient).

**Scope:** Dev-only debug panel reached via `#debug` URL hash or footer-version triple-click. Three sections — tier override (Solo/Studio/Network/Enterprise marketing labels mapped to free/pro/station/operator code values), reset onboarding, jump-to-screen (Onboarding / Subscription / Manage Devices / About / Settings). Plus `window.__devSetTier/__devClearTier/__devResetOnboarding` console helpers. Three layers of gating (`import.meta.env.DEV` build-time + runtime) ensure zero footprint in packaged builds.

**Files touched (5):**
- New: `src/components/DebugPanel.tsx`, `src/lib/devGlobals.ts`
- Edited: `src/main.tsx`, `src/hooks/usePlan.tsx`, `src/App.tsx`

**Why it's a detour:** Closes the immediate visibility gap — operator could not see UI changes in-session without reinstalling a packaged build. Phase 1 enables every subsequent UI arc (including the HA work's health dashboard) to be testable as it's built.

### UI tooling — Phases 2–5

**Status:** DEFERRED post-launch. Scoped in prior session.

- Phase 2: Playwright + critical-path tests (onboarding, license activation, station switch) — ~2–3 sessions
- Phase 3: Beta release channel via electron-updater — ~½ session
- Phase 4: Storybook + component isolation + mock layer — ~3–4 sessions (incremental)
- Phase 5: Visual regression (Playwright snapshots first, Chromatic if Storybook lands) — ~½ session

Sequencing rationale: Phase 1 alone closes the immediate gap. Phases 2–5 compound over time but are not blocking any product arc.

### Tier rename arc

**Status:** DEFERRED. Full execution plan drafted (4 commits across 2 repos: 3 ether-backend + 1 openair). Not blocking.

**Plan summary:** Rename `free/pro/pro_lifetime/station/station_lifetime/operator` → `solo/studio/studio_lifetime/network/network_lifetime/enterprise` across both repos. Production data is tiny (4 active licenses, all internal: 2× sync-test, 2× djdeniro). Hard cutover with transient-window safety via unioned `VALID_PLANS` in backend. Total ~218 LOC.

**Why deferred:** Cosmetic cleanup. The marketing labels (Solo/Studio/Network/Enterprise) are already being introduced in UI copy and the debug panel. Code-level rename can wait for a calmer window.

### Phase A — multi-station main-process work

**Status:** Partial. Phase B1 (Rust BusMixer + Program Bus TCP) shipped (commit 3249da6). Phases B2–B6 not shipped. Original Phase A multi-station plumbing (Step 0-C INSERT audit, engine map in main.js, per-station stream state map) not finished.

**Why it's a detour:** Phase A is the foundation for the Item 3 "graceful audio crossfade across restart" piece. The in-memory Program Bus tap that B1 introduced is the architectural seam where crossfade-across-restart would be wired. Item 3 can ship its other 4 pieces without Phase A, but the crossfade piece architecturally wants B1 (done) plus a separate audio host process (not done).

---

## 3. Item 3 (HA) scope decision

**Locked:** Ship the Phase-A-independent HA pieces first. Defer crossfade-across-restart until a separate audio host process exists.

**What ships in the first HA arc:**
1. Process supervisor with crash detection + auto-restart (single Ether process)
2. Sync engine resilience hardening (UI surfacing of disconnect state, powerMonitor network hooks, observability on long disconnects)
3. Health dashboard (process uptime, last sync tick, deck states, cursor position)
4. Operational runbook for station operators

**What's deferred to the post-Phase-A HA arc:**
5. Graceful audio crossfade across process restart

**Reasoning:** OV currently fails the Program Director Test the moment Ether crashes — no crash recovery exists. A supervisor that auto-restarts in 5–30 seconds is a huge improvement deliverable in days. Doing all of Phase A first would leave OV with no crash recovery for the duration of Phase A (multi-week arc). Crossfade-across-restart is real but architecturally entangled; better to wait for the right seam to land. Listeners will hear 5–30s of dead air on the restart instead of indefinite silence — acceptable interim state, huge net improvement.

---

## 4. Sequencing locked

```
1. Debug panel                        (today — in progress)
2. Partial HA — OV crash recovery     (next arc)
3. Phase A multi-station OR
   Tier rename OR
   Item 4 (Iris-as-Platform)          (next-next — operator picks)
```

The choice at step 3 is open. Each is a multi-session arc and they don't block each other:
- **Phase A** completes the architectural foundation for the deferred Item 3 crossfade piece and unblocks Item 5 (Control Center).
- **Tier rename** is cleanup; longer it sits, the more sites accrete with the old names.
- **Item 4** is a big architectural arc (Iris-as-Platform) with substantial open design questions.

---

## 5. Open tracker items surfaced today

**OB17 — Consolidate duplicate `TIER_RANK_LOCAL`**

The tier-rank lookup table is duplicated 4 times across the codebase: `electron/main.js:3188`, `electron/main.js:3879`, `electron/main.js:4025`, `electron/cloud-backup.js:27`. Each is a verbatim copy of the canonical `TIER_RANK` in `src/hooks/usePlan.tsx:20`. Surfaced during the tier rename audit — flagged for cleanup but kept duplicated for this phase to avoid mixing rename with refactor.

**Resolution:** Extract a shared module (e.g., `electron/lib/tier-rank.js`) that the 4 electron-side sites can import. Will eliminate 4× drift risk during future renames.

**Bundle with:** Tier rename arc when it executes, or as a standalone tiny cleanup commit.

---

## 6. Operator-side follow-ups (dashboard / manual work)

These are not Claude-actionable — they require operator-level access to external dashboards. Tracked here so they don't fall off the radar.

- **Resend domain verification** for `ether-technologies.com` — confirm DNS records and email deliverability propagation through the rename from `etherradio.app`.
- **Rotate `ADMIN_SECRET`** — exposed in chat during recent debugging. Update on Railway → restart backend → confirm `/admin/issue` still works with the new value.
- **Rotate Postgres password** — exposed in chat (visible via `railway variables` output). Update on Railway → confirm backend reconnects.
- **Verify email aliases work** — `support@`, `legal@`, `noreply@` at `ether-technologies.com`. Send test mails, confirm delivery + reply routing.

---

## 7. Last verified working state

- **Version shipped:** Ether v4.1.11 (commit fbd9112).
- **Branch:** main on both repos (`C:\openair` and `C:\ether-backend`).
- **All session work merged:** no in-flight branches pending integration on either repo.
- **Railway deployments:** active. Backend at `ether-backend-production.up.railway.app` healthy.
- **Production licenses (Railway):** 4 active rows confirmed 2026-05-23 via `list-licenses.js` — 2× pro (sync-test@ether.dev, sync-test2@ether.dev), 2× station (djdeniro@gmail.com × 2). No unexpected plan values.
- **Sync convergence:** proven 2026-05-19 (commit 36d92dc) — LIVE CONVERGENCE + LIVE-DATA FK-VALID.
- **OV install:** running v4.1.11 against the active backend. No outstanding deployment.

---

## 8. Session close — 2026-05-24

What shipped this session (newest last):

- **v4.1.11 customer release** — already live (commit fbd9112).
- **Debug panel (Phase 1 UI tooling)** — built & verified; **code still uncommitted** in the working tree (`DebugPanel.tsx`, `devGlobals.ts`, + hunks in `App.tsx`/`usePlan.tsx`/`main.tsx`). See §2. Needs its own commit.
- **OB18 — onboarding local-mirror fix** — submitAddStation/submitBindSeat now mirror backend station create/bind into the local stations table (commits 165f8d1 + e42ae26).
- **EB17 — abandoned-onboarding cloud orphan** — cleanup tooling shipped (`ether-backend/scripts/delete-orphan-station.js`, commits 005d310 + 52de3f8; tracker entry 69ca965) **and executed** — orphan "Ether Radio" + its dangling seat binding deleted from Railway.
- **Onboarding connect-path redesign** — returning customers pick an existing station and drop straight into the app (skip experience/venue/name/audio/pull); empty-account → add-station fallback (commit 2c3f61f).
- **Manage Stations delete fix** — `stations:list`/`:get-active` now filter `deleted_at IS NULL` (bundled in 2c3f61f).
- **Ghost "Station 1" soft-deleted at pick** — pragmatic interim; proper fix tracked as OB19 (bundled in 2c3f61f).
- **Tier label rename (customer-facing)** — Free→Solo, Creator/Pro→Studio, Station→Network, Operator→Enterprise across both repos; internal code values unchanged (openair af1c786 + ether-backend fe1df59).

Parked for future arcs:

- **OB19** — remove the auto-seeded "Station 1" entirely (audit `station_id=1` hardcodes, restructure default seed data). Multi-session arc.
- **OB20** — pre-launch tier feature-gating audit, **blocked on the operator refreshing the website tier-feature list** (current list is stale). Includes the multi-station label/gate mismatch (labeled Enterprise, website says Network).

**Next session entry point:** this file + the OB19/OB20 tracker entries in `docs/close-out-tracker.md`. First loose end: decide whether to commit the debug panel (still dirty).
