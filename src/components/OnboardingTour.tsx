// src/components/OnboardingTour.tsx
// Interactive first-run onboarding tour for Ether
// Shows a spotlight + callout on each UI element, advances on action or click

import { useState, useEffect, useRef, useCallback } from "react";
import { useActiveStation } from "../hooks/useActiveStation";

const TOUR_VERSION = "1.5.2"; // bump this to re-show tour after major updates

// ── Step definitions ──────────────────────────────────────────

interface TourStep {
  id: string;
  target: string;           // CSS selector for the element to spotlight
  title: string;
  body: string;
  position: "top" | "bottom" | "left" | "right";
  pulse?: boolean;          // show a pulsing ring on the target
  waitForEvent?: string;    // window event name — auto-advance when fired
  actionLabel?: string;     // label shown instead of "Next" when waiting for action
  skipable?: boolean;
}

const STEPS: TourStep[] = [
  {
    id: "welcome",
    target: "[data-tour='logo']",
    title: "Welcome to Ether 👋",
    body: "Professional broadcast automation — free, forever. This quick tour takes about 60 seconds. You can skip it anytime.",
    position: "bottom",
  },
  {
    id: "import",
    target: "[data-tour='nav-library']",
    title: "Start with your music",
    body: "Click Library to import your music folder. Ether reads MP3, FLAC, WAV, M4A and more — it'll scan everything automatically.",
    position: "bottom",
    pulse: true,
    waitForEvent: "ether:tour-library-opened",
    actionLabel: "Open Library →",
    skipable: true,
  },
  {
    id: "deck",
    target: "[data-tour='deck-a']",
    title: "Load a song to Deck A",
    body: "Drag any song here, or click the A button in the library. Deck A is your main player — it shows the waveform and countdown timer.",
    position: "right",
    pulse: true,
    waitForEvent: "ether:tour-deck-loaded",
    actionLabel: "Load a song →",
    skipable: true,
  },
  {
    id: "play",
    target: "[data-tour='deck-a']",
    title: "Press Space to play",
    body: "Hit the play button or press Space on your keyboard. The waveform animates and your countdown timer starts. That's your track on air.",
    position: "top",
    pulse: true,
    waitForEvent: "ether:tour-deck-playing",
    actionLabel: "Play Deck A →",
    skipable: true,
  },
  {
    id: "queue",
    target: "[data-tour='queue']",
    title: "Build your queue",
    body: "Drag songs here to line up what plays next. Ether crossfades automatically when a track ends — no dead air.",
    position: "left",
    pulse: false,
    skipable: true,
  },
  {
    id: "auto",
    target: "[data-tour='queue']",
    title: "Go fully automatic",
    body: "Toggle Auto ON in the queue panel to run 24/7 without touching anything. Ether fills the queue from your schedule and rotation rules.",
    position: "right",
    pulse: true,
    skipable: true,
  },
  {
    id: "onair",
    target: "[data-tour='onair-btn']",
    title: "You're ready to broadcast",
    body: "Hit ON AIR to start your stream. Right-click anywhere to change the theme. Press Shift+? to see all keyboard shortcuts.",
    position: "left",
    pulse: true,
    skipable: true,
  },
];

// ── Spotlight geometry ────────────────────────────────────────

interface Rect { top: number; left: number; width: number; height: number; }

function getTargetRect(selector: string): Rect | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

// ── Callout position ──────────────────────────────────────────

function calloutStyle(rect: Rect, position: TourStep["position"], boxW: number, boxH: number) {
  const PAD = 18;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let top = 0, left = 0;

  switch (position) {
    case "bottom":
      top = rect.top + rect.height + PAD;
      left = rect.left + rect.width / 2 - boxW / 2;
      break;
    case "top":
      top = rect.top - boxH - PAD;
      left = rect.left + rect.width / 2 - boxW / 2;
      break;
    case "right":
      top = rect.top + rect.height / 2 - boxH / 2;
      left = rect.left + rect.width + PAD;
      break;
    case "left":
      top = rect.top + rect.height / 2 - boxH / 2;
      left = rect.left - boxW - PAD;
      break;
  }

  // clamp to viewport
  left = Math.max(12, Math.min(left, vw - boxW - 12));
  top  = Math.max(12, Math.min(top,  vh - boxH - 12));

  return { top, left };
}

function arrowStyle(position: TourStep["position"]) {
  const base: React.CSSProperties = {
    position: "absolute",
    width: 0, height: 0,
    borderStyle: "solid",
  };
  switch (position) {
    case "bottom": return { ...base, top: -8, left: "50%", transform: "translateX(-50%)", borderWidth: "0 8px 8px 8px", borderColor: "transparent transparent var(--bg-elevated) transparent" };
    case "top":    return { ...base, bottom: -8, left: "50%", transform: "translateX(-50%)", borderWidth: "8px 8px 0 8px", borderColor: "var(--bg-elevated) transparent transparent transparent" };
    case "right":  return { ...base, top: "50%", left: -8, transform: "translateY(-50%)", borderWidth: "8px 8px 8px 0", borderColor: "transparent var(--bg-elevated) transparent transparent" };
    case "left":   return { ...base, top: "50%", right: -8, transform: "translateY(-50%)", borderWidth: "8px 0 8px 8px", borderColor: "transparent transparent transparent var(--bg-elevated)" };
  }
}

// ── Main component ────────────────────────────────────────────

interface Props {
  onDone: () => void;
}

export default function OnboardingTour({ onDone }: Props) {
  const [stepIdx, setStepIdx] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [waitingForAction, setWaitingForAction] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const { stationId } = useActiveStation();

  const step = STEPS[stepIdx];
  const isLast = stepIdx === STEPS.length - 1;
  const BOX_W = 320;
  const BOX_H = 180; // approximate

  // Track target element position (handles layout shifts)
  const updateRect = useCallback(() => {
    if (!step) return;
    const r = getTargetRect(step.target);
    setRect(r);
    rafRef.current = requestAnimationFrame(updateRect);
  }, [step]);

  useEffect(() => {
    rafRef.current = requestAnimationFrame(updateRect);
    return () => cancelAnimationFrame(rafRef.current);
  }, [updateRect]);

  // Fade in on mount and step change
  useEffect(() => {
    setVisible(false);
    const t = setTimeout(() => setVisible(true), 60);
    return () => clearTimeout(t);
  }, [stepIdx]);

  // Listen for action events to auto-advance
  useEffect(() => {
    if (!step?.waitForEvent) { setWaitingForAction(false); return; }
    setWaitingForAction(true);
    const handler = () => advance();
    window.addEventListener(step.waitForEvent, handler);
    return () => window.removeEventListener(step.waitForEvent!, handler);
  }, [stepIdx]);

  const advance = useCallback(() => {
    if (stepIdx < STEPS.length - 1) {
      setVisible(false);
      setTimeout(() => setStepIdx(i => i + 1), 200);
    } else {
      finish();
    }
  }, [stepIdx]);

  const back = () => {
    if (stepIdx > 0) {
      setVisible(false);
      setTimeout(() => setStepIdx(i => i - 1), 200);
    }
  };

  const finish = async () => {
    setExiting(true);
    setTimeout(async () => {
      if (stationId != null) {
        try {
          await (window as any).ether.stationConfigKv.upsertByKey(
            stationId, 'tour_done_version', TOUR_VERSION
          );
        } catch {}
      }
      onDone();
    }, 350);
  };

  if (!step) return null;

  const pos = rect ? calloutStyle(rect, step.position, BOX_W, BOX_H) : { top: "50%", left: "50%" };
  const SPOTLIGHT_PAD = 10;

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 99999,
      opacity: exiting ? 0 : 1,
      transition: "opacity 0.35s ease",
      pointerEvents: exiting ? "none" : "auto",
    }}>
      {/* ── SVG spotlight mask ── */}
      {rect && (
        <svg
          style={{ position: "fixed", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <mask id="spotlight-mask">
              <rect width="100%" height="100%" fill="white" />
              <rect
                x={rect.left - SPOTLIGHT_PAD}
                y={rect.top - SPOTLIGHT_PAD}
                width={rect.width + SPOTLIGHT_PAD * 2}
                height={rect.height + SPOTLIGHT_PAD * 2}
                rx={10}
                fill="black"
              />
            </mask>
          </defs>
          <rect
            width="100%" height="100%"
            fill="rgba(0,0,0,0.62)"
            mask="url(#spotlight-mask)"
          />
        </svg>
      )}

      {/* ── Fallback dim if no target found ── */}
      {!rect && (
        <div style={{
          position: "fixed", inset: 0,
          background: "rgba(0,0,0,0.62)",
          backdropFilter: "blur(2px)",
        }} />
      )}

      {/* ── Pulse ring on target ── */}
      {rect && step.pulse && (
        <div style={{
          position: "fixed",
          top: rect.top - SPOTLIGHT_PAD,
          left: rect.left - SPOTLIGHT_PAD,
          width: rect.width + SPOTLIGHT_PAD * 2,
          height: rect.height + SPOTLIGHT_PAD * 2,
          borderRadius: 0,
          boxShadow: "0 0 0 3px var(--accent-cyan)",
          animation: "tour-pulse 1.6s ease-in-out infinite",
          pointerEvents: "none",
        }} />
      )}

      {/* ── Callout box ── */}
      <div
        ref={boxRef}
        style={{
          position: "fixed",
          top: pos.top,
          left: pos.left,
          width: BOX_W,
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-secondary)",
          borderRadius: 0,
          padding: "20px 22px 16px",
          boxShadow: "0 24px 64px rgba(0,0,0,0.5), 0 4px 12px rgba(0,0,0,0.3)",
          fontFamily: "'Inter', system-ui, sans-serif",
          opacity: visible ? 1 : 0,
          transform: visible ? "translateY(0) scale(1)" : "translateY(6px) scale(0.97)",
          transition: "opacity 0.22s ease, transform 0.22s ease",
          zIndex: 100000,
        }}
      >
        {/* Arrow */}
        {rect && <div style={arrowStyle(step.position)} />}

        {/* Step counter */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ display: "flex", gap: 4 }}>
            {STEPS.map((_, i) => (
              <div key={i} style={{
                width: i === stepIdx ? 18 : 6,
                height: 6,
                borderRadius: 0,
                background: i === stepIdx ? "var(--accent-cyan)" : i < stepIdx ? "var(--accent-cyan)" : "var(--border-secondary)",
                transition: "all 0.3s ease",
                opacity: i < stepIdx ? 0.4 : 1,
              }} />
            ))}
          </div>
          <button
            onClick={finish}
            style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 11, padding: "2px 6px", borderRadius: 0, letterSpacing: "0.04em" }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)"}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"}
          >
            Skip tour
          </button>
        </div>

        {/* Content */}
        <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 15, fontWeight: 800, color: "var(--text-primary)", letterSpacing: "-0.02em", marginBottom: 7, lineHeight: 1.25 }}>
          {step.title}
        </div>
        <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.55, marginBottom: 18 }}>
          {step.body}
        </div>

        {/* Waiting for action hint */}
        {waitingForAction && step.waitForEvent && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12, padding: "6px 10px", background: "rgba(34,211,238,0.08)", border: "1px solid rgba(34,211,238,0.2)", borderRadius: 0 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent-cyan)", animation: "tour-pulse 1.2s ease-in-out infinite", flexShrink: 0 }} />
            <span style={{ fontSize: 11, color: "var(--accent-cyan)", fontWeight: 600 }}>
              Waiting for you to {step.actionLabel?.replace(" →", "").toLowerCase() || "complete this step"}...
            </span>
          </div>
        )}

        {/* Buttons */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {stepIdx > 0 && (
            <button
              onClick={back}
              style={{ height: 34, padding: "0 14px", borderRadius: 0, fontSize: 12, fontWeight: 600, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer" }}
            >
              ← Back
            </button>
          )}
          <button
            onClick={advance}
            style={{
              flex: 1, height: 34, borderRadius: 0, fontSize: 12, fontWeight: 700,
              background: isLast ? "var(--accent-green)" : "var(--accent-cyan)",
              border: "none", color: "#000", cursor: "pointer",
              letterSpacing: "0.02em",
              transition: "filter 0.15s",
            }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.filter = "brightness(1.1)"}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.filter = "brightness(1)"}
          >
            {isLast ? "Let's go! 🎙️" : (waitingForAction && step.actionLabel) ? step.actionLabel : "Next →"}
          </button>
        </div>
      </div>

      <style>{`
        @keyframes tour-pulse {
          0%, 100% { opacity: 1; box-shadow: 0 0 0 3px var(--accent-cyan); }
          50% { opacity: 0.7; box-shadow: 0 0 0 6px rgba(34,211,238,0.25); }
        }
      `}</style>
    </div>
  );
}

// ── Hook — checks if tour should show ────────────────────────

export function useTour() {
  const [showTour, setShowTour] = useState(false);
  const [checked, setChecked] = useState(false);
  const { stationId, isReady } = useActiveStation();

  useEffect(() => {
    if (!isReady || stationId == null) return;
    (async () => {
      try {
        const result = await (window as any).ether.stationConfigKv.list(stationId);
        const rows = result.ok ? result.rows : [];
        const donVersion = rows.find((r: { key: string }) => r.key === 'tour_done_version')?.value;
        if (donVersion !== TOUR_VERSION) setShowTour(true);
      } catch {
        setShowTour(true);
      }
      setChecked(true);
    })();
  }, [stationId, isReady]);

  const dismissTour = async () => {
    setShowTour(false);
    if (stationId != null) {
      try {
        await (window as any).ether.stationConfigKv.upsertByKey(
          stationId, 'tour_done_version', TOUR_VERSION
        );
      } catch {}
    }
  };

  return { showTour, checked, dismissTour };
}
