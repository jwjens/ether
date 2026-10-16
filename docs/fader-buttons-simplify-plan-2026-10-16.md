# Fader buttons simplified: plan, mock and the "nothing silent, nothing doubled" guarantee (2026-10-16)

Nothing is built. Mock: https://claude.ai/artifact/C2UFN6noriNvTLrjDhyLdU (scratchpad `duck-buttons-mock.html`).

## Jeff (verbatim)

> Simplify the fader buttons. My rules:
> 1. Every fader always plays out of the monitors (the local park speakers). Remove the MAIN/AUX buttons from every fader. No fader picks an output.
> 2. Remove "TO STREAM" everywhere. "Stream" means our internet live stream, and we don't broadcast live in the park, so the term is wrong here.
> 3. Decks A, B and C: no buttons at all (no MAIN/AUX, DUCKS, DUCKED, TO STREAM).
> 4. Source faders (announcements, jukebox, carts, sweepers, everything from D on): only one button, DUCK. Lit = this fader dips the music while it plays. No DUCKED button anywhere.
> 5. Only a fader whose source is a Park mic gets one extra button labeled MAIN. Lit = the voice also goes to the main program (on air). Not lit = park speakers only.
> 6. Duck amounts stay visible in Preferences → Ducker.
> Safety before building: today some faders play out of a separate AUX sound device. Check what the AUX output is set to on halloVeen. When the update arrives on any machine, everything must still come out of the speakers the park hears now: nothing goes silent and nothing doubles. Tell me in plain words how you'll guarantee that. Show me an updated mock of the strips first. No build until I approve.

## The AUX output on halloVeen

- **On OVEVENTS' copy (read-only):** main output `Speakers (2- Realtek(R) Audio)` (written 2026-09-25), AUX output the
  same device (2026-09-27).
  - Faders: A/B/C on MAIN; D, E, F, G (S1), H (S2), S3 on AUX, with AUX rows D 1.31, E 1.53, F 2.01, G 0.74, H 1.0.
- **On ovowforestmusic: UNKNOWN from here.**
  - Device settings stay on each machine: they're not in the cloud mirror and not in its health report.
  - Check: on ovowforestmusic, Preferences → Audio → the output device, and Master Out → AUX monitors → OUTPUT.

## What changes underneath (engine settings that already exist; no new engine code)

| Setting per fader | Today | After the update |
|---|---|---|
| Local output | MAIN or AUX (button) | always the main output (the park speakers); the AUX output is no longer used |
| Local level | MAIN: room level · AUX: its AUX row | the room level = the old AUX row for a fader that was on AUX, so it plays exactly as loud |
| Ducks the music | DUCKS (button, every fader) | A/B/C: off · D on: DUCK (button) |
| Ducked by others | DUCKED (button) | A/B/C: always · D on: never |
| On the main program | TO STREAM (button) | A/B/C and every source: on, as today (announcement audio stays on air, Jeff 2026-10-15) · a Park mic: MAIN (button) |

## The guarantee, per machine, at the update (before anything is switched)

Ether reads that machine's own two output settings for each station, then:

1. **Main and AUX are the same device** (as on OVEVENTS' copy):
   - The AUX faders move onto the main output at exactly their AUX row level, and the AUX output is closed.
   - Same speakers, same level per fader.
   - Each fader is then on one output only, so nothing can double.
2. **Main and AUX are different devices:**
   - Ether **changes nothing on that station**. It keeps today's routing, and Ether shows one question: "This station
     plays out of two outputs, <main> and <AUX>. Which one feeds the park speakers?"
   - Only after that answer does it move everything to that one output. Nothing goes silent while the question is
     open.
3. **AUX output is NONE:** today the AUX faders are silent in the park.
   - Moving them to the main output would make them audible: new sound, not doubling. This is Jeff's call; until then,
     treat it like case 2 (ask, change nothing).
4. **"Process local output" ON:** the AUX sum was processed (ride + limiter) on its own. Merged, it's processed together
   with the music. Levels stay; the limiter acts on the combined sound. Small difference, noted.

**Receipts:**
- Every move is written to the startup log and the Health ledger, per fader with its old and new output and level.
- An engine test renders the same faders before (AUX on the same device) and after (merged) and compares the speaker
  feed.
- Listen's park mix is the same sound before and after (it already sums main + AUX).

## Questions for Jeff
- Main + AUX on different devices (case 2): ask once in Ether as above? (recommended)
- AUX output NONE (case 3): should those faders start playing in the park?
- Other sources (announcements, carts, jukebox, sweepers): on the main program exactly as today, with no button?
  Recommended, because "Announcement audio stays on the stream as now".
