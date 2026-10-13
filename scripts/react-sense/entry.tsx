// The renderer sense on a known tree (scripts/smoke-react-sense.js): a click re-renders App, a cheap row and SlowList
// (which burns 60 ms in render); Static is memoised and must not appear. Uses the REAL src/lib/perfSense.ts.
import React, { Profiler, memo, useState } from "react";
import ReactDOM from "react-dom/client";
import { reactCommit, startPerfSense } from "../../src/lib/perfSense";

function spin(ms: number) { const end = performance.now() + ms; while (performance.now() < end) { /* render cost */ } }
function SlowList({ n }: { n: number }) { spin(60); return <ul>{Array.from({ length: 20 }, (_, i) => <li key={i}>{n}·{i}</li>)}</ul>; }
function FastRow({ n }: { n: number }) { return <div>row {n}</div>; }
const Static = memo(function Static() { spin(30); return <div>static</div>; });
function App() {
  const [n, setN] = useState(0);
  return (<div><button id="go" style={{ width: 200, height: 60 }} onClick={() => setN(n + 1)}>go</button><FastRow n={n} /><SlowList n={n} /><Static /></div>);
}
(window as any).__reports = [];
(window as any).ether = { invoke: (ch: string, p: any) => { if (ch === "perf:report") (window as any).__reports.push(p); return Promise.resolve(true); } };
startPerfSense("smoke");
ReactDOM.createRoot(document.getElementById("root")!).render(<Profiler id="root" onRender={reactCommit}><App /></Profiler>);
