# Help audit and the Operator Manual (2026-09-27)

**Ask (verbatim):** "The manual: help audit and assembly. No code."

**Result:**
- all 41 help docs audited against the current source (`log-reader-flip`, package 4.6.50) and corrected **doc-only**;
- the manual assembled: **`docs/manual-ethercast.md`**, 10 chapters, 41 topics, ~40,000 words.

**No code, config or test was changed.** The code problems the audit found are listed below for Jeff.

## Method

- **Three read-only audits,** ~14 docs each. Each claim was checked against the code: every door (menu, button, label,
  Preferences section), every checkable value, and every link.
  - Every problem cites file:line.
  - A claim only the running app can settle is marked UNVERIFIED, not guessed.
- **Three fix passes** applied the findings to the help docs only.
- **Verified after:**
  - 41/41 docs carry the full frontmatter (feature, title, summary, where, since, audience, tour);
  - no broken `docs/help-*.md` links;
  - no jingle→sweeper doubled wording ("Sweepers & Sweepers", "sweeper or sweeper");
  - only `docs/help-*.md` changed.
- **The manual** is assembled from the help files by a one-off script. The help files stay the source of truth; the
  manual says "edit the help file and re-assemble".
  - Every topic shows its **Where** and **Since**.
  - Cross-references become in-manual links (GitHub anchor rule; 0 dangling).

## What the audit found in the docs (≈145 findings, all fixed)

**Wrong doors.** The help pointed at a menu or setting that isn't there:
- **Health Monitor:** it is Tools → System Health, not "Menu → Tools → Health Monitor".
- **Designated generator:** Health Monitor → Library & Rotation.
- **Factory reset:** Settings → System.
- **Jukebox:** ☰ → Jukebox; the Windows section is gone.
- **Segue overlap:** File → Preferences → Audio.
- **Traffic:** ☰ → Play Log.
- **Rotation goals:** the health dot / System Health.
- **Announcements:** the Schedule menu.
- **Deck ON:** "Settings → Playout" doesn't exist.
- **Deleting songs:** "whole-library delete" doesn't exist.

**Features described wrongly:**
- **Multi-machine sync:** the doc said it was manual-only. It runs continuously once *Keep my stuff synced* is on;
  PUSH/PULL NOW are overrides.
- **The X-key manual crossfade:** removed 2026-09-07, still documented.
- **Show presets:** the processor-rack doc said "not in this version"; they have shipped.
- **Sweepers:**
  - written for the retired JIN/SWP split;
  - its on-air indicator section described a badge that became the Up Next sweeper row;
  - the arm window is ~90 s, not ~30 s.
- **Reel Splitter:** wrong output path, a class choice that no longer exists, a wrong threshold range.
- **Backup and restore:** status wording and buttons out of date; said audio goes up "as it changes" (it goes up when
  you send it).
- **Audio processing:** "GAIN REDUCTION" is RIDE GAIN.
- **Channel EQ:** CLEAR RACK removes Gate and Comp too.
- **Channel faders:** which channels remember their ON/OFF.

**Rename damage.** The jingle→sweeper find-and-replace had left doubled wording in about ten docs, including the
house template's own title.

**Stale history and `since:`:**
- version-history sections that now mislead were removed;
- six docs had no frontmatter at all;
- several `since:` values were slice names, not versions. They are now the first release tag containing the feature.
  The DSP slices after `ad12300` say `unreleased (log-reader-flip, after 4.6.50)`.

## Code defects for Jeff (not fixed — "no code")

**On air**
- **Pop-out MASTER fader is not wired to the engine.** It only sets display state and resets to 1.0 on open.
  `BroadcastMonitor.tsx:381,533,587` (compare `MasterOutput.tsx:598-601`).
- **Space and B start/pause decks directly,** outside the ON button and the daemon's serialized path.
  `App.tsx:1899-1918`.
- **The shortcut list is stale:** "X Crossfade" (removed) and "Esc Stop all decks" (Esc never kills audio).
  `KeyboardHelp.tsx:23-25`, `App.tsx:3242-3243`.
- **No crossfade-time control exists in Settings,** though the engine uses `crossfadeDuration`. `engine.js:1222`,
  `SettingsPanel.tsx:29-37`.

**Library, logs, exports**
- **Library Delete may never run in the packaged app.** It asks with `window.confirm`, which the code's own comments
  say no-ops in this Electron build. `App.tsx:5741,5351`; comment `main.js:1265`. **UNVERIFIED — one right-click →
  Delete on an installed build settles it.**
- **BMI/ASCAP exports write a fixed duration on every row** ("3:30" / "3.5"). `Logs.tsx:306,312`.
- **BMI, ASCAP and PDF exports read the on-screen list, capped at 200 rows,** whatever the period. `Logs.tsx:110,304,310,351`.
- **A renamed song probably keeps its old title in already-filled Program Log rows** (rows carry their own title).
  `main.js:9811`. UNVERIFIED.

**Imaging, spots, sweepers**
- **Edit Spot has no cart / ISCI fields.** They can only come from Import Traffic CSV, which writes the same value
  into both. `Spots.tsx:536-608,321`.
- **Deck / Up Next "Mark as Spot" skips the category dialog and creates no spots record,** so a break can't pull it.
  `songActions.tsx:134`.
- **AUTO-POST can't be switched on from the app.** The engine reads `overlay_chain_type`; nothing writes it.
  `main.js:9475`.
- **The sweeper pool LEAD-IN box is never read,** and the "UNDERLAP s" header has no column. `SweepersPanel.tsx:337-356`.
- **SweepersPanel imports InlineNameEditor but never renders it.** No sweeper rename in the push-up.
  `SweepersPanel.tsx:22`.
- **"Set up sweepers →" affordance is dead:** props passed, never used. `App.tsx:3076-3077,3881-3882`.
- **No sweeper armed/firing sense in the Health Monitor.**
- **The Schedule Manager pane is still titled "Jingles."** `layoutStore.ts:35`.
- **The Spots empty state still says "Import jingles…".** `Spots.tsx:619`.

**Rotation, generation**
- **Per-row pick reasons are recorded but shown nowhere.** `RotationAnalytics.tsx:233-235`.
- **The per-station AUTO ON (auto-generate) toggle only exists inside the "Log-Reader Flip — Canary" panel.**
  `HealthMonitor.tsx:1811-1829`.
- **The designation bypass (`kill_designation`) has no door in the app.**

**Accounts, backup, navigation**
- **A failed profile migration is only written to the console;** `profile:list` is never called. `main.js:233-237,6303-6309`.
- **The backup screen contradicts itself:** "both directions" vs "audio goes up only when you press Send just the
  audio". `SettingsPanel.tsx:3638` vs `3735-3736`.
- **The ☰ menu has no Health Monitor or Announcements entry.** Native menus only. `App.tsx:2929-2945`.
- **The in-app HelpPanel's Schedule Manager text is stale.** `HelpPanel.tsx:285`.

**Engine ids shown to operators (breaks one-name-per-fader)**
- **The Wild meter picker shows "S1 … S5".** `MasterMeters.tsx:18-21`.
- **Preferences → Mic Inputs row labels show "S1 · …".** `MicInputsSettings.tsx:30,63`.

**Show+ DAW**
- **G toggles snap instead of selecting Grab.** `StudioPro.tsx:1766-1770`.
- **C splices instead of selecting Splice** (the tooltip says "Splice (C)"). `StudioPro.tsx:1812-1815,3988`.

## Runtime checks only the running app can settle

1. **Library right-click → Delete** on an installed build: does the confirmation appear, and is the song deleted?
2. **The pop-out Master Out:** drag MASTER and watch PGM. Does the on-air level move?
3. **Rename a song that is in today's filled Program Log:** does the row's title change?
4. **Move MONITOR in the pop-out:** does the docked MONITOR follow?
5. **A trial lapsing while Ether is open:** which screen appears?

## Files

- **Changed:** 41 × `docs/help-*.md` (600 insertions, 437 deletions).
- **New:** `docs/manual-ethercast.md` (assembled) and this audit.
