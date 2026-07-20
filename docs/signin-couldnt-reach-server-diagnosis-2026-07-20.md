# Sign-in error "Couldn't reach the server to load your stations" — diagnosis (4.4.64, 2026-07-20)

**Symptom:** On 4.4.64 first launch the account sign-in screen shows
*"Couldn't reach the server to load your stations. Check your connection and try Sign in again."*
Network confirmed fine by the operator.

**Verdict:** **NOT a backend outage. NOT a 4.4.64 regression.** The message is fired by a
**locally-rejected request** to `/account/connect` (a non-200 HTTP response) that the UI mislabels
as "couldn't reach the server." Most likely `401 invalid_license_key`, or `400 missing_fields`
(empty `machine_id` on a truly fresh first launch), or `403` seat-limit.

---

## (1) Backend is UP and healthy — probed directly 2026-07-20 ~18:17Z

| Probe | Result |
|-------|--------|
| `GET /health` | **200** in 165ms — `{"ok":true,"service":"Ether Technologies API","version":"1.5.2"}` |
| `POST /account/connect` bogus license | **401** `{"error":"invalid_license_key"}` (~195ms) |
| `POST /account/connect` empty license | **400** `{"error":"missing_fields","detail":"license_key and machine_id are required"}` |
| `POST /account/connect` no body | **400** `missing_fields` |
| `GET /api/account/stations` (no token) | **401** `{"error":"missing_token"}` |

Server responds correctly and fast to every probe. The backend is not down and `/account/connect`
is alive.

## (2) What actually fires the message — and why the wording is misleading

`src/components/OnboardingFlow.tsx` `routeAfterAuth()` (~line 372–392):

```js
let connectOk = false;   // did the server AFFIRMATIVELY answer with a station list?
try {
  const idResp = await window.ether.identity?.get?.().catch(() => null);
  const res = await fetch(`${ETHER_BACKEND_URL}/account/connect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ license_key: lk, machine_id: idResp?.ok ? idResp.machine_id : '', machine_name: ... }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && Array.isArray(data.stations)) { connectOk = true; stations = data.stations; ... }
} catch { /* connectOk stays false */ }

if (!connectOk) {
  setAuthErr("Couldn't reach the server to load your stations. Check your connection and try Sign in again.");
  setState('auth');
  return;
}
```

`connectOk` is true **only** on `res.ok && Array.isArray(data.stations)`. It is false — and the
"couldn't reach the server" message shows — on **any non-200 HTTP** (401/403/400/500/502) **or** a
thrown fetch. The copy says "couldn't reach the server," but the code fires it identically for a
*rejected* request. Because the server is provably reachable, this is a **rejection, not
connectivity.**

This is the documented-open **C1–C3 gap** in `docs/onboarding-signin-state-table.md`: connect
error / non-OK / seat-limit are all collapsed into one path. Three real candidates:

- **401 `invalid_license_key`** — the license key entered/stored doesn't match this account. Most likely.
- **400 `missing_fields`** — `machine_id` came back empty because `ether.identity.get()` wasn't
  ready on a genuine **first launch**. Machine-id lives at
  `%LOCALAPPDATA%\EtherMachine\machine-id` (see `project_stable_machine_identity`); on a truly
  fresh boot that file may not exist yet when sign-in fires.
- **403** — seat limit reached for the account's devices.

## (3) 4.4.64 did NOT touch the auth / stations-load path — no regression

Full `e1fa433..HEAD` (4.4.63 → 4.4.64) diff is **UI / DAW / audio only**. Changed files:
`CHANGELOG.md`, `audiod/engine.js`, docs, `package.json`, `scripts/probe-deck-volumes.js`,
`src/App.tsx`, `src/audio/engine-rodio.ts`, `src/audio/imagingCommit.ts`,
`src/audio/regionAudition.ts`, `src/components/ClassPoolSelect.tsx`, `ReelSplitter.tsx`,
`StudioPro.tsx`, `StudioSendBar.tsx`, `UpNext.tsx`.

`App.tsx`'s **entire** change is 3 lines: two jingle-overlay comment edits, adding `"SCHEDULED"` to
a state-string list, and passing `stationId` to `<StudioPro>`. Nothing in `OnboardingFlow`,
`ccData`, identity resolution, or the connect fetch.

The `[reconcile] register-station failed: 401` spam in `ether-startup.log` is **background reconcile
noise on an already-signed-in box** (`src/lib/ccData.ts:441`, POST `/account/register-station`),
unrelated to the first-launch sign-in error.

## Observability gap this exposed

`ether-startup.log` never records the `/account/connect` status — it logs only the renderer's
register-station warnings. The actual failing status (401 vs 400 vs 403) is **invisible from the log
alone.**

**To pin the exact status right now:** open DevTools → Network on the sign-in screen and read the
`/account/connect` response; or check the stored license key against `/account/connect` directly.

**Permanent fix (recommended):** in `OnboardingFlow.tsx` capture `res.status` at the connect call
and branch the message — bad/invalid license vs. seat-full (403) vs. truly offline (fetch throw) —
instead of the one catch-all string. This closes the C1–C3 gap in the state table and stops
"couldn't reach the server" from masking a rejected license or an empty machine_id.

---

*Read-only diagnosis. No source changed. Probes run 2026-07-20 against
`ether-backend-production.up.railway.app`.*
