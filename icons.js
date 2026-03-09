const fs = require('fs');
const path = require('path');
const dir = path.join('src-tauri', 'icons');
fs.mkdirSync(dir, { recursive: true });
const png = Buffer.from(
'89504e470d0a1a0a0000000d4948445200000001000000010806' +
'0000001f15c4890000000a49444154789c62600000000200019' +
'8e1938a0000000049454e44ae426082', 'hex'
);
const names = ['icon.ico','icon.png','32x32.png','128x128.png','128x128@2x.png','icon.icns'];
names.forEach(n => fs.writeFileSync(path.join(dir, n), png));
console.log('Icons created!');
