# `window.ether.libraryAsset` is undefined — the third IPC seam

**Report (verbatim, Jeff, OVEVENTS 4.6.34):**
> deleting the orphan from the Library: "Could not delete 'Opportunity Village Spot': TypeError:
> Cannot read properties of undefined (reading 'deleteOwner')"
> "The result check works — it's naming the failure instead of going silent. But deleteLibraryRow
> calls something that isn't there."

**It is reaching for `window.ether.libraryAsset`, which is undefined.** Not `deleteOwner` — the
whole namespace. `undefined.deleteOwner` is what threw.

---

## The three links, and which one is broken

A renderer call crosses three independently breakable joins:

| # | link | where | state |
|---|---|---|---|
| 1 | the namespace is exposed on `window.ether` | `electron/preload.js` | **BROKEN** |
| 2 | the namespace has the method | `electron/preload-handlers.js:290-305` | present — `deleteOwner` is there |
| 3 | the channel has an `ipcMain.handle` | `electron/main.js` (after `installAll`) | present — `library:delete-asset` is registered |

Links 2 and 3 are the ones I verified in the shipped asar, and both are genuinely fine. **I never
checked link 1**, and it is the only one that was broken.

## Why link 1 breaks so easily

`preload-handlers.js` exports `buildHandlers(ipcRenderer)`, and its own header comment describes the
intended consumer as:

    contextBridge.exposeInMainWorld('ether', { ...existingNamespaces, ...handlers });

**`preload.js` does not do that.** It hand-wires every namespace, one line each
(`electron/preload.js:407-...`, *"Typed sync handlers — all 34 namespaces wired (Phase 3.5)"*):

    albums:        handlers.albums,
    announcements: handlers.announcements,
    ...

A namespace added to `preload-handlers.js` and not added to that list exists, is exported, is
reachable from nothing. There is no error at any layer — the object is simply absent from the bridge.

`libraryAsset` was added in **v50** and never wired, which was harmless for exactly as long as its own
comment said it would be:

    // NOTHING IN THE UI READS THESE YET. v50 is additive; `songs` and `spots` are still authoritative.

`src/App.tsx:4837` is the first line in the codebase to read it. It went in yesterday, in the Library
delete fix. The defect is four months old and was triggered by the first caller.

## The full sweep — is anything else unwired?

    namespaces built by preload-handlers.js : 41
    namespaces wired through preload.js     : 37

    NOT EXPOSED (4):
      libraryAsset       <- CALLED at src/App.tsx:4837        ** the live bug **
      assetSpotMeta         not called by the renderer
      assetSweeperMeta      not called by the renderer
      stations              FALSE POSITIVE — exposed inline at preload.js:376 with custom logic,
                            not via `handlers.stations` (main.js excludes stations:* from installAll)

So: **one real break, two latent, one false positive.** `assetSpotMeta` and `assetSweeperMeta` are the
same v50 vintage and will do exactly this to the first person who calls them — which, on the
assignment-model slices, is the next scheduled work in this area.

## Why neither existing guard caught it

They cover two different seams, and this is a third:

- **`smoke-ipc-payload-contract.js`** — *broadcast payload FIELDS*: a component reading `e.done` when
  the producer sends `downloaded`. It compares object literals on subscription callbacks. It has
  nothing to say about whether a namespace exists on the bridge.
- **`smoke-undefined-calls.js`** — *bare function calls inside a named file set* (`cloud-backup.js`).
  Renderer-to-bridge is out of its scope entirely.

Neither was mis-built; the seam was simply never covered. **This is the same class as
`window.ether.openExternal`** (2026-09-11), which also did not exist and whose real door was
`system.openUrl` — link 1, again, and caught by eye rather than by a gate. That is twice.

`tsc` cannot help either: `window as any` is how every one of these calls is written, which erases the
type before it can be checked.

## Proposed guard (NOT BUILT — read-only investigation)

`scripts/smoke-preload-bridge.js`, static, AST-based, three assertions:

1. **Every `ether.<ns>.<method>` read in `src/**` resolves to a namespace exposed on the bridge**, and
   to a method on it. Catches this bug and the `openExternal` one.
2. **Every namespace built by `preload-handlers.js` is exposed by `preload.js`** — or is on a short,
   explicit, commented allowlist of deliberately-unwired ones. That turns `assetSpotMeta` and
   `assetSweeperMeta` from silent traps into a decision someone wrote down.
3. **Every `ipcRenderer.invoke('channel')` in the preload has a matching `ipcMain.handle('channel')`
   somewhere in `electron/**`** — link 3, which is fine today and is the remaining unguarded joint.

Reading `preload.js`'s literal is the same AST trick `smoke-ipc-payload-contract.js` already uses on
the catalogue result objects, so this is a known technique in this codebase rather than a new one.

**The structural alternative, which is better and larger:** make `preload.js` spread `...handlers` the
way `preload-handlers.js` says it should, so the hand-written list cannot drift at all. That deletes
the class instead of guarding it, but it changes what 37 working namespaces resolve to in one edit
and needs its own verification pass. The guard is the correct minimal fix for today; the spread is
worth doing deliberately, not as a footnote to a delete-button repair.

## The immediate fix

One line in `electron/preload.js`, beside `libraryFolders`/`liners` in the alphabetical run:

    libraryAsset:  handlers.libraryAsset,

That alone makes the Library delete work — links 2 and 3 are already in the shipped build.

Until it ships, the orphan clears with:

    node scripts/repair-orphan-assets.js "<openair.db>" --write     (Ether closed)

---

# Built 2026-09-14 (v4.6.35)

## 1. The one-liner

`electron/preload.js:458` — `libraryAsset: handlers.libraryAsset,` with the reason at the call site.
Links 2 and 3 were already correct in the shipped 4.6.34, so this alone makes the Library delete work.

## 2. `scripts/smoke-preload-bridge.js` — all three links

    == link 1: every namespace built is exposed, or is a written-down decision ==
      PASS  all 42 namespaces accounted for (2 deliberately unwired)
      PASS  the unwired allowlist is current — every entry still exists and is still unwired
    == link 1: every namespace the renderer calls is on the bridge ==
      PASS  65 namespace(s) called across 237 files, all exposed
    == link 2: every method the renderer calls exists on its namespace ==
      PASS  502 method call(s) all resolve
      == link 3: every channel the preload invokes has an ipcMain handler ==
      PASS  457 channel(s) invoked, 3 known-broken, no NEW breakage

It reads `preload.js`'s `exposeInMainWorld` literal from the AST rather than by regex, because a
namespace can legitimately be `name: handlers.name`, an inline object (`stations`), or a
spread-plus-extras (`{ ...handlers.scheduledLog, getByDate, … }`). All three resolve to a real method
set. The consumer side uses the TypeScript compiler API, so `(window as any).ether.x.y` is seen
through the cast.

**PROVEN TO FAIL ON THE BUG IT EXISTS FOR.** A guard that has never failed is a guard nobody has
tested. Temporarily removing the one-liner:

    FAIL  built by preload-handlers.js but NOT on window.ether: libraryAsset
    FAIL  window.ether.libraryAsset is NOT exposed — src/App.tsx:4837 will throw
          "Cannot read properties of undefined"
    exit: 1

Caught from both directions — the producer gap and the exact consumer line — then green again on
restore.

## 3. The two latent ones are now a written decision

`DELIBERATELY_UNWIRED` holds `assetSpotMeta` and `assetSweeperMeta` with their reason. The guard also
fails if an entry goes **stale** — wired, or deleted from the factory — so the list cannot quietly
become an excuse. When the assignment slices need them, the fix is to wire them and delete the entry.

## 4. What the guard found on its first run

`ether.fs.writeFile` / `mkdir` / `copyFile`: exposed, invoked from seven-plus renderer sites, **no
handler anywhere**. Two files already recorded it in comments and routed around it; five did not.
Ratcheted as `KNOWN_MISSING_HANDLERS`, filed in `docs/backlog.md`, not fixed — a general
"write any file" channel is a sandbox decision, not a delete-button repair.

## 5. The spread is filed, not done

Per Jeff: filed in `docs/backlog.md` with the verification pass it needs, including the trap that
makes it more than a one-liner — the literal contains entries that deliberately differ from the
factory (`stations`, `scheduledLog`), and a `...handlers` placed after them silently overwrites both.
