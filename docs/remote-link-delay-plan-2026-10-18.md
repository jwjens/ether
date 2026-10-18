# Remote Link: laptop mic to the park speakers is seconds late — where SEND FEED taps, every buffer, the plan (2026-10-18)

**Type:** read-only, plan only. Nothing built; ovowforestmusic not touched.
**Jeff's report (verbatim, the defect):**
- "Focusrite mic on the laptop → the laptop's Ether board → SEND FEED (Remote Link, Opus/UDP) → Link fader on
  ovowforestmusic → the Bose. I heard my voice seconds later. TAP TO TALK is not involved."
- Same day: "there should be no backed in profanity delay we will press the ramp button when we need it or whatever that
  button is called to create the delay."

**Code read:** `C:\openair` at 6558e57's engine. `native/` and the link/mic code are unchanged since 6558e57 on every
branch (`git diff 6558e57 HEAD -- native audiod/link.js` is empty), so this is the code on ovowforestmusic, build 1278bdeb
per `docs/playout-change-audit-2026-10-17.md:17`.
**Not verified:** the laptop's build, and what is on ovowforestmusic today. Both are a look at Help → About.

## In plain words
- **SEND FEED taps the laptop's board early.** It takes the board's programme mix after the faders, the master EQ and the
  master fader, and BEFORE anything that delays audio:
  - before the loudness processing and the limiter's look-ahead;
  - before the stream buffer;
  - before the profanity delay;
  - before the monitor / room output.

  **The tap is not after any delay**, so moving the tap is not the fix.
- **Every buffer from the Focusrite to the Bose has a hard limit.** With default settings the whole path is about a
  quarter to half a second. With every setting turned to its maximum it is about 2 seconds. No buffer on this path can
  grow to "seconds" and stay there.
- **So the seconds come from one of four places, and one reading on each machine says which:**
  1. **The Bose itself.** A Bluetooth speaker adds ~0.2–0.3 s; a Wi-Fi/AirPlay/cast speaker adds about 2 s. That alone is "a
     few seconds". This is the first thing to check.
  2. **A setting turned up on ovowforestmusic's Link fader:** the jitter buffer, 20–1000 ms, normally 120.
  3. **The laptop mic's queue grown.** It sizes itself to the largest block the Focusrite driver has ever delivered and
     never shrinks back. That is up to +0.5 s, and it is a real defect (below).
  4. **The voice reached the park another way:** the laptop also on air and something in the park playing the stream,
     which is ~17 s behind.
- **The profanity delay is not built in.** The engine starts with none; only the **DELAY** button in the top bar arms
  it, and only on the stream. Two things break your rule: the 8 s is fixed in code, and the button can show OFF while the
  engine is still delaying (below).

## 1. Where SEND FEED taps the laptop's audio (receipts)
The laptop's mixer, in order, inside its output callback (`native/src/audio.rs`):

| Stage | Where | Before or after the tap |
|---|---|---|
| Faders, ducking, the air sum | `audio.rs:~4780-4840` | before |
| Master EQ | `audio.rs:~4855-4865` | before |
| Master fader (`master_vol`, ramped) | `audio.rs:4864-4884` | before |
| **PGM meter + REMOTE LINK SEND TAP** | **`audio.rs:4887` (meter), `audio.rs:4890` `if let Some(ref mut t) = bus.link_tap { t.push(out_l, out_r); }`** | **the tap** |
| Loudness processing + −1 dBTP limiter (look-ahead) | `audio.rs:~4903-4955` (`run_branch`, `program_processor.rs:114, 442`) | **after** |
| Stream encoder ring / Icecast writer | `audio.rs:~5280-5340` | **after** |
| Broadcast (profanity) delay FIFO | the stream writer thread, `audio.rs:5342-5420` ("Broadcast-delay FIFO") | **after**, and on the stream only |
| Monitor / room / AUX output, PFL | `audio.rs:~5037-5280` | **after** |

- **The comment at the tap** (`audio.rs:4888-4889`) records the design ruling: "before this station's processing, so the
  station it feeds processes once." The tap exists only while SEND TO is on (`audio.rs:989`; installed and removed by
  `RtCmd::LinkTap`, `:1223-1225`).
- **What the tap carries is the WHOLE board's programme.** Every fader that is up on the laptop goes out: decks, carts,
  the Focusrite mic. That is the choice in §3.

## 2. Every buffer, Focusrite to Bose

### On the laptop
| # | Buffer | Default | Maximum | Receipt |
|---|---|---|---|---|
| L1 | **Focusrite input device buffer** (cpal/WASAPI) | the driver's default block (WASAPI shared ≈ 10 ms) | the driver's choice | `micin.rs:821` `BufferSize::Default` |
| L2 | **Mic input queue (the ring)** | target = one output pull + **the largest input block ever seen** + 2 ms | ring 0.5 s; anything above target + 100 ms is dropped | `micin.rs:43` (0.5 s), `:55` (100 ms), `:257-260` (target), `:266-275` (drop), `:424` `in_block_max.fetch_max` |
| L3 | **The board mix** | none: computed inside the laptop's output callback, one block (the laptop's output device buffer ≈ 10 ms) | the output device's block | `audio.rs:3122-3143` (mixer in the callback) |
| L4 | **Send tap ring** | drained every ~5 ms, whole (the sender pops the entire ring each pass) | 0.5 s; if full, the newest block is dropped, never queued | `linknet.rs:33-34`, `:78-86`, `:332`, `:348`, `:395-398` |
| L5 | **Resample 44.1 → 48 kHz + Opus encode** | 20 ms frames + ~7.6 ms codec delay | the same | `link.rs:27-29`, `linknet.rs:51`, `:349-369` |
| L6 | **UDP send** | none: `send_to` direct, no relay, no TCP | — | `linknet.rs:313-320`; `docs/help-remote-link.md:131-132` |

**L2 is a real defect.** The mic queue's target includes the largest block the input driver has ever delivered,
and that value only grows (`fetch_max`, `micin.rs:424`; reset only when the input is re-opened, `:767, :823`). One large
block — a driver hiccup, a USB stall, Windows handing over a lump after the laptop was busy — permanently deepens the mic's
delay, up to the 0.5 s ring. The Park mic code already notes the same hazard (`micin.rs:76-77`: "in_block_max only ever
grows").

### Network
| # | Hop | Default | Maximum |
|---|---|---|---|
| N1 | Internet / LAN, UDP 9760 direct (a router port-forward at OV) | the path's one-way time (LAN: ms; internet: tens of ms) | no queue; a lost packet is lost, not waited for |

### On ovowforestmusic
| # | Buffer | Default | Maximum | Receipt |
|---|---|---|---|---|
| R1 | **Jitter buffer** (the Link fader's buffer setting) | **120 ms** | **1000 ms** (range 20–1000); anything above target + 10 frames (200 ms) is dropped | `link.rs:35, 39, 357`; `link.rs:~459-470` (stale drop) |
| R2 | **Decoded live ring** | topped up to ≈ 22 ms (one pull + one 10 ms push block + 2 ms) | 0.25 s ring; anything above target + 100 ms is dropped | `linknet.rs:36-39, 709-741`; `micin.rs:338-345` (`pull_link`) |
| R3 | Drift control | steers R1 + R2 together to the jitter target; drops nothing | ±0.3 % rate | `micin.rs:331-337, 45` |
| R4 | **The board mix + processing** | in OV's output callback; the limiter's look-ahead is a few ms on the processed branch | the same | `audio.rs:3122-3143`; `program_processor.rs:442-443` |
| R5 | **OV output device** (the Bose's output) | the device's buffer (WASAPI ≈ 10–30 ms) | the AUX/room path is capped at 0.125 s | `audio.rs:2909` |
| R6 | **The Bose itself** | cable/USB: ~0; **Bluetooth: ~0.2–0.3 s; Wi-Fi/AirPlay/cast: ~2 s** | outside Ether | — |
| R7 | **Sound across the park** | ~0.3 s per 100 m | outside Ether | — |

### Totals
- **Defaults:** ≈ 10 + 15 + 10 + 5 + 28 + (network) + 120 + 22 + 20 ms ≈ **0.25 s**. A cleaner measured box-to-box figure is
  120–142 ms with a 20 ms buffer (`docs/remote-link-design-2026-09-28.md:179-186, 339`).
- **Every Ether setting at its maximum, plus the L2 defect at its worst:** ≈ 0.5 (laptop queue) + 1.0 + 0.2 (jitter
  buffer at max) + 0.12 + 0.1 ≈ **2 s**.
- **"A few seconds" beyond that cannot come from this path inside Ether.** It is the Bose (R6), the distance (R7), or a
  different path (the stream). UNVERIFIED until the readings below.

**The one reading that settles it:**
- **On ovowforestmusic,** the Link fader's strip shows the delay the link measures on the audio itself, from the
  laptop's tap to OV's mix: "LINK · <laptop> · NNN ms" (`linknet.rs:951`, "(index out − index in) IS the delay through
  the link").
- **If the strip says ~150–300 ms while you hear seconds,** the seconds are after Ether: the Bose or the distance.
- **If the strip says seconds,** it is R1 or L2, and the strip names which (jitter target in Preferences; the laptop's
  Mic Inputs panel shows its buffer `buf X/Y ms`).

## 3. The plan (build nothing until GO)

### 3a. The tap stays where it is
It is already before every delay. Moving it would change nothing you heard.

### 3b. Fix the mic queue that only grows (L2)
- **Today:** the target is the largest input block since the input opened.
- **Fix:** the target follows the input blocks of the last few seconds, so one lump raises it for that moment and it then
  comes back down, never below what the current blocks need. It drains by dropping backlog, never by playing it late.
- **One rule for every mic input:** the board's mic, the Park mic and the Link receive ring, which shares the code. Not a
  copy per input.
- **Test:** feed one 400 ms lump into a running input. Today the delay stays +400 ms for good; after the fix it is back
  within ~25 ms within a few seconds, with no audible step.

### 3c. Make the link's delay visible and loud
- **The measured end-to-end delay** (the strip's NNN ms) is shown on BOTH machines, not only on the receiver's strip.
- **A health alert** on the one alert stream, kind `link-delay`, when the measured delay is above a setting. Proposed
  starting value: 500 ms. You set the number.
- **The jitter buffer setting is shown next to the measured delay,** so a buffer turned up is seen at once.

### 3d. Whole board or a source you choose: both laid out, your decision
- **A. The whole board (today).**
  - The laptop's programme goes out: every fader that is up, mixed, after the master fader.
  - Good: the remote operator mixes a whole show (mic + music + carts) on the laptop, and OV receives exactly what the
    laptop's PGM meter shows.
  - Risk: anything left up on the laptop goes to the park (a deck, a cart, a ringtone through a source channel). The
    laptop's master fader and EQ are in the path.
- **B. One source you choose.**
  - SEND FEED picks one fader on the laptop (e.g. the Focusrite mic) and sends only that.
  - Good: nothing else can leak. It is also the shortest path: no board mix block, no master stage.
  - Cost: the engine needs a tap per channel instead of one on the programme, and a choice of whether the tap is before or
    after that channel's fader, EQ and dynamics. The laptop can then not send a mixed show.
- **C. Both, chosen per send:** "Send: the whole board / one source: [Focusrite mic ▾]". The same link and receiver; only
  the tap point differs. This is the most work and the most flexible.
- Either way the receiver is unchanged: a Link fader on OV, under OV's MONITOR (the standing rule).

### 3e. The profanity delay: nothing built in, the button is the only way (your rule)
- **Already true:** the engine starts at no delay (`audio.rs:292` `target_samples: 0`). The only caller that arms it is
  the **DELAY** button in the top bar (`App.tsx:799-803`, the one `setBroadcastDelay` caller; button at `App.tsx:3527-3535`).
  Once armed, the cushion builds up gradually: the "ramp" (memory: auto-rebuild, quiet-gated). It sits on the stream only
  (§1).
- **Two things that break your rule, to fix:**
  1. **The 8 seconds is fixed in code** (`App.tsx:790` `const DELAY_SEC = 8`). It becomes a visible setting with 8 s shown
     as its starting value (the no-hidden-defaults rule).
  2. **The button's ON/OFF lives only in the window** (`App.tsx:791` `useState(false)`), but the audio engine keeps
     running when the window restarts (memory: the daemon never reloads on auto-update). After an app restart the stream
     can still be 8 s behind while the button shows OFF. **Fix:** the button shows the engine's own state
     (`broadcastDelayState`, `main.js:6539-6541`), read when the window opens and kept current. A health line says when the
     delay is on.

## What I need from you
1. **During one talk, on ovowforestmusic:** a screenshot of the Link fader's strip (the NNN ms), and the jitter buffer
   value (Preferences → Remote Link).
2. **On the laptop:** Health Monitor → Mic Inputs for the Focusrite (the `buf X/Y ms` and `inBlock`).
3. **How the Bose is connected to ovowforestmusic:** cable, USB, Bluetooth or Wi-Fi/AirPlay/cast.
4. **Whole board, one source, or both (§3d)?**
5. **GO on 3b, 3c and 3e** (and the alert's number in 3c).
6. Help → About on both machines.
