const fs = require('fs');

console.log('\n  Fixing Settings page...\n');

let app = fs.readFileSync('src/App.tsx', 'utf8');

// Check if imports exist
if (!app.includes('ProcessingPanel')) {
  app = app.replace(
    'import RulesEditor from "./components/RulesEditor";',
    'import RulesEditor from "./components/RulesEditor";\nimport ProcessingPanel from "./components/ProcessingPanel";'
  );
  console.log('  Added ProcessingPanel import');
}

if (!app.includes('NowPlayingSettings')) {
  app = app.replace(
    'import ProcessingPanel from "./components/ProcessingPanel";',
    'import ProcessingPanel from "./components/ProcessingPanel";\nimport NowPlayingSettings from "./components/NowPlayingSettings";'
  );
  console.log('  Added NowPlayingSettings import');
}

// Find the settings panel render and replace it completely
// Look for the current settings render
const settingsPatterns = [
  '{panel === "settings" && <div className="space-y-6"><AudioDevices',
  '{panel === "settings" && <div className="space-y-6"><NowPlayingSettings /><AudioDevices',
  '{panel === "settings" && <div className="space-y-6"><ProcessingPanel /><NowPlayingSettings /><AudioDevices',
  '{panel === "settings" && <RulesEditor />}',
];

let replaced = false;
for (const pat of settingsPatterns) {
  if (app.includes(pat)) {
    // Find the full settings line
    const idx = app.indexOf(pat);
    // Find the closing of this panel render
    let depth = 0;
    let end = idx;
    let inSettings = false;
    for (let i = idx; i < app.length; i++) {
      if (app[i] === '{' && !inSettings) { inSettings = true; depth = 1; continue; }
      if (inSettings) {
        if (app[i] === '{') depth++;
        if (app[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
      }
    }
    const oldRender = app.substring(idx, end);
    app = app.replace(oldRender, '{panel === "settings" && <div className="space-y-6"><ProcessingPanel /><NowPlayingSettings /><AudioDevices onOutputChange={handleOutputChange} onInputChange={handleInputChange} currentOutput={outputDevice} currentInput={inputDevice} /><RulesEditor /></div>}');
    replaced = true;
    console.log('  Replaced settings render');
    break;
  }
}

if (!replaced) {
  console.log('  WARNING: Could not find settings render to replace');
}

fs.writeFileSync('src/App.tsx', app, 'utf8');
console.log('\n  Done! App should hot-reload.\n');
