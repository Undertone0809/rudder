import { createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  applyPendingMigrations,
  organizations,
  organizationSecrets,
  organizationSecretVersions,
  createDb,
  ensurePostgresDatabase,
  heartbeatRuns,
  issues,
  projects,
  automationRuns,
  automations,
  automationTriggers,
  chatContextLinks,
  chatConversations,
  chatMessages,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { issueService } from "../services/issues.ts";
import { automationService } from "../services/automations.ts";
import { publishAutomationRunOutputToChat } from "../services/automation-chat-output.ts";

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
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function startTempDatabase() {
  const externalConnectionString = process.env.RUDDER_AUTOMATIONS_SERVICE_TEST_DATABASE_URL?.trim();
  if (externalConnectionString) {
    const parsed = new URL(externalConnectionString);
    const dbName = parsed.pathname.replace(/^\//, "");
    parsed.pathname = "/postgres";
    await ensurePostgresDatabase(parsed.toString(), dbName);
    await applyPendingMigrations(externalConnectionString);
    return { connectionString: externalConnectionString, dataDir: "", instance: null };
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-automations-service-"));
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

describe("automation service live-execution coalescing", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(automationRuns);
    await db.delete(automationTriggers);
    await db.delete(automations);
    await db.delete(chatContextLinks);
    await db.delete(chatMessages);
    await db.delete(chatConversations);
    await db.delete(organizationSecretVersions);
    await db.delete(organizationSecrets);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  async function seedFixture(opts?: {
    wakeup?: (
      agentId: string,
      wakeupOpts: {
        source?: string;
        triggerDetail?: string;
        reason?: string | null;
        payload?: Record<string, unknown> | null;
        requestedByActorType?: "user" | "agent" | "system";
        requestedByActorId?: string | null;
        contextSnapshot?: Record<string, unknown>;
      },
    ) => Promise<unknown>;
  }) {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const issuePrefix = `T${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const wakeups: Array<{
      agentId: string;
      opts: {
        source?: string;
        triggerDetail?: string;
        reason?: string | null;
        payload?: Record<string, unknown> | null;
        requestedByActorType?: "user" | "agent" | "system";
        requestedByActorId?: string | null;
        contextSnapshot?: Record<string, unknown>;
      };
    }> = [];

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      orgId,
      name: "Automations",
      status: "in_progress",
    });

    const svc = automationService(db, {
      heartbeat: {
        wakeup: async (wakeupAgentId, wakeupOpts) => {
          wakeups.push({ agentId: wakeupAgentId, opts: wakeupOpts });
          if (opts?.wakeup) return opts.wakeup(wakeupAgentId, wakeupOpts);
          const issueId =
            (typeof wakeupOpts.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
            (typeof wakeupOpts.contextSnapshot?.issueId === "string" && wakeupOpts.contextSnapshot.issueId) ||
            null;
          if (!issueId) return null;
          const queuedRunId = randomUUID();
          await db.insert(heartbeatRuns).values({
            id: queuedRunId,
            orgId,
            agentId: wakeupAgentId,
            invocationSource: wakeupOpts.source ?? "assignment",
            triggerDetail: wakeupOpts.triggerDetail ?? null,
            status: "queued",
            contextSnapshot: { ...(wakeupOpts.contextSnapshot ?? {}), issueId },
          });
          await db
            .update(issues)
            .set({
              executionRunId: queuedRunId,
              executionLockedAt: new Date(),
            })
            .where(eq(issues.id, issueId));
          return { id: queuedRunId };
        },
      },
    });
    const issueSvc = issueService(db);
    const automation = await svc.create(
      orgId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "ascii frog",
        description: "Run the frog automation",
        assigneeAgentId: agentId,
        outputMode: "track_issue",
        chatConversationId: null,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    return { orgId, agentId, issueSvc, projectId, automation, svc, wakeups };
  }

  it("creates a fresh execution issue when the previous automation issue is open but idle", async () => {
    const { orgId, issueSvc, automation, svc } = await seedFixture();
    const previousRunId = randomUUID();
    const previousIssue = await issueSvc.create(orgId, {
      projectId: automation.projectId,
      title: automation.title,
      description: automation.description,
      status: "todo",
      priority: automation.priority,
      assigneeAgentId: automation.assigneeAgentId,
      originKind: "automation_execution",
      originId: automation.id,
      originRunId: previousRunId,
    });

    await db.insert(automationRuns).values({
      id: previousRunId,
      orgId,
      automationId: automation.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
      completedAt: new Date("2026-03-20T12:00:00.000Z"),
    });

    const detailBefore = await svc.getDetail(automation.id);
    expect(detailBefore?.activeIssue).toBeNull();

    const run = await svc.runAutomation(automation.id, { source: "manual" });
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).not.toBe(previousIssue.id);

    const automationIssues = await db
      .select({
        id: issues.id,
        originRunId: issues.originRunId,
      })
      .from(issues)
      .where(eq(issues.originId, automation.id));

    expect(automationIssues).toHaveLength(2);
    expect(automationIssues.map((issue) => issue.id)).toContain(previousIssue.id);
    expect(automationIssues.map((issue) => issue.id)).toContain(run.linkedIssueId);
  });

  it("creates a fresh execution issue when the previous automation issue has a completed execution run", async () => {
    const { agentId, orgId, issueSvc, automation, svc } = await seedFixture();
    const previousRunId = randomUUID();
    const completedHeartbeatRunId = randomUUID();
    const previousIssue = await issueSvc.create(orgId, {
      projectId: automation.projectId,
      title: automation.title,
      description: automation.description,
      status: "todo",
      priority: automation.priority,
      assigneeAgentId: automation.assigneeAgentId,
      originKind: "automation_execution",
      originId: automation.id,
      originRunId: previousRunId,
    });

    await db.insert(automationRuns).values({
      id: previousRunId,
      orgId,
      automationId: automation.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
      completedAt: new Date("2026-03-20T12:00:00.000Z"),
    });

    await db.insert(heartbeatRuns).values({
      id: completedHeartbeatRunId,
      orgId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "completed",
      contextSnapshot: { issueId: previousIssue.id },
      startedAt: new Date("2026-03-20T12:01:00.000Z"),
      finishedAt: new Date("2026-03-20T12:05:00.000Z"),
    });

    await db
      .update(issues)
      .set({
        executionRunId: completedHeartbeatRunId,
        executionLockedAt: new Date("2026-03-20T12:01:00.000Z"),
      })
      .where(eq(issues.id, previousIssue.id));

    const run = await svc.runAutomation(automation.id, { source: "manual" });
    expect(run.status).toBe("issue_created");
    expect(run.failureReason).toBeNull();
    expect(run.linkedIssueId).toBeTruthy();
    expect(run.linkedIssueId).not.toBe(previousIssue.id);

    const automationIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, automation.id));

    expect(automationIssues).toHaveLength(2);
    expect(automationIssues.map((issue) => issue.id)).toContain(previousIssue.id);
    expect(automationIssues.map((issue) => issue.id)).toContain(run.linkedIssueId);
  });

  it("wakes the assignee when an automation creates a fresh execution issue", async () => {
    const { agentId, automation, svc, wakeups } = await seedFixture();

    const run = await svc.runAutomation(automation.id, { source: "manual" });

    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();
    expect(wakeups).toEqual([
      {
        agentId,
        opts: {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: { issueId: run.linkedIssueId, mutation: "create" },
          requestedByActorType: undefined,
          requestedByActorId: null,
          contextSnapshot: expect.objectContaining({
            issueId: run.linkedIssueId,
            source: "automation.dispatch",
            wakeSource: "assignment",
            wakeReason: "issue_assigned",
            issue: expect.objectContaining({
              id: run.linkedIssueId,
            }),
          }),
        },
      },
    ]);
  });

  it("rejects arbitrary existing chat output destinations", async () => {
    const { agentId, orgId, projectId, svc } = await seedFixture();
    const [chat] = await db
      .insert(chatConversations)
      .values({
        orgId,
        title: "Daily standup",
        preferredAgentId: agentId,
        status: "active",
        issueCreationMode: "manual_approval",
        planMode: false,
      })
      .returning();
    expect(chat).toBeTruthy();

    await expect(
      svc.create(
        orgId,
        {
          projectId,
          goalId: null,
          parentIssueId: null,
          title: "Daily standup",
          description: "Summarize active work.",
          assigneeAgentId: agentId,
          outputMode: "chat_output",
          chatConversationId: chat!.id,
          priority: "medium",
          status: "active",
          concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed",
        },
        {},
      ),
    ).rejects.toThrow("Chat output creates an automation-owned conversation");
  });

  it("posts chat output final results while preserving issue-backed execution", async () => {
    const { agentId, orgId, projectId, svc } = await seedFixture();
    const automation = await svc.create(
      orgId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "Daily standup",
        description: "Summarize active work.",
        assigneeAgentId: agentId,
        outputMode: "chat_output",
        chatConversationId: null,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    const run = await svc.runAutomation(automation.id, { source: "manual" });

    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();
    expect(run.linkedChatConversationId).toBeTruthy();
    expect(run.startedChatMessageId).toBeTruthy();
    expect(run.lastChatMessageId).toBe(run.startedChatMessageId);

    const startedMessage = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, run.startedChatMessageId!))
      .then((rows) => rows[0] ?? null);
    expect(startedMessage?.kind).toBe("system_event");
    expect(startedMessage?.body).toBe("From automation Daily standup.");
    expect(startedMessage?.structuredPayload).toMatchObject({
      eventType: "automation_source",
      automationId: automation.id,
      runId: run.id,
      issueId: run.linkedIssueId,
      status: "issue_created",
    });

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, run.linkedIssueId!));
    const completed = await svc.syncRunStatusForIssue(run.linkedIssueId!);

    expect(completed?.status).toBe("completed");
    expect(completed?.terminalChatMessageId).toBeNull();
    const outputMessage = await publishAutomationRunOutputToChat(db, {
      issueId: run.linkedIssueId,
      output: "Final daily standup summary.",
      status: "succeeded",
      transcript: [{ type: "message", message: "Checked active work" } as any],
    });
    expect(outputMessage?.role).toBe("assistant");
    expect(outputMessage?.kind).toBe("message");
    expect(outputMessage?.body).toBe("Final daily standup summary.");
    const withOutput = await db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.id, run.id))
      .then((rows) => rows[0] ?? null);
    expect(withOutput?.terminalChatMessageId).toBe(outputMessage?.id);
    expect(withOutput?.lastChatMessageId).toBe(outputMessage?.id);
    const terminalMessage = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, outputMessage!.id))
      .then((rows) => rows[0] ?? null);
    expect(terminalMessage?.structuredPayload).toMatchObject({
      eventType: "automation_run_result",
      automationId: automation.id,
      runId: run.id,
      issueId: run.linkedIssueId,
      status: "succeeded",
    });
    expect((terminalMessage?.structuredPayload as Record<string, unknown>).__chatTranscript).toHaveLength(1);
    const duplicateOutputMessage = await publishAutomationRunOutputToChat(db, {
      issueId: run.linkedIssueId,
      output: "Duplicate result should not post.",
      status: "succeeded",
      transcript: [],
    });
    expect(duplicateOutputMessage?.id).toBe(outputMessage?.id);
    const resultMessages = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, outputMessage!.conversationId));
    expect(resultMessages.filter((message) =>
      (message.structuredPayload as Record<string, unknown> | null)?.eventType === "automation_run_result" &&
      (message.structuredPayload as Record<string, unknown> | null)?.runId === run.id,
    )).toHaveLength(1);
  });

  it("creates a separate chat output destination for each execution run", async () => {
    const { agentId, orgId, projectId, svc } = await seedFixture();
    const automation = await svc.create(
      orgId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "Daily digest",
        description: "Post a fresh digest.",
        assigneeAgentId: agentId,
        outputMode: "chat_output",
        chatConversationId: null,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    const run = await svc.runAutomation(automation.id, { source: "manual" });

    expect(run.status).toBe("issue_created");
    expect(run.linkedChatConversationId).toBeTruthy();
    expect(run.startedChatMessageId).toBeTruthy();
    const updatedAutomation = await db
      .select({ chatConversationId: automations.chatConversationId })
      .from(automations)
      .where(eq(automations.id, automation.id))
      .then((rows) => rows[0] ?? null);
    expect(updatedAutomation?.chatConversationId).toBeNull();

    const createdChat = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.id, run.linkedChatConversationId!))
      .then((rows) => rows[0] ?? null);
    expect(createdChat).toMatchObject({
      orgId,
      title: "Daily digest",
      preferredAgentId: agentId,
      status: "active",
    });
    const projectContext = await db
      .select()
      .from(chatContextLinks)
      .where(eq(chatContextLinks.conversationId, run.linkedChatConversationId!))
      .then((rows) => rows[0] ?? null);
    expect(projectContext).toMatchObject({
      orgId,
      entityType: "project",
      entityId: projectId,
    });

    const startedMessage = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, run.startedChatMessageId!))
      .then((rows) => rows[0] ?? null);
    expect(startedMessage?.conversationId).toBe(run.linkedChatConversationId);

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, run.linkedIssueId!));
    const completed = await svc.syncRunStatusForIssue(run.linkedIssueId!);

    expect(completed?.linkedChatConversationId).toBe(run.linkedChatConversationId);
    expect(completed?.terminalChatMessageId).toBeNull();
    const outputMessage = await publishAutomationRunOutputToChat(db, {
      issueId: run.linkedIssueId,
      output: "Fresh digest result.",
      status: "succeeded",
      transcript: [],
    });
    expect(outputMessage?.conversationId).toBe(run.linkedChatConversationId);
    const terminalMessage = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, outputMessage!.id))
      .then((rows) => rows[0] ?? null);
    expect(terminalMessage?.conversationId).toBe(run.linkedChatConversationId);

    const secondRun = await svc.runAutomation(automation.id, { source: "manual" });

    expect(secondRun.status).toBe("issue_created");
    expect(secondRun.linkedChatConversationId).toBeTruthy();
    expect(secondRun.linkedChatConversationId).not.toBe(run.linkedChatConversationId);

    const chats = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.orgId, orgId));
    expect(chats).toHaveLength(2);
  });

  it("does not create an empty new chat for coalesced chat-output runs", async () => {
    const { agentId, orgId, projectId, svc } = await seedFixture();
    const automation = await svc.create(
      orgId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "Say hello",
        description: "Say hello to me.",
        assigneeAgentId: agentId,
        outputMode: "chat_output",
        chatConversationId: null,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    const firstRun = await svc.runAutomation(automation.id, { source: "manual" });
    const secondRun = await svc.runAutomation(automation.id, { source: "manual" });

    expect(firstRun.status).toBe("issue_created");
    expect(firstRun.linkedChatConversationId).toBeTruthy();
    expect(secondRun.status).toBe("coalesced");
    expect(secondRun.linkedChatConversationId).toBeNull();

    const chats = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.orgId, orgId));
    expect(chats).toHaveLength(1);
    const messages = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.orgId, orgId));
    expect(messages.map((message) => message.body)).not.toContain(
      "Say hello coalesced into an active automation run.",
    );
  });

  it("does not create an empty new chat for skipped chat-output runs", async () => {
    const { agentId, orgId, projectId, svc } = await seedFixture();
    const automation = await svc.create(
      orgId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "Say hello",
        description: "Say hello to me.",
        assigneeAgentId: agentId,
        outputMode: "chat_output",
        chatConversationId: null,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "skip_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    const firstRun = await svc.runAutomation(automation.id, { source: "manual" });
    const secondRun = await svc.runAutomation(automation.id, { source: "manual" });

    expect(firstRun.status).toBe("issue_created");
    expect(firstRun.linkedChatConversationId).toBeTruthy();
    expect(secondRun.status).toBe("skipped");
    expect(secondRun.linkedChatConversationId).toBeNull();

    const chats = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.orgId, orgId));
    expect(chats).toHaveLength(1);
    const messages = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.orgId, orgId));
    expect(messages.map((message) => message.body)).not.toContain(
      "Say hello skipped because an active automation run already exists.",
    );
  });

  it("rejects chat output destination updates to arbitrary existing chats", async () => {
    const { agentId, orgId, projectId, svc } = await seedFixture();
    const automation = await svc.create(
      orgId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "Digest",
        description: "Post a digest.",
        assigneeAgentId: agentId,
        outputMode: "chat_output",
        chatConversationId: null,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );
    const [chat] = await db
      .insert(chatConversations)
      .values({
        orgId,
        title: "Unrelated digest",
        preferredAgentId: agentId,
        status: "active",
        issueCreationMode: "manual_approval",
        planMode: false,
      })
      .returning();

    await expect(
      svc.update(
        automation.id,
        {
          outputMode: "chat_output",
          chatConversationId: chat!.id,
        },
        {},
      ),
    ).rejects.toThrow("Chat output creates an automation-owned conversation");
  });

  it("creates and runs automations without a project", async () => {
    const { agentId, orgId, svc } = await seedFixture();
    const automation = await svc.create(
      orgId,
      {
        projectId: null,
        goalId: null,
        parentIssueId: null,
        title: "Inbox sweep",
        description: "Review projectless intake.",
        assigneeAgentId: agentId,
        outputMode: "track_issue",
        chatConversationId: null,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    expect(automation.projectId).toBeNull();

    const run = await svc.runAutomation(automation.id, { source: "manual" });
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();

    const linkedIssue = await db
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);
    expect(linkedIssue?.projectId).toBeNull();
  });

  it("hard-deletes automations and cascades triggers, runs, and webhook secrets", async () => {
    const { automation, svc } = await seedFixture();
    const triggerResult = await svc.createTrigger(
      automation.id,
      {
        kind: "webhook",
        label: "incoming",
        enabled: true,
        signingMode: "bearer",
        replayWindowSec: 300,
      },
      {},
    );
    expect(triggerResult.trigger.secretId).toBeTruthy();

    const run = await svc.runAutomation(automation.id, { source: "manual" });
    expect(run.id).toBeTruthy();

    const deleted = await svc.delete(automation.id);
    expect(deleted?.id).toBe(automation.id);

    await expect(db.select().from(automations).where(eq(automations.id, automation.id))).resolves.toHaveLength(0);
    await expect(db.select().from(automationTriggers).where(eq(automationTriggers.automationId, automation.id))).resolves.toHaveLength(0);
    await expect(db.select().from(automationRuns).where(eq(automationRuns.automationId, automation.id))).resolves.toHaveLength(0);
    await expect(db.select().from(organizationSecrets).where(eq(organizationSecrets.id, triggerResult.trigger.secretId!))).resolves.toHaveLength(0);
    await expect(db.select().from(organizationSecretVersions).where(eq(organizationSecretVersions.secretId, triggerResult.trigger.secretId!))).resolves.toHaveLength(0);
    await expect(svc.getDetail(automation.id)).resolves.toBeNull();
  });

  it("waits for the assignee wakeup to be queued before returning the automation run", async () => {
    let wakeupResolved = false;
    const { automation, svc } = await seedFixture({
      wakeup: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        wakeupResolved = true;
        return null;
      },
    });

    const run = await svc.runAutomation(automation.id, { source: "manual" });

    expect(run.status).toBe("issue_created");
    expect(wakeupResolved).toBe(true);
  });

  it("coalesces only when the existing automation issue has a live execution run", async () => {
    const { agentId, orgId, issueSvc, automation, svc } = await seedFixture();
    const previousRunId = randomUUID();
    const liveHeartbeatRunId = randomUUID();
    const previousIssue = await issueSvc.create(orgId, {
      projectId: automation.projectId,
      title: automation.title,
      description: automation.description,
      status: "in_progress",
      priority: automation.priority,
      assigneeAgentId: automation.assigneeAgentId,
      originKind: "automation_execution",
      originId: automation.id,
      originRunId: previousRunId,
    });

    await db.insert(automationRuns).values({
      id: previousRunId,
      orgId,
      automationId: automation.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
    });

    await db.insert(heartbeatRuns).values({
      id: liveHeartbeatRunId,
      orgId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: previousIssue.id },
      startedAt: new Date("2026-03-20T12:01:00.000Z"),
    });

    await db
      .update(issues)
      .set({
        checkoutRunId: liveHeartbeatRunId,
        executionRunId: liveHeartbeatRunId,
        executionLockedAt: new Date("2026-03-20T12:01:00.000Z"),
      })
      .where(eq(issues.id, previousIssue.id));

    const detailBefore = await svc.getDetail(automation.id);
    expect(detailBefore?.activeIssue?.id).toBe(previousIssue.id);

    const run = await svc.runAutomation(automation.id, { source: "manual" });
    expect(run.status).toBe("coalesced");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    expect(run.coalescedIntoRunId).toBe(previousRunId);

    const automationIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, automation.id));

    expect(automationIssues).toHaveLength(1);
    expect(automationIssues[0]?.id).toBe(previousIssue.id);
  });

  it("creates distinct execution issues for always-enqueue dispatches", async () => {
    const { automation, svc } = await seedFixture();
    await svc.update(automation.id, { concurrencyPolicy: "always_enqueue" }, {});

    const first = await svc.runAutomation(automation.id, { source: "manual" });
    const second = await svc.runAutomation(automation.id, { source: "manual" });

    expect(first.status).toBe("issue_created");
    expect(second.status).toBe("issue_created");
    expect(first.failureReason).toBeNull();
    expect(second.failureReason).toBeNull();
    expect(first.linkedIssueId).toBeTruthy();
    expect(second.linkedIssueId).toBeTruthy();
    expect(first.linkedIssueId).not.toBe(second.linkedIssueId);

    const automationIssues = await db
      .select({ id: issues.id, originRunId: issues.originRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.originId, automation.id));

    expect(automationIssues).toHaveLength(2);
    expect(automationIssues.map((issue) => issue.originRunId).sort()).toEqual([first.id, second.id].sort());
    expect(automationIssues.every((issue) => Boolean(issue.executionRunId))).toBe(true);
  });

  it("serializes concurrent dispatches until the first execution issue is linked to a queued run", async () => {
    const { automation, svc } = await seedFixture({
      wakeup: async (wakeupAgentId, wakeupOpts) => {
        const issueId =
          (typeof wakeupOpts.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
          (typeof wakeupOpts.contextSnapshot?.issueId === "string" && wakeupOpts.contextSnapshot.issueId) ||
          null;
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (!issueId) return null;
        const queuedRunId = randomUUID();
        await db.insert(heartbeatRuns).values({
          id: queuedRunId,
          orgId: automation.orgId,
          agentId: wakeupAgentId,
          invocationSource: wakeupOpts.source ?? "assignment",
          triggerDetail: wakeupOpts.triggerDetail ?? null,
          status: "queued",
          contextSnapshot: { ...(wakeupOpts.contextSnapshot ?? {}), issueId },
        });
        await db
          .update(issues)
          .set({
            executionRunId: queuedRunId,
            executionLockedAt: new Date(),
          })
          .where(eq(issues.id, issueId));
        return { id: queuedRunId };
      },
    });

    const [first, second] = await Promise.all([
      svc.runAutomation(automation.id, { source: "manual" }),
      svc.runAutomation(automation.id, { source: "manual" }),
    ]);

    expect([first.status, second.status].sort()).toEqual(["coalesced", "issue_created"]);
    expect(first.linkedIssueId).toBeTruthy();
    expect(second.linkedIssueId).toBeTruthy();
    expect(first.linkedIssueId).toBe(second.linkedIssueId);

    const automationIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, automation.id));

    expect(automationIssues).toHaveLength(1);
  });

  it("fails the run and cleans up the execution issue when wakeup queueing fails", async () => {
    const { automation, svc } = await seedFixture({
      wakeup: async () => {
        throw new Error("queue unavailable");
      },
    });

    const run = await svc.runAutomation(automation.id, { source: "manual" });

    expect(run.status).toBe("failed");
    expect(run.failureReason).toContain("queue unavailable");
    expect(run.linkedIssueId).toBeNull();

    const automationIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, automation.id));

    expect(automationIssues).toHaveLength(0);
  });

  it("accepts standard second-precision webhook timestamps for HMAC triggers", async () => {
    const { automation, svc } = await seedFixture();
    const { trigger, secretMaterial } = await svc.createTrigger(
      automation.id,
      {
        kind: "webhook",
        signingMode: "hmac_sha256",
        replayWindowSec: 300,
      },
      {},
    );

    expect(trigger.publicId).toBeTruthy();
    expect(secretMaterial?.webhookSecret).toBeTruthy();

    const payload = { ok: true };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const timestampSeconds = String(Math.floor(Date.now() / 1000));
    const signature = `sha256=${createHmac("sha256", secretMaterial!.webhookSecret)
      .update(`${timestampSeconds}.`)
      .update(rawBody)
      .digest("hex")}`;

    const run = await svc.firePublicTrigger(trigger.publicId!, {
      signatureHeader: signature,
      timestampHeader: timestampSeconds,
      rawBody,
      payload,
    });

    expect(run.source).toBe("webhook");
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();
  });
});
