const fs = require('fs');

console.log('\n  Fixing autoXfade...\n');

let app = fs.readFileSync('src/App.tsx', 'utf8');

// Move autoXfade state into LivePanel instead of App
// Remove from App level
app = app.replace(
  "\n  const [xfadeSec, setXfadeSec] = useState(3);\n  const [autoXfade, setAutoXfade] = useState(true);",
  ""
);

// Add to LivePanel
app = app.replace(
  'function LivePanel({ deckA, deckB, autoAdv, shuffle, continuous, toggleAuto, toggleShuffle, toggleContinuous, queueLen, showCarts, toggleCarts }',
  'function LivePanel({ deckA, deckB, autoAdv, shuffle, continuous, toggleAuto, toggleShuffle, toggleContinuous, queueLen, showCarts, toggleCarts }'
);

// Add state inside LivePanel function body
app = app.replace(
  '  const handleXfade = () => {',
  '  const [autoXfade, setAutoXfade] = useState(true);\n\n  const handleXfade = () => {'
);

fs.writeFileSync('src/App.tsx', app, 'utf8');
console.log('  FIXED — autoXfade state moved into LivePanel');
console.log('  App should hot-reload.\n');
