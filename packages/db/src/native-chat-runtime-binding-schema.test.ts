import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { heartbeatRunAttempts } from "./schema/heartbeat_run_attempts.js";
import { heartbeatRuns } from "./schema/heartbeat_runs.js";
import * as schema from "./schema/index.js";
import {
  nativeSegments,
  runRuntimeSpans,
  runtimeBindings,
} from "./schema/runtime_bindings.js";

type ForeignKeyShape = {
  name: string;
  columns: string[];
  foreignTable: string;
  foreignColumns: string[];
  onDelete: string | undefined;
};

function columnsOf(table: PgTable): string[] {
  return getTableConfig(table).columns.map((column) => column.name);
}

function foreignKeyOf(table: PgTable, name: string): ForeignKeyShape {
  const foreignKey = getTableConfig(table).foreignKeys.find((candidate) => candidate.getName() === name);
  expect(foreignKey, `${name} must be declared`).toBeDefined();
  if (!foreignKey) throw new Error(`Missing foreign key ${name}`);

  const reference = foreignKey.reference();
  return {
    name: foreignKey.getName(),
    columns: reference.columns.map((column) => column.name),
    foreignTable: getTableConfig(reference.foreignTable).name,
    foreignColumns: reference.foreignColumns.map((column) => column.name),
    onDelete: foreignKey.onDelete,
  };
}

const migrationSql = readFileSync(
  fileURLToPath(new URL("./migrations/0164_native_chat_runtime_binding.sql", import.meta.url)),
  "utf8",
);

describe("native chat runtime binding schema", () => {
  it("exports lineage tables and durable common-run admission columns", () => {
    expect(schema.runtimeBindings).toBe(runtimeBindings);
    expect(schema.nativeSegments).toBe(nativeSegments);
    expect(schema.runRuntimeSpans).toBe(runRuntimeSpans);

    expect(columnsOf(heartbeatRuns)).toEqual(expect.arrayContaining([
      "scene",
      "target_type",
      "target_id",
      "idempotency_key",
      "session_intent_json",
    ]));

    const runConfig = getTableConfig(heartbeatRuns);
    expect(runConfig.indexes.map((index) => index.config.name)).toContain(
      "heartbeat_runs_org_idempotency_key_uq",
    );
    expect(runConfig.checks.map((check) => check.name)).toEqual(expect.arrayContaining([
      "heartbeat_runs_common_run_identity_check",
      "heartbeat_runs_scene_check",
      "heartbeat_runs_target_check",
      "heartbeat_runs_idempotency_key_check",
      "heartbeat_runs_session_intent_shape_check",
    ]));

    expect(getTableConfig(heartbeatRunAttempts).indexes.map((index) => index.config.name)).toContain(
      "heartbeat_run_attempts_org_run_id_uq",
    );
  });

  it("uses exact organization and lineage keys for parent/current and span relationships", () => {
    expect(foreignKeyOf(runtimeBindings, "runtime_bindings_parent_binding_org_fk")).toMatchObject({
      columns: ["org_id", "parent_binding_id"],
      foreignTable: "runtime_bindings",
      foreignColumns: ["org_id", "id"],
      onDelete: "no action",
    });
    expect(foreignKeyOf(runtimeBindings, "runtime_bindings_current_segment_binding_fk")).toMatchObject({
      columns: ["org_id", "id", "current_segment_id"],
      foreignTable: "native_segments",
      foreignColumns: ["org_id", "binding_id", "id"],
      onDelete: "no action",
    });
    expect(foreignKeyOf(nativeSegments, "native_segments_parent_segment_binding_fk")).toMatchObject({
      columns: ["org_id", "binding_id", "parent_segment_id"],
      foreignTable: "native_segments",
      foreignColumns: ["org_id", "binding_id", "id"],
      onDelete: "no action",
    });
    expect(foreignKeyOf(runRuntimeSpans, "run_runtime_spans_binding_segment_fk")).toMatchObject({
      columns: ["org_id", "binding_id", "segment_id"],
      foreignTable: "native_segments",
      foreignColumns: ["org_id", "binding_id", "id"],
      onDelete: "no action",
    });
    expect(foreignKeyOf(runRuntimeSpans, "run_runtime_spans_run_attempt_fk")).toMatchObject({
      columns: ["org_id", "run_id", "attempt_id"],
      foreignTable: "heartbeat_run_attempts",
      foreignColumns: ["org_id", "run_id", "id"],
      onDelete: "no action",
    });
  });

  it("keeps the manual 0164 migration aligned without relying on snapshots", () => {
    expect(migrationSql).toContain('ALTER TABLE "heartbeat_runs" ADD COLUMN "scene" text;');
    expect(migrationSql).toContain(
      'CREATE UNIQUE INDEX "heartbeat_runs_org_idempotency_key_uq" ON "heartbeat_runs" USING btree ("org_id","idempotency_key") WHERE "idempotency_key" IS NOT NULL;',
    );
    expect(migrationSql).toContain(
      'CREATE UNIQUE INDEX "runtime_bindings_org_conversation_uq" ON "runtime_bindings" USING btree ("org_id","conversation_id") WHERE "status" = \'active\';',
    );
    expect(migrationSql).toContain(
      'CREATE UNIQUE INDEX "runtime_bindings_org_conversation_epoch_uq" ON "runtime_bindings" USING btree ("org_id","conversation_id","binding_epoch");',
    );
    expect(migrationSql).toContain(
      'CREATE UNIQUE INDEX "heartbeat_run_attempts_org_run_id_uq" ON "heartbeat_run_attempts" USING btree ("org_id","run_id","id");',
    );

    for (const constraint of [
      "runtime_bindings_parent_binding_org_fk",
      "runtime_bindings_current_segment_binding_fk",
      "native_segments_parent_segment_binding_fk",
      "run_runtime_spans_binding_segment_fk",
      "run_runtime_spans_run_attempt_fk",
      "heartbeat_runs_common_run_identity_check",
      "heartbeat_runs_session_intent_shape_check",
      "native_segments_sealed_lifecycle_check",
      "run_runtime_spans_closed_lifecycle_check",
      "runtime_retention_claims_lifecycle_check",
      "runtime_source_aliases_read_only_check",
    ]) {
      expect(migrationSql).toContain(`"${constraint}"`);
    }

    expect(migrationSql).toContain(
      'FOREIGN KEY ("org_id", "run_id", "attempt_id") REFERENCES "public"."heartbeat_run_attempts"("org_id", "run_id", "id") ON DELETE no action',
    );
    expect(migrationSql).toContain(
      'FOREIGN KEY ("org_id", "binding_id", "segment_id") REFERENCES "public"."native_segments"("org_id", "binding_id", "id") ON DELETE no action',
    );
  });
});
