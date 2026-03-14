const fs = require('fs');
let f = fs.readFileSync('src/components/NowPlaying.tsx', 'utf8');

// Make the OV logo much bigger in the placeholder
f = f.replace(
  '<img src={ovLogo} alt="Opportunity Village" style={{ maxWidth: 220, maxHeight: 120, objectFit: "contain", opacity: 0.85 }} />',
  '<img src={ovLogo} alt="Opportunity Village" style={{ maxWidth: 480, maxHeight: 280, objectFit: "contain", opacity: 0.95 }} />'
);

// Make the watermark logo bigger too
f = f.replace(
  '<img src={ovLogo} alt="OV" style={{ height: 28, opacity: 0.5, objectFit: "contain" }} />',
  '<img src={ovLogo} alt="OV" style={{ height: 48, opacity: 0.6, objectFit: "contain" }} />'
);

fs.writeFileSync('src/components/NowPlaying.tsx', f);
console.log('Done');
