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
