import { useEffect, useRef, useState } from "react";

interface Props { onDone: () => void; }

const STATUS_LINES = [
  "Initializing audio engine...",
  "Loading music library...",
  "Starting broadcast clock...",
  "Connecting to database...",
  "Loading rotation rules...",
  "Starting stream monitor...",
  "Iris AI ready.",
  "Ready.",
];

const CHARS = "アイウエオカキクケコサシスセソタチツテトナニヌネノ01@#$%&";

// ── Matrix rain — strict column-drop algorithm ────────────────

function useMatrixRain(canvasRef: React.RefObject<HTMLCanvasElement>) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const FONT_SIZE    = 10;
    const LINE_HEIGHT  = 13;
    const TRAIL_LENGTH = 20;

    let cols: number;
    let drops: number[];

    const resize = () => {
      canvas.width  = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      cols  = Math.floor(canvas.width / FONT_SIZE);
      drops = Array.from({ length: cols }, () =>
        Math.floor(Math.random() * -(canvas.height / LINE_HEIGHT))
      );
    };
    resize();

    const draw = () => {
      // Dim previous frame to create trail persistence
      ctx.fillStyle = "rgba(8,8,15,0.18)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = `${FONT_SIZE}px 'DM Mono', monospace`;

      for (let i = 0; i < cols; i++) {
        const drop = drops[i];

        // Draw trail: j=0 is the leading (brightest) character
        for (let j = 0; j < TRAIL_LENGTH; j++) {
          const y = (drop - j) * LINE_HEIGHT;
          if (y < 0 || y > canvas.height) continue;

          const ch = CHARS[Math.floor(Math.random() * CHARS.length)];

          if (j === 0) {
            ctx.fillStyle = "#00ff41"; // bright matrix green leading char
          } else {
            const alpha = Math.max(0, (1 - j / TRAIL_LENGTH) * 0.85);
            ctx.fillStyle = `rgba(0,59,0,${alpha.toFixed(3)})`; // fade to dark green
          }
          ctx.fillText(ch, i * FONT_SIZE, y);
        }

        // Advance this column's drop
        drops[i]++;
        // Reset randomly when the drop scrolls off the bottom
        if (drops[i] * LINE_HEIGHT > canvas.height && Math.random() > 0.975) {
          drops[i] = Math.floor(Math.random() * -20);
        }
      }
    };

    const iv = setInterval(draw, 48); // ~20fps
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    return () => { clearInterval(iv); ro.disconnect(); };
  }, []);
}

// ── Component ─────────────────────────────────────────────────

export default function SplashScreen({ onDone }: Props) {
  const [lines, setLines]     = useState<string[]>([]);
  const [fadeOut, setFadeOut] = useState(false);
  const canvasRef             = useRef<HTMLCanvasElement>(null!);
  const scrollRef             = useRef<HTMLDivElement>(null);

  useMatrixRain(canvasRef);

  // When running inside Electron, the native splash.html handles the intro.
  // Auto-dismiss immediately so the React overlay never blocks the UI.
  useEffect(() => {
    if ((window as any).ether) {
      onDone();
      return;
    }

    // Browser / dev fallback — run the full animation
    let idx = 0;
    const iv = setInterval(() => {
      if (idx < STATUS_LINES.length) {
        setLines(prev => [...prev, STATUS_LINES[idx]]);
        idx++;
      } else {
        clearInterval(iv);
      }
    }, 600);
    const t = setTimeout(() => dismiss(), 15000);
    return () => { clearInterval(iv); clearTimeout(t); };
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  const dismiss = () => {
    if (fadeOut) return;
    setFadeOut(true);
    setTimeout(onDone, 380);
  };

  return (
    <div
      onClick={dismiss}
      style={{
        position:   "fixed",
        top:        0,
        left:       0,
        width:      "100vw",
        height:     "100vh",
        zIndex:     99999,
        background: "rgba(0,0,0,0.62)",
        opacity:    fadeOut ? 0 : 1,
        transition: "opacity 0.38s ease",
        fontFamily: "'Inter', system-ui, sans-serif",
        userSelect: "none",
        cursor:     "default",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          position:      "absolute",
          top:           "50%",
          left:          "50%",
          transform:     "translate(-50%, -50%)",
          width:         760,
          height:        440,
          borderRadius:  12,
          overflow:      "hidden",
          display:       "flex",
          flexDirection: "row",
          boxShadow: [
            "0 40px 100px rgba(0,0,0,0.85)",
            "0 0 40px rgba(0,255,65,0.15)",
            "0 0 0 1px rgba(0,255,65,0.4)",
          ].join(", "),
          animation: "sp-card 0.38s cubic-bezier(0.22,1,0.36,1) both",
        }}
      >

        {/* ── LEFT PANEL 42% — dark + matrix ── */}
        <div style={{
          width:      "42%",
          flexShrink: 0,
          position:   "relative",
          background: "#08080f",
          overflow:   "hidden",
          borderRadius: "12px 0 0 12px",
        }}>
          <canvas
            ref={canvasRef}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
          />
          <div style={{
            position:      "absolute",
            inset:         0,
            display:       "flex",
            flexDirection: "column",
            padding:       "32px 28px 24px",
            zIndex:        1,
          }}>
            <div style={{
              fontSize:      28,
              fontWeight:    900,
              letterSpacing: "0.1em",
              color:         "#ffffff",
              lineHeight:    1,
              marginBottom:  6,
              textShadow:    "0 0 20px rgba(0,255,65,0.8), 0 0 40px rgba(0,255,65,0.4)",
            }}>
              ETHER
            </div>
            <div style={{
              fontSize:      13,
              letterSpacing: "0.05em",
              color:         "#00ff41",
              textShadow:    "0 0 12px rgba(0,255,65,0.5)",
              marginBottom:  0,
            }}>
              Streaming Automation.
            </div>

            <div style={{ flex: 1 }} />

            <div
              ref={scrollRef}
              style={{
                height:         160,
                overflowY:      "hidden",
                display:        "flex",
                flexDirection:  "column",
                justifyContent: "flex-end",
                marginBottom:   16,
              }}
            >
              {lines.map((line, i) => (
                <div key={i} style={{
                  fontFamily: "'DM Mono', 'Courier New', monospace",
                  fontSize:   11,
                  color:      "#00ff41",
                  lineHeight: 1.7,
                  animation:  "sp-line 0.4s ease both",
                  flexShrink: 0,
                  textShadow: "0 0 8px rgba(0,255,65,0.4)",
                }}>
                  {line}
                </div>
              ))}
            </div>

            <div style={{
              fontSize:      9,
              color:         "rgba(0,255,65,0.3)",
              letterSpacing: "0.04em",
              fontFamily:    "'DM Mono', monospace",
            }}>
              © 2026 Ether Technologies
            </div>
          </div>
        </div>

        {/* ── RIGHT PANEL 58% — dark fill (native Electron splash handles artwork) ── */}
        <div style={{ flex: 1, position: "relative", overflow: "hidden", background: "#08080f" }}>
          {/* Blend left edge into dark panel */}
          <div style={{
            position:      "absolute",
            top: 0, left: 0,
            width:         40,
            height:        "100%",
            background:    "linear-gradient(to right, #08080f, transparent)",
            pointerEvents: "none",
          }} />
        </div>

      </div>

      <style>{`
        @keyframes sp-card {
          from { opacity:0; transform:translate(-50%,calc(-50% + 10px)) scale(0.97); }
          to   { opacity:1; transform:translate(-50%,-50%) scale(1); }
        }
        @keyframes sp-line {
          from { opacity:0; transform:translateY(4px); }
          to   { opacity:1; transform:translateY(0); }
        }
      `}</style>
    </div>
  );
}
