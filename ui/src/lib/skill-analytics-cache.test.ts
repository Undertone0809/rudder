import { describe, expect, it } from "vitest";
import { skillAnalyticsQueryOptions, SKILL_ANALYTICS_STALE_TIME_MS } from "./skill-analytics-cache";

describe("skill analytics query cache", () => {
  it("keeps skill analytics fresh long enough for dashboard navigation", () => {
    expect(SKILL_ANALYTICS_STALE_TIME_MS).toBe(120_000);
    expect(skillAnalyticsQueryOptions.staleTime).toBe(SKILL_ANALYTICS_STALE_TIME_MS);
  });

  it("keeps previous analytics while a new range is loading", () => {
    const previousAnalytics = { totalCount: 12 };

    expect(skillAnalyticsQueryOptions.placeholderData?.(previousAnalytics)).toBe(previousAnalytics);
  });
});
