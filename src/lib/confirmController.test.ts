// fix 5 (docs/help-audit-2026-09-27.md): Library Delete asked with window.confirm, which silently no-ops in the
// packaged Electron build — so Delete could never run. The replacement is an in-app confirm; this proves the flow:
// "yes" reaches the delete with the right row, "no" (or an abandoned question) never does, and no Library delete path
// still uses the browser confirm.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { createConfirmController } from "./confirmController";

describe("the in-app confirm (audit 5)", () => {
  it("YES → the delete runs with the right row; the question is shown until answered", async () => {
    const ctl = createConfirmController();
    const deleted: number[] = [];
    const row = { id: 42, title: "Song" };
    const run = (async () => { if (await ctl.ask(`Delete ${row.title}?`, { confirmLabel: "Delete", danger: true })) deleted.push(row.id); })();
    expect(ctl.pending()).toEqual({ message: "Delete Song?", confirmLabel: "Delete", danger: true });
    ctl.answer(true);
    await run;
    expect(deleted).toEqual([42]);
    expect(ctl.pending()).toBeNull();
  });

  it("NO → nothing is deleted", async () => {
    const ctl = createConfirmController();
    let deleted = false;
    const run = (async () => { if (await ctl.ask("Delete?")) deleted = true; })();
    ctl.answer(false);
    await run;
    expect(deleted).toBe(false);
  });

  it("a second question replaces an unanswered one, which counts as NO", async () => {
    const ctl = createConfirmController();
    const first = ctl.ask("first?");
    const second = ctl.ask("second?");
    expect(await first).toBe(false);
    ctl.answer(true);
    expect(await second).toBe(true);
  });

  it("no Library delete path uses the browser confirm any more (it no-ops in the packaged build)", () => {
    const app = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
    const lib = app.slice(app.indexOf("export function LibraryPanel("), app.indexOf("function ThreeSlotBar("));
    expect(lib.length).toBeGreaterThan(1000);
    // every place a Library row (or rows) is deleted is gated on the in-app confirm
    for (const needle of ["deleteLibraryRow(row); load()", "deleteLibraryRow(s); load()", "const deleteSelected", "const deleteAll"]) {
      const at = lib.indexOf(needle);
      expect(at, needle).toBeGreaterThan(0);
      const around = lib.slice(Math.max(0, at - 260), at + 220);
      expect(around, needle).toMatch(/askConfirm\(/);
      expect(around, needle).not.toMatch(/(^|[^.\w])confirm\(/);
    }
  });
});

// REGRESSION (Jeff's screen, 2026-09-27): Library → right-click → Delete threw "Maximum update depth exceeded" and the
// renderer crashed to the error screen. ConfirmDialog reads the controller through useSyncExternalStore, whose
// getSnapshot MUST return the same reference until the store changes; pending() built a fresh object on every call, so
// React saw a new snapshot on every render and re-rendered forever the moment a question was pending.
describe("the confirm snapshot is stable (useSyncExternalStore contract)", () => {
  it("pending() returns the SAME object on every read until the question changes", async () => {
    const ctl = createConfirmController();
    expect(ctl.pending()).toBe(ctl.pending());               // null === null
    const p = ctl.ask("Delete Song?", { confirmLabel: "Delete", danger: true });
    const a = ctl.pending(), b = ctl.pending();
    expect(a).not.toBeNull();
    expect(a).toBe(b);                                        // the loop: a fresh object here re-renders forever
    const second = ctl.ask("Delete Other?");
    expect(ctl.pending()).not.toBe(a);                        // a new question IS a new snapshot
    expect(ctl.pending()).toBe(ctl.pending());
    ctl.answer(false);
    expect(await p).toBe(false);
    expect(await second).toBe(false);
    expect(ctl.pending()).toBeNull();
  });
  it("simulated useSyncExternalStore: a render loop that re-reads the snapshot settles after one pass", () => {
    const ctl = createConfirmController();
    void ctl.ask("Delete?");
    // React re-renders while getSnapshot keeps changing; bail out like React does at 50 nested updates.
    let renders = 0, last = ctl.pending();
    for (;;) { renders++; const next = ctl.pending(); if (Object.is(next, last)) break; last = next; if (renders > 50) break; }
    expect(renders).toBe(1);
    ctl.answer(false);
  });
});

describe("ConfirmDialog reads the stable snapshot (no DOM here, so a source guard)", () => {
  it("getSnapshot is the controller's pending(), never an inline function that builds a value", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "components", "ConfirmDialog.tsx"), "utf8");
    expect(src).toMatch(/useSyncExternalStore\(ctl\.subscribe, ctl\.pending, ctl\.pending\)/);
    const ctlSrc = fs.readFileSync(path.join(__dirname, "confirmController.ts"), "utf8");
    expect(ctlSrc).toMatch(/pending: \(\) => snapshot,/);
  });
});
