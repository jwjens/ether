// AIVoiceStudio.tsx — the AI Auto-DJ workspace.
//
// What it does
//   - Library of generated voice segments (station IDs, weather, news, etc.)
//   - Templates with {{variables}} for one-click generation
//   - Inline playback + drop-into-queue
//   - Status flow: pending → generating → ready → played → archived
//
// Templates are stored in ai_voice_templates (seeded with sensible defaults
// on first open). Generated audio lives in ai_voice_segments + on disk at
// <userData>/ai-voice/.
//
// The actual TTS happens in main process (electron/ai-voice.js) so API keys
// stay out of the renderer.

import { useEffect, useMemo, useState } from "react";
import { useAudioEngine } from "../audio/AudioEngineContext";

type SegmentStatus = "pending" | "generating" | "ready" | "played" | "error" | "archived";

interface Segment {
  id: number;
  template_id: number | null;
  title: string;
  script: string;
  provider: string;
  voice_id: string;
  file_path: string;
  duration_ms: number;
  size_bytes: number;
  status: SegmentStatus;
  error_msg: string;
  generated_at: number;
  played_at: number;
  created_at: number;
}

interface Template {
  id: number;
  name: string;
  kind: string;            // 'one_shot' | 'recurring' | 'evergreen'
  prompt_template: string;
  voice_id: string;
  provider: string;
  created_at: number;
}

const STATUS_COLOR: Record<SegmentStatus, string> = {
  pending:    "#94a3b8",
  generating: "#f59e0b",
  ready:      "#38bdf8",
  played:     "#22c55e",
  archived:   "#94a3b8",
  error:      "#ef4444",
};

function fmtBytes(b: number) {
  if (!b) return "—";
  if (b > 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024).toFixed(0)} KB`;
}
function fmtAgo(unixSec: number) {
  if (!unixSec) return "—";
  const d = Math.floor(Date.now() / 1000) - unixSec;
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

// Extract {{variable}} names from a template string
function extractVars(template: string): string[] {
  const matches = template.match(/\{\{(\w+)\}\}/g) || [];
  return Array.from(new Set(matches.map(m => m.slice(2, -2))));
}
function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name) => values[name] || `{{${name}}}`);
}

export default function AIVoiceStudio({ onClose }: { onClose?: () => void }) {
  const ether = (window as any).ether;
  const [segments, setSegments]   = useState<Segment[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [activeTab, setActiveTab] = useState<"library" | "templates" | "compose">("compose");
  const [loading, setLoading]     = useState(true);
  const [playing, setPlaying]     = useState<number | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const [s, t] = await Promise.all([
        ether?.ai?.listSegments?.() || Promise.resolve([]),
        ether?.ai?.listTemplates?.() || Promise.resolve([]),
      ]);
      setSegments(Array.isArray(s) ? s : []);
      setTemplates(Array.isArray(t) ? t : []);
    } catch (e) {
      console.error("[AIVoiceStudio] refresh failed:", e);
    }
    setLoading(false);
  };
  useEffect(() => { refresh(); }, []);

  return (
    <div style={{ padding: 24, color: "var(--text-primary)", fontFamily: "'Inter', system-ui, sans-serif", minHeight: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em" }}>AI Voice Studio</h1>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 4 }}>
            Generate station IDs, weather, news intros, and more from text. Configured in Settings → AI Voice Generation.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={refresh} style={btnStyle}>↻ Refresh</button>
          {onClose && <button onClick={onClose} style={btnStyle}>Close</button>}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
        {(["compose","library","templates"] as const).map(t => (
          <button key={t} onClick={() => setActiveTab(t)} style={{
            padding: "8px 18px", borderRadius: 0, fontSize: 12, fontWeight: 700,
            background: activeTab === t ? "var(--accent-blue)" : "var(--bg-secondary)",
            color:      activeTab === t ? "#fff" : "var(--text-secondary)",
            border: activeTab === t ? "none" : "1px solid var(--border-primary)",
            cursor: "pointer", textTransform: "uppercase" as any, letterSpacing: "0.06em",
          }}>{t === "compose" ? "Compose" : t === "library" ? `Library (${segments.length})` : `Templates (${templates.length})`}</button>
        ))}
      </div>

      {activeTab === "compose"   && <ComposeTab templates={templates} onGenerated={refresh} />}
      {activeTab === "library"   && <LibraryTab segments={segments} loading={loading} playing={playing} setPlaying={setPlaying} onRefresh={refresh} />}
      {activeTab === "templates" && <TemplatesTab templates={templates} onChange={refresh} />}
    </div>
  );
}

// ── Compose tab — pick a template, fill vars, generate ──
function ComposeTab({ templates, onGenerated }: { templates: Template[]; onGenerated: () => void }) {
  const ether = (window as any).ether;
  const [selectedId, setSelectedId] = useState<number | "free">("free");
  const [freeText, setFreeText]     = useState("");
  const [title, setTitle]           = useState("");
  const [vars, setVars]             = useState<Record<string, string>>({});
  const [generating, setGenerating] = useState(false);
  const [status, setStatus]         = useState("");
  const [previewAudio, setPreviewAudio] = useState<string | null>(null);

  const selected = selectedId === "free" ? null : templates.find(t => t.id === selectedId);
  const promptText = selected?.prompt_template || freeText;
  const varNames = useMemo(() => selected ? extractVars(selected.prompt_template) : [], [selected]);

  // Auto-fill some common vars on template select
  useEffect(() => {
    if (!selected) return;
    const now = new Date();
    const initialVars: Record<string, string> = {};
    varNames.forEach(name => {
      if (name === "time")        initialVars[name] = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      else if (name === "hour")   initialVars[name] = now.toLocaleTimeString([], { hour: "numeric" });
      else if (name === "stationName") initialVars[name] = "Ether Radio";
      else initialVars[name] = vars[name] || "";
    });
    setVars(initialVars);
    if (!title) setTitle(selected.name + " — " + now.toLocaleString());
  }, [selectedId]);

  const finalScript = selected ? renderTemplate(selected.prompt_template, vars) : freeText;

  const generate = async () => {
    if (!finalScript.trim()) { setStatus("✗ Need some text to generate"); return; }
    setGenerating(true); setStatus("Generating…"); setPreviewAudio(null);
    try {
      const r = await ether.ai.generate({
        title: title || (selected?.name || "Ad-hoc clip"),
        script: finalScript,
        templateId: selected?.id || null,
        providerOverride: selected?.provider || null,
        voiceIdOverride: selected?.voice_id || null,
      });
      if (r?.ok) {
        setStatus("✓ Generated " + (r.segment?.size_bytes ? `(${Math.round(r.segment.size_bytes / 1024)} KB)` : ""));
        if (r.segment?.file_path) setPreviewAudio("file:///" + r.segment.file_path.replace(/\\/g, "/"));
        onGenerated();
      } else {
        setStatus("✗ " + (r?.error || "failed"));
      }
    } catch (e: any) {
      setStatus("✗ " + (e?.message || e));
    }
    setGenerating(false);
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 14 }}>
      {/* Left: template picker */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.08em", marginBottom: 8 }}>Pick a starting point</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <button onClick={() => setSelectedId("free")} style={tplBtnStyle(selectedId === "free")}>
            <div style={{ fontWeight: 700 }}>Free-form text</div>
            <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>Type any script directly</div>
          </button>
          {templates.map(t => (
            <button key={t.id} onClick={() => setSelectedId(t.id)} style={tplBtnStyle(selectedId === t.id)}>
              <div style={{ fontWeight: 700 }}>{t.name}</div>
              <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 2 }}>{t.kind} · {extractVars(t.prompt_template).length} vars</div>
            </button>
          ))}
        </div>
      </div>

      {/* Right: editor */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="Segment title">
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. 'Morning weather - 8 AM'" style={inputStyle} />
        </Field>

        {selected ? (
          <>
            <Field label="Template (read-only)">
              <div style={{ ...inputStyle, fontFamily: "ui-monospace, monospace", fontSize: 12, padding: "10px 12px", whiteSpace: "pre-wrap" as any, color: "var(--text-secondary)", background: "var(--bg-tertiary)" }}>
                {promptText}
              </div>
            </Field>
            {varNames.length > 0 && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.08em", marginBottom: 6 }}>Fill in variables</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8 }}>
                  {varNames.map(v => (
                    <div key={v}>
                      <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 3, fontFamily: "ui-monospace, monospace" }}>{`{{${v}}}`}</div>
                      <input value={vars[v] || ""} onChange={e => setVars(p => ({ ...p, [v]: e.target.value }))} placeholder={v} style={inputStyle} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <Field label="Script">
            <textarea value={freeText} onChange={e => setFreeText(e.target.value)} rows={5}
              placeholder="Type the exact text the AI voice should read…"
              style={{ ...inputStyle, fontFamily: "inherit", resize: "vertical" as any, lineHeight: 1.6 }} />
          </Field>
        )}

        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.08em", marginBottom: 4 }}>Final script (sent to TTS)</div>
          <div style={{
            padding: "10px 14px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
            fontSize: 13, lineHeight: 1.6, color: "var(--text-primary)", minHeight: 56,
          }}>
            {finalScript || <span style={{ color: "var(--text-tertiary)", fontStyle: "italic" }}>Empty — write something above</span>}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4 }}>{finalScript.length} characters</div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", paddingTop: 4 }}>
          <button onClick={generate} disabled={generating || !finalScript.trim()} style={{
            padding: "10px 24px", borderRadius: 0, fontSize: 13, fontWeight: 700,
            background: generating ? "var(--bg-tertiary)" : "var(--accent-blue)",
            color: generating ? "var(--text-tertiary)" : "#fff",
            border: "none", cursor: generating || !finalScript.trim() ? "not-allowed" : "pointer",
          }}>
            {generating ? "Generating…" : "🎙 Generate Voice"}
          </button>
          {status && <span style={{ fontSize: 12, color: status.startsWith("✓") ? "#22c55e" : status.startsWith("✗") ? "#ef4444" : "var(--text-tertiary)" }}>{status}</span>}
        </div>

        {previewAudio && <audio src={previewAudio} controls autoPlay style={{ width: "100%", marginTop: 4 }} />}
      </div>
    </div>
  );
}

// ── Library tab — generated segments + actions ──
function LibraryTab({ segments, loading, playing, setPlaying, onRefresh }:
  { segments: Segment[]; loading: boolean; playing: number | null; setPlaying: (n: number | null) => void; onRefresh: () => void }) {
  const engine = useAudioEngine();
  const ether = (window as any).ether;
  const [filter, setFilter] = useState<"all" | SegmentStatus>("all");

  const filtered = segments.filter(s => filter === "all" || s.status === filter);

  const sendToQueue = (s: Segment) => {
    if (!s.file_path) return;
    try {
      engine.addToQueue([{
        filePath: s.file_path,
        title:  s.title || `AI segment #${s.id}`,
        artist: `🤖 AI Voice (${s.provider})`,
      }]);
      ether.ai.updateSegment(s.id, { status: "played" }).then(onRefresh);
    } catch (e) { console.error(e); }
  };

  const archive = (s: Segment) => ether.ai.updateSegment(s.id, { status: "archived" }).then(onRefresh);
  const reactivate = (s: Segment) => ether.ai.updateSegment(s.id, { status: "ready" }).then(onRefresh);
  const del = (s: Segment) => {
    if (!confirm(`Delete "${s.title}"? The audio file will be removed.`)) return;
    ether.ai.deleteSegment(s.id).then(onRefresh);
  };

  const counts: Record<string, number> = { all: segments.length };
  segments.forEach(s => { counts[s.status] = (counts[s.status] || 0) + 1; });

  return (
    <div>
      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        {(["all","ready","generating","played","error","archived"] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            padding: "6px 12px", borderRadius: 0, fontSize: 12, fontWeight: 600,
            background: filter === f ? "var(--accent-blue)" : "var(--bg-secondary)",
            color:      filter === f ? "#fff" : "var(--text-secondary)",
            border: filter === f ? "none" : "1px solid var(--border-primary)",
            cursor: "pointer", textTransform: "capitalize" as any,
          }}>{f} ({counts[f] || 0})</button>
        ))}
      </div>

      {loading && segments.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center" as any, color: "var(--text-tertiary)" }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: 60, textAlign: "center" as any, background: "var(--bg-secondary)", border: "1px dashed var(--border-primary)" }}>
          <div style={{ fontSize: 14, color: "var(--text-secondary)" }}>No segments {filter !== "all" ? `with status "${filter}"` : "yet"}</div>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 4 }}>Generate one in the Compose tab</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {filtered.map(s => (
            <div key={s.id} style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", padding: "12px 14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>{s.title}</span>
                    <span style={{
                      padding: "2px 7px", fontSize: 10, fontWeight: 700, letterSpacing: "0.04em",
                      background: STATUS_COLOR[s.status] + "22", color: STATUS_COLOR[s.status],
                      textTransform: "uppercase" as any,
                    }}>{s.status}</span>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-tertiary)", display: "flex", gap: 10, flexWrap: "wrap" as any }}>
                    <span>🤖 {s.provider}/{s.voice_id || "?"}</span>
                    <span>{fmtBytes(s.size_bytes)}</span>
                    <span>{fmtAgo(s.generated_at || s.created_at)}</span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4, fontStyle: "italic", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.script}>
                    "{s.script}"
                  </div>
                  {s.status === "error" && s.error_msg && (
                    <div style={{ fontSize: 11, color: "#ef4444", marginTop: 4 }}>Error: {s.error_msg}</div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  {s.file_path && (
                    <button onClick={() => setPlaying(playing === s.id ? null : s.id)} style={miniBtn}>
                      {playing === s.id ? "Hide" : "▶ Play"}
                    </button>
                  )}
                  {s.status === "ready" && (
                    <button onClick={() => sendToQueue(s)} style={{ ...miniBtn, background: "var(--accent-blue)", color: "#fff", border: "none" }}>→ Queue</button>
                  )}
                  {s.status === "archived" ? (
                    <button onClick={() => reactivate(s)} style={miniBtn}>↺ Restore</button>
                  ) : s.status !== "generating" && (
                    <button onClick={() => archive(s)} style={miniBtn}>Archive</button>
                  )}
                  <button onClick={() => del(s)} style={{ ...miniBtn, color: "#ef4444" }}>Del</button>
                </div>
              </div>
              {playing === s.id && s.file_path && (
                <audio src={"file:///" + s.file_path.replace(/\\/g, "/")} controls autoPlay
                  style={{ width: "100%", marginTop: 8 }}
                  onError={() => alert("Playback failed — file may be missing")} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Templates tab — manage reusable prompts ──
function TemplatesTab({ templates, onChange }: { templates: Template[]; onChange: () => void }) {
  const ether = (window as any).ether;
  const [editing, setEditing] = useState<Template | null>(null);
  const [adding, setAdding]   = useState(false);

  const del = async (t: Template) => {
    if (!confirm(`Delete template "${t.name}"?`)) return;
    await ether.ai.deleteTemplate(t.id);
    onChange();
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
          Reusable prompts with <code>{"{{variables}}"}</code>. Use these in Compose for one-click generation.
        </div>
        <button onClick={() => setAdding(true)} style={{
          padding: "7px 14px", borderRadius: 0, fontSize: 12, fontWeight: 600,
          background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer",
        }}>+ New Template</button>
      </div>

      {templates.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center" as any, color: "var(--text-tertiary)", background: "var(--bg-secondary)", border: "1px dashed var(--border-primary)" }}>No templates yet</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {templates.map(t => (
            <div key={t.id} style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", padding: "12px 14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>{t.name}</span>
                    <span style={{ fontSize: 10, padding: "2px 7px", background: "var(--bg-tertiary)", color: "var(--text-tertiary)", letterSpacing: "0.04em", textTransform: "uppercase" as any }}>{t.kind}</span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)", fontFamily: "ui-monospace, monospace", marginTop: 4 }}>{t.prompt_template}</div>
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                  <button onClick={() => setEditing(t)} style={miniBtn}>Edit</button>
                  <button onClick={() => del(t)} style={{ ...miniBtn, color: "#ef4444" }}>Del</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {(adding || editing) && (
        <TemplateForm
          initial={editing || { id: 0, name: "", kind: "evergreen", prompt_template: "", voice_id: "", provider: "", created_at: 0 }}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSave={async (t) => {
            await ether.ai.saveTemplate(t);
            setAdding(false); setEditing(null);
            onChange();
          }}
        />
      )}
    </div>
  );
}

function TemplateForm({ initial, onClose, onSave }: { initial: Template; onClose: () => void; onSave: (t: Partial<Template>) => void }) {
  const [name, setName] = useState(initial.name);
  const [kind, setKind] = useState(initial.kind);
  const [prompt, setPrompt] = useState(initial.prompt_template);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
        width: "100%", maxWidth: 520, padding: "20px 22px", borderRadius: 0,
      }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, marginBottom: 14 }}>
          {initial.id ? "Edit" : "New"} Template
        </h3>
        <Field label="Name"><input value={name} onChange={e => setName(e.target.value)} style={inputStyle} placeholder="e.g. 'Morning weather'" /></Field>
        <Field label="Kind">
          <select value={kind} onChange={e => setKind(e.target.value)} style={inputStyle}>
            <option value="evergreen">Evergreen — manually triggered</option>
            <option value="recurring">Recurring — auto-regenerated on schedule</option>
            <option value="one_shot">One-shot — for a specific moment</option>
          </select>
        </Field>
        <Field label="Prompt template (use {{variableName}} for fillable values)">
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={4}
            style={{ ...inputStyle, fontFamily: "ui-monospace, monospace", fontSize: 12, lineHeight: 1.6, resize: "vertical" as any }}
            placeholder='e.g. "Right now in {{city}} it is {{temperature}} degrees."' />
        </Field>
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: -4, marginBottom: 8 }}>
          Variables found: {extractVars(prompt).length === 0 ? <i>none</i> : extractVars(prompt).map(v => <code key={v} style={{ marginRight: 6 }}>{`{{${v}}}`}</code>)}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border-primary)" }}>
          <button onClick={onClose} style={btnStyle}>Cancel</button>
          <button onClick={() => onSave({ id: initial.id, name, kind, prompt_template: prompt })} disabled={!name || !prompt} style={{
            ...btnStyle, background: name && prompt ? "var(--accent-blue)" : "var(--bg-tertiary)",
            color: name && prompt ? "#fff" : "var(--text-tertiary)",
            border: "none", cursor: name && prompt ? "pointer" : "not-allowed",
          }}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ── Styles ──
const btnStyle: React.CSSProperties = {
  padding: "7px 14px", borderRadius: 0, fontSize: 12, fontWeight: 600,
  background: "var(--bg-tertiary)", color: "var(--text-secondary)",
  border: "1px solid var(--border-primary)", cursor: "pointer",
};
const miniBtn: React.CSSProperties = {
  padding: "4px 10px", borderRadius: 0, fontSize: 11, fontWeight: 600,
  background: "var(--bg-tertiary)", color: "var(--text-secondary)",
  border: "1px solid var(--border-primary)", cursor: "pointer",
};
const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 0, fontSize: 13,
  background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
  color: "var(--text-primary)", outline: "none", boxSizing: "border-box",
};
function tplBtnStyle(active: boolean): React.CSSProperties {
  return {
    padding: "10px 12px", borderRadius: 0, fontSize: 12, textAlign: "left" as any,
    background: active ? "var(--accent-blue)" : "var(--bg-secondary)",
    color: active ? "#fff" : "var(--text-secondary)",
    border: active ? "none" : "1px solid var(--border-primary)",
    cursor: "pointer",
  };
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      {label && <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", marginBottom: 4, letterSpacing: "0.04em", textTransform: "uppercase" as any }}>{label}</div>}
      {children}
    </div>
  );
}
