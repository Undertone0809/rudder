import { describe, expect, it } from "vitest";
import { layoutTimedEvents } from "./calendar-event-layout";

function event(id: string, start: string, end: string) {
  return {
    id,
    startAt: `2026-05-01T${start}:00.000Z`,
    endAt: `2026-05-01T${end}:00.000Z`,
  };
}

describe("layoutTimedEvents", () => {
  it("uses full width for non-overlapping events", () => {
    const layout = layoutTimedEvents([
      event("a", "09:00", "10:00"),
      event("b", "10:00", "11:00"),
    ]);

    expect(layout.map((item) => item.columns)).toEqual([1, 1]);
    expect(layout.map((item) => item.leftPct)).toEqual([0, 0]);
    expect(layout.map((item) => item.widthPct)).toEqual([100, 100]);
  });

  it("splits overlapping events into columns", () => {
    const layout = layoutTimedEvents([
      event("a", "09:00", "10:00"),
      event("b", "09:30", "10:30"),
    ]);

    expect(layout.map((item) => item.columns)).toEqual([2, 2]);
    expect(layout[0]!.leftPct).toBeLessThan(layout[1]!.leftPct);
    expect(layout[0]!.leftPct + layout[0]!.widthPct).toBeLessThanOrEqual(layout[1]!.leftPct);
  });

  it("handles nested and partially overlapping events without horizontal collisions", () => {
    const layout = layoutTimedEvents([
      event("a", "09:00", "12:00"),
      event("b", "09:30", "10:30"),
      event("c", "10:30", "11:30"),
      event("d", "11:30", "12:30"),
    ]);

    const byId = new Map(layout.map((item) => [item.event.id, item]));
    expect(byId.get("a")?.columns).toBe(2);
    expect(byId.get("b")?.column).toBe(1);
    expect(byId.get("c")?.column).toBe(1);
    expect(byId.get("d")?.column).toBe(1);
  });

  it("is stable for same-start events", () => {
    const layout = layoutTimedEvents([
      event("c", "09:00", "10:00"),
      event("a", "09:00", "10:00"),
      event("b", "09:00", "10:00"),
    ]);

    const byId = new Map(layout.map((item) => [item.event.id, item.column]));
    expect(byId.get("a")).toBe(0);
    expect(byId.get("b")).toBe(1);
    expect(byId.get("c")).toBe(2);
  });
});
