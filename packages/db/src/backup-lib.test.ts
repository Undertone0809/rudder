import { describe, expect, it } from "vitest";
import {
  getDatabaseBackupSizeGuardDecision,
  type DatabaseBackupSizeEstimate,
} from "./backup-lib.js";

function estimate(overrides: Partial<DatabaseBackupSizeEstimate>): DatabaseBackupSizeEstimate {
  return {
    databaseSizeBytes: 0,
    includedTableTotalBytes: 0,
    tableCount: 0,
    largestTables: [],
    ...overrides,
  };
}

describe("getDatabaseBackupSizeGuardDecision", () => {
  it("allows scheduled backups when the estimated database size is at the limit", () => {
    expect(
      getDatabaseBackupSizeGuardDecision(
        estimate({ databaseSizeBytes: 256, includedTableTotalBytes: 128 }),
        256,
      ),
    ).toEqual({
      shouldSkip: false,
      reason: null,
      estimatedBytes: 256,
      maxEstimatedBytes: 256,
    });
  });

  it("skips scheduled backups when either database or included table estimate exceeds the limit", () => {
    expect(
      getDatabaseBackupSizeGuardDecision(
        estimate({ databaseSizeBytes: 128, includedTableTotalBytes: 257 }),
        256,
      ),
    ).toEqual({
      shouldSkip: true,
      reason: "database_too_large_for_in_process_backup",
      estimatedBytes: 257,
      maxEstimatedBytes: 256,
    });
  });

  it("normalizes invalid thresholds to a positive byte limit", () => {
    expect(
      getDatabaseBackupSizeGuardDecision(
        estimate({ databaseSizeBytes: 2 }),
        0,
      ),
    ).toMatchObject({
      shouldSkip: true,
      estimatedBytes: 2,
      maxEstimatedBytes: 1,
    });
  });
});
