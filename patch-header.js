const fs = require("fs");
let c = fs.readFileSync("C:/openair/src/App.tsx", "utf8");

// Find line 819 area
const lines = c.split("\n");
const targetLine = lines.findIndex(l => l.includes("RIGHT: Status controls"));
console.log("Found at line:", targetLine + 1);
console.log("Context:", lines.slice(targetLine, targetLine + 2).join("\n"));

const old = lines[targetLine] + "\n" + lines[targetLine + 1];
console.log("OLD:", JSON.stringify(old));

const neu = `        {/* CENTER: Toolbar + Search */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: 12, flex: 1 }}>
          <div style={{ display: "flex", gap: 2, background: "var(--bg-tertiary)", borderRadius: 8, padding: "3px 6px", border: "1px solid var(--border-primary)" }}>
            <ToolbarBtn label="SHUFFLE" active={shuffle} onClick={() => setShuffle(p => !p)} color="#fbbf24" />
            <ToolbarBtn label="TRIM" active={autoSilenceTrim??true} onClick={() => setAutoSilenceTrim(!autoSilenceTrim)} color="#34d399" />
            <ToolbarBtn label="CARTS" active={showCarts} onClick={() => setShowCarts(p => !p)} color="#f97316" />
            <ToolbarBtn label="AUTO-X" active={continuous} onClick={() => setContinuous(p => !p)} color="#a78bfa" />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, maxWidth: 320, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", borderRadius: 8, padding: "0 10px", height: 30 }}>
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" style={{ opacity: 0.4, flexShrink: 0, color: "var(--text-primary)" }}><circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5"/><path d="M9.5 9.5L12.5 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            <input type="text" placeholder="Quick search..." style={{ flex: 1, background: "transparent", border: "none", outline: "none", fontSize: 12, color: "var(--text-primary)" }} onChange={e => { if (e.target.value) setPanel("library"); }} />
          </div>
        </div>
        {/* RIGHT: Status controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 8, zIndex: 1 }}>`;

c = c.replace(old, neu);
fs.writeFileSync("C:/openair/src/App.tsx", c);
console.log("Done");
