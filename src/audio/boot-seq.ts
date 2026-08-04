// BOOT-SEQUENCE SENSE — the app's own answer to "what came up, in what order, and did any of it happen
// before sign-in". Permanent, not diagnostic scaffolding: it is the standing evidence that the
// account-is-the-root ordering holds, on any machine, at any time.
//
// ITS OWN DEPENDENCY-FREE MODULE, deliberately. The first version lived in engine-registry.ts and was
// reached from App.tsx / engine-rodio.ts via `require("./engine-registry")` — to dodge a circular import.
// That silently defeated the whole trace: `require` is CommonJS and DOES NOT EXIST in the Vite ESM
// bundle, so every call threw and was swallowed by its own try/catch. The 2026-08-03 map therefore
// showed no init(), no attachDaemonEvents, no SIGN-IN COMPLETE — and I read that absence as "the app
// never attaches", which was WRONG. Absence of a log line is not evidence of absence of behaviour.
// This module imports nothing, so every site can import it normally and no cycle can force `require`.
//
// console.warn, NOT console.log: only warn/error are forwarded to ether-startup.log (there are zero
// `renderer:log` lines in the entire history). A trace nobody can read is not a sense.

let authDone = false;

export function bootSeq(msg: string): void {
  try {
    console.warn(`[BOOTSEQ] ${new Date().toISOString()} ${authDone ? "post-auth" : "PRE-AUTH"} · ${msg}`);
  } catch { /* never break boot to log */ }
}

/** The dividing line D1 is built on: everything after it is legitimately account-derived. */
export function bootMarkAuthComplete(): void {
  if (authDone) return;                 // idempotent — a second sign-in must not reset the line
  authDone = true;
  bootSeq("SIGN-IN COMPLETE — everything after this line is legitimately account-derived");
}

export function bootAuthDone(): boolean { return authDone; }

/** The caller one frame up — which code path did this, and was anyone signed in yet. */
export function bootCallSite(): string {
  const NL = String.fromCharCode(10);
  const frames = ((new Error().stack || "").split(NL)[3] || "").trim();
  return frames.replace("at ", "") || "unknown";
}
