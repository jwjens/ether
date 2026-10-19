// The frame every module renders in — Screen Builder Phase 1 (docs/screen-builder-design-2026-10-18.md §2.1, §2.3).
//
// ONE STATION PER LAYOUT (Jeff's decision 1). <ModuleSurface station> takes the station once for the whole surface:
// a StationScope (so useActiveStation() in every module reads it, not the machine-global cache) and the engine
// provider under it (so useAudioEngine() resolves that station's engine, fresh, by id). A module cannot name a
// station of its own — that is option (b), later, per layout.
//
// <ModuleFrame type instanceId options> gives the module the other two things and nothing else:
//   · its instance id (ModuleInstanceContext) — hotkeys, DOM ids, stored view prefs are per instance;
//   · its options, as props.
// The frame adds no buttons of its own. Outside a ModuleSurface it refuses to render: a module never guesses its
// station (S7).
import type { ReactNode } from "react";
import { StationScope, useStationScope, type ScopedStation } from "../hooks/useActiveStation";
import { AudioEngineProvider } from "../audio/AudioEngineContext";
import { ModuleInstanceContext } from "../hooks/useModuleInstance";
import { moduleEntry, type ModuleEntry, type ModuleType } from "./registry";

export function ModuleSurface({ station, children }: { station: ScopedStation; children: ReactNode }) {
  return (
    <StationScope station={station}>
      <AudioEngineProvider>{children}</AudioEngineProvider>
    </StationScope>
  );
}

export interface ModuleFrameProps {
  type: ModuleType;
  instanceId: string;
  options?: Record<string, unknown>;
}

export function ModuleFrame({ type, instanceId, options }: ModuleFrameProps) {
  const scope = useStationScope();
  if (!scope) {
    throw new Error(
      `ModuleFrame "${type}" (${instanceId}) has no station: every module renders inside <ModuleSurface station>. ` +
      "A module never falls back to the machine's active station."
    );
  }
  const entry = moduleEntry(type);
  return (
    <ModuleInstanceContext.Provider value={instanceId}>
      {/* keyed by type: a pane whose type changes remounts rather than reusing another module's state */}
      <ModuleBody key={type} entry={entry} options={options} />
    </ModuleInstanceContext.Provider>
  );
}

function ModuleBody({ entry, options }: { entry: ModuleEntry; options?: Record<string, unknown> }) {
  const Component = entry.component;
  return <div style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column" }}><Component {...resolveOptions(entry, options)} /></div>;
}

/** A saved enum value the registry no longer offers renders as that option's default — a layout saved before the
 *  values changed (e.g. Carts "grid", retired 2026-10-19) shows what a new pane would, not a retired look. */
export function resolveOptions(entry: ModuleEntry, options?: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = { ...(options || {}) };
  for (const opt of entry.options) {
    if (opt.kind === "enum" && opt.key in o && !opt.values?.includes(o[opt.key] as string)) o[opt.key] = opt.default;
  }
  return o;
}
