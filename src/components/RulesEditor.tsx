import { useState, useEffect } from "react";
import { query, execute } from "../db/client";

interface Rule {
  id: number; rule_type: string; scope: string;
  value: number; is_hard: number; is_active: number;
  description: string | null;
}

const RULE_LABELS: Record<string, string> = {
  artist_separation_min: "Artist Separation (minutes)",
  song_separation_min: "Song Separation (minutes)",
  title_separation_min: "Title Separation (minutes)",
  max_same_gender: "Max Consecutive Same Gender",
  max_same_category: "Max Consecutive Same Category",
};

export default function RulesEditor() {
  const [rules, setRules] = useState<Rule[]>([]);

  const load = async () => { setRules(await query<Rule>("SELECT * FROM separation_rules ORDER BY id")); };
  useEffect(() => { load(); }, []);

  const update = async (id: number, field: string, val: number) => {
    await execute("UPDATE separation_rules SET " + field + " = ? WHERE id = ?", [val, id]);
    load();
  };

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-bold text-zinc-300">Scheduling Rules</h2>
      <div className="text-xs text-zinc-500">These rules control how the log generator picks songs. Hard rules block violations entirely. Soft rules penalize but still allow if no better option exists.</div>
      <div className="space-y-2">
        {rules.map(r => (
          <div key={r.id} className="bg-zinc-900 rounded-lg border border-zinc-800 p-3 flex items-center justify-between">
            <div className="flex-1">
              <div className="text-xs text-zinc-100 font-medium">{RULE_LABELS[r.rule_type] || r.rule_type}</div>
              <div className="text-[10px] text-zinc-500">{r.description}</div>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-zinc-500">Value:</span>
                <input type="number" className="w-16 px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100 text-center" value={r.value} onChange={e => update(r.id, "value", parseInt(e.target.value) || 0)} />
              </div>
              <button onClick={() => update(r.id, "is_hard", r.is_hard ? 0 : 1)} className={r.is_hard ? "px-2 py-1 rounded text-[10px] font-bold bg-red-700 text-white" : "px-2 py-1 rounded text-[10px] font-bold bg-zinc-700 text-zinc-400"}>{r.is_hard ? "HARD" : "SOFT"}</button>
              <button onClick={() => update(r.id, "is_active", r.is_active ? 0 : 1)} className={r.is_active ? "px-2 py-1 rounded text-[10px] font-bold bg-emerald-700 text-white" : "px-2 py-1 rounded text-[10px] font-bold bg-zinc-800 text-zinc-500"}>{r.is_active ? "ON" : "OFF"}</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}