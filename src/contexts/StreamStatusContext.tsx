import React, { createContext, useContext, useEffect, useReducer, useRef } from "react";

export interface StreamStatus {
  destId:       string;
  label:        string;
  state:        "idle" | "connecting" | "live" | "error";
  speed:        number | null;
  bitrate:      number | null;
  uptimeSec:    number | null;
  errorMsg:     string | null;
  speedHistory: number[];
}

interface GlobalStatus {
  anyLive:   boolean;
  liveCount: number;
}

interface StreamStatusState {
  dests:  Record<string, StreamStatus>;
  global: GlobalStatus;
}

type Action =
  | { type: "dest";   payload: StreamStatus }
  | { type: "global"; payload: GlobalStatus }
  | { type: "init";   payload: { dests: StreamStatus[]; anyLive: boolean; liveCount: number } };

function reducer(state: StreamStatusState, action: Action): StreamStatusState {
  switch (action.type) {
    case "dest":
      return { ...state, dests: { ...state.dests, [action.payload.destId]: action.payload } };
    case "global":
      return { ...state, global: action.payload };
    case "init": {
      const dests: Record<string, StreamStatus> = {};
      for (const d of action.payload.dests) dests[d.destId] = d;
      return { dests, global: { anyLive: action.payload.anyLive, liveCount: action.payload.liveCount } };
    }
    default:
      return state;
  }
}

const initialState: StreamStatusState = {
  dests:  {},
  global: { anyLive: false, liveCount: 0 },
};

const StreamStatusContext = createContext<StreamStatusState>(initialState);

export function StreamStatusProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const handlersRef = useRef<{ destH: unknown; globalH: unknown } | null>(null);

  useEffect(() => {
    const ether = (window as any).ether;
    if (!ether?.stream) return;

    // Seed with current snapshot
    ether.stream.getAllStatus().then((snap: any) => {
      if (snap) dispatch({ type: "init", payload: snap });
    }).catch(() => {});

    const destH   = ether.stream.onDestStatus((v: StreamStatus) => dispatch({ type: "dest",   payload: v }));
    const globalH = ether.stream.onGlobal((v: GlobalStatus)     => dispatch({ type: "global", payload: v }));
    handlersRef.current = { destH, globalH };

    return () => {
      ether.stream.offDestStatus(destH);
      ether.stream.offGlobal(globalH);
    };
  }, []);

  return (
    <StreamStatusContext.Provider value={state}>
      {children}
    </StreamStatusContext.Provider>
  );
}

export function useStreamStatus() {
  return useContext(StreamStatusContext);
}

export function useDestStatus(destId: string): StreamStatus | null {
  const ctx = useContext(StreamStatusContext);
  return ctx.dests[destId] ?? null;
}

export function useGlobalStatus(): GlobalStatus {
  return useContext(StreamStatusContext).global;
}
