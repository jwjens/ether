const fs = require('fs');
let f = fs.readFileSync('src/App.tsx', 'utf8');
// Add emit import at the very top
f = 'import { emit } from "@tauri-apps/api/event";\n' + f;
fs.writeFileSync('src/App.tsx', f);
console.log('Done');
