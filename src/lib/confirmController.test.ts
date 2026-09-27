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
