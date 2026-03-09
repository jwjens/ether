const fs = require('fs');

// Fix main.tsx to await migrations BEFORE rendering
fs.writeFileSync('src/main.tsx', [
  'import React from "react";',
  'import ReactDOM from "react-dom/client";',
  'import App from "./App";',
  'import "./index.css";',
  'import { runMigrations } from "./db/client";',
  '',
  'async function start() {',
  '  try {',
  '    await runMigrations();',
  '    console.log("Tables created, rendering app");',
  '  } catch (e) {',
  '    console.error("Migration failed, trying anyway:", e);',
  '  }',
  '  ReactDOM.createRoot(document.getElementById("root")!).render(',
  '    <React.StrictMode><App /></React.StrictMode>,',
  '  );',
  '}',
  '',
  'start();',
].join('\n'), 'utf8');

console.log('FIXED src/main.tsx — migrations run before render now');
console.log('Run: npm run tauri:dev');
