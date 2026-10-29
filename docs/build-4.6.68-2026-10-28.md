# Build 4.6.68 (2026-10-28)

**Jeff (verbatim):** "Finish the relay and build 4.6.68 today ... 5. Merge feat/patch-bay-outputs, the desktop sign-in work
(5e1a217, 7029763) and the relay into release/1019. 6. Type-check, all tests, the sync tests, and the full engine suite
must pass. 7. Build 4.6.68 and run the release checks: installer contents, size, the engine fingerprint check, and a real
launch in side-by-side mode that shows the queue filling from today's log and a station's existing Master device carried
over into the Patch Bay. 8. Give me the installer path and stop. Don't install it anywhere."

**Installer:** `C:\openair\dist-electron\Ether Setup 4.6.68.exe` — 216,409,020 bytes, sha256 `f927823de9448302…`. Local,
unsigned, not published, not installed anywhere. `release/1019` at `788ac34` (fast-forward of `feat/patch-bay-outputs`, 31
commits, plus the version commit). Not pushed, not tagged.

## In it

Patch Bay (outputs and inputs) · the ☰ door · console fader caps, double-click = 0 dB · the fader bank (minimum width,
sideways scroll, Master Out pinned, overview, narrow strips) · decks A/B/C as one strip · Settings sections (Remote Link,
Jukebox, Park Page, Audio Devices) and "Preferences" → "Settings" · sign-in Phase 0 (out of the database and backups) and
Phase 1 (stays signed in; starts straight to the station) · the Remote Link relay (engine + app; first-time Allow) · the
engine re-baseline · the release check that the engine is built from the app's engine source.

## Gates (all on `788ac34`)

- `tsc --noEmit`: 0 errors.
- vitest: 152 files, 1,253 tests, all pass.
- `test:sync`: 75 / 75.
- `test:rust` (full engine suite): 173 + 12 + 2 pass, 0 fail, 5 ignored.

## Release checks

1. **Contents: PASS** (against the installed 4.6.67).
   - app.asar 15,120 entries (4.6.67: 15,115). Added: `audiod/output-patch.js`, `electron/account-session.js`,
     `electron/account-renewer.js`, `electron/link-relay-client.js`, `scripts/smoke-link-relay.js`, and the renamed
     bundles. Nothing removed.
   - app.asar.unpacked 912 files (4.6.67: 911): + `audiod/output-patch.js` (the engine loads it).
2. **Size: PASS.** 216,409,020 bytes (+42.6 KB on 4.6.67).
3. **Engine fingerprint: PASS** (in the build itself): `native/ether-audio.node built from this engine source
   (4c5e4ca6a1c3bd65)`; packaged engine `pe, engine source 4c5e4ca6a1c3bd65`; every app file the engine loads unpacked;
   HA helper present.
4. **Real launch, side by side: PASS.**
   - Packaged `win-unpacked\Ether.exe`, `ETHER_SMOKE=1`, `ETHER_SMOKE_FILL_STATION=2`, `--user-data-dir`, LOCALAPPDATA and
     APPDATA in `%TEMP%\ether-rc-4668`, on a stripped copy of this computer's database: sign-in, licence, account, Link,
     stream, cloud and AI keys removed with secure_delete (30 rows), sync off, no auth.bin, no JWT-shaped bytes in the file.
     Live Ether was not running.
   - `[SMOKE] fill station 2: queue 20 item(s) — first: Pink Elephants on Parade - From "Dumbo" — Disney Studio Chorus`;
     engine log `[engine s2] logreader refill: 20 pending from log (mode=behind, queue=20)`.
   - `[SMOKE] PASS — react_mounted=true root_children=1 renderer_error=false daemon_desired=true daemon_started=true
     daemon_log_staged=true station_count=5 air_isolated=true fill_station=2 queue=20 no_account=true`; exit 0 after 24 s.
   - **Master device carried over:** stations 3 (Magical Forest) and 4 (Christmas in Jully) have only the old
     `audio_output_device` setting. The engine opened it: `Station 3 audio output opened: "Speakers (2- Realtek(R) Audio)"
     ch 1-2`. The Patch Bay's own reader on the same copy: `station 3: source=legacy
     master=[{"device":"Speakers (2- Realtek(R) Audio)","pair":0}]` — the window shows that device until someone changes it.
     Stations 1 and 2 (already patched) were applied through the Patch Bay (`SetOutputPatch`).
   - No test process left; the temporary copy was deleted after the check.

## The relay, live

- Backend (Railway): `0d072b1` H5/M1, `86d79c2` desktop-activate, `8b01295` sessions, `c2d3e1f` relay tickets — deployed;
  health 200, existing sign-ins 200. `ETHER_RELAY_HOST=44.244.52.207` set; `ETHER_RELAY_SECRET` comes from the Lightsail
  install (made on the server, put into Railway by Jeff; never in chat). Until then the relay routes answer 503 and Links
  that use a typed address work as before.
- Tested on OVEVENTS with the relay running locally (`scripts/smoke-link-relay.js`): receiving through the relay, 0 lost,
  120 ms (the jitter buffer), 3 ms RTT; a forged ticket refused, none of its 159 packets forwarded.

## UNVERIFIED (first real use)

- Two real computers through the Lightsail relay; OV's network for outbound UDP 9790 (the echo test from OVEVENTS passed
  600/600).
- The Patch Bay inputs grid on real interface inputs; sign-in renewal across a real 15-minute pass on a running station.
