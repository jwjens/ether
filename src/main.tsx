import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";

async function boot() {
  const isNowPlaying = window.location.hash === "#nowplaying";

  if (isNowPlaying) {
    const { default: NowPlaying } = await import("./components/NowPlaying");
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <NowPlaying />
    );
  } else {
    const { runMigrations } = await import("./db/client");
    await runMigrations();
    const { default: App } = await import("./App");
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <App />
    );
  }
}

boot();
