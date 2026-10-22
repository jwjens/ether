// The shift screen starts as the person who signed in (Jeff, 2026-10-21, 4.6.62: "Admin login shows 'Good afternoon
// Shawna'"). It used to take the lowest user id. docs/admin-greets-shawna-2026-10-21.md.
import { describe, it, expect } from "vitest";
import { pickOnShift } from "./OnShiftScreen";

// OV after users sync merged the two Admins: OV's own Admin (id 1) removed, the kept Admin arrived under a new id.
const OV = [{ id: 2, name: "ryan" }, { id: 3, name: "shawna" }, { id: 9, name: "Admin" }];

describe("pickOnShift", () => {
  it("Admin signed in → Admin on shift, not the lowest id (the reported bug)", () => {
    expect(pickOnShift(OV, 9, "Admin")?.name).toBe("Admin");
  });
  it("the signed-in row was merged away → the same name is the same person", () => {
    expect(pickOnShift(OV, 1, "admin")?.name).toBe("Admin");
  });
  it("Shawna signed in → Shawna", () => {
    expect(pickOnShift(OV, 3, "shawna")?.name).toBe("shawna");
  });
  it("nobody to go by → the first listed, so Start is never blocked", () => {
    expect(pickOnShift(OV)?.name).toBe("ryan");
    expect(pickOnShift(OV, 99, "nobody")?.name).toBe("ryan");
  });
  it("no users → none", () => {
    expect(pickOnShift([], 1, "Admin")).toBeNull();
  });
});
