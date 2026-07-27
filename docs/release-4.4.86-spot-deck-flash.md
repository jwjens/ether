# v4.4.86 — SPOT deck flash (amber, content_class-driven)

**Artifact:** `C:\openair\dist-electron\Ether Setup 4.4.86.exe` (`--publish never`). Supersedes the un-installed
4.4.85 — carries 4.4.83→85 (spot truth, break sense, anchor-fit, clean edges, real duration, import fix) + this.
STOP before install.

## What
A deck holding a SPOT (commercial/promo) gets an **amber/gold (#fbbf24) pulsing frame** from the moment it
loads until it finishes airing — readable across the room. **Songs never flash.** Distinct from the jingle
third-row indicator (white/yellow line). Dies when the spot ends and music resumes.

## Wiring — off the `content_class` the decks already carry (since 4.4.84)
- **Daemon path** (`audiod/engine.js`): the deck event now carries `contentClass` from the authoritative
  per-deck class map (`deckContentClass`, set at `loadToDeck`) — `_maybeEmitDeck` emits it in `state`.
- **Renderer** (`src/audio/engine-rodio.ts`): `DeckState.contentClass` + `makeState` read it (daemon path);
  the **in-process path** keeps a `deckContentClass` map (set in `loadToDeck`, threaded from the queue item)
  and overlays it in `poll()` since the native state carries no class. Both playout paths covered.
- **UI** (`src/components/UpNext.tsx`): each A/B/C deck card computes
  `isSpotDeck = contentClass === 'SPOT' && hasTrack && status !== 'ended'` and renders an amber inset-border +
  faint wash overlay animated by the new `spot-deck-flash` keyframe (opacity pulse). The flash ends the moment
  the deck's status goes `ended`.

## Architecture compliance
- **Honest UI:** the flash reflects the deck's observed `content_class`, never a guess — same class the
  clean-edges seam guards (4.4.85) and the queue gold-chip (4.4.84) read. One class, three consistent cues.
- **content_class isolation:** SPOT is carried on the existing rails; the jingle indicator (its own JIN/SWP
  white/yellow third row) is untouched and visually distinct.

## Gates
- `node --check audiod/engine.js` OK. `tsc` — 3 pre-existing errors (App/OnboardingFlow/PhoneDesk), zero in
  touched files. Leak-guard baseline 14 holds. Renderer + signed installer built.
- Help: `docs/help-spots.md` — amber deck flash noted.

## Live verify (post-install)
On a station with a break: when the spot loads onto a deck, that deck card pulses amber; songs on the other
decks do not; the amber stops when the spot finishes and music takes the deck. Works whether the daemon or the
in-process engine is driving.
