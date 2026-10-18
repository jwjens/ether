// SINGLE-KEY SHORTCUTS IGNORE CTRL / ALT / META — through the real components (src/lib/plainKey.ts).
//
//   · the cart wall (the Carts page, PopoutRenderer "carts"): Ctrl / Alt / Meta + each of the 24 cart keys fires no
//     cart; the plain key fires it;
//   · the shortcut sheet (KeyboardHelp): Shift+/ opens it; Ctrl/Alt/Meta + Shift+/ does not;
//   · macro hotkeys (useMacroHotkeys): Ctrl/Alt/Meta + the macro's key runs nothing; the plain key runs it;
//   · a fader's arrow keys (useFaderControl): Ctrl/Alt/Meta + an arrow moves nothing; the plain arrow steps it.
// The dashboard's own keys (App.tsx handleKey) are tested through the mapping it dispatches on, appShortcut
// (src/lib/plainKey.test.ts), and every other handler by the static check there.
import "../modules/proof/miniDom";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act, useRef } from "react";
import { installEther, type EtherStub } from "../modules/proof/etherStub";
import { mount, settle, type Mounted } from "../modules/proof/render";
import { pressKey, fire } from "../modules/proof/miniDom";
import { AudioEngineProvider } from "../audio/AudioEngineContext";
import { disposeEngine } from "../audio/engine-registry";
import PopoutRenderer from "../components/PopoutRenderer";
import KeyboardHelp from "../components/KeyboardHelp";
import { useMacroHotkeys } from "../components/MacroEngine";
import { useFaderControl } from "./useFaderControl";

const STATION = { id: 2, name: "Test FM", uuid: "uuid-2" };
const CART_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "Q", "W", "E", "R", "T", "Y", "U", "I", "A", "S", "D", "F", "G", "H", "J", "K"];
const MODS = [{ ctrlKey: true }, { altKey: true }, { metaKey: true }];

let ether: EtherStub;
let mounted: Mounted[] = [];
async function show(el: React.ReactElement) { const m = await mount(el); mounted.push(m); return m; }
async function press(key: string, mods = {}, code?: string) { await act(async () => { pressKey(key, mods, code); }); await settle(10); }

beforeEach(() => {
  ether = installEther({
    "stations.getActive": () => Promise.resolve({ ...STATION }),
    "stations.list": () => Promise.resolve([{ id: STATION.id }]),
    "audio.getState": () => Promise.resolve({ deckA: {}, deckB: {}, deckC: {} }),
    // all 24 hotkey slots loaded, so every cart key is live
    "cartSlots.list": () => Promise.resolve(CART_KEYS.map((_, i) => ({ slot_number: i, title: `Cart ${i + 1}`, file_path: `C:\\carts\\c${i + 1}.mp3` }))),
    "deckConfigs.list": () => Promise.resolve({ rows: [{ slot: "D", type: "source", kind: "cart", enabled: 1 }] }),
    "db.query": (sql: string) => Promise.resolve({ data: /FROM macros/.test(sql)
      ? [{ id: 1, name: "Go", hotkey: "KeyM", is_active: 1, actions: JSON.stringify([{ type: "command", value: "go" }]) }] : [] }),
  });
  disposeEngine(STATION.id);
});
afterEach(async () => {
  for (const m of mounted.reverse()) await m.unmount();
  mounted = [];
});

describe("the cart wall: Ctrl / Alt / Meta + a cart key fires no cart", () => {
  it("every one of the 24 cart keys, with each modifier: nothing reaches the engine", async () => {
    await show(<AudioEngineProvider gate><PopoutRenderer panel="carts" /></AudioEngineProvider>);
    ether.reset();
    for (const k of CART_KEYS) for (const m of MODS) await press(k, m);
    expect(ether.callsTo(/^audio\.(load|play|pause)$|^deckConfigs\.list$/)).toEqual([]);
  });
  it("the same key unmodified still fires its cart (and Shift is not a modifier here)", async () => {
    await show(<AudioEngineProvider gate><PopoutRenderer panel="carts" /></AudioEngineProvider>);
    ether.reset();
    await press("1");
    expect(ether.callsTo("audio.load")).toHaveLength(1);
    expect(ether.callsTo("audio.load")[0].args[1]).toBe("C:\\carts\\c1.mp3");
  });
});

describe("the shortcut sheet (KeyboardHelp): Shift+/ is deliberate, Ctrl/Alt/Meta + it is not", () => {
  it("Ctrl / Alt / Meta + Shift+/ leaves it closed; Shift+/ opens it", async () => {
    const m = await show(<KeyboardHelp />);
    for (const mod of MODS) await press("?", { ...mod, shiftKey: true }, "Slash");
    expect(m.container.textContent).not.toContain("Keyboard Shortcuts");
    await press("?", { shiftKey: true }, "Slash");
    expect(m.container.textContent).toContain("Keyboard Shortcuts");
  });
});

describe("macro hotkeys: Ctrl / Alt / Meta + the macro's key runs nothing", () => {
  function Macros({ onCmd }: { onCmd: (c: string) => void }) { useMacroHotkeys(onCmd); return null; }
  it("Ctrl+M, Alt+M, Meta+M run nothing; M runs the macro", async () => {
    const ran: string[] = [];
    await show(<Macros onCmd={c => ran.push(c)} />);
    for (const mod of MODS) await press("m", mod);
    expect(ran).toEqual([]);
    await press("m");
    expect(ran).toEqual(["go"]);
  });
});

describe("a fader's arrow keys: Ctrl / Alt / Meta + an arrow moves nothing", () => {
  function Fader({ onChange }: { onChange: (g: number) => void }) {
    const track = useRef<HTMLDivElement>(null);
    const c = useFaderControl({ gain: 0.5, topDb: 10, onChange, axis: "y", trackRef: track });
    return <div ref={track} data-fader="1" tabIndex={c.tabIndex} onKeyDown={c.onKeyDown} />;
  }
  it("with a modifier nothing; plain ArrowUp steps the gain; Shift+ArrowUp (fine step) still steps", async () => {
    const changes: number[] = [];
    const m = await show(<Fader onChange={g => changes.push(g)} />);
    const el = m.container.firstChild;
    for (const mod of MODS) await act(async () => { fire(el, "keydown", { key: "ArrowUp", code: "ArrowUp", ...mod }); });
    expect(changes).toEqual([]);
    await act(async () => { fire(el, "keydown", { key: "ArrowUp", code: "ArrowUp" }); });
    await act(async () => { fire(el, "keydown", { key: "ArrowUp", code: "ArrowUp", shiftKey: true }); });
    expect(changes).toHaveLength(2);
  });
});

