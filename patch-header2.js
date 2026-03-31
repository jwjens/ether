const fs = require("fs");
let c = fs.readFileSync("C:/openair/src/App.tsx", "utf8");

// Find the header section
const headerStart = c.indexOf('{/* \u2500\u2500 LEFT: Logo + Menu + Session \u2500\u2500 */}');
const headerEnd = c.indexOf('</header>');

if (headerStart === -1 || headerEnd === -1) {
  console.log("Could not find header section");
  console.log("headerStart:", headerStart, "headerEnd:", headerEnd);
  process.exit(1);
}

const headerContent = c.slice(headerStart, headerEnd);
console.log("Found header, length:", headerContent.length);

// Find what's in the RIGHT section - extract key buttons
const sessionNameBar = `          <SessionNameBar
            name={canvasEngine.activeLayoutName}
            onChange={canvasEngine.renameActive}
            onSave={async (name: string) => { await canvasEngine.saveCurrentLayout(name); if (name !== "Live Assist") setUseCanvas(true); }}
            layouts={canvasEngine.layouts}
            onLoadLayout={(id: string) => { canvasEngine.loadLayout(id); setUseCanvas(true); }}
            onDeleteLayout={(id: string) => canvasEngine.deleteLayout(id)}
          />`;

const newHeader = `        {/* LEFT: Live Assist + Session */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, zIndex: 1 }}>
${sessionNameBar}
        </div>

        {/* CENTER: Schedule + Clock + Dark mode */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "0 auto", zIndex: 1 }}>
          {panel !== "live" && (
            <button
              onClick={() => setPanel("live")}
              style={{ height: 28, padding: "0 10px", borderRadius: 7, background: "var(--accent-cyan)", border: "none", color: "#000", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}
            >
              <svg width="7" height="9" viewBox="0 0 8 10" fill="currentColor"><polygon points="0,0 8,5 0,10"/></svg>
              Go Live
            </button>
          )}
          <button
            onClick={() => setPanel("programlog")}
            style={{
              height: 28, padding: "0 10px", borderRadius: 7,
              background: panel === "programlog" ? "rgba(167,139,250,0.2)" : "var(--bg-tertiary)",
              border: \`1px solid \${panel === "programlog" ? "rgba(167,139,250,0.4)" : "var(--border-primary)"}\`,
              color: panel === "programlog" ? "#a78bfa" : "var(--text-secondary)",
              fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", cursor: "pointer",
              display: "flex", alignItems: "center", gap: 5,
            }}
          >
            📋 Schedule
          </button>
          <ClockDisplay />
          <button onClick={() => setDarkMode(!darkMode)} style={{ width: 30, height: 30, borderRadius: 8, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {darkMode ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
            )}
          </button>
        </div>

        {/* RIGHT: Desk + Now Playing + Pro + Admin + ON AIR */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, zIndex: 1 }}>
          <button onClick={openDeskWindow} style={{ height: 30, padding: "0 12px", borderRadius: 8, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer", fontSize: 11, fontWeight: 600, letterSpacing: "0.02em", display: "flex", alignItems: "center", gap: 6, transition: "all 0.15s" }}
            onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.background="rgba(167,139,250,0.15)";(e.currentTarget as HTMLElement).style.color="#a78bfa";(e.currentTarget as HTMLElement).style.borderColor="rgba(167,139,250,0.3)";}}
            onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.background="var(--bg-tertiary)";(e.currentTarget as HTMLElement).style.color="var(--text-secondary)";(e.currentTarget as HTMLElement).style.borderColor="var(--border-primary)";}}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            Desk
          </button>
          <button onClick={() => openNowPlayingWindow()} style={{ height: 30, padding: "0 12px", borderRadius: 8, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer", fontSize: 11, fontWeight: 600, letterSpacing: "0.02em", display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ opacity: 0.6 }}><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
            Now Playing
          </button>
          {currentPlan === "free" && (
            <button onClick={() => setPanel("subscription")} style={{ height: 30, padding: "0 10px", borderRadius: 8, background: "#7c3aed", border: "none", color: "#fff", cursor: "pointer", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", display: "flex", alignItems: "center", gap: 4 }}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
              Pro
            </button>
          )}
          <button onClick={() => setCurrentUser(null)} style={{ height: 30, padding: "0 10px", borderRadius: 8, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 10, display: "flex", alignItems: "center", gap: 5 }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
            {currentUser?.name}
          </button>
          <HealthStatusDot onClick={() => setPanel("health")} />
          <UpdateBanner state={updater.state} onDownload={updater.download} onRestart={updater.restart} onDismiss={updater.dismiss} />
          <button
            data-tour="onair-btn"
            onClick={async () => {
              if (onAir) {
                setOnAir(false); setOnAirOverride(true); onAirOverrideRef.current = true;
                invoke("stream_stop").catch(() => {});
              } else {
                setOnAir(true); setOnAirOverride(false); onAirOverrideRef.current = false;
              }
            }}
            style={{
              height: 32, padding: "0 16px", borderRadius: 8, border: "none", cursor: "pointer",
              fontSize: 11, fontWeight: 800, letterSpacing: "0.1em",
              background: onAir ? "#ef4444" : "var(--bg-tertiary)",
              color: onAir ? "#fff" : "var(--text-tertiary)",
              boxShadow: onAir ? "0 0 16px rgba(239,68,68,0.5)" : "none",
              transition: "all 0.2s",
            }}
          >
            {onAir ? "● ON AIR" : "OFF AIR"}
          </button>
        </div>
`;

// Replace the entire header content
const before = c.slice(0, headerStart);
const after = c.slice(headerEnd);
c = before + newHeader + after;

fs.writeFileSync("C:/openair/src/App.tsx", c);
console.log("Done - header reorganized");
