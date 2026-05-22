import { describe, expect, it } from "vitest";
import { formatRunDurationLabel, formatRunTimingTitle } from "./run-duration-label";

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
    expect(formatRunTimingTitle({
      status: "completed",
      startedAt: "2026-05-14T09:20:00.000Z",
      finishedAt: "2026-05-14T09:35:00.000Z",
      createdAt: "2026-05-14T09:19:00.000Z",
    })).toContain("Started");
  });
});
