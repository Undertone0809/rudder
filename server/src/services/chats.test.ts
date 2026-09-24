import {
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  applyPendingMigrations,
  chatConversations,
  chatMessageTranscriptEntries,
  chatMessages,
  createDb,
  ensurePostgresDatabase,
  goals,
  heartbeatRunAttempts,
  heartbeatRunEvents,
  heartbeatRuns,
  nativeSegments,
  organizationSkills,
  organizations,
  runRuntimeSpans,
  runtimeBindings,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey, type ChatStreamTranscriptEntry } from "@rudderhq/shared";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chatAgentRunService } from "./chat-agent-runs.js";
import { chatService } from "./chats.js";
import { currentNativeSession, ensureRuntimeBinding } from "./runtime-kernel/native-session.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (options: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

async function getAvailablePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function startTempDatabase() {
  const externalUrl = process.env.RUDDER_CHATS_TEST_DATABASE_URL?.trim();
  if (externalUrl) {
    await applyPendingMigrations(externalUrl);
    return { connectionString: externalUrl, dataDir: "", instance: null };
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-chats-transcript-"));
  const port = await getAvailablePort();
  const mod = await import("embedded-postgres");
  const EmbeddedPostgres = mod.default as EmbeddedPostgresCtor;
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
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
  const adminUrl = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminUrl, "rudder");
  const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

describe("chatService transcript persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let chats!: ReturnType<typeof chatService>;
  let runs!: ReturnType<typeof chatAgentRunService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    chats = chatService(db);
    runs = chatAgentRunService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 60_000);

  afterEach(async () => {
    await db.delete(chatMessageTranscriptEntries);
    await db.delete(chatMessages);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRunAttempts);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(runRuntimeSpans);
    await db.delete(nativeSegments);
    await db.delete(runtimeBindings);
    await db.delete(chatConversations);
    await db.delete(goals);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(organizationSkills);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("reads Run ledger entries for linked messages and retains legacy snapshots without run IDs", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const label = `Chat transcript ${randomUUID()}`;
    await db.insert(organizations).values({
      id: orgId,
      name: label,
      urlKey: deriveOrganizationUrlKey(label),
      issuePrefix: "SUB",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: `${label} agent`,
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: `${label} conversation`,
      issueCreationMode: "manual_approval",
      planMode: false,
    });

    const runtimeBinding = await ensureRuntimeBinding(db, {
      orgId,
      conversationId,
      principalScopeRef: "user:operator",
      agentId,
      runtimeType: "codex_local",
    });
    const nativeSession = await currentNativeSession(db, runtimeBinding);
    const run = await runs.createRun({
      conversation: { id: conversationId, orgId, primaryIssueId: null, planMode: false },
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      runtimeBinding,
      runtimeSegment: nativeSession.segment,
      nativeSessionId: nativeSession.sessionId,
      nativeSessionParams: nativeSession.sessionParams,
      inputCorrelationRef: randomUUID(),
    });
    const runEntry: ChatStreamTranscriptEntry = {
      kind: "assistant",
      ts: "2026-09-24T00:00:00.000Z",
      text: "Recovered from the legacy Run ledger",
    };
    expect(await runs.markLegacyTranscriptSource(run)).toBe(true);
    await runs.appendTranscriptEntry(run, runEntry, { spanId: run.runtimeSpanId });

    const runMessage = await chats.addMessage(conversationId, {
      orgId,
      role: "assistant",
      kind: "message",
      body: "Run-backed answer",
      runId: run.id,
      transcript: [runEntry],
    });
    expect(runMessage.transcript).toEqual([expect.objectContaining(runEntry)]);
    expect(await db.select().from(chatMessageTranscriptEntries)
      .where(eq(chatMessageTranscriptEntries.messageId, runMessage.id))).toEqual([]);

    await db.insert(chatMessageTranscriptEntries).values({
      orgId,
      messageId: runMessage.id,
      entrySeq: 0,
      payload: { kind: "assistant", ts: runEntry.ts, text: "historical duplicate" },
    });
    await chats.updateMessageStructuredPayload(conversationId, runMessage.id, { note: "metadata only" });
    expect(await db.select().from(chatMessageTranscriptEntries)
      .where(eq(chatMessageTranscriptEntries.messageId, runMessage.id))).toHaveLength(1);

    const detachedEntry: ChatStreamTranscriptEntry = {
      kind: "assistant",
      ts: "2026-09-24T00:00:01.000Z",
      text: "Recovered from the legacy message snapshot",
    };
    const detachedMessage = await chats.addMessage(conversationId, {
      orgId,
      role: "assistant",
      kind: "message",
      body: "Historical message without a Run",
      transcript: [detachedEntry],
    });
    const visibleMessages = await chats.listMessages(conversationId);
    expect(visibleMessages.find((message) => message.id === runMessage.id)?.transcript)
      .toEqual([expect.objectContaining(runEntry)]);
    expect(visibleMessages.find((message) => message.id === detachedMessage.id)?.transcript)
      .toEqual([expect.objectContaining(detachedEntry)]);
    await expect(chats.getMessageTranscript(conversationId, runMessage.id)).resolves.toMatchObject({
      transcript: [expect.objectContaining(runEntry)],
    });
  });
});
