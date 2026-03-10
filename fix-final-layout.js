const fs = require('fs');

console.log('\n  Ether — Fix Layout: Search under decks, carts toggle\n');

// ============================================================
// 1. Fix CartWall - remove scroll, tighten grid
// ============================================================

let cart = fs.readFileSync('src/components/CartWall.tsx', 'utf8');
cart = cart.replace(
  'overflow-y-auto" style={{ maxHeight: "220px" }}',
  '"'
);
// Reduce to 16 slots (2 rows of 8) instead of 32
cart = cart.replace('const TOTAL = 32;', 'const TOTAL = 16;');
fs.writeFileSync('src/components/CartWall.tsx', cart, 'utf8');
console.log('  FIXED CartWall (16 slots, no scroll)');

// ============================================================
// 2. Rewrite LivePanel - search under decks, carts replace it
// ============================================================

let app = fs.readFileSync('src/App.tsx', 'utf8');

const lpStart = app.indexOf('function LivePanel(');
let lpEnd = -1;
const candidates = ['\nfunction DeckCard(', '\nfunction OnAirDeck(', '\nfunction LibraryPanel(', '\nfunction PH('];
for (const c of candidates) {
  const idx = app.indexOf(c, lpStart + 1);
  if (idx > lpStart && (lpEnd === -1 || idx < lpEnd)) lpEnd = idx;
}

if (lpStart >= 0 && lpEnd >= 0) {
  const before = app.substring(0, lpStart);
  const after = app.substring(lpEnd);

  const newLP = `function LivePanel({ deckA, deckB, autoAdv, shuffle, continuous, toggleAuto, toggleShuffle, toggleContinuous, queueLen, showCarts, toggleCarts }: { deckA: DeckState | null; deckB: DeckState | null; autoAdv: boolean; shuffle: boolean; continuous: boolean; toggleAuto: () => void; toggleShuffle: () => void; toggleContinuous: () => void; queueLen: number; showCarts: boolean; toggleCarts: () => void }) {
  const handleXfade = () => {
    if (deckA?.status === "playing" && deckB?.filePath) engine.crossfade("A", "B", 2000);
    else if (deckB?.status === "playing" && deckA?.filePath) engine.crossfade("B", "A", 2000);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Control buttons */}
      <div className="flex items-center justify-between mb-3 shrink-0">
        <h1 className="text-lg font-bold">Live Assist</h1>
        <div className="flex items-center gap-1.5">
          <button onClick={async () => { await fillQueueFromSchedule(); }} className="px-2.5 py-1 rounded text-[11px] font-bold bg-emerald-700 hover:bg-emerald-600 text-white">GEN LOG</button>
          <button onClick={toggleContinuous} className={continuous ? "px-2.5 py-1 rounded text-[11px] font-bold bg-rose-600 text-white" : "px-2.5 py-1 rounded text-[11px] font-bold bg-zinc-800 text-zinc-500 hover:bg-zinc-700"}>24/7</button>
          <button onClick={toggleShuffle} className={shuffle ? "px-2.5 py-1 rounded text-[11px] font-bold bg-amber-600 text-white" : "px-2.5 py-1 rounded text-[11px] font-bold bg-zinc-800 text-zinc-500 hover:bg-zinc-700"}>SHUFFLE</button>
          <button onClick={toggleAuto} className={autoAdv ? "px-2.5 py-1 rounded text-[11px] font-bold bg-blue-600 text-white" : "px-2.5 py-1 rounded text-[11px] font-bold bg-zinc-800 text-zinc-500 hover:bg-zinc-700"}>AUTO</button>
          <button onClick={toggleCarts} className={showCarts ? "px-2.5 py-1 rounded text-[11px] font-bold bg-orange-600 text-white" : "px-2.5 py-1 rounded text-[11px] font-bold bg-zinc-800 text-zinc-500 hover:bg-zinc-700"}>CARTS</button>
          <button onClick={handleXfade} className="px-3 py-1 bg-purple-700 hover:bg-purple-600 rounded text-[11px] font-bold text-white">CROSSFADE</button>
        </div>
      </div>

      {/* Main area: queue left + decks right */}
      <div className="flex gap-3 flex-1 min-h-0">
        {/* Left - Up Next */}
        <div className="w-64 shrink-0">
          <UpNext queueLen={queueLen} onQueueChange={() => {}} />
        </div>

        {/* Right - Decks + search/carts below */}
        <div className="flex-1 flex flex-col min-h-0">
          {/* Deck A */}
          <OnAirDeck deck={deckA} label="Deck A \\u2014 On Air" />
          <div className="flex items-center gap-2 mt-1 mb-2">
            <button onClick={() => engine.getDeck("A")?.stop()} className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-xs font-bold text-zinc-400">STOP</button>
            <button onClick={() => { const d = engine.getDeck("A"); if (!d) return; const st = deckA?.status; if (st === "playing") d.pause(); else if (st === "paused") d.resume(); else d.play(); }} className="flex-1 py-1.5 rounded text-xs font-bold text-white" style={{ backgroundColor: deckA?.status === "playing" ? "#ca8a04" : "#2563eb" }}>{deckA?.status === "playing" ? "PAUSE" : deckA?.status === "paused" ? "RESUME" : "PLAY"}</button>
            <div className="flex items-center gap-1 text-[10px] text-zinc-500 w-28"><span>VOL</span><input type="range" min="0" max="100" value={Math.round((deckA?.volume || 1) * 100)} onChange={e => engine.getDeck("A")?.setVolume(parseInt(e.target.value) / 100)} className="flex-1 h-1 accent-blue-500" /><span>{Math.round((deckA?.volume || 1) * 100)}%</span></div>
          </div>

          {/* Deck B */}
          <OnAirDeck deck={deckB} label="Deck B \\u2014 Standby" />
          <div className="flex items-center gap-2 mt-1 mb-2">
            <button onClick={() => engine.getDeck("B")?.stop()} className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-xs font-bold text-zinc-400">STOP</button>
            <button onClick={() => { const d = engine.getDeck("B"); if (!d) return; const st = deckB?.status; if (st === "playing") d.pause(); else if (st === "paused") d.resume(); else d.play(); }} className="flex-1 py-1.5 rounded text-xs font-bold text-white" style={{ backgroundColor: deckB?.status === "playing" ? "#ca8a04" : "#059669" }}>{deckB?.status === "playing" ? "PAUSE" : deckB?.status === "paused" ? "RESUME" : "PLAY"}</button>
            <div className="flex items-center gap-1 text-[10px] text-zinc-500 w-28"><span>VOL</span><input type="range" min="0" max="100" value={Math.round((deckB?.volume || 1) * 100)} onChange={e => engine.getDeck("B")?.setVolume(parseInt(e.target.value) / 100)} className="flex-1 h-1 accent-emerald-500" /><span>{Math.round((deckB?.volume || 1) * 100)}%</span></div>
          </div>

          {/* Below decks: search OR carts */}
          {showCarts ? (
            <div className="flex-1 min-h-0 overflow-hidden">
              <CartWall />
            </div>
          ) : (
            <JockStrip deckA={deckA} deckB={deckB} />
          )}
        </div>
      </div>
    </div>
  );
}

`;

  app = before + newLP + after;

  // Remove any orphaned JockStrip or CartWall outside LivePanel
  app = app.replace('      {/* Jock Strip - search + history + teleprompter */}\n      <JockStrip deckA={deckA} deckB={deckB} />\n\n', '');
  app = app.replace(/\s*\{\/\* Cart Wall - FULL WIDTH below everything \*\/\}[\s\S]*?<\/div>\s*\)\}/m, '');

  fs.writeFileSync('src/App.tsx', app, 'utf8');
  console.log('  REWROTE LivePanel');
} else {
  console.log('  ERROR: Could not find LivePanel');
}

console.log('\n  Done! npm run tauri:dev');
console.log('  Search/history/clock shows under Deck B by default.');
console.log('  Click CARTS — search hides, cart wall appears.');
console.log('  Click CARTS again — carts hide, search comes back.\n');
