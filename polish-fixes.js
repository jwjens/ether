const fs = require('fs');

console.log('\n  Ether — Polish fixes\n');

// ============================================================
// 1. Fix the \U2014 em dash in LivePanel
// ============================================================

let app = fs.readFileSync('src/App.tsx', 'utf8');
app = app.replace(/\\\\u2014/g, ' —');
app = app.replace(/\\u2014/g, ' —');
fs.writeFileSync('src/App.tsx', app, 'utf8');
console.log('  FIXED em dashes in App.tsx');

// ============================================================
// 2. Fix queue readability
// ============================================================

let upnext = fs.readFileSync('src/components/UpNext.tsx', 'utf8');

// Fix queue item text colors to use theme vars
upnext = upnext.replace(
  /className="text-\[11px\] text-zinc-200 truncate"/g,
  'style={{ fontSize: 12, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}'
);

upnext = upnext.replace(
  /className="text-\[9px\] text-zinc-500 truncate"/g,
  'style={{ fontSize: 10, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}'
);

// Fix queue item background
upnext = upnext.replace(
  /className="text-\[9px\] text-zinc-600 w-4 shrink-0 text-right"/g,
  'style={{ fontSize: 10, color: "var(--text-tertiary)", width: 20, flexShrink: 0, textAlign: "right" as any }}'
);

// Fix the queue item row styling
upnext = upnext.replace(
  'className={getCls(i)}',
  'style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--border-primary)", cursor: "grab", opacity: dragIdx === i ? 0.3 : 1, borderTop: dragOverIdx === i ? "2px solid var(--accent-blue)" : "none", background: i === 0 ? "var(--bg-tertiary)" : "transparent" }}'
);

// Fix empty queue text
upnext = upnext.replace(
  'className="px-3 py-8 text-[11px] text-zinc-600 italic text-center"',
  'style={{ padding: "32px 12px", fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic", textAlign: "center" as any }}'
);

// Fix the clear button
upnext = upnext.replace(
  'className="text-[10px] text-zinc-600 hover:text-zinc-400"',
  'style={{ fontSize: 10, color: "var(--text-tertiary)", background: "none", border: "none", cursor: "pointer" }}'
);

// Fix the remove X button on each item
upnext = upnext.replace(
  'className="text-[9px] text-zinc-700 hover:text-red-400 px-1"',
  'style={{ fontSize: 10, color: "var(--text-tertiary)", background: "none", border: "none", cursor: "pointer", padding: "0 4px" }}'
);

// Fix context menu
upnext = upnext.replace(
  'className="fixed z-50 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl py-1 min-w-[160px]"',
  'style={{ position: "fixed" as any, zIndex: 50, background: "var(--bg-elevated)", border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-sm)", boxShadow: "var(--shadow-lg)", padding: "4px 0", minWidth: 180 }}'
);

upnext = upnext.replace(
  /className="px-3 py-1 text-\[10px\] text-zinc-500 truncate border-b border-zinc-700"/g,
  'style={{ padding: "4px 12px", fontSize: 10, color: "var(--text-tertiary)", borderBottom: "1px solid var(--border-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}'
);

upnext = upnext.replace(
  /className="w-full px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-700"/g,
  'style={{ width: "100%", padding: "6px 12px", textAlign: "left" as any, fontSize: 12, color: "var(--text-primary)", background: "none", border: "none", cursor: "pointer" }}'
);

upnext = upnext.replace(
  'className="w-full px-3 py-1.5 text-left text-xs text-red-400 hover:bg-zinc-700"',
  'style={{ width: "100%", padding: "6px 12px", textAlign: "left" as any, fontSize: 12, color: "var(--accent-red)", background: "none", border: "none", cursor: "pointer" }}'
);

fs.writeFileSync('src/components/UpNext.tsx', upnext, 'utf8');
console.log('  FIXED UpNext.tsx (readable text, themed)');

// ============================================================
// 3. Fix JockStrip readability
// ============================================================

if (fs.existsSync('src/components/JockStrip.tsx')) {
  let jock = fs.readFileSync('src/components/JockStrip.tsx', 'utf8');
  
  // Fix search input
  jock = jock.replace(
    'className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-blue-500"',
    'style={{ width: "100%", padding: "8px 12px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", borderRadius: "var(--radius-xs)", fontSize: 13, color: "var(--text-primary)", outline: "none" }}'
  );
  
  // Fix search results dropdown
  jock = jock.replace(
    'className="absolute top-full left-0 right-0 mt-1 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl z-50 max-h-60 overflow-y-auto"',
    'style={{ position: "absolute" as any, top: "100%", left: 0, right: 0, marginTop: 4, background: "var(--bg-elevated)", border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-sm)", boxShadow: "var(--shadow-lg)", zIndex: 50, maxHeight: 240, overflowY: "auto" as any }}'
  );

  // Fix history text
  jock = jock.replace(
    /className="text-\[9px\] text-zinc-600 uppercase shrink-0 mr-1"/g,
    'style={{ fontSize: 10, color: "var(--text-tertiary)", textTransform: "uppercase" as any, flexShrink: 0, marginRight: 4 }}'
  );
  
  jock = jock.replace(
    /className="text-\[10px\] text-zinc-500 truncate shrink-0"/g,
    'style={{ fontSize: 11, color: "var(--text-secondary)", flexShrink: 0 }}'
  );

  // Fix clock
  jock = jock.replace(
    'className="text-lg font-mono font-bold text-zinc-100 leading-none"',
    'style={{ fontSize: 18, fontFamily: "monospace", fontWeight: 700, color: "var(--text-primary)", lineHeight: 1 }}'
  );

  jock = jock.replace(
    'className="text-[10px] text-zinc-500">{dateStr}',
    'style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{dateStr}'
  );

  fs.writeFileSync('src/components/JockStrip.tsx', jock, 'utf8');
  console.log('  FIXED JockStrip.tsx (themed)');
}

console.log('\n  Done! App should hot-reload.');
console.log('  Queue text is now readable in both light and dark modes.');
console.log('  Em dashes display properly.');
console.log('  Search bar and history strip themed.\n');
