// scripts/test-artwork-cache.js — the music-store artwork cache, with the network stubbed.
// Run: ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/test-artwork-cache.js
//
// The three properties that make iTunes-as-fallback safe on a wall are the ones worth testing, and
// none of them can be checked by looking at the screen:
//   · a given (title, artist) costs ONE network call, ever — including across "restarts"
//   · "asked and found nothing" is remembered, but "the network was down" is NOT
//   · the rate limiter actually limits
//
// Needs Electron's ABI only because better-sqlite3 is built against it; nothing here touches the
// live database, the live cache directory, or the real iTunes API.

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ether-artwork-test-"));
const dbPath = path.join(tmp, "test.db");
const cacheDir = path.join(tmp, "cache");

const db = new Database(dbPath);
db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
require("./migrate-artwork-cache-phase-sync-41.js").applyMigration(db);

const artwork = require("../electron/artwork-cache");
artwork.init({ getDb: () => db, cacheDir, log: () => {} });

// ── Stub the network. Every call is counted, so "one call ever" is measurable rather than asserted.
let searchCalls = 0, imageCalls = 0;
let searchResult = () => ({ results: [{ artworkUrl100: "https://is1.example/a/100x100bb.jpg" }] });
const realFetch = global.fetch;
global.fetch = async (url) => {
  if (String(url).includes("itunes.apple.com")) {
    searchCalls++;
    return { ok: true, json: async () => searchResult() };
  }
  imageCalls++;
  return { ok: true, arrayBuffer: async () => new TextEncoder().encode("JPEGDATA".repeat(8)).buffer };
};

(async () => {
  console.log("\ncacheKey — the same song must not be fetched three times");
  await test("feat. and remaster suffixes normalise to one key", () => {
    const a = artwork.cacheKey("Be Our Guest (feat. Chorus)", "Angela Lansbury");
    const b = artwork.cacheKey("Be Our Guest", "angela lansbury");
    const c = artwork.cacheKey("Be Our Guest - 2011 Remaster", "ANGELA LANSBURY");
    assert.equal(a, b); assert.equal(b, c);
  });

  console.log("\none network call per song, ever");
  await test("first lookup fetches and writes a file", async () => {
    const p = await artwork.getMusicStoreArt("Be Our Guest", "Angela Lansbury");
    assert.ok(p, "expected a local path");
    assert.ok(fs.existsSync(p), "cached file should exist on disk");
    assert.equal(searchCalls, 1);
    assert.equal(imageCalls, 1);
  });
  await test("second lookup is served from disk — no further network calls", async () => {
    const p = await artwork.getMusicStoreArt("Be Our Guest", "Angela Lansbury");
    assert.ok(p && fs.existsSync(p));
    assert.equal(searchCalls, 1, "search must not be called again");
    assert.equal(imageCalls, 1, "image must not be downloaded again");
  });
  await test("a variant spelling hits the same cache entry", async () => {
    await artwork.getMusicStoreArt("Be Our Guest (feat. Chorus)", "angela lansbury");
    assert.equal(searchCalls, 1, "normalisation should have avoided a second search");
  });
  await test("SURVIVES A RESTART — a fresh module instance still finds it", async () => {
    delete require.cache[require.resolve("../electron/artwork-cache")];
    const fresh = require("../electron/artwork-cache");
    fresh.init({ getDb: () => db, cacheDir, log: () => {} });
    const p = await fresh.getMusicStoreArt("Be Our Guest", "Angela Lansbury");
    assert.ok(p && fs.existsSync(p));
    assert.equal(searchCalls, 1, "a reload must not re-fetch — this is the whole point of the disk cache");
  });

  console.log("\nnegative caching — remember 'nothing there', never 'the network was down'");
  const artwork2 = require("../electron/artwork-cache");
  await test("a song with no result is remembered and not asked twice", async () => {
    searchResult = () => ({ results: [] });
    const before = searchCalls;
    const p1 = await artwork2.getMusicStoreArt("Totally Unknown Track", "Nobody At All");
    const p2 = await artwork2.getMusicStoreArt("Totally Unknown Track", "Nobody At All");
    assert.equal(p1, null); assert.equal(p2, null);
    assert.equal(searchCalls, before + 1, "a known-empty result must be asked about exactly once");
  });
  await test("a NETWORK FAILURE is not recorded as 'this song has no cover'", async () => {
    const boom = global.fetch;
    global.fetch = async () => { throw new Error("offline"); };
    const p1 = await artwork2.getMusicStoreArt("Transient Failure", "Test");
    assert.equal(p1, null);
    global.fetch = boom;
    searchResult = () => ({ results: [{ artworkUrl100: "https://is1.example/b/100x100bb.jpg" }] });
    const p2 = await artwork2.getMusicStoreArt("Transient Failure", "Test");
    assert.ok(p2, "once the network returns, the song must resolve — a blip is not a verdict");
  });

  console.log("\nprovenance — the future rights decision is one query");
  await test("every fetched image records source='itunes' and its origin URL", () => {
    const rows = db.prepare("SELECT * FROM artwork_cache WHERE local_path IS NOT NULL").all();
    assert.ok(rows.length >= 2);
    for (const r of rows) {
      assert.equal(r.source, "itunes");
      assert.ok(r.source_url && r.source_url.startsWith("https://"), "origin URL must be kept");
      assert.ok(r.bytes > 0);
    }
  });
  await test("the large image is requested, not a thumbnail", () => {
    const r = db.prepare("SELECT source_url FROM artwork_cache WHERE local_path IS NOT NULL LIMIT 1").get();
    assert.ok(r.source_url.includes("600x600bb"), `expected 600x600bb, got ${r.source_url}`);
  });
  await test("stats() answers 'what came from iTunes' without a scan of the code", () => {
    const st = artwork2.stats();
    assert.equal(st.ready, true);
    const itunes = st.bySource.find(b => b.source === "itunes");
    assert.ok(itunes && itunes.rows >= 3, JSON.stringify(st.bySource));
  });

  console.log("\nrate limiting — Apple's ~20/min guidance");
  await test("a database that only exists AFTER init is still used", async () => {
    // REGRESSION 2026-08-19: main.js evaluates this module at require time, but `db` is not assigned
    // until openDb() runs later in startup. Capturing the handle at init caught `undefined` and
    // pinned it — v41 had run, the table existed, and artwork_cache stayed empty forever. The
    // provider must be consulted per call, not once.
    delete require.cache[require.resolve("../electron/artwork-cache")];
    const late = require("../electron/artwork-cache");
    let handle = null;                                   // nothing yet, exactly like startup
    late.init({ getDb: () => handle, cacheDir, log: () => {} });
    assert.equal(late.stats().ready, false, "with no db yet it must report not-ready, not throw");
    handle = db;                                         // ...openDb() finally runs
    assert.equal(late.stats().ready, true, "once the db exists it must be seen WITHOUT a re-init");
    const before = searchCalls;
    const p = await late.getMusicStoreArt("Be Our Guest", "Angela Lansbury");
    assert.ok(p, "should resolve from the cache it can now read");
    assert.equal(searchCalls, before, "and must NOT re-fetch — proof it read the table, not the network");
  });

  await test("the limiter is set below the guidance and queues rather than bursts", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "electron", "artwork-cache.js"), "utf8");
    const max = Number(/MAX_CALLS\s*=\s*(\d+)/.exec(src)[1]);
    const win = Number(/WINDOW_MS\s*=\s*([\d_]+)/.exec(src)[1].replace(/_/g, ""));
    assert.ok(max < 20, `MAX_CALLS ${max} must sit under Apple's ~20/min`);
    assert.equal(win, 60000);
    assert.ok(/_chain\s*=\s*_chain\.then/.test(src), "fetches must serialise so the limiter cannot be raced");
  });

  global.fetch = realFetch;
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
  console.log(`\n${passed} passed${process.exitCode ? " — WITH FAILURES" : ""}\n`);
})();
