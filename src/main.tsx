import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import NowPlaying from "./components/NowPlaying";
import ProducerDeskWindow from "./components/ProducerDeskWindow";
import CueEditorWindow from "./components/CueEditorWindow";
import "./index.css";
import { runMigrations } from "./db/client";

async function boot() {
  const hash = window.location.hash;
  const isNowPlaying  = hash === "#nowplaying";
  const isDesk        = hash === "#desk";
  const isCueEditor   = hash.startsWith("#cueeditor");

  if (!isNowPlaying && !isDesk && !isCueEditor) {
    await runMigrations();
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    isNowPlaying  ? <NowPlaying /> :
    isDesk        ? <ProducerDeskWindow /> :
    isCueEditor   ? <CueEditorWindow /> :
    <App />
  );
}

boot();
