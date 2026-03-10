const fs = require('fs');

// Check if file exists
if (!fs.existsSync('src/components/NowPlayingSettings.tsx')) {
  fs.writeFileSync('src/components/NowPlayingSettings.tsx', `import { useState } from "react";
export default function NowPlayingSettings() {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-bold text-zinc-300">Now Playing Metadata</h2>
      <div className="text-xs text-zinc-500">Pushes current track info to files and services when each song starts. Configure in a future update.</div>
      <div className="text-xs text-zinc-400">JSON file, text file, TuneIn, and webhook outputs — coming soon.</div>
    </div>
  );
}
`, 'utf8');
  console.log('CREATED NowPlayingSettings.tsx');
} else {
  console.log('File already exists');
}

// Also check ProcessingPanel exists
if (!fs.existsSync('src/components/ProcessingPanel.tsx')) {
  fs.writeFileSync('src/components/ProcessingPanel.tsx', `import { useState } from "react";
export default function ProcessingPanel() {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-bold text-zinc-300">Audio Processing</h2>
      <div className="text-xs text-zinc-500">LUFS normalization and volume analysis — coming soon.</div>
    </div>
  );
}
`, 'utf8');
  console.log('CREATED ProcessingPanel.tsx');
} else {
  console.log('ProcessingPanel already exists');
}

console.log('Done! Run: npm run tauri:dev');
