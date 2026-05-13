import { AudioEngine } from "./engine-rodio";

const registry = new Map<number, AudioEngine>();

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
