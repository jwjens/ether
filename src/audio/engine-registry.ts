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

// ONCE PER INSTANCE, NOT ONCE PER CALL (2026-08-26). getEngine is on the RENDER path —
// useAudioEngine() (AudioEngineContext.tsx) calls it on EVERY render, unmemoized — so the
// existing-instance branch below fired at repaint rate. Measured on 2026-08-26: 211,951 lines and a
// 341 MB ether-startup.log, 18–20 lines/sec sustained, every one of them BYTE-IDENTICAL (a single
// call site: useAudioEngine). Each line also round-tripped popout console → main.js → the dashboard's
// console → disk, so the cheapest thing in the trace was the logging itself.
//
// The question this trace answers is "what came up, in what ORDER, and did any of it happen before
// sign-in" (boot-seq.ts). The FIRST touch of an existing instance is the entire answer; the
// 211,950 repeats after it carried no information. Gating on this Set also takes bootCallSite() —
// which builds an Error stack — off the render path, which is why the guard is checked BEFORE it.
//
// Deliberately NOT deleted (BUILD THE SENSE, NOT THE SCAFFOLD): the trace is the standing evidence
// for the account-is-the-root ordering, and it is still emitted — once.
const preAuthTraced = new Set<number>();

export function getEngine(stationId: number): AudioEngine {
  if (!registry.has(stationId)) {
    // The caller is what matters: which code path constructed an engine, and was anyone signed in yet.
    const site = bootCallSite();
    bootSeq(`ENGINE CONSTRUCTED station=${stationId} ← ${site}`);
    registry.set(stationId, new AudioEngine(stationId));
  } else if (!bootAuthDone() && !preAuthTraced.has(stationId)) {
    preAuthTraced.add(stationId);
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
