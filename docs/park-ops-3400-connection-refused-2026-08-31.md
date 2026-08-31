# Park Ops :3400 — ERR_CONNECTION_REFUSED, diagnosed 2026-08-31 (read-only)

Symptom (Jeff, verbatim): "Browser gives ERR_CONNECTION_REFUSED at http://172.30.34.152:3400/ops/".

## Cause

**Nothing is listening on :3400 because Ether is not running at all.** `netstat -ano | grep :3400`
→ no listener. `tasklist` → no Ether/Electron process. ERR_CONNECTION_REFUSED is the honest
answer to "no process bound to that port"; it is not a routing or bundle fault.

**Second, independent blocker:** the *installed* app cannot serve /ops/ either.
- Installed: `%LOCALAPPDATA%\Programs\Ether\Ether.exe`, ProductVersion **4.4.229**, dated **Aug 19**.
- The ops work landed **Aug 31** (`electron/ops-api.js` 09:57, `web/ops/` 10:00, `electron/main.js` 10:11)
  and is **uncommitted / unbuilt**.
- `grep -c "Park Ops" resources/app.asar` → **0**. The route and the bundle are not in that build.

So relaunching the installed 4.4.229 would bind :3400 and still 404 /ops/. Park Ops only exists
in the source tree right now.

## Everything else checks out

| Check | Result |
|---|---|
| Route mounted | `electron/main.js:7013` builds `opsRoutes`; `:7047` dispatches before all other routes |
| Matcher | `ops-api.js:239` — claims `/ops*` and `/api/ops*` |
| webRoot | `path.join(__dirname,'..','web','ops')` → `C:\openair\web\ops` |
| Bundle on disk | `web/ops/index.html` (463 B) + `assets/index-CLqCmDaR.js` (147 KB) + `.css` — present |
| SPA fallback | `ops-api.js:296` falls back to index.html for unknown paths |
| Bind address | `main.js:7269` — `irisHttpServer.listen(3400, '0.0.0.0')` — **all interfaces, correct** |
| LAN IP | `172.30.34.152` on Wi-Fi — **still current and the only non-internal IPv4** |
| Packaging | `electron-builder.json:19` already ships `web/**/*` — a future packaged build will carry it |

No code change is required. Nothing was changed.

## The startup log line (`main.js:7280-7289`)

Printed inside the `listen()` callback, after `[API] REST server listening on http://0.0.0.0:3400`:

```
[ops] Park Ops (editable): http://<lan-ip>:3400/ops/?k=<32-hex-token>
```

One line per non-internal IPv4 address. On this machine that will be exactly one:
`http://172.30.34.152:3400/ops/?k=<token>`.

The token cannot be quoted in advance: `ensureToken()` (ops-api.js:89) mints it with
`crypto.randomBytes(16)` on first use and no ops build has ever run here, so
`station_config_kv.ops_token` does not exist yet. It is minted and printed on first launch.

Caveats on that line: it prints only when `db && getActiveStationId()` are both truthy. If no
station is active, the line is silently absent — but the page still serves read-only, because
`ops-api.js` gates only the WRITE (`PUT /api/ops/closing-time`) on `?k=`.

## To get it serving

Run from source, not the installed app:

```
npm run electron:dev
```

Then open **http://172.30.34.152:3400/ops/** (read-only) — or paste the `?k=` URL from the
`[ops]` log line to get the editable page.

Port contention: `main.js:7238` logs `[API] Port 3400 already in use` and disables the REST API.
Keep the installed 4.4.229 fully closed (including its tray icon and daemon) while the dev
instance runs, or the dev instance loses :3400.
