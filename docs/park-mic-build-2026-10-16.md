# Park mic (Hold to talk): build scope + server Listen fix deployed (2026-10-16)

## Jeff (verbatim)

> Keep it simple. This build: finish only the Park mic (Hold to talk).
> - 2 Park mic input sources (Park Mic 1, Park Mic 2), listed under Mic with the other inputs. The user puts each on any fader; that fader's existing settings (MAIN/AUX, ON, stream) decide where it's heard. No new bus system.
> - On the phone, HOLD TO TALK lets staff pick which Park mic to talk on, shown by the user's names.
> - Everything else as approved: logged-in only, one talker per mic, studio lock, follows MUTE where it reaches the park, STOP in Ether, who/when shown, limiter, longest talk 20 s, echo cancellation and noise suppression ON, auto gain OFF.
> - No engine change unless it's unavoidable; if it is, tell me the risk first.
> Next build, not now: user-chosen Listen channels (Park mix plus any source the user marks, e.g. Source K for staff), with a picker on the phone.
> Deploy the server Listen fix (2e5840b) now. Installer path and sha256 when the mic is done.

(The fixed MAIN/AUX/STAFF bus plan, `fader-buses-plan-2026-10-16.md`, is scrapped by Jeff.)

## Server Listen fix: deployed

- **Before (11:23 AM PDT):**
  - station online, level 0.316, not muted, closing 21:30, 4 carts;
  - Listen ready, buffer 0;
  - writes without a login refused (403).
- **Rollback point:** local branch `rollback/server-listen-fix` = `afa6896` (`git push origin rollback/server-listen-fix:main`).
- **Pushed** `afa6896..2e5840b` to main. Railway deployment `0aa79e66` SUCCESS 11:24 AM.
- **After:**
  - `/health` → 200;
  - `/public/ops/halloween` → 200: level, MUTE, closing time, carts identical; Listen ready, buffer 0; writes without a
    login still 403.
  - The station showed offline for a moment after the restart (its connection to the server re-opening) and was back
    online by 11:25:24 AM.

## Park mic: what the engine has to change

**E1 is unavoidable.** Nothing in the engine can put audio from the network onto a fader:
- a fader's live inputs today are a sound-card input (Mic) or another Ether box over the Remote Link's sealed wire
  (`native/src/micin.rs`, `linknet.rs`);
- the phone's voice arrives through the relay, and only a program on the station (ffmpeg, as Listen does in reverse) can
  receive it.

The ways around it are worse:
- a virtual audio cable driver on the air machine (an install on the customer's box, outside Ether);
- forging Remote Link packets (couples to a sealed wire format that was never meant as an input).

**E1, as proposed in `park-hold-to-talk-engine-2026-10-16.md`:**
- one new input that takes PCM from a 127.0.0.1 port into the same live-feed ring the Mic uses;
- its own thread;
- the playing code (`LiveIn` in the callback) unchanged;
- off unless a fader's source is a Park mic.
- **Risk: low.** No mixing code changes, so the exact-match goldens can't move.
- Two inputs (Park Mic 1, Park Mic 2) are two instances of the same thing.

**Not needed any more:**
- **E3 (own duck):** the fader's existing DUCKS setting and the station's ducker decide.
- **L2 (true limiter):** the limiter is the fader's channel-rack compressor set as a limiter (L1, no engine change).

**Found while scoping: there is no per-fader stream switch today.**
- Every fader goes to the stream whenever it is up and ON (`audio.rs:4589`). Its MAIN/AUX setting only picks the local
  output.
- So with existing settings, a Park mic fader that is up and ON is on the stream too.
- **Local-only or staff-only (park, not stream)** would need a per-fader stream switch: the old E2, low–medium risk,
  in the mix loop. Not built unless Jeff asks.

## Built (2026-10-16): Jeff's OK on the engine input and the To stream switch

Jeff (verbatim):
> 1. OK: build the new engine input for Park Mic 1 and Park Mic 2.
> 2. Yes: add the per-fader "To stream" switch, visible on each fader, saved, starting ON so everything sounds exactly like today. That's how one Park mic goes on air and the other stays local. Every exact-match sound test must stay identical, and test that a fader with To stream OFF is heard in the park but not on the stream.
> Limiter via the fader's compressor is fine. Build it all into one installer, path and sha256.

**Installer:** `C:\openair\dist-electron\Ether Setup 4.6.59 park-mic fe8ce09c ee0ea16.exe`
- sha256 `fe8ce09cf47fdf974c9577ce0226e6d1f926101c05d12c022ffa416d1645463f`, 216,085,510 bytes, version 4.6.59 (not bumped).
- Engine native `c2372b8a…` / code `5dfdeeba…`.
- Release gate PASS (engine identity matches by sha256; log `dist-electron/gate-logs/2026-10-16T20-12-11-882Z PASS.log`).
- It contains everything since `76f29be1`: the Listen fix (b111628) and this build.

**Commits (local, nothing pushed or deployed):**
- openair `feat/park-talk`: `331e0ea` engine, `ee0ea16` Ether.
- ether-backend `feat/park-talk`: `f33c4f2` (on the deployed `2e5840b`).
- ether-park `feat/park-talk`: `2d7a204` (on `63c392e`, which also holds the approved `_headers` fix).

### Engine (native)
- **Park Mic 1/2** (`micin.rs`): a mic whose device is `park:<n>`. It uses the same patch command, the same live feed and
  the same `LiveIn` consumer as a sound-card mic.
  - The samples come from a 127.0.0.1 TCP port (mono f32le 48 kHz) on its own thread, never the audio thread.
  - NAPI: `audio_get_park_mic_port`, `audio_park_mic_state`. Mixing code untouched.
- **To stream** (`air_on` per fader; `SetToStream`, NAPI `audio_set_to_stream`; board JSON `stream`):
  - OFF skips the stream sums; the fader keeps its park feed, meter and DUCKS.
  - A MAIN fader OFF the stream makes the park mix build from the room sums: the same path an AUX deck already takes,
    because with no AUX deck the main speakers play the stream's own mix.
  - Every fader starts ON.

### Tests
- **New engine tests:**
  - To stream OFF on all 12 faders × MAIN/AUX: heard on its output, stream silent, back ON = on the stream.
  - An OFF fader still ducks: duck_gain 0.100, stream peak 0.0250 = the ducked music only, park 0.2750.
  - Park Mic port → fader D (4,800 of 4,800 samples), unpatched → nothing.
- **Exact-match goldens:**
  - Five golden tests **already fail on the untouched engine**, with identical numbers (the stored goldens are out of
    date; pre-existing, not fixed).
  - To prove "identical", goldens were re-recorded from the untouched engine (originals backed up). The build with these
    changes was compared against them: **43/43 renders bit-exact** in all four comparison tests.
  - The hard-coded aux checksum gives the same value as the untouched engine (13288168936620410458).
  - The original goldens were then restored, so nothing in the repo changed.
- **Full engine suite:** 153 passed, 5 failed (the pre-existing five above).
- **Desktop:** tsc 0, vitest 921/921, test:sync 55/55, test:wedge pass.
- **Server:** 128/128 (adds park-talk 5/5 and the station-scoped list), smoke-ops-core PASS.
- **Runtime, real engine on OVEVENTS** (quiet, MONITOR 0.03), a 440 Hz "voice" written into Park Mic 1's port like the
  receiver writes it:

  ```
  To stream ON  → park mix (Listen): 177200 samples, peak -42.5 dBFS   stream: 176314 samples, peak -12.0 dBFS
  To stream OFF → park mix (Listen): 177200 samples, peak -42.5 dBFS   stream: 177200 samples, peak silence (0)
  To stream ON  → park mix (Listen): 176314 samples, peak -42.5 dBFS   stream: 177200 samples, peak -12.0 dBFS
  mic state after the voice stopped: [{"slot":"D","state":"idle","reason":"nobody is talking"}]
  PASS
  ```
- **Park page on the local dev station:** busy ("Ryan is talking"), park-only mic + muted ("Park is muted. Unmute to be
  heard."), stream mic + muted ("only the stream hears you").
  - **Not exercised:** a real phone's microphone over WebRTC. That needs the relay path, the server and the Park page
    deployed.

### Before it works end to end (each needs Jeff's GO/OK)
1. **Relay:** MediaMTX must accept the talk paths `park/<station>/talk1` and `talk2` (a phone publishes over WebRTC, the
   station reads over RTSPS). Whether today's path rule already covers them is **UNVERIFIED**. Check: read the `paths:`
   section of `/etc/mediamtx/mediamtx.yml` (read-only).
2. **Deploy the server** `f33c4f2`.
3. **Deploy the Park page** `2d7a204` (with the `--assetsDir a2` method, after the park closes).
4. **Install** the installer on ovowforestmusic. Put Park Mic 1/2 on faders, set TO STREAM, names, and press "Put the
   limiter on".

### Not built / honest gaps
- No dedicated "Park talk" row in the Health Monitor. The health events go to the ledger, and the Park mic's state shows
  in the existing Mic inputs health.
- The delay, mouth to park speaker, is not measured yet. Measure at the first real talk.

## Relay path rule: checked read-only (2026-10-16, 1:30 PM PDT)

Read from `/etc/mediamtx/mediamtx.yml` on the stream server (Jeff OK, read-only, nothing changed):
```
paths:
  "~^park/[0-9a-f-]{36}$":
```
plus `rtspTransports: [tcp]`, `rtspsAddress: :8322`, `webrtcAddress: 127.0.0.1:8889`,
`webrtcAllowOrigins: ['https://park.ether-cast.com']`, `webrtcAdditionalHosts: [44.244.52.207]`.

- **The talk paths are NOT covered.** The only rule is `park/<36-char station id>` with nothing after it: Listen's path.
  `park/<station>/talk1` and `talk2` don't match, so the relay would answer "path is not configured" to the phone and
  to the station.
- **The fix (needs Jeff's OK; a change on the stream server):** one more rule under `paths:`, empty like the Listen one,
  so any publisher/reader that the auth check allows may use it:
  ```
    "~^park/[0-9a-f-]{36}/talk[12]$":
  ```
  MediaMTX reloads its config file by itself when it changes.
  - **UNVERIFIED:** that hot reload leaves Listen sessions in progress alone. Do it while nobody is listening.
- Everything else Hold to talk needs is already there: WebRTC through nginx `/park/…` (the WHIP address is
  `/park/<station>/talk<n>/whip`), RTSPS 8322 for the station, the Park page origin allowed, the public address
  advertised.

## Deployed now, park open (Jeff: "Do it now, don't wait for close") (2026-10-16)

**Server `f33c4f2`:**
- Rollback branch `rollback/server-park-talk` = `2e5840b` (`git push origin rollback/server-park-talk:main`).
- Pushed `2e5840b..f33c4f2`; Railway `433ca48b` SUCCESS 1:31 PM.
- **Before (1:30 PM):** level 0.316, not muted, closing 21:30, 4 carts, Listen ready, writes without a login 403.
- **After (1:32 PM):** `/health` 200, station back online. Same level, MUTE, closing time, carts and Listen ready; writes
  without a login 403. New `/talk` refuses without a login (403 "Log in to make changes.").
- Live page in a browser at 1:32 PM: fader −10.0 dB, MUTE, carts 1–4, closes 9:30 PM, 4 announcements.
- A server restart drops Listen tickets held in memory: a phone listening at 1:31 PM would have seen "Listening
  stopped. Press Listen again."

**Park page `2d7a204` (with the headers fix):**
- Rollback copy (the live page as it was: index + `a2/index-CmN86cCJ.js`, `a2/index-AjIQ3lZA.css`, `_redirects`):
  scratchpad `park-live-before-talk` (`npx wrangler pages deploy <that folder> --project-name ether-park --branch main`).
- Built with `--assetsDir a2`; the live files were added to the upload, so a phone holding the old page never fetches a
  missing file. Deployed `e53eb3af` 1:33:42–1:33:52 PM; live index switched by 1:33:58 PM.
- All three files serve 200 with the right types.
- **After (1:34 PM):** the live page runs `a2/index-p6DRQqZG.js`: fader −10.0 dB, MUTE, carts 1–4, closes 9:30 PM, 4
  announcements; the ops data is the same.
- **LISTEN and HOLD TO TALK show only to logged-in staff; not checked by Claude** (no staff login).
  - The server says Listen is ready.
  - Until ovowforestmusic runs the new build, HOLD TO TALK shows greyed "Hold to talk isn't set up on this station"
    (the station doesn't report Park mics yet).
- **Found: the headers fix doesn't fully take.**
  - The files come back `cache-control: public, max-age=14400, must-revalidate`. The `must-revalidate` from `_headers`
    is there, but `max-age` is still 4 hours.
  - Most likely Cloudflare's zone "Browser Cache TTL" setting overrides it (UNVERIFIED, a Cloudflare dashboard setting).
  - It didn't matter this time, because the old files stayed in the upload.

**Relay: not changed.** The talk paths are not covered (above); the one-line rule waits for Jeff's OK.
