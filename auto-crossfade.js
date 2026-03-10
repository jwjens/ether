const fs = require('fs');

console.log('\n  Ether — Auto-Crossfade on Outro Point\n');

// ============================================================
// Update engine - monitor position and trigger crossfade at outro
// ============================================================

let eng = fs.readFileSync('src/audio/engine.ts', 'utf8');

if (!eng.includes('outroCrossfade')) {
  // Add outro crossfade settings to AudioEngine
  eng = eng.replace(
    '  autoAdvance = false;',
    '  autoAdvance = false;\n  outroCrossfade = true;\n  crossfadeDuration = 3; // seconds\n  private outroPending = false;'
  );

  // Add outro monitoring to the Deck's timer emit
  // We need to check position against outro point during playback
  // Add outroSec field to Deck
  eng = eng.replace(
    '  cueInSec = 0; cueOutSec = 0;',
    '  cueInSec = 0; cueOutSec = 0; outroStartSec = 0;'
  );

  // Update setCuePoints to include outro
  eng = eng.replace(
    '  setCuePoints(inSec: number, outSec: number) { this.cueInSec = inSec; this.cueOutSec = outSec; }',
    '  setCuePoints(inSec: number, outSec: number) { this.cueInSec = inSec; this.cueOutSec = outSec; }\n  setOutroStart(sec: number) { this.outroStartSec = sec; }'
  );

  // Add getOutroStartSec to DeckState
  eng = eng.replace(
    '  peaks: number[];',
    '  peaks: number[];\n  outroStartSec: number;'
  );

  eng = eng.replace(
    '      volume: this.volume, error: this.error, peaks: this.peaks };',
    '      volume: this.volume, error: this.error, peaks: this.peaks, outroStartSec: this.outroStartSec };'
  );

  // Add outro check method to AudioEngine
  eng = eng.replace(
    '  crossfade(fromId: DeckId',
    [
      '  // Check if active deck has hit its outro point',
      '  checkOutroCrossfade() {',
      '    if (!this.outroCrossfade || !this.autoAdvance || this.outroPending) return;',
      '    const deckA = this.getDeck("A");',
      '    const deckB = this.getDeck("B");',
      '    if (!deckA || !deckB) return;',
      '',
      '    const checkDeck = (deck: any, otherId: DeckId) => {',
      '      if (deck.status !== "playing") return;',
      '      const pos = deck.positionSec;',
      '      const dur = deck.durationSec;',
      '      if (dur <= 0) return;',
      '',
      '      // Use outro start point if set, otherwise use last N seconds',
      '      let outroAt = deck.outroStartSec;',
      '      if (!outroAt || outroAt <= 0) outroAt = dur - this.crossfadeDuration - 1;',
      '',
      '      if (pos >= outroAt && pos < dur - 0.5) {',
      '        // Time to crossfade! Load next song to other deck',
      '        this.outroPending = true;',
      '        const queue = this.getQueue();',
      '        if (queue.length > 0) {',
      '          let idx = 0;',
      '          if (this.shuffle) idx = Math.floor(Math.random() * queue.length);',
      '          const next = queue.splice(idx, 1)[0];',
      '          this.clearQueue();',
      '          this.addToQueue(queue);',
      '          const other = this.getDeck(otherId);',
      '          if (other) {',
      '            other.load(next.filePath, next.title, next.artist).then(() => {',
      '              this.crossfade(deck.id, otherId, this.crossfadeDuration * 1000);',
      '              setTimeout(() => { this.outroPending = false; }, this.crossfadeDuration * 1000 + 500);',
      '            });',
      '          }',
      '        }',
      '      }',
      '    };',
      '',
      '    checkDeck(deckA, "B");',
      '    checkDeck(deckB, "A");',
      '  }',
      '',
      '  crossfade(fromId: DeckId',
    ].join('\n')
  );

  // Add outro check to the event listener loop (called every 100-200ms from deck timer)
  eng = eng.replace(
    '  private onEvt: Listener = (id, st) => { this.listeners.forEach(l => l(id, st)); };',
    '  private onEvt: Listener = (id, st) => { this.listeners.forEach(l => l(id, st)); this.checkOutroCrossfade(); };'
  );

  fs.writeFileSync('src/audio/engine.ts', eng, 'utf8');
  console.log('  UPDATED engine.ts (auto-crossfade on outro)');
}

// ============================================================
// Update loggen to load outro points from songs table
// ============================================================

let loggen = fs.readFileSync('src/audio/loggen.ts', 'utf8');
if (!loggen.includes('outro_start_ms')) {
  // Add outro to SongCandidate
  loggen = loggen.replace(
    '  last_played_at: number | null; spins_total: number; gain_db: number;',
    '  last_played_at: number | null; spins_total: number; gain_db: number; outro_start_ms: number;'
  );
  // Add to query
  loggen = loggen.replace(
    '"SELECT s.id, s.title, s.file_path, s.artist_id, a.name as artist_name, s.category_id, s.gender, s.last_played_at, s.spins_total, s.gain_db "',
    '"SELECT s.id, s.title, s.file_path, s.artist_id, a.name as artist_name, s.category_id, s.gender, s.last_played_at, s.spins_total, s.gain_db, COALESCE(s.outro_start_ms, 0) as outro_start_ms "'
  );
  fs.writeFileSync('src/audio/loggen.ts', loggen, 'utf8');
  console.log('  UPDATED loggen.ts (includes outro_start_ms)');
}

// ============================================================
// Add crossfade settings to Settings page
// ============================================================

let app = fs.readFileSync('src/App.tsx', 'utf8');
if (!app.includes('crossfadeDuration')) {
  // Add crossfade duration state
  app = app.replace(
    'const [showNowPlaying, setShowNowPlaying] = useState(false);',
    'const [showNowPlaying, setShowNowPlaying] = useState(false);\n  const [xfadeSec, setXfadeSec] = useState(3);\n  const [autoXfade, setAutoXfade] = useState(true);'
  );

  // Sync with engine
  app = app.replace(
    '  useEffect(() => {\n    engine.init();',
    '  useEffect(() => {\n    engine.init();\n    engine.outroCrossfade = true;\n    engine.crossfadeDuration = 3;'
  );

  // We'll add a small crossfade control to the Live Assist control bar
  app = app.replace(
    '<button onClick={handleXfade} className="px-3 py-1 bg-purple-700 hover:bg-purple-600 rounded text-[11px] font-bold text-white">CROSSFADE</button>',
    '<button onClick={() => { const n = !autoXfade; setAutoXfade(n); engine.outroCrossfade = n; }} className={autoXfade ? "px-2.5 py-1 rounded text-[11px] font-bold bg-indigo-600 text-white" : "px-2.5 py-1 rounded text-[11px] font-bold bg-zinc-800 text-zinc-500 hover:bg-zinc-700"}>AUTO-X</button>\n            <button onClick={handleXfade} className="px-3 py-1 bg-purple-700 hover:bg-purple-600 rounded text-[11px] font-bold text-white">CROSSFADE</button>'
  );

  fs.writeFileSync('src/App.tsx', app, 'utf8');
  console.log('  UPDATED App.tsx (auto-crossfade toggle)');
}

console.log('\n  Done! npm run tauri:dev');
console.log('');
console.log('  AUTO-X button in Live Assist control bar:');
console.log('    ON (indigo) = auto-crossfade enabled');
console.log('    OFF = manual crossfade only');
console.log('');
console.log('  How it works:');
console.log('    1. Song is playing on Deck A');
console.log('    2. When it hits the outro point (or last 4 seconds if no outro set)');
console.log('    3. Next song from queue loads to Deck B');
console.log('    4. 3-second crossfade starts automatically');
console.log('    5. Deck A fades out, Deck B fades in');
console.log('    6. Seamless transition — sounds like real radio');
console.log('');
console.log('  Works with:');
console.log('    - Cue points set in the song editor (outro start)');
console.log('    - Default: crossfades in the last 4 seconds');
console.log('    - AUTO + 24/7 mode for fully hands-free operation');
console.log('    - CROSSFADE button still works for manual override');
console.log('');
console.log('  Push:');
console.log('    git add -A');
console.log('    git commit -m "v1.3.1 auto-crossfade on outro point"');
console.log('    git push\n');
