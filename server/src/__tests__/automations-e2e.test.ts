import {
  activityLog,
  agents,
  agentWakeupRequests,
  applyPendingMigrations,
  automationRuns,
  automations,
  automationTriggers,
  chatConversations,
  chatMessages,
  createDb,
  ensurePostgresDatabase,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issues,
  organizationMemberships,
  organizations,
  principalPermissionGrants,
  projects,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { asc, eq } from "drizzle-orm";
import express from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { accessService } from "../services/access.js";
import { issueService } from "../services/issues.js";

function mockServicesIndex() {
  vi.doMock("../services/index.js", async () => {
    const actual = await vi.importActual<typeof import("../services/index.js")>("../services/index.js");
    const { randomUUID } = await import("node:crypto");
    const { eq } = await import("drizzle-orm");
    const { heartbeatRuns, issues } = await import("@rudderhq/db");

    return {
      ...actual,
      automationService: (db: any) =>
        actual.automationService(db, {
          heartbeat: {
            wakeup: async (agentId: string, wakeupOpts: any) => {
              const issueId =
                (typeof wakeupOpts?.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
                (typeof wakeupOpts?.contextSnapshot?.issueId === "string" && wakeupOpts.contextSnapshot.issueId) ||
                null;
              if (!issueId) return null;

              const issue = await db
                .select({ orgId: issues.orgId })
                .from(issues)
                .where(eq(issues.id, issueId))
                .then((rows: Array<{ orgId: string }>) => rows[0] ?? null);
              if (!issue) return null;

              const queuedRunId = randomUUID();
              await db.insert(heartbeatRuns).values({
                id: queuedRunId,
                orgId: issue.orgId,
                agentId,
                invocationSource: wakeupOpts?.source ?? "assignment",
                triggerDetail: wakeupOpts?.triggerDetail ?? null,
                status: "queued",
                contextSnapshot: { ...(wakeupOpts?.contextSnapshot ?? {}), issueId },
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
          chatAssistant: {
            enrichConversation: async (conversation: any) => ({
              ...conversation,
              chatRuntime: {
                sourceType: "agent",
                sourceLabel: "Automation Agent",
                runtimeAgentId: conversation.preferredAgentId,
                agentRuntimeType: "codex_local",
                model: "test",
                available: true,
                error: null,
              },
            }),
            streamChatAssistantReply: async (input: any) => {
              await input.onTranscriptEntry?.({ type: "message", message: "Generated result" });
              await input.onAssistantDelta?.("Final result ");
              await input.onAssistantDelta?.("ready for follow-up.");
              return {
                outcome: "completed",
                reply: {
                  kind: "message",
                  body: "Final result ready for follow-up.",
                  structuredPayload: null,
                },
                partialBody: "Final result ready for follow-up.",
                replyingAgentId: input.conversation.preferredAgentId ?? null,
              };
            },
          },
        }),
    };
  });
}

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
  const externalConnectionString = process.env.RUDDER_AUTOMATIONS_E2E_TEST_DATABASE_URL?.trim();
  if (externalConnectionString) {
    const parsed = new URL(externalConnectionString);
    const dbName = parsed.pathname.replace(/^\//, "");
    parsed.pathname = "/postgres";
    await ensurePostgresDatabase(parsed.toString(), dbName);
    await applyPendingMigrations(externalConnectionString);
    return { connectionString: externalConnectionString, dataDir: "", instance: null };
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-automations-e2e-"));
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

async function waitFor<T>(
  fn: () => Promise<T | null | false | undefined>,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | null | false | undefined;
  while (Date.now() < deadline) {
    lastValue = await fn();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for condition; last value: ${JSON.stringify(lastValue)}`);
}

describe("automation routes end-to-end", { timeout: 20_000 }, () => {
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
    vi.doUnmock("../services/index.js");
    vi.resetModules();
    await db.delete(activityLog);
    await db.delete(automationRuns);
    await db.delete(automationTriggers);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(principalPermissionGrants);
    await db.delete(organizationMemberships);
    await db.delete(automations);
    await db.delete(chatMessages);
    await db.delete(chatConversations);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(organizations);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  async function createApp(actor: Record<string, unknown>) {
    vi.resetModules();
    mockServicesIndex();
    const { automationRoutes } = await import("../routes/automations.js");
    const { chatRoutes } = await import("../routes/chats.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", automationRoutes(db));
    app.use("/api", chatRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedFixture() {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const userId = randomUUID();
    const issuePrefix = `T${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    const orgName = `Rudder ${orgId.slice(0, 8)}`;
    await db.insert(organizations).values({
      id: orgId,
      name: orgName,
      urlKey: deriveOrganizationUrlKey(orgName),
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
      name: "Automation Project",
      status: "in_progress",
    });

    const access = accessService(db);
    const membership = await access.ensureMembership(orgId, "user", userId, "owner", "active");
    await access.setMemberPermissions(
      orgId,
      membership.id,
      [{ permissionKey: "tasks:assign" }],
      userId,
    );

    return { orgId, agentId, projectId, userId };
  }

  it("persists agent chat sends as direct operator-facing messages without a user prompt turn", async () => {
    const { orgId, agentId } = await seedFixture();
    const conversationId = randomUUID();
    const runId = randomUUID();
    const app = await createApp({
      type: "agent",
      agentId,
      orgId,
      runId,
    });

    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Agent direct handoff",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: null,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      orgId,
      agentId,
      invocationSource: "manual",
      status: "running",
    });

    const res = await request(app)
      .post(`/api/chats/${conversationId}/messages`)
      .send({ body: "I finished the requested work and need your review." });

    expect(res.status).toBe(201);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0]).toMatchObject({
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "I finished the requested work and need your review.",
      replyingAgentId: agentId,
    });

    const messages = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conversationId))
      .orderBy(asc(chatMessages.createdAt));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      kind: "message",
      body: "I finished the requested work and need your review.",
      replyingAgentId: agentId,
    });

    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, conversationId));
    expect(activities).toEqual([
      expect.objectContaining({
        orgId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        runId,
        action: "chat.message_added",
        entityType: "chat",
        entityId: conversationId,
      }),
    ]);
    expect(activities[0]?.details).toMatchObject({
      role: "assistant",
      kind: "message",
      replyingAgentId: agentId,
      source: "agent_direct_message",
    });
  });

  it("supports creating, scheduling, and manually running an automation through the API", async () => {
    const { orgId, agentId, projectId, userId } = await seedFixture();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      orgIds: [orgId],
    });

    const createRes = await request(app)
      .post(`/api/orgs/${orgId}/automations`)
      .send({
        projectId,
        title: "Daily standup prep",
        description: "Summarize blockers and open PRs",
        assigneeAgentId: agentId,
        priority: "high",
        outputMode: "track_issue",
        notifyOnIssueCreated: true,
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.title).toBe("Daily standup prep");
    expect(createRes.body.assigneeAgentId).toBe(agentId);
    expect(createRes.body.notifyOnIssueCreated).toBe(true);

    const automationId = createRes.body.id as string;

    const triggerRes = await request(app)
      .post(`/api/automations/${automationId}/triggers`)
      .send({
        kind: "schedule",
        label: "Weekday morning",
        cronExpression: "0 10 * * 1-5",
        timezone: "UTC",
      });

    expect(triggerRes.status).toBe(201);
    expect(triggerRes.body.trigger.kind).toBe("schedule");
    expect(triggerRes.body.trigger.enabled).toBe(true);
    expect(triggerRes.body.secretMaterial).toBeNull();

    const runRes = await request(app)
      .post(`/api/automations/${automationId}/run`)
      .send({
        source: "manual",
        payload: { origin: "e2e-test" },
      });

    expect(runRes.status).toBe(202);
    expect(runRes.body.status).toBe("issue_created");
    expect(runRes.body.source).toBe("manual");
    expect(runRes.body.linkedIssueId).toBeTruthy();

    const touchedIssues = await issueService(db).list(orgId, {
      status: "backlog,todo,in_progress,in_review,blocked,done",
      touchedByUserId: userId,
    });
    expect(touchedIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: runRes.body.linkedIssueId,
        originKind: "automation_execution",
        originId: automationId,
      }),
    ]));

    const detailRes = await request(app).get(`/api/automations/${automationId}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.triggers).toHaveLength(1);
    expect(detailRes.body.triggers[0]?.id).toBe(triggerRes.body.trigger.id);
    expect(detailRes.body.recentRuns).toHaveLength(1);
    expect(detailRes.body.recentRuns[0]?.id).toBe(runRes.body.id);
    expect(detailRes.body.activeIssue?.id).toBe(runRes.body.linkedIssueId);

    const runsRes = await request(app).get(`/api/automations/${automationId}/runs?limit=10`);
    expect(runsRes.status).toBe(200);
    expect(runsRes.body).toHaveLength(1);
    expect(runsRes.body[0]?.id).toBe(runRes.body.id);

    const [issue] = await db
      .select({
        id: issues.id,
        originId: issues.originId,
        originKind: issues.originKind,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, runRes.body.linkedIssueId));

    expect(issue).toMatchObject({
      id: runRes.body.linkedIssueId,
      originId: automationId,
      originKind: "automation_execution",
    });
    expect(issue?.executionRunId).toBeTruthy();

    const actions = await db
      .select({
        action: activityLog.action,
      })
      .from(activityLog)
      .where(eq(activityLog.orgId, orgId));

    expect(actions.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        "automation.created",
        "automation.trigger_created",
        "automation.run_triggered",
      ]),
    );
  }, 20_000);

  it("supports always-enqueue automation runs through the API", async () => {
    const { orgId, agentId, projectId, userId } = await seedFixture();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      orgIds: [orgId],
    });

    const createRes = await request(app)
      .post(`/api/orgs/${orgId}/automations`)
      .send({
        projectId,
        title: "Parallel report prep",
        description: "Prepare report slices independently",
        assigneeAgentId: agentId,
        priority: "medium",
        outputMode: "track_issue",
        concurrencyPolicy: "always_enqueue",
        catchUpPolicy: "skip_missed",
      });

    expect(createRes.status).toBe(201);
    const automationId = createRes.body.id as string;

    const firstRun = await request(app).post(`/api/automations/${automationId}/run`).send({ source: "manual" });
    const secondRun = await request(app).post(`/api/automations/${automationId}/run`).send({ source: "manual" });

    expect(firstRun.status).toBe(202);
    expect(secondRun.status).toBe(202);
    expect(firstRun.body.status).toBe("issue_created");
    expect(secondRun.body.status).toBe("issue_created");
    expect(firstRun.body.linkedIssueId).toBeTruthy();
    expect(secondRun.body.linkedIssueId).toBeTruthy();
    expect(firstRun.body.linkedIssueId).not.toBe(secondRun.body.linkedIssueId);

    const automationIssues = await db
      .select({
        id: issues.id,
        originRunId: issues.originRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.originId, automationId));

    expect(automationIssues).toHaveLength(2);
    expect(automationIssues.map((issue) => issue.originRunId).sort()).toEqual(
      [firstRun.body.id, secondRun.body.id].sort(),
    );
    expect(automationIssues.every((issue) => Boolean(issue.executionRunId))).toBe(true);
  }, 20_000);

  it("creates a chat-output automation result chat and publishes the final output", async () => {
    const { orgId, agentId, projectId, userId } = await seedFixture();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      orgIds: [orgId],
    });

    const createRes = await request(app)
      .post(`/api/orgs/${orgId}/automations`)
      .send({
        projectId,
        title: "Daily result chat",
        description: "Send the final result to chat.",
        assigneeAgentId: agentId,
        outputMode: "chat_output",
        chatConversationId: null,
        notifyOnIssueCreated: false,
        priority: "medium",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.chatConversationId).toBeNull();

    const runRes = await request(app)
      .post(`/api/automations/${createRes.body.id}/run`)
      .send({ source: "manual" });

    expect(runRes.status).toBe(202);
    expect(runRes.body.status).toBe("running");
    expect(runRes.body.linkedIssueId).toBeNull();
    expect(runRes.body.linkedChatConversationId).toBeTruthy();

    const [organizationAfterRun] = await db
      .select({ issueCounter: organizations.issueCounter })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    expect(organizationAfterRun?.issueCounter).toBe(0);

    const [automationRow] = await db
      .select({ chatConversationId: automations.chatConversationId })
      .from(automations)
      .where(eq(automations.id, createRes.body.id));
    expect(automationRow?.chatConversationId).toBeNull();

    await waitFor(async () => {
      const [run] = await db.select().from(automationRuns).where(eq(automationRuns.id, runRes.body.id));
      return run?.status === "completed" ? run : null;
    });

    const automationIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.originRunId, runRes.body.id));
    expect(automationIssues).toHaveLength(0);

    const messages = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, runRes.body.linkedChatConversationId))
      .orderBy(asc(chatMessages.createdAt));

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: "user",
      kind: "message",
      conversationId: runRes.body.linkedChatConversationId,
    });
    expect(messages[0]?.body).toContain("Send the final result to chat.");
    expect(messages[1]).toMatchObject({
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Final result ready for follow-up.",
      replyingAgentId: agentId,
    });
    expect(messages[1]?.structuredPayload).toMatchObject({
      automationChatRun: {
        runId: runRes.body.id,
        status: "completed",
      },
    });
  }, 20_000);
});
