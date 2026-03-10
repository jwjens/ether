const fs = require('fs');

console.log('\n  Ether — Collapsible Cart Wall\n');

let app = fs.readFileSync('src/App.tsx', 'utf8');

if (!app.includes('showCarts')) {
  // Add state
  app = app.replace(
    'const [showNowPlaying, setShowNowPlaying] = useState(false);',
    'const [showNowPlaying, setShowNowPlaying] = useState(false);\n  const [showCarts, setShowCarts] = useState(false);'
  );

  // Pass to LivePanel
  app = app.replace(
    'toggleContinuous={toggleContinuous} queueLen={queueLen}',
    'toggleContinuous={toggleContinuous} queueLen={queueLen} showCarts={showCarts} toggleCarts={() => setShowCarts(!showCarts)}'
  );

  // Update LivePanel signature
  app = app.replace(
    'function LivePanel({ deckA, deckB, autoAdv, shuffle, continuous, toggleAuto, toggleShuffle, toggleContinuous, queueLen }:',
    'function LivePanel({ deckA, deckB, autoAdv, shuffle, continuous, toggleAuto, toggleShuffle, toggleContinuous, queueLen, showCarts, toggleCarts }:'
  );

  app = app.replace(
    'toggleContinuous: () => void; queueLen: number })',
    'toggleContinuous: () => void; queueLen: number; showCarts: boolean; toggleCarts: () => void })'
  );

  // Add CARTS toggle button next to other controls
  app = app.replace(
    '<button onClick={handleXfade} className="px-3 py-1 bg-purple-700 hover:bg-purple-600 rounded text-[11px] font-bold text-white">CROSSFADE</button>',
    '<button onClick={toggleCarts} className={showCarts ? "px-2.5 py-1 rounded text-[11px] font-bold bg-orange-600 text-white" : "px-2.5 py-1 rounded text-[11px] font-bold bg-zinc-800 text-zinc-500 hover:bg-zinc-700"}>CARTS</button>\n            <button onClick={handleXfade} className="px-3 py-1 bg-purple-700 hover:bg-purple-600 rounded text-[11px] font-bold text-white">CROSSFADE</button>'
  );

  // Wrap cart wall in conditional
  app = app.replace(
    '          {/* Cart Wall */}\n          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3">\n            <div className="text-[10px] font-bold text-zinc-400 uppercase mb-2">Cart Wall</div>\n            <CartWall />\n          </div>',
    '          {/* Cart Wall - collapsible */}\n          {showCarts && (\n            <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3">\n              <div className="text-[10px] font-bold text-zinc-400 uppercase mb-2">Cart Wall — press CARTS to hide</div>\n              <CartWall />\n            </div>\n          )}'
  );

  fs.writeFileSync('src/App.tsx', app, 'utf8');
  console.log('  UPDATED App.tsx (collapsible cart wall)');
} else {
  console.log('  SKIPPED — already has showCarts');
}

console.log('\n  Done! App should hot-reload.');
console.log('  Orange CARTS button toggles the cart wall open/closed.');
console.log('  Closed by default — clean view for automation.');
console.log('  Open when the jock needs to fire carts.\n');
