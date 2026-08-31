'use strict';

// electron/ops-api.js — the station side of Park Ops.
//
// docs/operator-closing-screen-and-source-routing-2026-08-31.md · STAGE 1
//
// WHAT THIS IS FOR: a park operator with no technical training runs park announcements from their
// phone, walking the park, with nobody from engineering present. Announcements are whatever the park
// needs to broadcast — a ride closure, a lost child, weather, "parade in ten minutes", park hours,
// and the close. CLOSING IS ONE USE CASE, which is why the closing time is one setting here rather
// than the subject of the page. The page is built in the Cloudflare repo
// (`C:\ether-park`) like every other web surface here, and the SAME BUILD is shipped inside the app
// and served from this station's own HTTP port.
//
// WHY THE STATION SERVES IT AT ALL, when every other page is Cloudflare-hosted:
//   A page served over HTTPS cannot fetch http://192.168.x.x:3400 — browsers block active mixed
//   content unconditionally and a page cannot opt out. So a cloud-hosted copy can be cached to OPEN
//   with no internet and still have nothing to talk to. Only a station-served page reaches a station
//   on the LAN, because then the page and the API share one origin. Announcements are how a park
//   tells people what is happening; they must not depend on the park's connection. (`/remote` already solves the
//   same problem the same way — it is the existing precedent, not a new idea.)
//
// STAGE 1 IS READ-ONLY AGAINST THE ENGINE. Nothing fires. No deck, no ducking, no routing. The
// engine keeps firing the stored ABSOLUTE times exactly as it does today — `dueTimeFor()` is
// untouched. Offset rows are returned with a DERIVED time and `preview: true`, so the model can be
// judged on screen before anything about what airs changes.
//
// THE ONE WRITE is the closing time, and it is gated by a token (see below).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY_CLOSING = 'closing_time';        // station_config_kv — the JSON below
const KEY_TOKEN   = 'ops_token';           // station_config_kv — the ?k= access token

// ── the closing-time value ────────────────────────────────────────────────────
// One KV row per station, holding this shape:
//
//   { "default": "22:00", "byWeekday": { "5": "23:00" }, "byDate": { "2026-10-31": "23:30" } }
//
// Resolution is date → weekday → default. Stage 1 only ever WRITES `default`; the other two keys are
// carried through untouched so the shape does not have to change when Jeff rules on scope. That
// ruling is still open, and this makes it non-blocking rather than a migration later.
//
// Note for whoever reads this next: per-weekday CLOSING TIME is not the weekday scope v48 removed.
// That was per-weekday announcement ENTRIES — scheduling complexity that was deliberately cut. A park
// closing later on Fridays is a property of the park.
function parseClosing(raw) {
  const empty = { default: null, byWeekday: {}, byDate: {} };
  if (!raw) return empty;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object') return empty;
    return {
      default: typeof v.default === 'string' ? v.default : null,
      byWeekday: (v.byWeekday && typeof v.byWeekday === 'object') ? v.byWeekday : {},
      byDate: (v.byDate && typeof v.byDate === 'object') ? v.byDate : {},
    };
  } catch { return empty; }
}

/** date → weekday → default. `dateStr` is YYYY-MM-DD; `dow` is 0-6, Sunday first. */
function resolveClosing(cfg, dateStr, dow) {
  return cfg.byDate?.[dateStr] ?? cfg.byWeekday?.[String(dow)] ?? cfg.default ?? null;
}

const hhmmToMin = (s) => {
  if (!s || typeof s !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(s.trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
};
const minToHms = (n) => {
  const w = ((n % 1440) + 1440) % 1440;   // wrap, so "15 minutes after midnight closing" is 00:15
  return `${String(Math.floor(w / 60)).padStart(2, '0')}:${String(w % 60).padStart(2, '0')}:00`;
};

// ── the access token ──────────────────────────────────────────────────────────
// The :3400 server has no authentication of any kind today — anyone on the park wi-fi can already
// POST /api/transport/stop. That is pre-existing and out of scope here, but this page adds a WRITE,
// so the write is gated rather than adding to the problem.
//
// One opaque token per station, minted on first use and carried in the URL as ?k=. The address is
// printed in the [ops] startup log and shared as a link — there is no QR code and none is wanted;
// the URL is the whole access method. Reads stay open — the page is useless without a
// station on the same LAN, and gating reads would mean an operator whose phone lost the query string
// sees an error instead of the closing time.
function ensureToken(db, stationId) {
  try {
    const row = db.prepare(
      'SELECT value FROM station_config_kv WHERE station_id = ? AND key = ? AND deleted_at IS NULL'
    ).get(stationId, KEY_TOKEN);
    if (row && row.value) return row.value;
  } catch { /* fall through and mint */ }
  const token = crypto.randomBytes(16).toString('hex');
  try { upsertKv(db, stationId, KEY_TOKEN, token); } catch { /* read-only DB — the page stays view-only */ }
  return token;
}

function upsertKv(db, stationId, key, value) {
  // Through the sanctioned handler when it is available, so the write journals and reaches peers
  // like every other station_config_kv change.
  try {
    const kv = require('./sync/handlers/station_config_kv');
    if (kv && typeof kv.upsertByKey === 'function') return kv.upsertByKey(db, stationId, key, value);
  } catch { /* handler shape differs — fall back below */ }
  const now = new Date().toISOString();
  const ex = db.prepare('SELECT uuid FROM station_config_kv WHERE station_id = ? AND key = ?').get(stationId, key);
  if (ex) db.prepare('UPDATE station_config_kv SET value = ?, updated_at = ?, deleted_at = NULL WHERE uuid = ?').run(value, now, ex.uuid);
  else db.prepare(
    'INSERT INTO station_config_kv (station_id, key, value, uuid, created_at, updated_at) VALUES (?,?,?,?,?,?)'
  ).run(stationId, key, value, crypto.randomUUID(), now, now);
}

function readKv(db, stationId, key) {
  try {
    const r = db.prepare(
      'SELECT value FROM station_config_kv WHERE station_id = ? AND key = ? AND deleted_at IS NULL'
    ).get(stationId, key);
    return r ? r.value : null;
  } catch { return null; }
}

// ── sanity rails — FLAG, never block ──────────────────────────────────────────
// The operator may know something the rule does not: a ride broke down, the fireworks ran late. So a
// rail is a sentence beside the row, not a refusal. What it must catch is the disaster case — a
// closing announcement firing with an hour of park time left.
function railsFor(row, closingMin, allRows) {
  const rails = [];
  const due = hhmmToMin(row.dueTime);
  if (due != null && closingMin != null) {
    let delta = due - closingMin;
    if (delta < -720) delta += 1440;            // across midnight
    if (delta > 720) delta -= 1440;
    if (Math.abs(delta) > 360) {
      rails.push({ level: 'warn', text: `That is ${(Math.abs(delta) / 60).toFixed(1)} hours from closing. Is the closing time right?` });
    }
    if (/clos(ed|ing)/i.test(row.title || '') && delta < -20) {
      rails.push({ level: 'warn', text: 'A closing announcement, but the park is open for a while yet.' });
    }
  }
  for (const other of allRows) {
    if (other === row) continue;
    const o = hhmmToMin(other.dueTime);
    if (due != null && o != null && Math.abs(o - due) * 60 < 60) {
      rails.push({ level: 'warn', text: `Almost the same time as “${other.title}”.` });
      break;
    }
  }
  return rails;
}

// ── the state the page renders ────────────────────────────────────────────────
function buildState(db, audio, stationId, tokenOk) {
  const st = db.prepare('SELECT id, name FROM stations WHERE id = ? AND deleted_at IS NULL').get(stationId)
          || { id: stationId, name: 'Station' };

  // NOW PLAYING — the same source /api/status and /api/now-playing already use.
  let now = { title: null, artist: null, positionSec: null, durationSec: null, onAir: false };
  try {
    const s = JSON.parse(audio.audioGetState());
    const d = s.deckA && s.deckA.status === 'playing' ? s.deckA
            : s.deckB && s.deckB.status === 'playing' ? s.deckB
            : s.deckC && s.deckC.status === 'playing' ? s.deckC : null;
    if (d) {
      now = {
        title: d.title || null,
        artist: d.artist || null,
        positionSec: typeof d.position_sec === 'number' ? d.position_sec : null,
        durationSec: typeof d.duration_sec === 'number' ? d.duration_sec : null,
        onAir: true,
      };
    }
  } catch { /* engine not up — an honest "nothing playing", not a crash */ }

  const d0 = new Date();
  const dateStr = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`;
  const cfg = parseClosing(readKv(db, stationId, KEY_CLOSING));
  const effective = resolveClosing(cfg, dateStr, d0.getDay());
  const closingMin = hhmmToMin(effective);

  // TONIGHT'S QUEUE. v48: one calendar date, absolute times, no weekday precedence to resolve.
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT s.uuid AS uuid, s.trigger_time AS trigger_time, s.trigger_type AS trigger_type,
              s.close_offset_min AS close_offset_min, s.last_played_at AS last_played_at,
              a.title AS title, a.duck_music AS duck_music
         FROM announcement_schedule s
         JOIN announcements a ON a.uuid = s.announcement_uuid AND a.deleted_at IS NULL AND a.is_active = 1
        WHERE s.station_id = ? AND s.deleted_at IS NULL AND s.scope = 'date' AND s.date = ?
        ORDER BY s.sort_order, s.trigger_time`
    ).all(stationId, dateStr);
  } catch { rows = []; }

  const queue = rows.map(r => {
    const isOffset = r.trigger_type === 'before_close' && closingMin != null;
    // PREVIEW ONLY. The engine fires `trigger_time`; this derived value is what the row WOULD fire at
    // if offsets were live. Stage 1 changes nothing about what airs.
    const dueTime = isOffset
      ? minToHms(closingMin + (Number(r.close_offset_min) || 0))
      : (r.trigger_time ? String(r.trigger_time).slice(0, 8) : null);
    return {
      uuid: r.uuid,
      title: r.title || '(untitled)',
      dueTime,
      offsetMin: isOffset ? (Number(r.close_offset_min) || 0) : null,
      preview: !!isOffset,
      ducks: r.duck_music == null ? true : !!r.duck_music,
      alreadyPlayed: !!r.last_played_at && String(r.last_played_at).slice(0, 10) === dateStr,
      rails: [],
    };
  });
  for (const q of queue) q.rails = railsFor(q, closingMin, queue);

  return {
    ok: true,
    station: { id: st.id, name: st.name },
    now,
    closing: { default: cfg.default, byWeekday: cfg.byWeekday, byDate: cfg.byDate, effective },
    date: dateStr,
    queue,
    canEdit: !!tokenOk,
    previewOnly: true,
  };
}

// ── the routes ────────────────────────────────────────────────────────────────
// Mounted inside the station's existing HTTP server. Returns true when it handled the request.
function installOpsRoutes({ getDb, audio, getActiveStationId, webRoot }) {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                 '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
                 '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
                 '.woff2': 'font/woff2', '.map': 'application/json; charset=utf-8' };

  return function handle(req, res, url, qs) {
    if (!url.startsWith('/ops') && !url.startsWith('/api/ops')) return false;

    const db = getDb && getDb();
    const stationId = qs.station ? (parseInt(qs.station, 10) || null) : (getActiveStationId ? getActiveStationId() : null);
    const json = (code, body) => {
      res.statusCode = code;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(body));
    };

    // ── API ──
    if (url.startsWith('/api/ops')) {
      if (!db)        { json(503, { ok: false, error: 'The station database is not open yet.' }); return true; }
      if (!stationId) { json(409, { ok: false, error: 'No station is active on this machine.' }); return true; }

      const tokenOk = !!(qs.k && qs.k === ensureToken(db, stationId));

      if (req.method === 'GET' && url.startsWith('/api/ops/state')) {
        try { json(200, buildState(db, audio, stationId, tokenOk)); }
        catch (e) { json(500, { ok: false, error: e.message }); }
        return true;
      }

      if (req.method === 'PUT' && url.startsWith('/api/ops/closing-time')) {
        // The gate. Reads are open; the write is not.
        if (!tokenOk) { json(403, { ok: false, error: 'This copy is view-only. Open the full Park Ops link — the one ending in ?k= — from the station startup log to make changes.' }); return true; }
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
          try {
            const { time } = JSON.parse(body || '{}');
            if (hhmmToMin(time) == null) { json(400, { ok: false, error: 'That is not a time.' }); return; }
            const cfg = parseClosing(readKv(db, stationId, KEY_CLOSING));
            // Stage 1 writes ONLY `default`. byWeekday/byDate are carried through untouched so the
            // shape survives whichever way the scope question is ruled.
            cfg.default = String(time).trim().slice(0, 5);
            upsertKv(db, stationId, KEY_CLOSING, JSON.stringify(cfg));
            const d0 = new Date();
            const dateStr = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`;
            json(200, { ok: true, closing: { ...cfg, effective: resolveClosing(cfg, dateStr, d0.getDay()) } });
          } catch (e) { json(400, { ok: false, error: e.message }); }
        });
        return true;
      }

      json(404, { ok: false, error: 'Not found.' });
      return true;
    }

    // ── the page itself: the built bundle from the ether-park repo ──
    // Served from disk rather than an inline string, because it is a real Vite build from the
    // Cloudflare repo — the same artifact deployed to Pages. One build, two mount points; the page
    // reads its own origin and picks its API base.
    let rel = url.replace(/^\/ops\/?/, '') || 'index.html';
    rel = rel.split('?')[0];
    if (rel.includes('..')) { res.statusCode = 400; res.end('bad path'); return true; }
    let file = path.join(webRoot, rel);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(webRoot, 'index.html');
    try {
      const buf = fs.readFileSync(file);
      res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
      res.end(buf);
    } catch {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Park Ops is not installed on this station.');
    }
    return true;
  };
}

module.exports = {
  installOpsRoutes,
  // exported for the smoke test — the pure parts, testable without a server
  _test: { parseClosing, resolveClosing, hhmmToMin, minToHms, railsFor, buildState, ensureToken, KEY_CLOSING, KEY_TOKEN },
};
