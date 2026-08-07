import { describe, expect, it } from "vitest";
import { buildProductAnalyticsCreationSeries } from "./product-analytics-collector-report.js";

const range = {
  from: new Date("2026-08-01T00:00:00.000Z"),
  to: new Date("2026-08-04T23:59:59.999Z"),
};

describe("product analytics creation report", () => {
  it("uses the global observation date so leading zero days remain in the sample", () => {
    const report = buildProductAnalyticsCreationSeries([
      { day: "2026-08-02", installationId: "install-a", eventName: "issue_created", origin: "human", eventCount: 2 },
      { day: "2026-08-02", installationId: "install-b", eventName: "issue_created", origin: "human", eventCount: 3 },
      { day: "2026-08-03", installationId: "install-a", eventName: "issue_created", origin: "automation", eventCount: 50 },
    ], range, 2, { issue_created: "2026-07-30" });

    expect(report.days).toEqual([
      {
        day: "2026-08-01",
        issuesCreated: { count: 0, status: "available" },
        chatsCreated: { count: null, status: "not_observed" },
      },
      {
        day: "2026-08-02",
        issuesCreated: { count: 5, status: "available" },
        chatsCreated: { count: null, status: "not_observed" },
      },
      {
        day: "2026-08-03",
        issuesCreated: { count: 0, status: "available" },
        chatsCreated: { count: null, status: "not_observed" },
      },
      {
        day: "2026-08-04",
        issuesCreated: { count: 0, status: "available" },
        chatsCreated: { count: null, status: "not_observed" },
      },
    ]);
  });

  it("keeps below-threshold days null and never includes automation creation", () => {
    const report = buildProductAnalyticsCreationSeries([
      { day: "2026-08-01", installationId: "install-a", eventName: "chat_created", origin: "human", eventCount: 7 },
      { day: "2026-08-01", installationId: "install-b", eventName: "chat_created", origin: "automation", eventCount: 30 },
      { day: "2026-08-02", installationId: "install-a", eventName: "chat_created", origin: "human", eventCount: 2 },
      { day: "2026-08-02", installationId: "install-b", eventName: "chat_created", origin: "human", eventCount: 4 },
    ], range, 2);

    expect(report.days[0]?.chatsCreated).toEqual({ count: null, status: "threshold_blocked" });
    expect(report.days[1]?.chatsCreated).toEqual({ count: 6, status: "available" });
    expect(JSON.stringify(report)).not.toContain("install-a");
    expect(JSON.stringify(report)).not.toContain("automation");
  });
});
