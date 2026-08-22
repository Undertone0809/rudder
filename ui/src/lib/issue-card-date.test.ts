// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { formatIssueCardDate } from "./issue-card-date";

afterEach(() => {
  vi.useRealTimers();
  document.documentElement.lang = "";
});

describe("formatIssueCardDate", () => {
  it("keeps relative day labels alongside the concrete local time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 19, 12, 0, 0));

    expect(formatIssueCardDate(new Date(2026, 4, 19, 9, 8))).toBe("09:08");
    expect(formatIssueCardDate(new Date(2026, 4, 18, 22, 15))).toBe("Yesterday, 22:15");
    expect(formatIssueCardDate(new Date(2026, 4, 17, 22, 15))).toBe("May 17, 22:15");
    expect(formatIssueCardDate(new Date(2025, 11, 31, 22, 15))).toBe("Dec 31, 2025, 22:15");
  });

  it("keeps the day boundary local when yesterday is only a few minutes away", () => {
    const now = new Date(2026, 4, 19, 0, 1);

    expect(formatIssueCardDate(new Date(2026, 4, 18, 23, 59), now)).toBe("Yesterday, 23:59");
    expect(formatIssueCardDate(new Date(2026, 4, 19, 0, 0), now)).toBe("00:00");
  });

  it("uses localized labels and dates in Chinese UI", () => {
    document.documentElement.lang = "zh-CN";

    expect(
      formatIssueCardDate(new Date(2026, 4, 18, 22, 15), new Date(2026, 4, 19, 12, 0, 0)),
    ).toBe("昨天 22:15");
    expect(
      formatIssueCardDate(new Date(2026, 4, 17, 22, 15), new Date(2026, 4, 19, 12, 0, 0)),
    ).toBe("5/17 22:15");
    expect(
      formatIssueCardDate(new Date(2025, 11, 31, 22, 15), new Date(2026, 4, 19, 12, 0, 0)),
    ).toBe("2025/12/31 22:15");
  });
});
