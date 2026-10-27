// The "move to the catalogue" pop-up (Jeff, 2026-10-27; CatalogueMovePrompt.tsx): it lists the files that are not in the
// catalogue and asks Yes / No. No changes nothing; only Yes reaches catalogue:move-in. Through the real component.
import "../modules/proof/miniDom";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import React from "react";
import { mount, settle, click, type Mounted } from "../modules/proof/render";
import { findAllByText } from "../modules/proof/miniDom";
import CatalogueMovePrompt, { _resetAnsweredForTest, type NotInCatalogueFile } from "./CatalogueMovePrompt";

let m: Mounted | null = null;
afterEach(async () => { if (m) await m.unmount(); m = null; });
beforeEach(() => _resetAnsweredForTest());

const FILES: NotInCatalogueFile[] = [
  { key: "path:D:\\Downloads\\Outside.mp3", file: "D:\\Downloads\\Outside.mp3", name: "Outside.mp3", state: "elsewhere", fileKey: null, rows: [{ table: "songs", id: 2, title: "Outside" }] },
  { key: "path:C:\\Users\\projector\\Music\\Cloud.mp3", file: "C:\\Users\\projector\\Music\\Cloud.mp3", name: "Cloud.mp3", state: "missing", fileKey: "Cloud.mp3", rows: [{ table: "songs", id: 3, title: "Cloud" }] },
];
const QUESTION = "These files need to be moved to the catalogue. Do you want to do that now?";
const button = (root: any, text: string) => findAllByText(root, text).find((n: any) => String(n.tagName || "").toLowerCase() === "button");

function fakeApi(files: NotInCatalogueFile[]) {
  const calls: { ch: string; args: any[] }[] = [];
  let listener: ((s: any) => void) | null = null;
  const api = {
    invoke: async (ch: string, ...args: any[]) => {
      calls.push({ ch, args });
      if (ch === "library-health:get") return { notInCatalogue: { files } };
      if (ch === "catalogue:move-in") return { ok: true, results: args[0].map((f: any) => ({ key: f.key, name: f.name, ok: true, action: "moved", to: "C:\\cat\\" + f.name, reason: null, note: null })) };
      return null;
    },
    on: (_ch: string, cb: (s: any) => void) => { listener = cb; return cb; },
    off: () => { listener = null; },
  };
  return { api, calls, sweep: (s: any) => listener && listener(s) };
}

describe("CatalogueMovePrompt — nothing moves without the Yes", () => {
  it("lists the files not in the catalogue and asks", async () => {
    const f = fakeApi(FILES);
    m = await mount(<CatalogueMovePrompt api={f.api} />); await settle();
    expect(findAllByText(m.container, QUESTION).length).toBe(1);
    expect(findAllByText(m.container, "Outside.mp3").length).toBe(1);
    expect(findAllByText(m.container, "Cloud.mp3").length).toBe(1);
  });

  it("No: closes, and nothing is moved or changed", async () => {
    const f = fakeApi(FILES);
    m = await mount(<CatalogueMovePrompt api={f.api} />); await settle();
    await click(button(m.container, "No")); await settle();
    expect(findAllByText(m.container, QUESTION).length).toBe(0);
    expect(f.calls.some(c => c.ch === "catalogue:move-in")).toBe(false);
    // The next sweep finds the same files: not asked again this session.
    f.sweep({ notInCatalogue: { files: FILES } }); await settle();
    expect(findAllByText(m.container, QUESTION).length).toBe(0);
  });

  it("Yes: asks main to move exactly the listed files, then shows what happened", async () => {
    const f = fakeApi(FILES);
    m = await mount(<CatalogueMovePrompt api={f.api} />); await settle();
    await click(button(m.container, "Yes")); await settle();
    const moves = f.calls.filter(c => c.ch === "catalogue:move-in");
    expect(moves.length).toBe(1);
    expect(moves[0].args[0].map((x: any) => x.key)).toEqual(FILES.map(x => x.key));
    expect(findAllByText(m.container, "2 of 2 files are in the catalogue now.").length).toBe(1);
  });

  it("a new file brings it back; Re-sync's list is always shown", async () => {
    const f = fakeApi(FILES);
    m = await mount(<CatalogueMovePrompt api={f.api} />); await settle();
    await click(button(m.container, "No")); await settle();
    const NEW = { ...FILES[0], key: "path:D:\\Downloads\\New.mp3", file: "D:\\Downloads\\New.mp3", name: "New.mp3" };
    f.sweep({ notInCatalogue: { files: [...FILES, NEW] } }); await settle();
    expect(findAllByText(m.container, QUESTION).length).toBe(1);
    await click(button(m.container, "No")); await settle();
    window.dispatchEvent(new CustomEvent("ether:catalogue-prompt", { detail: { files: [FILES[1]] } })); await settle();
    expect(findAllByText(m.container, QUESTION).length).toBe(1);
    expect(f.calls.some(c => c.ch === "catalogue:move-in")).toBe(false);
  });
});
