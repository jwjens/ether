/**
 * StationManager.tsx — Manage Stations panel (operator tier).
 * Opened via "Manage Stations..." in the header switcher dropdown.
 * Uses ether.stations.* IPC (never raw SQL) so the safety gate is respected.
 */

import { useState, useEffect, useCallback } from "react";
import { query } from "../db/client";
import { PublicPageEditor } from "./SettingsPanel";
import { useActiveStation } from "../hooks/useActiveStation";
import { ETHER_BACKEND_URL } from "../lib/etherBackend";

// Session-cached user token (from email/password login) so the operator only authenticates
// once per session to manage the account hub.
let hubToken: string | null = null;

// Account hub editor (top of the Station Manager): the cluster's display name + handle.
// Account-level, so it authenticates as the signed-in user (email from KV + password).
function HubEditor({ stationId }: { stationId: number }) {
  const ether = (window as any).ether;
  const [email, setEmail]   = useState("");
  const [name, setName]     = useState("");
  const [slug, setSlug]     = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [savedSlug, setSavedSlug] = useState<string | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [avail, setAvail]   = useState<"idle" | "checking" | "ok" | "taken" | "invalid">("idle");
  const [msg, setMsg]       = useState("");
  const [busy, setBusy]     = useState(false);

  const loadCurrent = async () => {
    if (!hubToken) return;
    try {
      const r = await fetch(`${ETHER_BACKEND_URL}/api/user/account-slug`, { headers: { Authorization: `Bearer ${hubToken}` } });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setSavedSlug(d.slug || null); setSavedName(d.name || null); if (d.slug) { setSlug(d.slug); setSlugTouched(true); } if (d.name) setName(d.name); }
    } catch { /* ignore */ }
  };

  useEffect(() => {
    (async () => {
      try {
        const rows = await ether.stationConfigKv.list(stationId);
        const em = (Array.isArray(rows) ? rows : []).find((r: { key: string }) => r.key === "license_email")?.value;
        if (em) setEmail(em);
      } catch { /* ignore */ }
      if (hubToken) loadCurrent();
    })();
  }, [stationId]);

  // Auto-suggest the handle from the name until the operator edits the handle directly.
  useEffect(() => {
    if (slugTouched) return;
    setSlug(name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""));
  }, [name, slugTouched]);

  // Live availability (public endpoint, no auth).
  useEffect(() => {
    const s = slug.trim();
    if (!s || s === savedSlug) { setAvail("idle"); return; }
    setAvail("checking");
    const t = setTimeout(async () => {
      try { const r = await fetch(`${ETHER_BACKEND_URL}/public/account/check-slug?slug=${encodeURIComponent(s)}`); const d = await r.json(); setAvail(!d.valid ? "invalid" : d.available ? "ok" : "taken"); }
      catch { setAvail("idle"); }
    }, 350);
    return () => clearTimeout(t);
  }, [slug, savedSlug]);

  const ensureToken = async (): Promise<string | null> => {
    if (hubToken) return hubToken;
    if (!email) { setMsg("No account email found — sign in again."); return null; }
    if (!password) { setMsg("Enter your account password to save."); return null; }
    try {
      const r = await fetch(`${ETHER_BACKEND_URL}/api/user/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.token) { setMsg(d.error === "invalid_credentials" ? "Wrong password." : "Could not sign in."); return null; }
      hubToken = d.token; setPassword(""); await loadCurrent(); return hubToken;
    } catch { setMsg("Could not reach the server."); return null; }
  };

  const save = async () => {
    setBusy(true); setMsg("");
    const tok = await ensureToken();
    if (!tok) { setBusy(false); return; }
    try {
      const r = await fetch(`${ETHER_BACKEND_URL}/api/user/account-slug`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` }, body: JSON.stringify({ slug: slug.trim(), name: name.trim() }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setSavedSlug(d.slug || null); setSavedName(name.trim() || null); setMsg("✓ Saved"); }
      else if (r.status === 429) setMsg(`You can change the handle again in ${d.days_remaining ?? 30} day(s).`);
      else if (d.error === "taken") setMsg("That handle is taken.");
      else if (d.error === "invalid_format" || d.error === "reserved") setMsg("Use 3–32 lowercase letters, numbers, or hyphens.");
      else if (r.status === 401) { hubToken = null; setMsg("Session expired — enter your password again."); }
      else setMsg("Could not save.");
    } catch { setMsg("Could not save."); }
    setBusy(false);
  };

  const dirty = slug.trim() !== (savedSlug ?? "") || name.trim() !== (savedName ?? "");
  const inp: React.CSSProperties = { padding: "6px 10px", borderRadius: 0, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
      <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase" }}>Hub</span>
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Hub name (e.g. Dj Deniro)" style={{ ...inp, width: 200 }} />
      <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "monospace" }}>listen.ether-technologies.com/@</span>
      <input value={slug} onChange={e => { setSlugTouched(true); setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "")); }} placeholder="handle" spellCheck={false} style={{ ...inp, width: 140, fontFamily: "monospace" }} />
      {!hubToken && <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="account password" style={{ ...inp, width: 150 }} />}
      <button onClick={save} disabled={busy || !slug.trim() || !dirty || avail === "taken" || avail === "invalid"}
        style={{ padding: "6px 14px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: (!busy && dirty && slug.trim() && avail !== "taken" && avail !== "invalid") ? "var(--accent-blue)" : "var(--bg-tertiary)", color: "#fff", border: "none", cursor: "pointer" }}>
        {busy ? "Saving…" : "Save"}
      </button>
      <span style={{ fontSize: 11, color: avail === "ok" ? "#22c55e" : avail === "taken" || avail === "invalid" ? "#f87171" : "var(--text-tertiary)" }}>
        {avail === "checking" ? "Checking…" : avail === "ok" ? "✓ available" : avail === "taken" ? "taken" : avail === "invalid" ? "invalid" : ""}
        {msg && <span style={{ marginLeft: 8, color: msg.startsWith("✓") ? "#22c55e" : "#f87171" }}>{msg}</span>}
      </span>
    </div>
  );
}

interface Station {
  id:                 number;
  uuid?:              string;
  name:               string;
  callsign?:          string;
  frequency?:         string;
  city?:              string;
  state?:             string;
  icecast_server_url?: string;
  icecast_mount?:      string;
  icecast_password?:   string;
  icecast_bitrate?:    number;
  icecast_format?:     string;
  is_active:          number;
  created_at:         number;
}

interface StationStats {
  song_count:  number;
  clock_count: number;
}

interface Props {
  onStationSwitch?: (id: number, name: string) => void;
}

function fmtDate(epoch: number) {
  if (!epoch) return "—";
  return new Date(epoch * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ─── Station row ──────────────────────────────────────────────

function StationRow({
  station, active, stats, onEdit, onDelete,
}: {
  station:  Station;
  active:   boolean;
  stats:    StationStats;
  onEdit:   (s: Station) => void;
  onDelete: (id: number) => void;
}) {
  const isActive = active;
  const [expanded, setExpanded] = useState(false);
  const [pub, setPub] = useState<{ enabled: boolean; slug: string } | null>(null);

  // Per-row published status (so each station shows its own state — not just the active one).
  useEffect(() => {
    if (!station.uuid) return;
    let cancelled = false;
    (async () => {
      const r = await (window as any).ether?.station?.metadata?.get(station.uuid);
      if (!cancelled && r?.ok) setPub({ enabled: !!r.metadata?.public_enabled, slug: r.metadata?.slug || "" });
    })();
    return () => { cancelled = true; };
  }, [station.uuid, expanded]); // re-read after the panel closes (post-edit)
  const published = !!pub?.enabled && !!pub?.slug;

  return (
    <>
    <tr style={{ borderBottom: expanded ? "none" : "1px solid var(--border-primary)" }}>
      <td style={{ padding: "10px 14px", verticalAlign: "middle" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {isActive && (
            <span style={{
              fontSize: 8, fontWeight: 900, color: "#22c55e",
              letterSpacing: "0.06em", padding: "1px 5px",
              border: "1px solid rgba(34,197,94,0.3)",
              background: "rgba(34,197,94,0.1)", flexShrink: 0,
            }}>●</span>
          )}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>{station.name}</div>
              {published && (
                <span style={{ fontSize: 8, fontWeight: 900, letterSpacing: "0.08em", color: "#22c55e", padding: "1px 6px", border: "1px solid rgba(34,197,94,0.35)", background: "rgba(34,197,94,0.12)", whiteSpace: "nowrap" }}>● PUBLISHED</span>
              )}
            </div>
            {(station.callsign || station.frequency) && (
              <div style={{ fontSize: 10, color: "var(--text-tertiary)", fontFamily: "monospace", marginTop: 1 }}>
                {[station.callsign, station.frequency, station.city].filter(Boolean).join(" · ")}
              </div>
            )}
          </div>
        </div>
      </td>
      <td style={{ padding: "10px 14px", verticalAlign: "middle", fontSize: 12, color: "var(--text-tertiary)", whiteSpace: "nowrap" }}>
        {fmtDate(station.created_at)}
      </td>
      <td style={{ padding: "10px 14px", verticalAlign: "middle", fontSize: 12, color: "var(--text-tertiary)" }}>
        {stats.song_count} songs · {stats.clock_count} clocks
      </td>
      <td style={{ padding: "10px 14px", verticalAlign: "middle" }}>
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          <button
            onClick={() => setExpanded(e => !e)}
            disabled={!station.uuid}
            title={station.uuid ? "Publish / edit this station's public listener page" : "Station not synced yet"}
            style={{ ...actionBtn, ...(expanded ? { borderColor: "var(--accent-cyan)", color: "var(--accent-cyan)" } : {}), opacity: station.uuid ? 1 : 0.35, cursor: station.uuid ? "pointer" : "not-allowed" }}
          >{expanded ? "Close" : "Publish"}</button>
          <button onClick={() => onEdit(station)} style={actionBtn}>Rename</button>
          <button
            title="Duplicate station — coming soon"
            disabled
            style={{ ...actionBtn, opacity: 0.35, cursor: "not-allowed" }}
          >Duplicate</button>
          <button
            onClick={() => onDelete(station.id)}
            disabled={isActive}
            title={isActive ? "Cannot delete the active station" : `Delete ${station.name}`}
            style={{
              ...actionBtn,
              color: isActive ? "var(--text-tertiary)" : "#f87171",
              opacity: isActive ? 0.35 : 1,
              cursor: isActive ? "not-allowed" : "pointer",
            }}
          >Delete</button>
        </div>
      </td>
    </tr>
    {expanded && station.uuid && (
      <tr style={{ borderBottom: "1px solid var(--border-primary)" }}>
        <td colSpan={4} style={{ padding: "4px 16px 18px", background: "var(--bg-tertiary)" }}>
          <PublicPageEditor stationUuid={station.uuid} stationName={station.name} />
        </td>
      </tr>
    )}
    </>
  );
}

// ─── Editor modal ─────────────────────────────────────────────

function StationEditor({
  station, onSave, onClose,
}: {
  station: Partial<Station> | null;
  onSave:  (data: Partial<Station>) => Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm]   = useState<Partial<Station>>(station || {
    name: "", callsign: "", frequency: "", city: "",
    icecast_server_url: "", icecast_mount: "/live",
    icecast_password: "", icecast_bitrate: 128, icecast_format: "mp3",
  });
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState<string | null>(null);

  const set = <K extends keyof Station>(k: K, v: Station[K]) => setForm(p => ({ ...p, [k]: v }));

  const save = async () => {
    if (!form.name?.trim()) { setError("Name is required"); return; }
    setSaving(true);
    setError(null);
    try {
      await onSave(form);
    } catch (e: any) {
      setError(e?.message || "Failed to save");
      setSaving(false);
    }
  };

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      <div style={{ width: 480, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", overflow: "hidden", boxShadow: "0 30px 80px rgba(0,0,0,0.5)" }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border-primary)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>
            {station?.id ? `Edit — ${station.name}` : "New Station"}
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 18 }}>×</button>
        </div>

        <div style={{ padding: 20 }}>
          {error && (
            <div style={{ marginBottom: 14, padding: "9px 12px", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", color: "#f87171", fontSize: 12 }}>{error}</div>
          )}

          <EF label="Station Name *">
            <input autoFocus value={form.name || ""} onChange={e => set("name", e.target.value)}
              onKeyDown={e => e.key === "Enter" && save()}
              placeholder="KETH Radio" style={inp} />
          </EF>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <EF label="Callsign"><input value={form.callsign || ""} onChange={e => set("callsign", e.target.value)} placeholder="KETH" style={inp} /></EF>
            <EF label="Frequency"><input value={form.frequency || ""} onChange={e => set("frequency", e.target.value)} placeholder="98.7 FM" style={inp} /></EF>
          </div>
          <EF label="City"><input value={form.city || ""} onChange={e => set("city", e.target.value)} placeholder="Las Vegas" style={inp} /></EF>

          <div style={{ borderTop: "1px solid var(--border-primary)", margin: "14px 0 12px", paddingTop: 4 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", marginBottom: 8 }}>ICECAST</div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <EF label="Server URL"><input value={form.icecast_server_url || ""} onChange={e => set("icecast_server_url", e.target.value)} placeholder="127.0.0.1" style={inp} /></EF>
            <EF label="Mount"><input value={form.icecast_mount || ""} onChange={e => set("icecast_mount", e.target.value)} placeholder="/live" style={inp} /></EF>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            <EF label="Password"><input value={form.icecast_password || ""} onChange={e => set("icecast_password", e.target.value)} placeholder="hackme" type="password" style={inp} /></EF>
            <EF label="Bitrate">
              <select value={form.icecast_bitrate || 128} onChange={e => set("icecast_bitrate", parseInt(e.target.value))} style={{ ...inp, background: "var(--bg-tertiary)", colorScheme: "dark" }}>
                {[64,96,128,192,256,320].map(b => <option key={b} value={b}>{b} kbps</option>)}
              </select>
            </EF>
            <EF label="Format">
              <select value={form.icecast_format || "mp3"} onChange={e => set("icecast_format", e.target.value)} style={{ ...inp, background: "var(--bg-tertiary)", colorScheme: "dark" }}>
                <option value="mp3">MP3</option>
                <option value="aac">AAC</option>
                <option value="ogg">OGG</option>
              </select>
            </EF>
          </div>
        </div>

        <div style={{ padding: "12px 20px", borderTop: "1px solid var(--border-primary)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={cancelBtn}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ ...cancelBtn, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.7 : 1 }}>
            {saving ? "Saving…" : station?.id ? "Save Changes" : "Create Station"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────

export default function StationManager({ onStationSwitch }: Props) {
  const ether = (window as any).ether;
  // Live active station (same source as the bottom switcher) — the stations.is_active column
  // can be stale after a switch, so trust the hook for the "active" indicator.
  const { stationId: activeStationId } = useActiveStation();
  const [stations,  setStations]  = useState<Station[]>([]);
  const [stats,     setStats]     = useState<Record<number, StationStats>>({});
  const [loading,   setLoading]   = useState(true);
  const [editing,   setEditing]   = useState<Partial<Station> | null | false>(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await ether.stations.list();
      if (!Array.isArray(list)) return;
      setStations(list);

      const map: Record<number, StationStats> = {};
      for (const s of list as Station[]) {
        const [sc, cc] = await Promise.all([
          query<{ c: number }>(`SELECT COUNT(*) as c FROM songs WHERE station_id = ${s.id} OR station_id IS NULL`),
          query<{ c: number }>(`SELECT COUNT(*) as c FROM clocks WHERE station_id = ${s.id} OR station_id IS NULL`),
        ]);
        map[s.id] = { song_count: sc[0]?.c ?? 0, clock_count: cc[0]?.c ?? 0 };
      }
      setStats(map);
    } catch (e) { console.error("[StationManager]", e); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveStation = async (data: Partial<Station>) => {
    if (data.id) {
      const r = await ether.stations.update(data.id, data);
      if (!r?.ok) throw new Error(r?.error || "Update failed");
      if (data.is_active) onStationSwitch?.(data.id, data.name!);
    } else {
      const r = await ether.stations.create(data);
      if (!r?.ok) throw new Error(r?.error || "Create failed");
    }
    setEditing(false);
    load();
  };

  const deleteStation = async (id: number) => {
    const s = stations.find(x => x.id === id);
    if (!confirm(
      `Delete station "${s?.name}"?\n\nAll station-scoped data (schedules, logs, library associations) will be permanently removed. This cannot be undone.`
    )) return;
    const r = await ether.stations.delete(id);
    if (!r?.ok) {
      console.error("[StationManager] delete failed:", r?.error);
    }
    await load();
  };

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", gap: 10, color: "var(--text-tertiary)", fontFamily: "'Inter', system-ui, sans-serif" }}>
        <div style={{ width: 16, height: 16, border: "2px solid var(--border-primary)", borderTopColor: "var(--accent-blue)", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
        Loading stations…
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", fontFamily: "'Inter', system-ui, sans-serif", background: "var(--bg-primary)" }}>

      {/* Header */}
      <div style={{ padding: "16px 24px", borderBottom: "1px solid var(--border-primary)", background: "var(--bg-secondary)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.16em", color: "#a78bfa", textTransform: "uppercase", marginBottom: 2 }}>Enterprise</div>
            <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-0.03em", color: "var(--text-primary)" }}>Station Manager</div>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
              {stations.length} station{stations.length !== 1 ? "s" : ""} · {stations.find(s => s.id === activeStationId)?.name ?? "none"} active
            </div>
          </div>
          <button
            onClick={() => setEditing({})}
            style={{ padding: "8px 18px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: "#a78bfa", color: "#000", border: "none", cursor: "pointer" }}
          >
            + Add Station
          </button>
        </div>
        {activeStationId != null && <HubEditor stationId={activeStationId} />}
      </div>

      {/* Table */}
      <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
        {stations.length === 0 ? (
          <div style={{ textAlign: "center", padding: "60px 24px", color: "var(--text-tertiary)" }}>
            <div style={{ fontSize: 28, marginBottom: 12 }}>📻</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>No stations yet</div>
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-primary)", background: "var(--bg-tertiary)" }}>
                {["Station", "Created", "Library", "Actions"].map(h => (
                  <th key={h} style={{ padding: "8px 14px", textAlign: h === "Actions" ? "right" : "left", fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stations.map(s => (
                <StationRow
                  key={s.id}
                  station={s}
                  active={s.id === activeStationId}
                  stats={stats[s.id] ?? { song_count: 0, clock_count: 0 }}
                  onEdit={st => setEditing(st)}
                  onDelete={deleteStation}
                />
              ))}
            </tbody>
          </table>
        )}


      </div>

      {editing !== false && (
        <StationEditor
          station={editing}
          onSave={saveStation}
          onClose={() => setEditing(false)}
        />
      )}

      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// ─── Shared styles ────────────────────────────────────────────

const inp: React.CSSProperties = {
  width: "100%", padding: "7px 9px", borderRadius: 0, fontSize: 13,
  background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
  color: "var(--text-primary)", outline: "none", boxSizing: "border-box",
};

const cancelBtn: React.CSSProperties = {
  padding: "7px 16px", borderRadius: 0, fontSize: 12, fontWeight: 600,
  background: "var(--bg-tertiary)", color: "var(--text-secondary)",
  border: "1px solid var(--border-primary)", cursor: "pointer",
};

const actionBtn: React.CSSProperties = {
  padding: "4px 10px", borderRadius: 0, fontSize: 11, fontWeight: 600,
  background: "var(--bg-tertiary)", color: "var(--text-secondary)",
  border: "1px solid var(--border-primary)", cursor: "pointer",
};

function EF({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", marginBottom: 4, letterSpacing: "0.07em", textTransform: "uppercase" }}>{label}</div>
      {children}
    </div>
  );
}
