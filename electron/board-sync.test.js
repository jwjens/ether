// main's half of the board (electron/board-sync.js). The race of 2026-10-11, replayed: the WINDOW loads and sends its
// board before the engine is connected; every value must still arrive, and a mismatch must be named.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const S = require_("./board-sync.js");

// A fake daemon: rejects until connected, then records every command into its own "engine" state.
function fakeDaemon() {
  const d = { connected: false, engine: {}, log: [] };
  d.cmd = async (c, a) => {
    if (!d.connected) throw new Error("daemon not connected");
    d.log.push([c, a]);
    if (c === "setAuxMonitor") d.engine[`${a.deck}.aux`] = a.gain;
    if (c === "setVolume") d.engine[`${a.deck}.volume`] = a.volume;
    if (c === "applySavedBoard") { d.engine["S1.aux"] = d.engine["S1.aux"] ?? 0.74; return [{ ok: true, stationId: 2, sent: ["S1.aux"], failed: [] }]; }
    if (c === "getBoardState") return { ok: true, live: { ...d.engine } };
    return true;
  };
  return d;
}

describe("boardSend — never swallowed", () => {
  it("THE RACE: the window sends before the engine is connected → queued, logged, and delivered on connect", async () => {
    const d = fakeDaemon();
    const logs = [];
    const q = S.createBoardQueue({ log: (m) => logs.push(m) });
    const r = await S.boardSend({ cmd: "setAuxMonitor", args: { stationId: 2, deck: "E", gain: 0.83 }, daemonActive: true, daemonWanted: true, toDaemon: d.cmd, queue: q });
    expect(r).toBe(false);
    expect(q.size()).toBe(1);
    expect(logs.join("\n")).toMatch(/setAuxMonitor E s2 queued .*daemon not connected/);
    d.connected = true;
    await S.syncBoardOnConnect({ cmd: d.cmd, queue: q, stations: () => [2], readSaved: () => ({}), compare: () => [], onMismatch: () => {} });
    expect(d.engine["E.aux"]).toBe(0.83);
    expect(q.size()).toBe(0);
  });

  it("IN-PROCESS FALLBACK: the in-process engine gets it now AND the daemon gets it at handover", async () => {
    const d = fakeDaemon();
    const q = S.createBoardQueue({});
    let inProc = null;
    const r = await S.boardSend({ cmd: "setVolume", args: { stationId: 2, deck: "S1", volume: 0.6 }, daemonActive: false, daemonWanted: true,
      toDaemon: d.cmd, inProcess: () => { inProc = 0.6; return true; }, queue: q });
    expect(r).toBe(true);
    expect(inProc).toBe(0.6);
    expect(q.size()).toBe(1);
    d.connected = true;
    await S.syncBoardOnConnect({ cmd: d.cmd, queue: q, stations: () => [2], readSaved: () => ({}), compare: () => [], onMismatch: () => {} });
    expect(d.engine["S1.volume"]).toBe(0.6);
  });

  it("a drag is one queued value, the last one", async () => {
    const q = S.createBoardQueue({});
    for (const v of [0.1, 0.2, 0.3]) await S.boardSend({ cmd: "setVolume", args: { stationId: 2, deck: "E", volume: v }, daemonActive: false, daemonWanted: true, inProcess: () => true, queue: q });
    expect(q.entries()).toEqual([{ cmd: "setVolume", args: { stationId: 2, deck: "E", volume: 0.3 }, reason: "the app is on its in-process fallback" }]);
  });

  it("daemon off by choice: nothing is queued", async () => {
    const q = S.createBoardQueue({});
    await S.boardSend({ cmd: "setVolume", args: { stationId: 2, deck: "E", volume: 0.3 }, daemonActive: false, daemonWanted: false, inProcess: () => true, queue: q });
    expect(q.size()).toBe(0);
  });
});

describe("syncBoardOnConnect", () => {
  it("applies the saved board, then the queue (newer wins), then reads back and names any mismatch", async () => {
    const d = fakeDaemon(); d.connected = true;
    const q = S.createBoardQueue({});
    q.enqueue("setAuxMonitor", { stationId: 2, deck: "S1", gain: 0.5 }, "test");
    const seen = [];
    const v = await S.syncBoardOnConnect({ cmd: d.cmd, queue: q, stations: () => [2],
      readSaved: () => ({ want: 0.74 }),
      compare: (saved, live) => (live.live["S1.aux"] === saved.want ? [] : [{ setting: "S1.aux", saved: saved.want, live: live.live["S1.aux"], where: "control" }]),
      onMismatch: (sid, diffs) => seen.push([sid, diffs]) });
    // apply, then the queue, then the read-back — re-read before a mismatch is called (4 reads for a lasting one)
    expect(d.log.map(x => x[0])).toEqual(["applySavedBoard", "setAuxMonitor", "getBoardState", "getBoardState", "getBoardState", "getBoardState"]);
    expect(d.engine["S1.aux"]).toBe(0.5);   // the window's later change won over the saved value…
    expect(seen).toEqual([[2, [{ setting: "S1.aux", saved: 0.74, live: 0.5, where: "control" }]]]);   // …and the difference is named
    expect(v[0].mismatches.length).toBe(1);
  });

  it("a failed re-apply is said, and the pass still reads back", async () => {
    const d = fakeDaemon(); d.connected = true;
    const orig = d.cmd; d.cmd = async (c, a) => { if (c === "applySavedBoard") throw new Error("boom"); return orig(c, a); };
    const logs = [];
    await S.syncBoardOnConnect({ cmd: d.cmd, queue: S.createBoardQueue({}), stations: () => [2], readSaved: () => ({}), compare: () => [], onMismatch: () => {}, log: (m) => logs.push(m) });
    expect(logs.join("\n")).toMatch(/NOT re-applied on connect ✗ boom/);
    expect(logs.join("\n")).toMatch(/s2 live board matches/);
  });
});
