const fs = require('fs');

console.log('\n  Ether — Global Font Refresh\n');

// Update CSS to set global font properly
let css = fs.readFileSync('src/index.css', 'utf8');

css = css.replace(
  /font-family:.*?;/,
  "font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Segoe UI', system-ui, sans-serif;\n  font-weight: 400;\n  letter-spacing: -0.01em;"
);

fs.writeFileSync('src/index.css', css, 'utf8');
console.log('  UPDATED index.css (global font)');

// Update App.tsx - header wordmark
let app = fs.readFileSync('src/App.tsx', 'utf8');

// Make "Ether" wordmark thinner and more refined
app = app.replace(
  /fontSize: 20, fontWeight: 700, letterSpacing: "-0.03em"/,
  'fontSize: 22, fontWeight: 300, letterSpacing: "-0.04em"'
);

// "Live Assist" heading
app = app.replace(
  'className="text-lg font-bold">Live Assist',
  'style={{ fontSize: 22, fontWeight: 300, letterSpacing: "-0.03em", color: "var(--text-primary)" }}>Live Assist'
);

// Version badge
app = app.replace(
  /fontSize: 10, color: "var\(--text-tertiary\)", fontWeight: 500/,
  'fontSize: 10, color: "var(--text-tertiary)", fontWeight: 300, letterSpacing: "0.02em"'
);

// Control buttons - lighter weight
app = app.replace(
  /fontSize: 11, fontWeight: 700, background: "var\(--accent-green\)"/g,
  'fontSize: 11, fontWeight: 500, background: "var(--accent-green)", letterSpacing: "0.04em"'
);
app = app.replace(
  /fontSize: 11, fontWeight: 700, background: continuous/g,
  'fontSize: 11, fontWeight: 500, letterSpacing: "0.04em", background: continuous'
);
app = app.replace(
  /fontSize: 11, fontWeight: 700, background: shuffle/g,
  'fontSize: 11, fontWeight: 500, letterSpacing: "0.04em", background: shuffle'
);
app = app.replace(
  /fontSize: 11, fontWeight: 700, background: autoAdv/g,
  'fontSize: 11, fontWeight: 500, letterSpacing: "0.04em", background: autoAdv'
);
app = app.replace(
  /fontSize: 11, fontWeight: 700, background: showCarts/g,
  'fontSize: 11, fontWeight: 500, letterSpacing: "0.04em", background: showCarts'
);
app = app.replace(
  /fontSize: 11, fontWeight: 700, background: autoXfade/g,
  'fontSize: 11, fontWeight: 500, letterSpacing: "0.04em", background: autoXfade'
);
app = app.replace(
  /fontSize: 11, fontWeight: 700, background: "var\(--accent-purple\)", color: "#fff"/g,
  'fontSize: 11, fontWeight: 500, letterSpacing: "0.04em", background: "var(--accent-purple)", color: "#fff"'
);

// Sidebar nav items
app = app.replace(
  /fontSize: 14, fontWeight: active === i\.id \? 600 : 400/,
  'fontSize: 14, fontWeight: active === i.id ? 500 : 300'
);

// Footer
app = app.replace(
  /marginTop: "auto", padding: "12px 20px", fontSize: 10, color: "var\(--text-tertiary\)"/,
  'marginTop: "auto", padding: "12px 20px", fontSize: 10, fontWeight: 300, color: "var(--text-tertiary)"'
);

fs.writeFileSync('src/App.tsx', app, 'utf8');
console.log('  UPDATED App.tsx (all text lighter weight)');

// Update OnAirDeck text
let deck = fs.readFileSync('src/components/OnAirDeck.tsx', 'utf8');

// Deck label
deck = deck.replace(
  /fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0\.06em", color: accentColor/,
  'fontSize: 11, fontWeight: 500, textTransform: "uppercase" as const, letterSpacing: "0.08em", color: accentColor'
);

// Status label
deck = deck.replace(
  /fontSize: 10, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0\.04em", color: statusColor/,
  'fontSize: 10, fontWeight: 500, textTransform: "uppercase" as const, letterSpacing: "0.06em", color: statusColor'
);

// Song title
deck = deck.replace(
  /fontSize: 16, fontWeight: 700, color: "var\(--text-primary\)"/,
  'fontSize: 17, fontWeight: 500, color: "var(--text-primary)"'
);

// Labels like "REMAINING", "ELAPSED"
deck = deck.replace(
  /fontSize: 9, textTransform: "uppercase" as const, letterSpacing: "0\.06em", color: "var\(--text-tertiary\)", marginBottom: 2/g,
  'fontSize: 9, fontWeight: 400, textTransform: "uppercase" as const, letterSpacing: "0.1em", color: "var(--text-tertiary)", marginBottom: 2'
);

fs.writeFileSync('src/components/OnAirDeck.tsx', deck, 'utf8');
console.log('  UPDATED OnAirDeck.tsx (refined text weights)');

// Update UpNext
let upnext = fs.readFileSync('src/components/UpNext.tsx', 'utf8');

upnext = upnext.replace(
  /fontSize: 11, fontWeight: 700, color: "var\(--text-secondary\)", textTransform: "uppercase"/,
  'fontSize: 11, fontWeight: 500, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.06em"'
);

fs.writeFileSync('src/components/UpNext.tsx', upnext, 'utf8');
console.log('  UPDATED UpNext.tsx');

// Update CartWall
let cart = fs.readFileSync('src/components/CartWall.tsx', 'utf8');

cart = cart.replace(
  /className="text-sm font-bold text-white/g,
  'className="text-sm font-medium text-white'
);

fs.writeFileSync('src/components/CartWall.tsx', cart, 'utf8');
console.log('  UPDATED CartWall.tsx');

console.log('\n  Done! App should hot-reload.');
console.log('');
console.log('  Everything is now consistent:');
console.log('    Weight 300 — headings, wordmark, timers (light, airy)');
console.log('    Weight 400 — body text, labels');
console.log('    Weight 500 — buttons, active nav, song titles');
console.log('    Wider letter-spacing on uppercase labels');
console.log('    Tighter letter-spacing on large text');
console.log('');
console.log('  The whole app feels like one design system now.\n');
