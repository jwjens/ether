// cmd-ack — web-remote slice 5 (docs/web-remote-design-2026-09-16.md §5): no silent success. After a station-scoped
// command this machine accepted has run, the desktop POSTs /api/cmd/ack {cmd_id, station_uuid, machine_id, ok, error}
// with the REAL result, so the web page can say "✓ done on <machine>" or "✗ <machine>: <error>" instead of "sent".
// Best-effort: never throws, bounded by ACK_TIMEOUT_MS, never awaited by playout.

export interface CmdOutcome { ok: boolean; error: string | null }
export const ACK_TIMEOUT_MS = 4000;

/** Normalise what execCmd's calls return: an IPC envelope {ok, error}, a daemon envelope {ok, result:{ok, reason}}, or nothing. */
export function outcomeOf(r: any): CmdOutcome {
  if (r == null || typeof r !== "object") return { ok: true, error: null };
  if (r.ok === false) return { ok: false, error: String(r.error || r.reason || "failed (no reason given)") };
  const inner = r.result;
  if (inner && typeof inner === "object" && inner.ok === false) return { ok: false, error: String(inner.error || inner.reason || "failed (no reason given)") };
  return { ok: true, error: null };
}

export function ackBody(data: any, machineId: string | null | undefined, o: CmdOutcome) {
  return { cmd_id: data?.cmd_id ?? null, station_uuid: data?.station_uuid ?? null, machine_id: machineId ?? null, ok: o.ok, error: o.error };
}

export async function postCmdAck(fetchFn: typeof fetch, url: string, licenseKey: string | null | undefined, body: unknown): Promise<boolean> {
  if (!licenseKey) return false;
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), ACK_TIMEOUT_MS) : null;
  try {
    const res: any = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-license-key": licenseKey },
      body: JSON.stringify(body),
      signal: ctl ? ctl.signal : undefined,
    } as any);
    return !!(res && res.ok);
  } catch { return false; }
  finally { if (timer) clearTimeout(timer); }
}
