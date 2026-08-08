import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations, ensurePostgresDatabase } from "../client.js";
import { createLocalPostgresInstance } from "../local-postgres-provider.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

type BackfillReport = {
  legacyCandidates: number;
  legacyEligible: number;
  legacyMigrated: number;
  legacySkipped: unknown[];
  forksChecked: number;
  forksEligible: number;
  forksRepaired: number;
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("port allocation failed"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function runBackfill(connectionString: string, args: string[]) {
  return await new Promise<{ code: number | null; report: BackfillReport }>((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(repositoryRoot, "cli/node_modules/tsx/dist/cli.mjs"),
      "scripts/backfill-chat-transcripts.ts",
      ...args,
    ], {
      cwd: repositoryRoot,
      env: { ...process.env, DATABASE_URL: connectionString },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 30_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (!stdout.trim()) return reject(new Error(stderr || "backfill produced no report"));
      try {
        resolve({ code, report: (JSON.parse(stdout) as { report: BackfillReport }).report });
      } catch {
        reject(new Error(`${stderr}\n${stdout}`));
      }
    });
  });
}

describe("chat transcript storage migration", () => {
  it("backfills safely, prefers generation events, and is repeatable", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-chat-transcript-storage-"));
    const port = await availablePort();
    const { instance } = await createLocalPostgresInstance({
      databaseDir: path.join(tempRoot, "postgres"),
      user: "rudder",
      password: "rudder",
      port,
      persistent: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
      onLog: () => {},
      onError: () => {},
    });
    let sql: postgres.Sql | null = null;
    try {
      await instance.initialise();
      await instance.start();
      const adminUrl = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
      await ensurePostgresDatabase(adminUrl, "rudder");
      const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
      await applyPendingMigrations(connectionString);
      sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      const db = sql;

      const orgId = randomUUID();
    const conversationId = randomUUID();
    await db`
      INSERT INTO organizations (id, url_key, name, issue_prefix)
      VALUES (${orgId}, ${`transcript-${orgId}`}, 'Transcript migration', ${`T${orgId.replaceAll("-", "").slice(0, 8)}`})
    `;
    await db`
      INSERT INTO chat_conversations (id, org_id, title)
      VALUES (${conversationId}, ${orgId}, 'Transcript migration')
    `;
    const makeMessage = async (
      targetConversationId: string,
      role: string,
      body: string,
      payload: JsonValue,
      createdAt?: Date,
    ) => {
      const id = randomUUID();
      await db`
        INSERT INTO chat_messages (id, org_id, conversation_id, role, kind, status, body, structured_payload)
        VALUES (${id}, ${orgId}, ${targetConversationId}, ${role}, 'message', 'completed', ${body}, ${db.json(payload)})
      `;
      if (createdAt) {
        await db`UPDATE chat_messages SET created_at = ${createdAt}, updated_at = ${createdAt} WHERE id = ${id}`;
      }
      return id;
    };
    await makeMessage(conversationId, "user", "user", { __chatTranscript: [{ kind: "stdout", ts: "2026-08-08T00:00:01.000Z", text: "one" }] });
    await makeMessage(conversationId, "user", "user", { __chatTranscript: [{ kind: "stdout", ts: "2026-08-08T00:00:02.000Z", text: "two" }] });
    await makeMessage(conversationId, "user", "user", { __chatTranscript: "malformed" });
    const assistantMessageId = await makeMessage(conversationId, "assistant", "assistant", {
      __chatTranscript: [{ kind: "thinking", ts: "2026-08-08T00:00:03.000Z", text: "legacy" }],
    });
    const generationId = randomUUID();
    const generationAt = new Date("2026-08-08T00:00:00.000Z");
    await db`
      INSERT INTO chat_generations (id, org_id, conversation_id, status, started_at, created_at, updated_at)
      VALUES (${generationId}, ${orgId}, ${conversationId}, 'completed', ${generationAt}, ${generationAt}, ${generationAt})
    `;
    await db`
      INSERT INTO chat_generation_events (org_id, generation_id, generation_seq, attempt_epoch, event_kind, payload, assistant_message_id)
      VALUES (${orgId}, ${generationId}, 1, 1, 'transcript', ${db.json({ entry: { kind: "thinking", ts: "2026-08-08T00:00:04.000Z", text: "ledger" } })}, ${assistantMessageId})
    `;

    const forkSourceConversationId = randomUUID();
    const forkTargetConversationId = randomUUID();
    const forkUserCreatedAt = new Date("2026-08-08T00:01:00.000Z");
    const forkAssistantCreatedAt = new Date("2026-08-08T00:01:01.000Z");
    const forkBoundaryCreatedAt = new Date("2026-08-08T00:01:02.000Z");
    await db`
      INSERT INTO chat_conversations (id, org_id, title)
      VALUES (${forkSourceConversationId}, ${orgId}, 'Old fork source'), (${forkTargetConversationId}, ${orgId}, 'Old fork target')
    `;
    await makeMessage(
      forkSourceConversationId,
      "user",
      "fork user",
      { __chatTranscript: [{ kind: "stdout", ts: "2026-08-08T00:01:00.100Z", text: "fork user transcript" }] },
      forkUserCreatedAt,
    );
    const forkSourceAssistantId = await makeMessage(
      forkSourceConversationId,
      "assistant",
      "fork assistant",
      { __chatTranscript: [{ kind: "thinking", ts: "2026-08-08T00:01:01.100Z", text: "fork assistant transcript" }] },
      forkAssistantCreatedAt,
    );
    await db`
      UPDATE chat_conversations
      SET forked_from_conversation_id = ${forkSourceConversationId},
          forked_from_message_id = ${forkSourceAssistantId}
      WHERE id = ${forkTargetConversationId}
    `;
    await makeMessage(forkTargetConversationId, "user", "fork user", null, forkUserCreatedAt);
    await makeMessage(forkTargetConversationId, "assistant", "fork assistant", null, forkAssistantCreatedAt);
    await db`
      INSERT INTO chat_messages (id, org_id, conversation_id, role, kind, status, body, structured_payload, created_at, updated_at)
      VALUES (${randomUUID()}, ${orgId}, ${forkTargetConversationId}, 'system', 'system_event', 'completed', 'fork event', ${db.json({ eventType: "chat_fork" })}, ${forkBoundaryCreatedAt}, ${forkBoundaryCreatedAt})
    `;

    const dryRun = await runBackfill(connectionString, ["--dry-run", "--batch-size", "1"]);
    expect(dryRun.code).toBe(2);
    expect(dryRun.report).toMatchObject({ legacyCandidates: 6, legacyEligible: 5, legacyMigrated: 0, forksChecked: 1, forksEligible: 2 });
    expect(dryRun.report.legacySkipped).toHaveLength(1);

    const firstRun = await runBackfill(connectionString, ["--batch-size", "1"]);
    expect(firstRun.code).toBe(2);
    expect(firstRun.report).toMatchObject({ legacyCandidates: 6, legacyEligible: 5, legacyMigrated: 5, forksChecked: 1, forksRepaired: 1 });

    const secondRun = await runBackfill(connectionString, ["--batch-size", "1"]);
    expect(secondRun.code).toBe(2);
    expect(secondRun.report).toMatchObject({ legacyCandidates: 1, legacyMigrated: 0, forksChecked: 1, forksRepaired: 0 });

    const remaining = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM chat_messages WHERE structured_payload ? '__chatTranscript'`;
    const entries = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM chat_message_transcript_entries`;
    const assistantEntries = await db<{ count: number }[]>`
      SELECT count(*)::int AS count FROM chat_message_transcript_entries WHERE message_id = ${assistantMessageId}
    `;
    expect(Number(remaining[0]?.count)).toBe(1);
    expect(Number(entries[0]?.count)).toBe(6);
    expect(Number(assistantEntries[0]?.count)).toBe(0);
    const forkEntries = await db<{ text: string }[]>`
      SELECT payload->>'text' AS text
      FROM chat_message_transcript_entries
      WHERE message_id = (
        SELECT id FROM chat_messages
        WHERE conversation_id = ${forkTargetConversationId} AND role = 'assistant'
      )
      ORDER BY entry_seq
    `;
      expect(forkEntries).toEqual([{ text: "fork assistant transcript" }]);
    } finally {
      await sql?.end();
      await instance.stop().catch(() => undefined);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
