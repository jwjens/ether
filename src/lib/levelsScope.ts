// Renderer mirror of matchesStation in electron/levels-scope.js — covered by scripts/test-levels-scope.js.
// Should a meter bound to `myUuid` render this levels frame?
//  • other station's tagged frame → NO (kills the VU cross-talk)
//  • own station's frame → YES
//  • untagged frame, or my uuid not resolved yet → YES (never go dark; the fixed build always tags,
//    both the daemon relay and the in-process fallback, so this net only covers boot/edge)
export function matchesStation(
  lvl: { stationUuid?: string } | null | undefined,
  myUuid: string | null | undefined
): boolean {
  if (!myUuid) return true;
  if (!lvl || lvl.stationUuid == null) return true;
  return lvl.stationUuid === myUuid;
}
