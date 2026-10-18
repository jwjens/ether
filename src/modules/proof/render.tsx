// Mount / act helpers for the module proofs. Import "./miniDom" before this file (it installs the DOM react-dom reads
// when it loads).
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { fire } from "./miniDom";

export interface Mounted { container: any; unmount(): Promise<void> }

/** Let effects, IPC promises and short timers run, inside act so React flushes what they set. */
export async function settle(ms = 40): Promise<void> {
  await act(async () => { await new Promise(r => setTimeout(r, ms)); });
}

export async function mount(el: ReactElement): Promise<Mounted> {
  const container = (globalThis as any).document.createElement("div");
  (globalThis as any).document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(el); });
  await settle();
  return {
    container,
    async unmount() {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

export async function click(el: any, init: Record<string, unknown> = {}): Promise<void> {
  if (!el) throw new Error("click: no element");
  await act(async () => { fire(el, "click", init); });
  await settle();
}

export async function pointerDown(el: any): Promise<void> {
  if (!el) throw new Error("pointerDown: no element");
  await act(async () => { fire(el, "pointerdown"); });
}
