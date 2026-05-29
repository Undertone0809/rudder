import { describe, expect, it } from "vitest";
import { formatRunDurationLabel, formatRunOccurrenceLabel, formatRunTimingTitle } from "./run-duration-label";

describe("run duration labels", () => {
  it("prioritizes elapsed duration for active runs", () => {
    expect(formatRunDurationLabel({
      status: "running",
      startedAt: "2026-05-14T10:00:00.000Z",
      finishedAt: null,
      createdAt: "2026-05-14T09:59:00.000Z",
    }, Date.parse("2026-05-14T10:25:30.000Z"))).toBe("Live for 25m 30s");
  });

  it("uses the finished duration instead of a relative start-to-end range", () => {
    expect(formatRunDurationLabel({
      status: "completed",
      startedAt: "2026-05-14T09:20:00.000Z",
      finishedAt: "2026-05-14T09:35:00.000Z",
      createdAt: "2026-05-14T09:19:00.000Z",
    }, Date.parse("2026-05-14T10:00:00.000Z"))).toBe("Ran for 15m");
  });

  it("keeps absolute timing available for hover context", () => {
    const title = formatRunTimingTitle({
      status: "completed",
      startedAt: "2026-05-14T09:20:00.000Z",
      finishedAt: "2026-05-14T09:35:00.000Z",
      createdAt: "2026-05-14T09:19:00.000Z",
    });

    expect(title).toContain("Started");
    expect(title).toContain("Finished");
    expect(title).toContain("Created");
  });

  it("labels same-day run occurrence by local clock time", () => {
    expect(formatRunOccurrenceLabel({
      status: "succeeded",
      startedAt: new Date(2026, 4, 14, 9, 20),
      finishedAt: new Date(2026, 4, 14, 9, 35),
      createdAt: new Date(2026, 4, 14, 9, 19),
    }, new Date(2026, 4, 14, 10, 0).getTime())).toBe("09:20");
  });

  it("labels yesterday by calendar day instead of elapsed age", () => {
    expect(formatRunOccurrenceLabel({
      status: "succeeded",
      startedAt: new Date(2026, 4, 13, 23, 50),
      finishedAt: new Date(2026, 4, 13, 23, 55),
      createdAt: new Date(2026, 4, 13, 23, 49),
    }, new Date(2026, 4, 14, 0, 10).getTime())).toBe("Yesterday 23:50");
  });

  it("labels older runs with date and time", () => {
    expect(formatRunOccurrenceLabel({
      status: "succeeded",
      startedAt: new Date(2026, 4, 10, 8, 5),
      finishedAt: new Date(2026, 4, 10, 8, 10),
      createdAt: new Date(2026, 4, 10, 8, 4),
    }, new Date(2026, 4, 14, 10, 0).getTime())).toBe("May 10 08:05");
  });

  it("includes the year for prior-year runs", () => {
    expect(formatRunOccurrenceLabel({
      status: "succeeded",
      startedAt: new Date(2025, 4, 10, 8, 5),
      finishedAt: new Date(2025, 4, 10, 8, 10),
      createdAt: new Date(2025, 4, 10, 8, 4),
    }, new Date(2026, 4, 14, 10, 0).getTime())).toBe("May 10, 2025 08:05");
  });

  it("falls back to created time before a queued run starts", () => {
    expect(formatRunOccurrenceLabel({
      status: "queued",
      startedAt: null,
      finishedAt: null,
      createdAt: new Date(2026, 4, 14, 9, 19),
    }, new Date(2026, 4, 14, 10, 0).getTime())).toBe("09:19");
  });
});
