import { describe, expect, it } from "vitest";
import { clipTimedEventToDay, timedEventSegmentsForDay } from "./calendar-day-segments";

function event(id: string, startAt: Date, endAt: Date) {
  return { id, startAt, endAt };
}

describe("calendar day segments", () => {
  it("clips an event that continues into the next day", () => {
    const source = event("a", new Date(2026, 4, 1, 22, 15), new Date(2026, 4, 2, 1, 45));

    const firstDay = clipTimedEventToDay(source, new Date(2026, 4, 1));
    const secondDay = clipTimedEventToDay(source, new Date(2026, 4, 2));

    expect(firstDay?.startAt.getHours()).toBe(22);
    expect(firstDay?.startAt.getMinutes()).toBe(15);
    expect(firstDay?.endAt.getHours()).toBe(0);
    expect(firstDay?.endAt.getDate()).toBe(2);
    expect(firstDay?.startsBeforeDay).toBe(false);
    expect(firstDay?.endsAfterDay).toBe(true);

    expect(secondDay?.startAt.getHours()).toBe(0);
    expect(secondDay?.endAt.getHours()).toBe(1);
    expect(secondDay?.endAt.getMinutes()).toBe(45);
    expect(secondDay?.startsBeforeDay).toBe(true);
    expect(secondDay?.endsAfterDay).toBe(false);
  });

  it("does not render a zero-length next-day segment for events ending at midnight", () => {
    const source = event("a", new Date(2026, 4, 1, 22, 0), new Date(2026, 4, 2, 0, 0));

    expect(clipTimedEventToDay(source, new Date(2026, 4, 1))).not.toBeNull();
    expect(clipTimedEventToDay(source, new Date(2026, 4, 2))).toBeNull();
  });

  it("returns only events intersecting the requested day", () => {
    const visible = event("visible", new Date(2026, 4, 1, 23, 0), new Date(2026, 4, 2, 1, 0));
    const outside = event("outside", new Date(2026, 4, 3, 9, 0), new Date(2026, 4, 3, 10, 0));

    expect(timedEventSegmentsForDay([visible, outside], new Date(2026, 4, 2)).map((segment) => segment.event.id)).toEqual(["visible"]);
  });
});
