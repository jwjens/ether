import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { runMigrations } from "./db/client";

// Wait for database tables to be created BEFORE rendering the app
async function boot() {
  try {
    await runMigrations();
    console.log("Database ready, rendering app...");
  } catch (e) {
    console.error("Migration failed:", e);
  }
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode><App /></React.StrictMode>
  );
}

boot();