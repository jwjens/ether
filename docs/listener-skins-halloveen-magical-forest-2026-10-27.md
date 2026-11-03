# Listener: real full screen + HalloVeen "Slightly Spooky Radio" (2026-10-27) — LOCAL, NOT DEPLOYED

## Jeff's asks (verbatim)
- "The full-screen icon must put the page into the browser's real full screen (the Fullscreen API on the whole page),
  which hides the browser bar, not just a view drawn over the page. Tapping it again or pressing Esc exits. Do this on
  the standard page, so every station page gets it, skins included. On iPhone Safari, where the browser doesn't allow
  it, the page works from "Add to Home Screen" with no browser bar. Test it in a real browser window, not headless.
  Don't deploy until I say so. On the HalloVeen page, the title in marquee-bulb lettering reads "HalloVeen at the
  Magical Forest", and under it in lime green drip lettering, "Slightly Spooky Radio"."
- "fullscreen means actual full screen with no browser bar and everything fits on one screen"
- On a screenshot of the live HalloVeen page: "no your chaning it keep itlike this just fullscreen and add radio"
- On the skin attempt: "no stop yoru doing the hub that way too they are not all halloween stations"

## Abandoned along the way (nothing of it remains)
- A "skin over the standard page" rebuild (`src/skins/`) — Jeff: keep the live page as it is. Deleted.
- The uncommitted bottom-bar-on-scenes WIP — discarded with it.

## What changed (ether-listener working tree, uncommitted)
- `src/scenes/` restored to HEAD (= what is live), then only:
  - `FullscreenButton.tsx` (new): top-right corner icon on both scene pages; toggles the PAGE ITSELF into the browser's
    real full screen and back. Not shown where the browser has no page full screen (iPhone Safari) or when opened
    from the home screen (already bar-less).
  - `SpookyFunhouse.tsx`: title "HalloVeen at the Magical Forest", drip line "Slightly Spooky Radio" (exact wording;
    the Bungee bulb font draws capitals, as the live title already did).
  - `spooky-funhouse.css`, `santas-radio.css`: the icon's style; sizes follow the screen height so the page fits one
    screen; the sunburst rays are clipped so they never make the page scroll; Magical Forest's large empty bottom
    margin reduced.
- `src/App.tsx`: scene pages get `pageFullscreen` + `togglePageFullscreen` (Fullscreen API on `<html>`, webkit
  fallback, follows `fullscreenchange`, Esc exits). The standard page's full-screen also gets the webkit fallback.
- `src/styles.css` (standard page, every station):
  - phones: the full-screen icon now stays in the bottom bar's corner (it was hidden with the volume slider < 640px);
  - phones: the full-screen view's top row no longer pushes the exit icon off the right edge (pre-existing bug — on a
    phone there was no visible way out of full screen).

## Runtime receipts — real headed Edge window, real input events (CDP Input.dispatch*), not headless
Reported by the browser itself (`document.fullscreenElement`, window vs screen size):

| page | size | tap icon | tap again | tap + Esc | fits one screen |
|---|---|---|---|---|---|
| /halloween (scene) | desktop 1920×1080 screen | HTML, 1920×1080 | out | out | 1080/1080 |
| /halloween (scene) | phone 390×780 | HTML | out | out | 780/780 |
| /magical-forest (scene) | desktop | HTML, 1920×1080 | out | out | 1080/1080 |
| /magical-forest (scene) | phone | HTML | out | out | 780/780 |
| /christmas-in-july (standard) | desktop | HTML + view | out (exit icon) | out | 828/828 |
| /christmas-in-july (standard) | phone | HTML + view | out (exit icon) | out | 576/576 |

Whole-screen grabs: `C:\Users\jensj\AppData\Local\Temp\shotpage\rw3-*-2-fullscreen.png` (no browser bar);
page captures `rw3-*-page.png`. Layout fit (headless measure): both scenes fit at 360×740, 390×844, 412×915,
1366×768, 1440×900; a 360×640 screen is ~20px over.

## UNVERIFIED
- **iPhone**: Safari gives web pages no full screen, so the icon is hidden there. "Add to Home Screen" opens bar-less
  via the per-station manifest (`functions/__manifest/[slug].ts`, `display: standalone`) + `apple-mobile-web-app-capable`.
  Not tested on an iPhone from here — the check: add /halloween to an iPhone home screen and open it.
- Android Chrome on a real phone (the desktop window emulated phone size).

## Typecheck
`tsc --noEmit`: 2 errors, both pre-existing on HEAD (App.tsx `station` `undefined` vs `null` on PlayerBar/Fullscreen).

## Deployed (2026-10-27) — Jeff: "deploy"
- Committed locally on ether-listener `main` as `3e09edd` (not pushed). Cherry-picked onto the live `c66c1aa` →
  `7067d8d` (local branch `deployed/fullscreen-2026-10-27`); built in a separate worktree with its own `npm ci`.
  `3a2d95f` (jukebox "knows which phone it is") is still NOT live.
- Production deployment `https://07e96956.ether-listener.pages.dev`. Live bundle `assets/index-BvWx_PMu.js` on
  `/halloween`, `/magical-forest`, `/christmas-in-july` (was `index-BErIcEVD.js`); the live bundle contains
  "HalloVeen at the Magical Forest", "Slightly Spooky Radio", "Exit full screen".
- Live receipt (real headed Edge, phone size, https://listen.ether-cast.com/halloween): tap icon → fullscreenElement
  HTML, fits 780/780; tap again → out; tap + Esc → out.
- Nothing pushed to GitHub.
