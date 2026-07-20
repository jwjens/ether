// probe-deck-volumes.js — READ-ONLY. Connects to the LIVE ether-audiod pipe and reads the native
// per-deck state (getState). Prints each deck's native volume + status. Issues NO mutation — getState
// only. This is the "truth split" receipt: native deck gain vs. what the fader UI shows.
const net = require("net");
const PIPE = process.env.ETHER_AUDIOD_PIPE || "\\\\.\\pipe\\ether-audiod";

function client() {
  const c = { sock: null, id: 0, buf: "", pending: new Map() };
  c.cmd = (cmd, a = {}) => new Promise((res, rej) => {
    const i = ++c.id; c.pending.set(i, { res, rej });
    c.sock.write(JSON.stringify({ id: i, cmd, ...a }) + "\n");
    setTimeout(() => { if (c.pending.has(i)) { c.pending.delete(i); rej(new Error("timeout " + cmd)); } }, 4000);
  });
  c.connect = () => new Promise((res, rej) => {
    c.sock = net.connect(PIPE);
    c.sock.once("connect", res);
    c.sock.once("error", rej);
    c.sock.on("data", d => {
      c.buf += d.toString("utf8"); let nl;
      while ((nl = c.buf.indexOf("\n")) >= 0) {
        const line = c.buf.slice(0, nl); c.buf = c.buf.slice(nl + 1);
        if (!line.trim()) continue; let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id != null && c.pending.has(m.id)) { const p = c.pending.get(m.id); c.pending.delete(m.id); m.ok ? p.res(m.result) : p.rej(new Error(m.error)); }
      }
    });
  });
  return c;
}

(async () => {
  const app = client();
  try { await app.connect(); } catch (e) { console.error("CANNOT CONNECT to live daemon pipe " + PIPE + " — is the app running? " + e.message); process.exit(2); }
  await app.cmd("ping").catch(() => {});
  const STATION = Number(process.env.ETHER_STATION || 1);
  const st = await app.cmd("getState", { stationId: STATION }).catch(e => { console.error("getState failed:", e.message); return null; });
  if (!st) { process.exit(3); }
  console.log("=== NATIVE deck state (station " + STATION + ") — read-only getState ===");
  for (const d of ["deckA", "deckB", "deckC", "deckCart"]) {
    const s = st[d]; if (!s) continue;
    const v = typeof s.volume === "number" ? s.volume : "(none)";
    console.log(`  ${d.padEnd(6)}  vol=${typeof v === "number" ? v.toFixed(4) : v}  status=${s.status || "-"}  gainDb=${s.gainDb ?? "-"}  title="${s.title || ""}"`);
  }
  // Also dump the raw levels so we can see the post-mix master + per-deck taps
  const lv = await app.cmd("getLevels", { stationId: STATION }).catch(() => null);
  if (lv) console.log("  levels:", JSON.stringify(lv));
  try { app.sock.destroy(); } catch {}
  process.exit(0);
})();
