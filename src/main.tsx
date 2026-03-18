import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import NowPlaying from "./components/NowPlaying";
import "./index.css";
import { runMigrations } from "./db/client";

async function boot() {
  const isNowPlaying = window.location.hash === "#nowplaying";

  if (!isNowPlaying) {
    await runMigrations();
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    isNowPlaying ? <NowPlaying /> : <App />
  );
}

boot();
