// The "move to the catalogue" pop-up (Jeff, 2026-10-27; CatalogueMovePrompt.tsx): it lists the files that are not in the
// catalogue and asks Yes / No. No changes nothing; only Yes reaches catalogue:move-in. Through the real component.
import "../modules/proof/miniDom";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import React from "react";
import { mount, settle, click, type Mounted } from "../modules/proof/render";
import { findAllByText } from "../modules/proof/miniDom";
import CatalogueMovePrompt, { _resetAnsweredForTest, toAsk, type NotInCatalogueFile } from "./CatalogueMovePrompt";

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
    invoke: async (ch: string, ...args: any[]): Promise<any> => {
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

// "Download missing files into the catalogue automatically" (Preferences, 2026-10-27). On: a file that is not on this
// computer and has a cloud copy downloads by itself and is not asked about. Off: everything is asked about.
describe("CatalogueMovePrompt — the automatic-download switch", () => {
  const withSwitch = (on: boolean) => {
    const f = fakeApi(FILES);
    const inner = f.api.invoke;
    f.api.invoke = async (ch: string, ...a: any[]) => ch === "catalogue:auto-download:get" ? { ok: true, on } : inner(ch, ...a);
    return f;
  };
  it("on: the file not on this computer (cloud copy) is not asked about; the one stored elsewhere still is", async () => {
    const f = withSwitch(true);
    m = await mount(<CatalogueMovePrompt api={f.api} />); await settle();
    expect(findAllByText(m.container, QUESTION).length).toBe(1);
    expect(findAllByText(m.container, "Outside.mp3").length).toBe(1);
    expect(findAllByText(m.container, "Cloud.mp3").length).toBe(0);
  });
  it("on, and the only file is downloadable: no pop-up at all", async () => {
    const f = withSwitch(true);
    const inner = f.api.invoke;
    f.api.invoke = async (ch: string, ...a: any[]) => ch === "library-health:get" ? { notInCatalogue: { files: [FILES[1]] } } : inner(ch, ...a);
    m = await mount(<CatalogueMovePrompt api={f.api} />); await settle();
    expect(findAllByText(m.container, QUESTION).length).toBe(0);
  });
  it("off: both are asked about", async () => {
    const f = withSwitch(false);
    m = await mount(<CatalogueMovePrompt api={f.api} />); await settle();
    expect(findAllByText(m.container, "Cloud.mp3").length).toBe(1);
    expect(findAllByText(m.container, "Outside.mp3").length).toBe(1);
  });
  it("the pop-up and main split files by the same rule", () => {
    const M = require("../../electron/catalogue-moves");
    const sample: NotInCatalogueFile[] = [...FILES,
      { key: "path:C:\gone.mp3", file: "C:\gone.mp3", name: "gone.mp3", state: "missing", fileKey: null, rows: [] }];
    for (const on of [true, false]) expect(toAsk(sample, on).map(x => x.key)).toEqual(M.splitByAutoDownload(sample, on).ask.map((x: any) => x.key));
  });
});

describe("Preferences carries the switch", () => {
  it("Catalogue Folder & Sync has \"Download missing files into the catalogue automatically\", saved through catalogue:auto-download:set", () => {
    const fs = require("fs"), path = require("path");
    const src: string = fs.readFileSync(path.join(__dirname, "SettingsPanel.tsx"), "utf8");
    const section = src.slice(src.indexOf("function MusicFolderSection"), src.indexOf("export default function SettingsPanel"));
    expect(section).toMatch(/<Toggle value=\{autoDl\} onChange=\{toggleAutoDl\} label="Download missing files into the catalogue automatically" \/>/);
    expect(section).toMatch(/invoke\("catalogue:auto-download:set", v\)/);
    expect(section).toMatch(/invoke\("catalogue:auto-download:get"\)/);
  });
});
