#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const FILES = {

"index.html": `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>OpenAir</title></head>
<body class="bg-zinc-950 text-zinc-100 overflow-hidden"><div id="root"></div>
<script type="module" src="/src/main.tsx"></script>
</body>
</html>`,

"vite.config.ts": `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 1420,
    strictPort: true,
    watch: { usePolling: true },
  },
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: process.env.TAURI_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
`,

"tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2021",
    "useDefineForClassFields": true,
    "lib": ["ES2021", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
`,

"tsconfig.node.json": `{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true
  },
  "include": ["vite.config.ts"]
}
`,

"tailwind.config.js": `/** @type {import("tailwindcss").Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: { extend: { colors: {
    "on-air": "#ef4444", "cued": "#22c55e", "automation": "#3b82f6"
  }}},
  plugins: [],
};
`,

"postcss.config.js": `export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};
`,

"src/index.css": `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\nhtml, body, #root { height: 100%; margin: 0; padding: 0; }\n::-webkit-scrollbar { width: 8px; height: 8px; }\n::-webkit-scrollbar-track { background: rgb(24 24 27); }\n::-webkit-scrollbar-thumb { background: rgb(63 63 70); border-radius: 4px; }\n.no-select { user-select: none; -webkit-user-select: none; }\n`,

"src/main.tsx": `import React from "react";\nimport ReactDOM from "react-dom/client";\nimport App from "./App";\nimport "./index.css";\n\nReactDOM.createRoot(document.getElementById("root")!).render(\n  <React.StrictMode><App /></React.StrictMode>,\n);\n`,

"src/App.tsx": `import { useState, useEffect } from "react";\n\ntype Panel = "live" | "library" | "clocks" | "logs" | "spots" | "settings";\n\nexport default function App() {\n  const [activePanel, setActivePanel] = useState<Panel>("live");\n  const [onAir, setOnAir] = useState(false);\n\n  return (\n    <div className="h-screen flex flex-col bg-zinc-950 text-zinc-100">\n      <header className="h-12 flex items-center justify-between px-4 bg-zinc-900 border-b border-zinc-800 shrink-0">\n        <div className="flex items-center gap-3">\n          <span className="text-lg font-bold tracking-tight">\n            <span className="text-blue-400">Open</span>Air\n          </span>\n          <span className="text-xs text-zinc-500">v0.1.0</span>\n        </div>\n        <div className="flex items-center gap-2 text-sm text-zinc-400">\n          <ClockDisplay />\n          <button onClick={() => setOnAir(!onAir)}\n            className={\\\`ml-3 px-3 py-1 rounded text-xs font-bold uppercase tracking-wider transition-all \\\${\n              onAir ? "bg-red-600 text-white animate-pulse" : "bg-zinc-700 text-zinc-400 hover:bg-zinc-600"\n            }\\\`}>\n            {onAir ? "\\u25CF On Air" : "Off Air"}\n          </button>\n        </div>\n      </header>\n\n      <div className="flex flex-1 overflow-hidden">\n        <nav className="w-48 bg-zinc-900 border-r border-zinc-800 flex flex-col py-2 shrink-0">\n          {PANELS.map(({ id, label, icon }) => (\n            <button key={id} onClick={() => setActivePanel(id)}\n              className={\\\`flex items-center gap-2 px-4 py-2.5 text-sm text-left transition-colors \\\${\n                activePanel === id\n                  ? "bg-zinc-800 text-white border-l-2 border-blue-400"\n                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50 border-l-2 border-transparent"\n              }\\\`}>\n              <span className="text-base">{icon}</span> {label}\n            </button>\n          ))}\n          <div className="mt-auto px-4 py-3 text-[10px] text-zinc-600">OpenAir v0.1.0<br/>MIT License</div>\n        </nav>\n\n        <main className="flex-1 overflow-auto p-6">\n          {activePanel === "live" && <LivePanel onAir={onAir} />}\n          {activePanel === "library" && <P title="Song Library" d="Scan folders, edit metadata, assign categories." />}\n          {activePanel === "clocks" && <P title="Clock Builder" d="Design hourly format clocks." />}\n          {activePanel === "logs" && <P title="Log Builder" d="Generate and edit hourly playlists." />}\n          {activePanel === "spots" && <P title="Spot Inventory" d="Manage commercials, PSAs, promos." />}\n          {activePanel === "settings" && <P title="Settings" d="Station name, audio device, rules, theme." />}\n        </main>\n      </div>\n\n      <footer className="h-7 flex items-center justify-between px-4 bg-zinc-900 border-t border-zinc-800 text-[11px] text-zinc-500 shrink-0">\n        <span>Ready</span>\n        <span>SQLite: connected \\u00B7 Audio: Web Audio API \\u00B7 Mode: Manual</span>\n      </footer>\n    </div>\n  );\n}\n\nconst PANELS: { id: Panel; label: string; icon: string }[] = [\n  { id: "live", label: "Live Assist", icon: "\\u25B6" },\n  { id: "library", label: "Library", icon: "\\u266B" },\n  { id: "clocks", label: "Clocks", icon: "\\u25F7" },\n  { id: "logs", label: "Logs", icon: "\\u2630" },\n  { id: "spots", label: "Spots", icon: "\\u25C8" },\n  { id: "settings", label: "Settings", icon: "\\u2699" },\n];\n\nfunction LivePanel({ onAir }: { onAir: boolean }) {\n  return (\n    <div className="space-y-4">\n      <h1 className="text-xl font-bold">Live Assist</h1>\n      <div className="grid grid-cols-2 gap-4">\n        <div className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">\n          <span className="text-xs font-bold text-blue-400 uppercase">Deck A</span>\n          <Deck active={onAir} />\n        </div>\n        <div className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">\n          <span className="text-xs font-bold text-emerald-400 uppercase">Deck B</span>\n          <Deck active={false} />\n        </div>\n      </div>\n      <div className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">\n        <h2 className="text-xs font-bold text-zinc-400 uppercase mb-3">Up Next</h2>\n        <div className="text-sm text-zinc-500 italic">No log loaded.</div>\n      </div>\n      <div className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">\n        <h2 className="text-xs font-bold text-zinc-400 uppercase mb-3">Cart Wall</h2>\n        <div className="grid grid-cols-8 gap-1.5">\n          {Array.from({length:32},(_,i)=>(\n            <button key={i} className="aspect-square rounded bg-zinc-800 hover:bg-zinc-700 text-[10px] text-zinc-600 flex items-center justify-center">\n              {i<12?\\\`F\\\${i+1}\\\`:""}\n            </button>\n          ))}\n        </div>\n      </div>\n    </div>\n  );\n}\n\nfunction Deck({ active }: { active: boolean }) {\n  return (\n    <div className="space-y-3 mt-3">\n      <div className="h-20 bg-zinc-800 rounded flex items-center justify-center">\n        <span className="text-zinc-600 text-xs">No track loaded</span>\n      </div>\n      <div className="flex justify-between text-xs font-mono text-zinc-500"><span>00:00.0</span><span>-00:00.0</span></div>\n      <div className="flex items-center gap-2">\n        <button className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-xs">Cue</button>\n        <button className={\\\`px-4 py-1.5 rounded text-xs font-bold flex-1 \\\${active?"bg-red-600 text-white":"bg-emerald-700 hover:bg-emerald-600 text-white"}\\\`}>\n          {active?"Stop":"Play"}\n        </button>\n        <button className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-xs">Next</button>\n      </div>\n    </div>\n  );\n}\n\nfunction P({ title, d }: { title: string; d: string }) {\n  return (\n    <div className="flex flex-col items-center justify-center h-full text-center">\n      <h1 className="text-xl font-bold mb-2">{title}</h1>\n      <p className="text-sm text-zinc-400 max-w-md">{d}</p>\n      <p className="text-xs text-zinc-600 mt-4">Coming soon</p>\n    </div>\n  );\n}\n\nfunction ClockDisplay() {\n  const [time, setTime] = useState(new Date().toLocaleTimeString());\n  useEffect(() => {\n    const id = setInterval(() => setTime(new Date().toLocaleTimeString()), 1000);\n    return () => clearInterval(id);\n  }, []);\n  return <span className="font-mono text-xs">{time}</span>;\n}\n`,

"src-tauri/tauri.conf.json": `{
  "$schema": "https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-config-schema/schema.json",
  "productName": "OpenAir",
  "version": "0.1.0",
  "identifier": "com.openair.app",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:1420",
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build"
  },
  "app": {
    "title": "OpenAir",
    "windows": [{
      "title": "OpenAir",
      "width": 1280,
      "height": 800,
      "minWidth": 960,
      "minHeight": 600,
      "resizable": true
    }],
    "security": {
      "csp": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; media-src 'self' asset: file:; img-src 'self' asset: file:"
    }
  },
  "bundle": { "active": true, "targets": "all" },
  "plugins": { "sql": { "preload": { "db": "sqlite:openair.db" } } }
}
`,

"src-tauri/Cargo.toml": `[package]\nname = "openair"\nversion = "0.1.0"\nedition = "2021"\ndescription = "Free broadcast automation"\n\n[build-dependencies]\ntauri-build = { version = "2", features = [] }\n\n[dependencies]\ntauri = { version = "2", features = [] }\ntauri-plugin-sql = { version = "2", features = ["sqlite"] }\ntauri-plugin-dialog = "2"\ntauri-plugin-fs = "2"\ntauri-plugin-shell = "2"\nserde = { version = "1", features = ["derive"] }\nserde_json = "1"\n`,

"src-tauri/build.rs": `fn main() {\n    tauri_build::build()\n}\n`,

"src-tauri/src/main.rs": `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]\n\nfn main() {\n    tauri::Builder::default()\n        .plugin(tauri_plugin_sql::Builder::new().build())\n        .plugin(tauri_plugin_dialog::init())\n        .plugin(tauri_plugin_fs::init())\n        .plugin(tauri_plugin_shell::init())\n        .run(tauri::generate_context!())\n        .expect("error while running OpenAir");\n}\n`,

"src-tauri/capabilities/default.json": `{\n  "identifier": "default",\n  "description": "Default permissions for OpenAir",\n  "windows": ["main"],\n  "permissions": [\n    "core:default", "sql:default", "dialog:default", "fs:default", "shell:default"\n  ]\n}\n`,

};

if(!fs.existsSync("package.json")){console.log("\nERROR: No package.json found. Run this from your openair/ folder.\n");process.exit(1);}
console.log("\n  OpenAir Bootstrap Setup\n  ----------------------\n");
let c=0,r=0;
for(const[f,content]of Object.entries(FILES)){
  const d=path.dirname(f); if(d!==".")fs.mkdirSync(d,{recursive:true});
  const existed=fs.existsSync(f); fs.writeFileSync(f,content,"utf8");
  console.log("  "+(existed?"REPLACED":"CREATED ")+"  "+f);
  if(existed)r++;else c++;
}
console.log("\n  Done! "+c+" created, "+r+" replaced.");
console.log("\n  Next:\n    npm install\n    npm run tauri:dev\n");
