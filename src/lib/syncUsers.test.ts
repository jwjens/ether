import { describe, it, expect, vi } from "vitest";
vi.mock("../db/client", () => ({ query: vi.fn() }));
vi.mock("./etherBackend", () => ({ ETHER_BACKEND_URL: "http://backend" }));
import { buildUsersPush, type LocalUserRow } from "./syncUsers";

const row = (name: string, pin_hash: string | null = "salt:h", deleted_at: string | null = null, role = "jock"): LocalUserRow =>
  ({ name, role, pin_hash, deleted_at });

describe("buildUsersPush — explicit removals, never removal by absence", () => {
  it("sends live users with a PIN", () => {
    const p = buildUsersPush([row("Admin", "s:a", null, "admin"), row("jeff")]);
    expect(p.users).toEqual([{ name: "Admin", role: "admin", pin_hash: "s:a" }, { name: "jeff", role: "jock", pin_hash: "salt:h" }]);
    expect(p.removed).toEqual([]);
  });

  it("a user deleted here is an explicit removal", () => {
    expect(buildUsersPush([row("Admin"), row("Steve", "s:x", "2026-10-27T00:00:00Z")]).removed).toEqual(["Steve"]);
  });

  it("a user whose PIN was cleared is an explicit removal (they can't sign in remotely)", () => {
    const p = buildUsersPush([row("Admin"), row("ryan", null)]);
    expect(p.users.map((u) => u.name)).toEqual(["Admin"]);
    expect(p.removed).toEqual(["ryan"]);
  });

  it("a merged duplicate (old copy deleted, same name live) is never removed", () => {
    const p = buildUsersPush([row("jeff", "s:new"), row("JEFF ", "s:old", "2026-10-20T00:00:00Z")]);
    expect(p.users.map((u) => u.name)).toEqual(["jeff"]);
    expect(p.removed).toEqual([]);
  });

  it("each removed name is sent once", () => {
    const p = buildUsersPush([row("Steve", "a", "2026-09-01T00:00:00Z"), row("steve", "b", "2026-10-01T00:00:00Z")]);
    expect(p.removed).toEqual(["Steve"]);
  });
});
