const fs = require('fs');
let f = fs.readFileSync('src/components/NowPlaying.tsx', 'utf8');

// Find and replace the entire bottom info div
const oldBottom = `        {/* Bottom: Song info + progress */}
        <div style={{ padding: "0 36px 20px" }}>
          <div style={{ background: "rgba(0,0,0,0.4)", borderRadius: 14, padding: "16px 24px", backdropFilter: "blur(20px)", border: "1px solid rgba(255,255,255,0.08)" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 12 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", letterSpacing: "0.2em", textTransform: "uppercase" as any, marginBottom: 4 }}>
                  {isPlaying ? "Now Playing" : "Up Next"}
                </div>
                <div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
                {artist && <div style={{ fontSize: 16, color: "rgba(255,255,255,0.55)", marginTop: 2 }}>{artist}</div>}
              </div>
              <button onClick={handleClose} style={{ marginLeft: 20, flexShrink: 0, padding: "6px 16px", background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8, color: "rgba(255,255,255,0.5)", fontSize: 11, cursor: "pointer", letterSpacing: "0.08em" }}>CLOSE</button>
            </div>
            {dur > 0 && (
              <>
                <div style={{ height: 3, background: "rgba(255,255,255,0.1)", borderRadius: 2, overflow: "hidden", marginBottom: 6 }}>
                  <div style={{ height: "100%", width: pct + "%", background: "#60a5fa", borderRadius: 2, transition: "width 0.5s linear" }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontFamily: "monospace", color: "rgba(255,255,255,0.3)" }}>
                  <span>{fmtTime(pos)}</span>
                  <span>-{fmtTime(dur - pos)}</span>
                </div>
              </>
            )}
          </div>
        </div>`;

const newBottom = `        {/* Bottom: Song info + progress */}
        <div style={{ padding: "0 36px 20px" }}>
          <div style={{ background: "rgba(0,0,0,0.85)", borderRadius: 14, padding: "20px 28px", border: "2px solid rgba(255,255,255,0.2)" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 14 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 14, color: "#ffffff", letterSpacing: "0.2em", textTransform: "uppercase" as any, marginBottom: 6, fontWeight: 600, opacity: 0.7 }}>
                  {isPlaying ? "Now Playing" : "Up Next"}
                </div>
                <div style={{ fontSize: 36, fontWeight: 800, lineHeight: 1.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: "#ffffff" }}>{title}</div>
                {artist && <div style={{ fontSize: 24, color: "#ffffff", marginTop: 4, fontWeight: 400, opacity: 0.85 }}>{artist}</div>}
              </div>
              <button onClick={handleClose} style={{ marginLeft: 20, flexShrink: 0, padding: "8px 18px", background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.3)", borderRadius: 8, color: "#ffffff", fontSize: 12, cursor: "pointer", letterSpacing: "0.08em" }}>CLOSE</button>
            </div>
            {dur > 0 && (
              <>
                <div style={{ height: 6, background: "rgba(255,255,255,0.2)", borderRadius: 3, overflow: "hidden", marginBottom: 8 }}>
                  <div style={{ height: "100%", width: pct + "%", background: "#60a5fa", borderRadius: 3, transition: "width 0.5s linear" }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, fontFamily: "monospace", color: "#ffffff", opacity: 0.8 }}>
                  <span>{fmtTime(pos)}</span>
                  <span>-{fmtTime(dur - pos)}</span>
                </div>
              </>
            )}
          </div>
        </div>`;

if (f.includes('{/* Bottom: Song info + progress */}')) {
  f = f.replace(oldBottom, newBottom);
  console.log('Replaced bottom section');
} else {
  console.log('Pattern not found');
}

fs.writeFileSync('src/components/NowPlaying.tsx', f);
console.log('Done');
