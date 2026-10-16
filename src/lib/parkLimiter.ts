// PARK MIC LIMITER (2026-10-16) — the rack the "Put the limiter on fader …" button sends, and the check of what the
// fader's rack holds afterwards. Pure, tested (parkLimiter.test.ts).
//
// Jeff: "Limiter via the fader's compressor is fine." The limiter IS the fader's channel compressor: threshold = the
// ceiling, the compressor's maximum ratio (20:1), no knee, no makeup, IN. A rack that already has a compressor gets that
// one set (a channel rack holds one of each module); otherwise one is added. Nothing else in the rack changes.
import type { ChannelRackDoc } from "../components/rack/rackTypes";

export type LimiterNumbers = { ceilingDb: number | null; attackMs: number | null; releaseMs: number | null };

export function limiterComp(L: LimiterNumbers) {
  return { type: "comp" as const, threshold: Number(L.ceilingDb), ratio: 20, attack: Number(L.attackMs), release: Number(L.releaseMs), makeup: 0, knee: 0 };
}

/** The fader's rack with the limiter in it. `cur` = what rack:get returned (may be empty). */
export function limiterRack(cur: ChannelRackDoc | null | undefined, L: LimiterNumbers): ChannelRackDoc {
  const doc: ChannelRackDoc = cur && cur.sections && Array.isArray(cur.sections.ch)
    ? JSON.parse(JSON.stringify(cur)) : { v: 1, sections: { ch: [] } };
  const comp = limiterComp(L);
  const i = doc.sections.ch.findIndex((x: any) => x?.module?.type === "comp");
  if (i >= 0) doc.sections.ch[i] = { ...doc.sections.ch[i], in: true, module: comp } as any;
  else doc.sections.ch.push({ id: "park-limiter", in: true, module: comp } as any);
  return doc;
}

/** null = the rack holds the limiter as set; otherwise what it holds instead, in words. */
export function limiterCheck(doc: ChannelRackDoc | null | undefined, L: LimiterNumbers): string | null {
  const slot = doc?.sections?.ch?.find((x: any) => x?.module?.type === "comp") as any;
  if (!slot) return "no compressor";
  if (slot.in === false) return "a compressor that is OUT";
  const want = limiterComp(L), m = slot.module;
  const diff = (["threshold", "ratio", "attack", "release", "knee", "makeup"] as const).filter(k => Math.abs(Number(m[k]) - Number(want[k])) > 1e-6);
  return diff.length ? `a compressor with different numbers (${diff.map(k => `${k} ${m[k]}`).join(", ")})` : null;
}
