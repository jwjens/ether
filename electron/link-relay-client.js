// electron/link-relay-client.js — THE REMOTE LINK THROUGH THE RELAY, app side (docs/remote-link-relay-plan-2026-10-28.md).
//
// Jeff, 2026-10-28: machines find each other with no IP addresses or ports; "Receiver approves a sender the first time only,
// then remembers it. Typing an address stays as an advanced fallback."
//
// SENDING: a SEND FEED TO with a computer picked and NO typed address goes through the relay. This asks the backend for the
// session (POST /api/link/relay/session: both machines in this account) and hands the ticket to the audio engine; it renews
// well before the 12 h ticket ends. A typed address is the direct path, exactly as before.
// RECEIVING: every minute it asks which relay sessions are aimed at this computer (GET /api/link/relay/sessions). For a
// station whose fader is set to Link:
//   · the sender is the computer this fader takes its feed from, or one already ALLOWED here → joined at once (the fader
//     is switched to that computer's key if needed);
//   · any other sender → waits for the operator: "Allow <computer> to feed this station?" Allowed once = remembered (the
//     station's link_approved_senders, machine-local). Nothing joins until then.
// Tickets live in memory only (they are not settings). Pure: everything it touches is passed in.
"use strict";

const RENEW_MS = 6 * 3600 * 1000;    // the ticket lasts 12 h; renewed at 6
const KEY_APPROVED = "link_approved_senders";

function createLinkRelayClient({ fetch, baseUrl, token, me, stations, readInput, readSend, readKv, writeKv, setRelay, pairWith,
                                 note = () => {}, onPending = () => {}, now = () => Date.now() }) {
  const sendSessions = new Map();     // station id → { key: "<target>|<machine>", relay, at }
  const inputSessions = new Map();    // station id → relay json applied
  const pending = new Map();          // `${sid}|${senderMachine}` → { stationId, stationName, senderMachine, senderName, tag }

  const approved = (sid) => { try { const a = JSON.parse(readKv(sid, KEY_APPROVED) || "[]"); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };
  const relayJson = (host, port, s) => JSON.stringify({ host, port, tag: s.tag, ticket: s.ticket });
  async function call(method, path, body) {
    const t = token(); if (!t) return { status: 0, body: { error: "not_signed_in" } };
    const r = await fetch(`${baseUrl}${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` }, body: body ? JSON.stringify(body) : undefined });
    let j = {}; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  }

  /** Every station that sends through the relay: make sure the engine has a current ticket. */
  async function tickSend() {
    const m = me(); if (!m) return;
    for (const st of stations()) {
      const s = readSend(st.id);
      const viaRelay = s && !String(s.host || "").trim();
      if (!viaRelay) { if (sendSessions.has(st.id)) { sendSessions.delete(st.id); await setRelay(st.id, "send", null); } continue; }
      const key = `${s.target}|${s.targetMachine}`;
      const cur = sendSessions.get(st.id);
      if (cur && cur.key === key && now() - cur.at < RENEW_MS) continue;
      const r = await call("POST", "/api/link/relay/session", { sender_machine: m, receiver_machine: s.targetMachine, station_uuid: s.target });
      if (r.status === 200 && r.body.ticket) {
        const relay = relayJson(r.body.relay_host, r.body.relay_port, r.body);
        sendSessions.set(st.id, { key, relay, at: now() });
        await setRelay(st.id, "send", relay);
        note("link-relay-session", { stationId: st.id, side: "send", to: s.targetMachineName || s.targetMachine });
      } else note("link-relay-session-refused", { stationId: st.id, side: "send", status: r.status, error: r.body.error || null });
    }
  }

  /** Relay sessions aimed at this computer: join the allowed ones; ask about the rest. */
  async function tickReceive() {
    const m = me(); if (!m) return;
    const r = await call("GET", `/api/link/relay/sessions?machine=${encodeURIComponent(m)}`);
    if (r.status !== 200) return;
    const byUuid = new Map(stations().map(s => [String(s.uuid || "").toLowerCase(), s]));
    const seen = new Set();
    for (const s of r.body.sessions || []) {
      const st = byUuid.get(String(s.station_uuid).toLowerCase());
      const input = st ? readInput(st.id) : null;
      if (!st || !input) continue;                                 // no fader set to Link on that station here
      seen.add(st.id);
      const fromNow = input.from ? String(input.from.machine).toLowerCase() : null;
      const sender = String(s.sender_machine).toLowerCase();
      const ok = fromNow === sender || approved(st.id).includes(sender);
      const pk = `${st.id}|${sender}`;
      if (!ok) {
        if (!pending.has(pk)) {
          pending.set(pk, { stationId: st.id, stationName: st.name, senderMachine: sender, senderName: s.sender_name || sender.slice(0, 8), tag: s.tag });
          note("link-relay-approval-needed", { stationId: st.id, sender: s.sender_name || sender });
          onPending(list());
        }
        continue;
      }
      pending.delete(pk);
      if (fromNow !== sender) { const p = await pairWith(st.id, sender); if (!p || !p.ok) continue; }   // an allowed sender: take its key
      const relay = relayJson(r.body.relay_host, r.body.relay_port, s);
      if (inputSessions.get(st.id) !== relay) { inputSessions.set(st.id, relay); await setRelay(st.id, "input", relay); }
    }
    for (const sid of [...inputSessions.keys()]) if (!seen.has(sid)) { inputSessions.delete(sid); await setRelay(sid, "input", null); }
  }

  /** The operator allowed a sender: remembered for this station, joined on the next pass (run at once). */
  async function approve(stationId, senderMachine) {
    const sid = Number(stationId), m = String(senderMachine).toLowerCase();
    const a = approved(sid); if (!a.includes(m)) { a.push(m); writeKv(sid, KEY_APPROVED, JSON.stringify(a)); }
    pending.delete(`${sid}|${m}`);
    note("link-relay-sender-allowed", { stationId: sid, sender: m });
    onPending(list());
    await tickReceive();
    return { ok: true };
  }
  function list() { return [...pending.values()]; }

  return { tickSend, tickReceive, approve, pending: list, KEY_APPROVED };
}

module.exports = { createLinkRelayClient, KEY_APPROVED, RENEW_MS };
