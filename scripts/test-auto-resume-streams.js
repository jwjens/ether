'use strict';
// Phase-D proof (4.4.43): a simulated daemon reload restores the Icecast STREAM, not just playout.
// Before Phase D the reconnect replay issued only automationStart → streams stayed down every reload
// (jensj 4.4.41: listener dead air every ~10 min). This drives the extracted replayIntents() with a
// mock daemon client and asserts BOTH automationStart AND startStream are replayed for the right
// stations. Pure JS — plain `node`.
const path = require('path');
const { replayIntents } = require(path.join('C:', 'openair', 'electron', 'daemon-auto-resume'));

let n = 0; const ok = (m) => console.log(`  [${++n}] ${m} ✓`); const fail = (m) => { console.error('❌ FAIL:', m); process.exit(1); };

// Mock daemon client: record every cmd(name, {stationId}) call.
function mockClient() {
  const calls = [];
  return { calls, cmd: (name, args) => { calls.push({ name, stationId: args && args.stationId }); return Promise.resolve({ ok: true }); } };
}
const cmdsFor = (calls, name) => calls.filter(c => c.name === name).map(c => c.stationId).sort();

// Scenario mirrors jensj: 3 stations on air (automation intent 1,2,3); 2 of them streaming (1,3).
// Station 2 is playout-only (automation, no stream) — it must NOT get a startStream.
const automationIntent = new Map([[1, { stationId: 1 }], [2, { stationId: 2 }], [3, { stationId: 3 }]]);
const streamIntent = new Map([[1, { stationId: 1 }], [3, { stationId: 3 }]]);

// 1) Simulated reload → replay. streamDelayMs:0 so it fires synchronously for the test.
const client = mockClient();
const res = replayIntents(client, automationIntent, streamIntent, { streamDelayMs: 0 });

// 2) Playout restored for ALL three.
const autos = cmdsFor(client.calls, 'automationStart');
if (JSON.stringify(autos) !== JSON.stringify([1, 2, 3])) fail(`automationStart replayed for ${autos} (expected 1,2,3)`);
ok('reload replays automationStart for all on-air stations (1,2,3)');

// 3) THE FIX: streams restored for the streaming stations — this is what stops listener dead air.
const streams = cmdsFor(client.calls, 'startStream');
if (streams.length === 0) fail('NO startStream replayed on reload — this is the pre-Phase-D dead-air bug');
if (JSON.stringify(streams) !== JSON.stringify([1, 3])) fail(`startStream replayed for ${streams} (expected 1,3)`);
ok('reload replays startStream for the streaming stations (1,3) — streams auto-restore, not dead air');

// 4) Playout-only station never gets a stream.
if (streams.includes(2)) fail('station 2 (playout-only) wrongly got a startStream');
ok('playout-only station (2) is NOT streamed (stream intent is honored, not assumed)');

// 5) Return summary is accurate.
if (res.automationCount !== 3 || res.streamCount !== 2) fail(`summary wrong: ${JSON.stringify(res)}`);
ok('replay summary: automationCount=3 streamCount=2');

// 6) No stream intent → no startStream (a station that never streamed stays silent to listeners).
const c2 = mockClient();
replayIntents(c2, new Map([[5, { stationId: 5 }]]), new Map(), { streamDelayMs: 0 });
if (cmdsFor(c2.calls, 'startStream').length !== 0) fail('startStream fired with empty stream intent');
if (cmdsFor(c2.calls, 'automationStart').length !== 1) fail('automationStart not replayed for station 5');
ok('empty stream intent → automationStart only, no startStream');

console.log('\n✅ AUTO-RESUME STREAMS — ALL CHECKS PASS (a reload restores playout AND streams; no listener dead air)');
