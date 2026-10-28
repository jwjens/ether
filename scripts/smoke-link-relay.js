// Usage: ELECTRON_RUN_AS_NODE=1 npx electron scripts/smoke-link-relay.js   (ETHER_BACKEND_DIR = the ether-backend checkout; default C:/ether-backend)
// END TO END ON OVEVENTS, THROUGH THE RELAY: the real relay program (ether-backend relay/ether-relay.js) running
// locally, tickets signed exactly as the backend signs them (relay/ticket.js), and the freshly built engine with two
// isolated stations — 9102 sends its programme, 9101 takes it on fader S1 — with NO address of each other: only the relay.
// Then a forged ticket: nothing gets through. Run under Electron's Node (the engine is built for it).
"use strict";
const fs = require("fs"), path = require("path");
const dll = "C:/openair/native/target/release/ether_audio.dll";
const node = path.join(require("os").tmpdir(), "ether-relay-e2e-engine.node");
fs.copyFileSync(dll, node);
const A = require(node);
const { createRelay } = require(path.join(process.env.ETHER_BACKEND_DIR || "C:/ether-backend", "relay", "ether-relay.js"));
const { signTicket } = require(path.join(process.env.ETHER_BACKEND_DIR || "C:/ether-backend", "relay", "ticket.js"));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const SECRET = require("crypto").randomBytes(24).toString("hex");
const UUID = "11111111-2222-4333-8444-555555555555";
const RX_MACHINE = "rx-machine-0001", TX_MACHINE = "tx-machine-0002";
const KEY = A.audioLinkMintKey();
const TAG = require("crypto").randomBytes(8).toString("hex");
const st = (sid) => JSON.parse(A.audioLinkState(sid));

(async () => {
  const relay = createRelay({ secret: SECRET, port: 0, host: "127.0.0.1", log: (m) => console.log(m) });
  const port = await relay.start();
  const ticket = signTicket(SECRET, { sessionHex: TAG, sender: TX_MACHINE, receiver: RX_MACHINE, expiresAt: Date.now() + 3600000 });
  const relayCfg = JSON.stringify({ host: "127.0.0.1", port, tag: TAG, ticket });
  A.audioLinkSetPort(39770);
  console.log("input :", A.audioSetLinkInput(9101, "S1", UUID, KEY, 1, 120, `${RX_MACHINE}|${TX_MACHINE}`, relayCfg));
  await sleep(1500);
  // The sender is given NO usable address: host/port are ignored when a relay is set.
  console.log("send  :", A.audioSetLinkSend(9102, UUID, KEY, 1, "", 0, 128000, true, `${RX_MACHINE}|${TX_MACHINE}`, relayCfg));
  await sleep(6000);
  const rx = st(9101).rx, tx = st(9102).tx;
  console.log("RX    :", JSON.stringify({ state: rx.state, transport: rx.transport, sender: rx.sender, latencyMs: rx.latencyMs, received: rx.received ?? rx.packets, lost: rx.lost, authFailures: rx.authFailures, reason: rx.reason }));
  console.log("TX    :", JSON.stringify({ state: tx.state, transport: tx.transport, rttMs: tx.rttMs, framesSent: tx.framesSent, reason: tx.reason }));
  console.log("RELAY :", JSON.stringify(relay.snapshot()));

  // A FORGED ticket for a second sender on the same session: never forwarded.
  const before = relay.snapshot().forwarded;
  const forged = JSON.stringify({ host: "127.0.0.1", port, tag: TAG, ticket: signTicket("not-the-secret-not-the-secret-123456", { sessionHex: TAG, sender: "evil", receiver: RX_MACHINE, expiresAt: Date.now() + 3600000 }) });
  A.audioSetLinkSend(9102, "", "", 0, "", 0, 0, false, "", null);   // the real sender stops
  await sleep(1500);
  console.log("forged:", A.audioSetLinkSend(9103, UUID, KEY, 1, "", 0, 128000, true, `${RX_MACHINE}|${TX_MACHINE}`, forged));
  await sleep(3000);
  const snap = relay.snapshot();
  console.log("FORGED:", JSON.stringify({ forwardedSince: snap.forwarded - before, dropped: snap.dropped, txState: st(9103).tx.state, txReason: st(9103).tx.reason }));
  A.audioSetLinkSend(9103, "", "", 0, "", 0, 0, false, "", null);
  A.audioSetLinkInput(9101, "S1", "", "", 0, 0, "", null);
  await relay.stop();
  process.exit(0);
})().catch(e => { console.error("E2E ERROR", e); process.exit(1); });
