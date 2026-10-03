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
  functions: [] as { definition: string }[],
  checks: [] as { schema_name: string; tablename: string; constraint_name: string; definition: string }[],
  triggers: [] as { schema_name: string; tablename: string; trigger_name: string; enabled: string; definition: string }[],
}));

vi.mock("postgres", () => ({
  default: vi.fn(() => {
    const rows = Array.from({ length: 33 }, (_, index) => [index + 1, `row-${index + 1}`]);
    const sql = (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("FROM pg_proc")) return Promise.resolve(postgresMock.functions);
      if (query.includes("c.contype = 'c'")) return Promise.resolve(postgresMock.checks);
      if (query.includes("FROM pg_trigger")) return Promise.resolve(postgresMock.triggers);
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
  postgresMock.functions.length = 0;
  postgresMock.checks.length = 0;
  postgresMock.triggers.length = 0;
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
  async function restoreFixture() {
    const backupDir = await mkdtemp(join(tmpdir(), "rudder-backup-guards-"));
    temporaryDirectories.push(backupDir);
    const result = await runDatabaseBackup({
      connectionString: "postgres://mock", backupDir, retentionDays: 30,
    });
    await runDatabaseRestore({ connectionString: "postgres://mock", backupFile: result.backupFile });
    return postgresMock.executedStatements;
  }

  it("restores the complete dollar-quoted trigger function as one statement before data", async () => {
    const definition = `CREATE OR REPLACE FUNCTION public.guard_fixture() RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.payload = 'semicolon; inside literal' THEN
    RAISE EXCEPTION 'guard; rejected' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$`;
    postgresMock.functions.push({ definition });
    const statements = await restoreFixture();
    const functionIndex = statements.findIndex((statement) => statement.includes("CREATE OR REPLACE FUNCTION"));
    expect(functionIndex).toBeGreaterThan(-1);
    expect(statements[functionIndex]).toBe(definition);
    expect(statements.filter((statement) => statement.includes("guard; rejected"))).toHaveLength(1);
    expect(statements.indexOf("SET LOCAL check_function_bodies = false;")).toBeLessThan(functionIndex);
    expect(statements.findIndex((statement) => statement.includes("CREATE TABLE"))).toBeLessThan(functionIndex);
    expect(functionIndex).toBeLessThan(statements.findIndex((statement) => statement.startsWith("INSERT INTO")));
  });

  it("restores validated and NOT VALID CHECK definitions after historical rows", async () => {
    postgresMock.checks.push(
      { schema_name: "public", tablename: "large_table", constraint_name: "positive_id", definition: "CHECK (id > 0)" },
      // Existing rows violate this unvalidated check and must load before it.
      { schema_name: "public", tablename: "large_table", constraint_name: 'future"payload', definition: "CHECK (payload = 'future') NOT VALID" },
      { schema_name: "public", tablename: "not_in_snapshot", constraint_name: "excluded", definition: "CHECK (false)" },
    );
    const statements = await restoreFixture();
    const lastInsert = statements.findLastIndex((statement) => statement.startsWith("INSERT INTO"));
    for (const expected of [
      'ALTER TABLE "public"."large_table" ADD CONSTRAINT "positive_id" CHECK (id > 0);',
      'ALTER TABLE "public"."large_table" ADD CONSTRAINT "future""payload" CHECK (payload = \'future\') NOT VALID;',
    ]) {
      expect(statements).toContain(expected);
      expect(statements.indexOf(expected)).toBeGreaterThan(lastInsert);
    }
    expect(statements.join("\n")).not.toContain("not_in_snapshot");
  });

  it("installs triggers after data and checks, preserving every enabled mode and catalog order", async () => {
    const modes = { O: "ENABLE", D: "DISABLE", R: "ENABLE REPLICA", A: "ENABLE ALWAYS" };
    postgresMock.checks.push({ schema_name: "public", tablename: "large_table", constraint_name: "positive_id", definition: "CHECK (id > 0)" });
    for (const enabled of Object.keys(modes)) {
      postgresMock.triggers.push({
        schema_name: "public", tablename: "large_table", trigger_name: `guard_${enabled}`,
        enabled, definition: `CREATE TRIGGER guard_${enabled} BEFORE INSERT ON public.large_table FOR EACH ROW EXECUTE FUNCTION public.guard_fixture()`,
      });
    }
    postgresMock.triggers.push({ schema_name: "public", tablename: "not_in_snapshot", trigger_name: "excluded", enabled: "A", definition: "CREATE TRIGGER excluded" });
    const statements = await restoreFixture();
    let previousIndex = statements.findIndex((statement) => statement.includes('ADD CONSTRAINT "positive_id"'));
    expect(previousIndex).toBeGreaterThan(statements.findLastIndex((statement) => statement.startsWith("INSERT INTO")));
    for (const [enabled, mode] of Object.entries(modes)) {
      const trigger = postgresMock.triggers.find((entry) => entry.enabled === enabled)!;
      const index = statements.indexOf(`${trigger.definition};`);
      expect(index).toBeGreaterThan(previousIndex);
      expect(statements[index + 1]).toBe(`ALTER TABLE "public"."large_table" ${mode} TRIGGER "guard_${enabled}";`);
      previousIndex = index + 1;
    }
    expect(statements.join("\n")).not.toContain("CREATE TRIGGER excluded");
    expect(statements.at(-1)).toBe("COMMIT;");
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
