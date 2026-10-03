import { getTableConfig } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as schema from "./schema/index.js";
import { sideChatProviderCleanupIntents } from "./schema/side_chat_provider_cleanup_intents.js";

const table = getTableConfig(sideChatProviderCleanupIntents);
const migrationSql = readFileSync(
  fileURLToPath(new URL("./migrations/0176_side_chat_provider_cleanup_intents.sql", import.meta.url)),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };

describe("Side Chat Provider cleanup outbox schema", () => {
  it("exports durable owner, binding epoch, fork run, and lease identity", () => {
    expect(schema.sideChatProviderCleanupIntents).toBe(sideChatProviderCleanupIntents);
    expect(table.columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "org_id",
      "conversation_id",
      "owner_user_id",
      "binding_id",
      "binding_epoch",
      "segment_id",
      "fork_run_id",
      "native_session_id",
      "profile_snapshot_json",
      "state",
      "lease_owner",
      "lease_epoch",
      "lease_expires_at",
    ]));
    expect(table.indexes.map((index) => index.config.name)).toContain(
      "side_chat_provider_cleanup_resource_uq",
    );
    expect(table.checks.map((check) => check.name)).toEqual(expect.arrayContaining([
      "side_chat_provider_cleanup_state_check",
      "side_chat_provider_cleanup_identity_check",
      "side_chat_provider_cleanup_lease_check",
      "side_chat_provider_cleanup_completion_check",
    ]));
  });

  it("keeps provider cleanup independent of deleted chat/runtime foreign keys and journals its migration", () => {
    expect(table.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual([
      "side_chat_provider_cleanup_intents_org_id_organizations_id_fk",
    ]);
    expect(migrationSql).toContain('"fork_run_id" uuid');
    expect(migrationSql).toContain('"side_chat_provider_cleanup_resource_uq"');
    const entries = journal.entries.filter((entry) => entry.tag === "0176_side_chat_provider_cleanup_intents");
    const retention = journal.entries.find((entry) => entry.tag === "0175_span_supplement_retention");
    expect(entries).toHaveLength(1);
    expect(retention).toBeDefined();
    expect(entries[0]!.idx).toBeGreaterThan(retention!.idx);
  });
});
