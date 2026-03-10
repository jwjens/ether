const fs = require('fs');

console.log('\n  Fixing deck overlap...\n');

let eng = fs.readFileSync('src/audio/engine.ts', 'utf8');

// Disable the auto-crossfade check in the event loop
// It's conflicting with auto-advance and causing both decks to play
eng = eng.replace(
  'private onEvt: Listener = (id, st) => { this.listeners.forEach(l => l(id, st)); this.checkOutroCrossfade(); };',
  'private onEvt: Listener = (id, st) => { this.listeners.forEach(l => l(id, st)); };'
);

// Also set outroCrossfade to false by default
eng = eng.replace(
  'outroCrossfade = true;',
  'outroCrossfade = false;'
);

fs.writeFileSync('src/audio/engine.ts', eng, 'utf8');
console.log('  FIXED — disabled auto-crossfade check (was causing overlap)');
console.log('  Auto-advance still works — songs play one after another on same deck.');
console.log('  Manual CROSSFADE button still works.');
console.log('  App should hot-reload.\n');
