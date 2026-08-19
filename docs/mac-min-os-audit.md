# macOS minimum-version audit — why Ether refuses macOS 11

**Date:** 2026-08-18 · **Trigger:** Jeff's Intel iMac runs macOS 11 (Big Sur) and cannot install; the
Mac build (3 live installs) rejects it with an OS-version message. **Read-only. Nothing changed, nothing
built.**

**Verdict up front: the floor is REAL, not a config choice we made.** It comes from Electron itself. A
one-line `minimumSystemVersion: "11.0"` would rewrite the plist and let the app *launch* on Big Sur —
onto a binary that does not support it. That is a worse failure than today's honest refusal. The only
route to Big Sur is **downgrading Electron to 39.x**, and that cost is quantified in §5.

---

## 1 · Layer by layer, with receipts

### 1.1 · Our electron-builder config — declares NO floor

`electron-builder.json`, `mac` section, in full:

```json
"mac": {
  "category": "public.app-category.music",
  "entitlements": "build-resources/entitlements.mac.plist",
  "entitlementsInherit": "build-resources/entitlements.mac.plist",
  "hardenedRuntime": true,
  "icon": "build-resources/icon.icns",
  "target": [{ "arch": ["x64", "arm64"], "target": "dmg" }]
}
```

**There is no `minimumSystemVersion` key** — not in `electron-builder.json`, not in `package.json`.
And electron-builder only touches the plist when we supply one
(`node_modules/app-builder-lib/out/macPackager.js:462-464`):

```js
const minimumSystemVersion = this.platformSpecificBuildOptions.minimumSystemVersion;
if (minimumSystemVersion != null) {
  appPlist.LSMinimumSystemVersion = minimumSystemVersion;
}
```

Since we pass nothing, `LSMinimumSystemVersion` is whatever **Electron's own framework plist** carries.
**We did not choose this number.**

### 1.2 · The message is not ours either

`grep` for `OS 13` / `13 or newer` / `or newer` across `src/`, `electron/`, `build-resources/` and the
JSON configs returns **nothing**. The dialog Jeff sees is macOS's own Gatekeeper/LaunchServices refusal,
driven by `LSMinimumSystemVersion`. No product code is making this decision.

### 1.3 · Electron — this is the floor

We ship **Electron 41.1.0** (`package.json` → `^41.1.0`; `node_modules/electron/package.json` →
`41.1.0`). Electron's own README for that exact tag:

> **v41.1.0** — *"macOS (Monterey and up): Electron provides 64-bit Intel and Apple Silicon / ARM
> binaries for macOS."*

**Monterey is macOS 12.** Big Sur (11) is below it. The floor is Electron's, and it is real: these are
the binaries, not a policy string.

The version history, fetched from each tag's README — the boundary is exact:

| Electron | Stated macOS support | Covers Big Sur (11)? |
|---|---|---|
| 32.3.3 | "Catalina and up" (10.15) | yes |
| 37.0.0 | "Big Sur and up" (11) | yes |
| **39.0.0** | **"Big Sur and up" (11)** | **yes — the NEWEST that does** |
| 40.0.0 | "Monterey and up" (12) | no |
| **41.1.0 (ours)** | **"Monterey and up" (12)** | **no** |

Electron dropped Big Sur at **40**. We are one major past it.

### 1.4 · Native dependencies — none of them impose a floor

| Dep | Receipt | Imposes a macOS floor? |
|---|---|---|
| Rust addon (`native/`) | no `MACOSX_DEPLOYMENT_TARGET` in `Cargo.toml`, `build.rs`, or `.cargo/config.toml`; no deployment-target setting anywhere in the tree | **no** — inherits the toolchain default |
| `better-sqlite3` 12.8.0 | `engines` declares node versions only, no OS floor | **no** |
| CI (`.github/workflows/build.yml`) | `macos-latest` runner, node 22; **no `MACOSX_DEPLOYMENT_TARGET` set anywhere** | **no** |

A grep for `MACOSX_DEPLOYMENT_TARGET` across the repo returns nothing. No native dependency is the
cause; if every native dep were rebuilt for 10.15, the app would still refuse to launch, because the
Electron framework itself is the gate.

## 2 · Verdict

**Real dependency floor. The dep is Electron 41.**

- Not a declared floor we chose — §1.1 proves we declare nothing.
- Not a native-dep floor — §1.4 proves none of them set one.
- The one-line change (`"minimumSystemVersion": "11.0"`) **would be a lie**: it edits the plist that
  LaunchServices checks, not the binary. The app would start on Big Sur and fail on whatever API
  Electron 40+ requires — an unpredictable crash instead of a clear "this needs a newer macOS". Do not
  do this.

## 3 · Architecture — Intel is covered

`electron-builder.json` targets `"arch": ["x64", "arm64"]` for the `dmg`, so **darwin-x64 is built** and
Jeff's Intel iMac is not excluded on architecture grounds. This is a version problem, not an
architecture problem.

**One caveat, flagged as UNVERIFIED:** CI builds on `macos-latest`, which is an Apple-Silicon runner, so
the x64 dmg is a cross-build. Whether the x64 dmg's *native* modules (`better-sqlite3`, the Rust addon)
are genuinely x86_64 rather than arm64 has not been verified here and cannot be from Windows. If any of
the 3 live installs is an Intel Mac, that is already the receipt. If all three are Apple Silicon, the
x64 dmg has never actually been exercised, and that is worth knowing **before** anyone concludes an
Electron downgrade fixed the problem. Check with `lipo -archs` / `file` on the installed
`ether-audio.node` and `better_sqlite3.node` inside an Intel install.

## 4 · One discrepancy worth resolving before acting

Electron 41 declares **Monterey (12)**, but the reported message says **13**. Both cannot be the plist
value. Possibilities, none of which change the verdict:

- the framework's `LSMinimumSystemVersion` is set higher than the README's stated support;
- the live installs were built by CI at a different Electron version than the tree currently pins;
- the "13" in the report is a paraphrase of the number on screen.

**The settling check, on any Mac with the app or dmg:**

```
plutil -p /Applications/Ether.app/Contents/Info.plist | grep LSMinimumSystemVersion
```

That number is the actual floor. It matters because if the plist says **13** while Electron 41 claims
12, then moving to Electron 39 needs its plist checked the same way rather than assumed — I would not
want to spend a downgrade and still land above Big Sur.

## 5 · If Jeff needs macOS 11 — the option, and what it costs

**Pin Electron to 39.x** (the newest release supporting Big Sur, §1.3), rebuild, re-release the Mac
build. Costs, stated plainly:

1. **It is global, not per-platform.** `package.json` carries one Electron version for every target.
   Dropping to 39 downgrades **Windows and OV too** — the same binary generation that is currently on
   air. Shipping 39 on macOS and 41 on Windows means two build configurations, which is a real piece of
   release machinery this project does not have today.
2. **Two majors of Chromium security fixes.** Electron supports the latest three majors, so 39 is
   inside the support window now, but that window closes as 42 ships. This is a decision with an expiry
   date, not a permanent fix.
3. **Native rebuild required.** Electron 39 has a different ABI (`NODE_MODULE_VERSION`) from 41, so
   `better-sqlite3` and the Rust addon must be rebuilt for it. Mechanical — `electron-builder` already
   runs `@electron/rebuild` — but it invalidates every cached native artifact and needs a full
   regression pass on Windows, which is where the paying stations are.
4. **A machine ceiling remains.** Big Sur is Apple's 2020 release, already out of security support. A
   downgrade buys this iMac time; it does not make it a long-term platform.

**Alternatives that avoid the downgrade**, if the goal is "Jeff can use Ether on that iMac":

- upgrade the iMac if its model supports Monterey or newer (2015+ Intel iMacs generally reach Monterey;
  Ventura/13 needs a 2017+ model);
- run Ether on another machine and reach the iMac through the web surfaces already in production;
- treat the iMac as a listener/monitor rather than a station terminal.

## 6 · Recommendation, and the gate

**Recommended:** run the §4 `plutil` check first, on the actual dmg. One command, and it converts this
audit's remaining assumption into a number. Then decide between the Electron 39 pin (with §5.1's global
consequence understood) and upgrading the iMac.

**No build has been made and none should be until Jeff says so** — the Mac build needs its own
environment (macOS runner, signing identity, notarisation) and is a release-affecting change to a
version that Windows shares. Jeff's GO required.
