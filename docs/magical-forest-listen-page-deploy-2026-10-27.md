# Magical Forest listen-live page — deployed (2026-10-27)

**Jeff:** "Build the Magical Forest station's listen-live page in ether-listener. It is always Christmas, styled like
Santa's radio station … Show me screenshots at phone size and desktop size before deploying. Don't deploy until I say so."
Then: "deploy the magical forest page".

- Page: `https://listen.ether-cast.com/magical-forest` (ether-listener `src/scenes/SantasRadio.tsx`, `santas-radio.css`,
  `src/scenes/index.ts`; `src/App.tsx` renders the scene for that slug only).
- Deployed 2026-10-27 ~23:40Z: Cloudflare Pages project `ether-listener`, production, deployment
  `https://6d62f295.ether-listener.pages.dev`. Live bundle `assets/index-CISlGW04.js` (it was `index-BHRsI7hS.js`).
- Screenshots: phone and desktop before deploy, and phone live after, in `C:\Users\jensj\AppData\Local\Temp\shotpage\`
  (`mf-phone.png`, `mf-desktop.png`, `mf-phone-reduced.png`, `halloween-phone.png`, `mf-live-phone.png`).

## How this site actually deploys (the memory note said "git push" — it is not)

- Production deployments are **direct uploads** (`wrangler pages deploy`), each tagged with a local commit hash. The
  GitHub repo's `main` is behind: before this deploy, 13 local commits were never pushed, and production was `e43d8fa`.
- Local `main` also has `3a2d95f` ("the request page knows which phone it is"), which was **not live**. To ship only
  what was asked, this deploy was built from `e43d8fa` plus the Magical Forest commit alone (`05bb6ae`, kept as local
  branch `deployed/magical-forest-2026-10-27`). `3a2d95f` is still not live.
- Nothing was pushed to GitHub.

## Second deploy — HalloVeen funhouse page + "Broadcasting from Santa's Cabin" (2026-10-27)

**Jeff:** "Build the HalloVeen station's listen-live page in ether-listener, always Halloween, in the style of a slightly
spooky carnival funhouse …" and "change to broadcasting from santas cabin". Then: "deploy".

- Built from the live `05bb6ae` with only `d4614c9` (Santa's Cabin) and `a55dc46` (HalloVeen funhouse) cherry-picked on
  top, giving `c66c1aa` (kept as local branch `deployed/halloveen-2026-10-27`). `3a2d95f` is still not live.
- Production deployment `https://c6f838f3.ether-listener.pages.dev`. Live bundle `assets/index-BErIcEVD.js` on
  `/halloween`, `/magical-forest` and `/christmas-in-july`.
- Screenshots: `hv-phone.png`, `hv-desktop.png` and `hv-phone-reduced.png` before the deploy; `hv-live-phone.png` live,
  with the real "Thriller" cover in the frame. All in `C:\Users\jensj\AppData\Local\Temp\shotpage\`.
- The clear spot above the frame (`data-slot="mascot"`) is reserved for Hal & Hally.
