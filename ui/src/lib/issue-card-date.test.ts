// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { formatIssueCardDate } from "./issue-card-date";

afterEach(() => {
  vi.useRealTimers();
  document.documentElement.lang = "";
});

describe("formatIssueCardDate", () => {
  it("keeps issue card dates concrete except for yesterday", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 19, 12, 0, 0));

    expect(formatIssueCardDate(new Date(2026, 4, 19, 9, 8))).toBe("09:08");
    expect(formatIssueCardDate(new Date(2026, 4, 18, 22, 15))).toBe("Yesterday");
    expect(formatIssueCardDate(new Date(2026, 4, 17, 22, 15))).toBe("May 17, 22:15");
    expect(formatIssueCardDate(new Date(2025, 11, 31, 22, 15))).toBe("Dec 31, 2025, 22:15");
  });

  it("uses localized labels and dates in Chinese UI", () => {
    document.documentElement.lang = "zh-CN";

    expect(
      formatIssueCardDate(new Date(2026, 4, 18, 22, 15), new Date(2026, 4, 19, 12, 0, 0)),
    ).toBe("昨天");
    expect(
      formatIssueCardDate(new Date(2026, 4, 17, 22, 15), new Date(2026, 4, 19, 12, 0, 0)),
    ).toBe("5/17 22:15");
    expect(
      formatIssueCardDate(new Date(2025, 11, 31, 22, 15), new Date(2026, 4, 19, 12, 0, 0)),
    ).toBe("2025/12/31 22:15");
  });
});
