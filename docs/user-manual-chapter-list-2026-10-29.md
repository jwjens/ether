# Ether user manual — proposed chapter list (2026-10-29, for Jeff's approval)

**Jeff (verbatim):** "Write a full Ether user manual covering every feature in the current build, organized in chapters
with a table of contents. Write it from the actual code and screens, not from plan docs. Only document what is built
today; leave out anything planned or not built yet. Show me the chapter list first."

Built from the app's doors in the current tree (branch release/1019): the native menus (`electron/main.js:3658-3764`),
the ☰ menu (`src/App.tsx:2907+`), the bottom bar (`viewTabs`, DELAY, DUMP, IRIS) and the Settings tabs
(`src/components/SettingsPanel.tsx`). Each chapter will be written from that feature's code, and checked on screen where
a screen can be shown.

1. **Getting started** — installing, signing in to your account (first screen every launch), your stations, profiles
   (Administrator / Music Director / On-Air Jock) and the profile PIN, updating (close and reopen fully), signing out.
2. **The main screen** — layout, top bar (status, ON AIR), the ☰ menu, the bottom bar, pop-out windows (Monitors menu),
   window layout and Reset to Default.
3. **Decks and the board** — music decks A–F, Configure Decks, faders and their source choice, DUCK and per-channel
   controls, MONITOR, cueing (PFL), the Mic deck.
4. **Running the show** — AUTO and manual, the play queue / Up Next, loading and starting a deck, Esc, the broadcast
   delay (DELAY) and DUMP.
5. **Library** — importing music (Import Music, Import from Folder, Import Library), songs, artists and albums, the Cue
   Editor, the Clip Editor, the cloud music library.
6. **Categories, clocks and shows** — the CATEGORIES, CLOCKS and SHOWS tabs, Shows & Dayparts, rotation rules
   (Settings → Programming).
7. **The schedule and the Program Log** — Schedule Manager, Generate, the Program Log, editing an hour, Smart Scheduler,
   Rotation Analytics.
8. **Spots and promos** — the SPOTS tab, spot breaks in clocks.
9. **Imaging: sweepers, jingles and carts** — the SWEEPERS push-up (pools, assignments, Reel Splitter), the CARTS wall.
10. **Voice Tracker.**
11. **Announcements and the EAS Logbook.**
12. **Phone Desk** — the PHONE tab and its pop-out.
13. **Show+ and the Show+ DAW** — video/visual studio, and the production editor (import, chop, send to deck / jingle /
    sweeper / library).
14. **Streaming and going on air** — Stream Manager, ON AIR, Settings → Broadcast, the Processor (loudness ride and
    limiter), Patch Bay, Master Output, Settings → Audio and Audio Devices.
15. **Remote Link** — SEND TO, taking a remote broadcast from another Ether computer, Settings → Remote Link.
16. **The Park page** — Settings → Park Page, what a Park login can do.
17. **Jukebox** — Settings → Jukebox and the Jukebox window.
18. **Screens** — Ether Screens on other displays.
19. **Iris** — the assistant producer (IRIS button).
20. **Logs and reports** — the Play Log, Listener Analytics, the affidavit and royalty exports.
21. **Backups and keeping on air** — Backup & Restore, Cloud Log Backup, "Keep My Station On Air", the tray.
22. **Station settings** — Settings → Station, Integrations, Links, System, Station Manager.
23. **Health Monitor and System Health.**
24. **Keyboard shortcuts, Help and About** — Help → Keyboard Shortcuts, Check for Updates, About.

Not included unless Jeff says otherwise: the web dashboard (app.ether-cast.com), the listener page and the platform
console — separate products, not the Ether build.

Open while writing: a chapter whose feature turns out unbuilt or unreachable in this build is dropped and named in the
draft report, not written up.

## Jeff's answers (2026-10-30, verbatim)

"1. Include the web dashboard, the listener page and the platform console in the manual. For every feature in the
manual, note the plan tier needed to use it (Local, Station, Pro, Unlimited), taken from config/plans.json, not guessed.
2. Yes, describe profiles exactly as they work today, with no claimed restrictions. 3. Include e836590 in 4.6.69.
Before writing the draft: for every chapter, confirm the feature actually works in the current build. If a menu entry
opens a placeholder or an unfinished screen (check Iris, Screens and the Show+ DAW especially), drop that chapter and
list what you dropped."

Added chapters: 25 The web dashboard, 26 The listener page, 27 The platform console.

## Verification (static: traced door → component → working code; the app was not run)

- **Iris — DROPPED.** The IRIS button opens a chat panel for a separate Iris app (`src/components/IrisBadge.tsx:4-8`).
  The installer does not ship Iris (`electron-builder.json`, `package.json`: no Iris) and Ether never starts it (no
  spawn in `electron/`), so in an installed copy the panel can only say "offline"
  (`IrisBadge.tsx` send(): "I'm not connected right now…").
- **Show+ DAW — DROPPED.** "To Deck" (`src/components/StudioPro.tsx:4712`, `sendToDeck` :2981) renders the mix to a
  browser `blob:` URL and dispatches `ether:deck-load`, which nothing listens for (no listener in `src/` or `electron/`)
  — the send does nothing. Its discard warning (:1513) names Library and jingle/sweeper-pool exits that do not exist in
  the component. Export WAV / stems / session save-open are real, but the screen's main exit is unfinished.
- **Screens — KEPT (pending the chapter agent's full check).** ☰ → Screens opens the Screen Builder
  (`PopoutRenderer.tsx:220-222` → `ScreenSurface.tsx`): dockview layout, EDIT/LIVE, saved layouts.
- Remaining chapters: being traced chapter by chapter (agents), results to be added here.

## Queued: Part 3 — website (Jeff, 2026-10-30; starts after the manual is approved)

"The whole site at https://ether-technologies.com/ (Cloudflare) is outdated. Rebuild it to match Ether as it is today.
1. Use the approved manual as the source for features, and config/plans.json for plans and pricing: Local, Station,
Pro, Unlimited, the listener add-on, the 3+ station discount and annual billing. No free plan; every new account starts
with a 15-day trial, no card needed. 2. Include the signup page: replace the "free account" wording to match. 3. Show me
the page list first. After I approve it, build everything and show me screenshots of every page at desktop and phone
width before deploying. 4. Deploy only when I say go. Don't change anything else."
