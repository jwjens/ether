import { useState, useEffect } from "react";
import { query } from "../db/client";

interface User {
  id: number;
  name: string;
  role: string;
  pin: string | null;
}

export type UserRole = "admin" | "md" | "jock" | "traffic";

interface Props {
  onLogin: (user: User) => void;
}

const ROLE_COLORS: Record<string, string> = {
  admin: "#ef4444",
  md: "#8b5cf6",
  jock: "#3b82f6",
  traffic: "#22c55e",
};

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  md: "Music Director",
  jock: "Jock",
  traffic: "Traffic",
};

export default function UserLogin({ onLogin }: Props) {
  const [users, setUsers] = useState<User[]>([]);
  const [selected, setSelected] = useState<User | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    query<User>("SELECT * FROM users WHERE is_active = 1 ORDER BY role, name").then(setUsers);
  }, []);

  const handleSelect = (user: User) => {
    if (!user.pin) {
      onLogin(user);
      return;
    }
    setSelected(user);
    setPin("");
    setError("");
  };

  const handlePin = () => {
    if (!selected) return;
    if (pin === selected.pin) {
      onLogin(selected);
    } else {
      setError("Incorrect PIN");
      setPin("");
    }
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "#0a0a0a",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 9999
    }}>
      <div style={{ width: 420, padding: 32 }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ fontSize: 36, fontWeight: 300, letterSpacing: "-0.04em", marginBottom: 8 }}>
            <span style={{ color: "#60a5fa" }}>Eth</span><span style={{ color: "#fff" }}>er</span>
          </div>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.4)" }}>Select your profile to continue</div>
        </div>

        {!selected ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {users.map(user => (
              <button key={user.id} onClick={() => handleSelect(user)} style={{
                padding: "14px 20px", borderRadius: 12, border: "1px solid rgba(255,255,255,0.1)",
                background: "rgba(255,255,255,0.04)", cursor: "pointer",
                display: "flex", alignItems: "center", gap: 14, transition: "all 0.15s",
                textAlign: "left" as any,
              }}
              onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}
              onMouseLeave={e => (e.currentTarget.style.background = "rgba(255,255,255,0.04)")}
              >
                <div style={{
                  width: 40, height: 40, borderRadius: 20, flexShrink: 0,
                  background: ROLE_COLORS[user.role] || "#666",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 16, fontWeight: 700, color: "#fff"
                }}>
                  {user.name[0].toUpperCase()}
                </div>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 500, color: "#fff" }}>{user.name}</div>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>
                    {ROLE_LABELS[user.role] || user.role}
                    {user.pin ? " · PIN required" : " · No PIN"}
                  </div>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div style={{ textAlign: "center" }}>
            <div style={{
              width: 64, height: 64, borderRadius: 32, margin: "0 auto 16px",
              background: ROLE_COLORS[selected.role] || "#666",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 24, fontWeight: 700, color: "#fff"
            }}>
              {selected.name[0].toUpperCase()}
            </div>
            <div style={{ fontSize: 18, fontWeight: 500, color: "#fff", marginBottom: 4 }}>{selected.name}</div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginBottom: 24 }}>Enter your PIN</div>
            <input
              type="password"
              value={pin}
              onChange={e => setPin(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handlePin()}
              maxLength={8}
              autoFocus
              placeholder="••••"
              style={{
                width: "100%", padding: "12px 16px", borderRadius: 10, fontSize: 24,
                textAlign: "center" as any, letterSpacing: "0.3em",
                background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)",
                color: "#fff", outline: "none", marginBottom: 12
              }}
            />
            {error && <div style={{ color: "#ef4444", fontSize: 13, marginBottom: 12 }}>{error}</div>}
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setSelected(null)} style={{
                flex: 1, padding: "10px", borderRadius: 8, background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.6)", cursor: "pointer", fontSize: 13
              }}>Back</button>
              <button onClick={handlePin} style={{
                flex: 1, padding: "10px", borderRadius: 8, background: "#3b82f6",
                border: "none", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600
              }}>Enter</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
