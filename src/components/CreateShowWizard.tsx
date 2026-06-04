// src/components/CreateShowWizard.tsx
// 4-step wizard to create a new Show with daypart, format clock, and music category.

import { useState, useEffect, useCallback } from "react";
import { queryScoped } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";

// ── Types ─────────────────────────────────────────────────────

interface Category {
  id: number; code: string; name: string; color: string | null;
}

interface Clock {
  id: number; name: string;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const DAYS  = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtHour(h: number): string {
  if (h === 0) return "12 AM";
  if (h === 12) return "12 PM";
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

const CAT_COLORS = ["#6040c0","#a78bfa","#34d399","#f87171","#fbbf24","#fb923c","#e879f9","#8868D8"];

// ── Shared step card ──────────────────────────────────────────

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
      borderRadius: 0, padding: "20px 24px",
    }}>
      {children}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.12em", textTransform: "uppercase" as const, color: "var(--text-tertiary)", marginBottom: 6 }}>
      {children}
    </div>
  );
}

// ── Progress indicator ────────────────────────────────────────

function ProgressBar({ step, total }: { step: number; total: number }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 28 }}>
      {Array.from({ length: total }).map((_, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{
            width: 28, height: 28, borderRadius: "50%",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 11, fontWeight: 800,
            background: i < step ? "var(--accent-blue)" : i === step ? "rgba(96,64,192,0.2)" : "var(--bg-tertiary)",
            color: i < step ? "#fff" : i === step ? "var(--accent-blue)" : "var(--text-tertiary)",
            border: i === step ? "1px solid var(--accent-blue)" : "1px solid var(--border-primary)",
            transition: "all 0.2s",
          }}>
            {i < step ? "✓" : i + 1}
          </div>
          {i < total - 1 && (
            <div style={{
              width: 40, height: 2,
              background: i < step ? "var(--accent-blue)" : "var(--border-primary)",
              transition: "background 0.3s",
            }} />
          )}
        </div>
      ))}
      <span style={{ marginLeft: 8, fontSize: 11, color: "var(--text-tertiary)" }}>
        Step {step + 1} of {total}
      </span>
    </div>
  );
}

// ── Wizard ────────────────────────────────────────────────────

interface Props {
  onClose: () => void;
  onDone: () => void;
}

export default function CreateShowWizard({ onClose, onDone }: Props) {
  const { stationId, isReady } = useActiveStation();
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  // Step 1: Show name + daypart
  const [showName, setShowName]       = useState("");
  const [startHour, setStartHour]     = useState(6);
  const [endHour, setEndHour]         = useState(10);
  const [activeDays, setActiveDays]   = useState("0123456");
  const [showColor, setShowColor]     = useState("#6040c0");

  // Step 2: Format Clock
  const [clocks, setClocks]           = useState<Clock[]>([]);
  const [selectedClockId, setSelectedClockId] = useState<number | null>(null);
  const [newClockName, setNewClockName] = useState("");
  const [creatingClock, setCreatingClock] = useState(false);
  const [clockCreated, setClockCreated] = useState(false);

  // Step 3: Music Category
  const [categories, setCategories]   = useState<Category[]>([]);
  const [selectedCatId, setSelectedCatId] = useState<number | null>(null);
  const [newCatCode, setNewCatCode]   = useState("");
  const [newCatName, setNewCatName]   = useState("");
  const [newCatColor, setNewCatColor] = useState("#6040c0");
  const [creatingCat, setCreatingCat] = useState(false);
  const [catCreated, setCatCreated]   = useState(false);

  const loadClocks = useCallback(async () => {
    if (!isReady) return;
    try {
      const rows = await queryScoped<Clock>("SELECT id, name FROM clocks ORDER BY name", [], stationId);
      setClocks(rows);
    } catch {}
  }, [isReady, stationId]);

  const loadCategories = useCallback(async () => {
    if (!isReady) return;
    try {
      const rows = await queryScoped<Category>("SELECT id, code, name, color FROM categories ORDER BY code", [], stationId);
      setCategories(rows);
    } catch {}
  }, [isReady, stationId]);

  useEffect(() => { loadClocks(); loadCategories(); }, [loadClocks, loadCategories]);

  const toggleDay = (i: number) => {
    const d = String(i);
    setActiveDays(prev =>
      prev.includes(d) ? prev.replace(d, "") : (prev + d).split("").sort().join("")
    );
  };

  const createClock = async () => {
    if (!newClockName.trim()) return;
    setCreatingClock(true);
    try {
      const res = await (window as any).ether.clocks.create({ station_id: stationId, name: newClockName.trim() });
      setSelectedClockId(res.row.id);
      setNewClockName("");
      setClockCreated(true);
      setTimeout(() => setClockCreated(false), 2000);
    } catch {}
    setCreatingClock(false);
  };

  const createCategory = async () => {
    if (!newCatCode.trim() || !newCatName.trim()) return;
    setCreatingCat(true);
    try {
      const res = await (window as any).ether.categories.create({ station_id: stationId, code: newCatCode.trim().toUpperCase(), name: newCatName.trim(), color: newCatColor, spins_per_hour: 0, priority: 0 });
      await loadCategories();
      if (res.row?.id) setSelectedCatId(res.row.id);
      setNewCatCode(""); setNewCatName(""); setNewCatColor("#6040c0");
      setCatCreated(true);
      setTimeout(() => setCatCreated(false), 2000);
    } catch {}
    setCreatingCat(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError("");
    try {
      await (window as any).ether.shows.create({
        station_id: stationId, name: showName.trim(), start_hour: startHour, end_hour: endHour,
        color: showColor, days: activeDays || "0123456", is_active: 1, clock_id: selectedClockId,
      });
      onDone();
    } catch (e: any) {
      setSaveError(e?.message || "Save failed");
    }
    setSaving(false);
  };

  const canNext = [
    showName.trim().length > 0,         // step 0
    true,                                // step 1 — clock optional
    true,                                // step 2 — category optional
    true,                                // step 3 — review
  ][step];

  const stepLabels = ["Name & Daypart", "Format Clock", "Music Category", "Review"];

  return (
    <div style={{
      position: "fixed" as const, inset: 0, zIndex: 10000,
      background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div style={{
        width: 560, maxHeight: "90vh",
        background: "var(--bg-primary)", border: "1px solid var(--border-secondary)",
        borderRadius: 0, overflow: "auto",
        boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
      }}>
        {/* Header */}
        <div style={{
          padding: "18px 24px", borderBottom: "1px solid var(--border-primary)",
          background: "var(--bg-secondary)",
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "'Syne', sans-serif", color: "var(--text-primary)", letterSpacing: "-0.02em" }}>
              Create Show
            </div>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>{stepLabels[step]}</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 18 }}>✕</button>
        </div>

        {/* Body */}
        <div style={{ padding: "24px" }}>
          <ProgressBar step={step} total={4} />

          {/* ── Step 0: Name + Daypart ── */}
          {step === 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <Card>
                <Label>Show Name</Label>
                <input
                  autoFocus
                  value={showName}
                  onChange={e => setShowName(e.target.value)}
                  placeholder="e.g. Morning Drive, Late Night Jazz..."
                  onKeyDown={e => { if (e.key === "Enter" && canNext) setStep(1); }}
                  style={{
                    width: "100%", padding: "9px 12px", borderRadius: 0, fontSize: 14,
                    background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
                    color: "var(--text-primary)", outline: "none", boxSizing: "border-box" as const,
                    fontWeight: 600,
                  }}
                />
              </Card>
              <Card>
                <Label>Time Range</Label>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <select value={startHour} onChange={e => setStartHour(+e.target.value)}
                    style={{ flex: 1, padding: "8px 10px", borderRadius: 0, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }}>
                    {HOURS.map(h => <option key={h} value={h}>{fmtHour(h)}</option>)}
                  </select>
                  <span style={{ color: "var(--text-tertiary)", fontSize: 13 }}>to</span>
                  <select value={endHour} onChange={e => setEndHour(+e.target.value)}
                    style={{ flex: 1, padding: "8px 10px", borderRadius: 0, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }}>
                    {HOURS.map(h => <option key={h} value={h}>{fmtHour(h)}</option>)}
                  </select>
                </div>
                {endHour !== 0 && endHour <= startHour && (
                  <div style={{ marginTop: 6, fontSize: 10, color: "#fbbf24" }}>
                    ⚠ End hour is before start hour — this will be treated as an overnight show.
                  </div>
                )}
              </Card>
              <Card>
                <Label>Active Days</Label>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {DAYS.map((d, i) => {
                    const on = activeDays.includes(String(i));
                    return (
                      <button key={i} onClick={() => toggleDay(i)} style={{
                        padding: "6px 10px", borderRadius: 0, fontSize: 11, fontWeight: 700, cursor: "pointer",
                        background: on ? "var(--accent-blue)" : "var(--bg-tertiary)",
                        color: on ? "#fff" : "var(--text-tertiary)",
                        border: `1px solid ${on ? "var(--accent-blue)" : "var(--border-primary)"}`,
                        transition: "all 0.15s",
                      }}>{d}</button>
                    );
                  })}
                </div>
              </Card>
              <Card>
                <Label>Show Color</Label>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  {CAT_COLORS.map(c => (
                    <button key={c} onClick={() => setShowColor(c)} style={{
                      width: 28, height: 28, borderRadius: "50%", background: c, border: "none", cursor: "pointer",
                      outline: showColor === c ? `3px solid ${c}` : "none",
                      outlineOffset: 2, transition: "outline 0.15s",
                    }} />
                  ))}
                  <input type="color" value={showColor} onChange={e => setShowColor(e.target.value)}
                    style={{ width: 32, height: 28, borderRadius: 0, border: "1px solid var(--border-primary)", cursor: "pointer", padding: 2, background: "var(--bg-tertiary)" }} />
                </div>
              </Card>
            </div>
          )}

          {/* ── Step 1: Format Clock ── */}
          {step === 1 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <Card>
                <Label>Choose an existing Format Clock</Label>
                {clocks.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--text-tertiary)", padding: "8px 0" }}>No clocks created yet.</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 180, overflowY: "auto" }}>
                    {clocks.map(c => (
                      <button key={c.id} onClick={() => setSelectedClockId(c.id)} style={{
                        display: "flex", alignItems: "center", gap: 10,
                        padding: "9px 12px", borderRadius: 0, cursor: "pointer", textAlign: "left" as const,
                        background: selectedClockId === c.id ? "rgba(96,64,192,0.12)" : "var(--bg-tertiary)",
                        border: `1px solid ${selectedClockId === c.id ? "rgba(96,64,192,0.4)" : "var(--border-primary)"}`,
                        color: "var(--text-primary)", fontSize: 13, fontWeight: selectedClockId === c.id ? 700 : 400,
                        transition: "all 0.15s",
                      }}>
                        <span style={{ color: "var(--accent-blue)", fontSize: 14 }}>{selectedClockId === c.id ? "●" : "○"}</span>
                        {c.name}
                      </button>
                    ))}
                  </div>
                )}
                {selectedClockId !== null && (
                  <button onClick={() => setSelectedClockId(null)} style={{
                    marginTop: 8, fontSize: 10, color: "var(--text-tertiary)", background: "none", border: "none", cursor: "pointer", padding: 0,
                  }}>Clear selection (no clock)</button>
                )}
              </Card>
              <Card>
                <Label>Or create a new Format Clock</Label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    value={newClockName}
                    onChange={e => setNewClockName(e.target.value)}
                    placeholder="Clock name..."
                    onKeyDown={e => { if (e.key === "Enter") createClock(); }}
                    style={{ flex: 1, padding: "8px 10px", borderRadius: 0, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }}
                  />
                  <button onClick={createClock} disabled={creatingClock || !newClockName.trim()} style={{
                    padding: "8px 16px", borderRadius: 0, fontSize: 11, fontWeight: 700,
                    background: "var(--accent-blue)", color: "#fff", border: "none",
                    cursor: creatingClock || !newClockName.trim() ? "default" : "pointer",
                    opacity: !newClockName.trim() ? 0.5 : 1,
                  }}>
                    {creatingClock ? "Creating..." : "Create"}
                  </button>
                </div>
                {clockCreated && (
                  <div style={{ marginTop: 8, fontSize: 11, color: "#34d399" }}>
                    ✓ Clock created and selected. You can open the Clock Editor later to add slots.
                  </div>
                )}
              </Card>
            </div>
          )}

          {/* ── Step 2: Music Category ── */}
          {step === 2 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <Card>
                <Label>Choose an existing Music Category</Label>
                {categories.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--text-tertiary)", padding: "8px 0" }}>No categories created yet.</div>
                ) : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {categories.map(c => (
                      <button key={c.id} onClick={() => setSelectedCatId(selectedCatId === c.id ? null : c.id)} style={{
                        display: "flex", alignItems: "center", gap: 6,
                        padding: "7px 12px", borderRadius: 0, cursor: "pointer",
                        background: selectedCatId === c.id ? (c.color ? c.color + "22" : "rgba(96,64,192,0.12)") : "var(--bg-tertiary)",
                        border: `1px solid ${selectedCatId === c.id ? (c.color || "rgba(96,64,192,0.4)") : "var(--border-primary)"}`,
                        color: "var(--text-primary)", fontSize: 12, fontWeight: selectedCatId === c.id ? 700 : 400,
                        transition: "all 0.15s",
                      }}>
                        {c.color && <span style={{ width: 8, height: 8, borderRadius: "50%", background: c.color, flexShrink: 0 }} />}
                        <span style={{ fontWeight: 700, color: c.color || "var(--text-primary)" }}>{c.code}</span>
                        <span style={{ color: "var(--text-secondary)" }}>{c.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </Card>
              <Card>
                <Label>Or create a new Music Category</Label>
                <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                  <input value={newCatCode} onChange={e => setNewCatCode(e.target.value.toUpperCase().slice(0, 6))}
                    placeholder="Code (e.g. AC)"
                    style={{ width: 80, padding: "8px 10px", borderRadius: 0, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }}
                  />
                  <input value={newCatName} onChange={e => setNewCatName(e.target.value)}
                    placeholder="Name (e.g. Adult Contemporary)"
                    onKeyDown={e => { if (e.key === "Enter") createCategory(); }}
                    style={{ flex: 1, padding: "8px 10px", borderRadius: 0, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }}
                  />
                  <input type="color" value={newCatColor} onChange={e => setNewCatColor(e.target.value)}
                    style={{ width: 36, height: 36, borderRadius: 0, border: "1px solid var(--border-primary)", cursor: "pointer", padding: 2, background: "var(--bg-tertiary)" }} />
                </div>
                <button onClick={createCategory} disabled={creatingCat || !newCatCode.trim() || !newCatName.trim()} style={{
                  padding: "8px 16px", borderRadius: 0, fontSize: 11, fontWeight: 700,
                  background: "var(--accent-blue)", color: "#fff", border: "none",
                  cursor: creatingCat || !newCatCode.trim() || !newCatName.trim() ? "default" : "pointer",
                  opacity: !newCatCode.trim() || !newCatName.trim() ? 0.5 : 1,
                }}>
                  {creatingCat ? "Creating..." : "Create Category"}
                </button>
                {catCreated && (
                  <div style={{ marginTop: 8, fontSize: 11, color: "#34d399" }}>
                    ✓ Category created and selected. Add songs to it in the Song Library.
                  </div>
                )}
              </Card>
            </div>
          )}

          {/* ── Step 3: Review ── */}
          {step === 3 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <Card>
                <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
                  <div style={{ width: 48, height: 48, borderRadius: 0, background: showColor + "22", border: `2px solid ${showColor}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <div style={{ width: 16, height: 16, borderRadius: "50%", background: showColor }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "'Syne', sans-serif", color: "var(--text-primary)", letterSpacing: "-0.02em" }}>{showName || "(no name)"}</div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
                      {fmtHour(startHour)} – {fmtHour(endHour)}
                      {endHour !== 0 && endHour <= startHour ? " (overnight)" : ""}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
                      {activeDays.split("").map(d => DAYS[+d]).join(" · ")}
                    </div>
                  </div>
                </div>
              </Card>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Card>
                  <Label>Format Clock</Label>
                  {selectedClockId
                    ? <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                        {clocks.find(c => c.id === selectedClockId)?.name || "Unknown"}
                      </div>
                    : <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>None assigned — you can add one later</div>
                  }
                </Card>
                <Card>
                  <Label>Music Category</Label>
                  {selectedCatId
                    ? (() => {
                        const cat = categories.find(c => c.id === selectedCatId);
                        return (
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            {cat?.color && <span style={{ width: 10, height: 10, borderRadius: "50%", background: cat.color }} />}
                            <span style={{ fontSize: 13, fontWeight: 600, color: cat?.color || "var(--text-primary)" }}>{cat?.code}</span>
                            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{cat?.name}</span>
                          </div>
                        );
                      })()
                    : <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>None — assign songs via Library</div>
                  }
                </Card>
              </div>
              {saveError && (
                <div style={{ padding: "10px 14px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 0, fontSize: 12, color: "#ef4444" }}>
                  {saveError}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Footer nav ── */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 24px", borderTop: "1px solid var(--border-primary)",
          background: "var(--bg-secondary)",
        }}>
          <button onClick={step === 0 ? onClose : () => setStep(s => s - 1)} style={{
            padding: "8px 18px", borderRadius: 0, fontSize: 12, fontWeight: 600, cursor: "pointer",
            background: "var(--bg-tertiary)", color: "var(--text-secondary)",
            border: "1px solid var(--border-primary)",
          }}>
            {step === 0 ? "Cancel" : "← Back"}
          </button>

          <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>
            {stepLabels[step]}
          </div>

          {step < 3 ? (
            <button onClick={() => setStep(s => s + 1)} disabled={!canNext} style={{
              padding: "8px 20px", borderRadius: 0, fontSize: 12, fontWeight: 700, cursor: canNext ? "pointer" : "default",
              background: canNext ? "var(--accent-blue)" : "var(--bg-tertiary)",
              color: canNext ? "#fff" : "var(--text-tertiary)",
              border: `1px solid ${canNext ? "var(--accent-blue)" : "var(--border-primary)"}`,
              transition: "all 0.15s",
            }}>
              Next →
            </button>
          ) : (
            <button onClick={handleSave} disabled={saving || !showName.trim()} style={{
              padding: "8px 20px", borderRadius: 0, fontSize: 12, fontWeight: 700,
              cursor: saving || !showName.trim() ? "default" : "pointer",
              background: saving ? "var(--bg-tertiary)" : "rgba(52,211,153,0.15)",
              color: saving ? "var(--text-tertiary)" : "#34d399",
              border: `1px solid ${saving ? "var(--border-primary)" : "rgba(52,211,153,0.4)"}`,
              transition: "all 0.15s",
            }}>
              {saving ? "Saving..." : "✓ Create Show"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
