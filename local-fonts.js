const fs = require('fs');

console.log('\n  Ether — Fix Fonts (local, no Google)\n');

// Remove Google Fonts imports since Tauri cant fetch them
let css = fs.readFileSync('src/index.css', 'utf8');
css = css.replace(/@import url\('https:\/\/fonts\.googleapis\.com[^']*'\);\n?/g, '');
fs.writeFileSync('src/index.css', css, 'utf8');
console.log('  Removed Google Fonts imports');

// Update OnAirDeck to use system UI font with tabular nums
let deck = fs.readFileSync('src/components/OnAirDeck.tsx', 'utf8');

// Big countdown - use system font, thin weight, large size
deck = deck.replace(
  /fontSize: 40, fontWeight: 500, fontFamily: "'DM Mono', monospace", fontVariantNumeric: "tabular-nums"/,
  'fontSize: 48, fontWeight: 300, fontFamily: "-apple-system, BlinkMacSystemFont, \'Segoe UI\', system-ui, sans-serif", fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em"'
);

// Also catch the original monospace version
deck = deck.replace(
  /fontSize: 36, fontWeight: 800, fontFamily: "monospace", lineHeight: 1, color: accentColor, letterSpacing: "-0.02em"/,
  'fontSize: 48, fontWeight: 300, fontFamily: "-apple-system, BlinkMacSystemFont, \'Segoe UI\', system-ui, sans-serif", lineHeight: 1, color: accentColor, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums"'
);

// Elapsed - lighter weight
deck = deck.replace(
  /fontSize: 18, fontWeight: 400, fontFamily: "'DM Mono', monospace", fontVariantNumeric: "tabular-nums", color: "var\(--text-secondary\)"/,
  'fontSize: 18, fontWeight: 300, fontFamily: "-apple-system, BlinkMacSystemFont, \'Segoe UI\', system-ui, sans-serif", fontVariantNumeric: "tabular-nums", color: "var(--text-secondary)", letterSpacing: "0.02em"'
);

// Also catch original
deck = deck.replace(
  /fontSize: 18, fontFamily: "monospace", color: "var\(--text-secondary\)"/,
  'fontSize: 18, fontWeight: 300, fontFamily: "-apple-system, BlinkMacSystemFont, \'Segoe UI\', system-ui, sans-serif", fontVariantNumeric: "tabular-nums", color: "var(--text-secondary)", letterSpacing: "0.02em"'
);

fs.writeFileSync('src/components/OnAirDeck.tsx', deck, 'utf8');
console.log('  UPDATED OnAirDeck.tsx (system font, thin weight, 48px)');

// Fix JockStrip clock too
if (fs.existsSync('src/components/JockStrip.tsx')) {
  let jock = fs.readFileSync('src/components/JockStrip.tsx', 'utf8');
  jock = jock.replace(
    /fontSize: 20, fontFamily: "'DM Mono', monospace", fontWeight: 500, fontVariantNumeric: "tabular-nums"/,
    'fontSize: 20, fontWeight: 300, fontFamily: "-apple-system, BlinkMacSystemFont, \'Segoe UI\', system-ui, sans-serif", fontVariantNumeric: "tabular-nums", letterSpacing: "0.01em"'
  );
  jock = jock.replace(
    /fontSize: 18, fontFamily: "monospace", fontWeight: 700, color: "var\(--text-primary\)", lineHeight: 1/,
    'fontSize: 20, fontWeight: 300, fontFamily: "-apple-system, BlinkMacSystemFont, \'Segoe UI\', system-ui, sans-serif", fontVariantNumeric: "tabular-nums", color: "var(--text-primary)", lineHeight: 1'
  );
  fs.writeFileSync('src/components/JockStrip.tsx', jock, 'utf8');
  console.log('  UPDATED JockStrip.tsx');
}

console.log('\n  Done! App should hot-reload.');
console.log('');
console.log('  Timer is now:');
console.log('    48px (bigger)');
console.log('    Weight 300 (thin and elegant like Apple Watch)');
console.log('    System sans-serif (Segoe UI on Windows, SF Pro on Mac)');
console.log('    Tabular nums (digits dont jump)');
console.log('');
console.log('  Think Apple Clock app — big, thin, clean numbers.\n');
