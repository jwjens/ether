'use strict';
// AN ISOLATED RUN — its own userData (--user-data-dir), its own engine pipe, no :3400, no single-instance lock — so it
// never touches the live app's folders or engine. Two ways in, both need an explicit --user-data-dir:
//   · ETHER_SMOKE=1        the release/CI smoke check (it then checks the window and quits)
//   · ETHER_ISOLATED_DEV=1 a DEV build only (2026-11-01, the local billing test): the same isolation, kept running.
//     A packaged build ignores it.
function isIsolatedRun({ env = process.env, packaged, hasUserDataDir }) {
  if (!hasUserDataDir) return false;
  if (env.ETHER_SMOKE === "1") return true;
  return env.ETHER_ISOLATED_DEV === "1" && !packaged;
}
module.exports = { isIsolatedRun };
