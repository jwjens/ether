// Park Listen settings (2026-10-16): 0 is a saved value; only a missing/blank row is "not set"; four settings, not five.
import { describe, it, expect } from "vitest";
import { LISTEN_KEYS, storedValue, storedNumber, listenReady, saveRefusal } from "./parkListenSettings";

const row = (key: string, value: any, deleted_at: string | null = null) => ({ key, value, deleted_at });
const all = (buffer: any) => [row("park_listen_bitrate_kbps", "24"), row("park_listen_channels", "mono"),
                              row("park_listen_frame_ms", "20"), row("park_listen_buffer_ms", buffer)];

describe("Listen buffer 0", () => {
  it("a saved 0 (text or number) is 0, never 'not set'", () => {
    expect(storedValue(all("0"), "park_listen_buffer_ms")).toBe("0");
    expect(storedValue(all(0), "park_listen_buffer_ms")).toBe("0");
    expect(storedNumber(all("0"), "park_listen_buffer_ms")).toBe(0);
    expect(storedNumber(all(0), "park_listen_buffer_ms")).toBe(0);
    expect(listenReady(all("0"))).toBe(true);
    expect(listenReady(all(0))).toBe(true);
  });
  it("a missing, blank or deleted buffer is not set (null, not 0)", () => {
    const missing = all("0").slice(0, 3);
    expect(storedNumber(missing, "park_listen_buffer_ms")).toBeNull();
    expect(listenReady(missing)).toBe(false);
    expect(storedNumber(all(""), "park_listen_buffer_ms")).toBeNull();     // Number("") would have said 0
    expect(listenReady(all(""))).toBe(false);
    const deleted = [...all("0").slice(0, 3), row("park_listen_buffer_ms", "0", "2026-10-16T00:00:00Z")];
    expect(listenReady(deleted)).toBe(false);
  });
});

describe("what Listen needs", () => {
  it("four settings; the old MONITOR/AUX choice is not one of them", () => {
    expect(LISTEN_KEYS).toEqual(["park_listen_bitrate_kbps", "park_listen_channels", "park_listen_frame_ms", "park_listen_buffer_ms"]);
    expect(listenReady(all("100"))).toBe(true);   // no park_listen_output row, still ready
  });
  it("a refused save is read as refused (the IPC answers {ok:false}, it does not throw)", () => {
    expect(saveRefusal({ ok: false, error: "station_id required" })).toBe("station_id required");
    expect(saveRefusal({ ok: true, row: {} })).toBeNull();
    expect(saveRefusal(undefined)).toBeNull();
  });
});
