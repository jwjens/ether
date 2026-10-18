// THE MODULE REGISTRY — Screen Builder Phase 1 (docs/screen-builder-design-2026-10-18.md §2.1, §5).
//
// A module IS the app's own component, imported from the file the app already renders it from — never a copy,
// never a mock, never defined under src/modules. The registry only says how a surface may place it:
//   instances  how many of it one surface may hold (§2.4)
//   station    "follows-layout": one station per layout (Jeff's decision 1); the ModuleFrame takes ONE station
//   options    what a pane may set on it, passed through as props
//   help       its help doc, docs/help-module-<type>.md (doors before rooms, §2.7)
//   empty      what the component itself shows when there is nothing in it, and where (§2.7); the proof test
//              renders the module empty and asserts this text
//   proof      the test that proves it behaves like the page it comes from (§3)
//
// src/modules/proof/placeable.test.ts (S4) fails the build if an entry's component is not imported from the app,
// or its proof test, help doc or empty state is missing. Nothing is placeable until it is wired.
import type { ComponentType } from "react";
import { BoutiqueCartWall } from "../components/DeckConfigurator";
import ProgramLog from "../components/ProgramLog";
// The Library window (☰ → Library): the app's own LibraryPanel with the Library's one set of deck / queue actions
// (src/lib/libraryDeckActions.tsx). LibraryPanel itself stays in App.tsx (§2.6: lifted out later, as a pure move).
import LibraryWindow from "../components/LibraryWindow";

export type ModuleType = "carts" | "programlog" | "library";

export interface ModuleOption {
  key: string;
  kind: "enum" | "bool";
  label: string;
  values?: readonly string[];
  default: string | boolean;
}

export interface ModuleEntry {
  type: ModuleType;
  title: string;
  /** The app's own component. */
  component: ComponentType<any>;
  instances: "many" | "one-per-window" | "one";
  station: "follows-layout";
  options: readonly ModuleOption[];
  help: string;
  empty: { text: string; source: string };
  proof: string;
}

export const MODULES: readonly ModuleEntry[] = [
  {
    type: "carts",
    title: "Carts",
    component: BoutiqueCartWall,
    // Two walls are safe: hotkeys belong to the focused wall only, and a fire has its own in-flight guard
    // (DeckConfigurator.tsx ownsCartHotkeys / firingRef; proved by S6).
    instances: "many",
    station: "follows-layout",
    options: [
      { key: "variant", kind: "enum", label: "Layout", values: ["grid", "strip"], default: "grid" },
    ],
    help: "docs/help-module-carts.md",
    // An unassigned tile reads "Empty" and its tooltip names the one action: click to assign.
    empty: { text: "Empty — click to assign", source: "src/components/DeckConfigurator.tsx" },
    proof: "src/modules/proof/carts.proof.test.tsx",
  },
  {
    type: "programlog",
    title: "Program Log",
    component: ProgramLog,
    // State is per instance and schedule:changed is debounced per instance (proved by S2). Each instance keeps its
    // own on-screen day; the stored last-picked day that seeds the NEXT one opened is per station, shared.
    instances: "many",
    station: "follows-layout",
    options: [
      { key: "embedded", kind: "bool", label: "Docked (short strip) layout", default: false },
    ],
    help: "docs/help-module-programlog.md",
    empty: { text: "No shows configured for this day", source: "src/components/ProgramLog.tsx" },
    proof: "src/modules/proof/programlog.proof.test.tsx",
  },
  {
    type: "library",
    title: "Song Library",
    component: LibraryWindow,
    // State is per instance. Column widths and the page are stored per station in localStorage, so two instances
    // share them (a width dragged in one shows in the other on its next mount) — documented, not changed, in Phase 1.
    instances: "many",
    station: "follows-layout",
    options: [],
    help: "docs/help-module-library.md",
    empty: { text: "Import audio to add items to the library.", source: "src/App.tsx" },
    proof: "src/modules/proof/library.proof.test.tsx",
  },
];

export function moduleEntry(type: ModuleType): ModuleEntry {
  const e = MODULES.find(m => m.type === type);
  if (!e) throw new Error(`no module registered as "${type}"`);
  return e;
}
