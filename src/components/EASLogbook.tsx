// EASLogbook.tsx — FCC-compliant Emergency Alert System logbook.
//
// What it does
//   - Records every Required Weekly Test (RWT), Required Monthly Test (RMT),
//     and actual alert your station receives, transmits, or both.
//   - Shows a live compliance dashboard: "this week's RWTs", "this month's
//     RMT", days since last test, gap warnings.
//   - CSV + printable PDF export — exactly what an FCC inspector wants to see.
//
// What it doesn't do
//   - Generate the actual EAS audio. That's the SAGE Digital ENDEC or
//     Trilithic / DASDEC encoder/decoder boxes' job. Ether is the LOGBOOK,
//     not the encoder. (You can build a workflow where the SAGE box's
//     contact closure fires through GPIO → auto-creates a log entry, but
//     that wiring is per-station and lives outside this UI.)
//
// FCC reference: 47 CFR § 11.31, 11.35, 11.61. Tests must be retained 2 years.

import { useEffect, useState, useMemo } from "react";
import { query, execute } from "../db/client";
import { useActiveStation } from "../hooks/useActiveStation";

// Alert codes per FCC § 11.31.
const ALERT_CODES: { code: string; label: string; severity: "test" | "alert" }[] = [
  { code: "RWT", label: "Required Weekly Test",       severity: "test"  },
  { code: "RMT", label: "Required Monthly Test",      severity: "test"  },
  { code: "NPT", label: "National Periodic Test",     severity: "test"  },
  { code: "EAN", label: "Emergency Action Notification", severity: "alert" },
  { code: "EAT", label: "Emergency Action Termination",  severity: "alert" },
  { code: "TOR", label: "Tornado Warning",            severity: "alert" },
  { code: "SVR", label: "Severe Thunderstorm Warning", severity: "alert" },
  { code: "FFW", label: "Flash Flood Warning",        severity: "alert" },
  { code: "WSW", label: "Winter Storm Warning",       severity: "alert" },
  { code: "AVA", label: "Avalanche Watch",            severity: "alert" },
  { code: "HUW", label: "Hurricane Warning",          severity: "alert" },
  { code: "ADR", label: "Administrative Message",     severity: "alert" },
  { code: "CAE", label: "Child Abduction Emergency (Amber)", severity: "alert" },
];

const ORIGINATORS = [
  { code: "PEP", label: "Primary Entry Point" },
  { code: "EAS", label: "Broadcast / cable / wireless EAS Participant" },
  { code: "WXR", label: "National Weather Service" },
  { code: "CIV", label: "Civil authorities (state/local)" },
  { code: "EAN", label: "EAS Participant (national)" },
];

interface EasEntry {
  id: number;
  occurred_at: number;
  alert_code: string;
  direction: "received" | "transmitted" | "both";
  originator: string;
  sender_id: string;
  received_from: string;
  retransmitted: number;
  retransmitted_at: number;
  operator_initials: string;
  notes: string;
  created_at: number;
}

function fmtDateTime(unixSec: number) {
  if (!unixSec) return "—";
  return new Date(unixSec * 1000).toLocaleString();
}

function startOfWeek(): number {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay()); // back to Sunday
  return Math.floor(d.getTime() / 1000);
}
function startOfMonth(): number {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(1);
  return Math.floor(d.getTime() / 1000);
}

export default function EASLogbook({ onClose }: { onClose?: () => void }) {
  const { stationId } = useActiveStation();
  const [entries, setEntries] = useState<EasEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [filter, setFilter] = useState<"week" | "month" | "year" | "all">("month");

  const load = async () => {
    setLoading(true);
    try {
      const since =
        filter === "week"  ? startOfWeek() :
        filter === "month" ? startOfMonth() :
        filter === "year"  ? Math.floor(Date.now()/1000) - 365*86400 :
                             0;
      const rows = await query<EasEntry>(
        "SELECT * FROM eas_tests WHERE occurred_at >= ? AND station_id = ? ORDER BY occurred_at DESC",
        [since, stationId]
      );
      setEntries(rows);
    } catch (e) {
      console.error("[EAS] load failed:", e);
      setEntries([]);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, [filter]);

  // ── Compliance summary — what FCC inspector glances at ──
  const summary = useMemo(() => {
    const weekStart = startOfWeek();
    const monthStart = startOfMonth();
    const rwtThisWeek = entries.filter(e => e.alert_code === "RWT" && e.occurred_at >= weekStart).length;
    const rmtThisMonth = entries.filter(e => e.alert_code === "RMT" && e.occurred_at >= monthStart).length;
    const lastRwt = entries.filter(e => e.alert_code === "RWT").sort((a,b) => b.occurred_at - a.occurred_at)[0];
    const lastRmt = entries.filter(e => e.alert_code === "RMT").sort((a,b) => b.occurred_at - a.occurred_at)[0];
    const daysSinceRwt = lastRwt ? Math.floor((Date.now()/1000 - lastRwt.occurred_at) / 86400) : -1;
    const daysSinceRmt = lastRmt ? Math.floor((Date.now()/1000 - lastRmt.occurred_at) / 86400) : -1;
    return { rwtThisWeek, rmtThisMonth, daysSinceRwt, daysSinceRmt };
  }, [entries]);

  const deleteEntry = async (id: number) => {
    if (!confirm("Delete this EAS log entry? FCC requires 2-year retention — only delete duplicates or errors.")) return;
    await execute("DELETE FROM eas_tests WHERE id = ? AND station_id = ?", [id, stationId]);
    load();
  };

  // ── CSV export — FCC inspectors love columns ──
  const exportCSV = () => {
    const header = ["Date/Time","Code","Description","Direction","Originator","Sender","Received From","Retransmitted","Retransmitted At","Operator","Notes"];
    const rows = entries.map(e => [
      new Date(e.occurred_at * 1000).toISOString(),
      e.alert_code,
      ALERT_CODES.find(a => a.code === e.alert_code)?.label || "",
      e.direction,
      e.originator,
      e.sender_id,
      e.received_from,
      e.retransmitted ? "yes" : "no",
      e.retransmitted_at ? new Date(e.retransmitted_at*1000).toISOString() : "",
      e.operator_initials,
      (e.notes || "").replace(/\n/g, " "),
    ]);
    const csv = [header, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `eas-log-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ── Printable PDF — opens a new window with print stylesheet ──
  const exportPDF = () => {
    const rows = entries.map(e => `<tr>
      <td>${new Date(e.occurred_at*1000).toLocaleString()}</td>
      <td><strong>${e.alert_code}</strong></td>
      <td>${ALERT_CODES.find(a => a.code === e.alert_code)?.label || ""}</td>
      <td>${e.direction}</td>
      <td>${e.originator}</td>
      <td>${e.sender_id}</td>
      <td>${e.retransmitted ? "✓" : ""}</td>
      <td>${e.operator_initials}</td>
    </tr>`).join("");
    const html = `<!doctype html><html><head><title>EAS Logbook</title>
<style>body{font-family:Arial,sans-serif;font-size:11px;color:#222;margin:24px}h1{font-size:18px;margin:0 0 4px}.meta{color:#666;font-size:10px;margin-bottom:14px}table{width:100%;border-collapse:collapse;margin-top:8px}th{background:#1e293b;color:#fff;padding:6px;text-align:left;font-size:10px;text-transform:uppercase}td{padding:5px 6px;border-bottom:1px solid #e5e7eb}.summary{margin:10px 0;padding:8px 12px;background:#f1f5f9;border-left:3px solid #334155}</style>
</head><body>
<h1>EAS Logbook</h1>
<div class="meta">Generated ${new Date().toLocaleString()} · Filter: ${filter} · ${entries.length} entries · FCC § 11.61 compliance record</div>
<div class="summary">RWT this week: <b>${summary.rwtThisWeek}</b> · RMT this month: <b>${summary.rmtThisMonth}</b> · Days since last RWT: <b>${summary.daysSinceRwt < 0 ? "—" : summary.daysSinceRwt}</b> · Days since last RMT: <b>${summary.daysSinceRmt < 0 ? "—" : summary.daysSinceRmt}</b></div>
<table><thead><tr><th>Date/Time</th><th>Code</th><th>Description</th><th>Direction</th><th>Originator</th><th>Sender</th><th>Retx</th><th>Op</th></tr></thead>
<tbody>${rows}</tbody></table>
<div style="margin-top:24px;font-size:9px;color:#888">This logbook contains records of EAS tests received and transmitted by this station as required by 47 CFR Part 11. Records must be retained for 2 years.</div>
</body></html>`;
    const w = window.open("", "_blank", "width=900,height=700");
    if (w) { w.document.write(html); w.document.close(); setTimeout(() => w.print(), 400); }
  };

  return (
    <div style={{ padding: 24, color: "var(--text-primary)", fontFamily: "'Inter', system-ui, sans-serif", minHeight: "100%" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em" }}>EAS Logbook</h1>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 4 }}>
            Emergency Alert System compliance record · 47 CFR Part 11 · 2-year retention required
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => { setEditingId(null); setShowForm(true); }}
            style={{ padding: "8px 16px", borderRadius: 0, fontSize: 13, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>
            + Log Entry
          </button>
          <button onClick={exportCSV} style={btnStyle}>CSV</button>
          <button onClick={exportPDF} style={btnStyle}>Print / PDF</button>
          {onClose && <button onClick={onClose} style={btnStyle}>Close</button>}
        </div>
      </div>

      {/* Compliance summary cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 20 }}>
        <SummaryCard
          label="RWT this week"
          value={summary.rwtThisWeek}
          target={1}
          status={summary.rwtThisWeek >= 1 ? "ok" : "warn"}
          hint="FCC requires 1 RWT/week"
        />
        <SummaryCard
          label="RMT this month"
          value={summary.rmtThisMonth}
          target={1}
          status={summary.rmtThisMonth >= 1 ? "ok" : "warn"}
          hint="FCC requires 1 RMT/month"
        />
        <SummaryCard
          label="Days since RWT"
          value={summary.daysSinceRwt < 0 ? "—" : summary.daysSinceRwt}
          target={7}
          status={summary.daysSinceRwt < 0 ? "warn" : summary.daysSinceRwt > 7 ? "fail" : "ok"}
          hint="Should be < 7"
        />
        <SummaryCard
          label="Days since RMT"
          value={summary.daysSinceRmt < 0 ? "—" : summary.daysSinceRmt}
          target={31}
          status={summary.daysSinceRmt < 0 ? "warn" : summary.daysSinceRmt > 31 ? "fail" : "ok"}
          hint="Should be < 31"
        />
      </div>

      {/* Filter */}
      <div style={{ display: "flex", gap: 4, marginBottom: 14 }}>
        {(["week", "month", "year", "all"] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            padding: "6px 14px", borderRadius: 0, fontSize: 12, fontWeight: 600,
            background: filter === f ? "var(--accent-blue)" : "var(--bg-secondary)",
            color:      filter === f ? "#fff"               : "var(--text-secondary)",
            border: filter === f ? "none" : "1px solid var(--border-primary)",
            cursor: "pointer", textTransform: "capitalize" as any,
          }}>{f === "week" ? "This week" : f === "month" ? "This month" : f === "year" ? "Past year" : "All time"}</button>
        ))}
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ padding: 40, textAlign: "center" as any, color: "var(--text-tertiary)" }}>Loading…</div>
      ) : entries.length === 0 ? (
        <div style={{ padding: 60, textAlign: "center" as any, background: "var(--bg-secondary)", border: "1px dashed var(--border-primary)" }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>No entries yet</div>
          <div style={{ fontSize: 13, color: "var(--text-tertiary)" }}>Log your first EAS test by clicking <b>+ Log Entry</b> above</div>
        </div>
      ) : (
        <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" as any, fontSize: 12 }}>
            <thead>
              <tr style={{ background: "var(--bg-tertiary)", borderBottom: "1px solid var(--border-primary)" }}>
                {["Date/Time","Code","Description","Direction","Originator","Sender","Retx","Op","Notes",""].map(h => (
                  <th key={h} style={{ padding: "10px 12px", textAlign: "left" as any, fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.08em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map(e => (
                <tr key={e.id} style={{ borderBottom: "1px solid var(--border-primary)" }}>
                  <td style={{ padding: "8px 12px", fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>{fmtDateTime(e.occurred_at)}</td>
                  <td style={{ padding: "8px 12px" }}>
                    <span style={{
                      padding: "2px 6px", fontSize: 11, fontWeight: 700, letterSpacing: "0.04em",
                      background: ALERT_CODES.find(a => a.code === e.alert_code)?.severity === "alert" ? "rgba(239,68,68,0.18)" : "rgba(96,64,192,0.18)",
                      color:      ALERT_CODES.find(a => a.code === e.alert_code)?.severity === "alert" ? "#ef4444" : "#6040c0",
                    }}>{e.alert_code}</span>
                  </td>
                  <td style={{ padding: "8px 12px", color: "var(--text-secondary)" }}>{ALERT_CODES.find(a => a.code === e.alert_code)?.label || ""}</td>
                  <td style={{ padding: "8px 12px", color: "var(--text-secondary)" }}>{e.direction}</td>
                  <td style={{ padding: "8px 12px", color: "var(--text-secondary)" }}>{e.originator}</td>
                  <td style={{ padding: "8px 12px", color: "var(--text-secondary)" }}>{e.sender_id}</td>
                  <td style={{ padding: "8px 12px", color: e.retransmitted ? "#22c55e" : "var(--text-tertiary)" }}>{e.retransmitted ? "✓" : "—"}</td>
                  <td style={{ padding: "8px 12px", color: "var(--text-secondary)", fontWeight: 600 }}>{e.operator_initials}</td>
                  <td style={{ padding: "8px 12px", color: "var(--text-tertiary)", fontSize: 11, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={e.notes}>{e.notes}</td>
                  <td style={{ padding: "8px 12px" }}>
                    <button onClick={() => { setEditingId(e.id); setShowForm(true); }} style={miniBtn}>Edit</button>
                    <button onClick={() => deleteEntry(e.id)} style={{ ...miniBtn, color: "#ef4444", marginLeft: 4 }}>Del</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <EntryForm
          editingId={editingId}
          stationId={stationId}
          onClose={() => { setShowForm(false); setEditingId(null); }}
          onSaved={() => { setShowForm(false); setEditingId(null); load(); }}
        />
      )}
    </div>
  );
}

// ── Sub: compliance summary card ──
function SummaryCard({ label, value, target, status, hint }: { label: string; value: any; target: number; status: "ok" | "warn" | "fail"; hint: string }) {
  const color = status === "ok" ? "#22c55e" : status === "warn" ? "#f59e0b" : "#ef4444";
  return (
    <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", padding: "14px 16px" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.08em" }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 4 }}>
        <span style={{ fontSize: 26, fontWeight: 700, color, fontFamily: "'JetBrains Mono', monospace" }}>{value}</span>
        <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>/ target {target}</span>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>{hint}</div>
    </div>
  );
}

// ── Sub: entry add/edit form ──
function EntryForm({ editingId, stationId, onClose, onSaved }: { editingId: number | null; stationId: number; onClose: () => void; onSaved: () => void }) {
  const isEdit = editingId !== null;
  const [occurredAt, setOccurredAt]    = useState<string>(() => new Date().toISOString().slice(0, 16));
  const [alertCode, setAlertCode]      = useState("RWT");
  const [direction, setDirection]      = useState<"received" | "transmitted" | "both">("received");
  const [originator, setOriginator]    = useState("EAS");
  const [senderId, setSenderId]        = useState("");
  const [receivedFrom, setReceivedFrom] = useState("");
  const [retransmitted, setRetransmitted] = useState(false);
  const [retransmittedAt, setRetransmittedAt] = useState<string>("");
  const [operatorInitials, setOperatorInitials] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isEdit) return;
    (async () => {
      const r = await query<EasEntry>("SELECT * FROM eas_tests WHERE id = ? AND station_id = ?", [editingId!, stationId]);
      if (r[0]) {
        const e = r[0];
        setOccurredAt(new Date(e.occurred_at * 1000).toISOString().slice(0, 16));
        setAlertCode(e.alert_code);
        setDirection(e.direction);
        setOriginator(e.originator);
        setSenderId(e.sender_id);
        setReceivedFrom(e.received_from);
        setRetransmitted(!!e.retransmitted);
        setRetransmittedAt(e.retransmitted_at ? new Date(e.retransmitted_at * 1000).toISOString().slice(0, 16) : "");
        setOperatorInitials(e.operator_initials);
        setNotes(e.notes);
      }
    })();
  }, [editingId, isEdit]);

  const save = async () => {
    setSaving(true);
    try {
      const occUnix = Math.floor(new Date(occurredAt).getTime() / 1000);
      const retxUnix = retransmittedAt ? Math.floor(new Date(retransmittedAt).getTime() / 1000) : 0;
      if (isEdit) {
        await execute(
          "UPDATE eas_tests SET occurred_at=?, alert_code=?, direction=?, originator=?, sender_id=?, received_from=?, retransmitted=?, retransmitted_at=?, operator_initials=?, notes=? WHERE id=? AND station_id=?",
          [occUnix, alertCode, direction, originator, senderId, receivedFrom, retransmitted ? 1 : 0, retxUnix, operatorInitials, notes, editingId, stationId]
        );
      } else {
        await execute(
          "INSERT INTO eas_tests (occurred_at, alert_code, direction, originator, sender_id, received_from, retransmitted, retransmitted_at, operator_initials, notes, station_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [occUnix, alertCode, direction, originator, senderId, receivedFrom, retransmitted ? 1 : 0, retxUnix, operatorInitials, notes, stationId]
        );
      }
      onSaved();
    } catch (e) {
      alert("Save failed: " + (e as any)?.message);
      setSaving(false);
    }
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
        width: "100%", maxWidth: 560, maxHeight: "90vh", overflowY: "auto",
        padding: "20px 22px", borderRadius: 0,
      }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text-primary)", marginBottom: 14 }}>
          {isEdit ? "Edit" : "Log"} EAS Event
        </h3>

        <Field label="Date / Time of event">
          <input type="datetime-local" value={occurredAt} onChange={e => setOccurredAt(e.target.value)} style={inputStyle} />
        </Field>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Alert code">
            <select value={alertCode} onChange={e => setAlertCode(e.target.value)} style={inputStyle}>
              {ALERT_CODES.map(a => <option key={a.code} value={a.code}>{a.code} — {a.label}</option>)}
            </select>
          </Field>
          <Field label="Direction">
            <select value={direction} onChange={e => setDirection(e.target.value as any)} style={inputStyle}>
              <option value="received">Received</option>
              <option value="transmitted">Transmitted</option>
              <option value="both">Both (received + retransmitted)</option>
            </select>
          </Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Originator">
            <select value={originator} onChange={e => setOriginator(e.target.value)} style={inputStyle}>
              {ORIGINATORS.map(o => <option key={o.code} value={o.code}>{o.code} — {o.label}</option>)}
            </select>
          </Field>
          <Field label="Sender / Source ID">
            <input value={senderId} onChange={e => setSenderId(e.target.value)} placeholder="e.g. WXYZ" style={inputStyle} />
          </Field>
        </div>

        <Field label="Received from (monitoring assignment, e.g. LP-1)">
          <input value={receivedFrom} onChange={e => setReceivedFrom(e.target.value)} placeholder="e.g. LP-1, LP-2, NWS Las Vegas" style={inputStyle} />
        </Field>

        <Field label="">
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-secondary)" }}>
            <input type="checkbox" checked={retransmitted} onChange={e => setRetransmitted(e.target.checked)} />
            Retransmitted (rebroadcast on this station's air signal)
          </label>
        </Field>

        {retransmitted && (
          <Field label="Retransmitted at">
            <input type="datetime-local" value={retransmittedAt} onChange={e => setRetransmittedAt(e.target.value)} style={inputStyle} />
          </Field>
        )}

        <Field label="Operator initials">
          <input value={operatorInitials} onChange={e => setOperatorInitials(e.target.value)} placeholder="e.g. JD" style={{ ...inputStyle, width: 100 }} />
        </Field>

        <Field label="Notes (optional)">
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} style={{ ...inputStyle, fontFamily: "inherit" }} />
        </Field>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border-primary)" }}>
          <button onClick={onClose} style={btnStyle}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ ...btnStyle, background: "var(--accent-blue)", color: "#fff", border: "none" }}>
            {saving ? "Saving…" : isEdit ? "Update" : "Log entry"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Styles ──
const btnStyle: React.CSSProperties = {
  padding: "8px 14px", borderRadius: 0, fontSize: 12, fontWeight: 600,
  background: "var(--bg-tertiary)", color: "var(--text-secondary)",
  border: "1px solid var(--border-primary)", cursor: "pointer",
};
const miniBtn: React.CSSProperties = {
  padding: "3px 8px", borderRadius: 0, fontSize: 10, fontWeight: 600,
  background: "var(--bg-tertiary)", color: "var(--text-secondary)",
  border: "1px solid var(--border-primary)", cursor: "pointer",
};
const inputStyle: React.CSSProperties = {
  width: "100%", padding: "7px 10px", borderRadius: 0, fontSize: 13,
  background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
  color: "var(--text-primary)", outline: "none", boxSizing: "border-box",
};
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      {label && <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", marginBottom: 4, letterSpacing: "0.04em", textTransform: "uppercase" as any }}>{label}</div>}
      {children}
    </div>
  );
}
