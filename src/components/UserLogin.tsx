import { useState, useEffect } from "react";
import etherLogoMark from "../assets/ether-atom.png";
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
  jock: "var(--accent-cyan)",
  music_director: "#a78bfa",
};

export default function UserLogin({ onLogin }: Props) {
  const [users, setUsers] = useState<AppUser[]>([]);
  // Profiles are scoped per-station (account ⊃ station ⊃ profile). Resolved from
  // the active station on mount; defaults to 1 until then.
  const [stationId, setStationId] = useState(1);
  const [selected, setSelected] = useState<AppUser | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [shake, setShake] = useState(false);

  // First-run setup. No users in the DB yet → instead of auto-creating a default admin,
  // let the first person name their profile (their title) and set a PIN (typed twice to
  // match). Roles/extra profiles are managed afterward in Preferences.
  const [loading, setLoading] = useState(true);
  const [setupMode, setSetupMode] = useState(false);
  const [setupName, setSetupName] = useState("Admin");
  const [setupPin, setSetupPin] = useState("");
  const [setupConfirm, setSetupConfirm] = useState("");
  const [setupErr, setSetupErr] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const active = await (window as any).ether?.stations?.getActive?.().catch(() => null);
        const sid = active?.id ?? 1;
        setStationId(sid);
        const rows = await query<AppUser>("SELECT * FROM users WHERE station_id = ? ORDER BY id", [sid]);
        if (rows.length > 0) setUsers(rows);
        else setSetupMode(true);
      } catch {} finally { setLoading(false); }
    })();
  }, []);

  // Verify whenever the PIN reaches 4 digits — from the numpad OR the physical keyboard.
  useEffect(() => {
    if (!selected || pin.length !== 4) return;
    let cancelled = false;
    const ether = (window as any).ether;
    const verify = ether?.users?.verifyPin
      ? ether.users.verifyPin(pin, selected.pin_hash)
      : Promise.resolve(pin === selected.pin_hash);
    verify.then((ok: boolean) => {
      if (cancelled) return;
      if (ok) onLogin(selected);
      else { setError("Incorrect PIN"); setShake(true); setPin(""); setTimeout(() => setShake(false), 500); }
    });
    return () => { cancelled = true; };
  }, [pin, selected]);

  // Physical keyboard support on the PIN screen: digits type the PIN, Backspace deletes,
  // Esc goes back to the profile list.
  useEffect(() => {
    if (!selected || !selected.pin_hash) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key >= "0" && e.key <= "9") { setError(""); setPin(p => (p.length >= 4 ? p : p + e.key)); e.preventDefault(); }
      else if (e.key === "Backspace") { setError(""); setPin(p => p.slice(0, -1)); e.preventDefault(); }
      else if (e.key === "Escape") { setSelected(null); setPin(""); setError(""); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  const createFirstUser = async () => {
    const name = setupName.trim() || "Admin";
    if (!/^\d{4}$/.test(setupPin)) { setSetupErr("PIN must be 4 digits."); return; }
    if (setupPin !== setupConfirm) { setSetupErr("PINs don’t match — try again."); return; }
    setCreating(true); setSetupErr("");
    try {
      const ether = (window as any).ether;
      let pinHash: string = setupPin;
      if (ether?.users?.hashPin) pinHash = await ether.users.hashPin(setupPin);
      await execute("INSERT INTO users (name, role, pin_hash, color, station_id) VALUES (?,?,?,?,?)", [name, "admin", pinHash, "#f87171", stationId]);
      const created = await query<AppUser>("SELECT * FROM users WHERE station_id = ? ORDER BY id DESC LIMIT 1", [stationId]);
      if (created.length > 0) { onLogin(created[0]); return; }
      setCreating(false); setSetupErr("Couldn’t create your profile. Please try again.");
    } catch {
      setCreating(false); setSetupErr("Couldn’t create your profile. Please try again.");
    }
  };

  const setupInput: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", padding: "11px 14px", borderRadius: 0,
    background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
    color: "#f0f0f8", fontSize: 14, outline: "none", marginBottom: 14,
    fontFamily: "'Inter', system-ui, sans-serif",
  };

  const selectUser = (user: AppUser) => {
    setSelected(user);
    setPin("");
    setError("");
    if (!user.pin_hash) onLogin(user);
  };

  const submitPin = async () => {
    if (!selected) return;
    const ether = (window as any).ether;
    let ok = false;
    if (ether?.users?.verifyPin) {
      ok = await ether.users.verifyPin(pin, selected.pin_hash);
    } else {
      // Fallback for legacy / no preload bridge
      ok = pin === selected.pin_hash;
    }
    if (ok) {
      onLogin(selected);
    } else {
      setError("Incorrect PIN");
      setShake(true);
      setPin("");
      setTimeout(() => setShake(false), 500);
    }
  };

  const accentColor = selected ? selected.color : "var(--accent-cyan)";

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
        <img src={etherLogoMark} width={72} height={72} alt="" style={{ borderRadius: 0 }} />
        <div style={{ fontFamily: "'Newsreader', Georgia, serif", fontSize: 28, fontWeight: 800, letterSpacing: "-0.04em", color: "#f0f0f8" }}>ETHER</div>
        <div style={{ fontSize: 9, letterSpacing: "0.24em", color: "var(--accent-cyan)", textTransform: "uppercase" as const }}>Technologies</div>
      </div>

      {loading ? (
        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.35)", letterSpacing: "0.08em" }}>Loading…</div>
      ) : setupMode ? (
        /* First-run profile setup — name + PIN (twice) */
        <div style={{ width: "100%", maxWidth: 360 }}>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.35)", letterSpacing: "0.08em", textTransform: "uppercase" as const, marginBottom: 8, textAlign: "center" as const }}>
            Set up your profile
          </div>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", textAlign: "center" as const, marginBottom: 24, lineHeight: 1.5 }}>
            Name your profile and choose a 4-digit PIN. You can add more profiles later in Preferences.
          </div>

          <label style={{ display: "block", fontSize: 11, color: "rgba(255,255,255,0.4)", marginBottom: 6, letterSpacing: "0.06em", textTransform: "uppercase" as const }}>Profile title</label>
          <input value={setupName} onChange={e => setSetupName(e.target.value)} placeholder="Admin" style={setupInput} />

          <label style={{ display: "block", fontSize: 11, color: "rgba(255,255,255,0.4)", marginBottom: 6, letterSpacing: "0.06em", textTransform: "uppercase" as const }}>PIN (4 digits)</label>
          <input value={setupPin} onChange={e => { setSetupPin(e.target.value.replace(/\D/g, "").slice(0, 4)); setSetupErr(""); }} type="password" inputMode="numeric" placeholder="••••" style={{ ...setupInput, letterSpacing: "0.3em", fontFamily: "'DM Mono', monospace" }} />

          <label style={{ display: "block", fontSize: 11, color: "rgba(255,255,255,0.4)", marginBottom: 6, letterSpacing: "0.06em", textTransform: "uppercase" as const }}>Confirm PIN</label>
          <input value={setupConfirm} onChange={e => { setSetupConfirm(e.target.value.replace(/\D/g, "").slice(0, 4)); setSetupErr(""); }} onKeyDown={e => { if (e.key === "Enter") createFirstUser(); }} type="password" inputMode="numeric" placeholder="••••" style={{ ...setupInput, letterSpacing: "0.3em", fontFamily: "'DM Mono', monospace" }} />

          {setupErr && <div style={{ fontSize: 12, color: "#f87171", marginBottom: 12 }}>{setupErr}</div>}

          <button onClick={createFirstUser} disabled={creating} style={{ width: "100%", padding: "12px 0", borderRadius: 0, background: "var(--accent-cyan)", color: "#000", border: "none", fontSize: 14, fontWeight: 700, cursor: creating ? "default" : "pointer", fontFamily: "'Newsreader', Georgia, serif", letterSpacing: "0.02em", opacity: creating ? 0.7 : 1 }}>
            {creating ? "Creating…" : "Create profile & continue"}
          </button>
        </div>
      ) : !selected ? (
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
                  padding: "16px 20px", borderRadius: 0,
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
                {/* Role color accent */}
                <div style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: ROLE_COLORS[user.role] }} />

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
            <div style={{ fontFamily: "'Newsreader', Georgia, serif", fontSize: 26, fontWeight: 800, letterSpacing: "-0.03em", color: "#f0f0f8" }}>{selected.name}</div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginTop: 6 }}>Enter your PIN to continue</div>
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
                setError("");
                setPin(p => (p.length >= 4 ? p : p + k));
              }} style={{
                height: 52, borderRadius: 0,
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
            width: "100%", padding: "10px 0", borderRadius: 0,
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
