// src/components/SmartScheduler.tsx
// Tell Ether what you want in plain language — it builds the schedule.
// "Play upbeat music weekday mornings, slower on weekends, news at the top of every hour"
// → generates format clock rules automatically

import { useState, useEffect } from "react";
import { execute } from "../db/client";
import { queryScoped, executeScopedInsert } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";
import { processLibrary as analyzeLibrary } from "../audio/songAnalysis";
import { getScheduleStatus } from "../audio/loggen";

interface SmartRule {
  id: string;
  description: string;   // human-readable
  days: number[];        // 0=Sun, 1=Mon... 6=Sat
  startHour: number;
  endHour: number;
  energyLevel: "high" | "medium" | "low" | "mixed";
  bpmMin?: number;
  bpmMax?: number;
  genres?: string[];
  newsAtTop: boolean;
  spotBreaks: boolean;
  idsEveryNSongs: number; // 0 = never
  active: boolean;
}

interface Props {
  onClose?: () => void;
}

async function askAIForRules(prompt: string, existingRules: SmartRule[]): Promise<SmartRule[]> {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: `You are a radio programming assistant. Convert natural language scheduling requests into structured rules.
Respond ONLY with a JSON array of rule objects. Each rule:
{
  "id": "unique_string",
  "description": "human readable summary",
  "days": [0-6 array, 0=Sun],
  "startHour": 0-23,
  "endHour": 0-23,
  "energyLevel": "high"|"medium"|"low"|"mixed",
  "bpmMin": optional number,
  "bpmMax": optional number,
  "genres": optional string array,
  "newsAtTop": boolean,
  "spotBreaks": boolean,
  "idsEveryNSongs": number (0=never, 4=common),
  "active": true
}
No markdown, no explanation, just the JSON array.`,
        messages: [{ role: "user", content: `Current rules: ${JSON.stringify(existingRules.slice(0,3))}\n\nUser request: ${prompt}` }],
      }),
    });
    const d = await r.json();
    const text = d.content?.[0]?.text || "[]";
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch { return []; }
}

const ENERGY_COLORS = {
  high: { bg: "rgba(251,191,36,0.12)", border: "rgba(251,191,36,0.3)", text: "#fbbf24", label: "High Energy" },
  medium: { bg: "rgba(96,64,192,0.1)", border: "rgba(96,64,192,0.25)", text: "#6040c0", label: "Medium" },
  low: { bg: "rgba(167,139,250,0.1)", border: "rgba(167,139,250,0.25)", text: "#a78bfa", label: "Chill" },
  mixed: { bg: "rgba(52,211,153,0.08)", border: "rgba(52,211,153,0.2)", text: "#34d399", label: "Mixed" },
};

const DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

function fmt12(h: number) {
  if (h === 0) return "12 AM";
  if (h === 12) return "12 PM";
  return h < 12 ? `${h} AM` : `${h-12} PM`;
}

export default function SmartScheduler({ onClose }: Props) {
  const { stationId } = useActiveStation();
  const [rules, setRules] = useState<SmartRule[]>(() => {
    try {
      const s = localStorage.getItem("ether_smart_rules");
      if (s) return JSON.parse(s);
    } catch {}
    return [
      {
        id: "default-morning",
        description: "Weekday morning drive — high energy",
        days: [1,2,3,4,5],
        startHour: 6, endHour: 10,
        energyLevel: "high",
        bpmMin: 120, bpmMax: 999,
        newsAtTop: true, spotBreaks: true, idsEveryNSongs: 4,
        active: true,
      },
      {
        id: "default-midday",
        description: "Midday mix — medium energy",
        days: [0,1,2,3,4,5,6],
        startHour: 10, endHour: 15,
        energyLevel: "medium",
        newsAtTop: false, spotBreaks: true, idsEveryNSongs: 4,
        active: true,
      },
      {
        id: "default-evening",
        description: "Evening wind-down — chill",
        days: [0,1,2,3,4,5,6],
        startHour: 20, endHour: 24,
        energyLevel: "low",
        bpmMax: 110,
        newsAtTop: false, spotBreaks: false, idsEveryNSongs: 0,
        active: true,
      },
    ];
  });

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [editingRule, setEditingRule] = useState<SmartRule | null>(null);
  const [saved, setSaved] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState<{done:number;total:number;title:string}|null>(null);
  const [unanalyzedCount, setUnanalyzedCount] = useState(0);

  useEffect(() => {
    // station_id scoping: Strategy B — single table
    queryScoped<{count:number}>("SELECT COUNT(*) as count FROM songs WHERE bpm IS NULL OR energy IS NULL", [], stationId)
      .then(r => setUnanalyzedCount(r[0]?.count || 0)).catch(()=>{});
  }, [stationId]);

  const analyzeAll = async () => {
    setAnalyzing(true);
    await analyzeLibrary((done, total, title) => {
      setAnalyzeProgress({ done, total, title });
    });
    setAnalyzing(false);
    setAnalyzeProgress(null);
    // Recount — station_id scoping: Strategy B
    queryScoped<{count:number}>("SELECT COUNT(*) as count FROM songs WHERE bpm IS NULL OR energy IS NULL", [], stationId)
      .then(r => setUnanalyzedCount(r[0]?.count || 0)).catch(()=>{});
  };

  const saveRules = (r: SmartRule[]) => {
    setRules(r);
    localStorage.setItem("ether_smart_rules", JSON.stringify(r)); // only persistence — see docs/phase-3.5-smartscheduler-deferred.md
    // DB writes below are intentionally broken (schema mismatch + db:execute guard) — deferred, do not fix here
    execute("DELETE FROM smart_schedule_rules WHERE station_id = ?", [stationId]).catch(() => {});
    r.forEach(rule => {
      executeScopedInsert(
        "INSERT OR REPLACE INTO smart_schedule_rules (id, data) VALUES (?, ?)",
        [rule.id, JSON.stringify(rule)],
        stationId
      ).catch(() => {});
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleAI = async () => {
    if (!input.trim() || loading) return;
    setLoading(true);
    const newRules = await askAIForRules(input.trim(), rules);
    if (newRules.length > 0) {
      saveRules([...rules, ...newRules]);
      setInput("");
    }
    setLoading(false);
  };

  // Quick presets
  const applyPreset = (preset: string) => {
    const presets: Record<string, SmartRule[]> = {
      "Radio Station": [
        { id:"radio-am", description:"Morning drive (6-10am weekdays)", days:[1,2,3,4,5], startHour:6, endHour:10, energyLevel:"high", bpmMin:120, newsAtTop:true, spotBreaks:true, idsEveryNSongs:4, active:true },
        { id:"radio-mid", description:"Midday (10am-3pm)", days:[0,1,2,3,4,5,6], startHour:10, endHour:15, energyLevel:"medium", newsAtTop:false, spotBreaks:true, idsEveryNSongs:4, active:true },
        { id:"radio-pm", description:"Afternoon drive (3-7pm weekdays)", days:[1,2,3,4,5], startHour:15, endHour:19, energyLevel:"high", bpmMin:115, newsAtTop:false, spotBreaks:true, idsEveryNSongs:4, active:true },
        { id:"radio-eve", description:"Evening (7pm-midnight)", days:[0,1,2,3,4,5,6], startHour:19, endHour:24, energyLevel:"medium", newsAtTop:false, spotBreaks:false, idsEveryNSongs:0, active:true },
      ],
      "Coffee Shop": [
        { id:"coffee-open", description:"Opening hours", days:[0,1,2,3,4,5,6], startHour:7, endHour:20, energyLevel:"low", bpmMax:110, newsAtTop:false, spotBreaks:false, idsEveryNSongs:0, active:true },
      ],
      "Worship": [
        { id:"worship-pre", description:"Pre-service music", days:[0], startHour:9, endHour:10, energyLevel:"medium", newsAtTop:false, spotBreaks:false, idsEveryNSongs:0, active:true },
        { id:"worship-post", description:"Post-service", days:[0], startHour:12, endHour:13, energyLevel:"low", newsAtTop:false, spotBreaks:false, idsEveryNSongs:0, active:true },
      ],
      "Club / Venue": [
        { id:"venue-warm", description:"Warm-up (8-10pm)", days:[4,5,6], startHour:20, endHour:22, energyLevel:"medium", bpmMin:110, newsAtTop:false, spotBreaks:false, idsEveryNSongs:0, active:true },
        { id:"venue-peak", description:"Peak hours (10pm-2am)", days:[4,5,6], startHour:22, endHour:26, energyLevel:"high", bpmMin:126, newsAtTop:false, spotBreaks:false, idsEveryNSongs:0, active:true },
      ],
    };
    if (presets[preset]) saveRules(presets[preset]);
  };

  const toggleRule = (id: string) => {
    saveRules(rules.map(r => r.id === id ? { ...r, active: !r.active } : r));
  };

  const deleteRule = (id: string) => {
    saveRules(rules.filter(r => r.id !== id));
  };

  // Visual timeline — 24hr strip
  const activeRulesNow = () => {
    const now = new Date();
    const h = now.getHours();
    const d = now.getDay();
    return rules.filter(r => r.active && r.days.includes(d) && h >= r.startHour && h < r.endHour);
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", fontFamily: "'Inter', system-ui, sans-serif", background: "var(--bg-primary)" }}>

      {/* Header */}
      <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.16em", color: "var(--accent-cyan)", textTransform: "uppercase", marginBottom: 5 }}>Smart Scheduler</div>
            <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.03em", color: "var(--text-primary)", fontFamily: "'Syne', sans-serif", marginBottom: 4 }}>Your Programming</div>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Tell it what you want — it handles the rest</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {saved && <span style={{ fontSize: 10, color: "var(--accent-green)", fontWeight: 700 }}>✓ Saved</span>}
            {onClose && <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 16 }}>×</button>}
          </div>
        </div>

        {/* Active now indicator */}
        {activeRulesNow().length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 0, background: "rgba(52,211,153,0.08)", border: "1px solid rgba(52,211,153,0.2)", marginBottom: 12 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#34d399", boxShadow: "0 0 6px #34d399", animation: "pulse 2s ease-in-out infinite" }} />
            <span style={{ fontSize: 11, color: "#34d399", fontWeight: 600 }}>
              Active now: {activeRulesNow().map(r => r.description).join(", ")}
            </span>
          </div>
        )}

        {/* Library analysis banner */}
        {unanalyzedCount > 0 && !analyzing && (
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 14px", borderRadius:10, background:"rgba(251,191,36,0.08)", border:"1px solid rgba(251,191,36,0.2)", marginBottom:12 }}>
            <div>
              <div style={{ fontSize:12, fontWeight:700, color:"var(--accent-amber)" }}>Library not analyzed</div>
              <div style={{ fontSize:10, color:"var(--text-tertiary)", marginTop:1 }}>{unanalyzedCount} songs missing BPM/energy data — scheduler will use random selection for those</div>
            </div>
            <button onClick={analyzeAll} style={{ padding:"7px 14px", borderRadius:9, background:"var(--accent-amber)", border:"none", color:"#000", fontSize:11, fontWeight:700, cursor:"pointer", whiteSpace:"nowrap" as const, flexShrink:0, marginLeft:12 }}>
              Analyze Library
            </button>
          </div>
        )}
        {analyzing && analyzeProgress && (
          <div style={{ padding:"10px 14px", borderRadius:10, background:"rgba(96,64,192,0.08)", border:"1px solid rgba(96,64,192,0.2)", marginBottom:12 }}>
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
              <div style={{ width:11, height:11, borderRadius:"50%", border:"2px solid var(--accent-cyan)", borderTopColor:"transparent", animation:"spin 0.7s linear infinite" }} />
              <span style={{ fontSize:12, fontWeight:600, color:"var(--accent-cyan)" }}>Analyzing library...</span>
              <span style={{ fontSize:10, color:"var(--text-tertiary)", marginLeft:"auto" }}>{analyzeProgress.done}/{analyzeProgress.total}</span>
            </div>
            <div style={{ fontSize:11, color:"var(--text-tertiary)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" as const }}>{analyzeProgress.title}</div>
            <div style={{ marginTop:6, height:3, borderRadius:2, background:"var(--bg-tertiary)", overflow:"hidden" }}>
              <div style={{ height:"100%", width:`${analyzeProgress.total>0?(analyzeProgress.done/analyzeProgress.total*100):0}%`, background:"var(--accent-cyan)", borderRadius:2, transition:"width 0.3s" }} />
            </div>
          </div>
        )}

        {/* Quick presets */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {["Radio Station", "Coffee Shop", "Worship", "Club / Venue"].map(p => (
            <button key={p} onClick={() => applyPreset(p)} style={{ padding: "5px 12px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", fontSize: 10, fontWeight: 600, cursor: "pointer", transition: "all 0.12s" }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "var(--accent-cyan)"; (e.currentTarget as HTMLElement).style.color = "var(--accent-cyan)"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border-primary)"; (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)"; }}
            >{p}</button>
          ))}
        </div>
      </div>

      {/* AI input */}
      <div style={{ padding: "14px 24px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0, background: "var(--bg-secondary)" }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 8 }}>Tell AI what you want</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleAI(); }}
            placeholder="e.g. Play high energy music weekday mornings, slow jazz Friday evenings, news at the top of every hour..."
            style={{ flex: 1, padding: "10px 14px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", fontSize: 12, outline: "none", fontFamily: "inherit" }}
          />
          <button onClick={handleAI} disabled={loading || !input.trim()} style={{ padding: "10px 18px", borderRadius: 0, background: loading || !input.trim() ? "var(--bg-tertiary)" : "var(--accent-cyan)", border: "none", color: loading || !input.trim() ? "var(--text-tertiary)" : "#000", fontSize: 12, fontWeight: 700, cursor: loading || !input.trim() ? "default" : "pointer", display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
            {loading ? <><div style={{ width: 11, height: 11, borderRadius: "50%", border: "2px solid rgba(0,0,0,0.4)", borderTopColor: "transparent", animation: "spin 0.7s linear infinite" }} />Building...</> : "✦ Build Rules"}
          </button>
        </div>
        <div style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap" }}>
          {["High energy mornings", "Chill evenings", "News every hour", "Weekend party mode", "No talk, just music"].map(q => (
            <button key={q} onClick={() => setInput(q)} style={{ padding: "3px 9px", borderRadius: 0, background: "none", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)", fontSize: 10, cursor: "pointer", transition: "all 0.1s" }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = "var(--accent-cyan)"}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"}
            >{q}</button>
          ))}
        </div>
      </div>

      {/* 24hr timeline strip */}
      <div style={{ padding: "12px 24px 0", flexShrink: 0 }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 6 }}>Today's Schedule</div>
        <div style={{ position: "relative", height: 28, borderRadius: 0, background: "var(--bg-tertiary)", overflow: "hidden" }}>
          {rules.filter(r => r.active).map(rule => {
            const now = new Date();
            const d = now.getDay();
            if (!rule.days.includes(d)) return null;
            const left = (rule.startHour / 24) * 100;
            const width = ((rule.endHour - rule.startHour) / 24) * 100;
            const colors = ENERGY_COLORS[rule.energyLevel];
            return (
              <div key={rule.id} title={rule.description} style={{
                position: "absolute", left: `${left}%`, width: `${width}%`, top: 0, bottom: 0,
                background: colors.bg, borderLeft: `2px solid ${colors.border}`,
                display: "flex", alignItems: "center", paddingLeft: 4, overflow: "hidden",
              }}>
                <span style={{ fontSize: 8, color: colors.text, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden" }}>{rule.description}</span>
              </div>
            );
          })}
          {/* Current time indicator */}
          <div style={{ position: "absolute", left: `${(new Date().getHours() + new Date().getMinutes()/60) / 24 * 100}%`, top: 0, bottom: 0, width: 2, background: "var(--accent-red)", boxShadow: "0 0 4px var(--accent-red)" }} />
          {/* Hour labels */}
          {[6,12,18].map(h => (
            <div key={h} style={{ position: "absolute", left: `${h/24*100}%`, bottom: 2, fontSize: 7, color: "var(--text-tertiary)", transform: "translateX(-50%)" }}>{fmt12(h)}</div>
          ))}
        </div>
      </div>

      {/* Rules list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 24px 24px" }}>
        {rules.length === 0 && (
          <div style={{ textAlign: "center", padding: "48px 20px", color: "var(--text-tertiary)" }}>
            <div style={{ fontSize: 36, marginBottom: 10 }}>🗓</div>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>No rules yet</div>
            <div style={{ fontSize: 11 }}>Use the AI input above or pick a preset to get started</div>
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rules.map(rule => {
            const colors = ENERGY_COLORS[rule.energyLevel];
            return (
              <div key={rule.id} style={{
                padding: "14px 16px", borderRadius: 0,
                background: rule.active ? colors.bg : "var(--bg-secondary)",
                border: `1px solid ${rule.active ? colors.border : "var(--border-primary)"}`,
                opacity: rule.active ? 1 : 0.5,
                transition: "all 0.2s",
              }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>{rule.description}</span>
                      <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 0, background: colors.bg, color: colors.text, border: `1px solid ${colors.border}` }}>{colors.label}</span>
                    </div>
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                      {/* Days */}
                      <div style={{ display: "flex", gap: 3 }}>
                        {DAY_NAMES.map((d, i) => (
                          <div key={d} style={{ width: 20, height: 20, borderRadius: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, fontWeight: 700, background: rule.days.includes(i) ? colors.bg : "var(--bg-tertiary)", color: rule.days.includes(i) ? colors.text : "var(--text-tertiary)", border: `1px solid ${rule.days.includes(i) ? colors.border : "var(--border-primary)"}` }}>{d}</div>
                        ))}
                      </div>
                      {/* Time */}
                      <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace" }}>{fmt12(rule.startHour)} – {fmt12(rule.endHour)}</span>
                      {/* BPM */}
                      {(rule.bpmMin || rule.bpmMax) && (
                        <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{rule.bpmMin ? `${rule.bpmMin}+` : ""}{rule.bpmMin && rule.bpmMax ? "–" : ""}{rule.bpmMax ? `${rule.bpmMax}` : ""} BPM</span>
                      )}
                      {/* Features */}
                      {rule.newsAtTop && <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>📰 News on the hour</span>}
                      {rule.spotBreaks && <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>📢 Spot breaks</span>}
                      {rule.idsEveryNSongs > 0 && <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>🎙 ID every {rule.idsEveryNSongs} songs</span>}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                    {/* Toggle */}
                    <button onClick={() => toggleRule(rule.id)} style={{ width: 36, height: 20, borderRadius: 0, border: "none", background: rule.active ? colors.border : "var(--bg-tertiary)", cursor: "pointer", position: "relative", transition: "background 0.2s" }}>
                      <div style={{ position: "absolute", top: 2, left: rule.active ? 18 : 2, width: 16, height: 16, borderRadius: "50%", background: rule.active ? "#fff" : "var(--text-tertiary)", transition: "left 0.2s" }} />
                    </button>
                    <button onClick={() => deleteRule(rule.id)} style={{ width: 26, height: 26, borderRadius: 0, background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 14, opacity: 0.4 }}
                      onMouseEnter={e => (e.currentTarget as HTMLElement).style.opacity = "1"}
                      onMouseLeave={e => (e.currentTarget as HTMLElement).style.opacity = "0.4"}
                    >×</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
      `}</style>
    </div>
  );
}
