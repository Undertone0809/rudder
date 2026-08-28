import { renderTemplate, selectPromptTemplate } from "@rudderhq/agent-runtime-utils/server-utils";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  goals,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  organizationSkills,
  organizations,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { and, eq } from "drizzle-orm";
import express, { Router } from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockBudgetService = vi.hoisted(() => ({
  getInvocationBlock: vi.fn(),
}));

vi.mock("../services/budgets.ts", async () => {
  const actual = await vi.importActual("../services/budgets.ts");
  return {
    ...actual,
    budgetService: () => mockBudgetService,
  };
});

import { errorHandler } from "../middleware/index.js";
import { registerAgentManagementRoutes } from "../routes/agents.management-routes.js";
import { goalRoutes } from "../routes/goals.js";
import { heartbeatService } from "../services/heartbeat.ts";

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-heartbeat-paused-"));
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
  return { connectionString, instance, dataDir };
}

describe("heartbeat paused wakeups", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mockBudgetService.getInvocationBlock.mockResolvedValue(null);
  });

  afterEach(async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await db.delete(activityLog);
        await db.delete(issues);
        await db.delete(heartbeatRunEvents);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentTaskSessions);
        await db.delete(agentRuntimeState);
        await db.delete(organizationSkills);
        await db.delete(goals);
        await db.delete(agents);
        await db.delete(organizations);
        return;
      } catch (error) {
        if (attempt === 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  async function seedAgentFixture(status: "paused" | "idle" | "terminated" | "pending_approval" = "paused") {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(organizations).values({
      id: orgId,
      name: `Rudder ${orgId.slice(0, 6)}`,
      urlKey: deriveOrganizationUrlKey(`Rudder ${orgId.slice(0, 6)}`),
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Builder",
      role: "engineer",
      status,
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {
        heartbeat: {
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    return { orgId, agentId, issuePrefix };
  }

  async function seedDelegationRouteFixture(
    targetStatus: "paused" | "idle" | "terminated" = "idle",
  ) {
    const { orgId, agentId: targetAgentId } = await seedAgentFixture(targetStatus);
    const sourceAgentId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-08-28T00:00:00.000Z");

    await db.insert(agents).values({
      id: sourceAgentId,
      orgId,
      name: "Delegation Source",
      role: "engineer",
      status: "running",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      orgId,
      agentId: sourceAgentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "running",
      contextSnapshot: { taskKey: "delegation-source" },
      startedAt: now,
      updatedAt: now,
    });

    const realHeartbeat = heartbeatService(db);
    const heartbeat = {
      ...realHeartbeat,
      wakeup: (
        agentId: string,
        options: Parameters<typeof realHeartbeat.wakeup>[1],
      ) => realHeartbeat.wakeup(agentId, { ...options, startImmediately: false }),
    };
    const router = Router();
    registerAgentManagementRoutes({
      router,
      db,
      svc: {
        getById: vi.fn().mockResolvedValue({ id: sourceAgentId, orgId, name: "Delegation Source" }),
      },
      access: { hasPermission: vi.fn().mockResolvedValue(true) },
      heartbeat,
    } as any);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId: sourceAgentId,
        orgId,
        runId: sourceRunId,
      };
      next();
    });
    app.use("/api", router);
    app.use(errorHandler);

    return { app, orgId, sourceAgentId, sourceRunId, targetAgentId };
  }

  async function seedIssue(input: {
    orgId: string;
    issuePrefix: string;
    assigneeAgentId?: string | null;
    issueId?: string;
    title?: string;
    status?: "todo" | "in_progress";
    executionRunId?: string | null;
    executionAgentNameKey?: string | null;
  }) {
    const issueId = input.issueId ?? randomUUID();
    await db.insert(issues).values({
      id: issueId,
      orgId: input.orgId,
      title: input.title ?? "Investigate paused wakeups",
      status: input.status ?? "todo",
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId ?? null,
      executionRunId: input.executionRunId ?? null,
      executionAgentNameKey: input.executionAgentNameKey ?? null,
      issueNumber: 1,
      identifier: `${input.issuePrefix}-1`,
    });
    return issueId;
  }

  async function seedRunningBlocker(input: {
    orgId: string;
    agentId: string;
    taskKey: string;
    issueId?: string | null;
  }) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-04-08T00:00:00.000Z");

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      orgId: input.orgId,
      agentId: input.agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "test_blocker",
      payload: input.issueId ? { issueId: input.issueId } : { taskKey: input.taskKey },
      status: "claimed",
      claimedAt: now,
      runId,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      orgId: input.orgId,
      agentId: input.agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "running",
      wakeupRequestId,
      contextSnapshot: input.issueId
        ? { issueId: input.issueId, taskId: input.issueId, taskKey: input.taskKey }
        : { taskId: input.taskKey, taskKey: input.taskKey },
      startedAt: now,
      updatedAt: now,
    });

    return { wakeupRequestId, runId };
  }

  function createGoalRouteApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        source: "local_implicit",
        userId: "board-user",
      };
      next();
    });
    app.use("/api", goalRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedIssueExecutionLock(input: {
    orgId: string;
    issueId: string;
  }) {
    const executionAgentId = randomUUID();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-04-08T00:00:00.000Z");

    await db.insert(agents).values({
      id: executionAgentId,
      orgId: input.orgId,
      name: "Manager",
      role: "pm",
      status: "running",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      orgId: input.orgId,
      agentId: executionAgentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: input.issueId },
      status: "claimed",
      claimedAt: now,
      runId,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      orgId: input.orgId,
      agentId: executionAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId,
      contextSnapshot: {
        issueId: input.issueId,
        taskId: input.issueId,
        taskKey: input.issueId,
      },
      startedAt: now,
      updatedAt: now,
    });

    await db
      .update(issues)
      .set({
        executionRunId: runId,
        executionAgentNameKey: "manager",
        executionLockedAt: now,
      })
      .where(eq(issues.id, input.issueId));

    return { executionAgentId, wakeupRequestId, runId };
  }

  it("stores plain comment wakes as deferred while the agent is paused", async () => {
    const { orgId, agentId, issuePrefix } = await seedAgentFixture("paused");
    const issueId = await seedIssue({
      orgId,
      issuePrefix,
      assigneeAgentId: agentId,
    });
    const heartbeat = heartbeatService(db);
    const commentId = randomUUID();

    const result = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        commentId,
        wakeCommentId: commentId,
        wakeReason: "issue_commented",
        issue: {
          id: issueId,
          title: "Investigate paused wakeups",
          description: "Check replay logic",
          status: "todo",
          priority: "medium",
        },
        comment: {
          id: commentId,
          body: "please pick this up",
          authorUserId: "board-user",
        },
      },
    });

    expect(result).toBeNull();
    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]?.status).toBe("deferred_agent_paused");
    expect(wakeups[0]?.reason).toBe("issue_commented");
    expect((wakeups[0]?.payload as Record<string, unknown>)._paperclipWakeContext).toMatchObject({
      issueId,
      wakeCommentId: commentId,
      wakeReason: "issue_commented",
    });

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  it("persists a deferred Delegation admission through the public route when the target is paused", async () => {
    const { app, sourceAgentId, sourceRunId, targetAgentId } =
      await seedDelegationRouteFixture("paused");

    const response = await request(app)
      .post("/api/agent-runs/delegation")
      .send({
        task: "Inspect the paused target independently",
        targetAgentId,
        idempotencyKey: "delegation-paused-target",
      });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      runId: null,
      sourceRunId,
      targetAgentId,
      scene: "delegation",
      admissionStatus: "deferred",
      replayed: false,
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.delegationIdempotencyKey, "delegation-paused-target"))
      .then((rows) => rows[0] ?? null);
    expect(wakeup).toMatchObject({
      agentId: targetAgentId,
      source: "delegation",
      status: "deferred_agent_paused",
      runId: null,
      requestedByActorType: "agent",
      requestedByActorId: sourceAgentId,
    });
    expect(wakeup?.id).toBe(response.body.wakeupRequestId);
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.agentId, targetAgentId),
        eq(heartbeatRuns.invocationSource, "delegation"),
      ));
    expect(runs).toHaveLength(0);
  });

  it("persists a skipped Delegation admission through the public route on budget hard-stop", async () => {
    const { app, sourceAgentId, sourceRunId, targetAgentId } =
      await seedDelegationRouteFixture("idle");
    mockBudgetService.getInvocationBlock.mockResolvedValue({
      reason: "Agent budget hard-stop reached.",
      scopeType: "agent",
      scopeId: targetAgentId,
    });

    const response = await request(app)
      .post("/api/agent-runs/delegation")
      .send({
        task: "Inspect the budget-blocked target independently",
        targetAgentId,
        idempotencyKey: "delegation-budget-blocked",
      });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      runId: null,
      sourceRunId,
      targetAgentId,
      scene: "delegation",
      admissionStatus: "skipped",
      replayed: false,
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.delegationIdempotencyKey, "delegation-budget-blocked"))
      .then((rows) => rows[0] ?? null);
    expect(wakeup).toMatchObject({
      agentId: targetAgentId,
      source: "delegation",
      status: "skipped",
      reason: "budget.blocked",
      runId: null,
      requestedByActorType: "agent",
      requestedByActorId: sourceAgentId,
    });
    expect(wakeup?.id).toBe(response.body.wakeupRequestId);
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.agentId, targetAgentId),
        eq(heartbeatRuns.invocationSource, "delegation"),
      ));
    expect(runs).toHaveLength(0);
  });

  it("persists a skipped Delegation admission through the public route for a terminated target", async () => {
    const { app, sourceAgentId, sourceRunId, targetAgentId } =
      await seedDelegationRouteFixture("terminated");

    const response = await request(app)
      .post("/api/agent-runs/delegation")
      .send({
        task: "Record that the terminated target cannot execute",
        targetAgentId,
        idempotencyKey: "delegation-target-unavailable",
      });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      runId: null,
      sourceRunId,
      targetAgentId,
      scene: "delegation",
      admissionStatus: "skipped",
      replayed: false,
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.delegationIdempotencyKey, "delegation-target-unavailable"))
      .then((rows) => rows[0] ?? null);
    expect(wakeup).toMatchObject({
      agentId: targetAgentId,
      source: "delegation",
      status: "skipped",
      reason: "agent.unavailable",
      runId: null,
      requestedByActorType: "agent",
      requestedByActorId: sourceAgentId,
    });
    expect(wakeup?.id).toBe(response.body.wakeupRequestId);
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.agentId, targetAgentId),
        eq(heartbeatRuns.invocationSource, "delegation"),
      ));
    expect(runs).toHaveLength(0);
  });

  it("queues a Delegation admission through the public route when target concurrency is saturated", async () => {
    const { app, orgId, sourceRunId, targetAgentId } =
      await seedDelegationRouteFixture("idle");
    const blocker = await seedRunningBlocker({
      orgId,
      agentId: targetAgentId,
      taskKey: "occupied-target-slot",
    });

    const response = await request(app)
      .post("/api/agent-runs/delegation")
      .send({
        task: "Wait for capacity, then inspect the target independently",
        targetAgentId,
        idempotencyKey: "delegation-concurrency-saturated",
      });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      sourceRunId,
      targetAgentId,
      scene: "delegation",
      admissionStatus: "queued",
      replayed: false,
    });
    expect(response.body.runId).toEqual(expect.any(String));
    expect(response.body.runId).not.toBe(blocker.runId);

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.delegationIdempotencyKey, "delegation-concurrency-saturated"))
      .then((rows) => rows[0] ?? null);
    expect(wakeup).toMatchObject({
      agentId: targetAgentId,
      source: "delegation",
      status: "queued",
      runId: response.body.runId,
    });
    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, response.body.runId))
      .then((rows) => rows[0] ?? null);
    expect(run).toMatchObject({
      agentId: targetAgentId,
      invocationSource: "delegation",
      status: "queued",
      sourceRunId,
      wakeupRequestId: wakeup?.id,
      sessionReuseScope: "none",
    });
  });

  it("replays paused assignee mentions into the existing issue execution queue", async () => {
    const { orgId, agentId, issuePrefix } = await seedAgentFixture("paused");
    const issueId = await seedIssue({
      orgId,
      issuePrefix,
      assigneeAgentId: agentId,
    });
    await seedIssueExecutionLock({ orgId, issueId });
    const heartbeat = heartbeatService(db);
    const commentId = randomUUID();

    await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_comment_mentioned",
      payload: { issueId, commentId },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        commentId,
        wakeCommentId: commentId,
        wakeReason: "issue_comment_mentioned",
        wakeSource: "comment.mention",
        issue: {
          id: issueId,
          title: "Investigate paused wakeups",
          description: "Check replay logic",
          status: "todo",
          priority: "medium",
        },
        comment: {
          id: commentId,
          body: "@manager can you look?",
          authorUserId: "board-user",
        },
      },
    });

    await db
      .update(agents)
      .set({
        status: "idle",
        pausedAt: null,
        pauseReason: null,
      })
      .where(eq(agents.id, agentId));
    const pausedWakeup = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.status, "deferred_agent_paused"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    expect(pausedWakeup?.id).toBeTruthy();
    await seedRunningBlocker({ orgId, agentId, taskKey: "blocker-task" });

    const replay = await heartbeat.resumeDeferredWakeupsForAgent(agentId);
    expect(replay.replayed).toBe(1);

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, pausedWakeup!.id))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("deferred_issue_execution");
    expect(wakeup?.reason).toBe("issue_execution_deferred");
    expect(wakeup?.runId).toBeNull();
    expect((wakeup?.payload as Record<string, unknown>)._paperclipWakeContext).toMatchObject({
      issueId,
      wakeReason: "issue_comment_mentioned",
      wakeCommentId: commentId,
      relationship: "assignee",
    });
    const deferredMentionWakeups = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
        ),
      );
    expect(deferredMentionWakeups).toEqual([{ id: pausedWakeup!.id }]);
  });

  it("replays paused on-demand wakes on resume", async () => {
    const { orgId, agentId } = await seedAgentFixture("paused");
    const heartbeat = heartbeatService(db);

    await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_followup",
      payload: { taskKey: "adhoc-task" },
      contextSnapshot: {
        taskId: "adhoc-task",
        taskKey: "adhoc-task",
        wakeReason: "manual_followup",
      },
    });

    await db
      .update(agents)
      .set({
        status: "idle",
        pausedAt: null,
        pauseReason: null,
      })
      .where(eq(agents.id, agentId));
    await seedRunningBlocker({ orgId, agentId, taskKey: "blocker-task" });

    await heartbeat.resumeDeferredWakeupsForAgent(agentId);

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.reason, "manual_followup")))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("queued");
    expect(wakeup?.runId).toBeTruthy();

    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, wakeup?.runId ?? ""))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("queued");
    expect(run?.contextSnapshot).toMatchObject({
      taskKey: "adhoc-task",
      wakeReason: "manual_followup",
    });
  });

  it("hydrates issue context when replaying paused assignment wakes on resume", async () => {
    const { agentId, orgId, issuePrefix } = await seedAgentFixture("paused");
    const issueId = await seedIssue({
      orgId,
      issuePrefix,
      title: "CEO follow-up on roadmap",
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, mutation: "update" },
      contextSnapshot: {
        issueId,
        source: "issue.update",
        wakeSource: "assignment",
        wakeReason: "issue_assigned",
      },
    });

    await db
      .update(agents)
      .set({
        status: "idle",
        pausedAt: null,
        pauseReason: null,
      })
      .where(eq(agents.id, agentId));

    await heartbeat.resumeDeferredWakeupsForAgent(agentId);

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.reason, "issue_assigned")))
      .then((rows) => rows[0] ?? null);
    expect(["queued", "claimed"]).toContain(wakeup?.status);
    expect(wakeup?.runId).toBeTruthy();

    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, wakeup?.runId ?? ""))
      .then((rows) => rows[0] ?? null);
    const context = (run?.contextSnapshot ?? {}) as Record<string, unknown>;
    expect(context).toMatchObject({
      issueId,
      wakeReason: "issue_assigned",
      issue: {
        id: issueId,
        title: "CEO follow-up on roadmap",
        status: "todo",
        priority: "medium",
      },
    });

    const promptTemplate = selectPromptTemplate(undefined, context);
    const renderedPrompt = renderTemplate(promptTemplate, {
      agent: { id: agentId, name: "Builder" },
      context,
      issue: context.issue,
    });
    expect(renderedPrompt).toContain("CEO follow-up on roadmap");
    expect(renderedPrompt).toContain("**Status:** todo");
    expect(renderedPrompt).toContain("**Priority:** medium");
  });

  it("coalesces repeated paused comment wakes and keeps the latest comment context", async () => {
    const { orgId, agentId, issuePrefix } = await seedAgentFixture("paused");
    const issueId = await seedIssue({
      orgId,
      issuePrefix,
      assigneeAgentId: agentId,
    });
    const heartbeat = heartbeatService(db);
    const firstCommentId = randomUUID();
    const latestCommentId = randomUUID();

    await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: firstCommentId },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        commentId: firstCommentId,
        wakeCommentId: firstCommentId,
        wakeReason: "issue_commented",
        issue: { id: issueId, title: "Investigate paused wakeups", status: "todo" },
        comment: { id: firstCommentId, body: "first comment" },
      },
    });

    await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: latestCommentId },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        commentId: latestCommentId,
        wakeCommentId: latestCommentId,
        wakeReason: "issue_commented",
        issue: { id: issueId, title: "Investigate paused wakeups", status: "todo" },
        comment: { id: latestCommentId, body: "latest comment" },
      },
    });

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]?.status).toBe("deferred_agent_paused");
    expect(wakeups[0]?.coalescedCount).toBe(1);
    expect((wakeups[0]?.payload as Record<string, unknown>)._paperclipWakeContext).toMatchObject({
      commentId: latestCommentId,
      wakeCommentId: latestCommentId,
      comment: {
        id: latestCommentId,
        body: "latest comment",
      },
    });
  });

  it.each(["terminated", "pending_approval"] as const)(
    "rejects wakeups for %s agents instead of deferring them",
    async (status) => {
      const { agentId } = await seedAgentFixture(status);
      const heartbeat = heartbeatService(db);

      await expect(
        heartbeat.wakeup(agentId, {
          source: "on_demand",
          triggerDetail: "manual",
          reason: "manual_followup",
          payload: { taskKey: "adhoc-task" },
          contextSnapshot: {
            taskId: "adhoc-task",
            taskKey: "adhoc-task",
          },
        }),
      ).rejects.toThrow(/not invokable/i);

      const wakeups = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));
      expect(wakeups).toHaveLength(0);
    },
  );

  it("keeps budget-block behavior unchanged even when the agent is paused", async () => {
    const { agentId } = await seedAgentFixture("paused");
    const heartbeat = heartbeatService(db);
    mockBudgetService.getInvocationBlock.mockResolvedValue({
      reason: "Agent budget hard-stop reached.",
      scopeType: "agent",
      scopeId: agentId,
    });

    await expect(
      heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "manual_followup",
        payload: { taskKey: "adhoc-task" },
        contextSnapshot: {
          taskId: "adhoc-task",
          taskKey: "adhoc-task",
        },
      }),
    ).rejects.toThrow(/budget hard-stop/i);

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]?.status).toBe("skipped");
    expect(wakeups[0]?.reason).toBe("budget.blocked");
  });

  it("keeps Focus recovery inside the changed Goal organization", async () => {
    const orgA = await seedAgentFixture("idle");
    const orgB = await seedAgentFixture("idle");
    const goalAId = randomUUID();
    const goalBId = randomUUID();

    await db.insert(goals).values([
      {
        id: goalAId,
        orgId: orgA.orgId,
        title: "Recover organization A Goal work",
        outcomeStatement: "Only organization A work is recovered",
        lifecycle: "active",
        status: "active",
        ownerAgentId: orgA.agentId,
        planRevision: 1,
        criteria: [{ id: "org-a", label: "Organization A Run is admitted", evaluator: "artifact" }],
        continuationKind: "action",
        continuationSummary: "Resume organization A work",
      },
      {
        id: goalBId,
        orgId: orgB.orgId,
        title: "Keep organization B Goal work pending",
        outcomeStatement: "Organization B work waits for its own recovery",
        lifecycle: "active",
        status: "active",
        ownerAgentId: orgB.agentId,
        planRevision: 1,
        criteria: [{ id: "org-b", label: "Organization B Run remains pending", evaluator: "artifact" }],
        continuationKind: "action",
        continuationSummary: "Wait for organization B recovery",
      },
    ]);

    await seedRunningBlocker({ orgId: orgA.orgId, agentId: orgA.agentId, taskKey: "org-a-blocker" });
    await seedRunningBlocker({ orgId: orgB.orgId, agentId: orgB.agentId, taskKey: "org-b-blocker" });

    const queueGoalIntent = async (input: {
      orgId: string;
      agentId: string;
      goalId: string;
      label: string;
    }) => {
      const wakeupRequestId = randomUUID();
      const taskKey = `goal:${input.goalId}:goal_feedback:${input.label}`;
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        orgId: input.orgId,
        agentId: input.agentId,
        source: "on_demand",
        triggerDetail: "system",
        reason: "goal_feedback",
        payload: {
          event: "goal_feedback",
          goalId: input.goalId,
          feedbackId: input.label,
          taskKey,
          _paperclipWakeContext: {
            goalId: input.goalId,
            taskKey,
            wakeReason: "goal_feedback",
            goal: {
              id: input.goalId,
              title: `Goal ${input.label}`,
              outcomeStatement: `Outcome ${input.label}`,
              contractRevision: 1,
            },
          },
        },
        status: "queued",
        requestedByActorType: "user",
        requestedByActorId: "board-user",
        idempotencyKey: `goal-feedback:${input.label}`,
      });
      return wakeupRequestId;
    };

    const wakeupAId = await queueGoalIntent({
      orgId: orgA.orgId,
      agentId: orgA.agentId,
      goalId: goalAId,
      label: "org-a",
    });
    const wakeupBId = await queueGoalIntent({
      orgId: orgB.orgId,
      agentId: orgB.agentId,
      goalId: goalBId,
      label: "org-b",
    });

    const response = await request(createGoalRouteApp())
      .post(`/api/goals/${goalAId}/focus`)
      .send({ focus: true });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: goalAId, orgId: orgA.orgId, focus: true });
    expect(await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupAId))
      .then((rows) => rows[0])).toMatchObject({
      orgId: orgA.orgId,
      status: "queued",
      runId: expect.any(String),
    });
    expect(await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupBId))
      .then((rows) => rows[0])).toMatchObject({
      orgId: orgB.orgId,
      status: "queued",
      runId: null,
    });
    expect(await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.wakeupRequestId, wakeupBId))).toHaveLength(0);
  }, 30_000);

  it("keeps Goal wake intents recoverable across budget, policy, and Agent availability blocks", async () => {
    const { orgId, agentId } = await seedAgentFixture("idle");
    const goalId = randomUUID();
    await db.insert(goals).values({
      id: goalId,
      orgId,
      title: "Recover blocked Goal work",
      outcomeStatement: "Blocked Goal work resumes exactly once",
      lifecycle: "active",
      status: "active",
      ownerAgentId: agentId,
      planRevision: 1,
      criteria: [{ id: "resume", label: "One Run is admitted", evaluator: "artifact" }],
      continuationKind: "action",
      continuationSummary: "Resume after the blocking condition clears",
    });
    const heartbeat = heartbeatService(db);
    const queueAndDispatch = async (eventId: string) => {
      const wakeupRequestId = randomUUID();
      const taskKey = `goal:${goalId}:goal_feedback:${eventId}`;
      const payload = { event: "goal_feedback", goalId, feedbackId: eventId, taskKey };
      const contextSnapshot = {
        goalId,
        taskKey,
        goal: {
          id: goalId,
          title: "Recover blocked Goal work",
          outcomeStatement: "Blocked Goal work resumes exactly once",
          contractRevision: 1,
        },
        goalContinuation: {
          kind: "action",
          summary: "Resume after the blocking condition clears",
        },
      };
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        orgId,
        agentId,
        source: "on_demand",
        triggerDetail: "system",
        reason: "goal_feedback",
        payload,
        status: "queued",
        requestedByActorType: "user",
        requestedByActorId: "board-user",
        idempotencyKey: `goal-feedback:${eventId}`,
      });
      const run = await heartbeat.wakeup(agentId, {
        existingWakeupRequestId: wakeupRequestId,
        source: "on_demand",
        triggerDetail: "system",
        reason: "goal_feedback",
        payload,
        contextSnapshot,
        requestedByActorType: "user",
        requestedByActorId: "board-user",
        idempotencyKey: `goal-feedback:${eventId}`,
        startImmediately: false,
      });
      return { wakeupRequestId, run };
    };
    const expectDeferred = async (wakeupRequestId: string, error: string) => {
      expect(await db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0])).toMatchObject({
          status: "deferred_goal_blocked",
          runId: null,
          finishedAt: null,
          error,
        });
    };
    const recoverExactlyOnce = async (wakeupRequestId: string) => {
      const recovery = await heartbeat.resumePendingWakeupRequests({ startImmediately: false });
      expect(recovery.resumed).toBeGreaterThanOrEqual(1);
      expect(await db.select().from(heartbeatRuns)
        .where(eq(heartbeatRuns.wakeupRequestId, wakeupRequestId))).toHaveLength(1);
      await heartbeat.resumePendingWakeupRequests({ startImmediately: false });
      expect(await db.select().from(heartbeatRuns)
        .where(eq(heartbeatRuns.wakeupRequestId, wakeupRequestId))).toHaveLength(1);
    };

    mockBudgetService.getInvocationBlock.mockResolvedValue({
      reason: "Agent budget hard-stop reached.",
      scopeType: "agent",
      scopeId: agentId,
    });
    const budgetBlocked = await queueAndDispatch("budget-feedback");
    expect(budgetBlocked.run).toBeNull();
    await expectDeferred(budgetBlocked.wakeupRequestId, "budget.blocked");
    mockBudgetService.getInvocationBlock.mockResolvedValue(null);
    await recoverExactlyOnce(budgetBlocked.wakeupRequestId);

    await db.update(agents).set({
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1, wakeOnDemand: false } },
    }).where(eq(agents.id, agentId));
    const policyBlocked = await queueAndDispatch("policy-feedback");
    expect(policyBlocked.run).toBeNull();
    await expectDeferred(policyBlocked.wakeupRequestId, "heartbeat.wakeOnDemand.disabled");
    await db.update(agents).set({
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1, wakeOnDemand: true } },
    }).where(eq(agents.id, agentId));
    await recoverExactlyOnce(policyBlocked.wakeupRequestId);

    await db.update(agents).set({ status: "pending_approval" }).where(eq(agents.id, agentId));
    const unavailable = await queueAndDispatch("availability-feedback");
    expect(unavailable.run).toBeNull();
    await expectDeferred(unavailable.wakeupRequestId, "agent.unavailable");
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agentId));
    await recoverExactlyOnce(unavailable.wakeupRequestId);
  }, 30_000);
});
