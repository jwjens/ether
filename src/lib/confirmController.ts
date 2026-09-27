// confirmController — an in-app "are you sure?" (audit 5, docs/help-audit-2026-09-27.md).
//
// The renderer's window.confirm silently no-ops in the packaged Electron build (electron/main.js, File ▸ Sign Out),
// so a destructive action gated on it can never run. This is the replacement: ask() returns a promise the dialog
// settles with answer(). Pure — no DOM — so the flow is tested without a browser (confirmController.test.ts); the
// ConfirmDialog component renders whatever is pending.

export interface ConfirmRequest { message: string; confirmLabel: string; danger: boolean }
export interface ConfirmController {
  ask(message: string, opts?: { confirmLabel?: string; danger?: boolean }): Promise<boolean>;
  answer(yes: boolean): void;
  pending(): ConfirmRequest | null;
  subscribe(fn: () => void): () => void;
}

export function createConfirmController(): ConfirmController {
  let current: (ConfirmRequest & { resolve: (v: boolean) => void }) | null = null;
  const subs = new Set<() => void>();
  const emit = () => subs.forEach(f => f());
  return {
    ask(message, opts = {}) {
      // A new question replaces an unanswered one, which is answered NO — nothing destructive runs unconfirmed.
      if (current) current.resolve(false);
      return new Promise<boolean>(resolve => {
        current = { message, confirmLabel: opts.confirmLabel ?? "OK", danger: !!opts.danger, resolve };
        emit();
      });
    },
    answer(yes) {
      if (!current) return;
      const c = current; current = null;
      c.resolve(!!yes);
      emit();
    },
    pending: () => (current ? { message: current.message, confirmLabel: current.confirmLabel, danger: current.danger } : null),
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
  };
}
