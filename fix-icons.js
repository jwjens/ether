const fs = require('fs');

console.log('\n  Fixing icons for Mac/Linux builds...\n');

// Create a proper RGBA PNG icon using raw bytes
// This creates a simple 32x32 blue square with transparency

function createRGBAPng(size) {
  // PNG header
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  
  // IHDR chunk
  const width = size;
  const height = size;
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type: RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = makeChunk('IHDR', ihdrData);
  
  // IDAT chunk - raw pixel data
  const rawData = [];
  for (let y = 0; y < height; y++) {
    rawData.push(0); // filter byte: none
    for (let x = 0; x < width; x++) {
      // Blue gradient icon with rounded corners feel
      const cx = x - width / 2;
      const cy = y - height / 2;
      const dist = Math.sqrt(cx * cx + cy * cy) / (width / 2);
      
      if (dist < 0.85) {
        // Inner area - blue
        rawData.push(37);  // R
        rawData.push(99);  // G  
        rawData.push(235); // B - #2563eb
        rawData.push(255); // A
      } else if (dist < 0.95) {
        // Edge - slightly transparent
        const alpha = Math.round(255 * (0.95 - dist) / 0.1);
        rawData.push(37);
        rawData.push(99);
        rawData.push(235);
        rawData.push(alpha);
      } else {
        // Outside - transparent
        rawData.push(0);
        rawData.push(0);
        rawData.push(0);
        rawData.push(0);
      }
    }
  }
  
  // Compress with zlib
  const zlib = require('zlib');
  const compressed = zlib.deflateSync(Buffer.from(rawData));
  const idat = makeChunk('IDAT', compressed);
  
  // IEND chunk
  const iend = makeChunk('IEND', Buffer.alloc(0));
  
  return Buffer.concat([signature, ihdr, idat, iend]);
}

function makeChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = crc32(Buffer.concat([typeBuffer, data]));
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc, 0);
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  const table = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Generate icons at required sizes
fs.mkdirSync('src-tauri/icons', { recursive: true });

const sizes = [32, 128, 256];
sizes.forEach(size => {
  const png = createRGBAPng(size);
  fs.writeFileSync(`src-tauri/icons/${size}x${size}.png`, png);
  console.log(`  Created ${size}x${size}.png`);
});

// Copy 256 as the main icon.png
fs.copyFileSync('src-tauri/icons/256x256.png', 'src-tauri/icons/icon.png');
fs.copyFileSync('src-tauri/icons/128x128.png', 'src-tauri/icons/128x128@2x.png');
fs.copyFileSync('src-tauri/icons/32x32.png', 'src-tauri/icons/32x32.png');
console.log('  Copied icon.png');

// Also create Square150x150Logo.png and Square310x310Logo.png for Windows
const png150 = createRGBAPng(150);
fs.writeFileSync('src-tauri/icons/Square150x150Logo.png', png150);
const png310 = createRGBAPng(310);
fs.writeFileSync('src-tauri/icons/Square310x310Logo.png', png310);
console.log('  Created Windows store logos');

// Keep existing .ico if it exists, otherwise note it
if (!fs.existsSync('src-tauri/icons/icon.ico')) {
  console.log('  NOTE: icon.ico not found - Windows build may use default');
}

console.log('\n  Done! Push and rebuild:');
console.log('    git add -A');
console.log('    git commit -m "fix RGBA icons for Mac build"');
console.log('    git push');
console.log('    git tag -f v1.5.0');
console.log('    git push --tags --force\n');
