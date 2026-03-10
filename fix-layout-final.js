const fs = require('fs');

console.log('\n  Ether — Fix Live Assist Layout\n');

let app = fs.readFileSync('src/App.tsx', 'utf8');

// Find and replace the entire LivePanel function
const lpStart = app.indexOf('function LivePanel(');
// Find the next top-level function after LivePanel
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
          <button onClick={async () => { const n = await fillQueueFromSchedule(); }} className="px-2.5 py-1 rounded text-[11px] font-bold bg-emerald-700 hover:bg-emerald-600 text-white">GEN LOG</button>
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

        {/* Right - Decks */}
        <div className="flex-1 space-y-3 overflow-y-auto">
          <OnAirDeck deck={deckA} label="Deck A \\u2014 On Air" />
          <div className="flex items-center gap-2">
            <button onClick={() => engine.getDeck("A")?.stop()} className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 rounded text-xs font-bold text-zinc-400">STOP</button>
            <button onClick={() => { const d = engine.getDeck("A"); if (!d) return; const st = deckA?.status; if (st === "playing") d.pause(); else if (st === "paused") d.resume(); else d.play(); }} className="flex-1 py-2 rounded text-xs font-bold text-white" style={{ backgroundColor: deckA?.status === "playing" ? "#ca8a04" : "#2563eb" }}>{deckA?.status === "playing" ? "PAUSE" : deckA?.status === "paused" ? "RESUME" : "PLAY"}</button>
            <div className="flex items-center gap-1 text-[10px] text-zinc-500 w-32"><span>VOL</span><input type="range" min="0" max="100" value={Math.round((deckA?.volume || 1) * 100)} onChange={e => engine.getDeck("A")?.setVolume(parseInt(e.target.value) / 100)} className="flex-1 h-1 accent-blue-500" /><span>{Math.round((deckA?.volume || 1) * 100)}%</span></div>
          </div>
          <OnAirDeck deck={deckB} label="Deck B \\u2014 Standby" />
          <div className="flex items-center gap-2">
            <button onClick={() => engine.getDeck("B")?.stop()} className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 rounded text-xs font-bold text-zinc-400">STOP</button>
            <button onClick={() => { const d = engine.getDeck("B"); if (!d) return; const st = deckB?.status; if (st === "playing") d.pause(); else if (st === "paused") d.resume(); else d.play(); }} className="flex-1 py-2 rounded text-xs font-bold text-white" style={{ backgroundColor: deckB?.status === "playing" ? "#ca8a04" : "#059669" }}>{deckB?.status === "playing" ? "PAUSE" : deckB?.status === "paused" ? "RESUME" : "PLAY"}</button>
            <div className="flex items-center gap-1 text-[10px] text-zinc-500 w-32"><span>VOL</span><input type="range" min="0" max="100" value={Math.round((deckB?.volume || 1) * 100)} onChange={e => engine.getDeck("B")?.setVolume(parseInt(e.target.value) / 100)} className="flex-1 h-1 accent-emerald-500" /><span>{Math.round((deckB?.volume || 1) * 100)}%</span></div>
          </div>
        </div>
      </div>

      {/* Cart Wall - FULL WIDTH below everything */}
      {showCarts && (
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4 mt-3 shrink-0">
          <div className="text-[10px] font-bold text-zinc-400 uppercase mb-3">Cart Wall</div>
          <CartWall />
        </div>
      )}
    </div>
  );
}

`;

  app = before + newLP + after;
  fs.writeFileSync('src/App.tsx', app, 'utf8');
  console.log('  REWROTE LivePanel — cart wall is full width at the bottom');
} else {
  console.log('  ERROR: Could not find LivePanel boundaries');
  console.log('  lpStart:', lpStart, 'lpEnd:', lpEnd);
}

console.log('\n  Done! npm run tauri:dev\n');
