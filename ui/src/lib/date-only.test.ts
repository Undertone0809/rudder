import { describe, expect, it } from "vitest";
import { formatLocalDateOnly, isDateOnly, parseDateOnlyValue, toDateOnlyValue } from "./date-only";

describe("date-only values", () => {
  it("accepts valid calendar dates and rejects invalid dates", () => {
    expect(isDateOnly("2026-08-20")).toBe(true);
    expect(isDateOnly("2026-02-29")).toBe(false);
    expect(isDateOnly("2026-13-01")).toBe(false);
    expect(isDateOnly("2026-8-20")).toBe(false);
  });

  it("preserves the calendar date from date-only and datetime inputs", () => {
    expect(toDateOnlyValue("2026-08-20")).toBe("2026-08-20");
    expect(toDateOnlyValue("2026-08-20T00:00:00.000Z")).toBe("2026-08-20");
    expect(toDateOnlyValue("2026-08-20T23:30:00-07:00")).toBe("2026-08-20");
    expect(toDateOnlyValue("not-a-date")).toBe("");
  });

  it("uses local calendar fields for picker dates", () => {
    const date = new Date(2026, 7, 20, 12, 0, 0, 0);
    expect(formatLocalDateOnly(date)).toBe("2026-08-20");
    const parsed = parseDateOnlyValue("2026-08-20")!;
    expect(formatLocalDateOnly(parsed)).toBe("2026-08-20");
  });
});
