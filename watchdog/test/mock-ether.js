'use strict';
/**
 * Mock "Ether" for watchdog tests. Stands in for the real app: serves
 * GET /health on :3400 and then misbehaves according to argv[2]:
 *
 *   healthy                 → stay healthy forever
 *   crash:<ms>              → serve healthy, then process.exit(1) (unexpected crash)
 *   hang:<ms>               → after <ms>, stop answering /health but keep the
 *                             process + listening socket alive (frozen-but-alive)
 *   clean-exit:<ms>         → after <ms>, write .ether-clean-exit then exit(0)
 *   expected-restart:<ms>   → after <ms>, write .ether-expected-restart then exit(0)
 *
 * Sentinels are written to WATCHDOG_USER_DATA (the test's temp dir), matching
 * where the watchdog reads them.
 */
const http = require('http');
const fs   = require('fs');
const path = require('path');

const behavior = process.argv[2] || 'healthy';
const [mode, msStr] = behavior.split(':');
const ms = Number(msStr) || 0;
const userData = process.env.WATCHDOG_USER_DATA || process.cwd();
let hung = false;

const server = http.createServer((req, res) => {
  if (hung) return; // never respond — simulate a hang (socket open, no reply)
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ts: Date.now(), audio: { alive: true }, mock: behavior }));
    return;
  }
  res.writeHead(404); res.end();
});

server.on('error', (e) => { console.error('[mock] listen error', e.code); process.exit(3); });

server.listen(3400, '127.0.0.1', () => {
  console.log(`[mock] pid ${process.pid} listening :3400 behavior=${behavior}`);
  if (mode === 'crash')            setTimeout(() => { console.log('[mock] crashing'); process.exit(1); }, ms);
  else if (mode === 'hang')        setTimeout(() => { console.log('[mock] hanging'); hung = true; }, ms);
  else if (mode === 'clean-exit')  setTimeout(() => { fs.writeFileSync(path.join(userData, '.ether-clean-exit'), String(Date.now())); console.log('[mock] clean exit'); process.exit(0); }, ms);
  else if (mode === 'expected-restart') setTimeout(() => { fs.writeFileSync(path.join(userData, '.ether-expected-restart'), String(Date.now())); console.log('[mock] expected restart'); process.exit(0); }, ms);
});
