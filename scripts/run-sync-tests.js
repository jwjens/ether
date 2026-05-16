'use strict';
// scripts/run-sync-tests.js — run T-01..T-38 inside Electron's Node runtime.
//
// WHY ELECTRON: better-sqlite3 is compiled for Electron's Node ABI (145).
// System Node (ABI 137) cannot load it. Running vitest in system Node fails
// before any test logic executes. Running inside Electron avoids any rebuild
// dance and keeps Ether launchable regardless of test outcome — the ABI never
// changes. Same pattern as scripts/verify-transformer-chain.js.
//
// Usage (package.json "test:sync"):
//   electron --no-sandbox scripts/run-sync-tests.js [-- <vitest-filter>]
//
// Exit codes: 0 = all pass, 1 = failures or startup error.

(async () => {
  let startVitest;
  try {
    ({ startVitest } = await import('vitest/node'));
  } catch (err) {
    console.error('[run-sync-tests] cannot import vitest/node:', err.message);
    console.error('  Make sure vitest is installed: npm install');
    process.exit(1);
  }

  // Filters: anything after '--' on the command line, e.g.
  //   electron --no-sandbox scripts/run-sync-tests.js -- t01
  const argSep = process.argv.indexOf('--');
  const filters = argSep >= 0 ? process.argv.slice(argSep + 1) : [];

  let vitest;
  try {
    vitest = await startVitest('test', filters, {
      // All tests live under electron/sync/tests/
      include:     ['electron/sync/tests/**/*.test.js'],
      exclude:     ['**/node_modules/**'],
      environment: 'node',
      // pool: 'threads' — worker_threads, same Electron process, same ABI.
      pool:        'threads',
      reporters:   ['verbose'],
      // globals: true — inject describe/it/expect/vi into CJS test files so
      // they don't need to require('vitest') (which vitest v4 prohibits in CJS).
      globals:     true,
    });
  } catch (err) {
    console.error('[run-sync-tests] vitest startup error:', err.message);
    process.exit(1);
  }

  if (!vitest) {
    // startVitest returns undefined when config loading fails
    process.exit(1);
  }

  const failed = vitest.state?.getCountOfFailedTests?.() ?? 0;
  await vitest.close();
  process.exit(failed > 0 ? 1 : 0);
})();
