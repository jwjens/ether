// A RECORDING window.ether for the module proof tests. Every bridge call any component (or the engine under it)
// makes — window.ether.audio.load(...), .invoke("schedule:get", ...), .cartSlots.list(...) — is recorded in order
// with its arguments, and answered from the handlers a test supplies (else a neutral default). The parity tests
// compare these recordings: a module and the page it comes from must make the identical sequence of calls.
//
// Nothing here talks to a database, a daemon or a file. It is the preload's shape, not its behaviour.

export interface BridgeCall { path: string; args: unknown[] }
type Handler = (...args: any[]) => unknown;

/** Arguments as plain data: callbacks become "[fn]" so two recordings of the same call compare equal. */
function plain(v: unknown, depth = 0): unknown {
  if (typeof v === "function") return "[fn]";
  if (v === null || typeof v !== "object" || depth > 6) return v;
  if (Array.isArray(v)) return v.map(x => plain(x, depth + 1));
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = plain(x, depth + 1);
  return o;
}

export interface EtherStub {
  calls: BridgeCall[];
  /** Forget the recording (not the listeners). */
  reset(): void;
  /** Main → renderer: deliver `payload` on `channel` to every ether.on listener, as the preload does. */
  emit(channel: string, payload?: unknown): void;
  /** Replace / add handlers. */
  handle(map: Record<string, Handler>): void;
  /** The recorded calls whose path matches. */
  callsTo(match: RegExp | string): BridgeCall[];
}

export function installEther(initial: Record<string, Handler> = {}): EtherStub {
  const handlers: Record<string, Handler> = { ...initial };
  const listeners = new Map<string, Set<Handler>>();
  const calls: BridgeCall[] = [];

  const defaults: Record<string, Handler> = {
    on: (channel: string, fn: Handler) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel)!.add(fn);
      return fn;   // the preload returns the handle ether.off takes
    },
    off: (channel: string, fn: Handler) => { listeners.get(channel)?.delete(fn); },
    "db.query": () => Promise.resolve({ data: [] }),
    "db.execute": () => Promise.resolve({ data: { changes: 0 } }),
  };

  const call = (path: string, args: unknown[]) => {
    calls.push({ path, args: plain(args) as unknown[] });
    const h = handlers[path] ?? defaults[path];
    if (h) return h(...args);
    return Promise.resolve(null);
  };

  const node = (path: string): any => new Proxy(function () { /* callable */ }, {
    get(_t, prop) {
      if (typeof prop === "symbol" || prop === "then") return undefined;   // never a thenable
      return node(path ? `${path}.${prop}` : prop);
    },
    apply(_t, _this, args) { return call(path, args); },
  });

  (globalThis as any).ether = node("");

  return {
    calls,
    reset() { calls.length = 0; },
    emit(channel, payload) { for (const fn of [...(listeners.get(channel) || [])]) fn(payload); },
    handle(map) { Object.assign(handlers, map); },
    callsTo(match) {
      return calls.filter(c => (typeof match === "string" ? c.path === match : match.test(c.path)));
    },
  };
}
