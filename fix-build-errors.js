const fs = require('fs');

console.log('\n  Fixing 3 build errors...\n');

// 1. Fix engine.ts - outroStartSec not on Deck class
let eng = fs.readFileSync('src/audio/engine.ts', 'utf8');
if (!eng.match(/outroStartSec\s*=\s*0/) || eng.indexOf('outroStartSec = 0') === eng.lastIndexOf('outroStartSec = 0')) {
  // Make sure the property exists on the Deck class
  if (!eng.includes('outroStartSec = 0')) {
    eng = eng.replace(
      '  peaks: number[] = [];',
      '  peaks: number[] = [];\n  outroStartSec = 0;'
    );
  }
}
// If outroStartSec is in DeckState interface but not in class, remove from state
if (eng.includes('outroStartSec: this.outroStartSec') && !eng.match(/class Deck[\s\S]*?outroStartSec\s*=\s*0/)) {
  eng = eng.replace(', outroStartSec: this.outroStartSec', '');
  eng = eng.replace('  outroStartSec: number;\n', '');
}
fs.writeFileSync('src/audio/engine.ts', eng, 'utf8');
console.log('  FIXED engine.ts');

// 2. Fix CartWall.tsx - duplicate style attribute
let cart = fs.readFileSync('src/components/CartWall.tsx', 'utf8');
cart = cart.replace(
  'style={{ background: "var(--bg-tertiary)", border: "2px dashed var(--border-secondary)", cursor: "pointer" }} style={{ aspectRatio: "1", minHeight: "0" }}',
  'style={{ background: "var(--bg-tertiary)", border: "2px dashed var(--border-secondary)", cursor: "pointer", aspectRatio: "1", minHeight: "0" }}'
);
fs.writeFileSync('src/components/CartWall.tsx', cart, 'utf8');
console.log('  FIXED CartWall.tsx');

// 3. Fix UpNext.tsx - duplicate style attribute on context menu
let upnext = fs.readFileSync('src/components/UpNext.tsx', 'utf8');
// Find the context menu div that has both className and style for position
upnext = upnext.replace(
  /style=\{\{ position: "fixed" as any, zIndex: 50, background: "var\(--bg-elevated\)", border: "1px solid var\(--border-secondary\)", borderRadius: "var\(--radius-sm\)", boxShadow: "var\(--shadow-lg\)", padding: "4px 0", minWidth: 180 \}\}\s*style=\{\{ left: contextMenu\.x, top: contextMenu\.y \}\}/,
  'style={{ position: "fixed" as any, zIndex: 50, background: "var(--bg-elevated)", border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-sm)", boxShadow: "var(--shadow-lg)", padding: "4px 0", minWidth: 180, left: contextMenu.x, top: contextMenu.y }}'
);
// Also try the other way around
upnext = upnext.replace(
  /className="fixed z-50[^"]*"\s*style=\{\{ left: contextMenu\.x, top: contextMenu\.y \}\}/,
  'style={{ position: "fixed" as any, zIndex: 50, background: "var(--bg-elevated)", border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-sm)", boxShadow: "var(--shadow-lg)", padding: "4px 0", minWidth: 180, left: contextMenu.x, top: contextMenu.y }}'
);
fs.writeFileSync('src/components/UpNext.tsx', upnext, 'utf8');
console.log('  FIXED UpNext.tsx');

console.log('\n  Now run: npm run tauri:build\n');
