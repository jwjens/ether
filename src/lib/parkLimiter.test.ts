// The Park mic limiter button's rack and its read-back (2026-10-16).
import { describe, it, expect } from "vitest";
import { limiterRack, limiterCheck } from "./parkLimiter";

const L = { ceilingDb: -6, attackMs: 1, releaseMs: 100 };

describe("the limiter rack", () => {
  it("an empty rack gets one compressor, IN, at 20:1 with the set numbers", () => {
    const d = limiterRack({ v: 1, sections: { ch: [] } } as any, L);
    expect(d.sections.ch).toEqual([{ id: "park-limiter", in: true, module: { type: "comp", threshold: -6, ratio: 20, attack: 1, release: 100, makeup: 0, knee: 0 } }]);
    expect(limiterCheck(d, L)).toBeNull();
  });
  it("a rack with a compressor gets that one set and switched IN; the other modules are untouched", () => {
    const cur: any = { v: 1, sections: { ch: [
      { id: "c-filters", in: true, module: { type: "filters", hpf: { in: true, freq: 80 }, lpf: { in: false, freq: 18000 } } },
      { id: "c-comp", in: false, module: { type: "comp", threshold: -20, ratio: 3, attack: 10, release: 150, makeup: 0, knee: 6 } }] } };
    const d = limiterRack(cur, L);
    expect(d.sections.ch[0]).toEqual(cur.sections.ch[0]);
    expect(d.sections.ch[1]).toMatchObject({ id: "c-comp", in: true, module: { threshold: -6, ratio: 20, knee: 0 } });
    expect(cur.sections.ch[1].in).toBe(false);   // the input is not changed in place
  });
  it("the read-back names what is wrong", () => {
    expect(limiterCheck({ v: 1, sections: { ch: [] } } as any, L)).toBe("no compressor");
    expect(limiterCheck(null, L)).toBe("no compressor");
    const off: any = limiterRack(null, L); off.sections.ch[0].in = false;
    expect(limiterCheck(off, L)).toBe("a compressor that is OUT");
    const other: any = limiterRack(null, L); other.sections.ch[0].module.ratio = 3;
    expect(limiterCheck(other, L)).toMatch(/ratio 3/);
  });
});
