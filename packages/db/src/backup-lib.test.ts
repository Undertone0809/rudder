import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  applicationSchemas: ["public", "rudder_analytics"] as string[],
  cursorBatchSizes: [] as number[],
  executedStatements: [] as string[],
  yieldedBatchSizes: [] as number[],
  failCursorAfterFirstBatch: false,
}));

const childProcessMock = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock("node:child_process", () => childProcessMock);

vi.mock("postgres", () => ({
  default: vi.fn(() => {
    const rows = Array.from({ length: 33 }, (_, index) => [index + 1, `row-${index + 1}`]);
    const sql = (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("FROM information_schema.tables")) {
        return Promise.resolve([{ schema_name: "public", tablename: "large_table" }]);
      }
      if (query.includes("FROM pg_namespace")) {
        return Promise.resolve(postgresMock.applicationSchemas.map((schema_name) => ({ schema_name })));
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
  postgresMock.applicationSchemas.splice(0, postgresMock.applicationSchemas.length, "public", "rudder_analytics");
  postgresMock.cursorBatchSizes.length = 0;
  postgresMock.executedStatements.length = 0;
  postgresMock.yieldedBatchSizes.length = 0;
  postgresMock.failCursorAfterFirstBatch = false;
  childProcessMock.execFile.mockReset();
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
  it("uses PostgreSQL custom format when requested and atomically renames the dump", async () => {
    const backupDir = await mkdtemp(join(tmpdir(), "rudder-backup-custom-"));
    temporaryDirectories.push(backupDir);
    const postgresBinDir = join(backupDir, "bin");
    await mkdir(postgresBinDir);
    await writeFile(join(postgresBinDir, "pg_dump"), "mock binary");
    await writeFile(join(backupDir, "custom-test-20200101-000000-999999-stale.dump.tmp-old"), "stale");
    childProcessMock.execFile.mockImplementation((_binary: string, args: string[], ...callArgs: unknown[]) => {
      const callback = callArgs.at(-1) as (error: Error | null) => void;
      const fileIndex = args.indexOf("--file");
      void writeFile(String(args[fileIndex + 1]), "PGDMP custom backup").then(() => callback(null));
    });

    const result = await runDatabaseBackup({
      connectionString: "postgres://mock",
      backupDir,
      retentionDays: 30,
      filenamePrefix: "custom-test",
      format: "custom",
      postgresBinDir,
      includeMigrationJournal: true,
      excludeTables: ["organizations"],
    });

      expect(childProcessMock.execFile).toHaveBeenCalledWith(
      join(postgresBinDir, "pg_dump"),
      expect.arrayContaining([
        "--format=custom",
        "--compress=6",
        "--no-owner",
        "--no-privileges",
        "--schema=public",
        "--schema=rudder_analytics",
        "--schema=drizzle",
        "--exclude-table=public.organizations",
        "postgres://mock",
      ]),
      expect.objectContaining({ maxBuffer: 8 * 1024 * 1024 }),
      expect.any(Function),
    );
    expect(result.backupFile).toMatch(/\.dump$/);
    expect(await readFile(result.backupFile, "utf8")).toBe("PGDMP custom backup");
    expect((await readdir(backupDir)).filter((file) => file.includes(".tmp-")).length).toBe(0);
  });

  it("keeps the migration schema out of custom backups unless explicitly requested", async () => {
    const backupDir = await mkdtemp(join(tmpdir(), "rudder-backup-custom-schema-"));
    temporaryDirectories.push(backupDir);
    const postgresBinDir = join(backupDir, "bin");
    await mkdir(postgresBinDir);
    await writeFile(join(postgresBinDir, "pg_dump"), "mock binary");
    childProcessMock.execFile.mockImplementation((_binary: string, args: string[], ...callArgs: unknown[]) => {
      const callback = callArgs.at(-1) as (error: Error | null) => void;
      const fileIndex = args.indexOf("--file");
      void writeFile(String(args[fileIndex + 1]), "PGDMP custom backup").then(() => callback(null));
    });

    await runDatabaseBackup({
      connectionString: "postgres://mock",
      backupDir,
      retentionDays: 30,
      filenamePrefix: "custom-test",
      format: "custom",
      postgresBinDir,
    });

    const args = childProcessMock.execFile.mock.calls[0]?.[1] as string[];
    expect(args).toContain("--schema=public");
    expect(args).toContain("--schema=rudder_analytics");
    expect(args).not.toContain("--schema=drizzle");
  });

  it("includes future schemas owned by the database role in custom backups", async () => {
    const backupDir = await mkdtemp(join(tmpdir(), "rudder-backup-custom-future-schema-"));
    temporaryDirectories.push(backupDir);
    const postgresBinDir = join(backupDir, "bin");
    await mkdir(postgresBinDir);
    await writeFile(join(postgresBinDir, "pg_dump"), "mock binary");
    postgresMock.applicationSchemas.push("future_owned");
    childProcessMock.execFile.mockImplementation((_binary: string, args: string[], ...callArgs: unknown[]) => {
      const callback = callArgs.at(-1) as (error: Error | null) => void;
      const fileIndex = args.indexOf("--file");
      void writeFile(String(args[fileIndex + 1]), "PGDMP custom backup").then(() => callback(null));
    });

    await runDatabaseBackup({
      connectionString: "postgres://mock",
      backupDir,
      retentionDays: 30,
      filenamePrefix: "custom-test",
      format: "custom",
      postgresBinDir,
    });

    const args = childProcessMock.execFile.mock.calls[0]?.[1] as string[];
    expect(args).toContain("--schema=future_owned");
  });

  it("removes the custom temporary dump when pg_dump fails", async () => {
    const backupDir = await mkdtemp(join(tmpdir(), "rudder-backup-custom-failure-"));
    temporaryDirectories.push(backupDir);
    const postgresBinDir = join(backupDir, "bin");
    await mkdir(postgresBinDir);
    await writeFile(join(postgresBinDir, "pg_dump"), "mock binary");
    childProcessMock.execFile.mockImplementation((_binary: string, _args: string[], ...callArgs: unknown[]) => {
      const callback = callArgs.at(-1) as (error: Error) => void;
      callback(Object.assign(new Error("command failed"), { code: 1, stderr: "could not write backup" }));
    });

    await expect(runDatabaseBackup({
      connectionString: "postgres://mock",
      backupDir,
      retentionDays: 30,
      filenamePrefix: "custom-test",
      format: "custom",
      postgresBinDir,
    })).rejects.toThrow("could not write backup");

    expect((await readdir(backupDir)).filter((file) => file.includes(".tmp-") || file.endsWith(".dump"))).toEqual([]);
  });

  it("restores a custom dump through pg_restore without exposing the connection string", async () => {
    const backupDir = await mkdtemp(join(tmpdir(), "rudder-backup-custom-restore-"));
    temporaryDirectories.push(backupDir);
    const postgresBinDir = join(backupDir, "bin");
    await mkdir(postgresBinDir);
    await writeFile(join(postgresBinDir, "pg_restore"), "mock binary");
    const backupFile = join(backupDir, "restore.dump");
    await writeFile(backupFile, "PGDMP custom backup");
    let utilityOptions: unknown;
    const previousPassword = process.env.PGPASSWORD;
    process.env.PGPASSWORD = "wrong-inherited-password";
    childProcessMock.execFile.mockImplementation((_binary: string, args: string[], options: unknown, ...callArgs: unknown[]) => {
      utilityOptions = options;
      const callback = callArgs.at(-1) as (error: Error | null) => void;
      callback(null);
    });

    try {
      await runDatabaseRestore({
        connectionString: "postgres://user:secret@mock/rudder",
        backupFile,
        postgresBinDir,
      });
    } finally {
      if (previousPassword === undefined) delete process.env.PGPASSWORD;
      else process.env.PGPASSWORD = previousPassword;
    }

    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      join(postgresBinDir, "pg_restore"),
      expect.arrayContaining([
        "--clean",
        "--if-exists",
        "--exit-on-error",
        "--single-transaction",
        "--no-owner",
        "--no-privileges",
        "--dbname",
        "postgres://user@mock/rudder",
        backupFile,
      ]),
      expect.objectContaining({ maxBuffer: 8 * 1024 * 1024 }),
      expect.any(Function),
    );
    const calledArgs = childProcessMock.execFile.mock.calls[0]?.[1] as string[];
    expect(calledArgs.join(" ")).not.toContain("secret");
    expect(utilityOptions).toMatchObject({
      env: { PGPASSFILE: expect.any(String) },
    });
    expect((utilityOptions as { env: NodeJS.ProcessEnv }).env.PGPASSWORD).toBeUndefined();
    const passfile = (utilityOptions as { env: { PGPASSFILE: string } }).env.PGPASSFILE;
    await expect(access(passfile)).rejects.toThrow();
  });

  it("rejects custom backups when column nullification would be silently lost", async () => {
    const backupDir = await mkdtemp(join(tmpdir(), "rudder-backup-custom-filter-"));
    temporaryDirectories.push(backupDir);
    const postgresBinDir = join(backupDir, "bin");
    await mkdir(postgresBinDir);
    await writeFile(join(postgresBinDir, "pg_dump"), "mock binary");

    await expect(runDatabaseBackup({
      connectionString: "postgres://mock",
      backupDir,
      retentionDays: 30,
      format: "custom",
      postgresBinDir,
      nullifyColumns: { organizations: ["name"] },
    })).rejects.toThrow("do not support nullified columns");
    expect(childProcessMock.execFile).not.toHaveBeenCalled();
  });

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
