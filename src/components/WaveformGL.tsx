// src/components/WaveformGL.tsx
//
// GPU-accelerated waveform using WebGL2.
// Falls back gracefully if WebGL2 unavailable.

import { useEffect, useRef } from "react";

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
}

// Glow padding — each bar extends slightly beyond the actual amplitude so the
// fragment shader can draw a neon falloff around the waveform edge.  The extra
// geometry is cheap (same draw call, same vertex count) and keeps the per-peak
// bar structure 100% intact.
const GLOW_PAD = 0.07;

const VERT = `#version 300 es
precision highp float;
uniform sampler2D u_peaks;
uniform int  u_n;
uniform float u_vs, u_ve;
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
  float peak = texture(u_peaks, vec2(t, 0.5)).r;
  float amp  = peak * 0.92;
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
out vec4 color;
void main() {
  float t = v_t;

  // Zone colors — same as before, track colors are sacred
  vec3 c;
  if (t < u_ci || t > u_co)   c = vec3(0.4, 0.45, 0.5);   // outside cue — gray
  else if (t < u_ie)           c = vec3(0.13, 0.83, 0.93);  // intro — cyan
  else if (t > u_os)           c = vec3(0.98, 0.57, 0.24);  // outro — orange
  else                         c = vec3(0.98, 0.75, 0.14);  // body — gold

  // Distance from the waveform edge (negative = inside, positive = glow zone)
  float dist = abs(v_y) - v_amp;

  if (dist > 0.0) {
    // ── Glow zone — neon falloff outside the waveform ──
    float glow = exp(-dist * 28.0);       // exponential decay
    float a = glow * 0.35 * v_amp;        // brighter glow on louder peaks
    color = vec4(c * a, a);
  } else {
    // ── Inside the waveform — solid bars + bright edge ──
    float edgeDist = -dist;               // distance INTO the waveform (from edge)
    float edgeGlow = exp(-edgeDist * 18.0) * 0.25;  // subtle inner brightness at edges
    float base = 0.7 + v_amp * 0.3;
    float a = base + edgeGlow;
    color = vec4(c * a, min(a, 1.0));
  }
}`;

export default function WaveformGL({
  peaks, viewStart, viewEnd,
  cueIn, cueOut, introEnd, outroStart,
  playhead, hoverPos, dragRegion, onMount,
}: Props) {
  const glRef  = useRef<HTMLCanvasElement>(null);
  const ovRef  = useRef<HTMLCanvasElement>(null);
  const st     = useRef<{
    gl: WebGL2RenderingContext; prog: WebGLProgram;
    tex: WebGLTexture; vao: WebGLVertexArrayObject;
    u: Record<string, WebGLUniformLocation | null>; n: number;
  } | null>(null);

  // Init GL once
  useEffect(() => {
    const can = glRef.current;
    if (!can) return;
    if (onMount) onMount(can);
    const gl = can.getContext("webgl2", { antialias: true, alpha: true }) as WebGL2RenderingContext;
    if (!gl) { console.warn("WebGL2 not available"); return; }
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
      const names = ["u_peaks","u_n","u_vs","u_ve","u_ci","u_co","u_ie","u_os"];
      const u: Record<string, WebGLUniformLocation | null> = {};
      names.forEach(n => { u[n] = gl.getUniformLocation(prog, n); });
      const vao = gl.createVertexArray()!;
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      st.current = { gl, prog, tex, vao, u, n: 0 };
    } catch(e) { console.error("WebGL init failed:", e); }
  }, []);

  // Upload peaks
  useEffect(() => {
    const s = st.current;
    if (!s || !peaks || !peaks.length) return;
    const { gl, tex } = s;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // Convert to RGBA bytes (0-255) for maximum compatibility
    const rgba = new Uint8Array(peaks.length * 4);
    for (let i = 0; i < peaks.length; i++) {
      const v = Math.floor(Math.min(1, Math.max(0, peaks[i])) * 255);
      rgba[i*4] = v; rgba[i*4+1] = 0; rgba[i*4+2] = 0; rgba[i*4+3] = 255;
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, peaks.length, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    s.n = peaks.length;
  }, [peaks]);

  // Draw GL every render
  useEffect(() => {
    const s = st.current; const can = glRef.current;
    if (!s || !can || s.n === 0) return;
    const { gl, prog, tex, vao, u } = s;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = can.clientWidth, h = can.clientHeight;
    if (!w || !h) return;
    if (can.width !== Math.floor(w*dpr) || can.height !== Math.floor(h*dpr)) {
      can.width = Math.floor(w*dpr); can.height = Math.floor(h*dpr);
    }
    gl.viewport(0, 0, can.width, can.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.useProgram(prog); gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(u.u_peaks, 0); gl.uniform1i(u.u_n, s.n);
    gl.uniform1f(u.u_vs, viewStart); gl.uniform1f(u.u_ve, viewEnd);
    gl.uniform1f(u.u_ci, cueIn);     gl.uniform1f(u.u_co, cueOut);
    gl.uniform1f(u.u_ie, introEnd);  gl.uniform1f(u.u_os, outroStart);
    gl.drawArrays(gl.TRIANGLES, 0, s.n * 6);
    gl.bindVertexArray(null);
  });

  // Draw 2D overlay
  useEffect(() => {
    const can = ovRef.current; if (!can) return;
    const ctx = can.getContext("2d"); if (!ctx) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = can.clientWidth, h = can.clientHeight;
    if (!w || !h) return;
    if (can.width !== Math.floor(w*dpr) || can.height !== Math.floor(h*dpr)) {
      can.width = Math.floor(w*dpr); can.height = Math.floor(h*dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
      <canvas ref={glRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
      <canvas ref={ovRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} />
    </div>
  );
}
