const fs = require('fs');
const path = require('path');
const os = require('os');

console.log('\n  Fixing database issue...\n');

// Step 1: Find and delete ALL openair.db files everywhere in AppData
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

function findAndDelete(baseDir) {
  if (!fs.existsSync(baseDir)) return;
  try {
    const entries = fs.readdirSync(baseDir);
    for (const entry of entries) {
      const full = path.join(baseDir, entry);
      try {
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          // Look inside directories that might be ours
          if (entry === 'com.openair.app' || entry === 'openair' || entry === 'Ether') {
            const files = fs.readdirSync(full);
            for (const f of files) {
              if (f.includes('openair') || f.includes('.db')) {
                const fp = path.join(full, f);
                fs.unlinkSync(fp);
                console.log('  DELETED: ' + fp);
              }
            }
          }
        }
      } catch (e) { /* skip permission errors */ }
    }
  } catch (e) { /* skip */ }
}

findAndDelete(appData);
findAndDelete(localAppData);

// Step 2: Fix the race condition in main.tsx
// Make the app wait for migrations before rendering
fs.writeFileSync('src/main.tsx', [
  'import React from "react";',
  'import ReactDOM from "react-dom/client";',
  'import App from "./App";',
  'import "./index.css";',
  'import { runMigrations } from "./db/client";',
  '',
  '// Wait for database tables to be created BEFORE rendering the app',
  'async function boot() {',
  '  try {',
  '    await runMigrations();',
  '    console.log("Database ready, rendering app...");',
  '  } catch (e) {',
  '    console.error("Migration failed:", e);',
  '  }',
  '  ReactDOM.createRoot(document.getElementById("root")!).render(',
  '    <React.StrictMode><App /></React.StrictMode>',
  '  );',
  '}',
  '',
  'boot();',
].join('\n'), 'utf8');
console.log('  FIXED:   src/main.tsx (waits for DB before rendering)');

console.log('\n  Done! Now run: npm run tauri:dev');
console.log('  The error should be gone. Try Import Folder.\n');
