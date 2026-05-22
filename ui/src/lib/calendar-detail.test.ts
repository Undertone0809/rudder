import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "@rudderhq/shared";
import {
  calendarEventRunHref,
  calendarEventSourceLabel,
  formatCalendarDetailDateTime,
  formatCalendarDetailTimeRange,
} from "./calendar-detail";

describe("calendar-detail", () => {
  it("formats date-time values with fixed seconds", () => {
    expect(formatCalendarDetailDateTime(new Date(2026, 4, 11, 11, 34))).toBe("2026-05-11 11:34:00");
  });

  it("formats same-day ranges with one full date", () => {
    const start = new Date(2026, 4, 11, 11, 34);
    const end = new Date(2026, 4, 11, 11, 46);

    expect(formatCalendarDetailTimeRange(start, end)).toBe("2026-05-11 11:34:00 - 11:46:00");
  });

  it("formats cross-day ranges with two full date-times", () => {
    const start = new Date(2026, 4, 11, 23, 55);
    const end = new Date(2026, 4, 12, 0, 5);

    expect(formatCalendarDetailTimeRange(start, end)).toBe("2026-05-11 23:55:00 - 2026-05-12 00:05:00");
  });

  it("labels derived run events and builds run links", () => {
    const event = {
      eventStatus: "actual",
      sourceMode: "derived",
      heartbeatRunId: "run-1",
      agent: { id: "agent-1", name: "Wesley", role: "engineer", title: null, urlKey: "wesley" },
    } as CalendarEvent;

    expect(calendarEventSourceLabel(event)).toBe("run history");
    expect(calendarEventRunHref(event)).toBe("/agents/wesley/runs/run-1");
  });
});
