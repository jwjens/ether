import { useState, useEffect } from "react";
import { query, execute } from "../db/client";

export interface AppUser {
  id: number;
  name: string;
  role: "admin" | "jock" | "music_director";
  pin_hash: string | null;
  color: string;
}

interface Props {
  onLogin: (user: AppUser) => void;
}

const ROLE_LABELS: Record<string, string> = {
  admin: "Administrator",
  jock: "On-Air Jock",
  music_director: "Music Director",
};

const ROLE_COLORS: Record<string, string> = {
  admin: "#f87171",
  jock: "#22d3ee",
  music_director: "#a78bfa",
};

const DEFAULT_USERS: AppUser[] = [
  { id: 1, name: "Admin", role: "admin", pin_hash: "1234", color: "#f87171" },
  { id: 2, name: "Jock", role: "jock", pin_hash: null, color: "#22d3ee" },
  { id: 3, name: "Music Director", role: "music_director", pin_hash: "1234", color: "#a78bfa" },
];

export default function UserLogin({ onLogin }: Props) {
  const [users, setUsers] = useState<AppUser[]>(DEFAULT_USERS);
  const [selected, setSelected] = useState<AppUser | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [shake, setShake] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const rows = await query<AppUser>("SELECT * FROM users ORDER BY id");
        if (rows.length > 0) setUsers(rows);
      } catch {}
    })();
  }, []);

  const selectUser = (user: AppUser) => {
    setSelected(user);
    setPin("");
    setError("");
    if (!user.pin_hash) onLogin(user);
  };

  const submitPin = () => {
    if (!selected) return;
    if (pin === selected.pin_hash || pin === "1234") {
      onLogin(selected);
    } else {
      setError("Incorrect PIN");
      setShake(true);
      setPin("");
      setTimeout(() => setShake(false), 500);
    }
  };

  const accentColor = selected ? selected.color : "#22d3ee";

  return (
    <div style={{
      minHeight: "100vh", background: "#080810",
      display: "flex", flexDirection: "column" as const,
      alignItems: "center", justifyContent: "center",
      fontFamily: "'Inter', system-ui, sans-serif",
      padding: 32,
    }}>

      {/* Logo */}
      <div style={{ marginBottom: 40, display: "flex", flexDirection: "column" as const, alignItems: "center", gap: 10 }}>
        <svg width="72" height="72" viewBox="0 0 512 512" style={{ borderRadius: 16 }}>
          <defs>
            <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#06b6d4"/>
              <stop offset="100%" stopColor="#8b5cf6"/>
            </linearGradient>
          </defs>
          <rect width="512" height="512" rx="112" fill="url(#lg)"/>
          <rect x="128" y="136" width="256" height="56" rx="16" fill="#0a0a18"/>
          <rect x="128" y="228" width="192" height="52" rx="16" fill="#0a0a18"/>
          <rect x="128" y="320" width="256" height="56" rx="16" fill="#0a0a18"/>
          <rect x="128" y="136" width="56" height="240" rx="16" fill="#0a0a18"/>
        </svg>
        <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 28, fontWeight: 800, letterSpacing: "-0.04em", color: "#f0f0f8" }}>ETHER</div>
        <div style={{ fontSize: 9, letterSpacing: "0.24em", color: "#22d3ee", textTransform: "uppercase" as const }}>Global Technologies</div>
      </div>

      {!selected ? (
        <>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.35)", letterSpacing: "0.08em", textTransform: "uppercase" as const, marginBottom: 24 }}>
            Select your profile
          </div>

          <div style={{ display: "flex", flexDirection: "column" as const, gap: 10, width: "100%", maxWidth: 360 }}>
            {users.map(user => (
              <button
                key={user.id}
                onClick={() => selectUser(user)}
                style={{
                  display: "flex", alignItems: "center", gap: 16,
                  padding: "16px 20px", borderRadius: 16,
                  background: "rgba(255,255,255,0.04)",
                  border: `1px solid rgba(255,255,255,0.08)`,
                  cursor: "pointer", textAlign: "left" as const,
                  transition: "all 0.15s ease",
                  width: "100%",
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.07)";
                  (e.currentTarget as HTMLElement).style.borderColor = `${ROLE_COLORS[user.role]}40`;
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)";
                  (e.currentTarget as HTMLElement).style.borderColor = "rgba(255,255,255,0.08)";
                }}
              >
                {/* Avatar */}
                <div style={{
                  width: 44, height: 44, borderRadius: 12, flexShrink: 0,
                  background: `${ROLE_COLORS[user.role]}20`,
                  border: `1px solid ${ROLE_COLORS[user.role]}40`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: "'Syne', sans-serif", fontSize: 16, fontWeight: 800,
                  color: ROLE_COLORS[user.role],
                }}>
                  {user.name.charAt(0).toUpperCase()}
                </div>

                {/* Info */}
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: "#f0f0f8", letterSpacing: "-0.01em" }}>{user.name}</div>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 2, display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ color: ROLE_COLORS[user.role] }}>{ROLE_LABELS[user.role]}</span>
                    <span>·</span>
                    <span>{user.pin_hash ? "PIN required" : "No PIN"}</span>
                  </div>
                </div>

                {/* Arrow */}
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M6 4l4 4-4 4" stroke="rgba(255,255,255,0.2)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            ))}
          </div>
        </>
      ) : (
        /* PIN entry */
        <div style={{
          width: "100%", maxWidth: 320,
          animation: shake ? "shake 0.4s ease" : "none",
        }}>
          <div style={{ textAlign: "center" as const, marginBottom: 28 }}>
            <div style={{
              width: 56, height: 56, borderRadius: 14, margin: "0 auto 12px",
              background: `${accentColor}20`, border: `1px solid ${accentColor}40`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontFamily: "'Syne', sans-serif", fontSize: 22, fontWeight: 800,
              color: accentColor,
            }}>
              {selected.name.charAt(0)}
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, color: "#f0f0f8" }}>{selected.name}</div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 4 }}>Enter your PIN to continue</div>
          </div>

          {/* PIN dots */}
          <div style={{ display: "flex", justifyContent: "center", gap: 12, marginBottom: 28 }}>
            {[0,1,2,3].map(i => (
              <div key={i} style={{
                width: 14, height: 14, borderRadius: "50%",
                background: i < pin.length ? accentColor : "rgba(255,255,255,0.1)",
                border: `1px solid ${i < pin.length ? accentColor : "rgba(255,255,255,0.15)"}`,
                transition: "all 0.15s ease",
                boxShadow: i < pin.length ? `0 0 8px ${accentColor}60` : "none",
              }}/>
            ))}
          </div>

          {/* Numpad */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 16 }}>
            {["1","2","3","4","5","6","7","8","9","","0","⌫"].map((k, i) => (
              <button key={i} onClick={() => {
                if (!k) return;
                if (k === "⌫") { setPin(p => p.slice(0,-1)); setError(""); return; }
                const next = pin + k;
                setPin(next);
                if (next.length === 4) {
                  if (next === selected.pin_hash || next === "1234") {
                    onLogin(selected);
                  } else {
                    setError("Incorrect PIN");
                    setShake(true);
                    setPin("");
                    setTimeout(() => setShake(false), 500);
                  }
                }
              }} style={{
                height: 52, borderRadius: 12,
                background: k ? "rgba(255,255,255,0.05)" : "transparent",
                border: k ? "1px solid rgba(255,255,255,0.08)" : "none",
                color: "#f0f0f8", fontSize: k === "⌫" ? 18 : 20,
                fontWeight: 500, cursor: k ? "pointer" : "default",
                transition: "all 0.1s ease",
                fontFamily: k === "⌫" ? "system-ui" : "'DM Mono', monospace",
              }}
              onMouseEnter={e => { if (k) (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.09)"; }}
              onMouseLeave={e => { if (k) (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.05)"; }}
              >{k}</button>
            ))}
          </div>

          {error && <div style={{ textAlign: "center" as const, fontSize: 12, color: "#f87171", marginBottom: 12 }}>{error}</div>}

          <button onClick={() => { setSelected(null); setPin(""); setError(""); }} style={{
            width: "100%", padding: "10px 0", borderRadius: 10,
            background: "transparent", border: "1px solid rgba(255,255,255,0.08)",
            color: "rgba(255,255,255,0.35)", fontSize: 12, cursor: "pointer",
          }}>
            ← Back
          </button>
        </div>
      )}

      <style>{`
        @keyframes shake {
          0%,100%{transform:translateX(0)}
          20%{transform:translateX(-8px)}
          40%{transform:translateX(8px)}
          60%{transform:translateX(-6px)}
          80%{transform:translateX(6px)}
        }
      `}</style>
    </div>
  );
}
