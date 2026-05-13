// src/lib/ipc.ts
// Unified IPC bridge — works in both Electron and Tauri (for gradual migration)
// Replace: import { invoke } from "@tauri-apps/api/core"
// With:    import { invoke } from "@/lib/ipc"

type EtherAPI = typeof window.ether;

declare global {
  interface Window {
    ether: {
      audio: {
        load: (deck: string, filePath: string, title: string, artist: string, gainDb?: number) => Promise<boolean>;
        play: (deck: string) => Promise<boolean>;
        pause: (deck: string) => Promise<boolean>;
        stop: (deck: string) => Promise<boolean>;
        setVolume: (deck: string, volume: number) => Promise<boolean>;
        getState: () => Promise<any>;
        getLevels: () => Promise<{ a: number; b: number; c: number }>;
        getFileDuration: (filePath: string) => Promise<number>;
        watchdogSet: (active: boolean, thresholdSec: number) => Promise<boolean>;
      };
      db: {
        query: (sql: string, params?: any[]) => Promise<{ data: any[]; error: string | null }>;
        execute: (sql: string, params?: any[]) => Promise<{ data: any; error: string | null }>;
        backup: () => Promise<{ data: string | null; error: string | null }>;
        listBackups: () => Promise<string[]>;
        restore: (name: string) => Promise<{ data: string | null; error: string | null }>;
      };
      fs: {
        readFile: (filePath: string) => Promise<{ data: number[] | null; error: string | null }>;
        exists: (filePath: string) => Promise<boolean>;
        readDir: (dirPath: string) => Promise<{ name: string; path: string; isDir: boolean }[]>;
      };
      dialog: {
        openFile: (options?: any) => Promise<string[] | null>;
        openDirectory: () => Promise<string | null>;
        saveFile: (options?: any) => Promise<string | null>;
      };
      system: {
        getLocalIp: () => Promise<string>;
        openUrl: (url: string) => Promise<void>;
        openSoundSettings: () => Promise<void>;
        getAppDataDir: () => Promise<string>;
        getPlatform: () => Promise<string>;
      };
      autostart: {
        enable: () => Promise<void>;
        disable: () => Promise<void>;
        isEnabled: () => Promise<boolean>;
      };
      on: (channel: string, callback: (...args: any[]) => void) => void;
      off: (channel: string) => void;
    };
  }
}

// ── Unified invoke ────────────────────────────────────────────
export async function invoke(cmd: string, args?: Record<string, any>): Promise<any> {
  return electronInvoke(cmd, args);
}

async function electronInvoke(cmd: string, args?: Record<string, any>): Promise<any> {
  const e = window.ether;
  switch (cmd) {
    // Audio
    case "audio_load":
      return e.audio.load(args!.deck, args!.filePath, args!.title, args!.artist, args!.gainDb);
    case "audio_play":
      return e.audio.play(args!.deck);
    case "audio_pause":
      return e.audio.pause(args!.deck);
    case "audio_stop":
      return e.audio.stop(args!.deck);
    case "audio_set_volume":
      return e.audio.setVolume(args!.deck, args!.volume);
    case "audio_get_state":
      return e.audio.getState();
    case "get_levels":
      return e.audio.getLevels();
    case "get_file_duration":
      return e.audio.getFileDuration(args!.filePath);
    case "watchdog_set":
      return e.audio.watchdogSet(args!.active, args!.thresholdSec);

    // System
    case "get_local_ip":
      return e.system.getLocalIp();
    case "open_url":
      return e.system.openUrl(args!.url);
    case "open_sound_settings":
      return e.system.openSoundSettings();

    // Backup
    case "backup_db":
      return e.db.backup().then(r => r.data);
    case "list_backups":
      return e.db.listBackups();
    case "restore_db":
      return e.db.restore(args!.backupName).then(r => r.data);

    // Autostart
    case "plugin:autostart|enable":
      return e.autostart.enable();
    case "plugin:autostart|disable":
      return e.autostart.disable();
    case "plugin:autostart|is_enabled":
      return e.autostart.isEnabled();

    default:
      console.warn("[IPC] Unknown command:", cmd, args);
      return null;
  }
}

// ── File system helpers ───────────────────────────────────────
export async function readFile(filePath: string): Promise<Uint8Array> {
  const result = await window.ether.fs.readFile(filePath);
  if (result.error) throw new Error(result.error);
  return new Uint8Array(result.data!);
}

export async function openFileDialog(options?: {
  multiple?: boolean;
  filters?: { name: string; extensions: string[] }[];
}): Promise<string[] | null> {
  return window.ether.dialog.openFile(options);
}

export async function openDirectoryDialog(): Promise<string | null> {
  return window.ether.dialog.openDirectory();
}

export async function saveFileDialog(options?: any): Promise<string | null> {
  return window.ether.dialog.saveFile(options);
}

// ── Event listener ────────────────────────────────────────────
export function listenEvent(event: string, callback: (payload: any) => void): () => void {
  window.ether.on(event, callback);
  return () => window.ether.off(event);
}
