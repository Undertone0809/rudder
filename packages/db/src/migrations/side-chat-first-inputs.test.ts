import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import EmbeddedPostgres from "embedded-postgres";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations, ensurePostgresDatabase } from "../client.js";

const migrations = path.dirname(fileURLToPath(import.meta.url));
let root = "";
let instance: EmbeddedPostgres | undefined;
let db: postgres.Sql;
let legacyConversationId = "";
let legacyMessageId = "";

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("No disposable PostgreSQL port")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "rudder-side-chat-first-inputs-"));
  const port = await availablePort();
  instance = new EmbeddedPostgres({
    databaseDir: path.join(root, "postgres"),
    user: "rudder",
    password: "rudder",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  await instance.start();
  await ensurePostgresDatabase(`postgres://rudder:rudder@127.0.0.1:${port}/postgres`, "rudder");
  const url = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  db = postgres(url, { max: 3, onnotice: () => {} });

  const prior = path.join(root, "prior-migrations");
  mkdirSync(path.join(prior, "meta"), { recursive: true });
  const journal = JSON.parse(
    readFileSync(path.join(migrations, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 171);
  for (const entry of journal.entries) {
    copyFileSync(path.join(migrations, `${entry.tag}.sql`), path.join(prior, `${entry.tag}.sql`));
  }
  writeFileSync(path.join(prior, "meta/_journal.json"), JSON.stringify(journal));
  await migrate(drizzle(db), { migrationsFolder: prior });

  const orgId = randomUUID();
  legacyConversationId = randomUUID();
  legacyMessageId = randomUUID();
  await db`INSERT INTO organizations (id, url_key, name, issue_prefix)
    VALUES (${orgId}, ${`legacy-side-chat-${orgId}`}, 'Legacy Side Chat', ${`L${orgId.replaceAll("-", "").slice(0, 8)}`})`;
  await db`INSERT INTO chat_conversations (
      id, org_id, conversation_kind, messenger_visible, created_by_user_id,
      forked_from_conversation_id, forked_from_message_id
    ) VALUES (
      ${legacyConversationId}, ${orgId}, 'side_chat', false, 'legacy-owner', null, null
    )`;
  await db`INSERT INTO chat_messages (
      id, org_id, conversation_id, role, kind, status, body,
      client_mutation_id, client_mutation_fingerprint
    ) VALUES (
      ${legacyMessageId}, ${orgId}, ${legacyConversationId}, 'user', 'message', 'completed',
      'Existing first input', null, null
    )`;
  await applyPendingMigrations(url);
}, 180_000);

afterAll(async () => {
  await db?.end({ timeout: 5 });
  await instance?.stop();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("Side Chat first-input migration", () => {
  it("backfills a populated legacy Side Chat with null source fields", async () => {
    const [intent] = await db`
      SELECT creation_mutation_id, status, owner_user_id,
             source_conversation_id, source_message_id, user_message_id
      FROM side_chat_first_inputs
      WHERE conversation_id = ${legacyConversationId}
    `;

    expect(intent).toEqual({
      creation_mutation_id: `legacy:${legacyConversationId}`,
      status: "accepted",
      owner_user_id: "legacy-owner",
      source_conversation_id: null,
      source_message_id: null,
      user_message_id: legacyMessageId,
    });
  });
});
