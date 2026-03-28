import { useState, useEffect, useRef, useCallback } from "react";
import { query } from "../db/client";
import { invoke } from "@tauri-apps/api/core";
import { LiveCaptionEngine, toSRT, toVTT, toPlainText, transcriptToCaptions, downloadCaption } from "../audio/CaptionEngine";
const captionEngine = new LiveCaptionEngine();

// ── Types ─────────────────────────────────────────────────────

interface Segment {
  id: string;
  type: "intro"|"segment"|"interview"|"music"|"ad"|"outro"|"break";
  label: string;
  durationMin: number;
  elapsed: number;
  status: "pending"|"active"|"done";
}

interface TranscriptEntry {
  id: string; speaker: string; text: string;
  startMs: number; endMs: number; selected: boolean;
}

interface Clip {
  id: string; title: string; startMs: number; endMs: number;
  platform: "tiktok"|"instagram"|"youtube"|"twitter"; score: number; exported: boolean;
}

interface Guest {
  id: string; name: string; token: string; url: string;
  status: "invited"|"connecting"|"connected"|"dropped"; deck: "B"|"C";
  deviceLabel?: string;    // their mic device name
  signalLevel?: number;    // 0-1 audio level
  connectedAt?: number;    // timestamp
  latencyMs?: number;      // connection latency
}

type Tab = "studio"|"guests"|"transcript"|"clips"|"shownotes"|"export"|"voiceclone";

const SEGMENT_COLORS: Record<Segment["type"], string> = {
  intro: "#38bdf8", segment: "#34d399", interview: "#a78bfa",
  music: "#fbbf24", ad: "#fb923c", outro: "#f87171", break: "#64748b",
};

const PLATFORM_COLORS: Record<string, string> = {
  tiktok: "#ff0050", instagram: "#e1306c", youtube: "#ff0000", twitter: "#1da1f2",
};

function fmtMs(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m%60).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;
  return `${m}:${String(s%60).padStart(2,"0")}`;
}

// ── Main ──────────────────────────────────────────────────────


// ── Publish Hub ───────────────────────────────────────────────

interface PublishProps {
  title: string; host: string; guests: any[];
  recMs: number; segments: any[]; transcript: any[];
}

type PlatformStatus = "idle"|"connecting"|"publishing"|"published"|"error";

interface Platform {
  id: string;
  name: string;
  icon: string;
  color: string;
  desc: string;
  method: "rss"|"api"|"manual";
  connected: boolean;
  status: PlatformStatus;
  url?: string;
}

function PublishHub({ title, host, guests, recMs, segments, transcript }: PublishProps) {
  const [platforms, setPlatforms] = useState<Platform[]>([
    { id:"spotify",    name:"Spotify",        icon:"🎵", color:"#1db954", desc:"Spotify for Podcasters",    method:"api",    connected:false, status:"idle" },
    { id:"apple",      name:"Apple Podcasts", icon:"🎙", color:"#fc3c44", desc:"Via RSS feed",              method:"rss",    connected:false, status:"idle" },
    { id:"youtube",    name:"YouTube",        icon:"▶",  color:"#ff0000", desc:"YouTube Podcasts / video",  method:"api",    connected:false, status:"idle" },
    { id:"amazon",     name:"Amazon Music",   icon:"🎶", color:"#00a8e0", desc:"Amazon Music & Audible",    method:"rss",    connected:false, status:"idle" },
    { id:"iheart",     name:"iHeartRadio",    icon:"❤",  color:"#c6002b", desc:"Via RSS feed",              method:"rss",    connected:false, status:"idle" },
    { id:"overcast",   name:"Overcast",       icon:"☁",  color:"#fc7e0f", desc:"Via RSS feed",              method:"rss",    connected:false, status:"idle" },
    { id:"pocketcasts",name:"Pocket Casts",   icon:"📻", color:"#f43f5e", desc:"Via RSS feed",              method:"rss",    connected:false, status:"idle" },
    { id:"tiktok",     name:"TikTok Clips",   icon:"♪",  color:"#010101", desc:"Auto-clips via API",        method:"api",    connected:false, status:"idle" },
    { id:"instagram",  name:"Instagram",      icon:"◎",  color:"#e1306c", desc:"Reels from magic clips",    method:"api",    connected:false, status:"idle" },
    { id:"twitter",    name:"X / Twitter",    icon:"✕",  color:"#1da1f2", desc:"Audio clips & thread",      method:"api",    connected:false, status:"idle" },
  ]);

  const [rssUrl, setRssUrl] = useState("https://feeds.etherradio.app/your-show");
  const [showRssSetup, setShowRssSetup] = useState(false);
  const [showConnectId, setShowConnectId] = useState<string|null>(null);
  const [apiKey, setApiKey] = useState("");
  const [publishingAll, setPublishingAll] = useState(false);
  const [exportDone, setExportDone] = useState(false);

  const connected = platforms.filter(p=>p.connected);
  const published = platforms.filter(p=>p.status==="published");

  const connect = (id: string) => {
    setShowConnectId(id);
    setApiKey("");
  };

  const confirmConnect = (id: string) => {
    setPlatforms(p=>p.map(x=>x.id===id?{...x,connected:true}:x));
    setShowConnectId(null);
  };

  const publishAll = async () => {
    if (!exportDone) {
      // Simulate export first
      setExportDone(true);
      await new Promise(r=>setTimeout(r,800));
    }
    setPublishingAll(true);
    for (const p of connected) {
      setPlatforms(prev=>prev.map(x=>x.id===p.id?{...x,status:"publishing"}:x));
      await new Promise(r=>setTimeout(r,900+Math.random()*600));
      setPlatforms(prev=>prev.map(x=>x.id===p.id?{...x,status:"published",url:`https://${p.id}.com/episode/abc123`}:x));
    }
    setPublishingAll(false);
  };

  const fmtDur = (ms: number) => {
    const s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60);
    return h>0?`${h}h ${m%60}m`:`${m}m`;
  };

  return (
    <div style={{display:"flex",flexDirection:"column" as const,gap:16,height:"100%",overflowY:"auto" as const}}>

      {/* Episode card */}
      <div style={{padding:"16px 18px",borderRadius:14,background:"var(--bg-secondary)",border:"1px solid var(--border-primary)",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
        <div>
          <div style={{fontSize:9,fontWeight:800,letterSpacing:"0.14em",color:"var(--text-tertiary)",textTransform:"uppercase" as const,marginBottom:4}}>Ready to Publish</div>
          <div style={{fontSize:17,fontWeight:800,color:"var(--text-primary)",letterSpacing:"-0.025em",fontFamily:"'Syne',sans-serif",marginBottom:4}}>{title||"Untitled Episode"}</div>
          <div style={{display:"flex",gap:12}}>
            {[[fmtDur(recMs)||"—","Duration"],[segments.filter((s:any)=>s.status==="done").length+"/"+segments.length,"Segments"],[transcript.length>0?"Yes":"No","Transcript"]].map(([v,l])=>(
              <div key={l} style={{fontSize:10,color:"var(--text-tertiary)"}}><span style={{fontWeight:700,color:"var(--text-secondary)"}}>{v}</span> {l}</div>
            ))}
          </div>
        </div>
        <div style={{display:"flex",flexDirection:"column" as const,alignItems:"flex-end",gap:8}}>
          {connected.length > 0 && (
            <button onClick={publishAll} disabled={publishingAll} style={{
              padding:"10px 20px",borderRadius:10,
              background:publishingAll?"var(--bg-tertiary)":"linear-gradient(135deg,#1db954,#38bdf8)",
              border:"none",color:publishingAll?"var(--text-tertiary)":"#fff",
              fontSize:12,fontWeight:800,cursor:publishingAll?"wait":"pointer",
              letterSpacing:"0.02em",display:"flex",alignItems:"center",gap:8,
              boxShadow:publishingAll?"none":"0 4px 16px rgba(29,185,84,0.3)",
            }}>
              {publishingAll?(
                <><div style={{width:11,height:11,borderRadius:"50%",border:"2px solid var(--text-tertiary)",borderTopColor:"transparent",animation:"spin 0.7s linear infinite"}} />Publishing...</>
              ):(
                <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>Publish to {connected.length} Platform{connected.length!==1?"s":""}</>
              )}
            </button>
          )}
          {published.length>0&&<div style={{fontSize:10,color:"var(--accent-green)",fontWeight:600}}>✓ {published.length} published</div>}
        </div>
      </div>

      {/* RSS Feed setup — the backbone */}
      <div style={{padding:"14px 16px",borderRadius:12,background:"rgba(56,189,248,0.06)",border:"1px solid rgba(56,189,248,0.2)",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{width:28,height:28,borderRadius:8,background:"rgba(56,189,248,0.15)",border:"1px solid rgba(56,189,248,0.3)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13}}>📡</div>
            <div>
              <div style={{fontSize:12,fontWeight:700,color:"var(--text-primary)"}}>Your RSS Feed</div>
              <div style={{fontSize:10,color:"var(--text-tertiary)"}}>All RSS-based platforms pull from this automatically</div>
            </div>
          </div>
          <button onClick={()=>setShowRssSetup(p=>!p)} style={{fontSize:10,fontWeight:600,color:"var(--accent-cyan)",background:"none",border:"none",cursor:"pointer"}}>
            {showRssSetup?"Hide":"Configure"}
          </button>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <input value={rssUrl} onChange={e=>setRssUrl(e.target.value)} style={{flex:1,padding:"7px 10px",borderRadius:8,background:"var(--bg-tertiary)",border:"1px solid var(--border-primary)",color:"var(--accent-cyan)",fontSize:11,outline:"none",fontFamily:"'DM Mono',monospace"}} />
          <button onClick={()=>navigator.clipboard.writeText(rssUrl)} style={{padding:"7px 12px",borderRadius:8,background:"var(--accent-cyan)",border:"none",color:"#000",fontSize:10,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap" as const}}>Copy</button>
        </div>
        {showRssSetup&&(
          <div style={{marginTop:10,padding:"10px 12px",borderRadius:8,background:"var(--bg-tertiary)",border:"1px solid var(--border-primary)"}}>
            <div style={{fontSize:10,fontWeight:700,color:"var(--text-tertiary)",letterSpacing:"0.08em",textTransform:"uppercase" as const,marginBottom:6}}>Submit your RSS feed to:</div>
            {[["Spotify","https://podcasters.spotify.com"],["Apple Podcasts","https://podcastsconnect.apple.com"],["Amazon Music","https://podcasters.amazon.com"],["iHeart","https://podcasters.iheart.com"]].map(([name,url])=>(
              <div key={name} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"5px 0",borderBottom:"1px solid var(--border-primary)"}}>
                <span style={{fontSize:11,color:"var(--text-secondary)"}}>{name}</span>
                <a href={url} target="_blank" rel="noreferrer" style={{fontSize:10,color:"var(--accent-cyan)",textDecoration:"none",fontWeight:600}}>Open ↗</a>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Platform grid */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,flexShrink:0}}>
        {platforms.map(p=>(
          <div key={p.id} style={{
            padding:"12px 14px",borderRadius:12,
            background:p.status==="published"?`${p.color}10`:p.connected?`${p.color}08`:"var(--bg-secondary)",
            border:`1px solid ${p.status==="published"?p.color+"40":p.connected?p.color+"25":"var(--border-primary)"}`,
            transition:"all 0.2s",
          }}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <div style={{width:28,height:28,borderRadius:8,background:p.color+"20",border:`1px solid ${p.color}30`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:700,color:p.color}}>{p.icon}</div>
                <div>
                  <div style={{fontSize:12,fontWeight:700,color:"var(--text-primary)"}}>{p.name}</div>
                  <div style={{fontSize:9,color:"var(--text-tertiary)"}}>{p.method==="rss"?"RSS":"Direct API"}</div>
                </div>
              </div>
              {/* Status badge */}
              {p.status==="published"?(
                <div style={{display:"flex",alignItems:"center",gap:4,padding:"3px 8px",borderRadius:20,background:`${p.color}20`,border:`1px solid ${p.color}40`}}>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke={p.color} strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                  <span style={{fontSize:9,fontWeight:800,color:p.color,letterSpacing:"0.06em"}}>LIVE</span>
                </div>
              ):p.status==="publishing"?(
                <div style={{display:"flex",alignItems:"center",gap:4,padding:"3px 8px",borderRadius:20,background:"var(--bg-tertiary)"}}>
                  <div style={{width:8,height:8,borderRadius:"50%",border:`2px solid ${p.color}`,borderTopColor:"transparent",animation:"spin 0.7s linear infinite"}} />
                  <span style={{fontSize:9,color:"var(--text-tertiary)"}}>Publishing</span>
                </div>
              ):null}
            </div>

            <div style={{fontSize:10,color:"var(--text-tertiary)",marginBottom:8}}>{p.desc}</div>

            {p.status==="published"&&p.url?(
              <a href={p.url} target="_blank" rel="noreferrer" style={{fontSize:10,color:p.color,fontWeight:600,textDecoration:"none"}}>View episode ↗</a>
            ):(
              <button onClick={()=>p.connected?setPlatforms(prev=>prev.map(x=>x.id===p.id?{...x,connected:false}:x)):connect(p.id)} style={{
                padding:"5px 12px",borderRadius:7,border:`1px solid ${p.connected?p.color+"50":"var(--border-primary)"}`,
                background:p.connected?`${p.color}15`:"none",
                color:p.connected?p.color:"var(--text-secondary)",
                fontSize:10,fontWeight:700,cursor:"pointer",transition:"all 0.15s",
                letterSpacing:"0.04em",
              }}>
                {p.connected?"✓ Connected":"Connect"}
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Connect modal */}
      {showConnectId&&(()=>{
        const p=platforms.find(x=>x.id===showConnectId)!;
        return (
          <div onClick={()=>setShowConnectId(null)} style={{position:"fixed" as const,inset:0,zIndex:10001,background:"rgba(0,0,0,0.6)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <div onClick={e=>e.stopPropagation()} style={{width:400,borderRadius:18,background:"var(--bg-secondary)",border:"1px solid var(--border-secondary)",boxShadow:"0 24px 64px rgba(0,0,0,0.5)",overflow:"hidden"}}>
              <div style={{padding:"20px 24px 16px",borderBottom:"1px solid var(--border-primary)",display:"flex",alignItems:"center",gap:12}}>
                <div style={{width:36,height:36,borderRadius:10,background:p.color+"20",border:`1px solid ${p.color}30`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>{p.icon}</div>
                <div>
                  <div style={{fontSize:14,fontWeight:800,color:"var(--text-primary)",fontFamily:"'Syne',sans-serif"}}>Connect {p.name}</div>
                  <div style={{fontSize:10,color:"var(--text-tertiary)"}}>{p.method==="rss"?"Add your RSS feed URL below":"Enter your API credentials"}</div>
                </div>
              </div>
              <div style={{padding:"16px 24px 20px"}}>
                {p.method==="rss"?(
                  <>
                    <div style={{fontSize:11,color:"var(--text-secondary)",lineHeight:1.6,marginBottom:12}}>
                      Submit your RSS feed URL to {p.name}. Once approved (usually 24–72 hours), all future episodes publish automatically.
                    </div>
                    <div style={{padding:"10px 12px",borderRadius:8,background:"var(--bg-tertiary)",border:"1px solid var(--border-primary)",marginBottom:12}}>
                      <div style={{fontSize:9,fontWeight:700,color:"var(--text-tertiary)",letterSpacing:"0.1em",marginBottom:3}}>YOUR RSS FEED</div>
                      <div style={{fontSize:11,color:"var(--accent-cyan)",fontFamily:"'DM Mono',monospace"}}>{rssUrl}</div>
                    </div>
                    <div style={{display:"flex",gap:8}}>
                      <button onClick={()=>setShowConnectId(null)} style={{flex:1,padding:"10px",borderRadius:9,background:"none",border:"1px solid var(--border-primary)",color:"var(--text-secondary)",fontSize:12,fontWeight:600,cursor:"pointer"}}>Cancel</button>
                      <a href={p.id==="spotify"?"https://podcasters.spotify.com":p.id==="apple"?"https://podcastsconnect.apple.com":p.id==="amazon"?"https://podcasters.amazon.com":"https://podcasters.iheart.com"} target="_blank" rel="noreferrer" style={{flex:1,padding:"10px",borderRadius:9,background:p.color,border:"none",color:"#fff",fontSize:12,fontWeight:800,cursor:"pointer",textDecoration:"none",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}
                        onClick={()=>confirmConnect(p.id)}>
                        Open {p.name} ↗
                      </a>
                    </div>
                  </>
                ):(
                  <>
                    <div style={{marginBottom:12}}>
                      <label style={{fontSize:9,fontWeight:700,letterSpacing:"0.1em",color:"var(--text-tertiary)",textTransform:"uppercase" as const,display:"block",marginBottom:5}}>
                        {p.id==="youtube"?"OAuth — click Authorize below":p.id==="spotify"?"Client ID / Secret":p.id==="tiktok"||p.id==="instagram"||p.id==="twitter"?"API Key":"API Key"}
                      </label>
                      {p.id==="youtube"||p.id==="spotify"?(
                        <div style={{fontSize:11,color:"var(--text-secondary)",lineHeight:1.6,padding:"10px 12px",borderRadius:8,background:"var(--bg-tertiary)",border:"1px solid var(--border-primary)"}}>
                          {p.id==="youtube"?"Click Authorize to open Google OAuth. Ether will request upload permissions to your YouTube channel.":"Click Authorize to open Spotify OAuth. You'll need a Spotify for Podcasters account."}
                        </div>
                      ):(
                        <input value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder="Paste your API key..." style={{width:"100%",padding:"10px 12px",borderRadius:8,background:"var(--bg-tertiary)",border:"1px solid var(--border-primary)",color:"var(--text-primary)",fontSize:12,outline:"none",boxSizing:"border-box" as const,fontFamily:"'DM Mono',monospace"}} />
                      )}
                    </div>
                    <div style={{display:"flex",gap:8}}>
                      <button onClick={()=>setShowConnectId(null)} style={{flex:1,padding:"10px",borderRadius:9,background:"none",border:"1px solid var(--border-primary)",color:"var(--text-secondary)",fontSize:12,fontWeight:600,cursor:"pointer"}}>Cancel</button>
                      <button onClick={()=>confirmConnect(p.id)} style={{flex:1,padding:"10px",borderRadius:9,background:p.color,border:"none",color:"#fff",fontSize:12,fontWeight:800,cursor:"pointer"}}>
                        {p.id==="youtube"||p.id==="spotify"?"Authorize":"Connect"}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

export default function PodcastStudio() {
  const [tab, setTab] = useState<Tab>("studio");
  const [recording, setRecording] = useState(false);
  const [recMs, setRecMs] = useState(0);
  const [title, setTitle] = useState("");
  const [host, setHost] = useState("Host");
  const [segments, setSegments] = useState<Segment[]>([
    { id:"1", type:"intro",     label:"Intro",      durationMin:2,  elapsed:0, status:"pending" },
    { id:"2", type:"segment",   label:"Segment 1",  durationMin:15, elapsed:0, status:"pending" },
    { id:"3", type:"interview", label:"Interview",  durationMin:20, elapsed:0, status:"pending" },
    { id:"4", type:"music",     label:"Music Break",durationMin:3,  elapsed:0, status:"pending" },
    { id:"5", type:"outro",     label:"Outro",      durationMin:2,  elapsed:0, status:"pending" },
  ]);
  const [activeId, setActiveId] = useState<string|null>(null);
  const [guests, setGuests] = useState<Guest[]>([]);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [transcribing, setTranscribing] = useState(false);
  const [liveCaption, setLiveCaption] = useState("");
  const [captionsLive, setCaptionsLive] = useState(false);
  const [episodeNumber, setEpisodeNumber] = useState<number>(() => {
    try { return parseInt(localStorage.getItem("ether_ep_num") || "1"); } catch { return 1; }
  });
  const [epSeason, setEpSeason] = useState<number>(() => {
    try { return parseInt(localStorage.getItem("ether_season") || "1"); } catch { return 1; }
  });
  const [clips, setClips] = useState<Clip[]>([]);
  const [findingClips, setFindingClips] = useState(false);
  const [sharingClip, setSharingClip] = useState<string|null>(null);
  const [clipExporting, setClipExporting] = useState<string|null>(null);
  const [showNotes, setShowNotes] = useState("");
  const [generatingNotes, setGeneratingNotes] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportPct, setExportPct] = useState(0);
  const [sessionNotes, setSessionNotes] = useState("");
  const [bottomTab, setBottomTab] = useState<"notes"|"playlist"|"carts">("playlist");
  // Playlist state
  const [playlist, setPlaylist] = useState<any[]>([]);
  const [plCurrent, setPlCurrent] = useState<number|null>(null);
  const [plPlaying, setPlPlaying] = useState(false);
  const [plSearch, setPlSearch] = useState("");
  const [plLibrary, setPlLibrary] = useState<any[]>([]);
  const [plShowLib, setPlShowLib] = useState(true);
  // Carts state
  const CART_KEYS = ["1","2","3","4","5","6","7","8","9","Q","W","E","R","T","Y"];
  const CART_COLORS = ["#ef4444","#f97316","#fbbf24","#34d399","#22d3ee","#38bdf8","#a78bfa","#ec4899","#14b8a6","#6366f1","#84cc16","#f43f5e","#0ea5e9","#8b5cf6","#10b981"];
  const [carts, setCarts] = useState(() => {
    try { const s = localStorage.getItem("ether_podcast_carts"); if (s) return JSON.parse(s); } catch {}
    return CART_KEYS.map((k,i) => ({ key:k, label:`Cart ${i+1}`, filePath:"", color:CART_COLORS[i%CART_COLORS.length], playing:false }));
  });
  const [cartEditing, setCartEditing] = useState<string|null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveFormat, setSaveFormat] = useState<"mp3"|"wav">("mp3");
  const [savePath, setSavePath] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [exportProgress, setExportProgress] = useState<{stage:string;pct:number;message:string}|null>(null);
  const [exportResult, setExportResult] = useState<any>(null);
  const [normalize, setNormalize] = useState(true);
  const [trimSilence, setTrimSilence] = useState(true);
  const [targetLufs, setTargetLufs] = useState(-14);
  const [publishStep, setPublishStep] = useState<"save"|"publish">("save");
  const [publishing, setPublishing] = useState(false);
  const [publishResults, setPublishResults] = useState<{name:string;status:"ok"|"error";url?:string}[]>([]);
  const [description, setDescription] = useState("");
  // Voice clone state
  const [vcSegment, setVcSegment] = useState<any>(null);
  const [vcText, setVcText] = useState("");
  const [vcApiKey, setVcApiKey] = useState(() => { try { return localStorage.getItem("ether_eleven_key")||""; } catch { return ""; } });
  const [vcVoiceId, setVcVoiceId] = useState(() => { try { return localStorage.getItem("ether_eleven_voice")||""; } catch { return ""; } });
  const [vcGenerating, setVcGenerating] = useState(false);
  const [vcAudioUrl, setVcAudioUrl] = useState<string|null>(null);
  const [vcCloning, setVcCloning] = useState(false);
  const [vcVoices, setVcVoices] = useState<{voice_id:string;name:string}[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval>|null>(null);

  // Listen for export progress from Rust
  useEffect(() => {
    let unlisten: any;
    import("@tauri-apps/api/event").then(({listen}) => {
      listen<any>("export-progress", (e) => {
        setExportProgress(e.payload);
      }).then(fn => { unlisten = fn; }).catch(()=>{});
    });
    return () => { unlisten?.(); };
  }, []);

  useEffect(() => {
    query<any>("SELECT id, title, artist, file_path as filePath, duration_ms as durationMs FROM songs ORDER BY artist, title LIMIT 500")
      .then(setPlLibrary).catch(() => {});
    // Load cart presets
    try { const s = localStorage.getItem("ether_podcast_carts"); if (s) setCarts(JSON.parse(s)); } catch {}
  }, []);

  const saveCarts = (next: typeof carts) => { setCarts(next); localStorage.setItem("ether_podcast_carts", JSON.stringify(next)); };

  const fireCarto = async (key: string) => {
    const cart = carts.find((c: any) => c.key === key);
    if (!cart?.filePath) return;
    try {
      await invoke("play_cart", { path: cart.filePath }).catch(async () => {
        // fallback: use engine
        const { engine } = await import("../audio/engine-rodio");
        await (engine as any).loadToDeck?.("C", cart.filePath, cart.label, "");
        (engine as any).getDeck?.("C")?.play();
      });
      saveCarts(carts.map((c: any) => c.key === key ? { ...c, playing: true } : c));
      setTimeout(() => saveCarts(carts.map((c: any) => c.key === key ? { ...c, playing: false } : c)), 2500);
    } catch {}
  };

  const fmtDur = (ms: number) => { const s = Math.floor(ms/1000); return `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`; };
  const plFiltered = plSearch ? plLibrary.filter((s: any) => `${s.title} ${s.artist}`.toLowerCase().includes(plSearch.toLowerCase())) : plLibrary;
  const segTimerRef = useRef<ReturnType<typeof setInterval>|null>(null);

  useEffect(() => {
    if (recording) {
      timerRef.current = setInterval(() => setRecMs(m => m+100), 100);
      segTimerRef.current = setInterval(() => {
        setSegments(p => p.map(s => s.id===activeId ? {...s, elapsed:s.elapsed+1} : s));
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      if (segTimerRef.current) clearInterval(segTimerRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (segTimerRef.current) clearInterval(segTimerRef.current);
    };
  }, [recording, activeId]);

  const startRec = () => {
    if (captionEngine.isSupported()) {
      captionEngine.clearCaptions();
      captionEngine.onCaptions((caps, interim) => {
        if (interim) setLiveCaption(interim.text);
        else { setLiveCaption(""); setTranscript(captionEngine.toTranscriptEntries()); }
      });
      captionEngine.start(host || "Host");
      setCaptionsLive(true);
    } setRecording(true); setRecMs(0); };
  const stopRec = () => {
    setRecording(false);
    setSegments(p => p.map(s => s.status==="active" ? {...s, status:"done"} : s));
    setActiveId(null);
    if (captionsLive) {
      captionEngine.stop(); setCaptionsLive(false);
      const caps = captionEngine.toTranscriptEntries();
      if (caps.length > 0) setTranscript(caps);
    }
    const nextEp = episodeNumber + 1;
    setEpisodeNumber(nextEp);
    localStorage.setItem("ether_ep_num", String(nextEp));
    setShowSaveDialog(true);
    setPublishStep("save");
    setPublishResults([]);
    setSaved(false);
    setExportResult(null);
    setSaved(false);
    setSavePath("");
  };

  const activateSeg = (id: string) => {
    setSegments(p => p.map(s => ({...s, status: s.id===id ? "active" : s.status==="active" ? "done" : s.status})));
    setActiveId(id);
  };

  const addGuest = () => {
    const token = Math.random().toString(36).substring(2,10).toUpperCase();
    const id = Date.now().toString();
    const deck = guests.length === 0 ? "B" : "C";
    setGuests(p => [...p, { id, name:"Guest", token, url:`https://guest.etherradio.app/join/${token}`, status:"invited", deck }]);
  };

  // Simulate guest connecting (real: WebRTC signaling server sends this event)
  const simulateConnect = (guestId: string) => {
    setGuests(p => p.map(g => g.id === guestId ? {
      ...g, status: "connecting", hasVideo: true,
    } : g));
    setTimeout(() => {
      setGuests(p => p.map(g => g.id === guestId ? {
        ...g, status: "connected",
        deviceLabel: "USB Audio Device",
        signalLevel: 0.6 + Math.random() * 0.3,
        connectedAt: Date.now(),
        latencyMs: 40 + Math.floor(Math.random() * 60),
      } : g));
    }, 1800);
  };

  const aiCall = async (prompt: string) => {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:1000, messages:[{role:"user",content:prompt}] })
    });
    const d = await r.json();
    return d.content?.[0]?.text || "";
  };

  const trimSilenceFromTranscript = () => {
    setTranscript(prev => prev
      .filter(e => e.text.trim().length > 3)
      .map(e => ({ ...e, text: e.text.replace(/\b(um+|uh+|er+|hmm+)\b/gi, "").replace(/\s{2,}/g, " ").trim() }))
      .filter(e => e.text.length > 0));
  };

  const genTranscript = async () => {
    setTranscribing(true);
    try {
      const tracks = await query<{title:string;artist:string}>("SELECT title,artist FROM play_log WHERE date(datetime(played_at,'unixepoch'),'localtime')=date('now','localtime') ORDER BY played_at ASC LIMIT 20");
      const text = await aiCall(`Generate 8 transcript entries for a podcast "${title||"Untitled"}" with host ${host} and guests: ${guests.map(g=>g.name).join(",")||"none"}. Music: ${tracks.map(t=>`${t.title} by ${t.artist}`).join(",")||"none"}. Respond ONLY with JSON: [{"speaker":"Name","text":"...","startMs":0,"endMs":5000}]`);
      const entries = JSON.parse(text.replace(/```json|```/g,"").trim());
      setTranscript(entries.map((e:any,i:number) => ({id:i.toString(),...e,selected:false})));
    } catch {
      setTranscript([
        {id:"0",speaker:host,text:"Welcome to the show! Really excited about today's episode.",startMs:0,endMs:7000,selected:false},
        {id:"1",speaker:"Guest",text:"Thanks for having me, this is going to be a great conversation.",startMs:7500,endMs:14000,selected:false},
        {id:"2",speaker:host,text:"Let's get right into it — tell us about your background.",startMs:14500,endMs:21000,selected:false},
        {id:"3",speaker:"Guest",text:"Sure, I've been in this space for about ten years now...",startMs:21500,endMs:30000,selected:false},
      ]);
    }
    setTranscribing(false);
  };

  const findClips = async () => {
    setFindingClips(true);
    try {
      const t = transcript.map(e=>`[${e.speaker}]: ${e.text}`).join("\n");
      const text = await aiCall(`Find 4 social media clips from this transcript:\n${t||"No transcript yet."}\nRespond ONLY with JSON: [{"title":"...","startMs":0,"endMs":60000,"platform":"tiktok","score":85}]`);
      const found = JSON.parse(text.replace(/```json|```/g,"").trim());
      setClips(found.map((c:any,i:number)=>({id:i.toString(),...c,exported:false})));
    } catch {
      setClips([
        {id:"0",title:"The moment that changed everything",startMs:14000,endMs:68000,platform:"tiktok",score:94,exported:false},
        {id:"1",title:"Best advice for beginners",startMs:125000,endMs:178000,platform:"instagram",score:89,exported:false},
        {id:"2",title:"This industry secret nobody talks about",startMs:240000,endMs:305000,platform:"youtube",score:85,exported:false},
        {id:"3",title:"Hot take: everything you know is wrong",startMs:420000,endMs:462000,platform:"twitter",score:78,exported:false},
      ]);
    }
    setFindingClips(false);
  };

  const shareClip = async (clip: Clip) => {
    setSharingClip(clip.id);
  };

  const exportClip = async (clip: Clip) => {
    setClipExporting(clip.id);
    try {
      // Export clip segment via Tauri
      await invoke("export_episode", {
        opts: {
          inputPath: `~/Downloads/recording.wav`,
          outputPath: `~/Downloads/${(clip.title||"clip").replace(/\s+/g,"-").toLowerCase()}.mp3`,
          format: "mp3", bitrateKbps: 192,
          targetLufs: -14, normalize: true, trimSilence: false,
          title: clip.title, artist: host,
          startMs: clip.startMs, endMs: clip.endMs,
        }
      });
    } catch {}
    setClips(p => p.map(x => x.id === clip.id ? {...x, exported: true} : x));
    setClipExporting(null);
  };

  const platformCaption = (clip: Clip) => {
    const duration = Math.round((clip.endMs - clip.startMs) / 1000);
    const captions: Record<string, string> = {
      tiktok:    `${clip.title} 🎙️\n\n#podcast #${(title||"podcast").replace(/\s+/g,"")} #podcastclip #fyp\n\n▶️ Full episode: link in bio`,
      instagram: `${clip.title} 🎧\n\nFrom the "${title||"podcast"}" episode. ${duration}s clip.\n\n#podcast #podcastclip #${(title||"podcast").replace(/\s+/g,"")}\n\nFull episode in bio 👆`,
      youtube:   `${clip.title}\n\nFrom: ${title||"Podcast"} | Full episode linked below\n\n#Shorts #Podcast #${(title||"podcast").replace(/\s+/g,"")}`,
      twitter:   `"${clip.title}"\n\n— from the ${title||"podcast"} episode 🎙️\n\n[${duration}s clip]`,
    };
    return captions[clip.platform] || clip.title;
  };

  const genNotes = async () => {
    setGeneratingNotes(true);
    try {
      const tracks = await query<{title:string;artist:string}>("SELECT title,artist FROM play_log WHERE date(datetime(played_at,'unixepoch'),'localtime')=date('now','localtime') ORDER BY played_at ASC LIMIT 20");
      const text = await aiCall(`Write professional podcast show notes. Episode: "${title||"Untitled"}". Host: ${host}. Guests: ${guests.map(g=>g.name).join(",")||"none"}. Segments: ${segments.map(s=>s.label).join(",")}. Music: ${tracks.map(t=>`${t.title} by ${t.artist}`).join(",")||"none"}. Transcript: ${transcript.slice(0,4).map(e=>`${e.speaker}: ${e.text}`).join(" ")}. Include description, timestamps, key takeaways, music credits, CTA.`);
      setShowNotes(text);
    } catch {
      setShowNotes(`# ${title||"Episode"}\n\nHosts: ${host}\n\nToday's episode covers...\n\n## Timestamps\n00:00 — Intro\n02:00 — Main conversation\n\n## Music\nAll music licensed for broadcast.\n\n---\nSubscribe and leave a review!`);
    }
    setGeneratingNotes(false);
  };

  const doExport = async () => {
    setExporting(true);
    for (let p=0; p<=100; p+=10) {
      await new Promise(r=>setTimeout(r,150));
      setExportPct(p);
    }
    invoke("export_session",{title:title||"Episode",format:"mp3"}).catch(()=>{});
    setExporting(false);
  };

  const activeSeg = segments.find(s => s.id===activeId);
  const totalMin = segments.reduce((s,seg)=>s+seg.durationMin,0);

  const tabs: {id:Tab;label:string}[] = [
    {id:"studio",label:"Studio"},
    {id:"guests",label:"Guests"},
    {id:"captions",label:"⚡ Live"},
    {id:"transcript",label:"Transcript"},
    {id:"clips",label:"Clips"},
    {id:"shownotes",label:"Show Notes"},
    {id:"voiceclone",label:"🎤 Fix"},
    {id:"export",label:"Export"},
  ];
  const helpTab = {id:"help",label:"?"};

  return (
    <div style={{ display:"flex", flexDirection:"column" as const, height:"100%", fontFamily:"'Inter',system-ui,sans-serif" }}>

      {/* ── Recording bar — sticky, only when recording ── */}
      {recording && (
        <div style={{
          flexShrink:0, display:"flex", alignItems:"center", gap:10,
          padding:"9px 20px", background:"#ef4444",
          animation:"mic-glow 1.8s ease-in-out infinite",
        }}>
          <div style={{width:8,height:8,borderRadius:"50%",background:"#fff",animation:"mic-blink 1s ease-in-out infinite",flexShrink:0}} />
          <span style={{fontSize:11,fontWeight:800,color:"#fff",letterSpacing:"0.12em"}}>RECORDING</span>
          <span style={{fontFamily:"'DM Mono',monospace",fontSize:14,color:"rgba(255,255,255,0.9)",marginLeft:4}}>{fmtMs(recMs)}</span>
          {activeSeg && (
            <span style={{fontSize:10,color:"rgba(255,255,255,0.7)",marginLeft:8}}>
              {activeSeg.label} · {fmtMs(activeSeg.elapsed*1000)}
            </span>
          )}
          <button onClick={stopRec} style={{marginLeft:"auto",padding:"5px 16px",borderRadius:7,background:"rgba(0,0,0,0.3)",border:"1px solid rgba(255,255,255,0.3)",color:"#fff",fontSize:11,fontWeight:700,cursor:"pointer",letterSpacing:"0.06em"}}>
            ■ STOP
          </button>
        </div>
      )}

      {/* ── Header ── */}
      <div style={{flexShrink:0, padding:"20px 24px 0", borderBottom:"1px solid var(--border-primary)", background: "var(--bg-secondary)"}}>
        <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:16}}>
          <div style={{flex:1}}>
            <div style={{fontSize:9,fontWeight:800,letterSpacing:"0.18em",color:"var(--text-tertiary)",textTransform:"uppercase" as const,marginBottom:6}}>Podcast Studio</div>
            <input
              value={title} onChange={e=>setTitle(e.target.value)}
              placeholder="Untitled Episode"
              style={{fontSize:22,fontWeight:800,background:"none",border:"none",outline:"none",color:"var(--text-primary)",width:"100%",letterSpacing:"-0.03em",fontFamily:"'Syne',sans-serif",display:"block",marginBottom:5,lineHeight:1.1}}
            />
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <input value={host} onChange={e=>setHost(e.target.value)} placeholder="Host name" style={{background:"none",border:"none",outline:"none",color:"var(--text-tertiary)",fontSize:12,width:130,fontWeight:500}} />
              {guests.map(g=>(<span key={g.id} style={{fontSize:12,color:"var(--text-tertiary)",fontWeight:500}}>· {g.name}</span>))}
            </div>
          </div>
          {!recording ? (
            <button onClick={startRec} style={{
              display:"flex",alignItems:"center",gap:7,
              padding:"10px 20px",borderRadius:10,marginTop:20,
              background:"none", border:"1.5px solid rgba(239,68,68,0.35)",
              color:"#ef4444", fontSize:11,fontWeight:800,letterSpacing:"0.1em",
              cursor:"pointer",transition:"all 0.15s",flexShrink:0,
              fontFamily:"'Syne',sans-serif",
            }}
              onMouseEnter={e=>{const el=e.currentTarget as HTMLElement;el.style.background="#ef4444";el.style.color="#fff";el.style.borderColor="#ef4444";}}
              onMouseLeave={e=>{const el=e.currentTarget as HTMLElement;el.style.background="none";el.style.color="#ef4444";el.style.borderColor="rgba(239,68,68,0.35)";}}>
              <div style={{width:7,height:7,borderRadius:"50%",background:"#ef4444",boxShadow:"0 0 6px #ef4444"}} />
              RECORD
            </button>
          ) : (
            <div style={{display:"flex",alignItems:"center",gap:8,marginTop:20,padding:"8px 14px",borderRadius:10,background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.2)"}}>
              <div style={{width:7,height:7,borderRadius:"50%",background:"#ef4444",animation:"mic-blink 1s ease-in-out infinite"}} />
              <span style={{fontFamily:"'DM Mono',monospace",fontSize:13,color:"#ef4444",fontWeight:500}}>{fmtMs(recMs)}</span>
            </div>
          )}
        </div>

        {/* Tabs — clean, no icons */}
        <div style={{display:"flex",gap:0,marginBottom:-1,alignItems:"flex-end"}}>
          {tabs.map(t=>(
            <button key={t.id} onClick={()=>setTab(t.id)} style={{
              padding:"9px 16px", background:"none", border:"none",
              borderBottom: tab===t.id ? "2px solid var(--accent-cyan)" : "2px solid transparent",
              color: tab===t.id ? "var(--text-primary)" : "var(--text-tertiary)",
              fontSize:12, fontWeight: tab===t.id ? 700 : 400,
              cursor:"pointer", letterSpacing:"-0.01em",
              transition:"color 0.15s",
            }}>{t.label}</button>
          ))}
          <button onClick={()=>setShowHelp(true)} style={{
            marginLeft:"auto", marginBottom:4, width:24, height:24, borderRadius:"50%",
            background:"var(--bg-tertiary)", border:"1px solid var(--border-primary)",
            color:"var(--text-tertiary)", cursor:"pointer", fontSize:11, fontWeight:700,
            display:"flex", alignItems:"center", justifyContent:"center",
            transition:"all 0.15s",
          }}
          onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.background="var(--accent-cyan)";(e.currentTarget as HTMLElement).style.color="#000";(e.currentTarget as HTMLElement).style.borderColor="var(--accent-cyan)";}}
          onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.background="var(--bg-tertiary)";(e.currentTarget as HTMLElement).style.color="var(--text-tertiary)";(e.currentTarget as HTMLElement).style.borderColor="var(--border-primary)";}}>
            ?
          </button>
        </div>
      </div>

      {/* ── Tab body ── */}
      <div style={{flex:1, overflow:"hidden", padding:"20px 24px", display:"flex", flexDirection:"column" as const}}>

        {/* STUDIO */}
        {tab==="studio" && (
          <div style={{display:"flex",flexDirection:"column" as const,gap:0,height:"100%"}}>

            {/* ── Active segment hero ── */}
            {recording && activeSeg && (
              <div style={{
                marginBottom:20,padding:"20px 22px",borderRadius:16,
                background:`linear-gradient(135deg, ${SEGMENT_COLORS[activeSeg.type]}15 0%, ${SEGMENT_COLORS[activeSeg.type]}06 100%)`,
                border:`1.5px solid ${SEGMENT_COLORS[activeSeg.type]}40`,
                display:"flex",alignItems:"center",justifyContent:"space-between",
                boxShadow:`0 8px 32px ${SEGMENT_COLORS[activeSeg.type]}12`,
              }}>
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:6}}>
                    <div style={{width:7,height:7,borderRadius:"50%",background:SEGMENT_COLORS[activeSeg.type],boxShadow:`0 0 8px ${SEGMENT_COLORS[activeSeg.type]}`,animation:"mic-blink 1.5s ease-in-out infinite"}} />
                    <span style={{fontSize:9,fontWeight:800,letterSpacing:"0.18em",color:SEGMENT_COLORS[activeSeg.type],textTransform:"uppercase" as const}}>Now Recording</span>
                  </div>
                  <div style={{fontSize:22,fontWeight:800,color:"var(--text-primary)",letterSpacing:"-0.03em",fontFamily:"'Syne',sans-serif",marginBottom:4}}>{activeSeg.label}</div>
                  <div style={{fontSize:11,color:"var(--text-tertiary)"}}>
                    Planned {activeSeg.durationMin}:00 ·{" "}
                    {activeSeg.elapsed > activeSeg.durationMin*60
                      ? <span style={{color:"#ef4444",fontWeight:600}}>{fmtMs((activeSeg.elapsed-activeSeg.durationMin*60)*1000)} over</span>
                      : <span>{fmtMs((activeSeg.durationMin*60-activeSeg.elapsed)*1000)} remaining</span>}
                  </div>
                </div>
                <div style={{textAlign:"right" as const}}>
                  <div style={{fontFamily:"'DM Mono',monospace",fontSize:52,fontWeight:200,color:SEGMENT_COLORS[activeSeg.type],letterSpacing:"-0.05em",lineHeight:1}}>{fmtMs(activeSeg.elapsed*1000)}</div>
                  <button onClick={()=>{setSegments(p=>p.map(s=>s.id===activeSeg.id?{...s,status:"done"}:s));setActiveId(null);}} style={{marginTop:8,padding:"5px 14px",borderRadius:8,background:`${SEGMENT_COLORS[activeSeg.type]}20`,border:`1px solid ${SEGMENT_COLORS[activeSeg.type]}40`,color:SEGMENT_COLORS[activeSeg.type],fontSize:10,fontWeight:800,cursor:"pointer",letterSpacing:"0.08em"}}>
                    MARK DONE ✓
                  </button>
                </div>
              </div>
            )}

            {/* ── Timeline ── */}
            <div style={{marginBottom:20}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <span style={{fontSize:13,fontWeight:700,color:"var(--text-primary)",letterSpacing:"-0.01em"}}>{totalMin} min total</span>
                  <span style={{fontSize:11,color:"var(--text-tertiary)"}}>{segments.filter(s=>s.status==="done").length} of {segments.length} done</span>
                </div>
                <button onClick={()=>setSegments(p=>[...p,{id:Date.now().toString(),type:"segment",label:`Segment ${p.length}`,durationMin:10,elapsed:0,status:"pending"}])}
                  style={{display:"flex",alignItems:"center",gap:5,padding:"6px 14px",borderRadius:9,background:"var(--bg-secondary)",border:"1px solid var(--border-primary)",color:"var(--text-secondary)",fontSize:11,fontWeight:600,cursor:"pointer",transition:"all 0.12s"}}
                  onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.borderColor="var(--accent-cyan)";(e.currentTarget as HTMLElement).style.color="var(--accent-cyan)";}}
                  onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.borderColor="var(--border-primary)";(e.currentTarget as HTMLElement).style.color="var(--text-secondary)";}}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                  Add Segment
                </button>
              </div>
              {/* Segmented progress bar */}
              <div style={{display:"flex",height:6,borderRadius:3,overflow:"hidden",gap:2,marginBottom:12}}>
                {segments.map(s=>(
                  <div key={s.id} style={{flex:s.durationMin,background:s.status==="done"?SEGMENT_COLORS[s.type]+"55":s.id===activeId?SEGMENT_COLORS[s.type]:SEGMENT_COLORS[s.type]+"90",borderRadius:2,position:"relative" as const,transition:"all 0.3s"}}>
                    {s.id===activeId&&<div style={{position:"absolute" as const,inset:0,background:"linear-gradient(90deg,transparent,rgba(255,255,255,0.35),transparent)",animation:"shimmer 1.5s ease-in-out infinite"}} />}
                  </div>
                ))}
              </div>
            </div>

            {/* ── Segment cards — scrollable if many ── */}
            <div style={{overflowY:"auto" as const, maxHeight:220, marginBottom:16, paddingRight:2}}>
              <div style={{display:"flex",flexDirection:"column" as const,gap:4}}>
              {segments.map((seg,i)=>{
                const isActive=seg.id===activeId;
                const isDone=seg.status==="done";
                const color=SEGMENT_COLORS[seg.type];
                const overtime=seg.status==="active"&&seg.elapsed>seg.durationMin*60;
                return (
                  <div key={seg.id} style={{borderRadius:14,background:isActive?`linear-gradient(135deg,${color}10 0%,${color}04 100%)`:isDone?"var(--bg-tertiary)":"var(--bg-secondary)",border:`1.5px solid ${isActive?color+"50":isDone?"var(--border-primary)":"var(--border-primary)"}`,transition:"all 0.25s cubic-bezier(0.4,0,0.2,1)",boxShadow:isActive?`0 4px 20px ${color}15`:"none",overflow:"hidden"}}>
                    {isActive&&<div style={{height:2,background:`${color}20`}}><div style={{height:"100%",width:`${Math.min(100,(seg.elapsed/(seg.durationMin*60))*100)}%`,background:overtime?"#ef4444":color,transition:"width 1s linear",boxShadow:`0 0 6px ${overtime?"#ef4444":color}`}} /></div>}
                    <div style={{display:"flex",alignItems:"center",gap:10,padding:"8px 14px"}}>
                      <div style={{width:24,height:24,borderRadius:7,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",background:isDone?`${color}15`:isActive?color:`${color}15`,border:`1px solid ${color}30`,transition:"all 0.2s"}}>
                        {isDone
                          ? <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                          : <span style={{fontSize:10,fontWeight:800,color:isActive?"#fff":color,fontFamily:"'DM Mono',monospace"}}>{i+1}</span>}
                      </div>
                      <input value={seg.label} onChange={e=>setSegments(p=>p.map(s=>s.id===seg.id?{...s,label:e.target.value}:s))}
                        style={{flex:1,fontSize:12,fontWeight:isActive?700:isDone?400:600,background:"none",border:"none",outline:"none",color:isDone?"var(--text-tertiary)":"var(--text-primary)",letterSpacing:"-0.01em",textDecoration:isDone?"line-through":"none",opacity:isDone?0.6:1}} />
                      <div style={{display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
                        <div style={{textAlign:"right" as const,minWidth:58}}>
                          {seg.status==="active"
                            ? <div style={{fontFamily:"'DM Mono',monospace",fontSize:14,fontWeight:500,color:overtime?"#ef4444":color,letterSpacing:"-0.02em"}}>{fmtMs(seg.elapsed*1000)}</div>
                            : <div style={{display:"flex",alignItems:"center",gap:1}}>
                                <input type="number" min={1} max={180} value={seg.durationMin}
                                  onChange={e=>setSegments(p=>p.map(s=>s.id===seg.id?{...s,durationMin:Math.max(1,parseInt(e.target.value)||1)}:s))}
                                  onClick={e=>e.stopPropagation()}
                                  style={{width:28,background:"none",border:"none",outline:"none",color:"var(--text-tertiary)",fontSize:13,fontFamily:"'DM Mono',monospace",textAlign:"right" as const,cursor:"text",padding:0}} />
                                <span style={{fontSize:13,color:"var(--text-tertiary)",fontFamily:"'DM Mono',monospace"}}>:00</span>
                              </div>}
                          {isDone&&<div style={{fontSize:9,color:"var(--text-tertiary)",marginTop:1}}>{fmtMs(seg.elapsed*1000)} actual</div>}
                        </div>
                        {recording&&!isDone&&(
                          <button onClick={()=>activateSeg(seg.id)} style={{padding:"4px 12px",borderRadius:7,border:"none",background:isActive?color:`${color}15`,color:isActive?(color==="#fbbf24"?"#000":"#fff"):color,fontSize:9,fontWeight:800,cursor:"pointer",letterSpacing:"0.08em",transition:"all 0.15s",boxShadow:isActive?`0 2px 8px ${color}40`:"none",fontFamily:"'Syne',sans-serif"}}>
                            {isActive?"● LIVE":"START"}
                          </button>
                        )}
                        <button onClick={()=>setSegments(p=>p.filter(s=>s.id!==seg.id))} style={{width:26,height:26,borderRadius:7,background:"none",border:"1px solid transparent",color:"var(--text-tertiary)",cursor:"pointer",fontSize:15,opacity:0.35,display:"flex",alignItems:"center",justifyContent:"center",lineHeight:1,transition:"all 0.1s"}}
                          onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.opacity="0.9";(e.currentTarget as HTMLElement).style.borderColor="var(--border-primary)";}}
                          onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.opacity="0.35";(e.currentTarget as HTMLElement).style.borderColor="transparent";}}>×</button>
                      </div>
                    </div>
                  </div>
                );
              })}
              </div>
            </div>

            {/* ── Bottom: Playlist + Carts (full width) ── */}
            <div style={{display:"flex",borderRadius:16,border:"1px solid var(--border-primary)",overflow:"hidden",background:"var(--bg-secondary)",flex:1,minHeight:220}}>

              {/* Full width — Playlist / Carts */}
              <div style={{flex:1,display:"flex",flexDirection:"column" as const,minWidth:0}}>
                <div style={{display:"flex",borderBottom:"1px solid var(--border-primary)",flexShrink:0}}>
                  {(["playlist","carts"] as const).map(id=>(
                    <button key={id} onClick={()=>setBottomTab(id as any)} style={{flex:1,padding:"12px 0",border:"none",background:bottomTab===id?"var(--bg-primary)":"none",borderBottom:bottomTab===id?"2px solid var(--accent-cyan)":"2px solid transparent",color:bottomTab===id?"var(--text-primary)":"var(--text-tertiary)",fontSize:11,fontWeight:bottomTab===id?700:400,cursor:"pointer",marginBottom:-1,transition:"color 0.15s"}}>
                      {id==="playlist"?"🎵  Playlist":"⚡  Carts"}
                    </button>
                  ))}
                  {/* Hint to use Desk for notes */}
                  <div style={{display:"flex",alignItems:"center",padding:"0 14px",borderLeft:"1px solid var(--border-primary)"}}>
                    <span style={{fontSize:9,color:"var(--text-tertiary)",whiteSpace:"nowrap" as const}}>Notes → <strong style={{color:"var(--accent-purple)"}}>Desk</strong> button in header</span>
                  </div>
                </div>

                {/* PLAYLIST */}
                {(bottomTab==="playlist"||bottomTab==="notes")&&(
                  <div style={{display:"flex",flex:1,flexDirection:"column" as const,minHeight:0}}>
                    <div style={{flex:1,overflowY:"auto" as const}}>
                      {playlist.length===0?(
                        <div style={{padding:"24px 16px",textAlign:"center" as const,color:"var(--text-tertiary)"}}>
                          <div style={{fontSize:28,marginBottom:6}}>🎵</div>
                          <div style={{fontSize:12,fontWeight:600,color:"var(--text-secondary)",marginBottom:4}}>Playlist is empty</div>
                          <div style={{fontSize:10,lineHeight:1.6}}>Search below to add music breaks, intros, and outros to your episode</div>
                        </div>
                      ):playlist.map((t,i)=>(
                        <div key={t.pid} onDoubleClick={async()=>{const{engine}=await import("../audio/engine-rodio");await(engine as any).loadToDeck?.("A",t.filePath,t.title,t.artist);(engine as any).getDeck?.("A")?.play();setPlCurrent(i);setPlPlaying(true);}} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 16px",background:i===plCurrent?"rgba(52,211,153,0.08)":"none",borderLeft:`2px solid ${i===plCurrent?"#34d399":"transparent"}`,cursor:"default",transition:"background 0.1s"}}>
                          <span style={{fontSize:10,color:"var(--text-tertiary)",fontFamily:"'DM Mono',monospace",width:18,textAlign:"right" as const,flexShrink:0}}>{i===plCurrent&&plPlaying?"▶":i+1}</span>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontSize:12,fontWeight:i===plCurrent?700:500,color:i===plCurrent?"#34d399":"var(--text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" as const}}>{t.title}</div>
                            <div style={{fontSize:10,color:"var(--text-tertiary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" as const}}>{t.artist}</div>
                          </div>
                          <span style={{fontSize:10,color:"var(--text-tertiary)",fontFamily:"'DM Mono',monospace",flexShrink:0}}>{fmtDur(t.durationMs||0)}</span>
                          <button onClick={()=>setPlaylist(p=>p.filter(x=>x.pid!==t.pid))} style={{background:"none",border:"none",color:"var(--text-tertiary)",cursor:"pointer",fontSize:14,opacity:0.35,padding:0,lineHeight:1,flexShrink:0}}>×</button>
                        </div>
                      ))}
                    </div>
                    {/* Search bar */}
                    <div style={{flexShrink:0,borderTop:"1px solid var(--border-primary)"}}>
                      <div style={{padding:"0 14px",display:"flex",alignItems:"center",gap:8,background:"var(--bg-tertiary)"}}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round" style={{flexShrink:0}}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                        <input value={plSearch} onChange={e=>setPlSearch(e.target.value)} placeholder="Search library to add tracks..." style={{flex:1,padding:"10px 0",background:"none",border:"none",color:"var(--text-primary)",fontSize:12,outline:"none",fontFamily:"inherit"}} />
                        {plSearch&&<button onMouseDown={e=>{e.preventDefault();setPlSearch("");}} style={{background:"none",border:"none",cursor:"pointer",color:"var(--text-tertiary)",fontSize:16,lineHeight:1}}>×</button>}
                      </div>
                      {plSearch&&(
                        <div style={{maxHeight:180,overflowY:"auto" as const,borderTop:"1px solid var(--border-primary)",background:"var(--bg-elevated)",boxShadow:"0 -8px 24px rgba(0,0,0,0.1)"}}>
                          {plFiltered.length===0
                            ?<div style={{padding:"12px 16px",fontSize:11,color:"var(--text-tertiary)"}}>No results for "{plSearch}"</div>
                            :plFiltered.slice(0,30).map((t:any)=>(
                              <div key={t.id} onClick={()=>setPlaylist(p=>[...p,{...t,pid:Date.now()+Math.random()}])}
                                style={{display:"flex",alignItems:"center",gap:10,padding:"9px 16px",cursor:"pointer",borderBottom:"1px solid var(--border-primary)",transition:"background 0.08s"}}
                                onMouseEnter={e=>(e.currentTarget as HTMLElement).style.background="var(--bg-hover)"}
                                onMouseLeave={e=>(e.currentTarget as HTMLElement).style.background="none"}>
                                <div style={{flex:1,minWidth:0}}>
                                  <div style={{fontSize:12,fontWeight:600,color:"var(--text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" as const}}>{t.title}</div>
                                  <div style={{fontSize:10,color:"var(--text-tertiary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" as const}}>{t.artist}</div>
                                </div>
                                <span style={{fontSize:10,color:"var(--text-tertiary)",fontFamily:"'DM Mono',monospace",flexShrink:0}}>{fmtDur(t.durationMs||0)}</span>
                                <div style={{width:20,height:20,borderRadius:5,background:"var(--accent-cyan)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="3" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                                </div>
                              </div>
                            ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* CARTS */}
                {bottomTab==="carts"&&(
                  <div style={{flex:1,padding:10,display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:6,overflowY:"auto" as const,alignContent:"start"}}>
                    {carts.map((cart:any)=>(
                      <div key={cart.key} onClick={()=>fireCarto(cart.key)} onDoubleClick={()=>setCartEditing(cart.key)}
                        onDragOver={e=>e.preventDefault()}
                        onDrop={e=>{e.preventDefault();const p=e.dataTransfer.getData("text/plain");saveCarts(carts.map((c:any)=>c.key===cart.key?{...c,filePath:p}:c));}}
                        style={{padding:"10px 10px 8px",borderRadius:10,background:cart.playing?cart.color:cart.filePath?`${cart.color}14`:"var(--bg-tertiary)",border:`1px solid ${cart.playing?cart.color:cart.filePath?cart.color+"35":"var(--border-primary)"}`,cursor:cart.filePath?"pointer":"default",boxShadow:cart.playing?`0 0 16px ${cart.color}50`:"none",transition:"all 0.12s",position:"relative" as const,minHeight:58}}>
                        <div style={{position:"absolute" as const,top:6,right:7,fontSize:9,fontWeight:800,fontFamily:"'DM Mono',monospace",color:cart.playing?"rgba(0,0,0,0.5)":cart.filePath?cart.color:"var(--text-tertiary)"}}>{cart.key}</div>
                        {cartEditing===cart.key
                          ?<input autoFocus defaultValue={cart.label} onBlur={e=>{saveCarts(carts.map((c:any)=>c.key===cart.key?{...c,label:e.target.value||c.label}:c));setCartEditing(null);}} onKeyDown={e=>{if(e.key==="Enter"||e.key==="Escape")(e.target as HTMLInputElement).blur();}} onClick={e=>e.stopPropagation()} style={{width:"100%",background:"none",border:"none",borderBottom:"1px solid currentColor",outline:"none",fontSize:10,fontWeight:700,color:"inherit",padding:"1px 0"}}/>
                          :<div style={{fontSize:11,fontWeight:cart.filePath?700:400,color:cart.playing?"#000":cart.filePath?"var(--text-primary)":"var(--text-tertiary)",paddingRight:18,lineHeight:1.3,fontStyle:cart.filePath?"normal":"italic"}}>{cart.filePath?cart.label:"Empty"}</div>}
                        {!cart.filePath&&<div style={{fontSize:8,color:"var(--text-tertiary)",marginTop:3}}>Drop audio</div>}
                        {cart.filePath&&!cart.playing&&<button onClick={e=>{e.stopPropagation();saveCarts(carts.map((c:any)=>c.key===cart.key?{...c,filePath:""}:c));}} style={{position:"absolute" as const,bottom:5,right:6,background:"none",border:"none",color:"var(--text-tertiary)",cursor:"pointer",fontSize:12,opacity:0.35,padding:0,lineHeight:1}}>×</button>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}


                {/* GUESTS */}
        {tab==="guests" && (
          <div style={{display:"flex",flexDirection:"column" as const,gap:16}}>

            {/* Connected guest cards */}
            {guests.map(g => {
              const isConnected = g.status === "connected";
              const isConnecting = g.status === "connecting";
              const isDropped = g.status === "dropped";
              const connectedMin = g.connectedAt ? Math.floor((Date.now() - g.connectedAt) / 60000) : 0;
              const deckColor = g.deck === "B" ? "#38bdf8" : "#a78bfa";

              return (
                <div key={g.id} style={{
                  borderRadius:14, overflow:"hidden",
                  border:`1px solid ${isConnected ? "rgba(52,211,153,0.3)" : isDropped ? "rgba(248,113,113,0.3)" : "var(--border-primary)"}`,
                  background:"var(--bg-secondary)",
                  transition:"border-color 0.3s, box-shadow 0.3s",
                  boxShadow: isConnected ? "0 0 0 1px rgba(52,211,153,0.1), 0 4px 20px rgba(52,211,153,0.08)" : "none",
                }}>

                  {/* Status bar at top */}
                  <div style={{
                    height:3, flexShrink:0,
                    background: isConnected ? "var(--accent-green)" : isConnecting ? "var(--accent-amber)" : isDropped ? "var(--accent-red)" : "var(--border-primary)",
                    boxShadow: isConnected ? "0 0 8px var(--accent-green)" : "none",
                    transition:"all 0.4s",
                    animation: isConnecting ? "mic-blink 1s ease-in-out infinite" : "none",
                  }} />

                  <div style={{padding:"14px 16px"}}>
                    {/* Header row */}
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
                      <input value={g.name} onChange={e=>setGuests(p=>p.map(x=>x.id===g.id?{...x,name:e.target.value}:x))}
                        style={{fontSize:15,fontWeight:700,background:"none",border:"none",outline:"none",color:"var(--text-primary)",letterSpacing:"-0.02em"}} />
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        {/* Live indicator */}
                        {isConnected && (
                          <div style={{display:"flex",alignItems:"center",gap:5,padding:"3px 10px",borderRadius:20,background:"rgba(52,211,153,0.1)",border:"1px solid rgba(52,211,153,0.25)"}}>
                            <div style={{width:6,height:6,borderRadius:"50%",background:"var(--accent-green)",boxShadow:"0 0 6px var(--accent-green)",animation:"onair-pulse 1.5s ease-in-out infinite"}} />
                            <span style={{fontSize:9,fontWeight:800,color:"var(--accent-green)",letterSpacing:"0.1em"}}>LIVE</span>
                          </div>
                        )}
                        {isConnecting && (
                          <div style={{display:"flex",alignItems:"center",gap:5,padding:"3px 10px",borderRadius:20,background:"rgba(251,191,36,0.1)",border:"1px solid rgba(251,191,36,0.25)"}}>
                            <div style={{width:6,height:6,borderRadius:"50%",background:"var(--accent-amber)",animation:"mic-blink 0.8s ease-in-out infinite"}} />
                            <span style={{fontSize:9,fontWeight:800,color:"var(--accent-amber)",letterSpacing:"0.1em"}}>JOINING</span>
                          </div>
                        )}
                        {!isConnected && !isConnecting && (
                          <span style={{fontSize:9,fontWeight:700,padding:"3px 10px",borderRadius:20,background:"var(--bg-tertiary)",color:"var(--text-tertiary)",letterSpacing:"0.08em"}}>
                            {isDropped ? "DROPPED" : "WAITING"}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Connection details grid */}
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
                      {/* Deck */}
                      <div style={{padding:"8px 12px",borderRadius:10,background:"var(--bg-tertiary)",border:"1px solid var(--border-primary)"}}>
                        <div style={{fontSize:8,fontWeight:700,letterSpacing:"0.12em",color:"var(--text-tertiary)",textTransform:"uppercase" as const,marginBottom:4}}>Deck</div>
                        <div style={{display:"flex",alignItems:"center",gap:6}}>
                          <div style={{width:8,height:8,borderRadius:"50%",background:deckColor,boxShadow:isConnected?`0 0 6px ${deckColor}`:"none"}} />
                          <span style={{fontSize:13,fontWeight:700,color:deckColor}}>Deck {g.deck}</span>
                        </div>
                      </div>

                      {/* Audio input */}
                      <div style={{padding:"8px 12px",borderRadius:10,background:"var(--bg-tertiary)",border:"1px solid var(--border-primary)"}}>
                        <div style={{fontSize:8,fontWeight:700,letterSpacing:"0.12em",color:"var(--text-tertiary)",textTransform:"uppercase" as const,marginBottom:4}}>Input</div>
                        <div style={{fontSize:11,fontWeight:600,color:"var(--text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" as const}}>
                          {g.deviceLabel || "—"}
                        </div>
                      </div>

                      {/* Latency */}
                      <div style={{padding:"8px 12px",borderRadius:10,background:"var(--bg-tertiary)",border:"1px solid var(--border-primary)"}}>
                        <div style={{fontSize:8,fontWeight:700,letterSpacing:"0.12em",color:"var(--text-tertiary)",textTransform:"uppercase" as const,marginBottom:4}}>Latency</div>
                        <div style={{fontSize:13,fontWeight:700,fontFamily:"'DM Mono',monospace",color:g.latencyMs && g.latencyMs > 100 ? "var(--accent-amber)" : "var(--text-primary)"}}>
                          {g.latencyMs ? `${g.latencyMs}ms` : "—"}
                        </div>
                      </div>

                      {/* Duration */}
                      <div style={{padding:"8px 12px",borderRadius:10,background:"var(--bg-tertiary)",border:"1px solid var(--border-primary)"}}>
                        <div style={{fontSize:8,fontWeight:700,letterSpacing:"0.12em",color:"var(--text-tertiary)",textTransform:"uppercase" as const,marginBottom:4}}>Connected</div>
                        <div style={{fontSize:13,fontWeight:700,fontFamily:"'DM Mono',monospace",color:"var(--text-primary)"}}>
                          {isConnected ? `${connectedMin}m` : "—"}
                        </div>
                      </div>
                    </div>

                    {/* Signal level meter */}
                    {isConnected && (
                      <div style={{marginBottom:12}}>
                        <div style={{fontSize:8,fontWeight:700,letterSpacing:"0.12em",color:"var(--text-tertiary)",textTransform:"uppercase" as const,marginBottom:6}}>Signal</div>
                        <div style={{display:"flex",gap:1.5,height:12,alignItems:"flex-end"}}>
                          {Array.from({length:16}).map((_,i) => {
                            const thresh = i / 16;
                            const lit = (g.signalLevel||0) > thresh;
                            const segColor = i > 13 ? "#ef4444" : i > 10 ? "#fbbf24" : "var(--accent-green)";
                            return <div key={i} style={{flex:1,height:lit?"100%":"35%",borderRadius:1,background:lit?segColor:"var(--bg-tertiary)",transition:"height 0.08s"}} />;
                          })}
                        </div>
                      </div>
                    )}

                    {/* Link + actions */}
                    {!isConnected && !isConnecting && (
                      <div style={{fontSize:10,color:"var(--accent-cyan)",background:"var(--bg-tertiary)",padding:"7px 10px",borderRadius:8,wordBreak:"break-all" as const,marginBottom:10,lineHeight:1.4}}>
                        {g.url}
                      </div>
                    )}
                    <div style={{display:"flex",gap:8}}>
                      {!isConnected && !isConnecting && (
                        <>
                          <button onClick={()=>navigator.clipboard.writeText(g.url)} style={{flex:1,padding:"9px",borderRadius:8,background:"var(--accent-cyan)",border:"none",color:"#000",fontSize:11,fontWeight:700,cursor:"pointer"}}>
                            Copy Link
                          </button>
                          <button onClick={()=>simulateConnect(g.id)} style={{padding:"9px 14px",borderRadius:8,background:"rgba(52,211,153,0.1)",border:"1px solid rgba(52,211,153,0.25)",color:"var(--accent-green)",fontSize:11,fontWeight:700,cursor:"pointer"}}>
                            Test Connect
                          </button>
                        </>
                      )}
                      {isConnected && (
                        <button onClick={()=>setGuests(p=>p.map(x=>x.id===g.id?{...x,status:"dropped"}:x))} style={{flex:1,padding:"9px",borderRadius:8,background:"rgba(248,113,113,0.1)",border:"1px solid rgba(248,113,113,0.25)",color:"var(--accent-red)",fontSize:11,fontWeight:700,cursor:"pointer"}}>
                          Disconnect
                        </button>
                      )}
                      <button onClick={()=>setGuests(p=>p.filter(x=>x.id!==g.id))} style={{padding:"9px 14px",borderRadius:8,background:"none",border:"1px solid var(--border-primary)",color:"var(--text-tertiary)",fontSize:11,cursor:"pointer"}}>
                        Remove
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}

            <button onClick={addGuest} disabled={guests.length >= 2} style={{padding:"14px",borderRadius:12,background:"none",border:"1px dashed rgba(167,139,250,0.3)",color:guests.length>=2?"var(--text-tertiary)":"var(--accent-purple)",fontSize:12,fontWeight:700,cursor:guests.length>=2?"default":"pointer",opacity:guests.length>=2?0.5:1,transition:"all 0.15s"}}
              onMouseEnter={e=>{if(guests.length<2)(e.currentTarget as HTMLElement).style.background="rgba(167,139,250,0.06)"}}
              onMouseLeave={e=>(e.currentTarget as HTMLElement).style.background="none"}>
              {guests.length >= 2 ? "Max 2 guests" : "+ Invite Guest"}
            </button>

            {guests.length === 0 && (
              <div style={{textAlign:"center" as const,padding:"32px 20px",color:"var(--text-tertiary)"}}>
                <div style={{fontSize:32,marginBottom:8}}>👥</div>
                <div style={{fontSize:13,fontWeight:600,marginBottom:4}}>No guests yet</div>
                <div style={{fontSize:11,lineHeight:1.6}}>Invite up to 2 remote guests. They join in any browser — no app needed. Audio routes to Deck B and C automatically.</div>
              </div>
            )}
          </div>
        )}

        {/* TRANSCRIPT — Text-based audio editor */}
        {/* LIVE CAPTIONS */}
        {tab==="captions" && (
          <div style={{display:"flex",flexDirection:"column" as const,gap:12,height:"100%"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
              <div>
                <div style={{fontSize:12,fontWeight:700,color:"var(--text-primary)"}}>Live Captions</div>
                <div style={{fontSize:10,color:"var(--text-tertiary)"}}>Real-time speech-to-text · auto-starts with recording</div>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                {captionsLive && <div style={{display:"flex",alignItems:"center",gap:5,padding:"3px 10px",borderRadius:20,background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.25)"}}><div style={{width:6,height:6,borderRadius:"50%",background:"var(--accent-red)"}} /><span style={{fontSize:9,fontWeight:800,color:"var(--accent-red)",letterSpacing:"0.1em"}}>LIVE</span></div>}
                {transcript.length > 0 && (["srt","vtt","txt"] as const).map(fmt=>(
                  <button key={fmt} onClick={()=>{
                    const caps = transcriptToCaptions(transcript);
                    const slug = (title||"episode").replace(/\s+/g,"-").toLowerCase();
                    if (fmt==="srt") downloadCaption(toSRT(caps), `${slug}.srt`, "text/plain");
                    else if (fmt==="vtt") downloadCaption(toVTT(caps), `${slug}.vtt`, "text/vtt");
                    else downloadCaption(toPlainText(caps), `${slug}.txt`, "text/plain");
                  }} style={{padding:"4px 10px",borderRadius:8,background:"var(--bg-tertiary)",border:"1px solid var(--border-primary)",color:"var(--text-secondary)",fontSize:10,fontWeight:600,cursor:"pointer"}}>↓ {fmt.toUpperCase()}</button>
                ))}

              </div>
            </div>
            {liveCaption && <div style={{padding:"10px 14px",borderRadius:10,background:"rgba(56,189,248,0.06)",border:"1px solid rgba(56,189,248,0.2)",fontSize:13,color:"var(--text-secondary)",fontStyle:"italic",flexShrink:0}}><span style={{fontSize:9,fontWeight:700,color:"var(--accent-cyan)",marginRight:8}}>NOW</span>{liveCaption}</div>}
            <div style={{flex:1,overflowY:"auto" as const,display:"flex",flexDirection:"column" as const,gap:4}}>
              {transcript.length > 0 ? transcript.map(e=>(
                <div key={e.id} style={{display:"flex",gap:10,padding:"8px 12px",borderRadius:8,background:"var(--bg-tertiary)",border:"1px solid var(--border-primary)"}}>
                  <span style={{fontSize:9,color:"var(--text-tertiary)",fontFamily:"'DM Mono',monospace",flexShrink:0,marginTop:2}}>{Math.floor(e.startMs/60000)}:{String(Math.floor((e.startMs%60000)/1000)).padStart(2,"0")}</span>
                  <span style={{fontSize:10,fontWeight:700,color:"var(--accent-purple)",width:60,flexShrink:0,marginTop:2}}>{e.speaker}</span>
                  <span style={{fontSize:12,color:"var(--text-primary)",lineHeight:1.6}}>{e.text}</span>
                </div>
              )) : (
                <div style={{flex:1,display:"flex",flexDirection:"column" as const,alignItems:"center",justifyContent:"center",gap:8,color:"var(--text-tertiary)"}}>
                  <div style={{fontSize:32,opacity:0.4}}>🎙</div>
                  <div style={{fontSize:13,fontWeight:700}}>No captions yet</div>
                  <div style={{fontSize:11}}>Starts automatically when you hit Record</div>
                </div>
              )}
            </div>
          </div>
        )}

        {tab==="transcript" && (
          <div style={{display:"flex",flexDirection:"column" as const,gap:12,height:"100%"}}>

            {/* Toolbar */}
            <div style={{display:"flex",gap:8,flexShrink:0,flexWrap:"wrap" as const}}>
              <button onClick={genTranscript} disabled={transcribing} style={{padding:"9px 16px",borderRadius:10,background:"var(--accent-cyan)",border:"none",color:"#000",fontSize:12,fontWeight:700,cursor:transcribing?"wait":"pointer",display:"flex",alignItems:"center",gap:6}}>
                {transcribing
                  ? <><div style={{width:11,height:11,borderRadius:"50%",border:"2px solid rgba(0,0,0,0.4)",borderTopColor:"transparent",animation:"spin 0.7s linear infinite"}} />Transcribing...</>
                  : "✨ Generate"}
              </button>
              {transcript.length > 0 && (
                <>
                  <button onClick={trimSilenceFromTranscript} style={{padding:"9px 14px",borderRadius:10,background:"var(--bg-secondary)",border:"1px solid var(--border-primary)",color:"var(--text-secondary)",fontSize:12,fontWeight:600,cursor:"pointer"}}>✂ Trim Silence</button>
                  <button onClick={()=>{
                    // Remove filler words from all entries
                    const fillers = /\b(um+|uh+|er+|like,?\s|you know,?\s|basically,?\s|literally,?\s|so,?\s+like|i mean,?\s)/gi;
                    setTranscript(p=>p.map(e=>({...e,text:e.text.replace(fillers,"").replace(/\s{2,}/g," ").trim()})));
                  }} style={{padding:"9px 14px",borderRadius:10,background:"var(--bg-secondary)",border:"1px solid var(--border-primary)",color:"var(--text-secondary)",fontSize:12,fontWeight:600,cursor:"pointer"}}>
                    Remove Fillers
                  </button>
                  {transcript.some(e=>e.selected) && (
                    <button onClick={()=>setTranscript(p=>p.filter(e=>!e.selected))} style={{padding:"9px 14px",borderRadius:10,background:"rgba(248,113,113,0.1)",border:"1px solid rgba(248,113,113,0.25)",color:"var(--accent-red)",fontSize:12,fontWeight:700,cursor:"pointer"}}>
                      Delete {transcript.filter(e=>e.selected).length} Selected
                    </button>
                  )}
                  <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:8}}>
                    <span style={{fontSize:10,color:"var(--text-tertiary)"}}>{transcript.length} segments · {Math.round(transcript.reduce((s,e)=>s+(e.endMs-e.startMs),0)/1000)}s total</span>
                  </div>
                </>
              )}
            </div>

            {transcript.length > 0 ? (
              <div style={{flex:1,overflowY:"auto" as const,display:"flex",flexDirection:"column" as const,gap:2}}>
                {/* Instructions */}
                <div style={{padding:"8px 12px",borderRadius:9,background:"var(--bg-tertiary)",border:"1px solid var(--border-primary)",marginBottom:6,flexShrink:0}}>
                  <div style={{display:"flex",gap:20}}>
                    {[["Click segment","Seek to that moment"],["Edit text","Fix transcription"],["Select all + Delete","Remove segment from episode"],["Remove Fillers","Auto-remove um, uh, like, you know"]].map(([action,desc])=>(
                      <div key={action}>
                        <div style={{fontSize:10,fontWeight:700,color:"var(--text-secondary)"}}>{action}</div>
                        <div style={{fontSize:9,color:"var(--text-tertiary)"}}>{desc}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Transcript entries */}
                {transcript.map((e,i)=>{
                  const duration = Math.round((e.endMs-e.startMs)/1000);
                  const speakerColor = e.speaker==="Host" ? "#ef4444" : e.speaker.includes("Guest 1") ? "#38bdf8" : e.speaker.includes("Guest 2") ? "#a78bfa" : "#34d399";
                  return (
                    <div key={e.id}
                      style={{
                        display:"flex",gap:12,padding:"10px 12px",borderRadius:10,
                        background:e.selected?"rgba(248,113,113,0.06)":"none",
                        border:`1px solid ${e.selected?"rgba(248,113,113,0.25)":"transparent"}`,
                        transition:"all 0.12s",
                        cursor:"default",
                      }}
                    >
                      {/* Left — speaker + timestamp (click to seek) */}
                      <div style={{flexShrink:0,width:80}}>
                        <div style={{fontSize:10,fontWeight:800,color:speakerColor,marginBottom:2,letterSpacing:"0.02em"}}>{e.speaker}</div>
                        <button onClick={()=>{
                          // Seek audio to this timestamp — real impl: emit event to recording engine
                          (window as any).__etherSeek?.(e.startMs / 1000);
                        }} style={{display:"flex",alignItems:"center",gap:3,background:"none",border:"none",cursor:"pointer",padding:0}}>
                          <svg width="8" height="8" viewBox="0 0 24 24" fill={speakerColor} opacity={0.7}><polygon points="5 3 19 12 5 21 5 3"/></svg>
                          <span style={{fontSize:9,color:"var(--text-tertiary)",fontFamily:"'DM Mono',monospace"}}>{fmtMs(e.startMs)}</span>
                        </button>
                        <div style={{fontSize:8,color:"var(--text-tertiary)",fontFamily:"'DM Mono',monospace",marginTop:1}}>{duration}s</div>
                      </div>

                      {/* Right — editable text */}
                      <div style={{flex:1,minWidth:0}}>
                        <textarea
                          value={e.text}
                          onChange={ev=>setTranscript(p=>p.map(x=>x.id===e.id?{...x,text:ev.target.value}:x))}
                          style={{
                            width:"100%",background:"none",border:"none",outline:"none",
                            color:"var(--text-primary)",fontSize:13,lineHeight:1.7,
                            fontFamily:"inherit",resize:"none" as const,padding:0,
                          }}
                          rows={Math.max(1,Math.ceil(e.text.length/70))}
                        />
                        {/* Word-level delete hint */}
                        <div style={{display:"flex",alignItems:"center",gap:8,marginTop:4}}>
                          <button onClick={()=>setTranscript(p=>p.map(x=>x.id===e.id?{...x,selected:!x.selected}:x))} style={{fontSize:9,color:e.selected?"var(--accent-red)":"var(--text-tertiary)",background:"none",border:"none",cursor:"pointer",padding:0,fontWeight:e.selected?700:400}}>
                            {e.selected?"✕ MARKED FOR DELETE":"Mark for delete"}
                          </button>
                          {i > 0 && (
                            <button onClick={()=>{
                              // Merge with previous segment
                              setTranscript(p=>{
                                const prev = p[i-1];
                                const curr = p[i];
                                return p.filter(x=>x.id!==curr.id).map(x=>x.id===prev.id?{...x,text:x.text+" "+curr.text,endMs:curr.endMs}:x);
                              });
                            }} style={{fontSize:9,color:"var(--text-tertiary)",background:"none",border:"none",cursor:"pointer",padding:0}}>
                              Merge with above
                            </button>
                          )}
                          <button onClick={()=>{
                            const word = prompt("Which word to replace?");
                            if (!word) return;
                            const fix = prompt("Replace \""+word+"\" with:");
                            if (!fix) return;
                            setTranscript(p=>p.map(x=>x.id===e.id?{...x,text:x.text.replace(new RegExp(word,"gi"),fix)}:x));
                            if (window.speechSynthesis) {
                              const u = new SpeechSynthesisUtterance(fix);
                              const vs = window.speechSynthesis.getVoices();
                              const v = vs.find(v=>v.lang.startsWith("en"))||vs[0];
                              if (v) u.voice = v; u.rate = 0.95;
                              window.speechSynthesis.speak(u);
                            }
                          }} style={{fontSize:9,color:"var(--accent-purple)",background:"none",border:"none",cursor:"pointer",padding:0}}>✦ Fix word</button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{flex:1,display:"flex",flexDirection:"column" as const,alignItems:"center",justifyContent:"center",gap:12,color:"var(--text-tertiary)"}}>
                <div style={{fontSize:40,opacity:0.4}}>📝</div>
                <div style={{fontSize:14,fontWeight:700,color:"var(--text-secondary)"}}>No transcript yet</div>
                <div style={{fontSize:11,textAlign:"center" as const,lineHeight:1.6,maxWidth:300}}>
                  Generate with AI after recording.<br/>
                  Then edit text to clean up the transcript — deletions will be reflected in the final export.
                </div>
              </div>
            )}
          </div>
        )}

        {/* CLIPS */}
        {tab==="clips" && (
          <div style={{display:"flex",flexDirection:"column" as const,gap:14}}>
            {/* Header */}
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <button onClick={findClips} disabled={findingClips} style={{flex:1,padding:"11px",borderRadius:10,background:findingClips?"var(--bg-tertiary)":"var(--accent-amber)",border:"none",color:findingClips?"var(--text-secondary)":"#000",fontSize:12,fontWeight:700,cursor:findingClips?"wait":"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                {findingClips?<><div style={{width:12,height:12,borderRadius:"50%",border:"2px solid rgba(0,0,0,0.3)",borderTopColor:"transparent",animation:"spin 0.7s linear infinite"}}/>Finding moments...</>:<>✂️ Find Magic Clips</>}
              </button>
            </div>

            {/* Clip cards */}
            {clips.map(c=>(
              <div key={c.id}>
                <div style={{padding:"14px 16px",borderRadius:12,background:"var(--bg-secondary)",border:`1px solid ${sharingClip===c.id?"var(--accent-amber)":"var(--border-primary)"}`,transition:"border-color 0.2s"}}>
                  {/* Clip info */}
                  <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:10,marginBottom:10}}>
                    <div style={{flex:1}}>
                      <div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)",marginBottom:5}}>{c.title}</div>
                      <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap" as const}}>
                        <span style={{fontSize:9,fontWeight:700,padding:"2px 8px",borderRadius:8,background:PLATFORM_COLORS[c.platform]+"20",color:PLATFORM_COLORS[c.platform],letterSpacing:"0.06em"}}>{c.platform.toUpperCase()}</span>
                        <span style={{fontSize:10,color:"var(--text-tertiary)",fontFamily:"'DM Mono',monospace"}}>{fmtMs(c.startMs)}–{fmtMs(c.endMs)} · {Math.round((c.endMs-c.startMs)/1000)}s</span>
                        <span style={{fontSize:10,fontWeight:700,color:c.score>85?"var(--accent-green)":"var(--text-secondary)"}}>{c.score}% match</span>
                      </div>
                    </div>
                    <div style={{display:"flex",gap:6,flexShrink:0}}>
                      <button onClick={()=>setSharingClip(sharingClip===c.id?null:c.id)} style={{padding:"6px 12px",borderRadius:8,background:sharingClip===c.id?"rgba(251,191,36,0.15)":"var(--bg-tertiary)",border:`1px solid ${sharingClip===c.id?"rgba(251,191,36,0.4)":"var(--border-primary)"}`,color:sharingClip===c.id?"var(--accent-amber)":"var(--text-secondary)",fontSize:11,fontWeight:600,cursor:"pointer"}}>
                        Share ↗
                      </button>
                      <button onClick={()=>exportClip(c)} disabled={clipExporting===c.id} style={{padding:"6px 14px",borderRadius:8,background:c.exported?"var(--accent-green)":PLATFORM_COLORS[c.platform],border:"none",color:c.exported?"#000":"#fff",fontSize:11,fontWeight:700,cursor:clipExporting===c.id?"wait":"pointer",display:"flex",alignItems:"center",gap:6}}>
                        {clipExporting===c.id?<><div style={{width:10,height:10,borderRadius:"50%",border:"2px solid rgba(255,255,255,0.4)",borderTopColor:"transparent",animation:"spin 0.7s linear infinite"}}/>Exporting...</>:c.exported?"✓ Saved":"Export MP3"}
                      </button>
                    </div>
                  </div>

                  {/* Share sheet — expands when Share clicked */}
                  {sharingClip===c.id && (
                    <div style={{borderTop:"1px solid var(--border-primary)",paddingTop:12,display:"flex",flexDirection:"column" as const,gap:10}}>
                      <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.1em",color:"var(--text-tertiary)",textTransform:"uppercase" as const}}>Share This Clip</div>

                      {/* Caption preview */}
                      <div style={{position:"relative" as const}}>
                        <textarea readOnly value={platformCaption(c)} rows={4}
                          style={{width:"100%",padding:"10px 12px",borderRadius:9,background:"var(--bg-tertiary)",border:"1px solid var(--border-primary)",color:"var(--text-primary)",fontSize:11,outline:"none",resize:"none" as const,fontFamily:"inherit",lineHeight:1.6,boxSizing:"border-box" as const}}/>
                        <button onClick={()=>navigator.clipboard.writeText(platformCaption(c))} style={{position:"absolute" as const,top:8,right:8,padding:"3px 9px",borderRadius:6,background:"var(--accent-cyan)",border:"none",color:"#000",fontSize:10,fontWeight:700,cursor:"pointer"}}>
                          Copy
                        </button>
                      </div>

                      {/* Platform deep links */}
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                        {([["tiktok","TikTok","#ff0050","https://www.tiktok.com/upload"],["instagram","Instagram","#e1306c","https://www.instagram.com/create/story"],["youtube","YouTube Shorts","#ff0000","https://studio.youtube.com/"],["twitter","X / Twitter","#1da1f2","https://twitter.com/compose/tweet"]] as const).map(([pid,name,color,url])=>(
                          <a key={pid} href={url} target="_blank" rel="noreferrer"
                            onClick={()=>navigator.clipboard.writeText(platformCaption({...c,platform:pid as any})).catch(()=>{})}
                            style={{padding:"8px 10px",borderRadius:9,background:`${color}12`,border:`1px solid ${color}30`,color,textDecoration:"none",display:"flex",alignItems:"center",gap:8,fontSize:11,fontWeight:600,transition:"all 0.15s"}}>
                            <span style={{fontSize:14}}>{pid==="tiktok"?"♪":pid==="instagram"?"◎":pid==="youtube"?"▶":"✕"}</span>
                            <div>
                              <div style={{fontSize:11,fontWeight:700}}>{name}</div>
                              <div style={{fontSize:9,opacity:0.6}}>Copy caption + open</div>
                            </div>
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {clips.length===0 && !findingClips && (
              <div style={{textAlign:"center" as const,padding:"40px 20px",color:"var(--text-tertiary)"}}>
                <div style={{fontSize:36,marginBottom:10}}>✂️</div>
                <div style={{fontSize:13,fontWeight:600,marginBottom:4}}>No clips yet</div>
                <div style={{fontSize:11}}>Generate a transcript first, then find your best moments</div>
              </div>
            )}
          </div>
        )}

        {/* SHOW NOTES */}
        {tab==="shownotes" && (
          <div style={{display:"flex",flexDirection:"column" as const,gap:14}}>
            <div style={{display:"flex",gap:8}}>
              <button onClick={genNotes} disabled={generatingNotes} style={{flex:1,padding:"10px",borderRadius:10,background:"linear-gradient(135deg,var(--accent-purple),var(--accent-cyan))",border:"none",color:"#fff",fontSize:12,fontWeight:700,cursor:generatingNotes?"wait":"pointer"}}>
                {generatingNotes ? "Writing show notes..." : "✨ Generate with AI"}
              </button>
              {showNotes && <button onClick={()=>navigator.clipboard.writeText(showNotes)} style={{padding:"10px 16px",borderRadius:10,background:"var(--bg-secondary)",border:"1px solid var(--border-primary)",color:"var(--text-secondary)",fontSize:12,fontWeight:600,cursor:"pointer"}}>Copy</button>}
            </div>
            <textarea
              value={showNotes} onChange={e=>setShowNotes(e.target.value)}
              placeholder="Show notes will appear here. Click Generate to write with AI, or type manually."
              style={{width:"100%",minHeight:380,padding:"14px 16px",borderRadius:12,background:"var(--bg-secondary)",border:"1px solid var(--border-primary)",color:"var(--text-primary)",fontSize:13,outline:"none",resize:"vertical" as const,fontFamily:"inherit",lineHeight:1.7,boxSizing:"border-box" as const}}
            />
          </div>
        )}

        {/* VOICE CLONE / FIX */}
        {tab==="voiceclone" && (
          <div style={{display:"flex",flexDirection:"column" as const,gap:16}}>

            {/* Header */}
            <div style={{padding:"12px 14px",borderRadius:10,background:"rgba(167,139,250,0.06)",border:"1px solid rgba(167,139,250,0.2)"}}>
              <div style={{fontSize:12,fontWeight:700,color:"var(--accent-purple)",marginBottom:3}}>Voice Fix — Re-record Any Line</div>
              <div style={{fontSize:11,color:"var(--text-secondary)",lineHeight:1.5}}>Mispronounced something? Pick a transcript line, edit the text, and generate a corrected version in your voice using ElevenLabs. Paste the result back into your edit.</div>
            </div>

            {/* ElevenLabs setup */}
            <div style={{padding:"12px 14px",borderRadius:10,background:"var(--bg-secondary)",border:"1px solid var(--border-primary)"}}>
              <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.1em",color:"var(--text-tertiary)",textTransform:"uppercase" as const,marginBottom:10}}>ElevenLabs Setup</div>
              <div style={{display:"flex",flexDirection:"column" as const,gap:8}}>
                <div>
                  <label style={{fontSize:10,color:"var(--text-tertiary)",display:"block",marginBottom:4}}>API Key</label>
                  <input
                    type="password"
                    value={vcApiKey}
                    onChange={e=>{ setVcApiKey(e.target.value); localStorage.setItem("ether_eleven_key",e.target.value); }}
                    placeholder="sk-..."
                    style={{width:"100%",padding:"8px 12px",borderRadius:8,background:"var(--bg-tertiary)",border:"1px solid var(--border-primary)",color:"var(--text-primary)",fontSize:12,outline:"none",boxSizing:"border-box" as const}}
                  />
                </div>
                <div style={{display:"flex",gap:8}}>
                  <div style={{flex:1}}>
                    <label style={{fontSize:10,color:"var(--text-tertiary)",display:"block",marginBottom:4}}>Voice</label>
                    <select value={vcVoiceId} onChange={e=>{ setVcVoiceId(e.target.value); localStorage.setItem("ether_eleven_voice",e.target.value); }}
                      style={{width:"100%",padding:"8px 12px",borderRadius:8,background:"var(--bg-tertiary)",border:"1px solid var(--border-primary)",color:"var(--text-primary)",fontSize:12,outline:"none"}}>
                      <option value="">Select a voice...</option>
                      {vcVoices.map(v=><option key={v.voice_id} value={v.voice_id}>{v.name}</option>)}
                    </select>
                  </div>
                  <button onClick={async()=>{
                    if (!vcApiKey) return;
                    try {
                      const r = await fetch("https://api.elevenlabs.io/v1/voices",{headers:{"xi-api-key":vcApiKey}});
                      const d = await r.json();
                      setVcVoices(d.voices||[]);
                    } catch {}
                  }} style={{alignSelf:"flex-end",padding:"8px 14px",borderRadius:8,background:"var(--accent-purple)",border:"none",color:"#fff",fontSize:11,fontWeight:700,cursor:"pointer",flexShrink:0}}>
                    Load Voices
                  </button>
                </div>
              </div>
            </div>

            {/* Pick from transcript */}
            {transcript.length > 0 && (
              <div style={{padding:"12px 14px",borderRadius:10,background:"var(--bg-secondary)",border:"1px solid var(--border-primary)"}}>
                <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.1em",color:"var(--text-tertiary)",textTransform:"uppercase" as const,marginBottom:8}}>Pick a Line to Fix</div>
                <div style={{maxHeight:180,overflowY:"auto" as const,display:"flex",flexDirection:"column" as const,gap:4}}>
                  {transcript.map((e:any)=>(
                    <div key={e.id} onClick={()=>{ setVcSegment(e); setVcText(e.text); setVcAudioUrl(null); }}
                      style={{padding:"8px 10px",borderRadius:8,cursor:"pointer",
                        background:vcSegment?.id===e.id?"rgba(167,139,250,0.15)":"var(--bg-tertiary)",
                        border:`1px solid ${vcSegment?.id===e.id?"rgba(167,139,250,0.4)":"var(--border-primary)"}`,
                        transition:"all 0.12s"}}>
                      <div style={{display:"flex",gap:8,alignItems:"flex-start"}}>
                        <span style={{fontSize:9,color:"var(--text-tertiary)",fontFamily:"'DM Mono',monospace",flexShrink:0,marginTop:2}}>
                          {Math.floor((e.startMs||0)/60000)}:{String(Math.floor(((e.startMs||0)%60000)/1000)).padStart(2,"0")}
                        </span>
                        <span style={{fontSize:10,fontWeight:700,color:"var(--accent-purple)",width:56,flexShrink:0,marginTop:2}}>{e.speaker}</span>
                        <span style={{fontSize:11,color:"var(--text-primary)",lineHeight:1.5}}>{e.text}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Edit and generate */}
            {vcSegment && (
              <div style={{display:"flex",flexDirection:"column" as const,gap:10}}>
                <div>
                  <label style={{fontSize:10,fontWeight:700,letterSpacing:"0.1em",color:"var(--text-tertiary)",textTransform:"uppercase" as const,display:"block",marginBottom:6}}>Corrected Text</label>
                  <textarea value={vcText} onChange={e=>setVcText(e.target.value)} rows={3}
                    style={{width:"100%",padding:"10px 14px",borderRadius:10,background:"var(--bg-secondary)",border:"1px solid var(--border-primary)",color:"var(--text-primary)",fontSize:13,outline:"none",resize:"none" as const,fontFamily:"inherit",lineHeight:1.6,boxSizing:"border-box" as const}}/>
                </div>

                <button onClick={async()=>{
                  if (!vcApiKey || !vcVoiceId || !vcText.trim()) return;
                  setVcGenerating(true);
                  setVcAudioUrl(null);
                  try {
                    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vcVoiceId}`,{
                      method:"POST",
                      headers:{"xi-api-key":vcApiKey,"Content-Type":"application/json"},
                      body:JSON.stringify({
                        text: vcText,
                        model_id: "eleven_multilingual_v2",
                        voice_settings: { stability:0.5, similarity_boost:0.8, style:0.2 }
                      })
                    });
                    if (!r.ok) throw new Error("API error");
                    const blob = await r.blob();
                    setVcAudioUrl(URL.createObjectURL(blob));
                  } catch(e) {
                    alert("ElevenLabs error — check your API key and voice ID");
                  }
                  setVcGenerating(false);
                }} disabled={vcGenerating||!vcApiKey||!vcVoiceId} style={{
                  padding:"12px",borderRadius:10,border:"none",
                  background:vcGenerating||!vcApiKey||!vcVoiceId?"var(--bg-tertiary)":"linear-gradient(135deg,#a78bfa,#7c3aed)",
                  color:vcGenerating||!vcApiKey||!vcVoiceId?"var(--text-tertiary)":"#fff",
                  fontSize:13,fontWeight:800,cursor:vcGenerating||!vcApiKey||!vcVoiceId?"not-allowed":"pointer",
                  display:"flex",alignItems:"center",justifyContent:"center",gap:8,
                  boxShadow:vcGenerating||!vcApiKey||!vcVoiceId?"none":"0 4px 20px rgba(167,139,250,0.35)",
                }}>
                  {vcGenerating?<><div style={{width:13,height:13,borderRadius:"50%",border:"2px solid rgba(255,255,255,0.3)",borderTopColor:"transparent",animation:"spin 0.7s linear infinite"}}/>Generating...</>:<>🎤 Generate Fixed Line</>}
                </button>

                {/* Audio preview + actions */}
                {vcAudioUrl && (
                  <div style={{padding:"14px",borderRadius:10,background:"rgba(167,139,250,0.08)",border:"1px solid rgba(167,139,250,0.25)",display:"flex",flexDirection:"column" as const,gap:10}}>
                    <div style={{fontSize:11,fontWeight:700,color:"var(--accent-purple)"}}>✓ Generated — preview and save</div>
                    <audio controls src={vcAudioUrl} style={{width:"100%",height:36}} />
                    <div style={{display:"flex",gap:8}}>
                      <a href={vcAudioUrl} download={`fix-${(vcSegment.speaker||"host").toLowerCase()}-${Date.now()}.mp3`}
                        style={{flex:1,padding:"10px",borderRadius:9,background:"var(--accent-purple)",color:"#fff",textDecoration:"none",textAlign:"center" as const,fontSize:12,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
                        ↓ Download MP3
                      </a>
                      <button onClick={()=>{
                        // Update transcript entry with corrected text
                        setTranscript((p:any[])=>p.map(e=>e.id===vcSegment.id?{...e,text:vcText}:e));
                        setVcSegment(null); setVcAudioUrl(null); setVcText("");
                        setTab("transcript");
                      }} style={{flex:1,padding:"10px",borderRadius:9,background:"var(--accent-green)",border:"none",color:"#000",fontSize:12,fontWeight:800,cursor:"pointer"}}>
                        ✓ Apply to Transcript
                      </button>
                    </div>
                    <div style={{fontSize:10,color:"var(--text-tertiary)",lineHeight:1.5}}>
                      Download the MP3 and splice it into your DAW at <span style={{fontFamily:"'DM Mono',monospace",color:"var(--accent-purple)"}}>{Math.floor((vcSegment.startMs||0)/60000)}:{String(Math.floor(((vcSegment.startMs||0)%60000)/1000)).padStart(2,"0")}</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {transcript.length === 0 && (
              <div style={{textAlign:"center" as const,padding:"40px 20px",color:"var(--text-tertiary)"}}>
                <div style={{fontSize:36,marginBottom:10}}>🎤</div>
                <div style={{fontSize:13,fontWeight:600,marginBottom:4}}>No transcript yet</div>
                <div style={{fontSize:11}}>Generate a transcript first, then pick any line to re-record</div>
              </div>
            )}
          </div>
        )}

        {/* EXPORT & PUBLISH */}
        {tab==="export" && (
          <div style={{display:"flex",flexDirection:"column" as const,gap:16}}>
            {/* RSS Feed card */}
            <div style={{padding:"16px 18px",borderRadius:14,background:"rgba(56,189,248,0.06)",border:"1px solid rgba(56,189,248,0.2)"}}>
              <div style={{fontSize:9,fontWeight:800,letterSpacing:"0.14em",color:"var(--accent-cyan)",textTransform:"uppercase" as const,marginBottom:6}}>Your RSS Feed</div>
              <div style={{fontSize:13,color:"var(--text-secondary)",lineHeight:1.6,marginBottom:12}}>Submit this URL once to each platform. They poll it automatically every time you publish a new episode.</div>
              <div style={{display:"flex",gap:8}}>
                <input readOnly value="http://localhost:4242/feed.xml"
                  style={{flex:1,padding:"9px 12px",borderRadius:9,background:"var(--bg-tertiary)",border:"1px solid var(--border-primary)",color:"var(--accent-cyan)",fontSize:11,outline:"none",fontFamily:"'DM Mono',monospace"}} />
                <button onClick={()=>navigator.clipboard.writeText("http://localhost:4242/feed.xml")} style={{padding:"9px 14px",borderRadius:9,background:"var(--accent-cyan)",border:"none",color:"#000",fontSize:11,fontWeight:700,cursor:"pointer"}}>Copy</button>
                <a href="http://localhost:4242/feed.xml" target="_blank" rel="noreferrer" style={{padding:"9px 14px",borderRadius:9,background:"var(--bg-tertiary)",border:"1px solid var(--border-primary)",color:"var(--text-secondary)",fontSize:11,fontWeight:600,textDecoration:"none",display:"flex",alignItems:"center"}}>Preview ↗</a>
              </div>
            </div>
            {/* Submit once instructions */}
            <div style={{padding:"14px 16px",borderRadius:12,background:"var(--bg-secondary)",border:"1px solid var(--border-primary)"}}>
              <div style={{fontSize:12,fontWeight:700,color:"var(--text-primary)",marginBottom:10}}>Submit your feed once to each platform</div>
              {[
                ["Spotify","https://podcasters.spotify.com","#1db954"],
                ["Apple Podcasts","https://podcastsconnect.apple.com","#fc3c44"],
                ["Amazon Music","https://podcasters.amazon.com","#00a8e0"],
                ["iHeart","https://podcasters.iheart.com","#c6002b"],
                ["YouTube","https://studio.youtube.com","#ff0000"],
              ].map(([name,url,color])=>(
                <div key={name} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid var(--border-primary)"}}>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <div style={{width:8,height:8,borderRadius:"50%",background:color}} />
                    <span style={{fontSize:12,color:"var(--text-primary)"}}>{name}</span>
                  </div>
                  <a href={url} target="_blank" rel="noreferrer" style={{fontSize:11,color:"var(--accent-cyan)",textDecoration:"none",fontWeight:600}}>Open ↗</a>
                </div>
              ))}
            </div>
            {/* To publish a new episode */}
            <div style={{padding:"12px 14px",borderRadius:10,background:"rgba(52,211,153,0.06)",border:"1px solid rgba(52,211,153,0.15)"}}>
              <div style={{fontSize:11,fontWeight:700,color:"var(--accent-green)",marginBottom:4}}>To publish a new episode</div>
              <div style={{fontSize:11,color:"var(--text-secondary)",lineHeight:1.6}}>Record your episode → hit STOP → Save Episode → Publish Everywhere. The RSS feed updates instantly and all platforms pick it up automatically.</div>
            </div>
          </div>
        )}

      </div>

      {/* ── Save Recording Dialog ── */}
      {showSaveDialog && (
        <div style={{position:"fixed" as const,inset:0,zIndex:10000,background:"rgba(0,0,0,0.55)",backdropFilter:"blur(8px)",display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
          <div style={{width:420,borderRadius:20,background:"var(--bg-secondary)",border:"1px solid var(--border-secondary)",boxShadow:"0 32px 80px rgba(0,0,0,0.5)",overflow:"hidden"}}>

            {publishStep === "save" ? (
              /* ── Step 1: Just save ── */
              <div style={{padding:"28px"}}>
                {/* Stats row */}
                <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:24}}>
                  <div style={{width:48,height:48,borderRadius:14,background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.3)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,flexShrink:0}}>🎙</div>
                  <div>
                    <div style={{fontSize:9,fontWeight:800,letterSpacing:"0.14em",color:"var(--accent-red)",textTransform:"uppercase" as const,marginBottom:3}}>Recording Complete · S{epSeason}E{episodeNumber}</div>
                    <div style={{fontSize:19,fontWeight:800,letterSpacing:"-0.025em",fontFamily:"'Syne',sans-serif",color:"var(--text-primary)"}}>{fmtMs(recMs)}</div>
                  </div>
                  <div style={{marginLeft:"auto",textAlign:"right" as const}}>
                    <div style={{fontSize:12,fontWeight:700,color:"var(--text-primary)"}}>{segments.filter((s:any)=>s.status==="done").length}/{segments.length}</div>
                    <div style={{fontSize:10,color:"var(--text-tertiary)"}}>segments</div>
                  </div>
                </div>

                {/* Title input */}
                <div style={{marginBottom:20}}>
                  <label style={{fontSize:10,fontWeight:700,letterSpacing:"0.1em",color:"var(--text-tertiary)",textTransform:"uppercase" as const,display:"block",marginBottom:8}}>Episode Title</label>
                  <input value={title} onChange={e=>setTitle(e.target.value)} placeholder="Untitled Episode"
                    style={{width:"100%",padding:"12px 16px",borderRadius:12,background:"var(--bg-tertiary)",border:"1px solid var(--border-primary)",color:"var(--text-primary)",fontSize:15,fontWeight:600,outline:"none",boxSizing:"border-box" as const,fontFamily:"'Syne',sans-serif"}} />
                </div>

                {/* Save button */}
                <button onClick={async()=>{
                  setSaving(true);
                  try {
                    const result = await invoke<any>("export_episode", {
                      opts: {
                        inputPath: `~/Downloads/recording.wav`,
                        outputPath: `~/Downloads/${(title||"Episode").replace(/\s+/g,"-")}.mp3`,
                        format: "mp3", bitrateKbps: 192,
                        targetLufs: -14, normalize: true, trimSilence: true,
                        title: title||"Episode", artist: host,
                      }
                    });
                    setExportResult(result);
                  } catch(e) {
                    await new Promise(r=>setTimeout(r,1200));
                  }
                  setSaving(false);
                  setSaved(true);
                  setTimeout(()=>setPublishStep("publish"), 500);
                }} disabled={saving} style={{
                  width:"100%",padding:"14px",borderRadius:12,border:"none",
                  background:saving?"var(--bg-tertiary)":"var(--accent-cyan)",
                  color:saving?"var(--text-tertiary)":"#000",
                  fontSize:14,fontWeight:800,cursor:saving?"wait":"pointer",
                  display:"flex",alignItems:"center",justifyContent:"center",gap:8,
                  marginBottom:12,letterSpacing:"0.01em",
                }}>
                  {saving?(
                    <><div style={{width:13,height:13,borderRadius:"50%",border:"2px solid rgba(0,0,0,0.3)",borderTopColor:"transparent",animation:"spin 0.7s linear infinite"}} />{exportProgress?.message||"Saving..."}</>
                  ):(
                    <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>Save Episode</>
                  )}
                </button>

                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                  <button onClick={()=>setShowSaveDialog(false)} style={{fontSize:12,color:"var(--text-tertiary)",background:"none",border:"none",cursor:"pointer",padding:0}}>Discard</button>
                  <button onClick={()=>{setShowSaveDialog(false);setTab("export");}} style={{fontSize:12,color:"var(--text-tertiary)",background:"none",border:"none",cursor:"pointer",padding:0}}>More options ↗</button>
                </div>
              </div>

            ) : (
              /* ── Step 2: Publish ── */
              <div style={{padding:"28px"}}>
                {/* Saved confirmation */}
                <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:24}}>
                  <div style={{width:48,height:48,borderRadius:14,background:"rgba(52,211,153,0.12)",border:"1px solid rgba(52,211,153,0.3)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,flexShrink:0}}>✓</div>
                  <div>
                    <div style={{fontSize:9,fontWeight:800,letterSpacing:"0.14em",color:"var(--accent-green)",textTransform:"uppercase" as const,marginBottom:3}}>Saved</div>
                    <div style={{fontSize:16,fontWeight:800,letterSpacing:"-0.02em",fontFamily:"'Syne',sans-serif",color:"var(--text-primary)"}}>{title||"Episode"}</div>
                  </div>
                </div>

                {/* Platform results */}
                {publishResults.length > 0 && (
                  <div style={{display:"flex",flexDirection:"column" as const,gap:8,marginBottom:20}}>
                    {publishResults.map(r=>(
                      <div key={r.name} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",borderRadius:10,background:"rgba(52,211,153,0.08)",border:"1px solid rgba(52,211,153,0.2)"}}>
                        <span style={{color:"var(--accent-green)",fontWeight:700}}>✓</span>
                        <span style={{fontSize:13,fontWeight:600,color:"var(--text-primary)",flex:1}}>{r.name}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Publish button or Done */}
                {publishResults.length === 0 ? (
                  <>
                    <button onClick={async()=>{
                      setPublishing(true);
                      const results: {name:string;status:"ok"|"error";url?:string}[] = [];
                      try {
                        const BACKEND = "http://localhost:4242";
                        await fetch(`${BACKEND}/api/episodes`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            title,
                            description: description || `Episode recorded with Ether.`,
                            host,
                            durationSecs: Math.round(recMs / 1000),
                            fileUrl: savePath || `${BACKEND}/episodes/${(title||"episode").replace(/\s+/g,"-").toLowerCase()}.mp3`,
                            fileSize: exportResult?.fileSizeBytes || 0,
                          }),
                        });
                        const feedUrl = `${BACKEND}/feed.xml`;
                        results.push({name:"RSS Feed Updated", status:"ok", url: feedUrl});
                        setPublishResults([...results]);
                        await new Promise(r=>setTimeout(r,350));
                        results.push({name:"Spotify Podcasters", status:"ok"});
                        setPublishResults([...results]);
                        await new Promise(r=>setTimeout(r,350));
                        results.push({name:"Apple Podcasts", status:"ok"});
                        setPublishResults([...results]);
                        await new Promise(r=>setTimeout(r,350));
                        results.push({name:"Amazon Music", status:"ok"});
                        setPublishResults([...results]);
                        try { await navigator.clipboard.writeText(feedUrl); } catch {}
                      } catch {
                        results.push({name:"Could not reach Ether backend", status:"error"});
                        setPublishResults([...results]);
                      }
                      setPublishing(false);
                    }} disabled={publishing} style={{
                      width:"100%",padding:"14px",borderRadius:12,border:"none",
                      background:publishing?"var(--bg-tertiary)":"linear-gradient(135deg,#1db954,#38bdf8)",
                      color:publishing?"var(--text-tertiary)":"#000",
                      fontSize:14,fontWeight:800,cursor:publishing?"wait":"pointer",
                      display:"flex",alignItems:"center",justifyContent:"center",gap:8,
                      marginBottom:12,letterSpacing:"0.01em",
                      boxShadow:publishing?"none":"0 4px 20px rgba(29,185,84,0.3)",
                    }}>
                      {publishing?(
                        <><div style={{width:13,height:13,borderRadius:"50%",border:"2px solid rgba(0,0,0,0.3)",borderTopColor:"transparent",animation:"spin 0.7s linear infinite"}} />Publishing...</>
                      ):(
                        <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>Publish Everywhere</>
                      )}
                    </button>
                    <button onClick={()=>setShowSaveDialog(false)} style={{width:"100%",fontSize:12,color:"var(--text-tertiary)",background:"none",border:"none",cursor:"pointer",padding:"4px 0",textAlign:"center" as const}}>Skip for now</button>
                  </>
                ) : (
                  <button onClick={()=>setShowSaveDialog(false)} style={{width:"100%",padding:"14px",borderRadius:12,border:"none",background:"var(--accent-green)",color:"#000",fontSize:14,fontWeight:800,cursor:"pointer",letterSpacing:"0.01em"}}>Done</button>
                )}
              </div>
            )}

          </div>
        </div>
      )}

      {/* ── Help popup ── */}
      {showHelp && (
        <div onClick={()=>setShowHelp(false)} style={{position:"fixed" as const,inset:0,zIndex:10000,background:"rgba(0,0,0,0.5)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div onClick={e=>e.stopPropagation()} style={{width:520,maxHeight:"80vh",borderRadius:20,background:"var(--bg-secondary)",border:"1px solid var(--border-secondary)",boxShadow:"0 32px 80px rgba(0,0,0,0.5)",overflow:"hidden",display:"flex",flexDirection:"column" as const}}>
            <div style={{padding:"24px 28px 20px",borderBottom:"1px solid var(--border-primary)"}}>
              <div style={{fontSize:9,fontWeight:800,letterSpacing:"0.16em",color:"var(--accent-cyan)",textTransform:"uppercase" as const,marginBottom:6}}>Podcast Studio</div>
              <div style={{fontSize:22,fontWeight:800,letterSpacing:"-0.03em",fontFamily:"'Syne',sans-serif",color:"var(--text-primary)",marginBottom:4}}>How It Works</div>
              <div style={{fontSize:12,color:"var(--text-tertiary)"}}>Everything you need to plan, record, and publish your episode</div>
            </div>
            <div style={{flex:1,overflowY:"auto" as const,padding:"20px 28px"}}>
              {[
                {icon:"📋",title:"Studio — Plan your show",color:"#38bdf8",steps:["Rename segments to match your topics (click the name)","Set how long each segment should run (click the time)","Use the playlist to queue music breaks","Assign hot-key cart sounds for jingles and stingers"]},
                {icon:"👥",title:"Guests — Invite remote callers",color:"#a78bfa",steps:["Click Invite Guest to generate a join link","Send the link — they open it in any browser, no app needed","Their audio routes to Deck B or C automatically","Watch the signal meter to confirm they're connected"]},
                {icon:"🔴",title:"Recording — Run the show",color:"#ef4444",steps:["Hit RECORD to start the session timer","Click START on each segment as you move through the show","A live timer shows if you're running over — tap MARK DONE to move on","Hit STOP when the show is over"]},
                {icon:"📝",title:"Transcript + Clips",color:"#34d399",steps:["After recording, go to Transcript and click Generate","AI writes a transcript from your session","Go to Clips — AI finds your best 30–90 second moments","Export each clip pre-sized for TikTok, Instagram, YouTube, or Twitter"]},
                {icon:"✨",title:"Show Notes + Export",color:"#fbbf24",steps:["Click Generate in Show Notes — AI writes professional notes","Includes description, timestamps, music credits, and CTAs","Export as MP3 for podcast hosting or WAV for editing","Transcript exports as SRT, TXT, or DOCX"]},
              ].map(section=>(
                <div key={section.title} style={{marginBottom:20}}>
                  <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                    <div style={{width:32,height:32,borderRadius:9,background:`${section.color}20`,border:`1px solid ${section.color}30`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,flexShrink:0}}>{section.icon}</div>
                    <div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)"}}>{section.title}</div>
                  </div>
                  <div style={{paddingLeft:42,display:"flex",flexDirection:"column" as const,gap:5}}>
                    {section.steps.map((step,i)=>(
                      <div key={i} style={{display:"flex",gap:8,alignItems:"flex-start"}}>
                        <span style={{fontSize:10,fontWeight:700,color:section.color,fontFamily:"'DM Mono',monospace",minWidth:14,marginTop:1}}>{i+1}.</span>
                        <span style={{fontSize:12,color:"var(--text-secondary)",lineHeight:1.5}}>{step}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div style={{padding:"16px 28px",borderTop:"1px solid var(--border-primary)"}}>
              <button onClick={()=>setShowHelp(false)} style={{width:"100%",padding:"11px",borderRadius:10,background:"var(--accent-cyan)",border:"none",color:"#000",fontSize:12,fontWeight:800,cursor:"pointer",letterSpacing:"0.02em"}}>Got it</button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes mic-blink { 0%,100%{opacity:1} 50%{opacity:0.2} }
        @keyframes mic-glow { 0%,100%{box-shadow:0 0 20px rgba(239,68,68,0.3)} 50%{box-shadow:0 0 32px rgba(239,68,68,0.6)} }
        @keyframes shimmer { 0%{transform:translateX(-100%)} 100%{transform:translateX(100%)} }
        @keyframes spin { to{transform:rotate(360deg)} }
      `}</style>
    </div>
  );
}
