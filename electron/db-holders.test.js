// Every connection Ether holds to the station database is closed before a swap and reopened after it (electron/db-holders.js).
// Jeff, 2026-10-21 (4.6.62, work PC): joining HalloVeen by sync failed with "openair.db-wal and openair.db-shm could not be
// released ... something outside Ether is holding those files" — and it was Ether itself. Real files: scripts/smoke-db-release.js.
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const { createDbHolders, stuckFilesMessage } = require_("./db-holders.js");

/** A worker stand-in: exits when told, or never (busy) until terminated. */
function fakeWorker() {
  const w = new EventEmitter();
  w.terminated = false;
  w.terminate = vi.fn(async () => { w.terminated = true; w.emit("exit", 1); return 1; });
  w.finish = () => w.emit("exit", 0);
  return w;
}

describe("db holders — release before a swap, reopen after", () => {
  it("closes every persistent holder and lets each reopen afterwards", async () => {
    const h = createDbHolders();
    const a = { release: vi.fn(async () => {}), reacquire: vi.fn() };
    const b = { release: vi.fn(() => undefined), reacquire: vi.fn() };
    h.register("show-log worker", a);
    h.register("library-health worker", b);
    const out = await h.releaseAll();
    expect(a.release).toHaveBeenCalledOnce();
    expect(b.release).toHaveBeenCalledOnce();
    expect(out.map(r => [r.name, r.ok])).toEqual([["show-log worker", true], ["library-health worker", true]]);
    expect(h.isReleased()).toBe(true);
    h.reacquireAll();
    expect(a.reacquire).toHaveBeenCalledOnce();
    expect(b.reacquire).toHaveBeenCalledOnce();
    expect(h.isReleased()).toBe(false);
  });

  it("names a holder that does not let go instead of hanging", async () => {
    const h = createDbHolders();
    h.register("stuck worker", { release: () => new Promise(() => {}), reacquire: () => {} });
    const out = await h.releaseAll({ waitMs: 50 });
    expect(out).toEqual([{ name: "stuck worker", ok: false, error: expect.stringMatching(/no answer within 50 ms/) }]);
  });

  it("waits for a running worker to finish, and stops one that does not", async () => {
    const h = createDbHolders();
    const quick = h.track("local backup", fakeWorker());
    const busy = h.track("sync cleanup", fakeWorker());
    setTimeout(() => quick.finish(), 10);
    const out = await h.releaseAll({ waitMs: 100 });
    expect(out).toEqual([{ name: "local backup", ok: true, how: "finished" }, { name: "sync cleanup", ok: true, how: "stopped" }]);
    expect(quick.terminate).not.toHaveBeenCalled();
    expect(busy.terminated).toBe(true);
    expect(h.names()).toEqual([]);
  });

  it("stops a worker started while the database is being replaced, and lets the next one run after", async () => {
    const h = createDbHolders();
    await h.releaseAll();
    const during = h.track("cloud backup", fakeWorker());
    expect(during.terminated).toBe(true);
    h.reacquireAll();
    const after = h.track("cloud backup", fakeWorker());
    expect(after.terminated).toBe(false);
    expect(h.names()).toEqual(["cloud backup"]);
  });
});

describe("the stuck-files message says who holds them", () => {
  const stuck = ["openair.db-wal", "openair.db-shm"];
  const ok = [{ name: "show-log worker", ok: true, how: "closed" }];
  const isEther = (x) => /^(ether|ether-engine)$/i.test(x.process);

  it("Ether holding them is reported as Ether — never as outside software (Jeff's 4.6.62 report)", () => {
    const m = stuckFilesMessage(stuck, ok, [{ pid: 4242, process: "Ether", app: "Ether" }], isEther);
    expect(m).toMatch(/Ether itself is still holding openair\.db-wal and openair\.db-shm/);
    expect(m).not.toMatch(/outside Ether|antivirus|backup software/i);
    expect(m).toMatch(/untouched and still running/);
  });

  it("an Ether part that did not release is named", () => {
    const m = stuckFilesMessage(stuck, [{ name: "library-health worker", ok: false, error: "no answer" }], [], isEther);
    expect(m).toMatch(/Ether itself is still holding/);
    expect(m).toMatch(/library-health worker did not close its connection/);
  });

  it("another program is named only when Windows names it", () => {
    const m = stuckFilesMessage(stuck, ok, [{ pid: 77, process: "mcshield", app: "McAfee" }], isEther);
    expect(m).toMatch(/in use by McAfee \(mcshield\.exe, process 77\)/);
    expect(m).not.toMatch(/Ether itself/);
  });

  it("nothing reported: no blame either way", () => {
    const m = stuckFilesMessage(stuck, ok, [], isEther);
    expect(m).toMatch(/Windows did not say which program/);
    expect(m).not.toMatch(/outside Ether|antivirus/i);
  });
});
