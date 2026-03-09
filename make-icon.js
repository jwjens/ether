const fs = require('fs');
const path = require('path');

const dir = path.join('src-tauri', 'icons');
fs.mkdirSync(dir, { recursive: true });

// Create a minimal valid 32x32 ICO file (blue square)
function createICO() {
  const width = 32, height = 32;
  const bpp = 32;
  const imageSize = width * height * 4;
  const headerSize = 40;
  const dataSize = headerSize + imageSize;
  const buf = Buffer.alloc(6 + 16 + dataSize);
  
  // ICO header
  buf.writeUInt16LE(0, 0);     // reserved
  buf.writeUInt16LE(1, 2);     // type: icon
  buf.writeUInt16LE(1, 4);     // count: 1

  // Directory entry
  buf.writeUInt8(width, 6);
  buf.writeUInt8(height, 7);
  buf.writeUInt8(0, 8);        // palette
  buf.writeUInt8(0, 9);        // reserved
  buf.writeUInt16LE(1, 10);    // planes
  buf.writeUInt16LE(bpp, 12);  // bpp
  buf.writeUInt32LE(dataSize, 14); // size
  buf.writeUInt32LE(22, 18);   // offset

  // BMP info header
  const off = 22;
  buf.writeUInt32LE(headerSize, off);
  buf.writeInt32LE(width, off + 4);
  buf.writeInt32LE(height * 2, off + 8);
  buf.writeUInt16LE(1, off + 12);
  buf.writeUInt16LE(bpp, off + 14);

  // Pixel data (BGRA, bottom-up) - blue gradient
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = off + headerSize + (y * width + x) * 4;
      buf[i] = 200;           // B
      buf[i + 1] = 100;       // G
      buf[i + 2] = 50 + Math.floor((x / width) * 150); // R
      buf[i + 3] = 255;       // A
    }
  }
  return buf;
}

// Create a minimal PNG (32x32 blue square)
function createPNG() {
  const { createCanvas } = (() => { try { return require('canvas'); } catch { return { createCanvas: null }; } })();
  // Fallback: write a 1x1 blue PNG manually
  const png = Buffer.from([
    0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,
    0x00,0x00,0x00,0x0D,0x49,0x48,0x44,0x52,
    0x00,0x00,0x00,0x20,0x00,0x00,0x00,0x20,
    0x08,0x02,0x00,0x00,0x00,0xFC,0x18,0xED,
    0xA3,0x00,0x00,0x00,0x1E,0x49,0x44,0x41,
    0x54,0x78,0x9C,0x62,0x60,0x60,0xF8,0xCF,
    0x80,0x00,0x4C,0x28,0x12,0x4C,0xD8,0x24,
    0x98,0x08,0x67,0x31,0x52,0x0B,0x00,0x00,
    0x06,0x04,0x00,0x01,0x51,0x95,0x41,0xCA,
    0x00,0x00,0x00,0x00,0x49,0x45,0x4E,0x44,
    0xAE,0x42,0x60,0x82
  ]);
  return png;
}

const ico = createICO();
fs.writeFileSync(path.join(dir, 'icon.ico'), ico);

// Copy as PNG variants too
const png = createPNG();
fs.writeFileSync(path.join(dir, 'icon.png'), png);
fs.writeFileSync(path.join(dir, '32x32.png'), png);
fs.writeFileSync(path.join(dir, '128x128.png'), png);
fs.writeFileSync(path.join(dir, '128x128@2x.png'), png);
fs.writeFileSync(path.join(dir, 'icon.icns'), png);

console.log('CREATED icon files in src-tauri/icons/');
console.log('Run: npm run tauri:build');
