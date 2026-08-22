# v4.4.229 release blocked — profile-paths test isolation is Windows-only

**Date:** 2026-08-21 · **Run:** Build Ether #282 (`chore(release): 4.4.229`) · **Tag:** v4.4.229 → c26ff67
**Status:** tag pushed, `test` job FAILED, **no release published**, no installer uploaded.

## What happened

`npx vitest run` failed on the ubuntu runner: 5 of 16 tests in `electron/profile-paths.test.js`.
The same file passes **16/16 locally on Windows**, and the full suite passes locally
**24 files / 332 tests**. `npx tsc --noEmit` exits 0 locally. Nothing else in the gate is red.

## Root cause — one line

`electron/profile-paths.test.js:15` isolates each test by setting `process.env.LOCALAPPDATA`,
but `etherRoot()` (`electron/profile-paths.js:60-67`) only reads `LOCALAPPDATA` **when
`process.platform === "win32"`**. On Linux it reads `XDG_DATA_HOME || ~/.local/share`; on macOS,
`~/Library/Application Support`. The test sets neither.

So on the ubuntu runner the per-test `SANDBOX/<sub>` root is **ignored entirely** and all 16 tests
share the runner's real `~/.local/share/Ether/profiles`. State written by one test is still there
for the next one.

This is a **test-isolation defect. The product code is correct** — `LOCALAPPDATA` is a Windows
concept and the XDG/darwin branches are the right roots on those platforms. Nothing about how a
shipped build resolves a profile is wrong, and no product file needs to change.

## The receipt (from the CI log, not inference)

The last failure is decisive:

```
lists real profiles and never the scratch one
- Expected  [ "ETH-STN-AAAA-1111-2222",                           "ETH-STN-BBBB-3333-4444" ]
+ Received  [ "ETH-STN-AAAA-1111-2222", "ETH-STN-BAA8-E056-6FC8", "ETH-STN-BBBB-3333-4444" ]
```

That test's own `load("list")` sandbox only ever seeds AAAA and BBBB. `ETH-STN-BAA8-E056-6FC8` is
`KEY` (test:20) — seeded by a **different** test, in what is supposed to be a **different**
sandbox. Its presence proves the sandboxes are the same directory on Linux.

All five failures fall out of that one leak:

| # | Test | Why it fails |
|---|---|---|
| 1 | no pointer → no profile invented | `listProfiles()` returns `[BAA8]`, leaked from an earlier `seedProfile` |
| 2 | pointer naming a missing profile | same leak |
| 3 | dir but no database is not a profile | the leaked `openair.db` is still on disk, so `profileExists` is legitimately true |
| 4 | cold start resets the scratch profile | the leaked pointer+profile resolve as real, so `resolveActive` never takes the `freshPending` branch that rmSyncs the scratch dir (`profile-paths.js:167`) |
| 5 | lists real profiles, never scratch | the leak above |

## Proposed fix — test-only, ~3 lines

In `load()`, set the env var each platform actually reads, not just the Windows one:

```js
process.env.LOCALAPPDATA   = root;   // win32
process.env.XDG_DATA_HOME  = root;   // linux  <- the missing one; this is what CI reads
process.env.HOME           = root;   // darwin (os.homedir() honours HOME on posix)
```

with the original `HOME` restored in `afterAll`. No product file is touched.

**Rejected:** adding an `ETHER_ROOT` test override to `profile-paths.js`. That puts a test hook in
the file whose entire job is to be the one honest answer to "where does this account live" — the
test should speak the platform's language, not the product learn the test's.

## Standing gap this exposes

`build.yml` fires **only on a `v*` tag**, so a platform-dependent test defect committed on
2026-08-15 (77f6f25, 4.4.216) sat green on Windows for six days and surfaced at the moment of
release. Thirteen versions (216-228) were built locally and never tagged, so nothing caught it.
Already noted as the known cost of tag-only CI in `reference_leak_guard_ratchet`; recorded here as
a second receipt, not a new proposal.

## Re-tag decision (for Jeff)

`build` has `needs: test`, so it never ran and electron-builder never created a release. **No client
has ever seen a v4.4.229 release.** That makes deleting and re-pushing the tag safe, and it keeps
the version matching the installer Jeff verified on screen (`Ether Setup 4.4.229.exe`,
sha256 8C0656D8D1DA98B74942CCE98A96CD6444047919EEDD15765AAE2E8CD24D2267). A bump to 4.4.230 would
break that parity for a test-only change.
