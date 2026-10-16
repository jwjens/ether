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

## Relay talk-path rule added (2026-10-16, 1:41 PM PDT, Jeff GO)

Jeff (verbatim): "GO: add the talk-path line to /etc/mediamtx/mediamtx.yml. Back up the file first. Do it now; if anyone
is on Listen they may need to press Listen again. After the reload, confirm Listen still works and the relay accepts the
talk paths. Rollback = restore the backup. Change nothing else on that server."

- **Backup:** `/etc/mediamtx/mediamtx.yml.bak-20261016-park-talk` (`cp -p`, identical sha256 `d2eb3894a2f111d9…`).
- **The change:** one line appended after the Listen rule. `diff backup new`:
  ```
  38a39
  >   "~^park/[0-9a-f-]{36}/talk[12]$":
  ```
  Owner and mode unchanged (`-rw-r----- root mediamtx`).
- **Reload:** `INF reloading configuration (file changed)` at 20:41:32 UTC. Same process (started 2026-10-13 12:11:36
  UTC, not restarted), service active, no ERR/WAR lines.
- **Probe without credentials, before → after** (scratchpad `relay-paths-probe.js`):

  | Path | Before | After |
  |---|---|---|
  | `park/<halloVeen>` (Listen) | WHEP 401 "authentication error" · RTSPS 401 | the same |
  | `park/<halloVeen>/talk1` | WHIP 400 "not configured" · RTSPS 400 | WHIP 401 "authentication error" · RTSPS 401 |
  | `park/<halloVeen>/talk2` | the same 400s | the same 401s as talk1 |
  | `park/<halloVeen>/talk3` | 400 | still 400 (only talk1/talk2 allowed) |

  401 = the path is accepted and the relay asked the server's auth check, which refused (no ticket). The relay log shows
  "failed to authenticate: server replied with code 401", so the relay → server auth link works, with the secret.
- **Listen:** its path answers exactly as before the change.
  - No real Listen session was running at the reload (the relay log has none since 19:00 UTC).
  - **UNVERIFIED** with a real phone: Claude has no staff login. Check: tap LISTEN on the Park page.
- **Rollback:** `sudo cp -p /etc/mediamtx/mediamtx.yml.bak-20261016-park-talk /etc/mediamtx/mediamtx.yml` (it reloads by
  itself).

## "Put the limiter on fader S1 does nothing" (2026-10-16, fixed for the next installer)

Jeff (verbatim): "On ovowforestmusic (fe8ce09c), Preferences → Park page — Hold to talk: clicking 'Put the limiter on
fader S1' does nothing. No change, no message. Find why and fix it for the next installer. The button must either apply
the limiter and show 'Limiter on fader S1: −6 dB, 20:1', or say why it can't."

**What the code in fe8ce09c did (read, plus one engine check):**
- **The answer went to the foot of the panel.** The button's result, success or refusal, was written to the panel's one
  message line, under the help text at the bottom of the section, out of sight of the button.
- **An open rack window never re-reads.** `useChannelRack` reads a fader's rack once when the view opens. A rack written
  from elsewhere doesn't appear there, and that window's next edit re-sends the old rack and overwrites the limiter.
  The EQ lamp re-reads; the rack view didn't.
- **The engine accepts the button's exact rack.** Checked here: `audioSetChannelRack(…, "S1", <empty rack + comp -6 dB
  20:1 1 ms 100 ms knee 0>)` → `{"ok":true}`.
- **UNVERIFIED** which of the two Jeff met on ovowforestmusic: the button may have saved the limiter while the S1 rack
  window kept showing the old rack, or it was refused and said so out of sight. Both are fixed.

**Fix (`316e975`, in the next installer):**
- The answer appears **right under that Park mic**, with the button disabled while it works:
  - success: "Limiter on fader S1: −6 dB, 20:1 (attack 1 ms, release 100 ms). It is the COMP in fader S1's rack.";
  - otherwise: "Not put on: <why>" (no station, not on a fader, numbers not set, rack unreadable, the engine's reason, or
    what the rack reads back instead).
- After the write it **reads the rack back** and checks the compressor is there, IN, with those numbers
  (`src/lib/parkLimiter.ts`, tested).
- Open rack windows and the EQ lamp re-read a rack written elsewhere. A view in the middle of its own edit keeps its edit.
- vitest 924/924, tsc 0.

**By hand meanwhile** (fader S1's rack → COMP): Threshold −6 dB, Ratio 20 (20:1), Attack 1 ms, Release 100 ms, Knee 0 dB,
Makeup 0 dB, module IN. Knee and Makeup are the two that could be left wrong: a new COMP starts at Knee 6 dB.

## Installer ac24be72: buttons cleaned up, limiter removed, board letters (2026-10-16, 2:34 PM)

Jeff (verbatim): "Stop the output merge plan. Don't change any routing or outputs. … Keep only: 1. The Park mic source on
faders (already built). 2. The fader-name fix (board letters only, everywhere). 3. Remove the special Park mic limiter:
no limiter settings and no 'Put the limiter on' button in the Park mic preferences. The Park mic fader uses its own
processor like every other fader, and nothing is applied automatically or baked in. 4. The button cleanup, display only,
no routing change: decks A, B, C show no buttons; other faders show only DUCK; a Park mic fader shows DUCK and MAIN (lit
= also on air). Remove TO STREAM and MAIN/AUX from view. Build that into one installer. Path and sha256."

(The output-merge plan, `fader-buttons-simplify-plan-2026-10-16.md`, is stopped by Jeff. Nothing of it was built.)

**Installer:** `C:\openair\dist-electron\Ether Setup 4.6.59 park-mic-buttons ac24be72 139544c.exe`
- sha256 `ac24be7225a089eb04537dddac3116cebaff2e4bc2e69d3555ed7b841fd1bbcf`, 216,087,410 bytes, version 4.6.59.
- Engine unchanged from fe8ce09c (native `c2372b8a…` / code `5dfdeeba…`).
- Release gate PASS (log `gate-logs/2026-10-16T21-34-58-930Z PASS.log`).

**What changed since fe8ce09c (commit `139544c`, plus `6f8ad1b` for the names):**
- **Strip buttons, display only** (`FaderRouting.tsx`):
  - A/B/C show no buttons; every other fader shows DUCK; a fader whose input is a Park mic also shows MAIN (its on-air
    setting).
  - MAIN/AUX, DUCKED and TO STREAM are hidden. Their saved settings are untouched and still applied as before.
- **No Park mic limiter:**
  - the limiter settings, their starting values (no longer written when a Park mic is first patched), the button and its
    rack writer (`src/lib/parkLimiter.ts`) are removed;
  - the rack-window change made for that button (`useChannelRack.ts`) is reverted to its earlier state.
- **Board letters:** the Park mic Preferences card says "On fader G · park and on air (MAIN lit)". No engine slot name
  appears in any screen this work touched; the Mic inputs list already used board letters.
- **Help updated:** `help-channel-faders.md` (the buttons), `help-park-hold-to-talk.md` (MAIN/DUCK, no limiter).
- tsc 0, vitest 921/921, sync 55, wedge pass.

**Left as it was (noted):**
- Limiter values written by fe8ce09c into ovowforestmusic's Preferences (`park_talk_limit_*`) stay in its database but
  are no longer read or shown.
- A compressor set by hand on fader G stays in G's rack.
- The Park page still says "park + stream" / "only the stream hears you". Its wording would change with a page deploy;
  not touched.
- A TO STREAM set OFF on a non-Park-mic fader under fe8ce09c would now be hidden (it can't be seen to turn it back on).
  UNVERIFIED whether any was set; check on ovowforestmusic: each fader's settings are in its saved `fader_stream` row.

## Installer 0cd997f4 (To stream reset) + Park page wording deployed (2026-10-16, 2:42–2:44 PM)

Jeff (verbatim): "1. On update, set TO STREAM back to ON for every fader that isn't a Park mic, so nothing hidden can keep
a fader off the program. Log any fader it changes. Put it in this installer (rebuild, new path and sha256). 2. Park page
wording: replace 'park + stream' / 'only the stream hears you' with 'Park + on air (MAIN)' / 'Park only'. GO to deploy that
page change now, keeping the old files in place like last time, and confirm fader, MUTE, carts, LISTEN and HOLD TO TALK
still work."

**Installer:** `C:\openair\dist-electron\Ether Setup 4.6.59 park-mic-buttons-stream-reset 0cd997f4 21c7a76.exe`
- sha256 `0cd997f4c3caaf3b7ba4c938d88c1a7ca84e80ad24a7d424858c91c34b81cc43`, 216,088,053 bytes.
- Engine unchanged. Release gate PASS (`gate-logs/2026-10-16T21-44-31-766Z PASS.log`).
- **`21c7a76`:** only a Park mic fader can be off the program.
  - `readSavedBoard` reads a saved OFF as ON on any fader that isn't a Park mic (this machine's `mic_input_<slot>` =
    `park:<n>`). That holds at the update and later too, e.g. when a Park mic is unpatched.
  - The startup step "Fader routing" (`streamReset`) removes those saved OFFs and logs each fader by its board name:
    startup log "[board sN] To stream was OFF on fader(s) … set back ON", and the health event `fader-to-stream-reset`.
  - Tests: board-state 30/30 (non-Park OFF reads ON; a sound-card mic isn't a Park mic; a Park mic keeps OFF; the
    cleanup runs once). vitest 922/922, tsc 0, sync 55, wedge pass.

**Park page `3f9e9a8`, deployed `6ad10646` at 2:41:56 PM:**
- Wording: "· Park + on air (MAIN)", "· Park only". When muted with MAIN lit: "· Park is muted — on air only (MAIN)".
  The literal "Park only" there would have said the opposite of what happens.
- Rollback copy: scratchpad `park-live-before-wording`. The old files stayed in the upload; all three serve 200.
- Live at 2:42:13 PM on `a2/index-D52LCHZL.js`: closing 9:30 PM, announcements, carts 1–4, fader −10.0 dB shown.
- **The station was offline** before the deploy: last report 2:39:44 PM (Jeff: "becasue we are offline"). So the fader
  and MUTE (greyed "Station offline"), LISTEN and HOLD TO TALK could not be checked working. They need the station back
  online and a staff login.

## First real talk, the delay, and cutting it (2026-10-16, 3:07 PM)

- **Relay log, 3:07:22 PM:** the phone published Park Mic 1 over WebRTC (`remote candidate: prflx/udp/…`, so UDP
  8189), and the station read it 0.2 s later over RTSPS/TCP 8322. The talk lasted 3 s. Listen sessions also connected
  over UDP 8189.
- **Delay, by ear (Jeff):** "i said delay check and my voice came through the speaker right as i finished saying check"
  → about 0.7 s, mouth to park speaker. An estimate, not a measurement.
- **Earlier the same afternoon:** "the hold to talk button flickers it does not work … nothing changes" (iPhone Chrome).
  No talk reached the server or the relay. A few minutes later, without any change deployed: "for some reason its
  working now". A sturdier page is written but not deployed: the microphone is turned on by a tap first, a hold is
  tracked page-wide, and every early end says why.
- **Measured here:** the receiver's ffmpeg writing to a local port held up to **256 ms** and sent it in one lump without
  `-flush_packets 1`; with it, the largest lump was 85 ms (scratchpad `ffmpeg-chunk-test.js`).
- **Done (`talk.js`):** `-flush_packets 1`, `-max_delay 0`, `-reorder_queue_size 0`; the bundled ffmpeg accepts them.
- **Proposed, waiting for Jeff's OK (an engine change, Park mic code only):**
  - read the port in 10 ms pieces, so a lump can't raise the input target (`in_block_max` only ever grows);
  - drop backlog above about 30 ms at once (today up to 100 ms lingers and drains at ±0.3 %).
  - Risk: low. The mixing and the other inputs are not touched.
  - Cost: on a bad connection the voice skips a fragment instead of falling behind. Jeff: "we wont use weak phones".
