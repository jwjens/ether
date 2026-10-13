// electron/self-action-sense.js — DID ANY ETHER WINDOW MOVE, RESIZE, RAISE OR TAKE FOCUS BY ITSELF? (2026-10-12)
//
// docs/perf-pass-round2-2026-10-12.md §5. Jeff's rule: "the Health Monitor never moves, resizes, scrolls, auto-raises or
// takes focus by itself." Round 2: "Confirm the Health Monitor fix holds under a long session." A smoke proves it for a
// minute; this proves it for the whole session on the real machine:
//   · every call Ether's own code makes to focus / show / moveTop / restore / setBounds / setPosition / setSize / center
//     a window is seen (BrowserWindow.prototype is wrapped once, at startup);
//   · one that comes with NO operator input in any Ether window in the 1.5 s before it is recorded as SELF, with the
//     window and the first lines of the caller's stack — so it names the code that did it;
//   · the renderer reports scrolls nobody asked for (src/lib/perfSense.ts) — counted beside these.
// On /health as perf.selfActions. An empty list over a long session is the receipt.
"use strict";

const WINDOW_MS = 30 * 60_000;
const OPERATOR_MS = 1500;
const METHODS = ["focus", "show", "moveTop", "restore", "setBounds", "setPosition", "setSize", "center"];

function createSelfActionSense({ now = () => Date.now() } = {}) {
  const startedAt = now();
  let lastInputAt = 0;
  const self = [];                // { at, window, action, stack }
  let calls = 0;

  function noteInput() { lastInputAt = now(); }

  function install(electron) {
    const { app, BrowserWindow } = electron;
    // Operator input in ANY Ether window counts: a click in the dashboard that opens a pop-out is the operator's act.
    const ACTS = new Set(["mouseDown", "mouseUp", "keyDown", "rawKeyDown", "mouseWheel", "gestureTap", "touchStart"]);
    app.on("web-contents-created", (_e, wc) => {
      wc.on("input-event", (_ev, input) => { if (input && ACTS.has(input.type)) noteInput(); });
    });
    // The tray and a second launch are operator acts outside any page: main.js calls operatorAct() for them.
    for (const m of METHODS) {
      const orig = BrowserWindow.prototype[m];
      if (typeof orig !== "function") continue;
      BrowserWindow.prototype[m] = function (...args) {
        calls++;
        try {
          const t = now();
          if (t - lastInputAt > OPERATOR_MS) {
            let title = ""; try { title = this.getTitle(); } catch {}
            const stack = String(new Error().stack || "").split("\n").slice(2, 6).map(s => s.trim().replace(/^at /, "").replace(/\(?file:\/+[^)]*[\\/](electron[\\/][^)]*)\)?/, "$1")).join(" ← ");
            self.push({ at: t, sinceLaunchSec: Math.round((t - startedAt) / 1000), window: title, action: m, stack });
            if (self.length > 200) self.shift();
          }
        } catch { /* a sense never breaks what it watches */ }
        return orig.apply(this, args);
      };
    }
  }

  /** Called for the tray menu / app menu handlers, which are operator acts the page never sees. */
  function operatorAct() { noteInput(); }

  function snapshot(rendererScrolls) {
    const t = now();
    while (self.length && t - self[0].at > WINDOW_MS) self.shift();
    return { windowMin: WINDOW_MS / 60_000, windowCalls: calls, selfWindowActions: self.slice(-20), selfWindowActionsCount: self.length, unpromptedScrolls: rendererScrolls || [] };
  }

  return { install, operatorAct, snapshot };
}

module.exports = { createSelfActionSense };
