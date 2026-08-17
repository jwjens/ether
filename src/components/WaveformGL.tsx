// src/components/WaveformGL.tsx
//
// GPU-accelerated waveform using WebGL2.
// Falls back gracefully if WebGL2 unavailable.

import { useEffect, useRef, useState } from "react";

interface Props {
  peaks:       Float32Array | null;
  viewStart:   number;
  viewEnd:     number;
  cueIn:       number;
  cueOut:      number;
  introEnd:    number;
  outroStart:  number;
  playhead:    number;
  hoverPos:    number | null;
  dragRegion:  { start: number; end: number; type: "intro" | "outro" } | null;
  onMount?:    (canvas: HTMLCanvasElement) => void;
  // Optional solid tint (hex). When set, the whole waveform is drawn in this
  // color instead of the intro/outro/body zone colors — used by the multitrack
  // timeline so each track's waveform matches its track color.
  tint?:       string;
  // Fade boundaries in the SAME normalized space as viewStart/viewEnd. The waveform's
  // amplitude is scaled by the fade gain between viewStart→fadeInEnd and fadeOutStart→viewEnd,
  // so a committed fade is visible as a taper in the audio itself, not just as an overlay.
  // Defaults (undefined) mean "no fade" — the amplitude is untouched.
  fadeInEnd?:    number;
  fadeOutStart?: number;
  /** The clip's FULL trimmed span. When viewStart/viewEnd is a viewport slice of a clip too wide to
   *  allocate as one canvas, these stay fixed at the clip's real edges so fades and cue geometry are
   *  measured against the clip, not against whatever happens to be on screen. Defaults to the view. */
  clipStart?:    number;
  clipEnd?:      number;
  /** Which span of the clip the `peaks` array covers, in the same normalized space. Defaults to
   *  the whole clip (0..1). When the caller supplies a high-detail slice extraction instead of the
   *  coarse whole-clip array, these say where that slice sits. */
  peaksStart?:   number;
  peaksEnd?:     number;
  /** Identifies this instance in the debug log — without it, "a clip stopped drawing" names no clip. */
  label?:        string;
  /** Log-only context. `fullClipPx` is what an UNSLICED canvas would have had to allocate for this
   *  clip — it keeps the illegal-allocation measurement visible even though slicing now prevents
   *  the allocation from happening. None of these affect rendering. */
  clipDurationMs?: number;
  clipStartMs?:    number;
  zoom?:           number;
  fullClipPx?:     number;
}

function hexToRgb(hex?: string): [number, number, number] {
  if (!hex) return [0, 0, 0];
  const m = hex.replace("#", "");
  const n = parseInt(m.length === 3 ? m.split("").map(c => c + c).join("") : m, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// Glow padding — each bar extends slightly beyond the actual amplitude so the
// fragment shader can draw a neon falloff around the waveform edge.  The extra
// geometry is cheap (same draw call, same vertex count) and keeps the per-peak
// bar structure 100% intact.
const GLOW_PAD = 0.006;

/** The waveform surface is dark by convention — Audition, Pro Tools, every DAW — regardless of the
 *  app skin. It is set on the canvas ELEMENT as well as in the GL clear so that a canvas which never
 *  gets a context, or loses one, still reads as part of the timeline instead of a white hole. */
const SURFACE_DARK = "#0d0d0d";

const VERT = `#version 300 es
precision highp float;
uniform sampler2D u_peaks;
uniform int  u_n;
uniform float u_vs, u_ve;
uniform float u_fadeInEnd, u_fadeOutStart;
uniform float u_cs, u_ce;   // the clip's full trimmed span; u_vs/u_ve may be a slice of it
uniform float u_ps, u_pe;   // the span of the clip that the peak array actually covers
out float v_t, v_amp, v_y;
void main() {
  int pi  = gl_VertexID / 6;
  int sub = gl_VertexID % 6;
  if (pi >= u_n) { gl_Position = vec4(2.0,2.0,0.0,1.0); return; }

  int col, row;
  if      (sub == 0) { col = 0; row = 0; }
  else if (sub == 1) { col = 1; row = 0; }
  else if (sub == 2) { col = 0; row = 1; }
  else if (sub == 3) { col = 1; row = 0; }
  else if (sub == 4) { col = 1; row = 1; }
  else               { col = 0; row = 1; }

  float t    = u_vs + (float(pi) + float(col)) / float(u_n) * (u_ve - u_vs);
  // The peak array does not always cover the whole clip. When zoomed in past the resolution of the
  // coarse array, the caller hands us a HIGH-DETAIL extraction of just the visible slice, and
  // u_ps/u_pe say which part of the clip that array spans. t is remapped into the array's own
  // domain so the same shader draws a whole-clip array and a slice array identically.
  float tex  = (t - u_ps) / max(u_pe - u_ps, 1e-6);
  float peak = texture(u_peaks, vec2(tex, 0.5)).r;
  float amp  = peak * 0.92;

  // ── Fade gain ──
  // A committed fade must be READABLE in the waveform, not only in an overlay drawn on top of it.
  // The envelope is scaled by the same linear gain the mix applies, so the clip's audio visibly
  // tapers to nothing at the edge — the Audition read.
  // Ramps are measured against the CLIP's own edges (u_cs/u_ce), never against the drawn slice —
  // when only part of a clip is on screen, u_vs/u_ve is a window into it, and using those would
  // make the fade restart at the edge of the viewport.
  float gain = 1.0;
  if (u_fadeInEnd > u_cs && t < u_fadeInEnd) {
    gain *= clamp((t - u_cs) / max(u_fadeInEnd - u_cs, 1e-6), 0.0, 1.0);
  }
  if (u_fadeOutStart < u_ce && t > u_fadeOutStart) {
    gain *= clamp((u_ce - t) / max(u_ce - u_fadeOutStart, 1e-6), 0.0, 1.0);
  }
  amp *= gain;
  // Extend quad beyond actual amplitude for the glow region
  float extent = amp + ${GLOW_PAD.toFixed(4)};
  float y    = (row == 0) ? extent : -extent;
  float x    = (t - u_vs) / (u_ve - u_vs) * 2.0 - 1.0;
  gl_Position = vec4(x, y, 0.0, 1.0);
  v_t   = t;
  v_amp = amp;
  v_y   = y;   // interpolated across the quad — tells the frag where it is
}`;

const FRAG = `#version 300 es
precision highp float;
in float v_t, v_amp, v_y;
uniform float u_ci, u_co, u_ie, u_os;
uniform vec3  u_tint;
uniform float u_tintAmt;
out vec4 color;
void main() {
  float t = v_t;

  // Zone colors — same as before, track colors are sacred
  vec3 c;
  if (t < u_ci || t > u_co)   c = vec3(0.4, 0.45, 0.5);   // outside cue — gray
  else if (t < u_ie)           c = vec3(0.13, 0.83, 0.93);  // intro — cyan
  else if (t > u_os)           c = vec3(0.98, 0.57, 0.24);  // outro — orange
  else                         c = vec3(0.98, 0.75, 0.14);  // body — gold

  // Optional per-track tint overrides the zone colors entirely.
  c = mix(c, u_tint, u_tintAmt);

  // Distance from the waveform edge (negative = inside, positive = glow zone)
  float dist = abs(v_y) - v_amp;

  if (dist > 0.0) {
    // ── Outside the envelope ──
    // Was a wide neon falloff, which smeared adjacent peaks into one mass — the "big rectangle".
    // Now a tight 1px-ish antialias edge only: the shape reads, the glow does not fill the gaps.
    float aa = exp(-dist * 220.0) * 0.5;
    color = vec4(c, aa);
  } else {
    // ── Inside the envelope ──
    // Alpha now TRACKS AMPLITUDE. It used to floor at 0.7, so a whisper painted almost as solid as
    // a peak and the lane became a block you could not pick a spike out of. A quiet column is now
    // visibly quieter, and the crest of a transient is the brightest thing in the clip — which is
    // what makes "find the spike and pull it down" a thing you can actually do by eye.
    float edgeDist = -dist;
    float crest    = exp(-edgeDist * 26.0) * 0.45;   // bright rim right at the peak edge
    float body     = 0.30 + v_amp * 0.55;            // 0.30 floor keeps quiet passages visible
    float a        = min(body + crest, 1.0);
    color = vec4(c, a);
  }
}`;

export default function WaveformGL({
  peaks, viewStart, viewEnd,
  cueIn, cueOut, introEnd, outroStart,
  playhead, hoverPos, dragRegion, onMount, tint,
  fadeInEnd, fadeOutStart, clipStart, clipEnd, peaksStart, peaksEnd, label,
  clipDurationMs, clipStartMs, zoom, fullClipPx,
}: Props) {
  const pStart = peaksStart ?? 0;
  const pEnd   = peaksEnd   ?? 1;
  /** Draw-state log, deduped by signature.
   *
   *  The draw effect runs on EVERY render, so logging each pass would bury the signal. This emits
   *  only when the state actually CHANGES — a new bail reason, a new mip level, a resize, a lost
   *  or restored context. A clip that silently stops painting therefore leaves exactly one line
   *  saying why, and a healthy clip goes quiet after one line. */
  const lastLogRef = useRef<string>("");
  const logState = (sig: string) => {
    if (lastLogRef.current === sig) return;
    lastLogRef.current = sig;
    console.log(`[WaveformGL${label ? ` ${label}` : ""}] ${sig}`);
  };
  const glRef  = useRef<HTMLCanvasElement>(null);
  const ovRef  = useRef<HTMLCanvasElement>(null);

  // Live device-pixel ratio. A browser/Electron zoom changes this WITHOUT causing a React render,
  // so it is held in state and refreshed from a matchMedia listener — that state change is what
  // re-runs the draw effects below with the correct backing-store size.
  const [dpr, setDpr] = useState(() => (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1));
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    let mql: MediaQueryList | null = null;
    let cancelled = false;
    const attach = () => {
      if (cancelled) return;
      const cur = window.devicePixelRatio || 1;
      setDpr(cur);
      // A dppx media query only fires for the ratio it was created with, so it is re-armed on
      // every change. Without re-arming, the SECOND zoom step would go unnoticed.
      mql = window.matchMedia(`(resolution: ${cur}dppx)`);
      const onChange = () => { mql?.removeEventListener?.("change", onChange); attach(); };
      mql.addEventListener?.("change", onChange);
    };
    attach();
    return () => { cancelled = true; try { mql?.removeEventListener?.("change", () => {}); } catch {} };
  }, []);

  /** Backing-store scale. Caps TOTAL PIXELS rather than the ratio, so a high-DPR display or a
   *  zoomed window still renders at native density — which is what keeps the additive blend from
   *  saturating — while a very wide clip cannot allocate an unbounded texture. */
  const scaleFor = (w: number, h: number) => {
    const MAX_PX = 4096 * 2048;
    const want = dpr;
    const px = w * h * want * want;
    return px <= MAX_PX ? want : Math.max(1, Math.sqrt(MAX_PX / (w * h)));
  };
  const st     = useRef<{
    gl: WebGL2RenderingContext; prog: WebGLProgram;
    tex: WebGLTexture; vao: WebGLVertexArrayObject;
    u: Record<string, WebGLUniformLocation | null>; n: number;
    maxDim: number;
  } | null>(null);

  // Bumped whenever the GL context is lost/restored, purely to force the draw effects to re-run
  // against the rebuilt context.
  const [glEpoch, setGlEpoch] = useState(0);

  // Init GL. Runs on mount AND on every context restore — a WebGL context is not permanent.
  //
  // Each clip owns its own WebGL context, so a session with many clips can exceed the browser's
  // live-context cap (Chrome evicts at roughly 16). Eviction fires `webglcontextlost` and is
  // otherwise SILENT: no exception, no console error, the canvas simply stops painting forever.
  // That is the "dead instance" — it looked white only because every layer behind it is
  // theme-dependent and not reliably dark. Losing the context is now recoverable, and even an
  // unrecovered one paints dark via the canvas's own CSS background.
  useEffect(() => {
    const can = glRef.current;
    if (!can) return;
    if (onMount) onMount(can);
    const onLost = (e: Event) => {
      e.preventDefault();            // preventDefault is REQUIRED or the context never restores
      st.current = null;
      uploadedRef.current = -1;
      console.warn(`[WaveformGL${label ? ` ${label}` : ""}] CONTEXT LOST — this is the silent death; recovery armed`);
      lastLogRef.current = "";
      setGlEpoch(n => n + 1);        // repaint: the CSS dark background carries the clip meanwhile
    };
    const onRestored = () => {
      uploadedRef.current = -1;      // the texture died with the context — force a re-upload
      console.log(`[WaveformGL${label ? ` ${label}` : ""}] CONTEXT RESTORED — rebuilding program/VAO/texture`);
      lastLogRef.current = "";
      setGlEpoch(n => n + 1);        // re-runs this effect, which rebuilds program/VAO/texture
    };
    can.addEventListener("webglcontextlost", onLost as EventListener, false);
    can.addEventListener("webglcontextrestored", onRestored as EventListener, false);

    const gl = can.getContext("webgl2", { antialias: true, alpha: true }) as WebGL2RenderingContext;
    if (!gl || gl.isContextLost?.()) {
      console.warn("[WaveformGL] no WebGL2 context — clip renders dark, not blank");
      return () => {
        can.removeEventListener("webglcontextlost", onLost as EventListener, false);
        can.removeEventListener("webglcontextrestored", onRestored as EventListener, false);
      };
    }
    // Required for R32F texture format
    gl.getExtension("EXT_color_buffer_float");
    gl.getExtension("OES_texture_float_linear");

    const mk = (src: string, type: number) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)!);
      return s;
    };
    try {
      const prog = gl.createProgram()!;
      gl.attachShader(prog, mk(VERT, gl.VERTEX_SHADER));
      gl.attachShader(prog, mk(FRAG, gl.FRAGMENT_SHADER));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog)!);
      const names = ["u_peaks","u_n","u_vs","u_ve","u_ci","u_co","u_ie","u_os","u_tint","u_tintAmt",
                     "u_fadeInEnd","u_fadeOutStart","u_cs","u_ce","u_ps","u_pe"];
      const u: Record<string, WebGLUniformLocation | null> = {};
      names.forEach(n => { u[n] = gl.getUniformLocation(prog, n); });
      const vao = gl.createVertexArray()!;
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      // The driver's own ceiling. A canvas wider than this cannot be rendered: the draw fails
      // SILENTLY — no exception, no console error — and the canvas stays blank. That is what a
      // 160634px-wide clip hit at full zoom. 8192 is a further self-imposed ceiling: no display
      // needs more, and it keeps allocation sane on drivers that report an optimistic maximum.
      const maxTex    = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      const maxRender = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number;
      const maxView   = (gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | null)?.[0] ?? maxTex;
      const maxDim    = Math.max(1024, Math.min(maxTex || 4096, maxRender || 4096, maxView || 4096, 8192));
      st.current = { gl, prog, tex, vao, u, n: 0, maxDim };
      console.log(`[WaveformGL${label ? ` ${label}` : ""}] INIT MAX_TEXTURE_SIZE=${maxTex} `
                + `MAX_RENDERBUFFER_SIZE=${maxRender} MAX_VIEWPORT_DIMS=${maxView} → cap=${maxDim}px`);
      uploadedRef.current = -1;   // a fresh context holds no texture — force the next draw to upload
    } catch(e) { console.error("WebGL init failed:", e); }
    return () => {
      can.removeEventListener("webglcontextlost", onLost as EventListener, false);
      can.removeEventListener("webglcontextrestored", onRestored as EventListener, false);
    };
  }, [glEpoch]);

  /** Max-pooled mip pyramid over the peak data.
   *
   *  Zoomed out, a full song is ~10^5–10^6 peaks squeezed into a few hundred device pixels. Drawing
   *  one quad per peak means thousands of fragments landing on the SAME pixel; each one composites
   *  over the last, so the pixel converges to fully-opaque tint no matter how quiet the audio is —
   *  the lane turns into a solid slab and every transient in it is lost. Level 0 is the raw peaks;
   *  each level above is the pairwise MAX of the one below, so a decimated view still shows the
   *  loudest sample in each column rather than an average that erases the peaks.
   *  The draw picks the coarsest level that still has ~2 texels per device pixel. */
  const mipsRef     = useRef<{ data: Uint8Array; n: number }[]>([]);
  const uploadedRef = useRef<number>(-1);

  useEffect(() => {
    mipsRef.current = [];
    uploadedRef.current = -1;
    if (!peaks || !peaks.length) return;
    const toRgba = (src: Float32Array | Uint8Array, n: number, raw: boolean) => {
      const rgba = new Uint8Array(n * 4);
      for (let i = 0; i < n; i++) {
        const v = raw
          ? Math.floor(Math.min(1, Math.max(0, (src as Float32Array)[i])) * 255)
          : (src as Uint8Array)[i];
        rgba[i*4] = v; rgba[i*4+1] = 0; rgba[i*4+2] = 0; rgba[i*4+3] = 255;
      }
      return rgba;
    };
    // Level 0 — raw peaks.
    const levels: { data: Uint8Array; n: number }[] = [{ data: toRgba(peaks, peaks.length, true), n: peaks.length }];
    // Successive levels — pairwise max, so a peak survives every decimation.
    let cur = new Uint8Array(peaks.length);
    for (let i = 0; i < peaks.length; i++) cur[i] = Math.floor(Math.min(1, Math.max(0, peaks[i])) * 255);
    while (cur.length > 64) {
      const half = Math.ceil(cur.length / 2);
      const next = new Uint8Array(half);
      for (let i = 0; i < half; i++) {
        const a = cur[i*2], b = i*2 + 1 < cur.length ? cur[i*2+1] : 0;
        next[i] = a > b ? a : b;
      }
      levels.push({ data: toRgba(next, half, false), n: half });
      cur = next;
    }
    mipsRef.current = levels;
    const s = st.current;
    if (s) s.n = peaks.length;
  }, [peaks]);

  // Draw GL every render
  useEffect(() => {
    const s = st.current; const can = glRef.current;
    const mips = mipsRef.current;
    // Every one of these bail paths leaves the canvas painting its CSS dark background rather than
    // nothing — that is the invariant: if it cannot paint the waveform, it paints DARK.
    if (!s)            return logState("BAIL no-gl-state (context lost or init failed)");
    if (!can)          return logState("BAIL no-canvas");
    if (!mips.length)  return logState("BAIL no-peaks (mip pyramid empty)");
    if (s.gl.isContextLost?.()) return logState("BAIL context-lost");
    const { gl, prog, tex, vao, u } = s;
    const w = can.clientWidth, h = can.clientHeight;
    if (!w || !h) return logState(`BAIL zero-css-size w=${w} h=${h}`);
    const k = scaleFor(w, h);
    // PER-DIMENSION cap, not just total area. The old area cap let a 160634x62 canvas through
    // (only ~10M pixels) and the driver refused to draw it without saying so.
    const wantW = Math.floor(w * k), wantH = Math.floor(h * k);
    const capW = Math.max(1, Math.min(wantW, s.maxDim));
    const capH = Math.max(1, Math.min(wantH, s.maxDim));
    // Folded into the DRAW line below rather than logged separately — one event, one line.
    const capNote = (capW < wantW || capH < wantH)
      ? ` CAP(requested ${wantW}x${wantH}, granted ${capW}x${capH}, driverMax ${s.maxDim})`
      : "";
    if (can.width !== capW || can.height !== capH) { can.width = capW; can.height = capH; }
    if (!can.width || !can.height) return logState(`BAIL zero-backing-store ${can.width}x${can.height} (css ${w}x${h}, dpr ${dpr})`);

    // ── Level select: the coarsest mip that still carries ~2 texels per device pixel ──
    const span = Math.max(viewEnd - viewStart, 1e-6);
    const targetBars = Math.max(1, Math.min(4096, can.width));
    let level = 0;
    while (level + 1 < mips.length && mips[level].n * span > targetBars * 2) level++;
    if (uploadedRef.current !== level) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, mips[level].n, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, mips[level].data);
      uploadedRef.current = level;
    }
    // One quad per device pixel at most. This is the cap that makes over-accumulation structurally
    // impossible at ANY zoom: fragments can no longer stack thousands-deep on one pixel.
    const barsInView = Math.max(1, Math.round(mips[level].n * span));
    const nDraw = Math.max(1, Math.min(targetBars, barsInView));

    gl.viewport(0, 0, can.width, can.height);
    // OPAQUE DARK, never transparent. A clip that fails to draw its waveform for any reason —
    // lost context, an empty mip, a bail-out below — now paints DARK rather than letting whatever
    // sits behind it show through. The layers behind are theme-dependent and not reliably dark.
    gl.clearColor(0.05, 0.05, 0.05, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(prog); gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(u.u_peaks, 0); gl.uniform1i(u.u_n, nDraw);
    gl.uniform1f(u.u_vs, viewStart); gl.uniform1f(u.u_ve, viewEnd);
    gl.uniform1f(u.u_ci, cueIn);     gl.uniform1f(u.u_co, cueOut);
    gl.uniform1f(u.u_ie, introEnd);  gl.uniform1f(u.u_os, outroStart);
    // Undefined fade bounds collapse to the view edges, which the shader reads as "no fade".
    gl.uniform1f(u.u_cs, clipStart ?? viewStart);
    gl.uniform1f(u.u_ce, clipEnd   ?? viewEnd);
    gl.uniform1f(u.u_ps, pStart);
    gl.uniform1f(u.u_pe, pEnd);
    gl.uniform1f(u.u_fadeInEnd,    fadeInEnd    ?? (clipStart ?? viewStart));
    gl.uniform1f(u.u_fadeOutStart, fadeOutStart ?? (clipEnd   ?? viewEnd));
    const [tr, tg, tb] = hexToRgb(tint);
    gl.uniform3f(u.u_tint, tr, tg, tb);
    gl.uniform1f(u.u_tintAmt, tint ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, nDraw * 6);
    gl.bindVertexArray(null);
    logState(`DRAW ok mip=${level}/${mips.length - 1} texels=${mips[level].n} bars=${nDraw} `
           + `canvas=${can.width}x${can.height} drawingBuffer=${gl.drawingBufferWidth}x${gl.drawingBufferHeight} `
           + `css=${w}x${h} dpr=${dpr.toFixed(2)} `
           + `fullClipPx=${fullClipPx ?? "n/a"} clipDurMs=${clipDurationMs ?? "n/a"} clipStartMs=${clipStartMs ?? "n/a"} `
           + `zoom=${zoom ?? "n/a"} view=[${viewStart.toFixed(4)},${viewEnd.toFixed(4)}] span=${span.toFixed(5)} `
           + `peakSpan=[${pStart.toFixed(4)},${pEnd.toFixed(4)}] barsPerDevicePx=${(nDraw / can.width).toFixed(2)}`
           + capNote);
  });

  // Draw 2D overlay
  useEffect(() => {
    const can = ovRef.current; if (!can) return;
    const ctx = can.getContext("2d"); if (!ctx) return;
    const w = can.clientWidth, h = can.clientHeight;
    if (!w || !h) return;
    const k = scaleFor(w, h);
    if (can.width !== Math.floor(w*k) || can.height !== Math.floor(h*k)) {
      can.width = Math.floor(w*k); can.height = Math.floor(h*k);
    }
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const span = Math.max(viewEnd - viewStart, 0.0001);
    const toX  = (p: number) => ((p - viewStart) / span) * w;

    if (dragRegion) {
      const x0 = toX(dragRegion.start), x1 = toX(dragRegion.end);
      ctx.fillStyle   = dragRegion.type === "intro" ? "rgb(from var(--accent-cyan) r g b / 0.2)" : "rgba(251,146,60,0.2)";
      ctx.fillRect(x0, 0, x1-x0, h);
      ctx.strokeStyle = dragRegion.type === "intro" ? "var(--accent-cyan)" : "#fb923c";
      ctx.lineWidth   = 1.5; ctx.strokeRect(x0, 0, x1-x0, h);
    }

    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, h/2); ctx.lineTo(w, h/2); ctx.stroke();

    // ── Fade geometry ──
    // The taper lives in the waveform itself (vertex shader). These are the read-off marks:
    // the gain line you can follow, and a hairline at the boundary so the fade's length is exact.
    const drawFade = (fromP: number, toP: number, rising: boolean) => {
      const x0 = toX(fromP), x1 = toX(toP);
      if (!isFinite(x0) || !isFinite(x1) || Math.abs(x1 - x0) < 0.5) return;
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x0, rising ? h : 0);
      ctx.lineTo(x1, rising ? 0 : h);
      ctx.stroke();
      // Hairline at the boundary — where the fade ends and full level begins.
      const bx = rising ? x1 : x0;
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(bx, 0); ctx.lineTo(bx, h); ctx.stroke();
    };
    if (fadeInEnd !== undefined && fadeInEnd > viewStart) drawFade(viewStart, fadeInEnd, true);
    if (fadeOutStart !== undefined && fadeOutStart < viewEnd) drawFade(fadeOutStart, viewEnd, false);

    if (hoverPos !== null) {
      const hx = toX(hoverPos);
      ctx.strokeStyle = "rgba(255,255,255,0.4)"; ctx.lineWidth = 1;
      ctx.setLineDash([3,3]);
      ctx.beginPath(); ctx.moveTo(hx,0); ctx.lineTo(hx,h); ctx.stroke();
      ctx.setLineDash([]);
    }

    const phx = toX(playhead);
    if (phx >= -2 && phx <= w+2) {
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.globalAlpha = 0.9;
      ctx.beginPath(); ctx.moveTo(phx,0); ctx.lineTo(phx,h); ctx.stroke();
      ctx.globalAlpha = 1; ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.moveTo(phx-6,0); ctx.lineTo(phx+6,0); ctx.lineTo(phx,10); ctx.fill();
    }
  });

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {/* The dark background is on the ELEMENT, so a canvas with no context — or one whose context
          was evicted — still paints dark instead of showing the layers behind it. */}
      <canvas ref={glRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", background: SURFACE_DARK }} />
      <canvas ref={ovRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} />
    </div>
  );
}
