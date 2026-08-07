import { describe, expect, it } from "vitest";
import { fromDateTimeLocalValue, toDateTimeLocalValue } from "./datetime-local";

describe("datetime-local conversion", () => {
  it("round-trips a local wall-clock value through an ISO instant", () => {
    const localValue = "2026-08-20T10:45";
    const instant = fromDateTimeLocalValue(localValue);

    expect(instant).not.toBeNull();
    expect(toDateTimeLocalValue(instant!)).toBe(localValue);
  });

  it("returns empty values for invalid input", () => {
    expect(fromDateTimeLocalValue("not-a-date")).toBeNull();
    expect(toDateTimeLocalValue("not-a-date")).toBe("");
  });
});
