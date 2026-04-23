import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  organizationSkills,
  organizations,
} from "@rudder/db";
import { renderTemplate, selectPromptTemplate } from "@rudder/agent-runtime-utils/server-utils";
import { deriveOrganizationUrlKey } from "@rudder/shared";

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
        await db.delete(issues);
        await db.delete(heartbeatRunEvents);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentTaskSessions);
        await db.delete(agentRuntimeState);
        await db.delete(organizationSkills);
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
      runtimeConfig: {},
      permissions: {},
    });

    return { orgId, agentId, issuePrefix };
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

  it("replays paused mention wakes on resume without falling back to issue-lock deferral", async () => {
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
    await seedRunningBlocker({ orgId, agentId, taskKey: "blocker-task" });

    const replay = await heartbeat.resumeDeferredWakeupsForAgent(agentId);
    expect(replay.replayed).toBe(1);

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.reason, "issue_comment_mentioned")))
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
      issueId,
      wakeReason: "issue_comment_mentioned",
      wakeCommentId: commentId,
    });
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
});
