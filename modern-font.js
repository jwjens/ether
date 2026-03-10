const fs = require('fs');

console.log('\n  Ether — Modern Timer Font\n');

// Add font import to index.css
let css = fs.readFileSync('src/index.css', 'utf8');
if (!css.includes('Inter')) {
  css = `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');\n@import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&display=swap');\n\n` + css;

  // Update body font
  css = css.replace(
    "font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', system-ui, sans-serif;",
    "font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', system-ui, sans-serif;"
  );

  fs.writeFileSync('src/index.css', css, 'utf8');
  console.log('  UPDATED index.css (Inter + DM Mono fonts)');
}

// Update OnAirDeck timer to use DM Mono
let deck = fs.readFileSync('src/components/OnAirDeck.tsx', 'utf8');

// Big countdown timer
deck = deck.replace(
  "fontSize: 36, fontWeight: 800, fontFamily: \"monospace\"",
  "fontSize: 40, fontWeight: 500, fontFamily: \"'DM Mono', monospace\", fontVariantNumeric: \"tabular-nums\""
);

// Elapsed timer
deck = deck.replace(
  "fontSize: 18, fontFamily: \"monospace\", color: \"var(--text-secondary)\"",
  "fontSize: 18, fontWeight: 400, fontFamily: \"'DM Mono', monospace\", fontVariantNumeric: \"tabular-nums\", color: \"var(--text-secondary)\""
);

fs.writeFileSync('src/components/OnAirDeck.tsx', deck, 'utf8');
console.log('  UPDATED OnAirDeck.tsx (DM Mono timers)');

// Update clock in JockStrip
if (fs.existsSync('src/components/JockStrip.tsx')) {
  let jock = fs.readFileSync('src/components/JockStrip.tsx', 'utf8');
  jock = jock.replace(
    "fontSize: 18, fontFamily: \"monospace\", fontWeight: 700",
    "fontSize: 20, fontFamily: \"'DM Mono', monospace\", fontWeight: 500, fontVariantNumeric: \"tabular-nums\""
  );
  fs.writeFileSync('src/components/JockStrip.tsx', jock, 'utf8');
  console.log('  UPDATED JockStrip.tsx (DM Mono clock)');
}

console.log('\n  Done! App should hot-reload.');
console.log('');
console.log('  Inter — clean modern sans-serif for all UI text');
console.log('  DM Mono — elegant monospace for timers and clocks');
console.log('  Tabular nums — digits dont jump around as they count');
console.log('');
console.log('  Push:');
console.log('    git add -A');
console.log('    git commit -m "v1.5.3 modern typography"');
console.log('    git push\n');
