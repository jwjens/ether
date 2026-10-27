// A failed save shows an error instead of silently bouncing back (Jeff, 2026-10-26; InlineNameEditor.tsx). Before, the
// editor closed in a `finally` whatever happened, so a refused save ({ ok:false } from songs:update-by-id) or a thrown one
// put the old name back on screen with no word. Through the real component.
import "../modules/proof/miniDom";
import "../modules/proof/inputEvents";
import { describe, it, expect, afterEach } from "vitest";
import React, { act } from "react";
import { mount, settle, click, type Mounted } from "../modules/proof/render";
import { findAllByText, fire } from "../modules/proof/miniDom";
import InlineNameEditor from "./InlineNameEditor";

let m: Mounted | null = null;
afterEach(async () => { if (m) await m.unmount(); m = null; });

const inputOf = (root: any): any => {
  const out: any[] = [];
  const walk = (n: any) => { if (!n) return; if (String(n.tagName || "").toLowerCase() === "input") out.push(n); for (const c of n.childNodes || []) walk(c); };
  walk(root); return out[0] || null;
};
const button = (root: any, text: string) => findAllByText(root, text).find((n: any) => String(n.tagName || "").toLowerCase() === "button");
async function editTo(root: any, next: string) {
  await click(button(root, "EDIT"));
  const inp = inputOf(root);
  await act(async () => { inp.value = next; fire(inp, "input"); });
  await settle();
  await click(button(root, "SAVE"));
  await settle();
}

describe("InlineNameEditor — a failed save is shown, never a silent bounce", () => {
  it("a refused save ({ ok:false, error }) keeps the field open with what was typed, and says why", async () => {
    let got: string | null = null;
    m = await mount(<InlineNameEditor value="Deck the Halls" onSave={async (n) => { got = n; return { ok: false, error: "song 544 not found" }; }} />);
    await editTo(m.container, "Deck The Halls (Live)");
    expect(got).toBe("Deck The Halls (Live)");
    expect(inputOf(m.container)).not.toBeNull();                                   // still editing
    expect(inputOf(m.container).value).toBe("Deck The Halls (Live)");             // what was typed is kept
    expect(findAllByText(m.container, "Not saved: song 544 not found").length).toBeGreaterThan(0);
  });

  it("a save that throws is shown the same way", async () => {
    m = await mount(<InlineNameEditor value="A" onSave={async () => { throw new Error("database is locked"); }} />);
    await editTo(m.container, "B");
    expect(inputOf(m.container)).not.toBeNull();
    expect(findAllByText(m.container, "Not saved: database is locked").length).toBeGreaterThan(0);
  });

  it("a save that succeeds closes the editor, and CANCEL clears an error", async () => {
    m = await mount(<InlineNameEditor value="A" onSave={async () => ({ ok: true })} />);
    await editTo(m.container, "B");
    expect(inputOf(m.container)).toBeNull();
    await m.unmount();
    m = await mount(<InlineNameEditor value="A" onSave={async () => ({ ok: false, error: "no" })} />);
    await editTo(m.container, "B");
    await click(button(m.container, "CANCEL")); await settle();
    expect(inputOf(m.container)).toBeNull();
    expect(findAllByText(m.container, "Not saved: no").length).toBe(0);
  });
});

// The callers hand the refusal back, and the Library's artist / album / year / genre / BPM cells show theirs too
// (discogs:updateTrack refuses, e.g. "set the album first" for a year on a song with no album — it used to bounce).
import fs from "fs";
import path from "path";
describe("the Library's saves report a refusal instead of bouncing back", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
  const sw = fs.readFileSync(path.join(__dirname, "SweepersPanel.tsx"), "utf8");
  it("title saves return the songs:update-by-id result to the editor", () => {
    expect(app).toMatch(/const r = await \(window as any\)\.ether\.songs\.updateById\(s\.id, \{ title: next \}\); if \(r\?\.ok !== false\) load\(\); return r;/);
    expect(sw).toMatch(/const r = await ether\(\)\?\.songs\?\.updateById\(x\.id, \{ title: next \}\); if \(r\?\.ok !== false\) reload\(\); return r;/);
  });
  it("a refused cell edit keeps the cell open with the reason shown above the grid", () => {
    const c = app.slice(app.indexOf("const commitInline = async"), app.indexOf("const commitMetaEdit"));
    expect(c).toMatch(/r = await \(window as any\)\.ether\.discogs\.updateTrack\(payload\)/);
    expect(c).toMatch(/if \(r && r\.ok === false\) \{\s*setInlineEdit\(\{ id, col, value, error:/);
    expect(c.indexOf("setInlineEdit(null);\n    await load();")).toBeGreaterThan(c.indexOf("r.ok === false"));   // closes only after success
    expect(app).toMatch(/\{inlineEdit\?\.error && \(\s*<div role="alert"/);
  });
});
