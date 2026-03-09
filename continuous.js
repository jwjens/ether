const fs = require('fs');

console.log('\n  Ether — Continuous Play + Keyboard Shortcuts\n');

// ============================================================
// Update engine: continuous mode refills queue from DB
// ============================================================

let engineCode = fs.readFileSync('src/audio/engine.ts', 'utf8');

// Add continuous mode flag and refill callback
if (!engineCode.includes('continuous')) {
  engineCode = engineCode.replace(
    '  autoAdvance = false;',
    '  autoAdvance = false;\n  continuous = false;\n  private refillCallback: (() => Promise<{ filePath: string; title: string; artist: string }[]>) | null = null;'
  );

  // Add setRefillCallback method
  engineCode = engineCode.replace(
    '  clearQueue() { this.queue = []; }',
    '  clearQueue() { this.queue = []; }\n  setRefillCallback(fn: () => Promise<{ filePath: string; title: string; artist: string }[]>) { this.refillCallback = fn; }'
  );

  // Update handleDeckEnd to refill when queue is empty in continuous mode
  engineCode = engineCode.replace(
    '    if (!this.autoAdvance) return;\n    if (this.queue.length === 0) return;',
    '    if (!this.autoAdvance) return;\n    if (this.queue.length === 0 && this.continuous && this.refillCallback) {\n      this.refillCallback().then(songs => {\n        this.queue.push(...songs);\n        this.handleDeckEnd(deckId);\n      });\n      return;\n    }\n    if (this.queue.length === 0) return;'
  );

  fs.writeFileSync('src/audio/engine.ts', engineCode, 'utf8');
  console.log('  UPDATED src/audio/engine.ts (continuous mode)');
} else {
  console.log('  SKIPPED src/audio/engine.ts (continuous already added)');
}

// ============================================================
// Update App.tsx: add continuous toggle, keyboard shortcuts,
// and refill callback that loads all songs from DB
// ============================================================

let app = fs.readFileSync('src/App.tsx', 'utf8');

// Add continuous state
if (!app.includes('continuous')) {
  app = app.replace(
    'const [shuffle, setShuffle] = useState(false);',
    'const [shuffle, setShuffle] = useState(false);\n  const [continuous, setContinuous] = useState(false);'
  );

  // Add toggle function
  app = app.replace(
    "const toggleShuffle = () => { const n = !shuffle; setShuffle(n); engine.shuffle = n; };",
    "const toggleShuffle = () => { const n = !shuffle; setShuffle(n); engine.shuffle = n; };\n  const toggleContinuous = () => { const n = !continuous; setContinuous(n); engine.continuous = n; };"
  );

  // Set up refill callback and keyboard shortcuts
  app = app.replace(
    '  useEffect(() => {\n    engine.init();\n    return engine.on((id, st) => {',
    '  // Refill callback: loads all songs from DB when queue empties\n  useEffect(() => {\n    engine.setRefillCallback(async () => {\n      const rows = await query<SongRow>("SELECT s.*, a.name as artist_name FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.file_path IS NOT NULL ORDER BY RANDOM() LIMIT 500");\n      return rows.filter(s => s.file_path).map(s => ({ filePath: s.file_path!, title: s.title, artist: s.artist_name || "" }));\n    });\n  }, []);\n\n  // Keyboard shortcuts\n  useEffect(() => {\n    const handleKey = (e: KeyboardEvent) => {\n      if (e.target instanceof HTMLInputElement) return;\n      const dA = engine.getDeck("A");\n      const dB = engine.getDeck("B");\n      switch(e.code) {\n        case "Space": e.preventDefault(); if (dA) { if (dA.getState().status === "playing") dA.pause(); else if (dA.getState().status === "paused") dA.resume(); else dA.play(); } break;\n        case "KeyB": if (dB) { if (dB.getState().status === "playing") dB.pause(); else if (dB.getState().status === "paused") dB.resume(); else dB.play(); } break;\n        case "KeyX": if (deckA?.status === "playing" && deckB?.filePath) engine.crossfade("A", "B", 2000); else if (deckB?.status === "playing" && deckA?.filePath) engine.crossfade("B", "A", 2000); break;\n        case "Escape": dA?.stop(); dB?.stop(); break;\n      }\n    };\n    window.addEventListener("keydown", handleKey);\n    return () => window.removeEventListener("keydown", handleKey);\n  }, [deckA, deckB]);\n\n  useEffect(() => {\n    engine.init();\n    return engine.on((id, st) => {'
  );

  // Pass continuous to LivePanel
  app = app.replace(
    '{panel === "live" && <LivePanel deckA={deckA} deckB={deckB} autoAdv={autoAdv} shuffle={shuffle} toggleAuto={toggleAuto} toggleShuffle={toggleShuffle} queueLen={queueLen} />}',
    '{panel === "live" && <LivePanel deckA={deckA} deckB={deckB} autoAdv={autoAdv} shuffle={shuffle} continuous={continuous} toggleAuto={toggleAuto} toggleShuffle={toggleShuffle} toggleContinuous={toggleContinuous} queueLen={queueLen} />}'
  );

  // Update LivePanel signature and add continuous button
  app = app.replace(
    'function LivePanel({ deckA, deckB, autoAdv, shuffle, toggleAuto, toggleShuffle, queueLen }: { deckA: DeckState | null; deckB: DeckState | null; autoAdv: boolean; shuffle: boolean; toggleAuto: () => void; toggleShuffle: () => void; queueLen: number }) {',
    'function LivePanel({ deckA, deckB, autoAdv, shuffle, continuous, toggleAuto, toggleShuffle, toggleContinuous, queueLen }: { deckA: DeckState | null; deckB: DeckState | null; autoAdv: boolean; shuffle: boolean; continuous: boolean; toggleAuto: () => void; toggleShuffle: () => void; toggleContinuous: () => void; queueLen: number }) {'
  );

  // Add continuous button next to shuffle
  app = app.replace(
    '<button onClick={toggleShuffle} className={shuffle ? "px-2.5 py-1 rounded text-[11px] font-bold bg-amber-600 text-white" : "px-2.5 py-1 rounded text-[11px] font-bold bg-zinc-800 text-zinc-500 hover:bg-zinc-700"}>SHUFFLE</button>',
    '<button onClick={toggleContinuous} className={continuous ? "px-2.5 py-1 rounded text-[11px] font-bold bg-rose-600 text-white" : "px-2.5 py-1 rounded text-[11px] font-bold bg-zinc-800 text-zinc-500 hover:bg-zinc-700"}>24/7</button>\n          <button onClick={toggleShuffle} className={shuffle ? "px-2.5 py-1 rounded text-[11px] font-bold bg-amber-600 text-white" : "px-2.5 py-1 rounded text-[11px] font-bold bg-zinc-800 text-zinc-500 hover:bg-zinc-700"}>SHUFFLE</button>'
  );

  // Update the queue empty message
  app = app.replace(
    '<div className="text-xs text-zinc-600 italic">Empty. Add songs from Library with the Q button.</div>',
    '<div className="text-xs text-zinc-600 italic">{continuous ? "Continuous mode: will auto-refill from library when empty." : "Empty. Add songs from Library with the Q button."}</div>'
  );

  // Update footer to show continuous
  app = app.replace(
    '<span>{autoAdv ? "AUTO" : "MANUAL"}{shuffle ? " | SHUFFLE" : ""} | Queue: {queueLen}</span>',
    '<span>{autoAdv ? "AUTO" : "MANUAL"}{shuffle ? " | SHUFFLE" : ""}{continuous ? " | 24/7" : ""} | Queue: {queueLen} | Space=Play/Pause X=Crossfade</span>'
  );

  fs.writeFileSync('src/App.tsx', app, 'utf8');
  console.log('  UPDATED src/App.tsx (continuous mode + keyboard shortcuts)');
} else {
  console.log('  SKIPPED src/App.tsx (continuous already added)');
}

console.log('\n  Done! Restart: npm run tauri:dev');
console.log('');
console.log('  New features:');
console.log('    24/7 button — when on, queue auto-refills from your entire library');
console.log('                  (shuffled) when it runs out. Never stops playing.');
console.log('');
console.log('    Keyboard shortcuts:');
console.log('      SPACE  = Play/Pause Deck A');
console.log('      B      = Play/Pause Deck B');
console.log('      X      = Crossfade between decks');
console.log('      ESC    = Stop both decks');
console.log('');
console.log('  For OV pilot: turn on AUTO + SHUFFLE + 24/7, hit play, walk away.');
console.log('');
console.log('  Push:');
console.log('    git add -A');
console.log('    git commit -m "v0.3.0 continuous 24/7 mode + keyboard shortcuts"');
console.log('    git push\n');
