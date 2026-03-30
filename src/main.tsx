import React from "react";
import * as Sentry from "@sentry/electron/renderer";

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  enabled: !import.meta.env.DEV,
  release: "ether@" + (import.meta.env.VITE_APP_VERSION ?? "1.0.0"),
  tracesSampleRate: 0.1,
});
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
