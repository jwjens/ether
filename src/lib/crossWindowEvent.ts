// crossWindowEvent.ts — dispatch a DOM CustomEvent that also reaches Ether's OTHER windows.
//
// WHY. A `window.dispatchEvent` never leaves the window it fired in. That was invisible while a
// control and its listener always rendered in the same window, and it stopped being invisible when
// the board became a window of its own: the GUEST strip's ON button dispatches 'ether:guest-toggle'
// for the WebRTC layer to act on, and fired from a pop-out it reaches nobody. A control that renders
// and does nothing is the exact defect this arc exists to close — the dead BYPASS button, the
// Library pop-out's dead Edit, the cart that played into another station.
//
// Same shape as the operator console's relay (consoleLog, MasterOutput.tsx): dispatch LOCALLY FIRST
// and unconditionally, so the emitting window behaves identically with no IPC and keeps working in
// the dev server or a browser where window.ether is absent. Then hand it to main, which fans it out
// to every window against an ALLOW-LIST (electron/main.js). The receiver skips its own origin, which
// is what stops the echo.
//
// This is NOT a general renderer-to-renderer bus, on purpose. A general one is an invitation to move
// state between windows by shouting, which is how two windows end up disagreeing — the thing
// deck_configs.channel_on and the deck_configs:changed broadcast exist to prevent. Use it only for an
// event whose listener may legitimately live in a different window than the control.

const ORIGIN =
  Math.random().toString(36).slice(2) +
  "-" +
  (typeof performance !== "undefined" ? Math.floor(performance.now()) : 0);

/** Fire a CustomEvent in this window AND in every other Ether window. */
export function dispatchCrossWindow(name: string, detail: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
  try {
    (window as any).ether?.ui?.broadcast?.({ name, detail, origin: ORIGIN });
  } catch {
    /* no IPC — the local dispatch above already stands */
  }
}

let installed = false;

/**
 * Re-dispatch relayed events locally so existing `window.addEventListener` code needs no change.
 * Installed once per window; safe to call repeatedly.
 */
export function installCrossWindowEvents(): void {
  if (installed) return;
  const ether = (window as any).ether;
  if (!ether?.ui?.onBroadcast) return;
  installed = true;
  ether.ui.onBroadcast((msg: { name: string; detail: unknown; origin?: string }) => {
    if (!msg || !msg.name || msg.origin === ORIGIN) return; // our own event, already dispatched
    window.dispatchEvent(new CustomEvent(msg.name, { detail: msg.detail }));
  });
}
