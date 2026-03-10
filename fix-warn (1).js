const fs = require('fs');

let deck = fs.readFileSync('src/components/OnAirDeck.tsx', 'utf8');
deck = deck.replace(
  /letterSpacing: "-0\.02em", lineHeight: 1, color: accentColor, letterSpacing: "-0\.02em"/,
  'letterSpacing: "-0.02em", lineHeight: 1, color: accentColor'
);
fs.writeFileSync('src/components/OnAirDeck.tsx', deck, 'utf8');

let up = fs.readFileSync('src/components/UpNext.tsx', 'utf8');
up = up.replace(
  /letterSpacing: "0\.06em" as any, letterSpacing: "0\.04em"/,
  'letterSpacing: "0.06em"'
);
fs.writeFileSync('src/components/UpNext.tsx', up, 'utf8');

console.log('Fixed. git add -A && git commit -m "fix warnings" && git push --force');
