import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getDatabaseBackupSizeGuardDecision,
  runDatabaseBackup,
  runDatabaseRestore,
  type DatabaseBackupSizeEstimate,
} from "./backup-lib.js";

const postgresMock = vi.hoisted(() => ({
  cursorBatchSizes: [] as number[],
  executedStatements: [] as string[],
  yieldedBatchSizes: [] as number[],
  failCursorAfterFirstBatch: false,
}));

vi.mock("postgres", () => ({
  default: vi.fn(() => {
    const rows = Array.from({ length: 33 }, (_, index) => [index + 1, `row-${index + 1}`]);
    const sql = (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("FROM information_schema.tables")) {
        return Promise.resolve([{ schema_name: "public", tablename: "large_table" }]);
      }
      if (query.includes("FROM information_schema.columns")) {
        return Promise.resolve([
          {
            column_name: "id",
            data_type: "integer",
            udt_name: "int4",
            is_nullable: "NO",
            column_default: null,
            character_maximum_length: null,
            numeric_precision: 32,
            numeric_scale: 0,
          },
          {
            column_name: "payload",
            data_type: "text",
            udt_name: "text",
            is_nullable: "NO",
            column_default: null,
            character_maximum_length: null,
            numeric_precision: null,
            numeric_scale: null,
          },
        ]);
      }
      return Promise.resolve([]);
    };

    sql.unsafe = (query: string) => {
      if (query.startsWith("SELECT count(*)")) return Promise.resolve([{ n: rows.length }]);
      if (query.startsWith("SELECT *")) {
        return {
          values: () => ({
            cursor: async function* (batchSize: number) {
              postgresMock.cursorBatchSizes.push(batchSize);
              for (let offset = 0; offset < rows.length; offset += batchSize) {
                const batch = rows.slice(offset, offset + batchSize);
                postgresMock.yieldedBatchSizes.push(batch.length);
                yield batch;
                if (postgresMock.failCursorAfterFirstBatch) throw new Error("injected cursor failure");
              }
            },
          }),
        };
      }
      return {
        execute: () => {
          postgresMock.executedStatements.push(query);
          return Promise.resolve([]);
        },
      };
    };
    sql.end = () => Promise.resolve();
    return sql;
  }),
}));

const temporaryDirectories: string[] = [];

afterEach(async () => {
  postgresMock.cursorBatchSizes.length = 0;
  postgresMock.executedStatements.length = 0;
  postgresMock.yieldedBatchSizes.length = 0;
  postgresMock.failCursorAfterFirstBatch = false;
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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

describe("runDatabaseBackup", () => {
  it("streams table rows in bounded cursor batches into an atomically committed backup", async () => {
    const backupDir = await mkdtemp(join(tmpdir(), "rudder-backup-streaming-"));
    temporaryDirectories.push(backupDir);

    const result = await runDatabaseBackup({
      connectionString: "postgres://mock",
      backupDir,
      retentionDays: 30,
      filenamePrefix: "streaming-test",
    });

    expect(postgresMock.cursorBatchSizes).toEqual([4]);
    expect(postgresMock.yieldedBatchSizes).toEqual([4, 4, 4, 4, 4, 4, 4, 4, 1]);

    const contents = await readFile(result.backupFile, "utf8");
    expect(contents.match(/INSERT INTO "public"\."large_table"/g)).toHaveLength(33);
    expect(contents).toContain("VALUES (1, $rudder$row-1$rudder$);");
    expect(contents).toContain("VALUES (33, $rudder$row-33$rudder$);");
    expect(contents).toContain("COMMIT;");

    const files = await readdir(backupDir);
    expect(files).toEqual([result.backupFile.split("/").at(-1)]);
    expect(files.some((file) => file.includes(".tmp-"))).toBe(false);

    await runDatabaseRestore({ connectionString: "postgres://mock", backupFile: result.backupFile });
    expect(postgresMock.executedStatements.filter((statement) =>
      statement.includes("INSERT INTO \"public\".\"large_table\"")))
      .toHaveLength(33);
    expect(postgresMock.executedStatements.at(-1)).toBe("COMMIT;");
  });

  it("removes the temporary backup when a cursor batch fails", async () => {
    const backupDir = await mkdtemp(join(tmpdir(), "rudder-backup-streaming-failure-"));
    temporaryDirectories.push(backupDir);
    postgresMock.failCursorAfterFirstBatch = true;

    await expect(runDatabaseBackup({
      connectionString: "postgres://mock",
      backupDir,
      retentionDays: 30,
      filenamePrefix: "streaming-test",
    })).rejects.toThrow("injected cursor failure");

    expect(postgresMock.yieldedBatchSizes).toEqual([4]);
    expect(await readdir(backupDir)).toEqual([]);
  });
});
