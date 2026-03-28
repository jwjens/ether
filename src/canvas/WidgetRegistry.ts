// ── Widget Registry ───────────────────────────────────────────
// Central definition of every widget available in Developer Mode.
// Each entry defines the widget's identity, sizing constraints,
// and what props it accepts from the canvas engine.

export type WidgetType =
  | "deck"
  | "queue"
  | "mic"
  | "clock"
  | "library"
  | "nowplaying"
  | "logo"
  | "history"
  | "cartwall"
  | "vumeter"
  | "social"
  | "scheduler"
  | "episode"
  | "remoteguest"
  | "export"
  | "shownotes";

export interface WidgetDefinition {
  type: WidgetType;
  label: string;
  description: string;
  icon: string; // SVG path data
  defaultW: number;   // grid units (1 unit = 60px)
  defaultH: number;
  minW: number;
  minH: number;
  maxW?: number;
  maxH?: number;
  allowMultiple: boolean;  // can user add more than one?
  category: "audio" | "library" | "broadcast" | "custom";
  proOnly: boolean;
}

export const WIDGET_REGISTRY: Record<WidgetType, WidgetDefinition> = {
  deck: {
    type: "deck",
    label: "Audio Deck",
    description: "A full playback deck with waveform, transport controls and VU meter.",
    icon: "M5 3l14 9-14 9V3z",
    defaultW: 6, defaultH: 7,
    minW: 4, minH: 5,
    allowMultiple: true,
    category: "audio",
    proOnly: false,
  },
  queue: {
    type: "queue",
    label: "Play Queue",
    description: "Drag-and-drop queue showing upcoming tracks.",
    icon: "M4 6h16M4 12h16M4 18h10",
    defaultW: 3, defaultH: 8,
    minW: 2, minH: 4,
    allowMultiple: false,
    category: "audio",
    proOnly: false,
  },
  mic: {
    type: "mic",
    label: "Mic Deck",
    description: "Live microphone control with level metering and cue.",
    icon: "M12 2a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10c0 3.866-3.134 7-7 7s-7-3.134-7-7M12 17v4M8 21h8",
    defaultW: 3, defaultH: 7,
    minW: 2, minH: 5,
    allowMultiple: false,
    category: "audio",
    proOnly: false,
  },
  clock: {
    type: "clock",
    label: "Program Clock",
    description: "Live hour clock showing where you are in the current hour.",
    icon: "M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zM12 6v6l4 2",
    defaultW: 3, defaultH: 5,
    minW: 2, minH: 3,
    allowMultiple: false,
    category: "broadcast",
    proOnly: false,
  },
  library: {
    type: "library",
    label: "Song Library",
    description: "Search, browse, and load songs from your music library.",
    icon: "M9 18V5l12-2v13M6 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    defaultW: 5, defaultH: 8,
    minW: 3, minH: 5,
    allowMultiple: false,
    category: "library",
    proOnly: false,
  },
  nowplaying: {
    type: "nowplaying",
    label: "Now Playing",
    description: "Large display showing the current track with album art.",
    icon: "M9 18V5l12-2v13",
    defaultW: 4, defaultH: 3,
    minW: 3, minH: 2,
    allowMultiple: false,
    category: "broadcast",
    proOnly: false,
  },
  logo: {
    type: "logo",
    label: "Station Logo",
    description: "Upload your station logo or brand mark.",
    icon: "M4 16l4.586-4.586a2 2 0 0 1 2.828 0L16 16m-2-2 1.586-1.586a2 2 0 0 1 2.828 0L20 14M6 20h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2z",
    defaultW: 2, defaultH: 2,
    minW: 1, minH: 1,
    maxW: 4, maxH: 4,
    allowMultiple: false,
    category: "custom",
    proOnly: false,
  },
  history: {
    type: "history",
    label: "Song History",
    description: "Scrollable log of recently played tracks with timestamps.",
    icon: "M12 8v4l3 3M3.05 11a9 9 0 1 0 .5-3M3 4v4h4",
    defaultW: 17, defaultH: 2,
    minW: 2, minH: 2,
    allowMultiple: false,
    category: "broadcast",
    proOnly: false,
  },
  cartwall: {
    type: "cartwall",
    label: "Cart Wall",
    description: "Hotkey pads for jingles, drops, and sound effects.",
    icon: "M4 5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5zM14 5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V5zM4 15a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-4zM14 15a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-4z",
    defaultW: 4, defaultH: 3,
    minW: 3, minH: 2,
    allowMultiple: false,
    category: "audio",
    proOnly: false,
  },
  vumeter: {
    type: "vumeter",
    label: "VU Meters",
    description: "Standalone audio level meters for all decks.",
    icon: "M9 19V6l2-3h2l2 3v13M4 19V9l3-3h2M19 19V9l-3-3h-2",
    defaultW: 2, defaultH: 5,
    minW: 1, minH: 3,
    allowMultiple: false,
    category: "audio",
    proOnly: true,
  },
  social: {
    type: "social",
    label: "Social Chat",
    description: "Embed a live chat from Discord, Twitch, or YouTube.",
    icon: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
    defaultW: 3, defaultH: 6,
    minW: 2, minH: 4,
    allowMultiple: true,
    category: "custom",
    proOnly: true,
  },
  episode: {
    type: "episode",
    label: "Episode Timeline",
    description: "Segment-by-segment episode planner with live timers.",
    icon: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
    defaultW: 4, defaultH: 7,
    minW: 3, minH: 5,
    allowMultiple: false,
    category: "broadcast",
    proOnly: false,
  },
  remoteguest: {
    type: "remoteguest",
    label: "Remote Guest",
    description: "Invite a guest via browser link — no app needed.",
    icon: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
    defaultW: 3, defaultH: 5,
    minW: 2, minH: 4,
    allowMultiple: false,
    category: "custom",
    proOnly: false,
  },
  export: {
    type: "export",
    label: "Export Episode",
    description: "One-click mix down to MP3 from your session.",
    icon: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
    defaultW: 3, defaultH: 6,
    minW: 2, minH: 4,
    allowMultiple: false,
    category: "broadcast",
    proOnly: false,
  },
  shownotes: {
    type: "shownotes",
    label: "AI Show Notes",
    description: "Generate show notes from your session with AI.",
    icon: "M12 2a10 10 0 1 0 10 10M12 8v4l3 3M18 2l4 4-4 4M22 6H18",
    defaultW: 3, defaultH: 6,
    minW: 2, minH: 4,
    allowMultiple: false,
    category: "custom",
    proOnly: true,
  },
  scheduler: {
    type: "scheduler",
    label: "Format Clock",
    description: "Mini format clock showing current show and upcoming segments.",
    icon: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
    defaultW: 3, defaultH: 4,
    minW: 2, minH: 3,
    allowMultiple: false,
    category: "broadcast",
    proOnly: true,
  },
};

// ── Widget instance (placed on canvas) ────────────────────────
export interface WidgetInstance {
  id: string;           // unique instance ID
  type: WidgetType;
  x: number;            // grid column
  y: number;            // grid row
  w: number;            // grid width
  h: number;            // grid height
  config: Record<string, any>; // widget-specific config (e.g. deckId, logoUrl)
  label?: string;       // custom label override
}

// ── Default layout — what new users start with ────────────────
export const DEFAULT_LAYOUT: WidgetInstance[] = [
  // Queue — left panel, full height
  { id: "queue-1",   type: "queue",   x: 0,  y: 0, w: 3,  h: 11, config: {} },
  // Deck A — large, on air deck
  { id: "deck-1",    type: "deck",    x: 3,  y: 0, w: 6,  h: 11, config: { deckSlot: "A" }, label: "Deck A" },
  // Mic — narrow center column
  { id: "mic-1",     type: "mic",     x: 9,  y: 0, w: 3,  h: 11, config: {} },
  // Deck B
  { id: "deck-2",    type: "deck",    x: 12, y: 0, w: 4,  h: 11, config: { deckSlot: "B" }, label: "Deck B" },
  // Deck C
  { id: "deck-3",    type: "deck",    x: 16, y: 0, w: 4,  h: 11, config: { deckSlot: "C" }, label: "Deck C" },
];

// ── Canvas grid config ────────────────────────────────────────
export const GRID_COLS = 20;
export const GRID_ROWS = 12;
export const CELL_SIZE = 60; // px per grid unit
