import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/** Exact database values travel alongside Date fields used by the merge planner. */
export type MergeTimestampValues = {
  mergeTimestamps?: Record<string, string | null>;
};

export function selectMergeTimestamp(column: AnyPgColumn) {
  // Canonical UTC text retains PostgreSQL's six fractional digits and makes
  // source/target comparisons independent of their session time zones.
  return sql<string | null>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

export function mergeTimestamp<T extends MergeTimestampValues, K extends keyof T>(row: T, key: K): T[K] | SQL {
  if (!row.mergeTimestamps) return row[key]; // Existing programmatic plans use Date values.
  const raw = row.mergeTimestamps[String(key)];
  if (raw === undefined) throw new Error(`Missing exact merge timestamp: ${String(key)}`);
  if (raw === null) {
    if (row[key] !== null) throw new Error(`Inconsistent null merge timestamp: ${String(key)}`);
    return row[key];
  }
  return sql`${raw}::timestamptz`;
}

export function sameMergeTimestamp<T extends MergeTimestampValues, K extends keyof T>(left: T, right: T, key: K): boolean {
  const leftRaw = left.mergeTimestamps?.[String(key)];
  const rightRaw = right.mergeTimestamps?.[String(key)];
  if (left.mergeTimestamps || right.mergeTimestamps) {
    if (leftRaw === undefined || rightRaw === undefined) throw new Error(`Missing exact merge timestamp comparison: ${String(key)}`);
    return leftRaw === rightRaw;
  }
  const leftDate = left[key];
  const rightDate = right[key];
  return leftDate instanceof Date && rightDate instanceof Date
    ? leftDate.getTime() === rightDate.getTime()
    : leftDate === rightDate;
}
