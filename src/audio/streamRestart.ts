// streamRestart — web-remote slice 4 (docs/web-remote-design-2026-09-16.md §4): the web's Restart is a STREAM restart
// on the target machine, never a playout restart. stop-live → wait until the stream is no longer live (or
// STOP_WAIT_MS) → go-live. Automation is not touched: the song keeps playing through the encoder restart.
// stop-live deletes _streamIntent and go-live re-sets it (electron/main.js), so the intent ends as it began.
//
// THE RESULT IS THE STREAM'S REAL END STATE (slice 5 acks it). In daemon mode go-live answers ok as soon as ffmpeg is
// spawned; an Icecast refusal (403 — the mount is held elsewhere) arrives afterwards as the stream's `error` state.
// So after go-live this waits up to CONFIRM_MS for live | error and reports that — "sent" is never success.
// Pure over an injected io, so it is tested without a daemon or a clock.

export const STOP_WAIT_MS = 2000;
export const CONFIRM_MS = 8000;
const POLL_MS = 100;

export type StreamState = "live" | "connecting" | "idle" | "error" | string;
export interface StreamIo {
  stopLive(): Promise<any>;
  goLive(): Promise<any>;
  status(): Promise<{ state: StreamState; error?: string | null }>;
  sleep(ms: number): Promise<void>;
  now(): number;
}
export interface StreamOutcome { ok: boolean; error: string | null }

/** Wait for the stream to settle live (ok) or error (not ok, with its reason). Still connecting at the end → not ok. */
export async function confirmLive(io: StreamIo, windowMs = CONFIRM_MS): Promise<StreamOutcome> {
  const start = io.now();
  let last: { state: StreamState; error?: string | null } = { state: "unknown" };
  for (;;) {
    try { last = await io.status(); } catch { last = { state: "unknown" }; }
    if (last.state === "live") return { ok: true, error: null };
    if (last.state === "error") return { ok: false, error: last.error || "the stream reported an error" };
    if (io.now() - start >= windowMs) return { ok: false, error: `not confirmed live within ${windowMs / 1000} s (state: ${last.state})` };
    await io.sleep(POLL_MS);
  }
}

export async function restartStream(io: StreamIo): Promise<StreamOutcome> {
  const stop = await io.stopLive();
  if (stop && stop.ok === false) return { ok: false, error: `stop failed: ${stop.error || "no reason given"}` };
  const start = io.now();
  for (;;) {
    let s: StreamState = "unknown";
    try { s = (await io.status()).state; } catch { /* unreadable → keep waiting, bounded */ }
    if (s !== "live" || io.now() - start >= STOP_WAIT_MS) break;
    await io.sleep(POLL_MS);
  }
  const go = await io.goLive();
  if (!go || go.ok === false) return { ok: false, error: (go && go.error) || "go-live returned no answer" };
  return confirmLive(io);
}
