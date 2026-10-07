import { PgDialect, pgTable, timestamp } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { mergeTimestamp, sameMergeTimestamp, selectMergeTimestamp } from "../commands/worktree-merge-timestamps.js";

const dialect = new PgDialect();
const table = pgTable("precision_test", { createdAt: timestamp("created_at", { withTimezone: true }) });

describe("worktree merge timestamp fidelity", () => {
  it("retains all six digits without interpolating the timestamp as SQL", () => {
    const exact = "2026-10-03T13:18:34.228710Z";
    const row = { createdAt: new Date(exact), mergeTimestamps: { createdAt: exact } };
    expect(row.createdAt.toISOString()).toBe("2026-10-03T13:18:34.228Z");
    const result = dialect.sqlToQuery(mergeTimestamp(row, "createdAt") as never);
    expect(result.sql).toBe("$1::timestamptz");
    expect(result.params).toEqual([exact]);
    const hostile = "2026-01-01'; DROP TABLE projects; --";
    expect(dialect.sqlToQuery(mergeTimestamp({ ...row, mergeTimestamps: { createdAt: hostile } }, "createdAt") as never).params).toEqual([hostile]);
  });

  it("selects canonical UTC text before the driver can decode it as Date", () => {
    const query = dialect.sqlToQuery(selectMergeTimestamp(table.createdAt));
    expect(query.sql).toContain('"precision_test"."created_at" AT TIME ZONE \'UTC\'');
    expect(query.sql).toContain('HH24:MI:SS.US');
  });

  it("preserves nulls and rejects an incomplete precision sidecar", () => {
    expect(mergeTimestamp({ pausedAt: null, mergeTimestamps: { pausedAt: null } }, "pausedAt")).toBeNull();
    expect(() => mergeTimestamp({ createdAt: new Date(), mergeTimestamps: {} }, "createdAt")).toThrow("Missing exact merge timestamp");
    expect(() => mergeTimestamp({ createdAt: new Date(), mergeTimestamps: { createdAt: null } }, "createdAt")).toThrow("Inconsistent null");
  });

  it("distinguishes source updates within one millisecond", () => {
    const a: { updatedAt: Date; mergeTimestamps: Record<string, string | null> } = { updatedAt: new Date("2026-10-03T13:18:34.228710Z"), mergeTimestamps: { updatedAt: "2026-10-03T13:18:34.228710Z" } };
    const b = { updatedAt: new Date("2026-10-03T13:18:34.228711Z"), mergeTimestamps: { updatedAt: "2026-10-03T13:18:34.228711Z" } };
    expect(a.updatedAt.getTime()).toBe(b.updatedAt.getTime());
    expect(sameMergeTimestamp(a, b, "updatedAt")).toBe(false);
    expect(sameMergeTimestamp(a, a, "updatedAt")).toBe(true);
    expect(() => sameMergeTimestamp(a, { ...b, mergeTimestamps: {} }, "updatedAt")).toThrow("Missing exact merge timestamp comparison");
  });
});
