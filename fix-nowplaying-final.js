const fs = require('fs');

// 1. Revert window URL back to hash
let win = fs.readFileSync('src/components/NowPlayingWindow.tsx', 'utf8');
win = win.replace('url: "/now-playing.html"', 'url: "/#nowplaying"');
fs.writeFileSync('src/components/NowPlayingWindow.tsx', win);

// 2. Fix main.tsx - check hash BEFORE React renders anything
fs.writeFileSync('src/main.tsx', `import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";

async function boot() {
  const isNowPlaying = window.location.hash === "#nowplaying";

  if (isNowPlaying) {
    const { default: NowPlaying } = await import("./components/NowPlaying");
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <React.StrictMode><NowPlaying /></React.StrictMode>
    );
  } else {
    const { runMigrations } = await import("./db/client");
    await runMigrations();
    const { default: App } = await import("./App");
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <React.StrictMode><App /></React.StrictMode>
    );
  }
}

boot();
`);

console.log('Done');
