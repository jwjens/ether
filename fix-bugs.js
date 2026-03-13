const fs = require('fs');

// ── Fix 1: engine.ts ──────────────────────────────────────────
let engine = fs.readFileSync('src/audio/engine.ts', 'utf8');

// Add advancing flag after outroPending
engine = engine.replace(
  'private outroPending = false;',
  'private outroPending = false;\n  private advancing = false;'
);

// Guard handleDeckEnd against double-firing
engine = engine.replace(
  'if (!this.autoAdvance) return;\n    if (this.queue.length === 0 && this.continuous',
  'if (!this.autoAdvance) return;\n    if (this.advancing || this.outroPending) return;\n    if (this.queue.length === 0 && this.continuous'
);

// Add lock around the load+play in handleDeckEnd
engine = engine.replace(
  '    const deck = this.getDeck(deckId);\n    if (deck) {\n      deck.load(next.filePath, next.title, next.artist).then(() => {\n        deck.play();\n        this.listeners.forEach(l => l(deckId, deck.getState()));\n      });\n    }',
  '    const deck = this.getDeck(deckId);\n    if (deck) {\n      this.advancing = true;\n      deck.load(next.filePath, next.title, next.artist).then(() => {\n        deck.play();\n        this.listeners.forEach(l => l(deckId, deck.getState()));\n        this.advancing = false;\n      }).catch(() => { this.advancing = false; });\n    }'
);

// Guard checkOutroCrossfade too
engine = engine.replace(
  'if (!this.outroCrossfade || !this.autoAdvance || this.outroPending) return;',
  'if (!this.outroCrossfade || !this.autoAdvance || this.outroPending || this.advancing) return;'
);

fs.writeFileSync('src/audio/engine.ts', engine, 'utf8');
console.log('FIXED src/audio/engine.ts');

// ── Fix 2: NowPlaying.tsx ─────────────────────────────────────
let np = fs.readFileSync('src/components/NowPlaying.tsx', 'utf8');

// Replace onClick={onExit} on outer div with onMouseDown + stopPropagation
np = np.replace(
  '<div className="fixed inset-0 bg-black flex flex-col z-50 cursor-none select-none" onClick={onExit}>',
  '<div className="fixed inset-0 bg-black flex flex-col select-none" style={{zIndex:9999,cursor:"default"}} onMouseDown={(e)=>{e.stopPropagation();e.preventDefault();onExit();}}>'
);

// Add ESC key handler useEffect after the clock useEffect
np = np.replace(
  '  useEffect(() => {\n    const id = setInterval(() => setTime(new Date()), 1000);\n    return () => clearInterval(id);\n  }, []);',
  '  useEffect(() => {\n    const id = setInterval(() => setTime(new Date()), 1000);\n    return () => clearInterval(id);\n  }, []);\n\n  useEffect(() => {\n    const handler = (e: KeyboardEvent) => {\n      e.stopPropagation();\n      if (e.key === "Escape") onExit();\n    };\n    document.addEventListener("keydown", handler, true);\n    return () => document.removeEventListener("keydown", handler, true);\n  }, [onExit]);'
);

// Update exit hint text
np = np.replace(
  'Click anywhere to exit',
  'Click anywhere or press ESC to exit'
);

fs.writeFileSync('src/components/NowPlaying.tsx', np, 'utf8');
console.log('FIXED src/components/NowPlaying.tsx');

console.log('\nDone. Run: npm run tauri:dev');
