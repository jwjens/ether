// The Master Out console, mounted the way MasterOutput mounts it: at the bottom of a scrolling column whose top holds
// the faders. Built by scripts/smoke-feed-no-jump.js (once with the working tree, once with the pre-fix commit).
import React from "react";
import ReactDOM from "react-dom/client";
import { LiveConsole, consoleLog } from "__MASTER_OUTPUT__";

function Board() {
  return (
    <div id="column" style={{ height: 600, minHeight: 0, overflowY: "auto", overflowX: "hidden", display: "flex", flexDirection: "column" }}>
      <div id="faders" style={{ height: 640, flexShrink: 0, background: "#222", color: "#fff" }}>MASTER / MONITOR faders — Master Out is taller than the screen, so its column scrolls</div>
      <div style={{ flexShrink: 0, height: 60 }}>Health Monitor (mini)</div>
      <LiveConsole masterLevel={0.5} />
    </div>
  );
}
// The window's own sense, as every Ether window runs it (src/lib/perfSense.ts) — its reports are kept for the long run.
import { startPerfSense } from "../../src/lib/perfSense";
(window as any).__reports = [];
(window as any).ether = { invoke: (ch: string, p: any) => { if (ch === "perf:report") (window as any).__reports.push(p); return Promise.resolve(true); } };
startPerfSense("feed-smoke");
(window as any).__log = (n: number, msg = "deck") => { for (let i = 0; i < n; i++) consoleLog("audio", `[DECK A] ${msg} ${i}`); };
ReactDOM.createRoot(document.getElementById("root")!).render(<Board />);
