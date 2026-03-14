const fs = require('fs');
let f = fs.readFileSync('src/components/NowPlaying.tsx', 'utf8');

// Make "Now Playing" label brighter and bigger
f = f.replace(
  'fontSize: 11, color: "rgba(255,255,255,0.35)", letterSpacing: "0.2em", textTransform: "uppercase" as any, marginBottom: 12',
  'fontSize: 14, color: "rgba(255,255,255,0.7)", letterSpacing: "0.2em", textTransform: "uppercase" as any, marginBottom: 12, fontWeight: 600'
);

// Make title bigger and pure white
f = f.replace(
  'fontSize: albumArt ? 52 : 72, fontWeight: 700, lineHeight: 1.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"',
  'fontSize: albumArt ? 58 : 80, fontWeight: 800, lineHeight: 1.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: "#ffffff", textShadow: "0 2px 20px rgba(0,0,0,0.8)"'
);

// Make artist name much brighter
f = f.replace(
  'fontSize: albumArt ? 28 : 36, color: "rgba(255,255,255,0.55)", marginBottom: 40',
  'fontSize: albumArt ? 32 : 42, color: "rgba(255,255,255,0.9)", marginBottom: 40, fontWeight: 500, textShadow: "0 2px 12px rgba(0,0,0,0.8)"'
);

fs.writeFileSync('src/components/NowPlaying.tsx', f);
console.log('Done');
