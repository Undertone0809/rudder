import { describe, expect, it } from "vitest";
import {
  floorDateToMinuteIso,
  resolvePresetDateRange,
} from "./date-range-cache";

describe("date range cache helpers", () => {
  it("floors timestamps to the current minute for stable sliding-window keys", () => {
    expect(floorDateToMinuteIso(new Date("2026-06-19T01:51:37.432Z"))).toBe("2026-06-19T01:51:00.000Z");
  });

  it("keeps relative dashboard ranges stable when called again within the same minute", () => {
    const first = resolvePresetDateRange({
      preset: "7d",
      now: new Date("2026-06-19T01:51:03.100Z"),
    });
    const second = resolvePresetDateRange({
      preset: "7d",
      now: new Date("2026-06-19T01:51:58.900Z"),
    });

    expect(second).toEqual(first);
  });

  it("preserves custom local-day boundaries", () => {
    expect(resolvePresetDateRange({
      preset: "custom",
      customFrom: "2026-06-10",
      customTo: "2026-06-12",
      now: new Date("2026-06-19T01:51:03.100Z"),
    })).toEqual({
      from: new Date("2026-06-10T00:00:00").toISOString(),
      to: new Date("2026-06-12T23:59:59.999").toISOString(),
      customReady: true,
    });
  });

  it("can keep cost-dashboard lookback windows distinct from inclusive dashboard windows", () => {
    const now = new Date("2026-06-19T01:51:03.100Z");

    expect(resolvePresetDateRange({ preset: "7d", now }).from).toBe(
      new Date("2026-06-13T00:00:00").toISOString(),
    );
    expect(resolvePresetDateRange({ preset: "7d", now, dayWindowMode: "lookback" }).from).toBe(
      new Date("2026-06-12T00:00:00").toISOString(),
    );
  });
});
