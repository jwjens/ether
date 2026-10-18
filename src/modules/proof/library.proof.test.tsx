// PROOF — the Song Library module (docs/screen-builder-design-2026-10-18.md §3: S3, S7; §2.7 empty state).
//
//   S3  Load A / Queue from a Library module vs the Library page (the pop-out PopoutRenderer "library", the window
//       the ☰ Library entry opens) make the identical window.ether bridge calls, on the same station.
//
// The component is the app's own LibraryPanel (imported from App.tsx, as PopoutRenderer does) with the Library
// window's own actions (useLibraryWindowActions). window.ether is a recording stub serving one song.
import "./miniDom";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { installEther, type EtherStub } from "./etherStub";
import { mount, click, type Mounted } from "./render";
import { findAllByText } from "./miniDom";
import { AudioEngineProvider } from "../../audio/AudioEngineContext";
import { disposeEngine } from "../../audio/engine-registry";
import PopoutRenderer from "../../components/PopoutRenderer";
import { ModuleSurface, ModuleFrame } from "../ModuleFrame";
import { moduleEntry } from "../registry";

const GLOBAL = { id: 2, name: "Test FM", uuid: "uuid-2" };
const OTHER = { id: 3, name: "Other FM", uuid: "uuid-3" };
const SONG = { id: 41, uuid: "song-41", title: "Wichita Lineman", artist_name: "Glen Campbell", file_path: "C:\\music\\wichita.mp3",
  duration_ms: 183000, content_class: "MUSIC", category_id: null, deleted_at: null };

let ether: EtherStub;
let mounted: Mounted[] = [];

function install(songs: any[] = [SONG]) {
  ether = installEther({
    "stations.getActive": () => Promise.resolve({ ...GLOBAL }),
    "stations.list": () => Promise.resolve([{ id: GLOBAL.id }, { id: OTHER.id }]),
    "audio.getState": () => Promise.resolve({ deckA: {}, deckB: {}, deckC: {} }),
    "db.query": (sql: string) => Promise.resolve({ data: /FROM songs s LEFT JOIN artists/.test(sql) ? songs.map(s => ({ ...s })) : [] }),
  });
}

async function show(el: React.ReactElement) { const m = await mount(el); mounted.push(m); return m; }
const page = () => <AudioEngineProvider gate><PopoutRenderer panel="library" /></AudioEngineProvider>;
const libModule = (station = GLOBAL) => <ModuleSurface station={station}><ModuleFrame type="library" instanceId="lib-1" /></ModuleSurface>;

/** The calls a button press makes. Left out: subscriptions and the engine's background deck-state poll. */
const pressCalls = () => ether.calls.filter(c => c.path !== "on" && c.path !== "off" && c.path !== "audio.getState");

async function pressBoth(m: Mounted) {
  expect(m.container.textContent, "the song is listed").toContain(SONG.title);
  ether.reset();
  await click(findAllByText(m.container, "A")[0]);
  const loadA = pressCalls();
  ether.reset();
  await click(findAllByText(m.container, "Q")[0]);
  const queue = pressCalls();
  return { loadA, queue };
}

beforeEach(() => { install(); disposeEngine(GLOBAL.id); disposeEngine(OTHER.id); });
afterEach(async () => {
  for (const m of mounted.reverse()) await m.unmount();
  mounted = [];
});

describe("S3 — library parity: Load A / Queue from the module and from the Library page", () => {
  it("make the identical bridge calls, on the same station", async () => {
    const p = await show(page());
    const fromPage = await pressBoth(p);
    await p.unmount(); mounted = [];

    disposeEngine(GLOBAL.id);
    const m = await show(libModule());
    const fromModule = await pressBoth(m);

    expect(fromPage.loadA.length, "Load A reaches the bridge").toBeGreaterThan(0);
    expect(fromModule.loadA).toEqual(fromPage.loadA);
    expect(fromModule.queue).toEqual(fromPage.queue);
    // the song's file is what was cued, on station 2
    expect(JSON.stringify(fromPage.loadA)).toContain("wichita.mp3");
    expect(JSON.stringify(fromPage.loadA)).toContain(String(GLOBAL.id));
    // FINDING (2026-10-18, docs/screen-builder-phase1-2026-10-18.md): the Library window's Q calls
    // `eng.enqueue?.(...)` and AudioEngine has no `enqueue` (it has queueEnqueue, engine-rodio.ts:630), so Queue from
    // the Library pop-out reaches no bridge call at all — in the page and, by parity, in the module. Recorded here so
    // the day it is fixed this line is updated on purpose, not silently. Runtime: UNVERIFIED.
    expect(fromPage.queue).toEqual([]);
  });
});

describe("S7 — the Library module follows its surface's station", () => {
  it("a module of station 3 cues on station 3 while the active station is 2", async () => {
    const onGlobal = await show(libModule(GLOBAL));
    const g = await pressBoth(onGlobal);
    await onGlobal.unmount(); mounted = [];
    const onOther = await show(libModule(OTHER));
    const o = await pressBoth(onOther);
    // the same calls, with the station swapped — and never the active station's id
    const swap = (calls: unknown) => JSON.parse(JSON.stringify(calls).split(`"stationId":${GLOBAL.id}`).join(`"stationId":${OTHER.id}`)
      .replace(new RegExp(`,${GLOBAL.id}\\]`, "g"), `,${OTHER.id}]`));
    expect(o.loadA).toEqual(swap(g.loadA));
    expect(JSON.stringify(o.loadA)).not.toEqual(JSON.stringify(g.loadA));
  });
});

describe("empty state (doors before rooms)", () => {
  it("a Library module with nothing in it shows the registry's empty state", async () => {
    install([]);
    const m = await show(libModule());
    expect(m.container.textContent).toContain(moduleEntry("library").empty.text);
  });
});
