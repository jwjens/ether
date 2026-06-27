// electron/ai-voice.js — AI voice generation for Auto-DJ.
//
// Generates broadcast-ready voice segments from text using one of:
//   - elevenlabs:  best quality, voice cloning support, $5/mo starter
//   - openai:      OpenAI TTS-1 / TTS-1-HD, $15/M chars, simple
//   - browser:     Web Speech API, FREE, lower quality (renderer-side, fallback)
//
// All providers return MP3, which we save to disk and reference from the
// ai_voice_segments table. Audio playback is handled by the renderer
// (loads file:// URL).
//
// Provider config is stored in station_config_kv as 'ai_voice_config' JSON:
//   { provider, apiKey, voiceId, model, stability, similarity }

const fs   = require("fs");
const path = require("path");
const https = require("https");
const { URL } = require("url");

let getDb = () => null;   // resolves the LIVE connection (set in install); survives a reopen
let voiceSegmentsDir = null;

// ── Config helpers ──────────────────────────────────────────
function getConfig() {
  try {
    const row = getDb().prepare("SELECT value FROM station_config_kv WHERE key = 'ai_voice_config'").get();
    if (row?.value) return JSON.parse(row.value);
  } catch {}
  return { provider: "elevenlabs", apiKey: "", voiceId: "", model: "eleven_turbo_v2_5", stability: 0.5, similarity: 0.75 };
}
function setConfig(cfg) {
  try {
    getDb().prepare("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('ai_voice_config', ?)").run(JSON.stringify(cfg));
    return true;
  } catch { return false; }
}

// ── Generic HTTPS POST returning a Buffer (audio binary) ────
function httpsPostBinary(urlString, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      method: "POST",
      headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
      timeout: 60000,
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body: buf, headers: res.headers });
        } else {
          // Try to extract error message from JSON body (most providers return JSON errors)
          let msg = `HTTP ${res.statusCode}`;
          try { const j = JSON.parse(buf.toString("utf8")); msg = j?.detail?.message || j?.error?.message || j?.message || msg; } catch {}
          reject(new Error(msg + ` (${buf.toString("utf8").slice(0, 200)})`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("TTS request timeout")); });
    req.write(body);
    req.end();
  });
}
function httpsGetJson(urlString, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    https.get({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      headers, timeout: 30000,
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        try {
          const json = JSON.parse(buf.toString("utf8"));
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(new Error(json?.detail?.message || json?.error?.message || `HTTP ${res.statusCode}`));
        } catch (e) { reject(new Error("Invalid JSON: " + buf.toString("utf8").slice(0, 200))); }
      });
    }).on("error", reject);
  });
}

// ── Provider: ElevenLabs ────────────────────────────────────
// Eleven Multilingual v2 / Turbo v2.5 are great for broadcast voiceover.
// Free tier: 10k chars/mo. Paid: $5/mo for 30k.
async function generateElevenLabs(cfg, text) {
  if (!cfg.apiKey)  throw new Error("ElevenLabs API key not set");
  if (!cfg.voiceId) throw new Error("ElevenLabs voice ID not set — pick a voice in AI Voice settings");
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(cfg.voiceId)}`;
  const body = JSON.stringify({
    text,
    model_id: cfg.model || "eleven_turbo_v2_5",
    voice_settings: {
      stability:        cfg.stability    ?? 0.5,
      similarity_boost: cfg.similarity   ?? 0.75,
      style:            cfg.style        ?? 0,
      use_speaker_boost: true,
    },
  });
  const r = await httpsPostBinary(url, {
    "xi-api-key":   cfg.apiKey,
    "Content-Type": "application/json",
    "Accept":       "audio/mpeg",
  }, body);
  return { mime: "audio/mpeg", ext: "mp3", data: r.body };
}

async function listElevenLabsVoices(cfg) {
  if (!cfg.apiKey) throw new Error("ElevenLabs API key not set");
  const json = await httpsGetJson("https://api.elevenlabs.io/v1/voices", { "xi-api-key": cfg.apiKey });
  return (json.voices || []).map(v => ({
    id:       v.voice_id,
    name:     v.name,
    category: v.category,
    preview:  v.preview_url,
    description: v.labels?.description || "",
  }));
}

// ── Provider: OpenAI TTS ────────────────────────────────────
// Built-in voices: alloy, echo, fable, onyx, nova, shimmer
// tts-1 = $15/M chars (faster). tts-1-hd = $30/M chars (better quality).
async function generateOpenAI(cfg, text) {
  if (!cfg.apiKey) throw new Error("OpenAI API key not set");
  const voice = cfg.voiceId || "alloy";
  const body = JSON.stringify({
    model: cfg.model || "tts-1",
    voice,
    input: text,
    response_format: "mp3",
  });
  const r = await httpsPostBinary("https://api.openai.com/v1/audio/speech", {
    "Authorization": "Bearer " + cfg.apiKey,
    "Content-Type":  "application/json",
  }, body);
  return { mime: "audio/mpeg", ext: "mp3", data: r.body };
}

const OPENAI_VOICES = [
  { id: "alloy",   name: "Alloy",   description: "Balanced, neutral tone" },
  { id: "echo",    name: "Echo",    description: "Smooth, warm male" },
  { id: "fable",   name: "Fable",   description: "Expressive British male" },
  { id: "onyx",    name: "Onyx",    description: "Deep, authoritative male" },
  { id: "nova",    name: "Nova",    description: "Friendly, energetic female" },
  { id: "shimmer", name: "Shimmer", description: "Clear, professional female" },
];

// ── Dispatcher ──────────────────────────────────────────────
async function generateAudio(provider, cfg, text) {
  if (provider === "elevenlabs") return generateElevenLabs(cfg, text);
  if (provider === "openai")     return generateOpenAI(cfg, text);
  throw new Error(`Unknown provider: ${provider} (browser TTS handled in renderer)`);
}

// ── IPC install ─────────────────────────────────────────────
function installAIVoice(ipcMain, database, opts = {}) {
  getDb = (typeof database === 'function') ? database : () => database;
  voiceSegmentsDir = opts.voiceSegmentsDir || path.join(opts.userDataPath || ".", "ai-voice");
  if (!fs.existsSync(voiceSegmentsDir)) fs.mkdirSync(voiceSegmentsDir, { recursive: true });

  ipcMain.handle("ai-voice:get-config",  () => getConfig());
  ipcMain.handle("ai-voice:set-config",  (_, cfg) => { setConfig(cfg); return getConfig(); });

  // List voices for the configured (or specified) provider
  ipcMain.handle("ai-voice:list-voices", async (_, { provider, apiKey } = {}) => {
    const cfg = getConfig();
    const useProvider = provider || cfg.provider;
    const useKey = apiKey || cfg.apiKey;
    try {
      if (useProvider === "elevenlabs") {
        return { ok: true, voices: await listElevenLabsVoices({ ...cfg, apiKey: useKey }) };
      }
      if (useProvider === "openai") {
        return { ok: true, voices: OPENAI_VOICES };
      }
      return { ok: false, error: "browser TTS uses renderer's SpeechSynthesis API — voices listed there" };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Generate a segment from text. Saves to disk, inserts row, returns the row.
  ipcMain.handle("ai-voice:generate", async (_, { title, script, templateId = null, providerOverride = null, voiceIdOverride = null, stationId = 1 }) => {
    const cfg = getConfig();
    const provider = providerOverride || cfg.provider;
    const voiceId  = voiceIdOverride  || cfg.voiceId;

    let segmentId;
    try {
      const r = getDb().prepare(
        "INSERT INTO ai_voice_segments (template_id, title, script, provider, voice_id, status, station_id) VALUES (?, ?, ?, ?, ?, 'generating', ?)"
      ).run(templateId, title || "Untitled", script, provider, voiceId, stationId);
      segmentId = r.lastInsertRowid;
    } catch (e) {
      return { ok: false, error: "DB insert failed: " + e.message };
    }

    try {
      const useCfg = { ...cfg, voiceId };
      const result = await generateAudio(provider, useCfg, script);
      const filename = `aiv-${segmentId}-${Date.now()}.${result.ext}`;
      const filePath = path.join(voiceSegmentsDir, filename);
      fs.writeFileSync(filePath, result.data);
      const stat = fs.statSync(filePath);

      getDb().prepare(
        "UPDATE ai_voice_segments SET status='ready', file_path=?, size_bytes=?, generated_at=? WHERE id=? AND station_id=?"
      ).run(filePath, stat.size, Math.floor(Date.now() / 1000), segmentId, stationId);

      const row = getDb().prepare("SELECT * FROM ai_voice_segments WHERE id=? AND station_id=?").get(segmentId, stationId);
      return { ok: true, segment: row };
    } catch (e) {
      getDb().prepare("UPDATE ai_voice_segments SET status='error', error_msg=? WHERE id=? AND station_id=?")
        .run(e.message || String(e), segmentId, stationId);
      return { ok: false, error: e.message || String(e), segmentId };
    }
  });

  // List segments — newest first
  ipcMain.handle("ai-voice:list-segments", (_, { status, limit = 100, stationId = 1 } = {}) => {
    try {
      const sql = status
        ? "SELECT * FROM ai_voice_segments WHERE station_id=? AND status=? ORDER BY created_at DESC LIMIT ?"
        : "SELECT * FROM ai_voice_segments WHERE station_id=? ORDER BY created_at DESC LIMIT ?";
      return status ? getDb().prepare(sql).all(stationId, status, limit) : getDb().prepare(sql).all(stationId, limit);
    } catch { return []; }
  });

  // Update status (queued/played/archived) and metadata
  ipcMain.handle("ai-voice:update-segment", (_, { id, status, title, stationId = 1 }) => {
    try {
      if (status) {
        getDb().prepare(
          "UPDATE ai_voice_segments SET status=?, played_at=CASE WHEN ?='played' THEN unixepoch() ELSE played_at END WHERE id=? AND station_id=?"
        ).run(status, status, id, stationId);
      }
      if (title !== undefined) getDb().prepare("UPDATE ai_voice_segments SET title=? WHERE id=? AND station_id=?").run(title, id, stationId);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle("ai-voice:delete-segment", (_, { id, stationId = 1 }) => {
    try {
      const row = getDb().prepare("SELECT file_path FROM ai_voice_segments WHERE id=? AND station_id=?").get(id, stationId);
      if (row?.file_path && fs.existsSync(row.file_path)) {
        try { fs.unlinkSync(row.file_path); } catch {}
      }
      getDb().prepare("DELETE FROM ai_voice_segments WHERE id=? AND station_id=?").run(id, stationId);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // ── Templates ──
  ipcMain.handle("ai-voice:list-templates", () => {
    try {
      const rows = getDb().prepare("SELECT * FROM ai_voice_templates ORDER BY name").all();
      // First-time seed: drop in some sensible defaults if empty
      if (rows.length === 0) {
        const seeds = [
          { name: "Time check",      kind: "evergreen", prompt: "It's {{time}} on {{stationName}}." },
          { name: "Weather report",  kind: "recurring", prompt: "Right now in {{city}} it's {{temperature}} degrees and {{conditions}}. Today's high {{high}}, low {{low}}." },
          { name: "Now playing intro", kind: "evergreen", prompt: "Coming up next on Ether, here's {{title}} by {{artist}}." },
          { name: "Station ID",       kind: "evergreen", prompt: "You're listening to {{stationName}} — your home for great music." },
          { name: "Up next",          kind: "evergreen", prompt: "Stay tuned, {{nextShow}} is coming up at {{nextShowTime}}." },
          { name: "Top of hour",      kind: "recurring", prompt: "It's {{hour}} o'clock at {{stationName}}. Here's what's coming up this hour." },
        ];
        for (const s of seeds) {
          getDb().prepare("INSERT INTO ai_voice_templates (name, kind, prompt_template) VALUES (?, ?, ?)").run(s.name, s.kind, s.prompt);
        }
        return getDb().prepare("SELECT * FROM ai_voice_templates ORDER BY name").all();
      }
      return rows;
    } catch { return []; }
  });

  ipcMain.handle("ai-voice:save-template", (_, { id, name, kind, prompt_template, voice_id, provider }) => {
    try {
      if (id) {
        getDb().prepare("UPDATE ai_voice_templates SET name=?, kind=?, prompt_template=?, voice_id=?, provider=? WHERE id=?")
          .run(name, kind || "evergreen", prompt_template, voice_id || "", provider || "", id);
      } else {
        const r = getDb().prepare("INSERT INTO ai_voice_templates (name, kind, prompt_template, voice_id, provider) VALUES (?, ?, ?, ?, ?)")
          .run(name, kind || "evergreen", prompt_template, voice_id || "", provider || "");
        return { ok: true, id: r.lastInsertRowid };
      }
      return { ok: true, id };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle("ai-voice:delete-template", (_, { id }) => {
    try { getDb().prepare("DELETE FROM ai_voice_templates WHERE id = ?").run(id); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  console.log("[AI-VOICE] installed — segments dir:", voiceSegmentsDir);
}

module.exports = { installAIVoice };
