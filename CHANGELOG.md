## [4.0.0] — 2026-05-07

### Library Arc Close-Out

**Library panel rebuild**
- Three-track CSS Grid layout: frozen left (checkbox + # + Title), middle paged columns, frozen right action zone (A/B/C/Q/Cue/×)
- Action zone always visible on every row (no more hover-conditional rendering)
- Inline metadata column rendering restored (no longer behind modal)
- Per-station Title column drag-resize with localStorage persistence
- Comfortable default column widths per data type

**Column paging**
- Adaptive column packing: middle columns paginate when they don't fit the available width
- Prev/next arrows in header (◀ Page X / Y ▶) with disabled state at boundaries
- ResizeObserver-driven page recalculation; clamps current page on shrink
- Per-station page index persistence

**Three-slot top bar (ON AIR / NEXT / AFTER)**
- Replaces single-slot NowPlayingPill with three queue-position slots
- Reads queue[0..2] for content; deck A state for ON AIR countdown
- Channel-color dots (cyan/green/purple) per slot
- Amber color shift on remaining time below 15s

**Button visual feedback**
- A/B/C/Q/Cue/× action buttons get hover brightness lift and active-state press feedback
- CSS-only, no React re-render overhead

**Vocab management**
- Right-click context menu on vocab values replaces dangerous inline × button
- Explicit confirmation dialog before deletion
- Outside-click and Escape dismissal

**Engine performance**
- Engine poll interval relaxed from 100ms to 250ms
- Listener fire change-detection prevents redundant React state updates on idle decks
- `loadToDeck` fires listeners synchronously for instant React updates

**Keyboard**
- A key toggles automation on/off (input field guard prevents firing while typing)

### Known Issues / Parked

- `detect_song_cue_points` IPC handler missing — autoCueSong calls fail silently with ~200ms stall per click
- MacroEngine clock-trigger polling unindexed — ~150-565ms DB hits per check
- crash_recovery saveQueue writes ~370ms unthrottled
- Backend command endpoints (/api/cmd, /api/pending-cmds) have no authentication — must address before external pilot promotion
- RemoteCmd polls every 2s with 4s timeout — SSE migration planned

### Deferred

- Y1-take-2: deck-direct loads with on-air lock (proper discovery needed)
- Y3 polish: progress fill on ON AIR slot, marquee scroll on long titles in NEXT/AFTER
