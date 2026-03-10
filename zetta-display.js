const fs = require('fs');

console.log('\n  Ether — Zetta-Style On-Air Display\n');

// ============================================================
// Create OnAirDeck component - the big countdown display
// ============================================================

fs.mkdirSync('src/components', { recursive: true });
fs.writeFileSync('src/components/OnAirDeck.tsx', [
'import { useState, useEffect } from "react";',
'import { DeckState } from "../audio/engine";',
'',
'interface Props {',
'  deck: DeckState | null;',
'  label: string;',
'}',
'',
'function fmtCountdown(sec: number): string {',
'  if (sec <= 0) return "00:00";',
'  const m = Math.floor(sec / 60);',
'  const s = Math.floor(sec % 60);',
'  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");',
'}',
'',
'function fmtElapsed(sec: number): string {',
'  const m = Math.floor(sec / 60);',
'  const s = Math.floor(sec % 60);',
'  const ms = Math.floor((sec % 1) * 10);',
'  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0") + "." + ms;',
'}',
'',
'export default function OnAirDeck({ deck, label }: Props) {',
'  const [blink, setBlink] = useState(false);',
'',
'  const status = deck?.status || "idle";',
'  const title = deck?.title || "";',
'  const artist = deck?.artist || "";',
'  const pos = deck?.positionSec || 0;',
'  const dur = deck?.durationSec || 0;',
'  const remaining = dur - pos;',
'  const pct = dur > 0 ? (pos / dur) * 100 : 0;',
'',
'  // Cue point zones (approximated - would use real cue points if saved)',
'  const introEnd = dur * 0.08; // first 8% is intro',
'  const outroStart = dur * 0.92; // last 8% is outro',
'  const isInIntro = pos < introEnd && status === "playing";',
'  const isInOutro = pos > outroStart && status === "playing";',
'  const isEnding = remaining < 15 && remaining > 0 && status === "playing";',
'  const isCritical = remaining < 5 && remaining > 0 && status === "playing";',
'',
'  // Blink effect when ending',
'  useEffect(() => {',
'    if (isCritical) {',
'      const id = setInterval(() => setBlink(b => !b), 300);',
'      return () => clearInterval(id);',
'    }',
'    setBlink(false);',
'  }, [isCritical]);',
'',
'  // Background color logic',
'  let bgColor = "#18181b"; // idle - dark',
'  let textColor = "#71717a"; // idle - gray',
'  let timerColor = "#71717a";',
'  let barColor = "#3f3f46";',
'',
'  if (status === "playing") {',
'    if (isInIntro) {',
'      // INTRO - bright blue (talk time!)',
'      bgColor = "#1e3a5f";',
'      textColor = "#60a5fa";',
'      timerColor = "#93c5fd";',
'      barColor = "#3b82f6";',
'    } else if (isCritical) {',
'      // CRITICAL - flashing red',
'      bgColor = blink ? "#7f1d1d" : "#450a0a";',
'      textColor = "#fca5a5";',
'      timerColor = blink ? "#ffffff" : "#fca5a5";',
'      barColor = "#ef4444";',
'    } else if (isEnding) {',
'      // ENDING - solid red',
'      bgColor = "#450a0a";',
'      textColor = "#fca5a5";',
'      timerColor = "#f87171";',
'      barColor = "#ef4444";',
'    } else if (isInOutro) {',
'      // OUTRO - amber/yellow',
'      bgColor = "#451a03";',
'      textColor = "#fcd34d";',
'      timerColor = "#fbbf24";',
'      barColor = "#f59e0b";',
'    } else {',
'      // PLAYING - green',
'      bgColor = "#052e16";',
'      textColor = "#86efac";',
'      timerColor = "#4ade80";',
'      barColor = "#22c55e";',
'    }',
'  } else if (status === "paused") {',
'    bgColor = "#1c1917";',
'    textColor = "#fbbf24";',
'    timerColor = "#fbbf24";',
'  }',
'',
'  return (',
'    <div className="rounded-lg overflow-hidden transition-colors duration-300" style={{ backgroundColor: bgColor }}>',
'      {/* Header bar */}',
'      <div className="flex items-center justify-between px-3 py-1.5" style={{ backgroundColor: "rgba(0,0,0,0.3)" }}>',
'        <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: textColor }}>{label}</span>',
'        <span className="text-[10px] uppercase font-bold" style={{ color: textColor }}>',
'          {status === "playing" ? (isInIntro ? "INTRO - TALK!" : isInOutro ? "OUTRO" : isEnding ? "ENDING" : "PLAYING") : status === "paused" ? "PAUSED" : status === "loading" ? "LOADING" : "IDLE"}',
'        </span>',
'      </div>',
'',
'      {/* Main content */}',
'      <div className="px-3 py-2">',
'        {/* Title + Artist */}',
'        <div className="text-base font-bold truncate" style={{ color: status === "playing" ? "#ffffff" : "#a1a1aa" }}>{title || "No track loaded"}</div>',
'        {artist && <div className="text-xs truncate mb-2" style={{ color: textColor }}>{artist}</div>}',
'',
'        {/* Big countdown timer */}',
'        {dur > 0 && (',
'          <div className="flex items-end justify-between mb-2">',
'            <div>',
'              <div className="text-[10px] uppercase" style={{ color: textColor }}>{isInIntro ? "Intro Left" : "Remaining"}</div>',
'              <div className="text-3xl font-mono font-black leading-none" style={{ color: timerColor }}>',
'                {isInIntro ? fmtCountdown(introEnd - pos) : fmtCountdown(remaining)}',
'              </div>',
'            </div>',
'            <div className="text-right">',
'              <div className="text-[10px] uppercase" style={{ color: textColor }}>Elapsed</div>',
'              <div className="text-lg font-mono" style={{ color: textColor }}>{fmtElapsed(pos)}</div>',
'            </div>',
'          </div>',
'        )}',
'',
'        {/* Progress bar with zones */}',
'        {dur > 0 && (',
'          <div className="relative h-3 rounded-full overflow-hidden mb-1" style={{ backgroundColor: "rgba(0,0,0,0.3)" }}>',
'            {/* Intro zone marker */}',
'            <div className="absolute top-0 h-full opacity-30" style={{ left: 0, width: (introEnd / dur * 100) + "%", backgroundColor: "#3b82f6" }}></div>',
'            {/* Outro zone marker */}',
'            <div className="absolute top-0 h-full opacity-30" style={{ left: (outroStart / dur * 100) + "%", width: ((dur - outroStart) / dur * 100) + "%", backgroundColor: "#f59e0b" }}></div>',
'            {/* Playhead */}',
'            <div className="absolute top-0 h-full rounded-full transition-all" style={{ width: pct + "%", backgroundColor: barColor }}></div>',
'          </div>',
'        )}',
'',
'        {/* Time markers */}',
'        {dur > 0 && (',
'          <div className="flex justify-between text-[9px] font-mono" style={{ color: textColor }}>',
'            <span>{fmtCountdown(0)}</span>',
'            <span>Intro {fmtCountdown(introEnd)}</span>',
'            <span>Outro {fmtCountdown(dur - outroStart)}</span>',
'            <span>{fmtCountdown(dur)}</span>',
'          </div>',
'        )}',
'      </div>',
'    </div>',
'  );',
'}',
].join('\n'), 'utf8');
console.log('  CREATED src/components/OnAirDeck.tsx');

// ============================================================
// Create UpNext component - scrolling song list
// ============================================================

fs.writeFileSync('src/components/UpNext.tsx', [
'import { engine } from "../audio/engine";',
'',
'interface Props {',
'  queueLen: number;',
'}',
'',
'export default function UpNext({ queueLen }: Props) {',
'  const queue = engine.getQueue();',
'',
'  return (',
'    <div className="bg-zinc-900 rounded-lg border border-zinc-800 flex flex-col h-full overflow-hidden">',
'      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 shrink-0">',
'        <span className="text-[10px] font-bold text-zinc-400 uppercase">Up Next ({queueLen})</span>',
'        {queue.length > 0 && <button onClick={() => engine.clearQueue()} className="text-[10px] text-zinc-600 hover:text-zinc-400">Clear</button>}',
'      </div>',
'      <div className="flex-1 overflow-y-auto">',
'        {queue.length === 0 ? (',
'          <div className="px-3 py-4 text-[11px] text-zinc-600 italic text-center">Queue empty</div>',
'        ) : queue.slice(0, 30).map((item, i) => (',
'          <div key={i} className={"flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800 " + (i === 0 ? "bg-zinc-800" : "hover:bg-zinc-800")}>',
'            <span className="text-[10px] text-zinc-600 w-5 shrink-0 text-right">{i + 1}</span>',
'            <div className="flex-1 min-w-0">',
'              <div className="text-xs text-zinc-200 truncate">{item.title}</div>',
'              <div className="text-[10px] text-zinc-500 truncate">{item.artist}</div>',
'            </div>',
'          </div>',
'        ))}',
'        {queue.length > 30 && <div className="px-3 py-2 text-[10px] text-zinc-600 text-center">+ {queue.length - 30} more</div>}',
'      </div>',
'    </div>',
'  );',
'}',
].join('\n'), 'utf8');
console.log('  CREATED src/components/UpNext.tsx');

// ============================================================
// Update the LivePanel in App.tsx
// ============================================================

let app = fs.readFileSync('src/App.tsx', 'utf8');

if (!app.includes('OnAirDeck')) {
  // Add imports
  app = app.replace(
    'import Waveform from "./components/Waveform";',
    'import Waveform from "./components/Waveform";\nimport OnAirDeck from "./components/OnAirDeck";\nimport UpNext from "./components/UpNext";'
  );

  // Replace the entire LivePanel function
  const oldLiveStart = 'function LivePanel({';
  const oldLiveEnd = "        </div>\n      )}'\n    </div>\n  );\n}\n\nfunction DeckCard";

  // Find and replace LivePanel
  const lpStart = app.indexOf('function LivePanel(');
  const dcStart = app.indexOf('\nfunction DeckCard(');
  
  if (lpStart >= 0 && dcStart >= 0) {
    const before = app.substring(0, lpStart);
    const after = app.substring(dcStart);
    
    const newLivePanel = [
      'function LivePanel({ deckA, deckB, autoAdv, shuffle, continuous, toggleAuto, toggleShuffle, toggleContinuous, queueLen }: { deckA: DeckState | null; deckB: DeckState | null; autoAdv: boolean; shuffle: boolean; continuous: boolean; toggleAuto: () => void; toggleShuffle: () => void; toggleContinuous: () => void; queueLen: number }) {',
      '  const handleXfade = () => {',
      '    if (deckA?.status === "playing" && deckB?.filePath) engine.crossfade("A", "B", 2000);',
      '    else if (deckB?.status === "playing" && deckA?.filePath) engine.crossfade("B", "A", 2000);',
      '  };',
      '',
      '  return (',
      '    <div className="flex gap-3 h-full">',
      '      {/* Left column - Up Next */}',
      '      <div className="w-64 shrink-0">',
      '        <UpNext queueLen={queueLen} />',
      '      </div>',
      '',
      '      {/* Right column - Decks + Controls */}',
      '      <div className="flex-1 space-y-3">',
      '        {/* Control buttons */}',
      '        <div className="flex items-center justify-between">',
      '          <h1 className="text-lg font-bold">Live Assist</h1>',
      '          <div className="flex items-center gap-1.5">',
      '            <button onClick={async () => { const n = await fillQueueFromSchedule(); }} className="px-2.5 py-1 rounded text-[11px] font-bold bg-emerald-700 hover:bg-emerald-600 text-white">GEN LOG</button>',
      '            <button onClick={toggleContinuous} className={continuous ? "px-2.5 py-1 rounded text-[11px] font-bold bg-rose-600 text-white" : "px-2.5 py-1 rounded text-[11px] font-bold bg-zinc-800 text-zinc-500 hover:bg-zinc-700"}>24/7</button>',
      '            <button onClick={toggleShuffle} className={shuffle ? "px-2.5 py-1 rounded text-[11px] font-bold bg-amber-600 text-white" : "px-2.5 py-1 rounded text-[11px] font-bold bg-zinc-800 text-zinc-500 hover:bg-zinc-700"}>SHUFFLE</button>',
      '            <button onClick={toggleAuto} className={autoAdv ? "px-2.5 py-1 rounded text-[11px] font-bold bg-blue-600 text-white" : "px-2.5 py-1 rounded text-[11px] font-bold bg-zinc-800 text-zinc-500 hover:bg-zinc-700"}>AUTO</button>',
      '            <button onClick={handleXfade} className="px-3 py-1 bg-purple-700 hover:bg-purple-600 rounded text-[11px] font-bold text-white">CROSSFADE</button>',
      '          </div>',
      '        </div>',
      '',
      '        {/* Deck A - On Air style */}',
      '        <OnAirDeck deck={deckA} label="Deck A — On Air" />',
      '',
      '        {/* Deck A Controls */}',
      '        <div className="flex items-center gap-2">',
      '          <button onClick={() => engine.getDeck("A")?.stop()} className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 rounded text-xs font-bold text-zinc-400">STOP</button>',
      '          <button onClick={() => { const d = engine.getDeck("A"); if (!d) return; const st = deckA?.status; if (st === "playing") d.pause(); else if (st === "paused") d.resume(); else d.play(); }} className="flex-1 py-2 rounded text-xs font-bold text-white" style={{ backgroundColor: deckA?.status === "playing" ? "#ca8a04" : "#2563eb" }}>{deckA?.status === "playing" ? "PAUSE" : deckA?.status === "paused" ? "RESUME" : "PLAY"}</button>',
      '          <div className="flex items-center gap-1 text-[10px] text-zinc-500 w-32">',
      '            <span>VOL</span>',
      '            <input type="range" min="0" max="100" value={Math.round((deckA?.volume || 1) * 100)} onChange={e => engine.getDeck("A")?.setVolume(parseInt(e.target.value) / 100)} className="flex-1 h-1 accent-blue-500" />',
      '            <span>{Math.round((deckA?.volume || 1) * 100)}%</span>',
      '          </div>',
      '        </div>',
      '',
      '        {/* Deck B - On Air style */}',
      '        <OnAirDeck deck={deckB} label="Deck B — Standby" />',
      '',
      '        {/* Deck B Controls */}',
      '        <div className="flex items-center gap-2">',
      '          <button onClick={() => engine.getDeck("B")?.stop()} className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 rounded text-xs font-bold text-zinc-400">STOP</button>',
      '          <button onClick={() => { const d = engine.getDeck("B"); if (!d) return; const st = deckB?.status; if (st === "playing") d.pause(); else if (st === "paused") d.resume(); else d.play(); }} className="flex-1 py-2 rounded text-xs font-bold text-white" style={{ backgroundColor: deckB?.status === "playing" ? "#ca8a04" : "#059669" }}>{deckB?.status === "playing" ? "PAUSE" : deckB?.status === "paused" ? "RESUME" : "PLAY"}</button>',
      '          <div className="flex items-center gap-1 text-[10px] text-zinc-500 w-32">',
      '            <span>VOL</span>',
      '            <input type="range" min="0" max="100" value={Math.round((deckB?.volume || 1) * 100)} onChange={e => engine.getDeck("B")?.setVolume(parseInt(e.target.value) / 100)} className="flex-1 h-1 accent-emerald-500" />',
      '            <span>{Math.round((deckB?.volume || 1) * 100)}%</span>',
      '          </div>',
      '        </div>',
      '      </div>',
      '    </div>',
      '  );',
      '}',
      '',
    ].join('\n');

    app = before + newLivePanel + after;
    fs.writeFileSync('src/App.tsx', app, 'utf8');
    console.log('  UPDATED src/App.tsx (Zetta-style Live Assist layout)');
  } else {
    console.log('  WARNING: Could not find LivePanel boundaries to replace');
  }
}

console.log('\n  Done! App should hot-reload or restart: npm run tauri:dev');
console.log('');
console.log('  Zetta-style Live Assist:');
console.log('');
console.log('  LEFT COLUMN:');
console.log('    Scrolling Up Next list — shows all queued songs');
console.log('    Song title + artist for each upcoming track');
console.log('');
console.log('  RIGHT COLUMN — each deck shows:');
console.log('    BIG countdown timer');
console.log('    Color-coded phases:');
console.log('      BLUE    = Intro (TALK! — countdown shows intro time left)');
console.log('      GREEN   = Playing (main body of song)');
console.log('      AMBER   = Outro (getting close to end)');
console.log('      RED     = Ending (under 15 sec left)');
console.log('      FLASH   = Critical (under 5 sec — blinking red)');
console.log('');
console.log('    Progress bar with intro/outro zone markers');
console.log('    Elapsed time on the right');
console.log('');
console.log('  The jock sees at a glance:');
console.log('    Blue = talk over the intro');
console.log('    Green = music is playing, relax');
console.log('    Amber = get ready, outro coming');
console.log('    Red blink = hit the next song NOW');
console.log('');
console.log('  Push:');
console.log('    git add -A');
console.log('    git commit -m "v1.0.0 Zetta-style on-air display"');
console.log('    git push\n');
