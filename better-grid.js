const fs = require('fs');

console.log('\n  Ether — Better Schedule Grid\n');

let sched = fs.readFileSync('src/components/Scheduler.tsx', 'utf8');

// Replace the entire GridTab function
const oldGridStart = 'function GridTab() {';
const oldGridEnd = "      {clocks.length > 0 && (\n        <div className=\"flex gap-2 text-[10px]\">\n          {clocks.map(c => <span key={c.id} className=\"flex items-center gap-1\"><span className=\"w-3 h-3 rounded\" style={{ backgroundColor: c.color || \"#444\" }}></span>{c.name}</span>)}\n        </div>\n      )}\n    </div>\n  );\n}";

const startIdx = sched.indexOf(oldGridStart);
const endIdx = sched.indexOf(oldGridEnd);

if (startIdx >= 0 && endIdx >= 0) {
  const before = sched.substring(0, startIdx);
  const after = sched.substring(endIdx + oldGridEnd.length);

  const newGrid = [
    'function GridTab() {',
    '  const [clocks, setClocks] = useState<Clock[]>([]);',
    '  const [grid, setGrid] = useState<Record<string, number | null>>({});',
    '',
    '  const load = async () => {',
    '    setClocks(await query<Clock>("SELECT * FROM clocks ORDER BY name"));',
    '    const rows = await query<{ day_of_week: number; hour: number; clock_id: number }>("SELECT * FROM schedule_grid");',
    '    const g: Record<string, number | null> = {};',
    '    rows.forEach(r => { g[r.day_of_week + "-" + r.hour] = r.clock_id; });',
    '    setGrid(g);',
    '  };',
    '  useEffect(() => { load(); }, []);',
    '',
    '  const assign = async (day: number, hour: number, clockId: number | null) => {',
    '    const key = day + "-" + hour;',
    '    if (clockId) {',
    '      await execute("INSERT OR REPLACE INTO schedule_grid (day_of_week, hour, clock_id) VALUES (?,?,?)", [day, hour, clockId]);',
    '    } else {',
    '      await execute("DELETE FROM schedule_grid WHERE day_of_week=? AND hour=?", [day, hour]);',
    '    }',
    '    setGrid(prev => ({ ...prev, [key]: clockId }));',
    '  };',
    '',
    '  const [paintClock, setPaintClock] = useState<number | null>(null);',
    '  const [painting, setPainting] = useState(false);',
    '',
    '  const clockMap = new Map(clocks.map(c => [c.id, c]));',
    '',
    '  return (',
    '    <div className="space-y-3">',
    '      <h2 className="text-sm font-bold text-zinc-300">Schedule Grid</h2>',
    '      <div className="text-xs text-zinc-500 mb-2">Select a clock below, then click or drag across the grid to paint it.</div>',
    '',
    '      <div className="flex gap-2 flex-wrap mb-3">',
    '        <button onClick={() => setPaintClock(null)} className={paintClock === null ? "px-3 py-1.5 rounded text-xs font-bold border-2 border-white bg-zinc-800 text-white" : "px-3 py-1.5 rounded text-xs font-bold bg-zinc-800 text-zinc-500 hover:bg-zinc-700 border-2 border-transparent"}>Eraser</button>',
    '        {clocks.map(c => (',
    '          <button key={c.id} onClick={() => setPaintClock(c.id)} className={"px-3 py-1.5 rounded text-xs font-bold text-white border-2 " + (paintClock === c.id ? "border-white" : "border-transparent")} style={{ backgroundColor: c.color || "#444" }}>{c.name}</button>',
    '        ))}',
    '      </div>',
    '',
    '      <div className="overflow-auto bg-zinc-900 rounded-lg border border-zinc-800 p-2"',
    '        onMouseUp={() => setPainting(false)}',
    '        onMouseLeave={() => setPainting(false)}>',
    '        <table className="text-[10px] border-collapse w-full" style={{ userSelect: "none" }}>',
    '          <thead>',
    '            <tr>',
    '              <th className="px-2 py-1 text-zinc-500 text-left w-12"></th>',
    '              {HOURS.map(h => <th key={h} className="py-1 text-zinc-500 text-center" style={{ minWidth: "42px" }}>{fmtHour(h)}</th>)}',
    '            </tr>',
    '          </thead>',
    '          <tbody>',
    '            {DAYS.map((day, di) => (',
    '              <tr key={di}>',
    '                <td className="px-2 py-1 text-zinc-300 font-bold">{day}</td>',
    '                {HOURS.map(h => {',
    '                  const key = di + "-" + h;',
    '                  const clockId = grid[key] || null;',
    '                  const clock = clockId ? clockMap.get(clockId) : null;',
    '                  return (',
    '                    <td key={h}',
    '                      className="border border-zinc-700 cursor-pointer text-center"',
    '                      style={{ backgroundColor: clock?.color || "#1c1c1e", height: "32px", minWidth: "42px" }}',
    '                      onMouseDown={() => { setPainting(true); assign(di, h, paintClock); }}',
    '                      onMouseEnter={() => { if (painting) assign(di, h, paintClock); }}>',
    '                      <span className="text-white font-bold text-[9px]">{clock?.name?.substring(0, 4) || ""}</span>',
    '                    </td>',
    '                  );',
    '                })}',
    '              </tr>',
    '            ))}',
    '          </tbody>',
    '        </table>',
    '      </div>',
    '',
    '      {clocks.length > 0 && (',
    '        <div className="flex gap-3 text-xs">',
    '          {clocks.map(c => <span key={c.id} className="flex items-center gap-1.5"><span className="w-4 h-4 rounded" style={{ backgroundColor: c.color || "#444" }}></span><span className="text-zinc-300">{c.name}</span></span>)}',
    '        </div>',
    '      )}',
    '    </div>',
    '  );',
    '}',
  ].join('\n');

  sched = before + newGrid + after;
  fs.writeFileSync('src/components/Scheduler.tsx', sched, 'utf8');
  console.log('  UPDATED Schedule Grid:');
  console.log('    - Select a clock button first, then paint across the grid');
  console.log('    - Click and drag to fill multiple hours at once');
  console.log('    - Bigger cells with clock name abbreviation');
  console.log('    - Eraser button to clear cells');
  console.log('    - Color-coded legend at the bottom');
} else {
  console.log('  ERROR: Could not find GridTab to replace. File may have changed.');
}

console.log('\n  Push:');
console.log('    git add -A');
console.log('    git commit -m "better schedule grid - paint mode"');
console.log('    git push\n');
