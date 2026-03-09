const fs = require('fs');

console.log('\n  Ether — Fix audio for release builds\n');

let engine = fs.readFileSync('src/audio/engine.ts', 'utf8');

// Replace the fetch-based loading with Tauri fs readFile
if (!engine.includes('readFile')) {
  // Add fs import at top
  engine = engine.replace(
    'import { convertFileSrc } from "@tauri-apps/api/core";',
    'import { readFile } from "@tauri-apps/plugin-fs";'
  );

  // Replace the load method's fetch logic
  engine = engine.replace(
    "      const url = convertFileSrc(filePath);\n      const resp = await fetch(url);\n      if (!resp.ok) throw new Error(\"fetch failed: \" + resp.status);\n      const ab = await resp.arrayBuffer();",
    "      const bytes = await readFile(filePath);\n      const ab = bytes.buffer;"
  );

  fs.writeFileSync('src/audio/engine.ts', engine, 'utf8');
  console.log('  FIXED src/audio/engine.ts (uses readFile instead of fetch)');
}

// Also fix id3.ts
let id3 = fs.readFileSync('src/audio/id3.ts', 'utf8');
if (id3.includes('convertFileSrc')) {
  id3 = id3.replace(
    'import { convertFileSrc } from "@tauri-apps/api/core";',
    'import { readFile } from "@tauri-apps/plugin-fs";'
  );
  id3 = id3.replace(
    "    const url = convertFileSrc(filePath);\n    const resp = await fetch(url);\n    if (!resp.ok) return result;\n    const ab = await resp.arrayBuffer();",
    "    const bytes = await readFile(filePath);\n    const ab = bytes.buffer;"
  );
  fs.writeFileSync('src/audio/id3.ts', id3, 'utf8');
  console.log('  FIXED src/audio/id3.ts (uses readFile instead of fetch)');
}

// Also fix CueEditor
if (fs.existsSync('src/components/CueEditor.tsx')) {
  let cue = fs.readFileSync('src/components/CueEditor.tsx', 'utf8');
  if (cue.includes('convertFileSrc')) {
    cue = cue.replace(
      'import { convertFileSrc } from "@tauri-apps/api/core";',
      'import { readFile } from "@tauri-apps/plugin-fs";'
    );
    cue = cue.replace(
      "        const url = convertFileSrc(filePath);\n        const resp = await fetch(url);\n        const ab = await resp.arrayBuffer();",
      "        const bytes = await readFile(filePath);\n        const ab = bytes.buffer;"
    );
    fs.writeFileSync('src/components/CueEditor.tsx', cue, 'utf8');
    console.log('  FIXED src/components/CueEditor.tsx (uses readFile instead of fetch)');
  }
}

console.log('\n  Done! Rebuild:');
console.log('    npm run tauri:build');
console.log('  The installer will now load audio files properly.\n');
