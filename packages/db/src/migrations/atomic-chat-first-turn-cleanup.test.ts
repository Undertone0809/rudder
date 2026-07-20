import fs from "node:fs";
import { describe, expect, it } from "vitest";

const migration = fs.readFileSync(
  new URL("./0108_atomic_chat_first_turn_cleanup.sql", import.meta.url),
  "utf8",
);

describe("atomic chat first-turn cleanup migration", () => {
  it("deletes unbound empties and preserves bound empties as hidden archived evidence", () => {
    expect(migration).toContain('DELETE FROM "chat_conversations"');
    expect(migration).toContain('DELETE FROM "agent_integration_chat_bindings"');
    expect(migration).toContain("'legacy_empty_chat_recovered'");
    expect(migration).toContain('"status" = \'archived\'');
    expect(migration).toContain('"messenger_visible" = false');
    expect(migration).toContain('"last_message_at" = recovered_message."created_at"');
  });
});
