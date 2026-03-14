const fs = require('fs');
let f = fs.readFileSync('src/components/NowPlaying.tsx', 'utf8');

// Bottom info bar - make background darker and text pure white
f = f.replace(
  'background: "rgba(0,0,0,0.4)", borderRadius: 14, padding: "16px 24px", backdropFilter: "blur(20px)", border: "1px solid rgba(255,255,255,0.08)"',
  'background: "rgba(0,0,0,0.75)", borderRadius: 14, padding: "20px 28px", backdropFilter: "blur(20px)", border: "1px solid rgba(255,255,255,0.15)"'
);

// Progress bar text
f = f.replace(
  'fontSize: 12, fontFamily: "monospace", color: "rgba(255,255,255,0.3)"',
  'fontSize: 14, fontFamily: "monospace", color: "rgba(255,255,255,0.8)"'
);

// Progress bar itself - brighter
f = f.replace(
  'height: 3, background: "rgba(255,255,255,0.1)", borderRadius: 2, overflow: "hidden", marginBottom: 6',
  'height: 5, background: "rgba(255,255,255,0.2)", borderRadius: 2, overflow: "hidden", marginBottom: 8'
);

fs.writeFileSync('src/components/NowPlaying.tsx', f);
console.log('Done');
