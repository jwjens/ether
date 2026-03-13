import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import NowPlaying from "./components/NowPlaying";
import "./index.css";
import { runMigrations } from "./db/client";

const isNowPlaying = window.location.hash === "#nowplaying";

async function boot() {
  await runMigrations();
  ReactDOM.createRoot(document.getElementById("root")!).render(
    isNowPlaying ? <NowPlaying /> : <App />
  );
}

boot();