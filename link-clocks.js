const fs = require('fs');

console.log('\n  Ether — Link Clocks to Dayparts\n');

// ============================================================
// 1. Update database - add clock_id to shows table
// ============================================================

let client = fs.readFileSync('src/db/client.ts', 'utf8');
if (!client.includes('shows ADD COLUMN clock_id')) {
  client = client.replace(
    'try { await d.execute("ALTER TABLE categories ADD COLUMN spins_per_hour',
    'try { await d.execute("ALTER TABLE shows ADD COLUMN clock_id INTEGER REFERENCES clocks(id)"); } catch {}\n  try { await d.execute("ALTER TABLE categories ADD COLUMN spins_per_hour'
  );
  fs.writeFileSync('src/db/client.ts', client, 'utf8');
  console.log('  UPDATED src/db/client.ts (clock_id on shows)');
}

// ============================================================
// 2. Update loggen.ts to check shows first, then grid as fallback
// ============================================================

let loggen = fs.readFileSync('src/audio/loggen.ts', 'utf8');
if (!loggen.includes('getClockFromShow')) {
  loggen = loggen.replace(
    'async function getClockForNow(): Promise<number | null> {',
    [
      '// Check if a show covers the current hour and has a clock assigned',
      'async function getClockFromShow(): Promise<number | null> {',
      '  const now = new Date();',
      '  const hour = now.getHours();',
      '  const shows = await query<{ id: number; start_hour: number; end_hour: number; clock_id: number | null }>("SELECT * FROM shows WHERE is_active = 1 AND clock_id IS NOT NULL");',
      '  for (const s of shows) {',
      '    if (s.end_hour > s.start_hour) {',
      '      if (hour >= s.start_hour && hour < s.end_hour) return s.clock_id;',
      '    } else {',
      '      // Wraps midnight (e.g. 19-6)',
      '      if (hour >= s.start_hour || hour < s.end_hour) return s.clock_id;',
      '    }',
      '  }',
      '  return null;',
      '}',
      '',
      'async function getClockForNow(): Promise<number | null> {',
    ].join('\n')
  );

  // Make getClockForNow check shows first
  loggen = loggen.replace(
    "  const row = await queryOne<{ clock_id: number }>(\"SELECT clock_id FROM schedule_grid WHERE day_of_week = ? AND hour = ?\", [day, hour]);\n  return row ? row.clock_id : null;",
    "  // Check shows first, then fall back to grid\n  const fromShow = await getClockFromShow();\n  if (fromShow) return fromShow;\n  const row = await queryOne<{ clock_id: number }>(\"SELECT clock_id FROM schedule_grid WHERE day_of_week = ? AND hour = ?\", [day, hour]);\n  return row ? row.clock_id : null;"
  );

  fs.writeFileSync('src/audio/loggen.ts', loggen, 'utf8');
  console.log('  UPDATED src/audio/loggen.ts (checks shows first)');
}

// ============================================================
// 3. Update Scheduler.tsx - add clock dropdown to shows
// ============================================================

let sched = fs.readFileSync('src/components/Scheduler.tsx', 'utf8');

if (!sched.includes('clock_id')) {
  // Add clock_id to Show interface
  sched = sched.replace(
    "interface Show {\n  id: number; name: string; start_hour: number; end_hour: number;\n  days: string; color: string | null; description: string | null; is_active: number;\n}",
    "interface Show {\n  id: number; name: string; start_hour: number; end_hour: number;\n  days: string; color: string | null; description: string | null; is_active: number; clock_id: number | null;\n}"
  );

  // Add clocks state to ShowsTab
  sched = sched.replace(
    'function ShowsTab() {\n  const [shows, setShows] = useState<Show[]>([]);\n  const [editing, setEditing] = useState<Partial<Show> | null>(null);',
    'function ShowsTab() {\n  const [shows, setShows] = useState<Show[]>([]);\n  const [editing, setEditing] = useState<Partial<Show> | null>(null);\n  const [clocks, setClocks] = useState<Clock[]>([]);'
  );

  // Load clocks alongside shows
  sched = sched.replace(
    '  const load = async () => { setShows(await query<Show>("SELECT * FROM shows ORDER BY start_hour")); };',
    '  const load = async () => {\n    setShows(await query<Show>("SELECT * FROM shows ORDER BY start_hour"));\n    setClocks(await query<Clock>("SELECT * FROM clocks ORDER BY name"));\n  };'
  );

  // Replace the show row display to include clock dropdown
  const oldShowRow = `          <div key={s.id} className="flex items-center justify-between px-3 py-2 bg-zinc-900 rounded border border-zinc-800 hover:bg-zinc-800">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: s.color || "#444" }}></div>
              <span className="text-sm text-zinc-100 font-medium">{s.name}</span>
              <span className="text-xs text-zinc-500">{fmtHour(s.start_hour)} - {fmtHour(s.end_hour)}</span>
            </div>
            <div className="flex gap-1">
              <button onClick={() => setEditing(s)} className="px-2 py-0.5 bg-zinc-700 hover:bg-zinc-600 rounded text-[10px] text-zinc-300">Edit</button>
              <button onClick={() => remove(s.id)} className="px-2 py-0.5 bg-zinc-800 hover:bg-red-900 rounded text-[10px] text-zinc-500 hover:text-red-400">Delete</button>
            </div>
          </div>`;

  const newShowRow = `          <div key={s.id} className="flex items-center justify-between px-3 py-2.5 bg-zinc-900 rounded border border-zinc-800 hover:bg-zinc-800">
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: s.color || "#444" }}></div>
              <div>
                <div className="text-sm text-zinc-100 font-medium">{s.name}</div>
                <div className="text-[11px] text-zinc-500">{fmtHour(s.start_hour)} - {fmtHour(s.end_hour)}{s.description ? " — " + s.description : ""}</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <select value={s.clock_id || ""} onChange={async (e) => {
                const cid = e.target.value ? parseInt(e.target.value) : null;
                await execute("UPDATE shows SET clock_id = ? WHERE id = ?", [cid, s.id]);
                load();
              }} className="px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-200 min-w-[140px]">
                <option value="">No clock assigned</option>
                {clocks.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button onClick={() => setEditing(s)} className="px-2 py-0.5 bg-zinc-700 hover:bg-zinc-600 rounded text-[10px] text-zinc-300">Edit</button>
              <button onClick={() => remove(s.id)} className="px-2 py-0.5 bg-zinc-800 hover:bg-red-900 rounded text-[10px] text-zinc-500 hover:text-red-400">Del</button>
            </div>
          </div>`;

  sched = sched.replace(oldShowRow, newShowRow);

  // Remove Grid from the tabs since shows handle it now
  sched = sched.replace(
    '{(["shows", "categories", "clocks", "grid"] as const).map(t => (',
    '{(["shows", "categories", "clocks"] as const).map(t => ('
  );
  sched = sched.replace(
    "? \"Shows / Dayparts\" : t === \"categories\" ? \"Categories\" : t === \"clocks\" ? \"Format Clocks\" : \"Schedule Grid\"",
    "? \"Shows / Dayparts\" : t === \"categories\" ? \"Categories\" : \"Format Clocks\""
  );
  sched = sched.replace(
    "      {tab === \"grid\" && <GridTab />}\n",
    ""
  );

  fs.writeFileSync('src/components/Scheduler.tsx', sched, 'utf8');
  console.log('  UPDATED src/components/Scheduler.tsx (clock dropdown on shows)');
}

console.log('\n  Done! Restart: npm run tauri:dev');
console.log('');
console.log('  New workflow:');
console.log('    1. Create format clocks (Format Clocks tab)');
console.log('    2. Go to Shows / Dayparts');
console.log('    3. Each show has a dropdown — pick which clock plays');
console.log('    4. Morning Drive (6-10 AM) → Morning Drive clock');
console.log('    5. Evening (7 PM-midnight) → Evening clock');
console.log('    6. GEN LOG reads the current hour, finds the show,');
console.log('       uses that show\'s clock. Done.');
console.log('');
console.log('  No more grid needed. Shows define the hours,');
console.log('  clocks define what plays. Simple.');
console.log('');
console.log('  Push:');
console.log('    git add -A');
console.log('    git commit -m "v0.5.1 clocks linked to dayparts - no grid needed"');
console.log('    git push\n');
