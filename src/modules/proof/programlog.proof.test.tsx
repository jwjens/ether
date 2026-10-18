// PROOF — the Program Log module (docs/screen-builder-design-2026-10-18.md §3: S2; §2.4; §2.7 empty state).
//
//   S2  two Program Log modules on one surface plus the Program Log page (the pop-out PopoutRenderer "programlog"):
//       an edit (delete a row) made in one module shows in every instance after ONE schedule:changed — and the write
//       it makes is the exact bridge call the page's own edit makes.
//
// The component is the app's own ProgramLog (via the registry). window.ether is a recording stub holding a small
// fake generated_schedule; schedule:deleteRow soft-deletes in it, and the test plays main's schedule:changed.
import "./miniDom";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { installEther, type EtherStub } from "./etherStub";
import { mount, click, settle, type Mounted } from "./render";
import { findAllByAttr, findAllByText } from "./miniDom";
import { AudioEngineProvider } from "../../audio/AudioEngineContext";
import PopoutRenderer from "../../components/PopoutRenderer";
import { CHANGED_DEBOUNCE_MS, PROGRAMLOG_DATE_KEY } from "../../components/ProgramLog";
import { localDateStr } from "../../lib/programLogRows";
import { ModuleSurface, ModuleFrame } from "../ModuleFrame";
import { moduleEntry } from "../registry";

const STATION = { id: 2, name: "Test FM", uuid: "uuid-2" };
const DELETE_TITLE = "Remove this row from the log (the slot refills on the next Fill Day)";

// Tomorrow at 10:00 local: an hour that has not started, so its rows are editable.
const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(10, 0, 0, 0);
const DAY = localDateStr(tomorrow);
const T10 = Math.floor(tomorrow.getTime() / 1000);

let ether: EtherStub;
let mounted: Mounted[] = [];
let rows: any[] = [];

function row(id: number, uuid: string, title: string, at: number) {
  return { id, uuid, scheduled_at: at, song_id: 100 + id, title, artist: "Artist", file_key: null, file_path: `C:\\m\\${uuid}.mp3`,
    duration_s: 200, category_id: null, source: "auto", state: "pending", content_class: "MUSIC", channel: null, played_at: null, deleted: false };
}

function install() {
  ether = installEther({
    "stations.getActive": () => Promise.resolve({ ...STATION }),
    "stations.list": () => Promise.resolve([{ id: STATION.id }]),
    invoke: (channel: string, ...args: any[]) => {
      if (channel === "schedule:get") {
        const [from, to] = args;
        return Promise.resolve({ data: rows.filter(r => !r.deleted && r.scheduled_at >= from && r.scheduled_at < to) });
      }
      if (channel === "schedule:deleteRow") {
        const r = rows.find(x => x.uuid === args[0]);
        if (r) r.deleted = true;
        return Promise.resolve({ ok: !!r });
      }
      return Promise.resolve(null);
    },
  });
}

async function show(el: React.ReactElement) { const m = await mount(el); mounted.push(m); return m; }
const page = () => <AudioEngineProvider gate><PopoutRenderer panel="programlog" /></AudioEngineProvider>;
const logModule = (instanceId: string) => <ModuleFrame type="programlog" instanceId={instanceId} />;

/** Open the hour, then press the row's ✕ — the operator's own gesture. */
async function deleteFirstRow(m: Mounted) {
  await click(findAllByText(m.container, "✎ Edit")[0]);
  const del = findAllByAttr(m.container, "title", DELETE_TITLE);
  expect(del.length, "the hour editor shows a delete for each pending row").toBe(2);
  await click(del[0]);
}
const writes = () => ether.calls.filter(c => c.path === "invoke" && c.args[0] === "schedule:deleteRow");

beforeEach(() => {
  rows = [row(1, "r1", "Song One", T10), row(2, "r2", "Song Two", T10 + 200)];
  (globalThis as any).localStorage.setItem(PROGRAMLOG_DATE_KEY(STATION.id), DAY);
  install();
});
afterEach(async () => {
  for (const m of mounted.reverse()) await m.unmount();
  mounted = [];
});

describe("S2 — log parity: an edit in one Program Log shows in every instance after one schedule:changed", () => {
  it("two modules + the page: delete in module A; B and the page follow on ONE schedule:changed", async () => {
    const pg = await show(page());
    const surface = await show(
      <ModuleSurface station={STATION}>
        <div data-pane="a">{logModule("log-a")}</div>
        <div data-pane="b">{logModule("log-b")}</div>
      </ModuleSurface>
    );
    const [paneA, paneB] = [findAllByAttr(surface.container, "data-pane", "a")[0], findAllByAttr(surface.container, "data-pane", "b")[0]];
    for (const [name, root] of [["page", pg.container], ["A", paneA], ["B", paneB]] as const) {
      await click(findAllByText(root, "Expand All")[0]);
      expect(root.textContent, `${name} shows the day`).toContain("Song One");
    }

    await deleteFirstRow({ container: paneA, unmount: async () => {} });
    expect(writes()).toHaveLength(1);
    // A re-reads after its own edit; B and the page have not been told yet.
    expect(paneA.textContent).not.toContain("Song One");
    expect(paneB.textContent).toContain("Song One");
    expect(pg.container.textContent).toContain("Song One");

    // main.js broadcasts schedule:changed after every generated_schedule write — once.
    const reads = ether.calls.filter(c => c.path === "invoke" && c.args[0] === "schedule:get").length;
    ether.emit("schedule:changed", { stationUuid: STATION.uuid });
    await settle(CHANGED_DEBOUNCE_MS + 150);
    for (const [name, root] of [["page", pg.container], ["A", paneA], ["B", paneB]] as const) {
      expect(root.textContent, `${name} dropped the deleted row`).not.toContain("Song One");
      expect(root.textContent, `${name} kept the other row`).toContain("Song Two");
    }
    // one re-read per instance (debounced per instance), all three on the same station
    const after = ether.calls.filter(c => c.path === "invoke" && c.args[0] === "schedule:get").slice(reads);
    expect(after).toHaveLength(3);
    expect(after.every(c => c.args[3] === STATION.id)).toBe(true);
  });

  it("the module's edit writes exactly what the page's own edit writes", async () => {
    const pg = await show(page());
    await click(findAllByText(pg.container, "Expand All")[0]);
    ether.reset();
    await deleteFirstRow(pg);
    const fromPage = writes();
    await pg.unmount(); mounted = [];

    rows = [row(1, "r1", "Song One", T10), row(2, "r2", "Song Two", T10 + 200)];
    const m = await show(<ModuleSurface station={STATION}>{logModule("log-a")}</ModuleSurface>);
    await click(findAllByText(m.container, "Expand All")[0]);
    ether.reset();
    await deleteFirstRow(m);
    const fromModule = writes();

    expect(fromPage).toEqual([{ path: "invoke", args: ["schedule:deleteRow", "r1"] }]);
    expect(fromModule).toEqual(fromPage);
  });

  it("a schedule:changed for ANOTHER station is ignored by a module of this one", async () => {
    const m = await show(<ModuleSurface station={STATION}>{logModule("log-a")}</ModuleSurface>);
    const reads = () => ether.calls.filter(c => c.path === "invoke" && c.args[0] === "schedule:get").length;
    const before = reads();
    ether.emit("schedule:changed", { stationUuid: "uuid-someone-else" });
    await settle(CHANGED_DEBOUNCE_MS + 150);
    expect(reads()).toBe(before);
    expect(m.container.textContent).toContain("2 tracks");
  });
});

describe("empty state (doors before rooms)", () => {
  it("a Program Log module on a day with nothing shows the registry's empty state", async () => {
    rows = [];
    const m = await show(<ModuleSurface station={STATION}>{logModule("log-empty")}</ModuleSurface>);
    expect(m.container.textContent).toContain(moduleEntry("programlog").empty.text);
  });
});
