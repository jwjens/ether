const fs = require('fs');

console.log('\n  Ether — Scheduled Announcements\n');

// ============================================================
// 1. Add announcements table
// ============================================================

let client = fs.readFileSync('src/db/client.ts', 'utf8');
if (!client.includes('announcements')) {
  client = client.replace(
    '  console.log("DB ready");',
    [
      '  await d.execute("CREATE TABLE IF NOT EXISTS announcements (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, file_path TEXT NOT NULL, trigger_time TEXT NOT NULL, days TEXT NOT NULL DEFAULT \'0123456\', duck_music INTEGER NOT NULL DEFAULT 1, resume_music INTEGER NOT NULL DEFAULT 1, duck_level REAL NOT NULL DEFAULT 0.1, is_active INTEGER NOT NULL DEFAULT 1, last_played_at INTEGER, created_at INTEGER NOT NULL DEFAULT (unixepoch()))");',
      '  console.log("DB ready");',
    ].join('\n')
  );
  fs.writeFileSync('src/db/client.ts', client, 'utf8');
  console.log('  UPDATED client.ts (announcements table)');
}

// ============================================================
// 2. Create Announcements component
// ============================================================

fs.mkdirSync('src/components', { recursive: true });
fs.writeFileSync('src/components/Announcements.tsx', `import { useState, useEffect } from "react";
import { query, execute, queryOne } from "../db/client";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { engine } from "../audio/engine";

interface Announcement {
  id: number;
  title: string;
  file_path: string;
  trigger_time: string;
  days: string;
  duck_music: number;
  resume_music: number;
  duck_level: number;
  is_active: number;
  last_played_at: number | null;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtTime(t: string): string {
  const [h, m] = t.split(":");
  const hr = parseInt(h);
  const ampm = hr >= 12 ? "PM" : "AM";
  const h12 = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr;
  return h12 + ":" + m + " " + ampm;
}

// The announcement engine - checks every 10 seconds
let announcementTimer: any = null;
let lastFiredMinute = "";

async function checkAnnouncements() {
  const now = new Date();
  const currentTime = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
  const currentDay = String(now.getDay());

  // Don't fire the same minute twice
  if (currentTime === lastFiredMinute) return;

  try {
    const announcements = await query<Announcement>(
      "SELECT * FROM announcements WHERE is_active = 1 AND trigger_time = ?",
      [currentTime]
    );

    for (const ann of announcements) {
      if (!ann.days.includes(currentDay)) continue;

      // Check if already played this minute
      const nowEpoch = Math.floor(Date.now() / 1000);
      if (ann.last_played_at && nowEpoch - ann.last_played_at < 120) continue;

      console.log("Playing announcement:", ann.title, "at", currentTime);
      lastFiredMinute = currentTime;

      // Duck music if enabled
      const deckA = engine.getDeck("A");
      const deckB = engine.getDeck("B");
      const origVolA = deckA ? (deckA as any).volume || 1 : 1;
      const origVolB = deckB ? (deckB as any).volume || 1 : 1;

      if (ann.duck_music) {
        if (deckA) deckA.setVolume(ann.duck_level);
        if (deckB) deckB.setVolume(ann.duck_level);
      }

      // Play the announcement
      try {
        const bytes = await readFile(ann.file_path);
        const blob = new Blob([bytes], { type: "audio/mpeg" });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);

        audio.onended = () => {
          URL.revokeObjectURL(url);
          // Restore music volume
          if (ann.duck_music && ann.resume_music) {
            if (deckA) deckA.setVolume(origVolA);
            if (deckB) deckB.setVolume(origVolB);
          }
        };

        audio.play();
        await execute("UPDATE announcements SET last_played_at = unixepoch() WHERE id = ?", [ann.id]);
      } catch (e) {
        console.error("Announcement play error:", e);
        // Restore volume on error
        if (ann.duck_music) {
          if (deckA) deckA.setVolume(origVolA);
          if (deckB) deckB.setVolume(origVolB);
        }
      }
    }
  } catch (e) {
    console.error("Announcement check error:", e);
  }
}

export function startAnnouncementEngine() {
  if (announcementTimer) clearInterval(announcementTimer);
  announcementTimer = setInterval(checkAnnouncements, 10000);
  console.log("Announcement engine started");
}

export function stopAnnouncementEngine() {
  if (announcementTimer) clearInterval(announcementTimer);
  announcementTimer = null;
}

// UI Component
export default function Announcements() {
  const [list, setList] = useState<Announcement[]>([]);
  const [editing, setEditing] = useState<Partial<Announcement> | null>(null);

  const load = async () => {
    setList(await query<Announcement>("SELECT * FROM announcements ORDER BY trigger_time"));
  };
  useEffect(() => { load(); startAnnouncementEngine(); }, []);

  const addNew = async () => {
    const files = await open({
      multiple: false,
      title: "Select announcement audio",
      filters: [{ name: "Audio", extensions: ["mp3", "flac", "ogg", "wav", "m4a", "aac"] }]
    });
    if (!files) return;
    const filePath = Array.isArray(files) ? files[0] : files;
    const title = (filePath.split(/[\\\\/]/).pop() || "").replace(/\\.[^.]+$/, "").replace(/[_-]/g, " ");

    setEditing({
      title,
      file_path: filePath,
      trigger_time: "17:30",
      days: "0123456",
      duck_music: 1,
      resume_music: 1,
      duck_level: 0.1,
      is_active: 1,
    });
  };

  const save = async () => {
    if (!editing) return;
    if (editing.id) {
      await execute(
        "UPDATE announcements SET title=?, trigger_time=?, days=?, duck_music=?, resume_music=?, duck_level=?, is_active=? WHERE id=?",
        [editing.title, editing.trigger_time, editing.days, editing.duck_music ? 1 : 0, editing.resume_music ? 1 : 0, editing.duck_level, editing.is_active ? 1 : 0, editing.id]
      );
    } else {
      await execute(
        "INSERT INTO announcements (title, file_path, trigger_time, days, duck_music, resume_music, duck_level, is_active) VALUES (?,?,?,?,?,?,?,?)",
        [editing.title, editing.file_path, editing.trigger_time, editing.days, editing.duck_music ? 1 : 0, editing.resume_music ? 1 : 0, editing.duck_level, editing.is_active ? 1 : 0]
      );
    }
    setEditing(null);
    load();
  };

  const remove = async (id: number) => {
    if (confirm("Delete this announcement?")) {
      await execute("DELETE FROM announcements WHERE id=?", [id]);
      load();
    }
  };

  const toggleDay = (day: string) => {
    if (!editing) return;
    const days = editing.days || "0123456";
    if (days.includes(day)) {
      setEditing({ ...editing, days: days.replace(day, "") });
    } else {
      setEditing({ ...editing, days: days + day });
    }
  };

  const testPlay = async (ann: Announcement) => {
    try {
      const bytes = await readFile(ann.file_path);
      const blob = new Blob([bytes], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      audio.play();
    } catch (e) {
      alert("Could not play: " + e);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold">Scheduled Announcements</h1>
          <p className="text-xs text-zinc-500 mt-1">Auto-play audio at specific times. Music ducks, announcement plays, music resumes.</p>
        </div>
        <button onClick={addNew} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-xs font-bold text-white">+ Add Announcement</button>
      </div>

      {/* Edit dialog */}
      {editing && (
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4 space-y-3">
          <h3 className="text-sm font-bold text-zinc-200">{editing.id ? "Edit" : "New"} Announcement</h3>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-zinc-500 uppercase">Title</label>
              <input className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" value={editing.title || ""} onChange={e => setEditing({ ...editing, title: e.target.value })} />
            </div>
            <div>
              <label className="text-[10px] text-zinc-500 uppercase">Trigger Time</label>
              <input type="time" className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" value={editing.trigger_time || "17:30"} onChange={e => setEditing({ ...editing, trigger_time: e.target.value })} />
            </div>
          </div>

          <div>
            <label className="text-[10px] text-zinc-500 uppercase">Days Active</label>
            <div className="flex gap-1 mt-1">
              {DAY_NAMES.map((name, i) => (
                <button key={i} onClick={() => toggleDay(String(i))}
                  className={"px-3 py-1.5 rounded text-[10px] font-bold " + ((editing.days || "").includes(String(i)) ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-500")}>
                  {name}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={!!editing.duck_music} onChange={e => setEditing({ ...editing, duck_music: e.target.checked ? 1 : 0 })} />
              <label className="text-xs text-zinc-300">Duck music</label>
            </div>
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={!!editing.resume_music} onChange={e => setEditing({ ...editing, resume_music: e.target.checked ? 1 : 0 })} />
              <label className="text-xs text-zinc-300">Resume after</label>
            </div>
            <div>
              <label className="text-[10px] text-zinc-500 uppercase">Duck Level ({Math.round((editing.duck_level || 0.1) * 100)}%)</label>
              <input type="range" min="0" max="50" value={Math.round((editing.duck_level || 0.1) * 100)} onChange={e => setEditing({ ...editing, duck_level: parseInt(e.target.value) / 100 })} className="w-full" />
            </div>
          </div>

          <div className="text-[10px] text-zinc-600">File: {editing.file_path}</div>

          <div className="flex gap-2">
            <button onClick={save} className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-xs font-bold text-white">Save</button>
            <button onClick={() => setEditing(null)} className="px-4 py-1.5 bg-zinc-700 rounded text-xs text-zinc-300">Cancel</button>
          </div>
        </div>
      )}

      {/* List */}
      {list.length === 0 ? (
        <div className="text-center py-8">
          <div className="text-zinc-400 text-lg mb-2">No announcements scheduled</div>
          <div className="text-zinc-600 text-xs">Add closing announcements, park alerts, legal IDs, or any timed audio.</div>
        </div>
      ) : (
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-[10px] text-zinc-500 uppercase border-b border-zinc-800">
              <th className="px-3 py-2">Title</th>
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">Days</th>
              <th className="px-3 py-2">Duck</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr></thead>
            <tbody>{list.map(a => (
              <tr key={a.id} className="border-b border-zinc-800 hover:bg-zinc-800">
                <td className="px-3 py-2 text-zinc-100 font-medium">{a.title}</td>
                <td className="px-3 py-2 text-zinc-300 font-mono">{fmtTime(a.trigger_time)}</td>
                <td className="px-3 py-2">
                  <div className="flex gap-0.5">
                    {DAY_NAMES.map((name, i) => (
                      <span key={i} className={"text-[8px] px-1 rounded " + (a.days.includes(String(i)) ? "bg-blue-900 text-blue-300" : "bg-zinc-800 text-zinc-600")}>{name[0]}</span>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2 text-zinc-400">{a.duck_music ? Math.round(a.duck_level * 100) + "%" : "No"}</td>
                <td className="px-3 py-2">
                  <button onClick={async () => { await execute("UPDATE announcements SET is_active=? WHERE id=?", [a.is_active ? 0 : 1, a.id]); load(); }}
                    className={"px-2 py-0.5 rounded text-[9px] font-bold " + (a.is_active ? "bg-emerald-900 text-emerald-300" : "bg-zinc-800 text-zinc-600")}>
                    {a.is_active ? "ON" : "OFF"}
                  </button>
                </td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => testPlay(a)} className="px-1.5 py-0.5 bg-emerald-700 hover:bg-emerald-600 rounded text-[9px] font-bold text-white mr-1">Test</button>
                  <button onClick={() => setEditing(a)} className="px-1.5 py-0.5 bg-zinc-700 hover:bg-zinc-600 rounded text-[9px] font-bold text-white mr-1">Edit</button>
                  <button onClick={() => remove(a.id)} className="px-1.5 py-0.5 bg-zinc-800 hover:bg-red-900 rounded text-[9px] font-bold text-zinc-500 hover:text-red-400">Del</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {/* Quick presets */}
      <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3">
        <div className="text-[10px] text-zinc-500 uppercase mb-2">Common Setups</div>
        <div className="text-xs text-zinc-400 space-y-1">
          <p><strong>Theme park closing:</strong> "Park closes in 30 min" at 8:30 PM, "15 minutes" at 8:45 PM, "Closing" at 9:00 PM</p>
          <p><strong>Legal station ID:</strong> Top of every hour, every day</p>
          <p><strong>Event alerts:</strong> One-time announcements on specific days</p>
        </div>
      </div>
    </div>
  );
}
`, 'utf8');
console.log('  CREATED Announcements.tsx');

// ============================================================
// 3. Wire into App.tsx
// ============================================================

if (!app.includes('"announce"')) {
  app = app.replace(
    'import VoiceTracker from "./components/VoiceTracker";',
    'import VoiceTracker from "./components/VoiceTracker";\nimport Announcements, { startAnnouncementEngine } from "./components/Announcements";'
  );

  // Add nav item
  app = app.replace(
    '{ id: "voicetrack" as Panel, label: "Voice Track" },',
    '{ id: "voicetrack" as Panel, label: "Voice Track" },\n    { id: "announce" as Panel, label: "Announce" },'
  );

  // Add panel type
  app = app.replace(
    'type Panel = "live" | "library" | "clocks" | "logs" | "spots" | "voicetrack" | "streaming" | "settings";',
    'type Panel = "live" | "library" | "clocks" | "logs" | "spots" | "voicetrack" | "announce" | "streaming" | "settings";'
  );

  // Add render
  app = app.replace(
    '{panel === "voicetrack" && <VoiceTracker',
    '{panel === "announce" && <Announcements />}\n          {panel === "voicetrack" && <VoiceTracker'
  );

  // Start announcement engine on app load
  app = app.replace(
    '  useEffect(() => {\n    engine.init();',
    '  useEffect(() => {\n    engine.init();\n    startAnnouncementEngine();'
  );

  fs.writeFileSync('src/App.tsx', app, 'utf8');
  console.log('  UPDATED App.tsx (Announce tab)');
}

console.log('\n  Done! Close app, delete DB, restart:');
console.log('  npm run tauri:dev\n');
console.log('  New ANNOUNCE tab in the sidebar.\n');
console.log('  For Magical Forest at OV:');
console.log('    + Add Announcement → select "closes in 30 min" audio');
console.log('    Set time: 8:30 PM');
console.log('    Days: every day (or just weekends)');
console.log('    Duck music: ON at 10% volume');
console.log('    Resume after: ON');
console.log('');
console.log('    + Add another → "closes in 15 min" → 8:45 PM');
console.log('    + Add another → "now closing" → 9:00 PM');
console.log('');
console.log('  What happens at 8:30 PM:');
console.log('    1. Music volume drops to 10%');
console.log('    2. Announcement plays over the ducked music');
console.log('    3. Announcement ends → music comes back to full');
console.log('    4. Automatic. No human needed.');
console.log('');
console.log('  Push:');
console.log('    git add -A');
console.log('    git commit -m "v1.7.0 scheduled announcements"');
console.log('    git push\n');
