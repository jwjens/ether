# Two pop-out defects in 4.6.20 — diagnosis (2026-09-08)

Read-only. Nothing built. Jeff's reports, verbatim:

1. *"The Carts pop-out shows the correct 10 carts but pressing one plays no audio."*
2. *"The Decks pop-out shows an old design from months ago, not the current deck UI. It says 'not
   available in monitor mode' on Source D/E/F."*

They have **one root cause between them and one apiece**. The shared one is that a pop-out window is
not the app — it is a bare renderer that mounts none of the app's providers.

---

## THE SHARED CAUSE — pop-outs mount no `AudioEngineProvider`

`src/main.tsx:96` renders the pop-out root bare:

```tsx
isPopout ? <PopoutRenderer panel={popoutPanel} /> : <App />
```

`App` wraps its tree in `<AudioEngineProvider>` (`src/App.tsx:2750`). `PopoutRenderer` has no
equivalent. And the context has a **default value**:

```tsx
const AudioEngineContext = createContext<number>(1);          // AudioEngineContext.tsx:7

export function useAudioEngine(stationId?: number): AudioEngine {
  const activeStationId = useContext(AudioEngineContext);
  return getEngine(stationId ?? activeStationId);              // ← 1, in every pop-out
}
```

So **any component that resolves its engine through the context commands station 1** when it renders
in a window, no matter which station is live. It does not throw, does not warn, and does not render
differently. It silently addresses a different station.

`PopoutRenderer` already works around this in one place — `PopoutLibrary` does
`getEngine(stationId ?? 1)` off `useActiveStation()` rather than `useAudioEngine()`
(`PopoutRenderer.tsx:165`). The workaround is local to that one function; nothing else got it.

**Four station engines exist on this machine** and the app switches between them. Receipt, from
`%APPDATA%\Ether\ether-startup.log`:

```
2026-09-08T23:29:56Z post-auth · SWITCH-EFFECT station=2 inst=e2 attachState=daemon read=true -> writes=true
2026-09-09T05:40:58Z post-auth · ENGINE CONSTRUCTED station=3
2026-09-09T05:40:58Z post-auth · ENGINE CONSTRUCTED station=4
```

A pop-out is therefore right only by coincidence — when the live station happens to be 1.

---

## DEFECT 1 — the Carts pop-out fires into the wrong station's engine

### What IS wired (and works)

`BoutiqueCartWall` is the **same component** in both windows — the dashboard's dock and the pop-out
render `<BoutiqueCartWall />` from `src/components/DeckConfigurator.tsx:714`. Everything it resolves
over IPC is correct in the pop-out:

| What | How | Correct in a pop-out? |
|---|---|---|
| Which carts to show | `cartSlots.list(stationId)`, `stationId` from `useActiveStation()` | **Yes** — hence the right 10 |
| Which channel to fire on | `resolveFireChannels()` re-reads `deckConfigs.list(stationId)` on every click | **Yes** — resolves Source F |
| The load/play command | `engine.loadToDeck(ch,…)` → `invoke("audio_load")` → `ether.audio.load(…)` → `ipcMain "audio:load"` → `audiodClient.cmd("load", …)` | reaches a live engine |

This is **not** the BYPASS defect. The command is not dropped; there is no missing handler. It goes
all the way to the daemon.

### What is NOT wired

`DeckConfigurator.tsx:715`:

```tsx
const engine = useAudioEngine();     // ← no argument, no provider ⇒ getEngine(1)
```

Every command the deck handle sends stamps `this.stationId` (engine-rodio.ts:1034, :983):

```ts
await invoke("audio_load", { deck: id, filePath, title, artist, gainDb, stationId: this.stationId });
const ok = await invoke("audio_play", { deck: deckId, stationId: this.stationId });
```

and `main.js:4228` forwards it verbatim, with **no active-station fallback**:

```js
audiodClient.cmd("load", { deck, filePath: fp, title, artist, gainDb, stationId })
```

(Compare `jukebox:play` two handlers below, which does `req?.stationId ?? getActiveStationId()`.)

**So: the wall reads the live station, picks the live station's cart channel, and then loads and
plays it on station 1.** Right cart, right slot letter, wrong station. Nothing is audible on the
station the operator is listening to.

### The second half — the wall's own error reporting is blind in a window

The fire path is deliberately loud. It reports where a cart went, and refuses to fail silently when
no channel is dialled (`DeckConfigurator.tsx:760`):

```ts
consoleLog("audio",  `[CART] "${cart.label}" → ${chans.join("+")}`);
consoleLog("error",  `[CART] no channel is dialled to Cart / SFX rack — firing on ${CART_CHANNEL}. …`);
```

But `consoleLog` is a **window-scoped DOM event** (`MasterOutput.tsx:37`):

```ts
window.dispatchEvent(new CustomEvent("ether:console", { detail: { type, msg, ts: Date.now() } }));
```

The console strip that listens lives in the dashboard's window. From a pop-out these are dispatched
into a window with no listener and no file sink.

**Receipt:** the 1.6 GB `ether-startup.log` contains **zero** `[CART]` lines, ever.

So the honesty layer written specifically to stop this path failing silently is itself absent in a
window — the operator gets silence with no line anywhere saying what happened. Same shape as the
BYPASS defect after all, one layer up: the *diagnosis* is what goes nowhere.

### What it takes

- **The fix:** a pop-out must resolve its engine from the active station, not from a context default.
  Either mount `AudioEngineProvider` in `PopoutRenderer` (one wrapper, fixes every pop-out at once,
  including any future one) or repeat `PopoutLibrary`'s `getEngine(stationId)` at each call site (N
  places, and the next component added is wrong again). The provider is the correct shape.
- **The guard:** `useAudioEngine()` silently returning station 1 is what made this invisible. A
  context default of `1` cannot be distinguished from a real station 1 — the default should be a
  sentinel a component can refuse to act on, the same rule the Jukebox already follows ("resolves the
  active station itself and refuses to guess").
- **The reporting:** `consoleLog` needs to reach the operator's console from any window — main-process
  relay, the way `ether.captions.onLine` already works — or every diagnostic written into a panel is
  dark the moment that panel is popped out.
- **Not required:** any change to the cart wall, the cart schema, `resolveFireChannels`, or the
  daemon. They are correct.

**UNVERIFIED at runtime:** that the live station right now is not 1. The one check that settles it —
open the Carts pop-out, press a cart, and look at the daemon's `load` line for `stationId`.

---

## DEFECT 2 — there are two deck implementations, and the pop-out renders the old one

**Yes: two implementations. Same class as the two cart walls.**

| | Dashboard | Decks pop-out |
|---|---|---|
| Renders | inline block in `LivePanel`, `src/App.tsx` ~4481–4695 | `src/components/StandaloneDecksPanel.tsx` |
| Per-channel widget | `ConsoleStrip` (A/B/C), `SourceChannelStrip` (D/E/F), `MicChannel` | `OnAirDeck` (A/B/C only), `MicDeck` |
| Source channels | full strip: assignment dropdown, DUCK, fader, meter, ON, PFL | **placeholder** |
| Add-channel `+` | yes, right edge, before Master | absent |
| Master | `MasterOutput` | absent |
| Deck state | App's engine subscription | own 100 ms `ether.audio.getState()` poll, **no stationId** |

`StandaloneDecksPanel.tsx:126-139` is the exact string Jeff saw:

```tsx
{type === "mic" || type === "guest" ? <MicDeck />
 : (["music","video"].includes(type) && ["A","B","C"].includes(cfg.slot)) ? <MusicDeckPanel slot={cfg.slot} />
 : ( … <div>not available in monitor mode</div> )}
```

A `type: "source"` row (D/E/F) matches neither branch, so it falls to the placeholder. The file's own
header says what it was built as — *"all-inclusive decks widget for secondary monitor … Cart/desk
decks → skipped (no standalone equivalent)"*. It predates source channels entirely.

Its poll is separately wrong now: `ether.audio.getState()` with no station argument, and per
`reference_daemon_getstate_no_position` the daemon's `getState` carries no position or duration at
all — so those decks read 0 whatever station answers.

### What the lift actually is

Jeff: *"That's the component the dashboard already renders. Lift that, don't rebuild it, and don't
keep two"* — and *"the + on the right edge for adding channels comes with it."*

**The obstacle: it is not a component.** It is inline JSX inside `LivePanel`, which takes 30+ props
from `App`. So the work is an **extraction**, not a move: pull ~215 lines into
`src/components/FaderSection.tsx`, have `LivePanel` render it, have `PopoutRenderer` render the same
one, and delete `StandaloneDecksPanel`.

Where each dependency comes from, and whether a second window can reach it:

| Dependency | Source | Reachable in a window? |
|---|---|---|
| `deckConfigs`, `saveDeckConfigs` | `useDeckConfig()` — station-scoped DB reads + `deckConfigs.updateBySlot` writes | **Yes**, read and write |
| `addSourceChannel` / `setSourceKind` / `setSourceDuck` / `removeSourceChannel` / `nextFreeSourceSlot` | `useCallback`s over the two above (`App.tsx:931-1030`) | **Yes** — re-creatable verbatim. This is why the `+` and the dropdowns carry over cleanly |
| `engineSlots` (a slot earns a strip by carrying audio) | `ether.audio.onLevels`, gated by `matchesStation(lvl, stationUuid)` | **Yes** — IPC stream + `useActiveStation().stationUuid` |
| `deckA/B/C` | App's engine subscription | Yes, with its own subscription — **once the engine is the right station's** (shared cause) |
| `MasterOutput` | already a pop-out (`case "master"`) | Yes |
| `computeDeckRole`, `boardSlots` | pure functions | Yes |
| **`srcChannelOn`** — the ON lamp | **`useState<Record<string,boolean>>({})` in App, `App.tsx:4085` — no store at all** | **NO. See below.** |
| `jukeboxOn` / `jukeboxVol` | `station_config_kv`, persisted, default OFF | Yes |

### The one thing that blocks two windows rendering it — and it is not cosmetic

`srcChannelOn` is unpersisted renderer state, and `App.tsx:4106` **asserts it downward into the
engine** on every change:

```tsx
useEffect(() => {
  for (const c of deckConfigs) {
    if (c.type !== "source" || !c.enabled || c.kind === "jukebox") continue;
    const on = srcChannelOn[c.slot] ?? true;
    engine.getDeck(c.slot)?.setMuted(!on);        // ← writes the channel cut
  }
}, [deckConfigs, srcChannelOn, engine]);
```

That effect exists for a good reason (its comment: the ON lamp was a claim, not a reading, and a cart
re-dialled onto an unasserted channel played into a slot whose cut had never been sent). But it means
the fader section is a **writer** of the channel cut, not just a display of it.

Render it in two windows and each carries its own `srcChannelOn`, each starting `{}` — so each
asserts `?? true`. The window where the operator pressed OFF sends `setMuted(true)`; the other
window's effect re-fires and sends `setMuted(false)`. **Two writers on the same channel cut, with no
arbiter** — the multi-writer hazard already filed on 2026-08-11, reproduced inside one machine.

There is also no read-back: `DeckState` carries `volume` but no `muted`, so a second window cannot
recover the truth from the engine even if it wanted to.

**So the extraction has a prerequisite:** the source-channel ON state needs a store, exactly the way
the jukebox channel's already has one (`station_config_kv`, per station, per slot — or a `deck_configs`
column beside `duck`, which is the closer analogue since `duck` is already persisted per row and
pushed to the engine on change). One truth, both windows read it, both windows write it, the assert
stays honest.

A second, smaller prerequisite: `useDeckConfig()` re-reads only on `[isReady, stationId]`. Add a
channel with `+` in one window and the other window's list is stale until it re-mounts. The `+`
working in a pop-out means `deck_configs` needs a change broadcast.

### What it takes, in order

1. Persist the source-channel ON lamp (prerequisite — without it, two windows fight over the cut).
2. Broadcast `deck_configs` changes so both windows re-read (prerequisite for `+` and the dropdowns).
3. Mount `AudioEngineProvider` in `PopoutRenderer` (shared cause — also fixes defect 1).
4. Extract `App.tsx` ~4481–4695 to `FaderSection.tsx` with the six source-channel callbacks; render it
   from `LivePanel` and from `PopoutRenderer`'s `case "decks"`.
5. Delete `StandaloneDecksPanel.tsx` and its `OnAirDeck`/`MusicDeckPanel` poll. Do not keep two.

Steps 1–2 are the real work. Step 4 is mechanical once they exist.

---

## Not proposing anything yet, per the instruction. Two things worth Jeff's ruling first

- **Scope of step 3.** Mounting the provider in `PopoutRenderer` changes the engine every pop-out
  resolves — not just Carts. That is the correct fix and it is also the widest blast radius in this
  list; it deserves to be its own change, verified on its own, rather than riding along with the
  fader extraction.
- **What actually gets deleted.** Checked, so the "don't keep two" instruction lands on the right
  files:
  - `StandaloneDecksPanel.tsx` — **delete.** Rendered only by the Decks pop-out; this is the old design.
  - `OnAirDeck.tsx` — **keep.** Still rendered by `canvas/widgets/DeckWidget.tsx`. Note that
    `App.tsx:41` imports it and never renders it — a dead import, safe to drop.
  - `StandaloneDeck.tsx` — **orphan.** Header says *"self-contained deck panel for pop-out windows"*;
    **nothing imports it.** A third deck implementation, already unreachable. Worth removing with the
    second, but it is not causing anything.
  - Incidental, not part of this task: `useCanvas` routes the live screen to `WidgetCanvas` instead of
    `LivePanel` (`App.tsx:3112`), which renders decks a fourth way. Flagged, not investigated.
