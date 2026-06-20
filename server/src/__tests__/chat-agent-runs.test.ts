import {
  agents,
  applyPendingMigrations,
  chatConversations,
  chatMessages,
  createDb,
  ensurePostgresDatabase,
  heartbeatRunEvents,
  heartbeatRuns,
  organizations,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chatAgentRunService } from "../services/chat-agent-runs.ts";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function startTempDatabase() {
  const externalConnectionString = process.env.RUDDER_CHAT_AGENT_RUNS_TEST_DATABASE_URL?.trim();
  if (externalConnectionString) {
    await applyPendingMigrations(externalConnectionString);
    return { connectionString: externalConnectionString, dataDir: "", instance: null };
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-chat-agent-runs-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
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

  const adminConnectionString = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "rudder");
  const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

describe("chatAgentRunService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof chatAgentRunService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    svc = chatAgentRunService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(chatMessages);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(chatConversations);
    await db.delete(agents);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("creates one active run per conversation, finalizes stale runs, and links assistant messages", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const messageId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix: "RDR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Chat Runner",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Run-backed chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });

    const conversation = {
      id: conversationId,
      orgId,
      primaryIssueId: null,
      planMode: false,
    };

    const firstRun = await svc.createRun({
      conversation,
      agentId,
      triggerDetail: "chat_assistant_reply",
      userMessageId: messageId,
      linkedIssueIds: [],
      linkedProjectId: null,
    });

    expect(firstRun.status).toBe("running");
    expect(firstRun.invocationSource).toBe("chat");
    expect(firstRun.contextSnapshot).toMatchObject({
      scene: "chat",
      targetType: "chat_conversation",
      targetId: conversationId,
      conversationId,
      messageId,
      userMessageId: messageId,
    });
    await expect(svc.createRun({
      conversation,
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
    })).rejects.toThrow("already active");

    await expect(svc.finalizeStaleRuns({
      conversationId,
      olderThanMs: 0,
      error: "test stale chat run",
      errorCode: "test_chat_run_stale",
    })).resolves.toBe(1);

    const [timedOutRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, firstRun.id));
    expect(timedOutRun?.status).toBe("timed_out");
    expect(timedOutRun?.errorCode).toBe("test_chat_run_stale");

    const secondRun = await svc.createRun({
      conversation,
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
    });

    await expect(svc.linkAssistantMessage(secondRun.id, conversationId, randomUUID())).resolves.toBeNull();
    const eventsBeforeLink = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, secondRun.id));
    expect(eventsBeforeLink.some((event) => event.eventType === "chat.message_linked")).toBe(false);

    await db.insert(chatMessages).values({
      id: messageId,
      orgId,
      conversationId,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Done.",
      replyingAgentId: agentId,
    });

    await svc.linkAssistantMessage(secondRun.id, conversationId, messageId);

    const [message] = await db.select().from(chatMessages).where(eq(chatMessages.id, messageId));
    expect(message?.runId).toBe(secondRun.id);

    const [linkedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, secondRun.id));
    expect(linkedRun?.chatConversationId).toBe(conversationId);
    expect(linkedRun?.contextSnapshot).toMatchObject({ assistantMessageId: messageId, messageId });

    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, secondRun.id));
    expect(events.some((event) => event.eventType === "chat.message_linked")).toBe(true);
  });

  it("stores automation run target metadata on chat-backed agent runs", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const userMessageId = randomUUID();
    const automationRunId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix: "RDR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Chat Runner",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Automation chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });

    const run = await svc.createRun({
      conversation: {
        id: conversationId,
        orgId,
        primaryIssueId: null,
        planMode: false,
      },
      agentId,
      triggerDetail: "chat_assistant_reply_stream",
      userMessageId,
      linkedIssueIds: [],
      linkedProjectId: null,
      runContext: {
        targetType: "automation_run",
        targetId: automationRunId,
        automationRunId,
      },
    });

    expect(run.contextSnapshot).toMatchObject({
      scene: "chat",
      targetType: "automation_run",
      targetId: automationRunId,
      automationRunId,
      conversationId,
      messageId: userMessageId,
      userMessageId,
    });
  });
});
