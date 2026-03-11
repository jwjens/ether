import { useState, useEffect } from "react";

interface Props {
  onDone: () => void;
}

export default function SplashScreen({ onDone }: Props) {
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Initializing...");

  useEffect(() => {
    const steps = [
      { pct: 15, msg: "Loading database..." },
      { pct: 35, msg: "Checking audio devices..." },
      { pct: 55, msg: "Loading library..." },
      { pct: 75, msg: "Starting audio engine..." },
      { pct: 90, msg: "Preparing interface..." },
      { pct: 100, msg: "Ready" },
    ];

    let i = 0;
    const timer = setInterval(() => {
      if (i < steps.length) {
        setProgress(steps[i].pct);
        setStatus(steps[i].msg);
        i++;
      } else {
        clearInterval(timer);
        setTimeout(onDone, 400);
      }
    }, 350);

    return () => clearInterval(timer);
  }, []);

  return (
    <div style={{
      position: "fixed",
      inset: 0,
      zIndex: 99999,
      background: "#09090b",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    }}>
      {/* Logo */}
      <div style={{ marginBottom: 32 }}>
        <div style={{
          width: 80,
          height: 80,
          borderRadius: 20,
          background: "linear-gradient(135deg, #2563eb 0%, #7c3aed 100%)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 20px 40px rgba(37, 99, 235, 0.3)",
          marginBottom: 20,
          marginLeft: "auto",
          marginRight: "auto",
        }}>
          <span style={{ fontSize: 36, fontWeight: 300, color: "#fff", letterSpacing: "-0.03em" }}>E</span>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 28, fontWeight: 300, color: "#fff", letterSpacing: "-0.03em" }}>
            <span style={{ color: "#2563eb" }}>Eth</span>er
          </div>
          <div style={{ fontSize: 11, fontWeight: 300, color: "rgba(255,255,255,0.3)", letterSpacing: "0.15em", textTransform: "uppercase" as const, marginTop: 4 }}>
            Broadcast Automation
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ width: 240 }}>
        <div style={{
          height: 2,
          background: "rgba(255,255,255,0.08)",
          borderRadius: 1,
          overflow: "hidden",
        }}>
          <div style={{
            height: "100%",
            width: progress + "%",
            background: "linear-gradient(90deg, #2563eb, #7c3aed)",
            borderRadius: 1,
            transition: "width 0.3s ease",
          }} />
        </div>
        <div style={{
          fontSize: 10,
          fontWeight: 300,
          color: "rgba(255,255,255,0.25)",
          textAlign: "center" as const,
          marginTop: 8,
          letterSpacing: "0.02em",
        }}>
          {status}
        </div>
      </div>

      {/* Version */}
      <div style={{
        position: "absolute",
        bottom: 24,
        fontSize: 10,
        fontWeight: 300,
        color: "rgba(255,255,255,0.15)",
        letterSpacing: "0.04em",
      }}>
        v1.7 — Free forever
      </div>
    </div>
  );
}
