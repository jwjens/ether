// rta-lease.js — SLICE 8: who is listening to a station's RTA, held on a LEASE (docs/dsp-channel-rta.md §1).
//
// A rack view subscribes (a channel, or "master") and renews every 2 s. The engine's RTA target follows the lease:
// set when a subscription names a new target, cleared ("") when the last renewal is older than the TTL or the view
// says "" itself. So a closed window, a crashed renderer or a station switch turns the tap off BY ITSELF — the
// callback then does nothing for the RTA (one branch). One target per station: the newest subscription wins.
"use strict";

const RTA_TTL_MS = 5000;

class RtaLeases {
  constructor(ttlMs = RTA_TTL_MS) { this.ttl = ttlMs; this.m = new Map(); }   // sid → { target, uuid, at }
  /** Returns the target to send the engine when it CHANGES (or null when nothing changes). */
  subscribe(sid, uuid, target, now) {
    const t = String(target || "");
    const cur = this.m.get(sid);
    if (!t) { if (!cur) return null; this.m.delete(sid); return ""; }
    this.m.set(sid, { target: t, uuid: uuid || (cur && cur.uuid) || null, at: now });
    return cur && cur.target === t ? null : t;
  }
  /** Stations whose lease has lapsed (removed here); each must be sent "". */
  expire(now) {
    const out = [];
    for (const [sid, l] of this.m) if (now - l.at > this.ttl) { this.m.delete(sid); out.push(sid); }
    return out;
  }
  entries() { return [...this.m.entries()]; }
  get(sid) { return this.m.get(sid) || null; }
}

module.exports = { RtaLeases, RTA_TTL_MS };
