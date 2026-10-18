// PROOF — the Song Library module (docs/screen-builder-design-2026-10-18.md §3: S3, S7; §2.7 empty state), and Jeff's
// two Library rulings of 2026-10-18 (src/lib/libraryDeckActions.tsx):
//   · NEVER LOAD OVER A DECK THAT IS ON AIR, EVERYWHERE — with deck A/B/C playing or paused, Load A/B/C from the main
//     window's Library, the Library window and the Library module sends nothing to the engine and shows the same
//     refusal; with the deck idle or cued, all three send the identical command.
//   · Q IS THE REAL ENQUEUE — daemon-driven: audio:daemon "queue:enqueue" (→ ether-audiod intentEnqueue), from all
//     three, identically; in-process: the engine's own queue.
//
// The three surfaces:
//   page    the Library window — PopoutRenderer "library", under the provider main.tsx mounts;
//   module  ModuleFrame type="library" on a ModuleSurface;
//   main    the main window's Library: App.tsx builds its LibraryPanel props with libraryDeckActions({ engine: () =>
//           getEngine(stationId), setNotice: setDeckLoadMsg, … }). App itself is not mounted here (it is the whole app
//           behind the account gate); `mainLibrary` below is that same call, and a static check holds App.tsx to it.
import "./miniDom";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { useMemo, useState } from "react";
import fs from "fs";
import path from "path";
import { installEther, type EtherStub, type BridgeCall } from "./etherStub";
import { mount, click, type Mounted } from "./render";
import { findAllByText } from "./miniDom";
import { AudioEngineProvider } from "../../audio/AudioEngineContext";
import { disposeEngine, getEngine } from "../../audio/engine-registry";
import PopoutRenderer from "../../components/PopoutRenderer";
import { LibraryPanel } from "../../App";
import { libraryDeckActions, DeckLoadNoticeBar, onAirRefusal, type DeckLoadNotice } from "../../lib/libraryDeckActions";
import { ModuleSurface, ModuleFrame } from "../ModuleFrame";
import { moduleEntry } from "../registry";

const GLOBAL = { id: 2, name: "Test FM", uuid: "uuid-2" };
const OTHER = { id: 3, name: "Other FM", uuid: "uuid-3" };
const SONG = { id: 41, uuid: "song-41", title: "Wichita Lineman", artist_name: "Glen Campbell", file_path: "C:\\music\\wichita.mp3",
  duration_ms: 183000, intro_end: 1200, content_class: "MUSIC", category_id: null, deleted_at: null };
const RESOLVED = "C:\\cache\\wichita.mp3";

let ether: EtherStub;
let mounted: Mounted[] = [];

function install(songs: any[] = [SONG]) {
  ether = installEther({
    "stations.getActive": () => Promise.resolve({ ...GLOBAL }),
    "stations.list": () => Promise.resolve([{ id: GLOBAL.id }, { id: OTHER.id }]),
    "audio.getState": () => Promise.resolve({ deckA: {}, deckB: {}, deckC: {} }),
    "db.query": (sql: string) => Promise.resolve({ data: /FROM songs s LEFT JOIN artists/.test(sql) ? songs.map(s => ({ ...s })) : [] }),
    invoke: (ch: string) => Promise.resolve(ch === "audio:resolve-local-path" ? { ok: true, filePath: RESOLVED } : null),
  });
}

/** The main window's Library: App.tsx's own call, with App's station resolution (getEngine by id, fresh). */
function MainLibrary({ stationId }: { stationId: number }) {
  const [notice, setNotice] = useState<DeckLoadNotice>(null);
  const actions = useMemo(() => libraryDeckActions({ engine: () => getEngine(stationId), setNotice, autoCueOnQueue: () => true }), [stationId]);
  return <div><LibraryPanel {...actions} /><DeckLoadNoticeBar notice={notice} /></div>;
}

type Surface = "main" | "page" | "module";
const SURFACES: Surface[] = ["main", "page", "module"];
function render(surface: Surface, station = GLOBAL): React.ReactElement {
  if (surface === "main") return <AudioEngineProvider><MainLibrary stationId={station.id} /></AudioEngineProvider>;
  if (surface === "page") return <AudioEngineProvider gate><PopoutRenderer panel="library" /></AudioEngineProvider>;
  return <ModuleSurface station={station}><ModuleFrame type="library" instanceId="lib-1" /></ModuleSurface>;
}
async function show(el: React.ReactElement) { const m = await mount(el); mounted.push(m); return m; }

/** The engine's own report of a deck, set as the engine would hold it (playing / paused / idle). */
function setDeck(stationId: number, deck: "A" | "B" | "C", status: string, filePath = "") {
  const eng: any = getEngine(stationId);
  eng[`state${deck}`] = { ...eng[`state${deck}`], status, filePath };
}
function daemonMode(stationId: number, on: boolean) { (getEngine(stationId) as any).daemonDriven = on; }

/** The calls a button press makes. Left out: subscriptions and the engine's own background work on its timers — the
 *  deck-state poll, the daemon-attach retry, its rotation log line — which run whether or not anything is pressed. */
const pressCalls = (): BridgeCall[] => ether.calls.filter(c => !/^(on|off|audio\.getState|audio\.daemonEnabled|fs\.logRotation)$/.test(c.path));
const ENGINE_COMMAND = /^audio\.(load|play|daemon)$/;

async function press(m: Mounted, label: "A" | "B" | "C" | "Q") {
  expect(m.container.textContent, "the song is listed").toContain(SONG.title);
  ether.reset();
  await click(findAllByText(m.container, label)[0]);
  return pressCalls();
}

beforeEach(() => { install(); disposeEngine(GLOBAL.id); disposeEngine(OTHER.id); });
afterEach(async () => {
  for (const m of mounted.reverse()) await m.unmount();
  mounted = [];
});

describe("never load over a deck that is on air — all three surfaces", () => {
  for (const status of ["playing", "paused"]) {
    for (const deck of ["A", "B", "C"] as const) {
      it(`deck ${deck} ${status}: Load ${deck} sends nothing and says why, from main, page and module`, async () => {
        for (const s of SURFACES) {
          const m = await show(render(s));
          setDeck(GLOBAL.id, deck, status, "C:\\music\\on-air.mp3");
          const calls = await press(m, deck);
          expect(calls.filter(c => ENGINE_COMMAND.test(c.path)), `${s}: nothing reaches the engine`).toEqual([]);
          expect(calls.some(c => c.path === "invoke" && c.args[0] === "audio:resolve-local-path"), `${s}: not even the resolve`).toBe(false);
          expect(m.container.textContent, `${s}: the refusal is shown`).toContain(onAirRefusal(SONG.title, deck));
          await m.unmount(); mounted = [];
          disposeEngine(GLOBAL.id);
        }
      });
    }
  }
});

describe("deck idle or cued: all three send the identical command", () => {
  for (const mode of ["in-process", "daemon"] as const) {
    for (const [state, file] of [["idle", ""], ["cued", "C:\\music\\cued.mp3"]] as const) {
      it(`${mode}, deck A ${state}: Load A from main, page and module is the same call sequence`, async () => {
        const seqs: Record<string, BridgeCall[]> = {};
        for (const s of SURFACES) {
          const m = await show(render(s));
          daemonMode(GLOBAL.id, mode === "daemon");
          setDeck(GLOBAL.id, "A", "idle", file);
          seqs[s] = await press(m, "A");
          expect(m.container.textContent, `${s}: no refusal`).not.toContain("is on air");
          await m.unmount(); mounted = [];
          disposeEngine(GLOBAL.id);
        }
        expect(seqs.page).toEqual(seqs.main);
        expect(seqs.module).toEqual(seqs.main);
        // the one path: resolve local-first → R2, then the load with the RESOLVED file, on station 2
        expect(seqs.main[0]).toEqual({ path: "invoke", args: ["audio:resolve-local-path", SONG.file_path] });
        const cmd = seqs.main.find(c => ENGINE_COMMAND.test(c.path))!;
        if (mode === "daemon") {
          expect(cmd).toEqual({ path: "audio.daemon", args: ["deck:cue", { stationId: GLOBAL.id, deck: "A",
            songRef: { filePath: RESOLVED, title: SONG.title, artist: SONG.artist_name, durationMs: SONG.duration_ms } }] });
        } else {
          expect(cmd.path).toBe("audio.load");
          expect(cmd.args.slice(0, 2)).toEqual(["A", RESOLVED]);
          expect(cmd.args[cmd.args.length - 1]).toBe(GLOBAL.id);
        }
      });
    }
  }
});

describe("Q is the real enqueue — S3 for the queue", () => {
  it("daemon-driven: Q from main, page and module sends audio:daemon queue:enqueue with the song, identically", async () => {
    const seqs: Record<string, BridgeCall[]> = {};
    for (const s of SURFACES) {
      const m = await show(render(s));
      daemonMode(GLOBAL.id, true);
      seqs[s] = (await press(m, "Q")).filter(c => c.path === "audio.daemon");
      await m.unmount(); mounted = [];
      disposeEngine(GLOBAL.id);
    }
    expect(seqs.main).toEqual([{ path: "audio.daemon", args: ["queue:enqueue", { stationId: GLOBAL.id, items: [{
      filePath: SONG.file_path, title: SONG.title, artist: SONG.artist_name, introEnd: SONG.intro_end, durationMs: SONG.duration_ms,
    }] }] }]);
    expect(seqs.page).toEqual(seqs.main);
    expect(seqs.module).toEqual(seqs.main);
  });
  it("in-process: Q from each surface puts the song on that station's engine queue", async () => {
    for (const s of SURFACES) {
      const m = await show(render(s));
      await press(m, "Q");
      const q = getEngine(GLOBAL.id).getQueue();
      expect(q.map(i => i.filePath), s).toEqual([SONG.file_path]);
      await m.unmount(); mounted = [];
      disposeEngine(GLOBAL.id);
    }
  });
});

describe("S7 — the Library module follows its surface's station", () => {
  it("a module of station 3 cues and queues on station 3 while the active station is 2", async () => {
    const m = await show(render("module", OTHER));
    daemonMode(OTHER.id, true);
    const load = await press(m, "A");
    const queue = await press(m, "Q");
    const cmds = [...load, ...queue].filter(c => c.path === "audio.daemon");
    expect(cmds.map(c => (c.args[1] as any).stationId)).toEqual([OTHER.id, OTHER.id]);
  });
});

describe("App.tsx's main-window Library is the call MainLibrary makes", () => {
  it("both LibraryPanels take libraryDeckActions({ engine: () => getEngine(stationId), setNotice: setDeckLoadMsg, … })", () => {
    const app = fs.readFileSync(path.join(__dirname, "..", "..", "App.tsx"), "utf8").replace(/\r/g, "");
    expect(app).toMatch(/const libActions = useMemo\(\(\) => libraryDeckActions\(\{\n\s*engine: \(\) => getEngine\(stationId\),\n\s*setNotice: setDeckLoadMsg,/);
    expect(app.split("<LibraryPanel {...libActions} onEdit=").length - 1).toBe(2);
    expect(app).not.toMatch(/const loadDeck = useCallback/);
    expect(app).toContain("<DeckLoadNoticeBar notice={deckLoadMsg} />");
  });
});

describe("empty state (doors before rooms)", () => {
  it("a Library module with nothing in it shows the registry's empty state", async () => {
    install([]);
    const m = await show(render("module"));
    expect(m.container.textContent).toContain(moduleEntry("library").empty.text);
  });
});
