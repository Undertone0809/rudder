import { afterEach, describe, expect, it, vi } from "vitest";

import { agentIssuesUrl, formatDateTime, formatDateTimeSeconds, formatTime, formatTokens, relativeTime } from "./utils";

afterEach(() => {
  vi.useRealTimers();
});

describe("formatTokens", () => {
  it("uses billion units for billion-scale token counts", () => {
    expect(formatTokens(1_535_400_000)).toBe("1.5B");
    expect(formatTokens(1_000_000_000)).toBe("1.0B");
  });

  it("keeps existing million, thousand, and raw count formatting", () => {
    expect(formatTokens(999_900_000)).toBe("999.9M");
    expect(formatTokens(1_535_400)).toBe("1.5M");
    expect(formatTokens(1_200)).toBe("1.2k");
    expect(formatTokens(999)).toBe("999");
  });
});

describe("agentIssuesUrl", () => {
  it("builds an issue board URL filtered to the assigned agent", () => {
    expect(agentIssuesUrl("agent-123")).toBe("/issues?assignee=agent-123");
    expect(agentIssuesUrl("agent/with space")).toBe("/issues?assignee=agent%2Fwith%20space");
  });
});

describe("formatDateTimeSeconds", () => {
  it("formats local date-time values with fixed seconds", () => {
    expect(formatDateTimeSeconds(new Date(2026, 4, 11, 12, 35, 18))).toBe("2026-05-11 12:35:18");
    expect(formatDateTimeSeconds(new Date(2026, 0, 2, 3, 4, 5))).toBe("2026-01-02 03:04:05");
  });
});

describe("24-hour time formatting", () => {
  it("formats date-times without AM/PM markers", () => {
    const label = formatDateTime(new Date(2026, 4, 11, 16, 35, 18));
    expect(label).toContain("16:35");
    expect(label).not.toMatch(/\b(?:AM|PM)\b/i);
  });

  it("formats standalone times with 00-23 hours", () => {
    expect(formatTime(new Date(2026, 4, 11, 3, 4, 5), { seconds: true })).toBe("03:04:05");
    expect(formatTime(new Date(2026, 4, 11, 16, 35, 18))).toBe("16:35");
  });
});

describe("relativeTime", () => {
  it("keeps the default absolute fallback localized", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 9, 12, 0, 0));

    expect(relativeTime(new Date(2026, 4, 15, 12, 0, 0))).toBe("25d ago");
    expect(relativeTime(new Date(2026, 4, 9, 12, 0, 0))).toBe("May 9, 2026");
  });

  it("can render older dates with compact numeric labels", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 9, 12, 0, 0));

    expect(relativeTime(new Date(2026, 4, 9, 12, 0, 0), { compactDate: true })).toBe("2026.5.9");
  });
});
