// etherConfirm — Ether's own "are you sure?", callable from anywhere (Jeff, 2026-10-30: "Every "are you sure?" box:
// replace it with Ether's own confirm window that works in the installed app").
//
// The browser's window.confirm silently does nothing in the installed (packaged Electron) app — electron/main.js,
// File ▸ Sign Out — so every action behind it could never run. `await etherConfirm("Delete X?", { danger: true })`
// shows the app-wide window (EtherConfirmHost, mounted at every window's root in src/main.tsx) and resolves true
// only on the confirm button (or Enter); Cancel / Esc resolves false.
import { createConfirmController } from "./confirmController";

export const etherConfirmController = createConfirmController();

export function etherConfirm(message: string, opts?: { confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return etherConfirmController.ask(message, opts);
}
