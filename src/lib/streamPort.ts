// The renderer's copy of the one stream-port rule (audiod/stream.js serverAndPort): a port written in the server address
// wins, otherwise the station's own port setting; no port anywhere = null — never a fixed 8000 (Jeff, 2026-10-31).
export function streamHostPort(raw: string, stationPort: number | null | undefined): { host: string; port: number | null } {
  const s = String(raw || "").trim().replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
  const m = s.match(/^(.*):(\d{1,5})$/);
  const own = Number(stationPort);
  return m ? { host: m[1], port: parseInt(m[2], 10) } : { host: s, port: Number.isInteger(own) && own > 0 && own < 65536 ? own : null };
}
