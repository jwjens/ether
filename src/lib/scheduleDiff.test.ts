import { describe, it, expect } from "vitest";
import { diffSchedule, type ExistingRow, type DraftLine } from "./scheduleDiff";

const row = (uuid: string, ann: string, t: string | null): ExistingRow =>
  ({ uuid, announcement_uuid: ann, trigger_time: t });
const line = (ann: string, t: string): DraftLine => ({ announcement_uuid: ann, trigger_time: t });

describe("diffSchedule — what APPLY does to one date", () => {
  it("an unchanged line KEEPS its row, so last_played_at survives", () => {
    // The whole reason this function exists: recreating this row would reset the 120s double-fire
    // guard and let the announcement re-fire inside its own window.
    const d = diffSchedule([row("r1", "a", "10:00:00")], [line("a", "10:00:00")]);
    expect(d.keep.map(r => r.uuid)).toEqual(["r1"]);
    expect(d.remove).toEqual([]);
    expect(d.create).toEqual([]);
  });

  it("changing a time removes the old row and creates the new line", () => {
    const d = diffSchedule([row("r1", "a", "10:00:00")], [line("a", "10:15:00")]);
    expect(d.keep).toEqual([]);
    expect(d.remove.map(r => r.uuid)).toEqual(["r1"]);
    expect(d.create).toEqual([line("a", "10:15:00")]);
  });

  it("changing which announcement plays removes and creates", () => {
    const d = diffSchedule([row("r1", "a", "10:00:00")], [line("b", "10:00:00")]);
    expect(d.remove.map(r => r.uuid)).toEqual(["r1"]);
    expect(d.create).toEqual([line("b", "10:00:00")]);
  });

  it("adding a line leaves the existing rows alone", () => {
    const d = diffSchedule(
      [row("r1", "a", "10:00:00")],
      [line("a", "10:00:00"), line("b", "11:00:00")],
    );
    expect(d.keep.map(r => r.uuid)).toEqual(["r1"]);
    expect(d.remove).toEqual([]);
    expect(d.create).toEqual([line("b", "11:00:00")]);
  });

  it("removing a line deletes only that row", () => {
    const d = diffSchedule(
      [row("r1", "a", "10:00:00"), row("r2", "b", "11:00:00")],
      [line("a", "10:00:00")],
    );
    expect(d.keep.map(r => r.uuid)).toEqual(["r1"]);
    expect(d.remove.map(r => r.uuid)).toEqual(["r2"]);
    expect(d.create).toEqual([]);
  });

  it("an empty editor removes everything and creates nothing", () => {
    const d = diffSchedule([row("r1", "a", "10:00:00"), row("r2", "b", "11:00:00")], []);
    expect(d.keep).toEqual([]);
    expect(d.remove.map(r => r.uuid)).toEqual(["r1", "r2"]);
    expect(d.create).toEqual([]);
  });

  it("applying to a date that had nothing creates everything", () => {
    const d = diffSchedule([], [line("a", "10:00:00"), line("b", "11:00:00")]);
    expect(d.remove).toEqual([]);
    expect(d.create).toHaveLength(2);
  });

  it("the SAME announcement twice at the SAME time is kept twice, not collapsed", () => {
    // Multiset, not set. A double-play is a thing an operator can legitimately ask for, and set
    // semantics would keep one row and delete the other behind their back.
    const d = diffSchedule(
      [row("r1", "a", "10:00:00"), row("r2", "a", "10:00:00")],
      [line("a", "10:00:00"), line("a", "10:00:00")],
    );
    expect(d.keep.map(r => r.uuid).sort()).toEqual(["r1", "r2"]);
    expect(d.remove).toEqual([]);
    expect(d.create).toEqual([]);
  });

  it("two rows, one draft line — one is kept and the duplicate is removed", () => {
    const d = diffSchedule(
      [row("r1", "a", "10:00:00"), row("r2", "a", "10:00:00")],
      [line("a", "10:00:00")],
    );
    expect(d.keep).toHaveLength(1);
    expect(d.remove).toHaveLength(1);
    expect(d.create).toEqual([]);
  });

  it("a null stored time matches an empty draft time rather than churning", () => {
    const d = diffSchedule([row("r1", "a", null)], [line("a", "")]);
    expect(d.keep.map(r => r.uuid)).toEqual(["r1"]);
    expect(d.remove).toEqual([]);
  });

  it("reordering the editor changes nothing — order is not identity", () => {
    const existing = [row("r1", "a", "10:00:00"), row("r2", "b", "11:00:00")];
    const d = diffSchedule(existing, [line("b", "11:00:00"), line("a", "10:00:00")]);
    expect(d.keep.map(r => r.uuid).sort()).toEqual(["r1", "r2"]);
    expect(d.remove).toEqual([]);
    expect(d.create).toEqual([]);
  });

  it("does not mutate the arrays it was given", () => {
    const existing = [row("r1", "a", "10:00:00")];
    const draft = [line("a", "10:15:00")];
    diffSchedule(existing, draft);
    expect(existing).toHaveLength(1);
    expect(draft).toHaveLength(1);
  });
});
