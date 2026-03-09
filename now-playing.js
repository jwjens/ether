const fs = require('fs');

console.log('\n  Ether — Now Playing Display\n');

// ============================================================
// Create NowPlaying component
// ============================================================

fs.mkdirSync('src/components', { recursive: true });
fs.writeFileSync('src/components/NowPlaying.tsx', [
'import { useState, useEffect } from "react";',
'import { engine, DeckState } from "../audio/engine";',
'import { query } from "../db/client";',
'',
'interface RecentPlay {',
'  title: string;',
'  artist: string | null;',
'  played_at: number;',
'}',
'',
'function fmtTime(s: number) {',
'  if (!s || s < 0) return "0:00";',
'  return Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");',
'}',
'',
'export default function NowPlaying({ onExit }: { onExit: () => void }) {',
'  const [deckA, setDeckA] = useState<DeckState | null>(null);',
'  const [deckB, setDeckB] = useState<DeckState | null>(null);',
'  const [recent, setRecent] = useState<RecentPlay[]>([]);',
'  const [time, setTime] = useState(new Date());',
'',
'  useEffect(() => {',
'    const unsub = engine.on((id, st) => {',
'      if (id === "A") setDeckA({ ...st });',
'      else setDeckB({ ...st });',
'    });',
'    return unsub;',
'  }, []);',
'',
'  useEffect(() => {',
'    const id = setInterval(() => setTime(new Date()), 1000);',
'    return () => clearInterval(id);',
'  }, []);',
'',
'  useEffect(() => {',
'    const loadRecent = async () => {',
'      try {',
'        const rows = await query<RecentPlay>("SELECT title, artist, played_at FROM play_log ORDER BY played_at DESC LIMIT 5");',
'        setRecent(rows);',
'      } catch {}',
'    };',
'    loadRecent();',
'    const id = setInterval(loadRecent, 5000);',
'    return () => clearInterval(id);',
'  }, []);',
'',
'  // Determine which deck is active',
'  const active = deckA?.status === "playing" ? deckA : deckB?.status === "playing" ? deckB : deckA?.title ? deckA : deckB;',
'  const title = active?.title || "Ether Radio";',
'  const artist = active?.artist || "";',
'  const pos = active?.positionSec || 0;',
'  const dur = active?.durationSec || 0;',
'  const pct = dur > 0 ? (pos / dur) * 100 : 0;',
'  const isPlaying = active?.status === "playing";',
'',
'  const hours = time.getHours();',
'  const mins = time.getMinutes();',
'  const timeStr = time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });',
'  const dateStr = time.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });',
'',
'  return (',
'    <div className="fixed inset-0 bg-black flex flex-col z-50 cursor-none select-none" onClick={onExit}>',
'',
'      {/* Top bar */}',
'      <div className="flex items-center justify-between px-12 pt-8">',
'        <div className="flex items-center gap-4">',
'          <span className="text-4xl font-bold tracking-tight"><span className="text-blue-400">Eth</span><span className="text-white">er</span></span>',
'          {isPlaying && <span className="px-3 py-1 bg-red-600 rounded text-sm font-bold text-white animate-pulse">ON AIR</span>}',
'        </div>',
'        <div className="text-right">',
'          <div className="text-5xl font-mono font-bold text-white">{timeStr}</div>',
'          <div className="text-lg text-zinc-500">{dateStr}</div>',
'        </div>',
'      </div>',
'',
'      {/* Main now playing */}',
'      <div className="flex-1 flex flex-col items-center justify-center px-12">',
'        <div className="text-zinc-500 text-lg uppercase tracking-widest mb-4">{isPlaying ? "Now Playing" : "Up Next"}</div>',
'        <div className="text-6xl font-bold text-white text-center mb-3 leading-tight" style={{ maxWidth: "80%" }}>{title}</div>',
'        {artist && <div className="text-3xl text-zinc-400 text-center mb-8">{artist}</div>}',
'',
'        {/* Progress bar */}',
'        {dur > 0 && (',
'          <div className="w-full max-w-3xl">',
'            <div className="h-2 bg-zinc-800 rounded-full overflow-hidden mb-2">',
'              <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: pct + "%" }}></div>',
'            </div>',
'            <div className="flex justify-between text-lg font-mono text-zinc-500">',
'              <span>{fmtTime(pos)}</span>',
'              <span>-{fmtTime(dur - pos)}</span>',
'            </div>',
'          </div>',
'        )}',
'      </div>',
'',
'      {/* Recently played */}',
'      {recent.length > 0 && (',
'        <div className="px-12 pb-8">',
'          <div className="text-zinc-600 text-xs uppercase tracking-widest mb-3">Recently Played</div>',
'          <div className="flex gap-6">',
'            {recent.slice(0, 5).map((r, i) => (',
'              <div key={i} className="flex-1">',
'                <div className="text-sm text-zinc-400 truncate">{r.title}</div>',
'                <div className="text-xs text-zinc-600 truncate">{r.artist || ""}</div>',
'              </div>',
'            ))}',
'          </div>',
'        </div>',
'      )}',
'',
'      {/* Exit hint */}',
'      <div className="absolute bottom-3 right-6 text-[10px] text-zinc-800">Click anywhere to exit</div>',
'    </div>',
'  );',
'}',
].join('\n'), 'utf8');
console.log('  CREATED src/components/NowPlaying.tsx');

// ============================================================
// Wire into App.tsx
// ============================================================

let app = fs.readFileSync('src/App.tsx', 'utf8');

if (!app.includes('NowPlaying')) {
  // Add import
  app = app.replace(
    'import Logs from "./components/Logs";',
    'import Logs from "./components/Logs";\nimport NowPlaying from "./components/NowPlaying";'
  );

  // Add state
  app = app.replace(
    'const [queueLen, setQueueLen] = useState(0);',
    'const [queueLen, setQueueLen] = useState(0);\n  const [showNowPlaying, setShowNowPlaying] = useState(false);'
  );

  // Add the NowPlaying overlay
  app = app.replace(
    '    <div className="h-screen flex flex-col bg-zinc-950 text-zinc-100">',
    '    <div className="h-screen flex flex-col bg-zinc-950 text-zinc-100">\n      {showNowPlaying && <NowPlaying onExit={() => setShowNowPlaying(false)} />}'
  );

  // Add NOW PLAYING button to header
  app = app.replace(
    '<ClockDisplay />',
    '<button onClick={() => setShowNowPlaying(true)} className="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 rounded text-[10px] font-bold text-zinc-400">NOW PLAYING</button>\n          <ClockDisplay />'
  );

  fs.writeFileSync('src/App.tsx', app, 'utf8');
  console.log('  UPDATED src/App.tsx (Now Playing button + overlay)');
}

console.log('\n  Done! App should hot-reload.');
console.log('');
console.log('  Click "NOW PLAYING" in the top bar to launch the display.');
console.log('  It goes full screen with:');
console.log('    - Giant song title and artist');
console.log('    - Progress bar');
console.log('    - Clock and date');
console.log('    - ON AIR indicator');
console.log('    - Last 5 songs played');
console.log('    - Click anywhere to exit back to the app');
console.log('');
console.log('  For OV: put this on a lobby TV. Play music on one screen,');
console.log('  show Now Playing on the second monitor.');
console.log('');
console.log('  Push:');
console.log('    git add -A');
console.log('    git commit -m "v0.7.1 now playing display for lobby screens"');
console.log('    git push\n');
