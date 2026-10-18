// The instance id a ModuleFrame gives the module it renders (Screen Builder, docs/screen-builder-design-2026-10-18.md
// §2.1, §2.4). Two of the same module on one surface are two instances; whatever must be per instance — hotkey
// ownership, DOM ids, stored view preferences — keys on this id.
//
// Lives here, not under src/modules, so the app's own components can read it without importing the registry (which
// imports them). Outside a ModuleFrame it is null and a component behaves exactly as it does today.
import { createContext, useContext } from "react";

export const ModuleInstanceContext = createContext<string | null>(null);

export function useModuleInstanceId(): string | null {
  return useContext(ModuleInstanceContext);
}
