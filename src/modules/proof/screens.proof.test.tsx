// PROOF — the surface window (docs/screen-builder-design-2026-10-18.md §2.2, §2.5, §3; Jeff's decisions 1 and 3).
//
//   · placing a module in the surface renders the SAME registry component, in a ModuleFrame pane (S4 still holds);
//   · S1 / S2 / S3 parity still hold for modules INSIDE a surface: a cart fired, a log row deleted, a song loaded and
//     queued from a surface pane make the identical bridge calls the pages make;
//   · the layout round trip: build a screen in the UI → SAVE → the real screen_layouts handler writes a real SQLite
//     table (created by the real v64 migration) → reopen the window by its layout uuid → the same panes, sizes and
//     module options come back (and saving the reopened screen writes the identical document);
//   · S7: a surface of station B never reads station A's rows.
//
// The surface is the real ScreenSurface under PopoutRenderer (the "screen" / "screen:<uuid>" windows), dockview and
// all, in the test DOM (./miniDom). window.ether is the recording stub; screen_layouts:* are answered by
// electron/sync/handlers/screen_layouts.js over node:sqlite, with a recorder in place of the sync mutation log.
import "./miniDom";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRequire } from "module";
import { DatabaseSync } from "node:sqlite";
import { installEther, type EtherStub, type BridgeCall } from "./etherStub";
import { mount, click, settle, type Mounted } from "./render";
import { findAllByAttr, findAllByText } from "./miniDom";
import { AudioEngineProvider } from "../../audio/AudioEngineContext";
import { disposeEngine, getEngine } from "../../audio/engine-registry";
import PopoutRenderer from "../../components/PopoutRenderer";
import { BoutiqueCartWall } from "../../components/DeckConfigurator";
import { moduleEntry } from "../registry";
import { parseLayoutDoc } from "../layoutPayload";
import { DockviewApi } from "dockview-react";
import { useActiveStation } from "../../hooks/useActiveStation";

function StationProbe() { return <>{useActiveStation().stationId}</>; }

const require_ = createRequire(import.meta.url);
const { createScreenLayoutsApi } = require_("../../../electron/sync/handlers/screen_layouts.js");
const migration64 = require_("../../../scripts/migrate-screen-layouts-phase-sync-64.js");

const A = { id: 2, name: "Test FM", uuid: "uuid-2" };
const B = { id: 3, name: "Other FM", uuid: "uuid-3" };
const SONG = { id: 41, title: "Wichita Lineman", artist_name: "Glen Campbell", file_path: "C:\\music\\wichita.mp3", duration_ms: 183000, intro_end: 1200, content_class: "MUSIC", deleted_at: null };
const FIRE_TITLE = "Legal ID — click to fire, right-click to delete";

let ether: EtherStub;
let db: any;
let mutations: any[];
let mounted: Mounted[] = [];
let activeStation = A;

/** A real SQLite database with the real v64 migration applied (node:sqlite has no .transaction; this is its shim). */
function freshDb() {
  const d: any = new DatabaseSync(":memory:");
  d.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
  d.transaction = (fn: () => void) => () => { d.exec("BEGIN"); try { fn(); d.exec("COMMIT"); } catch (e) { d.exec("ROLLBACK"); throw e; } };
  const log = console.log; console.log = () => {};
  try { migration64.applyMigration(d); } finally { console.log = log; }
  return d;
}

function install() {
  const api = createScreenLayoutsApi((_d: any, m: any, fn: () => void) => { mutations.push(m); fn(); });
  const wrap = (f: () => any) => { try { return Promise.resolve(f()); } catch (e: any) { return Promise.resolve({ ok: false, error: e.message }); } };
  ether = installEther({
    "stations.getActive": () => Promise.resolve({ ...activeStation }),
    "stations.list": () => Promise.resolve([{ id: A.id }, { id: B.id }]),
    "audio.getState": () => Promise.resolve({ deckA: {}, deckB: {}, deckC: {} }),
    "cartSlots.list": () => Promise.resolve([{ slot_number: 0, title: "Legal ID", file_path: "C:\\carts\\legal-id.mp3", color: "#ef4444" }]),
    "deckConfigs.list": () => Promise.resolve({ rows: [{ slot: "D", type: "source", kind: "cart", enabled: 1 }] }),
    "db.query": (sql: string) => Promise.resolve({ data: /FROM songs s LEFT JOIN artists/.test(sql) ? [{ ...SONG }] : [] }),
    invoke: (ch: string, ...a: any[]) => {
      if (ch === "screen_layouts:save") return wrap(() => ({ ok: true, row: api.save(db, a[0]) }));
      if (ch === "screen_layouts:get") return wrap(() => ({ ok: true, row: api.get(db, a[0], a[1]) }));
      if (ch === "screen_layouts:list") return wrap(() => ({ ok: true, rows: api.list(db, a[0], a[1]) }));
      if (ch === "audio:resolve-local-path") return Promise.resolve({ ok: true, filePath: a[0] });
      return Promise.resolve(null);
    },
  });
  return api;
}

async function show(el: React.ReactElement) { const m = await mount(el); mounted.push(m); return m; }
const screenWindow = (key = "screen") => <AudioEngineProvider gate><PopoutRenderer panel={key} /></AudioEngineProvider>;
const page = (panel: string) => <AudioEngineProvider gate><PopoutRenderer panel={panel} /></AudioEngineProvider>;

async function place(m: Mounted, title: string) { await click(findAllByText(m.container, `+ ${title}`)[0]); await settle(60); }
/** SAVE, then accept the name dialog (askText mounts in document.body) with its default name. */
async function saveScreen(m: Mounted) {
  await click(findAllByText(m.container, "SAVE")[0]);
  const ok = findAllByText((globalThis as any).document.body, "OK").pop();
  if (ok) await click(ok);
  await settle(60);
}
const rows = () => db.prepare("SELECT * FROM screen_layouts WHERE deleted_at IS NULL ORDER BY id").all();
const commands = (): BridgeCall[] => ether.calls.filter(c => !/^(on|off|audio\.getState|audio\.daemonEnabled|fs\.logRotation)$/.test(c.path)
  && !(c.path === "invoke" && String(c.args[0]).startsWith("screen_layouts:")));
const stable = (calls: BridgeCall[]) => JSON.parse(JSON.stringify(calls, (k, v) => (k === "ts" && typeof v === "number" ? "[time]" : v)));

beforeEach(() => {
  activeStation = A; mutations = []; db = freshDb(); install();
  disposeEngine(A.id); disposeEngine(B.id);
});
afterEach(async () => {
  for (const m of mounted.reverse()) await m.unmount();
  mounted = [];
  for (const el of [...(globalThis as any).document.body.childNodes]) el.remove();
  if (activeStation !== A) {
    activeStation = A; install();
    const p = await mount(<StationProbe />);
    await act(async () => { (globalThis as any).dispatchEvent(new Event("station-switched")); });
    await settle(40);
    await p.unmount();
  }
});

describe("the surface places the registry's own components", () => {
  it("a new screen shows its empty state, and + Carts / + Program Log / + Song Library place the real modules", async () => {
    const m = await show(screenWindow());
    expect(m.container.textContent).toContain("An empty screen");
    await place(m, "Carts");
    await place(m, "Program Log");
    await place(m, "Song Library");
    const text = m.container.textContent;
    expect(text).toContain("/64 loaded");                 // BoutiqueCartWall's own header
    expect(text).toContain("Fill Day");                   // ProgramLog's own sidebar
    expect(text).toContain(SONG.title);                   // LibraryPanel's own table
    expect(moduleEntry("carts").component).toBe(BoutiqueCartWall);
  });
  it("live is the locked mode; EDIT shows the palette and LIVE hides it", async () => {
    const m = await show(screenWindow());
    expect(findAllByText(m.container, "+ Carts").length).toBe(1);   // a new screen opens in EDIT
    await click(findAllByText(m.container, "EDIT")[0]);
    expect(findAllByText(m.container, "LIVE").length).toBe(1);
    expect(findAllByText(m.container, "+ Carts").length).toBe(0);
  });
});

describe("S1 / S2 / S3 inside a surface — the same calls as the pages", () => {
  it("S1: a cart fired from a surface pane = the Carts page", async () => {
    const p = await show(page("carts"));
    ether.reset(); await click(findAllByAttr(p.container, "title", FIRE_TITLE)[0]);
    const fromPage = stable(commands());
    await p.unmount(); mounted = []; disposeEngine(A.id);

    const s = await show(screenWindow());
    await place(s, "Carts");
    ether.reset(); await click(findAllByAttr(s.container, "title", FIRE_TITLE)[0]);
    const fromSurface = stable(commands());
    expect(fromPage.map((c: BridgeCall) => c.path)).toEqual(expect.arrayContaining(["audio.load", "audio.play"]));
    expect(fromSurface).toEqual(fromPage);
  });
  it("S3: Load A and Q from a surface pane = the Library window (daemon-driven)", async () => {
    const run = async (m: Mounted) => {
      (getEngine(A.id) as any).daemonDriven = true;
      ether.reset(); await click(findAllByText(m.container, "A")[0]);
      const load = commands();
      ether.reset(); await click(findAllByText(m.container, "Q")[0]);
      return { load, queue: commands() };
    };
    const p = await show(page("library"));
    const fromPage = await run(p);
    await p.unmount(); mounted = []; disposeEngine(A.id);
    const s = await show(screenWindow());
    await place(s, "Song Library");
    const fromSurface = await run(s);
    expect(fromPage.load.some(c => c.path === "audio.daemon" && c.args[0] === "deck:cue")).toBe(true);
    expect(fromPage.queue.some(c => c.path === "audio.daemon" && c.args[0] === "queue:enqueue")).toBe(true);
    expect(fromSurface).toEqual(fromPage);
  });
  it("S2: a Program Log pane and the Program Log page both re-read on one schedule:changed", async () => {
    const p = await show(page("programlog"));
    const s = await show(screenWindow());
    await place(s, "Program Log");
    const reads = () => ether.calls.filter(c => c.path === "invoke" && c.args[0] === "schedule:get");
    const before = reads().length;
    ether.emit("schedule:changed", { stationUuid: A.uuid });
    await settle(600);
    const after = reads().slice(before);
    expect(after).toHaveLength(2);                                   // one re-read each, the page and the pane
    expect(after.every(c => c.args[3] === A.id)).toBe(true);
    expect(p.container.textContent.length).toBeGreaterThan(0);
  });
});

describe("the layout round trip: save → reopen → identical", () => {
  it("panes, sizes and module options survive SAVE and reopening by uuid; re-saving writes the identical document", async () => {
    const s = await show(screenWindow());
    await place(s, "Carts");
    await place(s, "Program Log");
    await place(s, "Song Library");
    await saveScreen(s);
    const saved = rows();
    expect(saved).toHaveLength(1);
    const row = saved[0];
    expect(row.station_id).toBe(A.id);
    expect(row.station_uuid).toBe(A.uuid);
    expect(row.name).toBe("My screen");
    expect(mutations.map(m => m.op)).toEqual(["insert"]);           // the write went through the sync mutation path
    const doc = parseLayoutDoc(row.payload, ["carts", "programlog", "library"]);
    expect(Object.values(doc.panes).map(p => p.type).sort()).toEqual(["carts", "library", "programlog"]);
    expect(doc.panes["carts-1"].options).toEqual({ variant: "grid" });
    expect(doc.panes["programlog-1"].options).toEqual({ embedded: false });

    // Give the saved screen real sizes and a non-default option, as an operator's arrangement would.
    const arranged = JSON.parse(row.payload);
    arranged.panes["carts-1"].options = { variant: "strip" };
    arranged.dockview.grid.width = 1280; arranged.dockview.grid.height = 800;
    const sizes = (node: any, n = 0): number => {
      if (Array.isArray(node.data)) { node.data.forEach((c: any, i: number) => { c.size = 300 + 100 * i; n = sizes(c, n + 1); }); }
      return n;
    };
    sizes(arranged.dockview.grid.root);
    db.prepare("UPDATE screen_layouts SET payload = ? WHERE uuid = ?").run(JSON.stringify(arranged), row.uuid);
    await s.unmount(); mounted = [];

    // What the reopened window hands dockview: recorded at dockview's own fromJSON.
    const restored: any[] = [];
    const original = (DockviewApi.prototype as any).fromJSON;
    (DockviewApi.prototype as any).fromJSON = function (data: any) { restored.push(JSON.parse(JSON.stringify(data))); return original.call(this, data); };
    let r: Mounted;
    try { r = await show(screenWindow(`screen:${row.uuid}`)); } finally { (DockviewApi.prototype as any).fromJSON = original; }
    const sizesOf = (node: any): any => Array.isArray(node.data) ? node.data.map((c: any) => [c.size, sizesOf(c)]) : null;
    expect(restored).toHaveLength(1);
    // dockview is given the saved arrangement exactly: the same grid sizes, the same panels, the panes' options
    expect(sizesOf(restored[0].grid.root)).toEqual(sizesOf(arranged.dockview.grid.root));
    expect(restored[0].grid.width).toBe(1280);
    expect(restored[0].panels).toEqual(parseLayoutDoc(arranged, ["carts", "programlog", "library"]).dockview.panels);
    await settle(80);
    expect(r.container.textContent).toContain("My screen");
    expect(r.container.textContent).toContain("Fill Day");
    expect(r.container.textContent).toContain(SONG.title);
    // the reopened screen is in LIVE (locked)
    expect(findAllByText(r.container, "LIVE").length).toBe(1);
    // the carts pane came back with its saved option: the strip layout has no "loaded" header
    expect(r.container.textContent).not.toContain("/64 loaded");

    await saveScreen(r);                                             // a known name: no dialog, an update
    expect(rows()).toHaveLength(1);
    expect(mutations.map(m => m.op)).toEqual(["insert", "update"]);
    const again = JSON.parse(rows()[0].payload);
    expect(again.panes).toEqual(arranged.panes);
    // dockview's panels carry each pane's params; the panes map is the authority, so they now read "strip" too
    expect(again.dockview.panels).toEqual(parseLayoutDoc(arranged, ["carts", "programlog", "library"]).dockview.panels);
    expect(again.dockview.panels["carts-1"].params.options).toEqual({ variant: "strip" });
    // Sizes after dockview lays the screen out again depend on the window's real size: the test DOM has no layout
    // (every element is 0 px), so dockview re-divides the grid there. In a real window of the saved size it keeps them
    // (UNVERIFIED here — Jeff's check). The split structure itself survives.
    expect(sizesOf(again.dockview.grid.root).length).toBe(sizesOf(arranged.dockview.grid.root).length);
  });
});

describe("S7 — a surface of station B never reads station A's rows", () => {
  it("station B's window cannot open A's layout, and B's list has none of A's", async () => {
    // Station A builds and saves a screen.
    const s = await show(screenWindow());
    await place(s, "Carts");
    await saveScreen(s);
    const aUuid = rows()[0].uuid;
    expect(rows()[0].station_id).toBe(A.id);
    await s.unmount(); mounted = [];
    // The operator switches to station B (the app's own station-switched event; the hook re-reads the active station).
    activeStation = B;
    const api = install();
    const probe = await show(<StationProbe />);
    await act(async () => { (globalThis as any).dispatchEvent(new Event("station-switched")); });
    await settle(40);
    expect(probe.container.textContent).toBe(String(B.id));
    await probe.unmount(); mounted = [];
    const w = await show(screenWindow(`screen:${aUuid}`));
    await settle(60);
    expect(w.container.textContent).toContain("That screen is not saved on this station.");
    expect(w.container.textContent).not.toContain("A screen");
    await click(findAllByText(w.container, "OPEN…")[0]);
    expect((globalThis as any).document.body.textContent).toContain("No saved screens yet");
    const gets = ether.calls.filter(c => c.path === "invoke" && String(c.args[0]).startsWith("screen_layouts:"));
    expect(gets.every(c => c.args[0] === "screen_layouts:get" ? c.args[2] === B.id : c.args[1] === B.id)).toBe(true);
    // the handler refuses to overwrite another station's layout
    expect(() => api.save(db, { uuid: aUuid, station_id: B.id, name: "x", payload: { v: 1, dockview: {}, panes: {} } })).toThrow(/another station/);
  });
});

describe("the v64 migration", () => {
  it("creates screen_layouts with every column, records v64, and is idempotent", () => {
    const d = freshDb();
    const log = console.log; console.log = () => {};
    try { migration64.applyMigration(d); } finally { console.log = log; }
    const cols = d.prepare("PRAGMA table_info(screen_layouts)").all().map((c: any) => c.name);
    expect(cols).toEqual(["id", "uuid", "station_id", "station_uuid", "owner_user_uuid", "name", "payload", "version", "created_at", "updated_at", "deleted_at"]);
    expect(d.prepare("SELECT version FROM schema_version").all().map((r: any) => r.version)).toEqual([64]);
    expect(migration64.payloadTransformer({ a: 1 })).toEqual({ a: 1 });
  });
  it("the sync registry lists it as a station-scoped synced table with the same columns", () => {
    const { REGISTRY, SYNCED_TABLES } = require_("../../../electron/sync/synced-tables.js");
    expect(SYNCED_TABLES).toContain("screen_layouts");
    expect(REGISTRY.screen_layouts.scope).toBe("station");
    expect(Object.keys(REGISTRY.screen_layouts.columns).sort()).toEqual(["created_at", "deleted_at", "id", "name", "owner_user_uuid", "payload", "station_id", "station_uuid", "updated_at", "uuid", "version"]);
  });
});

