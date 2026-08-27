// src/lib/assetTypes.ts — the asset type registry, renderer side.
//
// docs/library-asset-build-plan-2026-08-26.md · docs/asset-type-fixed-vs-configurable-2026-08-26.md
//
// The DATA lives in shared/asset-types.json, read by this module and by electron/asset-types.js
// (main + daemon). One definition, two loaders — a type present in one and not the other is how a row
// becomes invisible to half the product.
//
// THE POINT OF THIS MODULE: nothing anywhere else branches on a type NAME. Everything asks a
// CAPABILITY — `rotationEligible`, `countsAsMusic`, `showAsTab` — so adding a ninth type is a diff of
// one object in the JSON and nothing else. `assetTypes.test.ts` asserts exactly that by registering a
// type at runtime and checking it reaches the rotation set, the filter list and the tab list.
//
// THREE AXES, NEVER COLLAPSED (docs/three-axes-preserved-2026-08-26.md):
//   TYPE      — this file. 8, developer-defined, install-wide.
//   CATEGORY  — `categories`. UNLIMITED, operator-created, per station. Not this.
//   METADATA  — `metadata_definitions`. UNLIMITED, operator-created, per station. Not this either.
// This registry is never a category list and never a field list.
//
// DUCKING IS DELIBERATELY ABSENT. Duck is a function of the channel/deck, available to anything
// loaded on it including a live mic. Nothing here may override, replace, gate or pre-empt it.

import registry from "../../shared/asset-types.json";

export type SchedulerKind =
  | "rotation" | "traffic-break" | "cadence" | "date-list" | "log-element" | "manual";
export type BusKind = "rotation-deck" | "source-channel" | "cart-overlay" | "aux-deck";

/** Per-station overridable. The registry supplies the default; the operator decides. */
export interface AssetTypeBehaviour {
  label: string;
  labelOne: string;
  rotationEligible: boolean;
  scheduler: SchedulerKind;
  bus: BusKind;
  honorsSeparation: boolean;
  countsAsMusic: boolean;
  showAsTab: boolean;
  sortOrder: number;
}

/** Structural — identical on every station, never overridable. */
export interface AssetTypeDef {
  code: string;
  badge: string;
  color: string;
  bg: string;
  border: string;
  commercial: boolean;
  metaTable: string | null;
  defaults: AssetTypeBehaviour;
}

const BUILT_IN: AssetTypeDef[] = (registry as any).types as AssetTypeDef[];

// Runtime registrations sit alongside the built-ins. This exists so the openness test can add a type
// without editing the JSON — and so a future build can register one without a rebuild.
const EXTRA: AssetTypeDef[] = [];

/** THE fallback. An asset whose type this build has never heard of is still a playable thing. */
export const FALLBACK_TYPE = "SONG";

export function registerAssetType(def: AssetTypeDef): void {
  const i = EXTRA.findIndex(d => d.code === def.code);
  i >= 0 ? EXTRA.splice(i, 1, def) : EXTRA.push(def);
}

/** Test-only: undo a runtime registration so one test cannot leak into the next. */
export function unregisterAssetType(code: string): void {
  const i = EXTRA.findIndex(d => d.code === code);
  if (i >= 0) EXTRA.splice(i, 1);
}

export function allTypes(): AssetTypeDef[] {
  return [...BUILT_IN, ...EXTRA].sort((a, b) => a.defaults.sortOrder - b.defaults.sortOrder);
}

export function typeDef(code: string | null | undefined): AssetTypeDef {
  const k = String(code ?? "").trim().toUpperCase();
  return allTypes().find(t => t.code === k)
      ?? allTypes().find(t => t.code === FALLBACK_TYPE)!;
}

/**
 * NULL, '' and an UNKNOWN code all normalise to SONG.
 *
 * Unknown-degrades-to-something is deliberate and load-bearing: a newer build may write a type this
 * one has never seen, and that asset must still be listed, badged and reportable rather than silently
 * vanishing from a log. Dropping it would be the worst outcome for an as-run record.
 */
export function normalizeType(code: string | null | undefined): string {
  return typeDef(code).code;
}

/** Is this a type this build actually knows, as opposed to one it is degrading? */
export function isKnownType(code: string | null | undefined): boolean {
  const k = String(code ?? "").trim().toUpperCase();
  return allTypes().some(t => t.code === k);
}

/** The codes matching a capability — the ONLY way a query learns which types it wants. */
export function typesWhere(pred: (b: AssetTypeBehaviour, d: AssetTypeDef) => boolean): string[] {
  return allTypes().filter(t => pred(t.defaults, t)).map(t => t.code);
}

/** `?, ?, ?` for an IN-clause. Pairs with typesWhere so no query ever spells a type literal. */
export function placeholders(codes: readonly string[]): string {
  return codes.map(() => "?").join(", ");
}

// ── The named capability questions. Call these, never `type === 'SPOT'`. ────────────────────────
export const rotationEligibleTypes = () => typesWhere(b => b.rotationEligible);
export const musicCountingTypes    = () => typesWhere(b => b.countsAsMusic);
export const separationTypes       = () => typesWhere(b => b.honorsSeparation);
export const tabTypes              = () => allTypes().filter(t => t.defaults.showAsTab);
export const commercialTypes       = () => allTypes().filter(t => t.commercial).map(t => t.code);

/**
 * Does this asset pass the operator's element filter? An EMPTY selection means EVERYTHING — the
 * default state, and the thing it must never be confused with "show nothing".
 */
export function passesTypeFilter(code: string | null | undefined, selected: ReadonlySet<string>): boolean {
  if (!selected || selected.size === 0) return true;
  return selected.has(normalizeType(code));
}
