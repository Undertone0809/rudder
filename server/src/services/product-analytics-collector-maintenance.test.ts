import { describe, expect, it } from "vitest";
import { retainedProductAnalyticsCohortDay } from "./product-analytics-collector-maintenance.js";

describe("product analytics collector maintenance", () => {
  it("does not recreate a privacy cohort after its retention cutoff", () => {
    const cutoff = new Date("2026-08-04T00:00:00.000Z");

    expect(retainedProductAnalyticsCohortDay(new Date("2026-08-03T23:59:59.999Z"), cutoff)).toBeNull();
    expect(retainedProductAnalyticsCohortDay(cutoff, cutoff)).toBe("2026-08-04");
  });

  it("keeps the full UTC cutoff day because retention is day-based", () => {
    const cutoff = new Date("2026-08-04T12:00:00.000Z");

    expect(retainedProductAnalyticsCohortDay(new Date("2026-08-04T00:00:00.000Z"), cutoff)).toBe("2026-08-04");
  });
});
