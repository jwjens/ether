// scripts/smoke-window-station.js
//
// THE CONTRACT: a window must never guess which station it commands.
//
// WHY THIS EXISTS. `AudioEngineContext` used to be `createContext<number>(1)`. A default of `1` is
// indistinguishable from a real station 1, so any component rendered outside `<AudioEngineProvider>`
// silently addressed station 1 — no throw, no warning, no visual difference. Every pop-out window
// mounts its own React root (src/main.tsx) and NONE of them mounted the provider, so eight
// components that call useAudioEngine() — BoutiqueCartWall, PhoneDesk, VoiceTracker, MasterOutput,
// ConsoleStrip, UpNext, Spots, HealthMonitor — were commanding the wrong station in every window.
//
// The visible symptom was one line of Jeff's: "The Carts pop-out shows the correct 10 carts but
// pressing one plays no audio." The wall read the live station for its carts AND for its fire
// channel, then sent the load to station 1.
//
// The three things that made it possible are the three things checked here. Static on purpose: it
// runs in CI on a tree with no Electron, no engine and no audio.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

// STRIP COMMENTS BEFORE GRADING. The first run of this test failed on its own explanatory prose —
// the comment "This was createContext<number>(1)" matched the check for the defect it describes.
// A guard that reads commentary is a guard that punishes documenting the bug it guards against.
// Line numbers are preserved: a block comment is blanked, not deleted, so a reported hit still
// points at the right line of the real file.
// NORMALISE CRLF FIRST. `.` does not match `\r` in JavaScript, so on a CRLF file `//.*$` never
// reaches the end of the line and the line comment survives the strip — silently, and only for
// files the working tree happens to have checked out with CRLF. App.tsx is one of them: section 8
// first found its <AudioEngineProvider> inside the comment at App.tsx:592 that merely describes it.
// Line numbers are unaffected — only the carriage returns go.
const code = (p) => read(p)
  .replace(/\r/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
  .split("\n")
  .map((l) => l.replace(/(^|\s)\/\/.*$/, ""))
  .join("\n");

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures++; console.log(`  FAIL  ${m}`); };

console.log("\n== 1. the context carries NO station default ==");
{
  const src = code("src/audio/AudioEngineContext.tsx");

  if (/createContext<number>\s*\(\s*\d+\s*\)/.test(src)) {
    fail("AudioEngineContext has a numeric default — a component with no provider will silently command it");
  } else if (/createContext<number\s*\|\s*null>\s*\(\s*null\s*\)/.test(src)) {
    pass("createContext<number | null>(null) — the absence of a provider is not a station");
  } else {
    fail("could not find the createContext call in AudioEngineContext.tsx — has it moved?");
  }

  // The throw is the half that makes the null useful. Without it, `getEngine(null)` would just
  // construct an engine for a bogus key and we would be back to failing silently.
  if (/resolved\s*==\s*null/.test(src) && /throw new Error\(/.test(src)) {
    pass("useAudioEngine() throws by name when no station can be resolved");
  } else {
    fail("useAudioEngine() does not throw on an unresolved station — it must say so, not guess");
  }
}

console.log("\n== 2. every window root mounts the provider ==");
{
  const src = code("src/main.tsx");

  // Each of these is a separate BrowserWindow with its own React root. <App /> mounts the provider
  // inside its own JSX and is deliberately NOT gated (see AudioEngineContext) — the other four must
  // be wrapped here or they mount nothing at all.
  const ROOTS = ["NowPlaying", "ProducerDeskWindow", "CueEditorWindow", "PopoutRenderer"];

  const wrapped = /<AudioEngineProvider[^>]*>\s*\{?\s*secondary/.test(src)
    || /<AudioEngineProvider[^>]*>\s*\{[\s\S]{0,400}?PopoutRenderer/.test(src);
  if (wrapped) pass("the secondary-window root is wrapped in <AudioEngineProvider>");
  else fail("no <AudioEngineProvider> wraps the secondary window roots in src/main.tsx");

  if (/<AudioEngineProvider\s+gate/.test(src)) {
    pass("secondary windows are gated — they wait for the station instead of acting on the id=1 fallback");
  } else {
    fail("secondary windows are not gated: they can act during the window where useActiveStation() still reports 1");
  }

  for (const r of ROOTS) {
    if (!src.includes(r)) { fail(`window root ${r} is no longer referenced in main.tsx — this test is stale`); continue; }
    // The root must appear in the branch that feeds the wrapped element, not as a bare sibling of
    // <App />. Anything assigned straight into `mainContent` alongside App bypasses the wrapper.
    const bare = new RegExp(`mainContent\\s*=\\s*[\\s\\S]{0,200}?<${r}\\s*/>`);
    if (bare.test(src)) fail(`${r} is assigned directly to mainContent — it bypasses the provider`);
    else pass(`${r} routes through the wrapped branch`);
  }
}

console.log("\n== 3. no call site re-introduces a station guess ==");
{
  // `?? 1` next to a station is the shape the fix removed from PopoutRenderer. It is a guess wearing
  // a fallback's clothes: it cannot be distinguished from a real station 1 at runtime.
  const files = ["src/components/PopoutRenderer.tsx"];
  for (const f of files) {
    const src = code(f);
    const hits = src.split("\n")
      .map((l, i) => ({ n: i + 1, l }))
      .filter(({ l }) => /getEngine\([^)]*\?\?\s*1\s*\)/.test(l) || /stationId\s*\?\?\s*1/.test(l));
    if (hits.length) {
      for (const h of hits) fail(`${f}:${h.n} guesses station 1 — ${h.l.trim()}`);
    } else {
      pass(`${f} contains no \`?? 1\` station guess`);
    }
  }
}

console.log("\n== 4. the operator console can leave the window it was logged in ==");
{
  // The second half of the same defect: consoleLog() was a window-scoped DOM event, so the cart
  // wall's own "fired on F" / "nothing is dialled" reporting was unreachable from a pop-out. The
  // receipt was a 1.6 GB ether-startup.log with zero [CART] lines in it.
  const master  = code("src/components/MasterOutput.tsx");
  const preload = code("electron/preload.js");
  const main    = code("electron/main.js");

  if (/ether\?\.console\?\.emit/.test(master)) pass("consoleLog() relays each line to the main process");
  else fail("consoleLog() does not relay — a pop-out's diagnostics stay in the pop-out");

  if (/console\.onEntry/.test(master)) pass("each window subscribes to relayed console lines");
  else fail("nothing subscribes to console:entry — relayed lines arrive nowhere");

  if (/console:\s*\{[\s\S]{0,400}?emit:[\s\S]{0,400}?onEntry:/.test(preload)) pass("preload exposes console.emit + console.onEntry");
  else fail("preload does not expose the console channel");

  if (/ipcMain\.on\("console:emit"/.test(main) && /webContents\.send\("console:entry"/.test(main)) {
    pass("main fans console lines out to every window");
  } else {
    fail("main does not fan console lines out — the relay dead-ends in the main process");
  }
}

console.log("\n== 5. the daemon's load line names the station it reached ==");
{
  const d = code("audiod/ether-audiod.js");
  if (/load:\s*\(m\)\s*=>\s*\{[^\n]*log\(`\[engine s\$\{m\.stationId\}\] load /.test(d)) {
    pass("audiod logs stationId on every load");
  } else {
    fail("audiod's load handler writes no line naming the station — a load to the wrong station is unreadable");
  }
}

console.log("\n== 6. the ON lamp has a STORE, so two windows cannot fight over the channel cut ==");
{
  // The second half of the contract. srcChannelOn was useState({}) in App while an effect asserted
  // it DOWNWARD into the engine (setMuted) on every change — which makes the board a WRITER of the
  // channel cut, not a display of it. Render that section in two windows and each carries its own
  // {}, each asserts its own `?? true`, and they overwrite each other with no arbiter. There is no
  // read-back either: DeckState carries `volume`, never `muted`. The row is the only place the
  // truth can live. Jeff: "I'm not shipping two writers fighting over a channel cut."
  // The board lives in FaderSection.tsx now (extracted from LivePanel so the dashboard and the Decks
  // window render ONE implementation). Both files are checked: the state must be derived where it
  // lives, and must not reappear as useState in either.
  const app     = code("src/App.tsx");
  const fader   = code("src/components/FaderSection.tsx");
  const cfg     = code("src/components/DeckConfigurator.tsx");
  const handler = code("electron/sync/handlers/deck_configs.js");

  if (/const\s*\[\s*srcChannelOn\s*,/.test(fader) || /const\s*\[\s*srcChannelOn\s*,/.test(app)) {
    fail("srcChannelOn is renderer useState again — unstored state asserted downward is two writers waiting to happen");
  } else if (/const\s+srcChannelOn\s*=\s*useMemo/.test(fader)) {
    pass("srcChannelOn is derived from the config rows, not held as window-local state");
  } else {
    fail("could not find the derived srcChannelOn in FaderSection.tsx — has it moved?");
  }

  // The assert-downward effect WRITES (setMuted on every change). Two copies of it in one app is the
  // collision this arc removes, so App must not carry one beside FaderSection's.
  if (/srcChannelOn\[c\.slot\]/.test(app)) {
    fail("App.tsx still runs its own channel-cut assert — that is a second writer alongside FaderSection's");
  } else {
    pass("App.tsx carries no second channel-cut assert");
  }

  if (/channelOn/.test(cfg) && /COALESCE\(channel_on,\s*1\)/.test(cfg)) {
    pass("useDeckConfig reads channel_on, defaulting an unwritten row to OPEN");
  } else {
    fail("useDeckConfig does not read channel_on — the lamp has no store to read");
  }

  // Without this the handler's guard rejects the write outright and the toggle silently does not
  // persist: "cannot patch immutable field(s): channel_on".
  if (/PATCHABLE[^\n]*"channel_on"/.test(handler)) pass("channel_on is patchable in the deck_configs handler");
  else fail("channel_on is missing from PATCHABLE — every write of the lamp will be refused");
}

console.log("\n== 7. a board change reaches every window ==");
{
  const handler = code("electron/sync/handlers/deck_configs.js");
  const preload = code("electron/preload-handlers.js");
  const cfg     = code("src/components/DeckConfigurator.tsx");

  // EVERY mutating handler, not only the one the UI happens to call: a change announcement that
  // depends on which caller made the change is the partial truth that lets two windows drift.
  for (const h of ["create", "update", "delete", "update-by-slot"]) {
    const re = new RegExp("deck_configs:" + h + "'[\\s\\S]{0,400}?announce\\(");
    if (re.test(handler)) pass(`deck_configs:${h} announces the change`);
    else fail(`deck_configs:${h} does not announce — a write through it is invisible to other windows`);
  }

  if (/webContents\.send\('deck_configs:changed'/.test(handler)) pass("the announcement reaches every window");
  else fail("nothing sends deck_configs:changed to the windows");

  if (/onChanged:/.test(preload) && /offChanged:/.test(preload)) pass("preload exposes deckConfigs.onChanged/offChanged");
  else fail("preload does not expose the board-changed subscription");

  if (/deckConfigs\.onChanged/.test(cfg)) pass("useDeckConfig re-reads when the board changes elsewhere");
  else fail("useDeckConfig never re-reads — a second window stays stale until it re-mounts");
}

console.log("\n== 8. App()'s gate screens render ABOVE the provider — none may call useAudioEngine() ==");
{
  // WHY THIS EXISTS. Section 2 covers the pop-out half of the class: the secondary roots in
  // main.tsx. It missed the other half. App() reaches its <AudioEngineProvider> only after five
  // gate early-returns — splash, first-run, account sign-in, user PIN, on-shift — and every one of
  // them renders wrapped in <EtherErrorBoundary> alone, ABOVE the provider, where the context is
  // null. OnShiftScreen called useAudioEngine() there and 4.6.22 could not launch past it.
  //
  // The runtime throw alone is not enough cover. It fires only on the path that renders, and four
  // of the five gates render on paths a dev machine almost never takes (!splashDone,
  // !firstRunChecked, !accountSignedIn, !currentUser). A useAudioEngine() added to OnboardingFlow
  // would throw for a fresh install and pass every machine that already has one — so it would
  // ship. This check fails in CI instead.
  //
  // Above the provider the rule is getEngine(stationId) at its point of use, once the station has
  // actually resolved — App.tsx:604 and OnShiftScreen.tsx do it that way.
  const src = code("src/App.tsx");
  const lines = src.split("\n");

  const providerLine = lines.findIndex((l) => /<AudioEngineProvider[\s>]/.test(l));
  if (providerLine < 0) {
    fail("no <AudioEngineProvider> found in App.tsx — this test is stale");
  } else {
    // name -> module path, for local imports only (a bare-module tag is not ours to grade).
    const imports = new Map();
    for (const m of src.matchAll(/import\s+(\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s+"(\.[^"]+)"/g)) {
      imports.set(m[1], m[2]);
    }
    for (const m of src.matchAll(/import\s+(?:\w+\s*,\s*)?\{([^}]*)\}\s*from\s+"(\.[^"]+)"/g)) {
      for (const raw of m[1].split(",")) {
        const name = raw.split(/\s+as\s+/).pop().trim();
        if (name) imports.set(name, m[2]);
      }
    }

    // A named import shares its file with every other export in it — EtherErrorBoundary lives in
    // HealthMonitor.tsx, and HealthMonitor() two hundred lines below it DOES call useAudioEngine()
    // and is right to. Grading the file would fail the boundary for its neighbour's correct code,
    // so read only from the export's own declaration to the next top-level one.
    const exportRegion = (fileSrc, name) => {
      const re = new RegExp(`export\\s+(?:default\\s+)?(?:async\\s+)?(?:function|class|const)\\s+${name}\\b`);
      const m = re.exec(fileSrc);
      if (!m) return null;
      const rest = fileSrc.slice(m.index + m[0].length);
      const next = rest.search(/\nexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const)\s+\w+/);
      return next < 0 ? rest : rest.slice(0, next);
    };

    // Each gate is one `return <…>;` statement above the provider. Collect the statement, not a
    // fixed window, so a neighbouring return cannot contribute tags to it.
    const gates = new Map();   // tag -> first App.tsx line it is returned on
    for (let i = 0; i < providerLine; i++) {
      if (!/\breturn\s*\(?\s*</.test(lines[i])) continue;
      const stmt = [];
      for (let j = i; j < Math.min(i + 12, providerLine); j++) {
        stmt.push(lines[j]);
        if (lines[j].includes(";")) break;
      }
      for (const t of stmt.join("\n").matchAll(/<([A-Z]\w*)/g)) {
        if (!gates.has(t[1])) gates.set(t[1], i + 1);
      }
    }

    if (gates.size === 0) {
      fail("found no gate early-returns above the provider in App.tsx — this test is stale");
    } else {
      for (const [tag, line] of gates) {
        const mod = imports.get(tag);
        if (!mod) {
          fail(`App.tsx:${line} returns <${tag}> above the provider and this test cannot resolve it — stale`);
          continue;
        }
        const candidates = [`src/${mod.replace(/^\.\//, "")}.tsx`, `src/${mod.replace(/^\.\//, "")}.ts`];
        const file = candidates.find((p) => fs.existsSync(path.join(ROOT, p)));
        if (!file) {
          fail(`App.tsx:${line} returns <${tag}> from "${mod}", which resolves to no file — stale`);
          continue;
        }
        const region = exportRegion(code(file), tag);
        if (region == null) {
          fail(`${file} has no exported ${tag} — this test is stale`);
        } else if (/useAudioEngine\s*\(/.test(region)) {
          fail(`${tag} calls useAudioEngine() but is returned at App.tsx:${line}, above the provider — ` +
               `it must resolve getEngine(stationId) at its point of use, once the station is ready`);
        } else {
          pass(`<${tag}> (App.tsx:${line}) resolves no engine through the context`);
        }
      }
    }
  }
}

console.log(failures === 0
  ? "\nVERDICT: PASS — a window cannot silently command the wrong station, and two windows cannot disagree about the board.\n"
  : `\nVERDICT: FAIL — ${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
