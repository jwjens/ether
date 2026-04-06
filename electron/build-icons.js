// electron/build-icons.js
// Converts SVG source files to PNG assets used by the Electron app.
// Run with: node electron/build-icons.js

const path  = require("path");
const sharp = require("sharp");

const ASSETS = path.join(__dirname, "assets");

const jobs = [
  { input: "icon.svg",      output: "icon.png",      size: 256 },
  { input: "icon.svg",      output: "icon-512.png",  size: 512 },
  { input: "tray-icon.svg", output: "tray-icon.png", size: 32  },
];

(async () => {
  for (const { input, output, size } of jobs) {
    const src  = path.join(ASSETS, input);
    const dest = path.join(ASSETS, output);
    await sharp(src).resize(size, size).png().toFile(dest);
    console.log(`  ✓  ${input} → ${output} (${size}×${size})`);
  }
  console.log("Icons built.");
})().catch(e => { console.error(e); process.exit(1); });
