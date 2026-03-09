// src/store/index.ts
// All Zustand stores exported from one place.

import { create } from 'zustand';
import type { SongView, Category, AppSettings, EntryStatus } from '../types/models';

// ============================================================
// UI STORE — active panel, modals, layout
// ============================================================

export type AppPanel =
  | 'live'
  | 'library'
  | 'clock-builder'
  | 'log-builder'
  | 'spots'
  | 'settings';

export type AutomationMode = 'automation' | 'manual' | 'assist';

interface UIState {
  activePanel: AppPanel;
  automationMode: AutomationMode;
  onAir: boolean;
  stationName: string;
  sidebarCollapsed: boolean;
  activeModal: string | null;

  setPanel: (panel: AppPanel) => void;
  setAutomationMode: (mode: AutomationMode) => void;
  setOnAir: (val: boolean) => void;
  setStationName: (name: string) => void;
  toggleSidebar: () => void;
  openModal: (id: string) => void;
  closeModal: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  activePanel: 'live',
  automationMode: 'manual',
  onAir: false,
  stationName: 'My Station',
  sidebarCollapsed: false,
  activeModal: null,

  setPanel: (panel) => set({ activePanel: panel }),
  setAutomationMode: (mode) => set({ automationMode: mode }),
  setOnAir: (val) => set({ onAir: val }),
  setStationName: (name) => set({ stationName: name }),
  toggleSidebar: () => set(s => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  openModal: (id) => set({ activeModal: id }),
  closeModal: () => set({ activeModal: null }),
}));

// ============================================================
// LIBRARY STORE — song list, search, filters
// ============================================================

interface LibraryState {
  songs: SongView[];
  categories: Category[];
  totalCount: number;
  loading: boolean;
  error: string | null;
  searchQuery: string;
  filterCategoryId: number | null;
  filterStatus: string | null;
  selectedSongId: number | null;
  importProgress: { current: number; total: number; file: string } | null;

  setSongs: (songs: SongView[]) => void;
  setCategories: (cats: Category[]) => void;
  setTotalCount: (n: number) => void;
  setLoading: (v: boolean) => void;
  setError: (e: string | null) => void;
  setSearch: (q: string) => void;
  setFilterCategory: (id: number | null) => void;
  setFilterStatus: (s: string | null) => void;
  setSelectedSong: (id: number | null) => void;
  setImportProgress: (p: { current: number; total: number; file: string } | null) => void;
  upsertSong: (song: SongView) => void;
  removeSong: (id: number) => void;
}

export const useLibraryStore = create<LibraryState>((set) => ({
  songs: [],
  categories: [],
  totalCount: 0,
  loading: false,
  error: null,
  searchQuery: '',
  filterCategoryId: null,
  filterStatus: null,
  selectedSongId: null,
  importProgress: null,

  setSongs: (songs) => set({ songs }),
  setCategories: (categories) => set({ categories }),
  setTotalCount: (totalCount) => set({ totalCount }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setSearch: (searchQuery) => set({ searchQuery }),
  setFilterCategory: (filterCategoryId) => set({ filterCategoryId }),
  setFilterStatus: (filterStatus) => set({ filterStatus }),
  setSelectedSong: (selectedSongId) => set({ selectedSongId }),
  setImportProgress: (importProgress) => set({ importProgress }),
  upsertSong: (song) => set(s => ({
    songs: s.songs.some(x => x.id === song.id)
      ? s.songs.map(x => x.id === song.id ? song : x)
      : [...s.songs, song]
  })),
  removeSong: (id) => set(s => ({ songs: s.songs.filter(x => x.id !== id) })),
}));

// ============================================================
// ENGINE STORE — live player state (mirrors AudioEngine events)
// ============================================================

export type DeckStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

export interface DeckInfo {
  status: DeckStatus;
  title: string;
  artist: string;
  durationMs: number;
  positionMs: number;
  introMs: number;
  outroMs: number;
  volume: number;
  isCued: boolean;
  error: string | null;
}

const emptyDeck = (): DeckInfo => ({
  status: 'idle', title: '', artist: '', durationMs: 0,
  positionMs: 0, introMs: 0, outroMs: 0, volume: 1,
  isCued: false, error: null,
});

export interface LogQueueItem {
  entryId: number;
  position: number;
  slotType: string;
  title: string;
  artist: string;
  durationMs: number;
  status: EntryStatus;
  scheduledTime: string | null;
}

interface EngineState {
  deckA: DeckInfo;
  deckB: DeckInfo;
  activeDeck: 'A' | 'B';
  queue: LogQueueItem[];
  currentEntryId: number | null;
  crossfadeMs: number;
  masterVolume: number;

  setDeck: (deck: 'A' | 'B', info: Partial<DeckInfo>) => void;
  setActiveDeck: (deck: 'A' | 'B') => void;
  setQueue: (items: LogQueueItem[]) => void;
  setCurrentEntry: (id: number | null) => void;
  updateEntryStatus: (entryId: number, status: EntryStatus) => void;
  setCrossfade: (ms: number) => void;
  setMasterVolume: (v: number) => void;
}

export const useEngineStore = create<EngineState>((set) => ({
  deckA: emptyDeck(),
  deckB: emptyDeck(),
  activeDeck: 'A',
  queue: [],
  currentEntryId: null,
  crossfadeMs: 0,
  masterVolume: 1,

  setDeck: (deck, info) => set(s =>
    deck === 'A'
      ? { deckA: { ...s.deckA, ...info } }
      : { deckB: { ...s.deckB, ...info } }
  ),
  setActiveDeck: (activeDeck) => set({ activeDeck }),
  setQueue: (queue) => set({ queue }),
  setCurrentEntry: (currentEntryId) => set({ currentEntryId }),
  updateEntryStatus: (entryId, status) => set(s => ({
    queue: s.queue.map(q => q.entryId === entryId ? { ...q, status } : q)
  })),
  setCrossfade: (crossfadeMs) => set({ crossfadeMs }),
  setMasterVolume: (masterVolume) => set({ masterVolume }),
}));

// ============================================================
// SETTINGS STORE
// ============================================================

interface SettingsState {
  settings: Partial<AppSettings>;
  setSettings: (s: Partial<AppSettings>) => void;
  setSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: {
    station_name: 'My Station',
    theme: 'dark',
    crossfade_ms: 0,
    lufs_target: -14,
  },
  setSettings: (settings) => set(s => ({ settings: { ...s.settings, ...settings } })),
  setSetting: (key, value) => set(s => ({ settings: { ...s.settings, [key]: value } })),
}));
