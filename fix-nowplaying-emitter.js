const fs = require('fs');
let f = fs.readFileSync('src/App.tsx', 'utf8');

// Add emit import if not present
if (!f.includes("from '@tauri-apps/api/event'") && !f.includes('from "@tauri-apps/api/event"')) {
  f = f.replace(
    "import { WebviewWindow }",
    "import { emit } from '@tauri-apps/api/event';\nimport { WebviewWindow }"
  );
}

// Find engine.on and inject after setQueueLen line
const marker = 'setQueueLen(engine.getQueue().length);';
const injection = `
      emit("now-playing-update", {
        title: st.title || "Ether Radio",
        artist: st.artist || "",
        positionSec: st.positionSec || 0,
        durationSec: st.durationSec || 0,
        isPlaying: st.status === "playing",
      }).catch(() => {});`;

if (f.includes(marker) && !f.includes('now-playing-update')) {
  f = f.replace(marker, marker + injection);
  console.log('Patched!');
} else if (f.includes('now-playing-update')) {
  console.log('Already patched');
} else {
  console.log('marker not found');
}

fs.writeFileSync('src/App.tsx', f);
console.log('Done');
