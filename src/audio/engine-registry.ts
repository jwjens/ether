import { AudioEngine, engine as singletonEngine } from "./engine-rodio";

// Pre-register the station-1 singleton so getEngine(1) returns the same
// instance that legacy consumers import directly from engine-rodio. Without
// this, getEngine(1) would create a second AudioEngine(1), producing two
// divergent JS-side queues. (Patches a Commit 2 oversight.)
const registry = new Map<number, AudioEngine>([[1, singletonEngine]]);

export function getEngine(stationId: number): AudioEngine {
  if (!registry.has(stationId)) {
    registry.set(stationId, new AudioEngine(stationId));
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
