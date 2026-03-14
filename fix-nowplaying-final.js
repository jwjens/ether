const fs = require('fs');
let f = fs.readFileSync('src/components/NowPlaying.tsx', 'utf8');

// Fix the "Now Playing" label - currently dim
f = f.replace(
  `fontSize: 11, color: "rgba(255,255,255,0.35)", letterSpacing: "0.2em", textTransform: "uppercase" as any, marginBottom: 4`,
  `fontSize: 16, color: "#ffffff", letterSpacing: "0.2em", textTransform: "uppercase" as any, marginBottom: 8, fontWeight: 700`
);

// Fix title size
f = f.replace(
  `fontSize: 28, fontWeight: 700, lineHeight: 1.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"`,
  `fontSize: 42, fontWeight: 800, lineHeight: 1.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: "#ffffff"`
);

// Fix artist color
f = f.replace(
  `fontSize: 16, color: "rgba(255,255,255,0.55)", marginTop: 2`,
  `fontSize: 28, color: "#ffffff", marginTop: 6, fontWeight: 400`
);

// Fix close button color
f = f.replace(
  `color: "rgba(255,255,255,0.5)", fontSize: 11, cursor: "pointer", letterSpacing: "0.08em"`,
  `color: "#ffffff", fontSize: 13, cursor: "pointer", letterSpacing: "0.08em"`
);

fs.writeFileSync('src/components/NowPlaying.tsx', f);
console.log('Done');
