// electron/artwork-cache.js — cover art from the music store, fetched ONCE and kept.
//
// Jeff's ruling, 2026-08-19: the Jukebox uses the library's existing pipeline (embedded art first)
// and falls back to the iTunes Search API for tracks with no local cover — the same in-house,
// non-commercial use as the rest of Ether.
//
// This is the piece that makes that safe to do on a WALL. The 08-04 §3 objection was a request storm:
// an uncached lookup per tile across thousands of songs. Three things answer it, and all three are
// required — remove any one and the storm comes back:
//
//   1. A DISK CACHE. The image is downloaded once and served from a local file thereafter. The old
//      in-memory cache in src/lib/albumArt.ts died with every window reload, so a pop-out that was
//      closed and reopened re-fetched the entire visible wall.
//   2. A DATABASE ROW per lookup, carrying PROVENANCE (source='itunes') and negative results. A track
//      with genuinely no cover is asked about once, ever — not on every render forever.
//   3. A RATE LIMITER. Apple's guidance is ~20 calls/minute. This queues rather than bursts, so a
//      wall of 3,000 uncached songs fills in gradually instead of getting the machine throttled or
//      blocked. That IS the honest trade of the ruling and it is stated here rather than discovered.
//
// The cached file is the LARGE artwork (600x600). Callers that only need a thumbnail scale it down in
// CSS; caching a 60px image would have meant re-fetching the moment anything wanted it bigger, which
// is how a cache becomes a request storm with extra steps.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ── Apple's guidance is ~20 calls per minute. Sit under it, and QUEUE rather than drop: a queued
//    lookup resolves late, a dropped one leaves a permanent hole in the wall for no reason.
const MAX_CALLS = 18;               // headroom under 20
const WINDOW_MS = 60_000;
const _callTimes = [];              // epoch ms of recent calls, pruned to the window
let _chain = Promise.resolve();     // serialises fetches so the limiter cannot be raced

let _db = null;
let _dir = null;
let _log = () => {};

/** Wire up. `dbProvider` is a function so this module never holds a handle across a database swap. */
function init({ db, cacheDir, log }) {
  _db = db || null;
  _dir = cacheDir || null;
  if (typeof log === "function") _log = log;
  try { if (_dir) fs.mkdirSync(_dir, { recursive: true }); }
  catch (e) { console.error("[artwork] cache dir:", e.message); }
}

/** Normalised lookup key. The same song must not be fetched three times because one copy says
 *  "(feat. X)" and another says "- 2011 Remaster". Mirrors the query cleanup below. */
function cacheKey(title, artist) {
  const clean = (s) => String(s || "")
    .toLowerCase()
    .replace(/\(feat\..*?\)/g, "")
    // "- 2011 Remaster", "- Remastered 2009", "– Remaster". The year sits BETWEEN the dash and the
    // word, so anchoring "remaster" straight after the dash missed the commonest form of it and cost
    // a second fetch for a song already cached (caught by scripts/test-artwork-cache.js).
    .replace(/\s*[-–][^-–]*\bremaster\w*\b.*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return `${clean(title)}::${clean(artist)}`;
}

function _tableReady() {
  try { return !!_db && !!_db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='artwork_cache'").get(); }
  catch { return false; }
}

/** What we already know about this key. Returns undefined when never asked — which is NOT the same
 *  as a row whose local_path is null ("asked, nothing there"). */
function _lookup(key) {
  if (!_tableReady()) return undefined;
  try { return _db.prepare("SELECT * FROM artwork_cache WHERE cache_key = ?").get(key); }
  catch { return undefined; }
}

function _remember(key, title, artist, sourceUrl, localPath, bytes) {
  if (!_tableReady()) return;
  try {
    _db.prepare(`INSERT INTO artwork_cache (cache_key, title, artist, source, source_url, local_path, fetched_at, bytes)
                 VALUES (?,?,?,'itunes',?,?,?,?)
                 ON CONFLICT(cache_key) DO UPDATE SET
                   source_url = excluded.source_url, local_path = excluded.local_path,
                   fetched_at = excluded.fetched_at, bytes = excluded.bytes`)
       .run(key, title || null, artist || null, sourceUrl || null, localPath || null,
            Math.floor(Date.now() / 1000), bytes ?? null);
  } catch (e) { _log(`[artwork] remember failed: ${e.message}`); }
}

/** Wait until a call is allowed. Prunes the window, then sleeps exactly as long as needed. */
async function _throttle() {
  for (;;) {
    const now = Date.now();
    while (_callTimes.length && now - _callTimes[0] > WINDOW_MS) _callTimes.shift();
    if (_callTimes.length < MAX_CALLS) { _callTimes.push(now); return; }
    const waitMs = WINDOW_MS - (now - _callTimes[0]) + 50;
    await new Promise(r => setTimeout(r, Math.max(250, waitMs)));
  }
}

/**
 * Resolve cover art for a (title, artist) and return an absolute local file path, or null.
 *
 * Never throws: artwork is decoration. A network failure returns null and the caller keeps its
 * neutral tile — and is NOT negatively cached, because "the network was down" must not be recorded
 * as "this song has no cover" forever.
 */
async function getMusicStoreArt(title, artist) {
  if (!title && !artist) return null;
  const key = cacheKey(title, artist);

  const known = _lookup(key);
  if (known !== undefined) {
    // A hit whose file has since been deleted falls through and is re-fetched.
    if (known.local_path && fs.existsSync(known.local_path)) return known.local_path;
    if (known.local_path == null) return null;   // negative cache — asked, nothing there
  }

  // Serialise through one chain so concurrent tiles cannot each slip past the limiter.
  _chain = _chain.then(async () => {
    const again = _lookup(key);
    if (again !== undefined && again.local_path && fs.existsSync(again.local_path)) return again.local_path;

    await _throttle();

    const q = encodeURIComponent(`${title || ""} ${artist || ""}`
      .replace(/\(feat\..*?\)/gi, "")
      .replace(/\s*[-–][^-–]*\bremaster\w*\b.*/gi, "")
      .trim());
    let url = null;
    try {
      const r = await fetch(`https://itunes.apple.com/search?term=${q}&media=music&entity=song&limit=1`);
      if (!r.ok) { _log(`[artwork] iTunes HTTP ${r.status} for ${key}`); return null; }
      const d = await r.json();
      // Ask for the LARGE image — this is going on a wall, not a list row.
      url = d?.results?.[0]?.artworkUrl100?.replace("100x100bb", "600x600bb") ?? null;
    } catch (e) {
      _log(`[artwork] lookup failed for ${key}: ${e.message}`);
      return null;   // transient — deliberately NOT negatively cached
    }

    if (!url) { _remember(key, title, artist, null, null, null); return null; }   // genuinely no art

    try {
      const res = await fetch(url);
      if (!res.ok) { _log(`[artwork] image HTTP ${res.status} for ${key}`); return null; }
      const buf = Buffer.from(await res.arrayBuffer());
      const file = path.join(_dir, crypto.createHash("sha1").update(key).digest("hex") + ".jpg");
      fs.writeFileSync(file, buf);
      _remember(key, title, artist, url, file, buf.length);
      _log(`[artwork] cached ${key} (${buf.length}B) from iTunes`);
      return file;
    } catch (e) {
      _log(`[artwork] download failed for ${key}: ${e.message}`);
      return null;   // transient again — no negative cache
    }
  }).catch(() => null);

  return _chain;
}

/** Provenance roll-up. The answer to "what came from iTunes?" is one query, by design. */
function stats() {
  if (!_tableReady()) return { ready: false };
  try {
    const r = _db.prepare(`SELECT source, COUNT(*) AS rows,
                                  SUM(CASE WHEN local_path IS NOT NULL THEN 1 ELSE 0 END) AS withArt,
                                  COALESCE(SUM(bytes), 0) AS bytes
                             FROM artwork_cache GROUP BY source`).all();
    return { ready: true, bySource: r, dir: _dir };
  } catch (e) { return { ready: false, error: e.message }; }
}

module.exports = { init, getMusicStoreArt, cacheKey, stats };
