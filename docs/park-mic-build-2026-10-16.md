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
