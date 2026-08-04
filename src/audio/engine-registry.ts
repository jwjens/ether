import { bootSeq, bootAuthDone, bootCallSite } from "./boot-seq";
import { AudioEngine, engine as singletonEngine } from "./engine-rodio";

// Pre-register the station-1 singleton so getEngine(1) returns the same
// instance that legacy consumers import directly from engine-rodio. Without
// this, getEngine(1) would create a second AudioEngine(1), producing two
// divergent JS-side queues. (Patches a Commit 2 oversight.)
const registry = new Map<number, AudioEngine>([[1, singletonEngine]]);

// BOOT-SEQUENCE SENSE (permanent, 2026-08-03). The cold-start work needs the REAL startup ordering,
// not a code reading — five theories about this sequence were wrong before it was measured. This is the
// product's own answer to "what came up, in what order, and did any of it happen before sign-in".
// Cheap (a console line per construction) and permanently useful: it is the evidence that the
// account-is-the-root ordering holds, on any machine, at any time.

export function getEngine(stationId: number): AudioEngine {
  if (!registry.has(stationId)) {
    // The caller is what matters: which code path constructed an engine, and was anyone signed in yet.
    const site = bootCallSite();
    bootSeq(`ENGINE CONSTRUCTED station=${stationId} ← ${site}`);
    registry.set(stationId, new AudioEngine(stationId));
  } else if (!bootAuthDone()) {
    const site = bootCallSite();
    bootSeq(`getEngine(${stationId}) PRE-AUTH (existing instance) ← ${site}`);
  }
  return registry.get(stationId)!;
}

export function hasEngine(stationId: number): boolean {
  return registry.has(stationId);
}

export function getAllEngines(): Map<number, AudioEngine> {
  return new Map(registry);
}

export function initializeRegistry(stationIds: number[]): void {
  for (const id of stationIds) {
    if (!registry.has(id)) {
      registry.set(id, new AudioEngine(id));
    }
  }
}

export function disposeEngine(stationId: number): void {
  registry.delete(stationId);
}
