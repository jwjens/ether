const fs = require('fs');
let f = fs.readFileSync('src/components/NowPlaying.tsx', 'utf8');

// Make OV logo fill the entire right panel
f = f.replace(
  `<img src={ovLogo} alt="Opportunity Village" style={{ maxWidth: 480, maxHeight: 280, objectFit: "contain", opacity: 0.95 }} />
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.25)", letterSpacing: "0.15em", textTransform: "uppercase" }}>Powered by Ether</div>`,
  `<img src={ovLogo} alt="Opportunity Village" style={{ width: "90%", height: "80%", objectFit: "contain", opacity: 0.98 }} />`
);

fs.writeFileSync('src/components/NowPlaying.tsx', f);
console.log('Done');
