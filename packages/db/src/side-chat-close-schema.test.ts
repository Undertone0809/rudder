import { getTableConfig } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as schema from "./schema/index.js";
import { sideChatCloseIntents } from "./schema/side_chat_close_intents.js";

const table = getTableConfig(sideChatCloseIntents);
const migrationSql = readFileSync(
  fileURLToPath(new URL("./migrations/0171_side_chat_close_intents.sql", import.meta.url)),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };

describe("Side Chat close intent schema", () => {
  it("persists independent close, Stop, lease, and attachment cleanup state", () => {
    expect(schema.sideChatCloseIntents).toBe(sideChatCloseIntents);
    expect(table.columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "conversation_id", "owner_user_id", "state", "stop_generation_id",
      "stop_control_action_id", "attachments_json", "attachment_cursor",
      "lease_owner", "lease_epoch", "lease_expires_at",
    ]));
    expect(table.indexes.map((index) => index.config.name)).toContain("side_chat_close_conversation_uq");
    expect(table.checks.map((check) => check.name)).toEqual(expect.arrayContaining([
      "side_chat_close_state_check", "side_chat_close_lease_check", "side_chat_close_cursor_check",
    ]));
  });

  it("survives conversation deletion and blocks organization deletion until cleanup finishes", () => {
    expect(table.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual([
      "side_chat_close_intents_org_id_organizations_id_fk",
    ]);
    expect(migrationSql).toContain('ON DELETE RESTRICT');
    expect(migrationSql).toContain('"attachments_json" jsonb');
    expect(journal.entries.some((entry) => entry.idx === 171
      && entry.tag === "0171_side_chat_close_intents")).toBe(true);
  });
});
