'use strict';
// electron/link-pairing-client.js — Remote Link pairing against the backend (Jeff's ruling, 2026-10-04: the link
// key is never copied or typed by hand). The backend side is ether-backend src/lib/link-pairing.js (/api/link).
//
//   SAME ACCOUNT (default): this machine PUBLISHES its key; a receiver LISTS the account's other machines and FETCHES
//   the key of the one picked. GUEST: the sender asks for an 8-character code (XXXX-XXXX, 10 minutes, one use); the
//   receiver REDEEMS it.
//
// Every result is { ok, ... } or { ok:false, reason } with the reason in words — the panel shows it as is.
// Writes (publish, code, redeem — a redeem deletes the code) go through canWrite, the dev-build guard
// (electron/lib/etherBackend.js canWriteProduction). Reads do not.

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";   // the backend's: no 0/O, 1/I/L
function normalizeCode(input) {
  const s = String(input || "").toUpperCase().replace(/[\s-]/g, "");
  if (s.length !== 8) return null;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
  return s;
}
const formatCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;

const SIGN_IN = "sign in to your Ether account on this computer first (top-right person icon)";
const DEV = "this is a development build — it does not write to the live service (ETHER_ALLOW_DEV_PUSH=1 to allow)";

function createLinkPairingClient({ fetch, baseUrl, getJwt, canWrite }) {
  async function call(method, path, body, { write = false } = {}) {
    if (write && !canWrite()) return { ok: false, reason: DEV };
    const jwt = getJwt();
    if (!jwt) return { ok: false, reason: SIGN_IN };
    let res;
    try {
      res = await fetch(`${baseUrl}/api/link${path}`, {
        method, headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) { return { ok: false, reason: `the Ether service could not be reached (${(e && e.message) || e})` }; }
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (res.status === 401) return { ok: false, reason: `your sign-in has expired — ${SIGN_IN}` };
    if (!res.ok) return { ok: false, status: res.status, error: data && data.error, reason: null };
    return { ok: true, data };
  }
  const asFrom = (d, via) => ({ machine: String(d.machine_id).toLowerCase(), name: d.machine_name || String(d.machine_id).slice(0, 8),
                                keyId: d.key_id, key: String(d.key).toLowerCase(), via });
  const keyBody = ({ machineId, machineName, key }) => ({ machine_id: machineId, machine_name: machineName || "", key: key.key, key_id: key.id });

  return {
    /** The account's machines other than this one, with whether each has shared its key. */
    async listMachines({ thisMachine }) {
      const r = await call("GET", "/machines");
      if (!r.ok) return r.reason ? r : { ok: false, reason: "could not read this account's computers" };
      const me = String(thisMachine || "").toLowerCase();
      const machines = ((r.data && r.data.machines) || [])
        .filter(m => String(m.machine_id).toLowerCase() !== me)
        .map(m => ({ machineId: String(m.machine_id).toLowerCase(), name: m.machine_name || String(m.machine_id).slice(0, 8),
                     published: !!m.published, fingerprint: m.fingerprint || null, keyId: m.key_id ?? null, lastSeen: m.last_seen || null }));
      return { ok: true, machines };
    },
    /** Same account: the picked machine's current key, as the fader's `from`. */
    async fetchKey(machineId) {
      const r = await call("GET", `/key/${encodeURIComponent(machineId)}`);
      if (!r.ok) return r.reason ? r : { ok: false, reason: "that computer has not shared its link key yet — open Ether on it once while signed in" };
      return { ok: true, from: asFrom(r.data, "account"), fingerprint: r.data.fingerprint || null };
    },
    /** This machine's key, published (again after Replace key). */
    async publishKey(args) {
      const r = await call("PUT", "/key", keyBody(args), { write: true });
      if (!r.ok) return r.reason ? r : { ok: false, reason: r.status === 403 ? "this computer is not on the signed-in account" : "the key was not shared" };
      return { ok: true, fingerprint: r.data && r.data.fingerprint };
    },
    /** Guest pairing, sender: a fresh 8-character code for this machine's key. */
    async createCode(args) {
      const r = await call("POST", "/pair-code", keyBody(args), { write: true });
      if (!r.ok) return r.reason ? r : { ok: false, reason: r.status === 403 ? "this computer is not on the signed-in account" : "no code was made" };
      return { ok: true, code: r.data.code, expiresAt: r.data.expires_at };
    },
    /** Guest pairing, receiver: the code typed off the sender's screen → the fader's `from`. One use. */
    async redeemCode(typed) {
      const c = normalizeCode(typed);
      if (!c) return { ok: false, reason: "a pairing code is 8 characters, like K7QD-2XMF" };
      const r = await call("POST", "/pair-redeem", { code: formatCode(c) }, { write: true });
      if (!r.ok) return r.reason ? r : { ok: false, reason: r.status === 429 ? "too many tries — wait a minute" : "that code is wrong, has expired, or was already used — ask for a new one (codes last 10 minutes and work once)" };
      return { ok: true, from: asFrom(r.data, "code"), fingerprint: r.data.fingerprint || null };
    },
  };
}

module.exports = { createLinkPairingClient, normalizeCode, formatCode, CODE_ALPHABET };
