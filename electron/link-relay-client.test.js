// The Remote Link through the relay, app side (electron/link-relay-client.js). Jeff, 2026-10-28: "Receiver approves a sender
// the first time only, then remembers it. Typing an address stays as an advanced fallback."
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const { createLinkRelayClient, KEY_APPROVED } = require_("./link-relay-client");

const ST = "11111111-2222-3333-4444-555555555555";
function rig({ send = null, input = null, sessions = [] } = {}) {
  const kv = new Map(), relays = [], calls = [], pairs = [], notes = [];
  let pendingSeen = [];
  const c = createLinkRelayClient({
    fetch: async (url, init) => {
      const p = url.replace(/^.*\/api/, "/api"); calls.push({ p, body: init.body ? JSON.parse(init.body) : null });
      if (p === "/api/link/relay/session") return { status: 200, json: async () => ({ relay_host: "relay.example", relay_port: 9790, tag: "00aa00aa00aa00aa", ticket: "T.sig" }) };
      return { status: 200, json: async () => ({ relay_host: "relay.example", relay_port: 9790, sessions }) };
    },
    baseUrl: "https://x", token: () => "pass", me: () => "m-ov",
    stations: () => [{ id: 2, name: "halloVeen", uuid: ST }],
    readInput: () => input, readSend: () => send,
    readKv: (sid, k) => kv.get(`${sid}|${k}`) || null, writeKv: (sid, k, v) => kv.set(`${sid}|${k}`, v),
    setRelay: async (sid, side, relay) => relays.push({ sid, side, relay }),
    pairWith: async (sid, m) => { pairs.push({ sid, m }); return { ok: true }; },
    note: (e) => notes.push(e), onPending: (l) => { pendingSeen = l; },
  });
  return { c, kv, relays, calls, pairs, notes, pending: () => pendingSeen };
}
const session = (sender, name) => ({ tag: "00bb00bb00bb00bb", sender_machine: sender, sender_name: name, station_uuid: ST, ticket: "R.sig" });

describe("sending", () => {
  it("no typed address → through the relay: a session for that computer and station, handed to the engine", async () => {
    const x = rig({ send: { target: ST, targetMachine: "m-studio", host: "" } });
    await x.c.tickSend();
    expect(x.calls[0]).toEqual({ p: "/api/link/relay/session", body: { sender_machine: "m-ov", receiver_machine: "m-studio", station_uuid: ST } });
    expect(x.relays).toEqual([{ sid: 2, side: "send", relay: JSON.stringify({ host: "relay.example", port: 9790, tag: "00aa00aa00aa00aa", ticket: "T.sig" }) }]);
    await x.c.tickSend();
    expect(x.calls.length).toBe(1, "the ticket is reused until it is due for renewal");
  });
  it("a typed address is the direct path: no relay session at all (the advanced fallback)", async () => {
    const x = rig({ send: { target: ST, targetMachine: "m-studio", host: "203.0.113.7" } });
    await x.c.tickSend();
    expect(x.calls).toEqual([]); expect(x.relays).toEqual([]);
  });
});

describe("receiving: the first time asks, then it remembers", () => {
  it("the computer this fader already takes its feed from joins at once", async () => {
    const x = rig({ input: { slot: "F", from: { machine: "m-venue" } }, sessions: [session("m-venue", "VenueLaptop")] });
    await x.c.tickReceive();
    expect(x.relays.map(r => [r.side, JSON.parse(r.relay).tag])).toEqual([["input", "00bb00bb00bb00bb"]]);
    expect(x.c.pending()).toEqual([]);
  });
  it("any OTHER computer waits for Allow — nothing joins, nothing is re-paired", async () => {
    const x = rig({ input: { slot: "F", from: { machine: "m-venue" } }, sessions: [session("m-stranger", "SomeLaptop")] });
    await x.c.tickReceive();
    expect(x.relays).toEqual([]); expect(x.pairs).toEqual([]);
    expect(x.pending()).toMatchObject([{ stationId: 2, stationName: "halloVeen", senderMachine: "m-stranger", senderName: "SomeLaptop" }]);
  });
  it("Allow once: remembered for the station, the fader takes that computer's key, and it joins; next time no question", async () => {
    const x = rig({ input: { slot: "F", from: { machine: "m-venue" } }, sessions: [session("m-new", "NewLaptop")] });
    await x.c.tickReceive();
    await x.c.approve(2, "m-new");
    expect(JSON.parse(x.kv.get(`2|${KEY_APPROVED}`))).toEqual(["m-new"]);
    expect(x.pairs).toEqual([{ sid: 2, m: "m-new" }]);
    expect(x.relays.at(-1).side).toBe("input");
    expect(x.c.pending()).toEqual([]);
    // a later session from the same computer: no question asked
    const n = x.notes.filter(e => e === "link-relay-approval-needed").length;
    await x.c.tickReceive();
    expect(x.notes.filter(e => e === "link-relay-approval-needed").length).toBe(n);
  });
  it("a station with no fader set to Link takes nothing, from anyone", async () => {
    const x = rig({ input: null, sessions: [session("m-venue", "VenueLaptop")] });
    await x.c.tickReceive();
    expect(x.relays).toEqual([]); expect(x.c.pending()).toEqual([]);
  });
  it("a session that ends releases the fader's relay", async () => {
    const sessions = [session("m-venue", "VenueLaptop")];
    const x = rig({ input: { slot: "F", from: { machine: "m-venue" } }, sessions });
    await x.c.tickReceive();
    expect(x.relays.at(-1).relay).not.toBe(null);
    sessions.length = 0;                       // the server no longer lists it (stopped, or expired)
    await x.c.tickReceive();
    expect(x.relays.at(-1)).toEqual({ sid: 2, side: "input", relay: null });
  });
});
