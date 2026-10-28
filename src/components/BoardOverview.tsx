// BoardOverview — the fader bank overview above the board (Jeff, 2026-10-28): every fader on the board as one small box,
// the ones in view highlighted; a click scrolls the board there. Shown only when the strips don't all fit (the board
// then scrolls sideways; Master Out stays pinned on the right, outside the scrolling bank). src/lib/boardLayout.ts.
import { useCallback, useEffect, useState, type RefObject } from "react";
import { visibleStrips, scrollToShow, overflows, type StripBox } from "../lib/boardLayout";

export default function BoardOverview({ bankRef, nameOf }: { bankRef: RefObject<HTMLDivElement | null>; nameOf: (slot: string) => string }) {
  const [boxes, setBoxes] = useState<StripBox[]>([]);
  const [view, setView] = useState({ left: 0, width: 0, content: 0 });

  const measure = useCallback(() => {
    const bank = bankRef.current; if (!bank) return;
    const els = Array.from(bank.querySelectorAll<HTMLElement>("[data-board-strip]"));
    setBoxes(els.map(el => ({ key: el.dataset.boardStrip || "", left: el.offsetLeft - bank.offsetLeft, width: el.offsetWidth })));
    setView({ left: bank.scrollLeft, width: bank.clientWidth, content: bank.scrollWidth });
  }, [bankRef]);

  useEffect(() => {
    const bank = bankRef.current; if (!bank) return;
    measure();
    bank.addEventListener("scroll", measure, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(bank);
    for (const el of Array.from(bank.children)) ro?.observe(el as Element);
    const mo = typeof MutationObserver !== "undefined" ? new MutationObserver(measure) : null;
    mo?.observe(bank, { childList: true, subtree: false });
    return () => { bank.removeEventListener("scroll", measure); ro?.disconnect(); mo?.disconnect(); };
  }, [bankRef, measure]);

  if (!overflows(view.content, view.width)) return null;
  const shown = new Set(visibleStrips(boxes, view.left, view.width));
  const jump = (key: string) => {
    const bank = bankRef.current; if (!bank) return;
    bank.scrollTo({ left: scrollToShow(boxes, key, bank.scrollLeft, bank.clientWidth), behavior: "smooth" });
  };
  return (
    <div data-board-overview="1" style={{ display: "flex", gap: 3, padding: "3px 6px", alignItems: "center", flexShrink: 0,
                                          borderBottom: "1px solid var(--strip-divider, #303040)", background: "var(--panel-bg, #0e0e13)" }}>
      <span style={{ fontSize: 9, letterSpacing: "0.12em", color: "var(--text-tertiary)", marginRight: 4 }}>FADERS</span>
      {boxes.map(b => {
        const on = shown.has(b.key);
        return (
          <button key={b.key} data-overview-strip={b.key} data-overview-visible={on ? "1" : "0"} onClick={() => jump(b.key)}
                  title={`Fader ${nameOf(b.key)}${on ? " (in view)" : " — show it"}`}
                  style={{ minWidth: 22, height: 18, padding: "0 4px", fontSize: 10, fontWeight: 700, cursor: "pointer", borderRadius: 2,
                           border: `1px solid ${on ? "var(--accent-cyan)" : "var(--border-primary)"}`,
                           background: on ? "rgb(from var(--accent-cyan) r g b / 0.18)" : "var(--bg-tertiary)",
                           color: on ? "var(--accent-cyan)" : "var(--text-tertiary)" }}>
            {nameOf(b.key)}
          </button>
        );
      })}
    </div>
  );
}
