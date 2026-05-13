import React, { createContext, useContext, useEffect } from "react";
import { AudioEngine } from "./engine-rodio";
import { getEngine, initializeRegistry } from "./engine-registry";
import { useActiveStation } from "../hooks/useActiveStation";

const AudioEngineContext = createContext<number>(1);

export function AudioEngineProvider({ children }: { children: React.ReactNode }) {
  const { stationId } = useActiveStation();

  useEffect(() => {
    const ether = (window as any).ether;
    if (!ether?.stations?.list) return;
    ether.stations.list()
      .then((rows: { id: number }[]) => {
        if (Array.isArray(rows)) {
          initializeRegistry(rows.map((r: { id: number }) => r.id));
        }
      })
      .catch((e: unknown) => {
        console.error("[engine-registry] stations.list failed, falling back to [1]:", e);
        initializeRegistry([1]);
      });
  }, []);

  return (
    <AudioEngineContext.Provider value={stationId}>
      {children}
    </AudioEngineContext.Provider>
  );
}

export function useAudioEngine(): AudioEngine;
export function useAudioEngine(stationId: number): AudioEngine;
export function useAudioEngine(stationId?: number): AudioEngine {
  const activeStationId = useContext(AudioEngineContext);
  return getEngine(stationId ?? activeStationId);
}
