# Four builds (proposed, not built) and every other dead control found (2026-10-30)

**Jeff (verbatim):** "Build these so they actually work: Tools → Stream Manager (real start/stop and real status);
Stream Metadata Outputs; Remote Access & Website; The voice-tracking mic picker (saved and used). For each one, show me
what it will do before building it. Any other dead control or placeholder you find: list it for me to decide. Don't
hide or remove anything."

Evidence is static (code read, file:line). Found while verifying the manual chapters.

## A. Tools → Stream Manager — today
The screen calls `stream_start` / `stream_status` / `stream_health`, which are stubs (`electron/main.js:8621-8642`,
"Streaming stubs (Icecast client to be implemented)"): Start sets a flag, the status and uptime are invented, and its
fields write an old `stream_settings` row the real stream never reads. The real stream is the ON AIR button →
`stream:go-live` / `stream:stop-live` (main.js:13471/13529), configured per station (server, mount, password, bitrate in
Station Manager; server also in Settings → Broadcast).

**Proposed:** Stream Manager becomes the full view of that same real stream, for the active station.
1. Shows and edits the active station's real stream settings (server, mount, password, bitrate) — the same fields
   Station Manager and Settings → Broadcast use, so there is one set of settings, not two.
2. START / STOP = exactly what ON AIR does (same go-live / stop-live). The ON AIR button and Stream Manager always agree.
3. Real status from the encoder: OFF AIR / CONNECTING / ON AIR / the error text if it failed or dropped; time on air
   since it connected; and the listener count read from the Icecast server's own status page for that mount.
4. The three stub handlers are pointed at the real stream (they no longer invent anything).
Not included: song titles to Icecast (that is B).

## B. Stream Metadata Outputs — today
Settings → Broadcast → Stream Metadata Outputs calls `window.ether.metadata.*`, which preload does not expose; the
engine for it (`electron/metadata-dispatcher.js`: Icecast, Shoutcast, TuneIn, RDS, webhook) exists but is never
installed (`installMetadataDispatcher` is never called), and its table `stream_metadata_targets` is not in the schema.
The real stream sends no song titles at all (`audiod/stream.js`).

**Proposed:**
1. A per-station list of outputs on this computer (new local table, schema step with the usual migration checks; not
   synced — an RDS encoder's serial port belongs to one computer).
2. Add / edit / delete / enable each output; types: Icecast (song title on your mount — also covers Ether's hosted
   stream), Shoutcast, TuneIn AIR, webhook (POST of title/artist to any URL), RDS encoder on a serial port.
3. Every time a song starts on that station, Ether sends "Artist – Title" to each enabled output at once; each row shows
   its last result (OK / the error) and when it last sent. A **Test** button sends the current song now.
4. Runs in the main process, so it keeps sending with no window open.
Decisions for Jeff: **RDS** needs the `serialport` package added to the app (not installed today) — include RDS, or ship
the other four first? The dispatcher's old one-time "seed from stream_settings" would create a surprise output from a
stale row — proposed: leave it out.

## C. Remote Access & Website — today
Shows `http://<this computer's IP>:4242` and `/now-playing.json`; nothing in Ether listens on port 4242
(SettingsPanel.tsx:3330-3345, NowPlayingSettings.tsx:38).

**Proposed:** Ether runs a small web server on port 4242 on this computer's network while it is open.
1. `/now-playing.json` — title, artist, playing yes/no, station name, time; open to any page (CORS), read-only.
2. `/` — the phone remote: open on a phone or tablet on the same Wi-Fi. It shows now playing and Up Next, and offers
   the controls you choose (proposed: Skip, Stop all, AUTO on/off — the same commands the web dashboard remote sends).
   Because anyone on the Wi-Fi could open it, the phone asks once for a 6-digit code shown in this Settings section.
3. Windows will ask once to allow Ether on the network (firewall) the first time it starts.
**Honest limit for Jeff:** a public website on the internet cannot reach a computer's local address, so
`/now-playing.json` only helps a page viewed on the same network. For a public website the working route is the
listener page / embed (chapter 26). Proposed: keep this section's text truthful about that (say "on your network").
Decision for Jeff: which controls the phone remote offers.

## D. Voice-tracking microphone picker — today
Clicking a mic only changes the screen (SettingsPanel.tsx:3185 `setCurrentInput`); it is never saved, and Voice Tracker
records from App's `inputDevice` (App.tsx:3215, never set from Settings) in the main window, and from the default mic in
its pop-out (PopoutRenderer.tsx:200 passes nothing).

**Proposed:**
1. The choice is saved on this computer (like the phone and cue pickers next to it).
2. Voice Tracker records from it — in the main window and in its pop-out.
3. If that mic is unplugged, Voice Tracker records from the default mic and says so on its screen.

## Every other dead control or placeholder found (for Jeff to decide — nothing hidden or removed)
1. **Show+ DAW — Export WAV, Export stems, Save session:** call `fs:writeFile`, which has no handler — nothing is written
   (StudioPro.tsx:2695-2887; preload.js:324; no `ipcMain.handle("fs:writeFile")`).
2. **Health Monitor → DMCA Play Log Export → Export Play Log CSV:** same missing `fs:writeFile`; downloads a file saying
   "Play log export failed" (HealthMonitor.tsx:833-860).
3. **Voice Tracker → Send to Deck A/B/C:** dispatches `ether:deck-load`, which nothing listens for (VoiceTracker.tsx:750)
   — same defect the Show+ DAW had.
4. **Phone Desk:** CART send target dispatches `ether:phone-clip` with no listener (PhoneDesk.tsx:761/795); the
   "SIP / WEBRTC URL" field is saved but never used (:399/1074); device list call `get_audio_devices` has no handler
   (falls back to the browser list, which works).
5. **Show+:** TELEPROMPTER, LOWER THIRDS and BRAND never reach the picture or stream (ShowPlus.tsx:2821-2828); AI Smart
   Cut lights indicators but never switches (:1662-1747); ⏮ CLIP likely unplayable after 30 s (drops the WebM header,
   :262-267); Mic Vol only changes self-monitoring (:1962-1999); the lower "+ Screen" share is not an engine source
   (:1663-1667).
6. **Imaging window → RULES tab:** says "Nothing is configured, and bans are not built yet" (ImagingPanel.tsx:280).
7. **Tools → Cloud Log Backup:** "Description (optional)" is never sent (CloudBackup.tsx:263-281); "Auto-backup daily
   at midnight" saves a setting nothing reads (:357); Saved Backups "↩ Restore" is refused by the synced-table guard
   (:316-321, main.js:7688-7699); the screen still says "Studio plan / Network plan" (:546).
8. **Settings → Pair Mobile App (Ether2Go):** preload has no `v2g`; `electron/mobile-app.js` (the phone page) is never
   loaded — Generate fails, device list always empty.
9. **Station Manager → Duplicate:** disabled, tooltip "coming soon" (StationManager.tsx:262-266).
10. **Settings → Beta Program & Feedback:** its backend routes `/beta/apply` and `/feedback` do not exist; also offers
    "free Station-tier access forever" (BetaProgram.tsx).
11. **Settings → Audio → Loudness Normalization:** measurements are written but nothing in playout reads them; says
    "Target is -14 LUFS" while the real loudness target is elsewhere; shows "Done! Analyzed [object Object] songs"
    (SettingsPanel.tsx:3424-3457, 3040).
12. **Master Out → Station → "Stream" row:** always "—" (MasterOutput.tsx:841).
13. **Station Manager → Format:** the stream is always MP3 whatever is chosen (StationManager.tsx:358; audiod/stream.js:98).
14. **Settings → Broadcast → Audio Processing "Target loudness":** ignored once a processor rack has been saved
    (audiod/rack-seed.js:49-58).
15. **Remote Link → SRT→UDP fallback:** disabled in this build (RemoteLinkSettings.tsx:268-271).
16. **Settings → Jukebox → Donations:** says guests can't donate yet; no guest donation step.
17. **On-air deck artist photos:** fetched through `http://localhost:4242`, which nothing serves (OnAirDeck.tsx:142-143).
18. **Web dashboard:** Users page says "Remote user management is coming in a later update" (UserManagement.tsx:27);
    "Clone programming from granted library" can't be reached (CategoriesPanel.tsx:116, staged mode never on).
19. **Listener page:** left rail menu is an empty placeholder ("menu TBD", ether-listener App.tsx ~485).
20. **Bugs found (not dead):** EAS Logbook date/time box shifts times by the UTC offset on default and on every edit
    (EASLogbook.tsx:321/339/346) — matters for an FCC record. Stream port is always 8000, so a server address with its
    own port (e.g. :8443) builds a wrong address (main.js:13502; audiod/stream.js:83). Old plan names (Studio/Network/
    Operator) still shown in the dashboard header, Cloud Log Backup, and the platform Accounts list.
21. **Plan gates in the desktop use the old tiers** (Listener Analytics `requires="pro"`, Station Manager
    `requires="station"`) and do not line up with plans.json (Listener Analytics is local data).

### Added from the getting-started / main-screen / decks / shortcuts check
22. **Settings → Users & Security → Delete and Remove PIN:** run behind `window.confirm`, which does nothing in the
    installed app (SettingsPanel.tsx:4172, 4191; main.js:1823). (Change PIN with both boxes empty does remove a PIN.)
23. **View → Deck A / Deck B / Deck C / Mic Deck:** toggle settings nothing reads; only Play Queue works (App.tsx:3812, 4144).
24. **Board source "Announcement":** says "nothing fires yet" (sourceKinds.ts:27); **"Network"** source disabled (:60);
    Configure Decks **Purpose** is saved but never read (DeckConfigurator.tsx:376); **Guest** deck meter can never move
    (no `ether:guest-level` sender) and its ON reaches only an open Show+ window (FaderSection.tsx:283-293).
25. **AUTO with nothing scheduled in the next 2 hours** asks through `window.confirm` (App.tsx:2455) — likely never shown
    in the installed app, so AUTO falls back to MANUAL. UNVERIFIED (press AUTO on a station with an empty log).
26. **Up Next:** empty text "Drag carts here or use GEN LOG" names a button and a drag that don't exist (UpNext.tsx:534);
    right-click Play Next / Move Up / Move Down / Move to Bottom and drag-reorder change only the in-memory queue, which is
    rebuilt from the log every 2 s, so they likely snap back (audiod/engine.js:2169, 2285-2301). UNVERIFIED.
27. **Keyboard shortcuts:** Shift+/ opens two overlays at once (KeyboardHelp.tsx and App.tsx:3295); both list keys that
    don't exist (N, F1–F4, F10, "F12 = help" — F12 is DevTools); G is labelled "Program Log" but opens the Play Log;
    A, S and G also fire carts 17, 18 and 21 when the CARTS push-up is open.
28. **Help → Check for Updates:** no message when already up to date; after "Later" the card never returns that session
    (Updater.tsx:26-41, App.tsx:3355).
29. **About:** says "free, open-source" (AboutPanel.tsx:202); **What's New** is a stale hard-coded changelog ("1.5.2
    March 2026", :15-50, :177).
30. **View → Reload (Ctrl+R) returns to the sign-in screen** mid-session (reload does not set the keep-session marker;
    main.js:3681 vs 4690) — conflicts with "never signed out while running". UNVERIFIED.
31. **New station → Solo / Standard / Live Radio** says it "sets your default deck layout" but nothing uses it
    (App.tsx:1031). The onboarding "placement" step is never reached.
32. **Station switcher hidden below desktop rank "station"** (ActiveStationBadge.tsx:76, 178): a catalog **Pro** license
    (key `pro`, desktop rank 1) would not see it, though Pro is above Station in plans.json.

### Added from the library / scheduling / spots check
33. **Tools → Smart Scheduler — whole screen does not affect scheduling (chapter section dropped):** its AI button calls
    the AI service with no key (SmartScheduler.tsx:30-60); rules save to this window's storage only, the database write
    is marked "intentionally broken … deferred" (:203-217); the generator never reads them.
34. **Categories → "⏱ Scan Durations":** calls `get_file_duration`, which has no handler — every song comes back
    "failed" (CategoriesTab.tsx:64); the clock preview uses the same call silently (ClocksTab.tsx:328).
35. **Clock row CHAIN STP/SEG:** saved, never read by Generate (ClocksTab.tsx:471; generate-core.js:116).
36. **Rotation rules:** STRICT/SOFT and "Max songs in a row from same category" are never read by the scheduler
    (scheduler-core.js:173-184); the retired gender rule may still show (SettingsPanel.tsx:2842 has no deleted filter).
37. **Create Show wizard:** picking an existing music category is not saved (CreateShowWizard.tsx:179-191).
38. **Program Log → ⚙ Shows & Dayparts → delete:** calls a function that does not exist (`shows['delete-by-id']`,
    ProgramLog.tsx:1558) — the click fails; editing a show there drops its start/end minutes (:1532-1538).
39. **Library → "Import from Spotify" and "NexGen / ENCO":** create songs with no audio (main.js:10935-10960;
    NexGenImport.tsx:120); the way to attach files later was removed (preload.js:290).
40. **Library → Normalize:** a failed analysis silently writes gain −14 dB (main.js:8644-8647) — a hidden
    sound-affecting default.
41. **Cue Editor key hints [I] [N] [O] [U]:** shown but only Space works (TrackEditor.tsx:620-633).
42. **Spots:** Import Traffic CSV makes spots with no audio, which never air, and there is no way to attach audio to an
    existing spot; "⚠ WON'T AIR" flags spots with no category, but "Any spot" breaks still pick them (Spots.tsx ~661 vs
    generate-core.js:45-50).
43. **Every delete/confirm behind `window.confirm`** (library bulk "Assign category…", category Delete, show Del,
    spot and spot-category Delete, Users & Security Delete/Remove PIN, AUTO with an empty log): Ether's own code says
    `window.confirm` does nothing in the installed app (main.js:1823, ConfirmDialog.tsx:1). UNVERIFIED — one check
    settles all of them: in an installed build, right-click a spot → Delete.
44. **Program Log → PDF Report:** locked to the old "Studio" tier (ProgramLog.tsx ~869-880); not a plans.json feature.
