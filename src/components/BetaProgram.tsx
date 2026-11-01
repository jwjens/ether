// BetaProgram.tsx — beta program application form + feedback widget.
//
// Two functions:
//   1. Beta program enrollment — submit your station details to request
//      free Station-tier access in exchange for feedback + testimonial.
//   2. Ongoing feedback — send bug reports / feature requests to Ether.
//
// Delivery: HTTPS POST to the Ether backend (/beta/apply, /feedback — built
// 2026-11-01; before that both 404'd). "Received" shows ONLY when the server
// answered that it stored the row (src/lib/betaSubmit.ts). A failure shows its
// reason and keeps what was typed; "Email it instead" is a button the user
// presses, never automatic. The application is remembered as filed (localStorage)
// only after the server confirmed it.

import { useEffect, useState } from "react";
import { ETHER_BACKEND_URL, blockedByDevGuard } from "../lib/etherBackend";
import { submitForm, mailtoFor, type SubmitResult } from "../lib/betaSubmit";

/** The real app version for the report (was a hard-coded "1.0"). */
function useAppVersion(): string {
  const [v, setV] = useState("");
  useEffect(() => {
    try {
      (window as any).ether?.system?.getVersion?.().then((x: string) => setV(String(x || ""))).catch(() => {});
    } catch {}
  }, []);
  return v;
}

const DEV_RESULT: SubmitResult = { ok: false, kind: "dev", message: "This is a development build; it does not send to the Ether server. Not sent." };

const SUBMIT_URL   = `${ETHER_BACKEND_URL}/beta/apply`;
const FEEDBACK_URL = `${ETHER_BACKEND_URL}/feedback`;
const EMAIL_FALLBACK = "hello@ether-technologies.com";

interface BetaApp {
  station_name: string;
  station_type: string;   // "college" | "lpfm" | "internet" | "commercial" | "other"
  callsign: string;
  city: string;
  country: string;
  estimated_listeners: string;
  current_automation: string;  // what they're using today
  why_ether: string;
  contact_name: string;
  contact_email: string;
  phone: string;
  submitted_at: number;
}

export default function BetaProgram() {
  const ether = (window as any).ether;
  const [mode, setMode] = useState<"about" | "apply" | "feedback">("about");
  const [alreadyApplied, setAlreadyApplied] = useState(false);

  useEffect(() => {
    // Filed only if the server confirmed it (server_id). Before 2026-11-01 a failed send was also remembered as filed
    // (the routes didn't exist, so every one failed) — those entries carry no server_id and no longer count.
    try { if (JSON.parse(localStorage.getItem("ether_beta_applied") || "{}").server_id) setAlreadyApplied(true); } catch {}
  }, []);

  return (
    <div>
      {/* Mode tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 14, borderBottom: "1px solid var(--border-primary)" }}>
        {([
          { id: "about",    label: "About the Program" },
          { id: "apply",    label: alreadyApplied ? "✓ Applied" : "Apply" },
          { id: "feedback", label: "Send Feedback" },
        ] as const).map(t => (
          <button key={t.id} onClick={() => setMode(t.id as any)} style={{
            padding: "8px 14px", borderRadius: 0, fontSize: 12, fontWeight: 700,
            background: "transparent", color: mode === t.id ? "var(--accent-blue)" : "var(--text-secondary)",
            border: "none", borderBottom: mode === t.id ? "2px solid var(--accent-blue)" : "2px solid transparent",
            cursor: "pointer", marginBottom: -1,
          }}>{t.label}</button>
        ))}
      </div>

      {mode === "about" && <AboutTab />}
      {mode === "apply" && <ApplyTab onApplied={() => setAlreadyApplied(true)} alreadyApplied={alreadyApplied} />}
      {mode === "feedback" && <FeedbackTab />}
    </div>
  );
}

// ── About ──
function AboutTab() {
  return (
    <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.7 }}>
      <p style={{ margin: "0 0 12px" }}>
        Ether is actively seeking <b style={{ color: "var(--text-primary)" }}>3-5 beta partners</b> for launch. In exchange for free <b style={{ color: "var(--text-primary)" }}>Station-tier access forever</b>, we ask for:
      </p>
      <ul style={{ margin: "0 0 12px 20px", padding: 0 }}>
        <li style={{ marginBottom: 6 }}>Your honest feedback — bug reports, feature requests, rough edges</li>
        <li style={{ marginBottom: 6 }}>A 2-minute testimonial video (or quote) we can use on the website</li>
        <li style={{ marginBottom: 6 }}>Permission to list your station as an Ether user</li>
      </ul>
      <p style={{ margin: "0 0 12px" }}>
        We're especially interested in:
      </p>
      <ul style={{ margin: "0 0 12px 20px", padding: 0 }}>
        <li style={{ marginBottom: 6 }}><b>College stations</b> — Ether's teaching tool angle means students get the same workflow they'll see in commercial radio</li>
        <li style={{ marginBottom: 6 }}><b>LPFMs</b> — small, low-budget, scrappy; exactly who we built Ether for</li>
        <li style={{ marginBottom: 6 }}><b>Internet-only stations</b> — you're already comfortable running your own stack</li>
        <li style={{ marginBottom: 6 }}><b>Stations migrating from Zetta / GSelector / Wide Orbit</b> — you'll tell us what's missing fastest</li>
      </ul>
      <p style={{ margin: "0 0 12px" }}>Applications reviewed in order received. Usually a response within a week.</p>

      <div style={{ marginTop: 18, padding: "12px 14px", background: "rgb(from var(--accent-blue) r g b / 0.08)", border: "1px solid rgb(from var(--accent-blue) r g b / 0.25)", fontSize: 12, color: "var(--accent-blue)" }}>
        Ether is in active development. Things will break. You'll catch them. That's the whole point.
      </div>
    </div>
  );
}

// ── Apply ──
function ApplyTab({ onApplied, alreadyApplied }: { onApplied: () => void; alreadyApplied: boolean }) {
  const [form, setForm] = useState<BetaApp>({
    station_name: "", station_type: "college", callsign: "", city: "", country: "US",
    estimated_listeners: "", current_automation: "", why_ether: "",
    contact_name: "", contact_email: "", phone: "", submitted_at: 0,
  });
  const appVersion = useAppVersion();
  const [sending, setSending] = useState(false);
  const [result, setResult]   = useState<"ok" | null>(null);
  const [error, setError]     = useState("");
  const [canEmail, setCanEmail] = useState(false);

  const update = (k: keyof BetaApp, v: string) => setForm(f => ({ ...f, [k]: v }));

  const submit = async () => {
    if (!form.station_name.trim() || !form.contact_email.trim()) {
      setError("Station name and contact email are required"); return;
    }
    setSending(true); setError(""); setCanEmail(false);
    const payload = { ...form, app_version: appVersion, submitted_at: Date.now() };
    const res = blockedByDevGuard("beta application") ? DEV_RESULT : await submitForm(SUBMIT_URL, payload);
    if (res.ok) {
      setResult("ok");
      try { localStorage.setItem("ether_beta_applied", JSON.stringify({ ...payload, server_id: res.id ?? true })); } catch {}
      onApplied();
    } else {
      setError(res.message);
      setCanEmail(res.kind !== "invalid");
    }
    setSending(false);
  };

  const emailInstead = () => {
    const { submitted_at: _s, ...lines } = { ...form, app_version: appVersion };
    window.location.href = mailtoFor(EMAIL_FALLBACK, "Ether beta application: " + form.station_name, lines);
  };

  if (alreadyApplied && !result) {
    return (
      <div style={{ padding: 20, background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.3)" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#22c55e", marginBottom: 4 }}>✓ Application on file</div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          We've got your application. We'll be in touch soon. In the meantime — keep using Ether and send bug reports via the Feedback tab.
        </div>
      </div>
    );
  }

  if (result === "ok") {
    return (
      <div style={{ padding: 20, background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.3)" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#22c55e", marginBottom: 4 }}>✓ Application received</div>
        <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>We'll review and reply within a week. Thanks for being willing to partner up.</div>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="Station name*"><input value={form.station_name} onChange={e => update("station_name", e.target.value)} style={inputStyle} /></Field>
        <Field label="Station type">
          <select value={form.station_type} onChange={e => update("station_type", e.target.value)} style={inputStyle}>
            <option value="college">College / student station</option>
            <option value="lpfm">LPFM / community</option>
            <option value="internet">Internet-only</option>
            <option value="commercial">Commercial</option>
            <option value="other">Other</option>
          </select>
        </Field>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "120px 1fr 120px", gap: 10 }}>
        <Field label="Callsign"><input value={form.callsign} onChange={e => update("callsign", e.target.value)} style={inputStyle} /></Field>
        <Field label="City"><input value={form.city} onChange={e => update("city", e.target.value)} style={inputStyle} /></Field>
        <Field label="Country"><input value={form.country} onChange={e => update("country", e.target.value)} style={inputStyle} /></Field>
      </div>
      <Field label="Estimated concurrent listeners"><input value={form.estimated_listeners} onChange={e => update("estimated_listeners", e.target.value)} placeholder="e.g. 200" style={inputStyle} /></Field>
      <Field label="Current automation software">
        <input value={form.current_automation} onChange={e => update("current_automation", e.target.value)} placeholder="e.g. RCS Zetta, Wide Orbit, NexGen, SAM, nothing" style={inputStyle} />
      </Field>
      <Field label="Why Ether?">
        <textarea value={form.why_ether} onChange={e => update("why_ether", e.target.value)} rows={3}
          placeholder="What's broken about your current setup? What features matter most?"
          style={{ ...inputStyle, resize: "vertical" as any, fontFamily: "inherit" }} />
      </Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 140px", gap: 10, borderTop: "1px solid var(--border-primary)", paddingTop: 12 }}>
        <Field label="Your name"><input value={form.contact_name} onChange={e => update("contact_name", e.target.value)} style={inputStyle} /></Field>
        <Field label="Email*"><input type="email" value={form.contact_email} onChange={e => update("contact_email", e.target.value)} style={inputStyle} /></Field>
        <Field label="Phone (optional)"><input value={form.phone} onChange={e => update("phone", e.target.value)} style={inputStyle} /></Field>
      </div>

      {error && <div role="alert" style={{ padding: "8px 12px", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", color: "#ef4444", fontSize: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span>{error}</span>
        {canEmail && <button onClick={emailInstead} style={emailBtnStyle}>Email it instead</button>}
      </div>}

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button onClick={submit} disabled={sending} style={{
          padding: "10px 22px", borderRadius: 0, fontSize: 13, fontWeight: 700,
          background: sending ? "var(--bg-tertiary)" : "var(--accent-blue)",
          color: sending ? "var(--text-tertiary)" : "#fff",
          border: "none", cursor: sending ? "default" : "pointer",
        }}>{sending ? "Sending…" : "Submit application"}</button>
        <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Takes 30 seconds · We never share your info</span>
      </div>
    </div>
  );
}

// ── Feedback ──
function FeedbackTab() {
  const [category, setCategory] = useState<"bug" | "feature" | "praise" | "other">("bug");
  const [text, setText] = useState("");
  const [email, setEmail] = useState(() => {
    try { return JSON.parse(localStorage.getItem("ether_beta_applied") || "{}").contact_email || ""; } catch { return ""; }
  });
  const appVersion = useAppVersion();
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<"ok" | null>(null);
  const [failure, setFailure] = useState<SubmitResult | null>(null);

  const submit = async () => {
    if (!text.trim()) return;
    setSending(true); setFailure(null); setResult(null);
    const payload = { category, feedback: text, email, app_version: appVersion, submitted_at: Date.now() };
    const res = blockedByDevGuard("feedback") ? DEV_RESULT : await submitForm(FEEDBACK_URL, payload);
    if (res.ok) {
      setResult("ok");
      setText("");                       // cleared only once the server has it
      setTimeout(() => setResult(null), 6000);
    } else {
      setFailure(res);                   // what was typed stays in the box
    }
    setSending(false);
  };

  const emailInstead = () => {
    window.location.href = mailtoFor(EMAIL_FALLBACK, "Ether feedback: " + category,
      { category, feedback: text, from: email, app_version: appVersion });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 4 }}>
        {([
          { id: "bug",     label: "🐛 Bug" },
          { id: "feature", label: "✨ Feature request" },
          { id: "praise",  label: "🙏 Kudos" },
          { id: "other",   label: "Other" },
        ] as const).map(c => (
          <button key={c.id} onClick={() => setCategory(c.id as any)} style={{
            padding: "7px 14px", borderRadius: 0, fontSize: 12, fontWeight: 600,
            background: category === c.id ? "var(--accent-blue)" : "var(--bg-tertiary)",
            color:      category === c.id ? "#fff" : "var(--text-secondary)",
            border: category === c.id ? "none" : "1px solid var(--border-primary)",
            cursor: "pointer",
          }}>{c.label}</button>
        ))}
      </div>
      <Field label="Tell us">
        <textarea value={text} onChange={e => setText(e.target.value)} rows={6}
          placeholder={category === "bug" ? "What happened? What were you expecting?"
                     : category === "feature" ? "What would make Ether more useful to you?"
                     : category === "praise" ? "We'll take it."
                     : "Fire away."}
          style={{ ...inputStyle, resize: "vertical" as any, fontFamily: "inherit", lineHeight: 1.6 }} />
      </Field>
      <Field label="Your email (optional — lets us follow up)">
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} style={inputStyle} placeholder="you@yourstation.com" />
      </Field>

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button onClick={submit} disabled={sending || !text.trim()} style={{
          padding: "10px 22px", borderRadius: 0, fontSize: 13, fontWeight: 700,
          background: (sending || !text.trim()) ? "var(--bg-tertiary)" : "var(--accent-blue)",
          color:      (sending || !text.trim()) ? "var(--text-tertiary)" : "#fff",
          border: "none", cursor: (sending || !text.trim()) ? "default" : "pointer",
        }}>{sending ? "Sending…" : "Send feedback"}</button>
        {result === "ok"    && <span style={{ fontSize: 12, color: "#22c55e" }}>✓ Thanks — we got it</span>}
      </div>
      {failure && !failure.ok && (
        <div role="alert" style={{ padding: "8px 12px", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", color: "#ef4444", fontSize: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span>{failure.message}</span>
          {failure.kind !== "invalid" && <button onClick={emailInstead} style={emailBtnStyle}>Email it instead</button>}
        </div>
      )}
    </div>
  );
}

const emailBtnStyle: React.CSSProperties = {
  padding: "4px 10px", borderRadius: 0, fontSize: 11, fontWeight: 700, cursor: "pointer",
  background: "transparent", color: "var(--text-primary)", border: "1px solid var(--border-primary)",
};
const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 0, fontSize: 13,
  background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
  color: "var(--text-primary)", outline: "none", boxSizing: "border-box",
};
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", marginBottom: 4, letterSpacing: "0.04em", textTransform: "uppercase" as any }}>{label}</div>
      {children}
    </div>
  );
}
