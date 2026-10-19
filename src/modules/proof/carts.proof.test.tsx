// PROOF — the Carts module (docs/screen-builder-design-2026-10-18.md §3: S1, S6, S7; §2.7 empty state).
//
//   S1  the Carts page (the pop-out PopoutRenderer "carts", under the provider main.tsx mounts) and a Carts module on a
//       surface fire the same cart and make the IDENTICAL sequence of window.ether bridge calls, on the same station.
//   S6  two cart modules in one window: a hotkey fires only the focused one, once. With a single wall and no click,
//       the hotkey still fires it (the Carts page keeps working exactly as today).
//   S7  a module of station 3 never addresses the global active station (2).
//
// The components are the app's own (BoutiqueCartWall via the registry); only window.ether is a recording stub.
import "./miniDom";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { installEther, type EtherStub, type BridgeCall } from "./etherStub";
import { mount, click, settle, pointerDown, type Mounted } from "./render";
import { findAllByAttr, pressKey } from "./miniDom";
import { act } from "react";
import { AudioEngineProvider } from "../../audio/AudioEngineContext";
import { disposeEngine } from "../../audio/engine-registry";
import PopoutRenderer from "../../components/PopoutRenderer";
import { ModuleSurface, ModuleFrame } from "../ModuleFrame";
import { moduleEntry } from "../registry";

const GLOBAL = { id: 2, name: "Test FM", uuid: "uuid-2" };
const OTHER = { id: 3, name: "Other FM", uuid: "uuid-3" };
const FIRE_TITLE = "Legal ID — click to fire, right-click to delete";

let ether: EtherStub;
let mounted: Mounted[] = [];

function handlers(withCarts = true) {
  return {
    "stations.getActive": () => Promise.resolve({ id: GLOBAL.id, name: GLOBAL.name, uuid: GLOBAL.uuid }),
    "stations.list": () => Promise.resolve([{ id: GLOBAL.id }, { id: OTHER.id }]),
    "cartSlots.list": () => Promise.resolve(withCarts
      ? [{ slot_number: 0, title: "Legal ID", file_path: "C:\\carts\\legal-id.mp3", color: "#ef4444" }]
      : []),
    // one channel dialled to Cart, so the fire resolves a real patch rather than the fallback
    "deckConfigs.list": () => Promise.resolve({ rows: [{ slot: "D", type: "source", kind: "cart", enabled: 1 }] }),
    "audio.getState": () => Promise.resolve({ deckA: {}, deckB: {}, deckC: {} }),
  };
}

async function show(el: React.ReactElement) { const m = await mount(el); mounted.push(m); return m; }
const page = () => <AudioEngineProvider gate><PopoutRenderer panel="carts" /></AudioEngineProvider>;
const cartModule = (instanceId: string, station = GLOBAL) =>
  <ModuleSurface station={station}><ModuleFrame type="carts" instanceId={instanceId} /></ModuleSurface>;

/** The bridge calls a fire makes: the recording from the click until it settles. Left out: subscriptions, and the
 *  engine's own background deck-state poll (it runs on a timer whether or not anything is pressed). The console
 *  line's wall-clock stamp is the one field that cannot match between two fires. */
function fireCalls(): BridgeCall[] {
  // THE FIRE ENDS AT audio.play. The wall polls its cart deck every 200 ms (the flash and countdown), and each poll reads
  // audio.daemonEnabled. On a loaded machine the click took ~410 ms to settle, a poll landed inside the recording, and
  // the module showed 9 calls to the page's 8 — the same component (the page IS the Carts window now), different timing.
  // Measured 2026-10-19: the extra calls were audio.daemonEnabled ×2 after audio.play. Everything up to and including
  // the play is still compared exactly; what the poll reads afterwards is not the fire.
  const all = ether.calls.filter(c => c.path !== "on" && c.path !== "off" && c.path !== "audio.getState");
  const end = all.findIndex(c => c.path === "audio.play");
  const calls = end >= 0 ? all.slice(0, end + 1) : all;
  return JSON.parse(JSON.stringify(calls, (k, v) => (k === "ts" && typeof v === "number" ? "[time]" : v)));
}
const tileOf = (m: Mounted) => findAllByAttr(m.container, "title", FIRE_TITLE)[0];

beforeEach(() => {
  ether = installEther(handlers());
  disposeEngine(GLOBAL.id); disposeEngine(OTHER.id);   // a fresh engine per test: no state carried between fires
});
afterEach(async () => {
  for (const m of mounted.reverse()) await m.unmount();
  mounted = [];
});

describe("S1 — cart parity: the Carts page and a Carts module make the identical bridge calls", () => {
  it("fires the same cart with the same sequence, on the same station", async () => {
    const p = await show(page());
    const pageTile = findAllByAttr(p.container, "title", FIRE_TITLE)[0];
    expect(pageTile, "the page renders the assigned cart").toBeTruthy();
    ether.reset();
    await click(pageTile);
    const fromPage = fireCalls();
    await p.unmount(); mounted = [];

    disposeEngine(GLOBAL.id);
    const m = await show(cartModule("carts-1"));
    const modTile = findAllByAttr(m.container, "title", FIRE_TITLE)[0];
    expect(modTile, "the module renders the assigned cart").toBeTruthy();
    ether.reset();
    await click(modTile);
    const fromModule = fireCalls();

    // The recording is not empty and is the real fire: the deck config read, the load, the play.
    expect(fromPage.map(c => c.path)).toEqual(expect.arrayContaining(["deckConfigs.list", "audio.load", "audio.play"]));
    expect(fromModule).toEqual(fromPage);
    // Same station on every station-carrying call.
    expect(fromPage.find(c => c.path === "deckConfigs.list")!.args).toEqual([GLOBAL.id]);
    const load = fromPage.find(c => c.path === "audio.load")!;
    expect(load.args[0]).toBe("D");
    expect(load.args[1]).toBe("C:\\carts\\legal-id.mp3");
    expect(load.args[load.args.length - 1]).toBe(GLOBAL.id);
    const play = fromPage.find(c => c.path === "audio.play")!;
    expect(play.args).toEqual(["D", GLOBAL.id]);
  });
});

describe("S6 — two cart modules: a hotkey fires only the focused one, once", () => {
  const loads = () => ether.callsTo("audio.load");

  it("the Carts page alone: key 1 fires its cart (unchanged behaviour, no click needed)", async () => {
    await show(page());
    ether.reset();
    await act(async () => { pressKey("1"); });
    await settle();
    expect(loads()).toHaveLength(1);
    expect(ether.callsTo("audio.play")).toHaveLength(1);
  });

  it("two modules, the second clicked into: key 1 fires once, from the focused wall only", async () => {
    const a = await show(cartModule("carts-a"));
    const b = await show(cartModule("carts-b"));
    // focus the FIRST wall (not the most recently mounted), so the test can tell ownership from mount order.
    // A pointer-down on a tile is a focus, not a fire (a cart fires on click).
    await pointerDown(tileOf(a));
    ether.reset();
    await act(async () => { pressKey("1"); });
    await settle();
    expect(loads()).toHaveLength(1);
    expect(ether.callsTo("audio.play")).toHaveLength(1);

    // now focus the second: still exactly one fire per key press
    await pointerDown(tileOf(b));
    ether.reset();
    // B has nothing playing, so its key FIRES (a load); had A still owned the key it would have STOPPED A's cart
    // (a pause, no load) — so one load here is B and only B.
    await act(async () => { pressKey("1"); });
    await settle();
    expect(loads()).toHaveLength(1);
    expect(ether.callsTo("audio.pause")).toHaveLength(0);
  });

  it("two modules, none clicked: one key press fires once (the most recently mounted wall), never twice", async () => {
    await show(cartModule("carts-a"));
    await show(cartModule("carts-b"));
    ether.reset();
    await act(async () => { pressKey("1"); });
    await settle();
    expect(loads()).toHaveLength(1);
  });

  it("a double press inside one fire's awaits fires once (the in-flight guard)", async () => {
    let release: () => void = () => {};
    ether.handle({ "deckConfigs.list": () => new Promise(r => { release = () => r({ rows: [{ slot: "D", type: "source", kind: "cart", enabled: 1 }] }); }) });
    const m = await show(cartModule("carts-a"));
    const tile = findAllByAttr(m.container, "title", FIRE_TITLE)[0];
    ether.reset();
    await click(tile);       // fire 1 is parked on the deck-config read
    await click(tile);       // fire 2 arrives while fire 1 is still in flight
    await act(async () => { release(); });
    await settle();
    expect(ether.callsTo("deckConfigs.list")).toHaveLength(1);
    expect(loads()).toHaveLength(1);
  });
});

describe("S7 — a module follows its surface's station, never the global one", () => {
  it("a Carts module of station 3 reads and fires station 3 while the active station is 2", async () => {
    const m = await show(cartModule("carts-other", OTHER));
    const reads = ether.callsTo("cartSlots.list");
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(c => c.args[0] === OTHER.id)).toBe(true);
    const tile = findAllByAttr(m.container, "title", FIRE_TITLE)[0];
    ether.reset();
    await click(tile);
    const stationArgs = ether.calls
      .filter(c => /^audio\.(load|play)$|^deckConfigs\.list$/.test(c.path))
      .map(c => c.args[c.args.length - 1]);
    expect(stationArgs.length).toBeGreaterThanOrEqual(3);
    expect(stationArgs.every(s => s === OTHER.id)).toBe(true);
  });

  it("a ModuleFrame outside a ModuleSurface refuses to render (no station guess)", async () => {
    const err = console.error; console.error = () => {};
    try {
      await expect(mount(<ModuleFrame type="carts" instanceId="orphan" />)).rejects.toThrow(/has no station/);
    } finally { console.error = err; }
  });
});

describe("empty state (doors before rooms)", () => {
  it("a Carts module with no carts shows the registry's empty state on its tiles", async () => {
    ether = installEther(handlers(false));
    const m = await show(cartModule("carts-empty"));
    const empty = findAllByAttr(m.container, "title", moduleEntry("carts").empty.text);
    expect(empty.length).toBeGreaterThan(0);
    expect(m.container.textContent).toContain("Empty");
  });
});
