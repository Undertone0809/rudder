import {
  activityLog,
  agentWakeupRequests,
  agents,
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  heartbeatRuns,
  issues,
  organizations,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockBudgetService = vi.hoisted(() => ({
  getInvocationBlock: vi.fn(),
}));

const mockRuntimeAdapter = vi.hoisted(() => {
  const calls: Array<{ runId: string; taskKey: string | null }> = [];
  const completions: Array<() => void> = [];
  const pending: Array<Promise<unknown>> = [];

  return {
    calls,
    reset() {
      calls.length = 0;
    },
    async completePendingExecutions() {
      const resolvers = completions.splice(0);
      for (const resolve of resolvers) resolve();
      const pendingExecutions = pending.splice(0);
      await Promise.allSettled(pendingExecutions);
    },
    adapter: {
      type: "codex_local",
      sessionCodec: {
        deserialize: (raw: unknown) =>
          typeof raw === "object" && raw !== null && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : null,
        serialize: (params: Record<string, unknown> | null) => params,
        getDisplayId: (params: Record<string, unknown> | null) =>
          typeof params?.sessionId === "string" ? params.sessionId : null,
      },
      supportsLocalAgentJwt: false,
      testEnvironment: async () => ({
        agentRuntimeType: "codex_local",
        status: "pass" as const,
        checks: [],
        testedAt: new Date("2026-04-27T00:00:00.000Z").toISOString(),
      }),
      execute: async (ctx: { runId: string; runtime: { taskKey: string | null } }) => {
        mockRuntimeAdapter.calls.push({
          runId: ctx.runId,
          taskKey: ctx.runtime.taskKey,
        });
        const result = new Promise((resolve) => {
          completions.push(() => {
            resolve({
              exitCode: 0,
              signal: null,
              timedOut: false,
              summary: "Test execution released",
            });
          });
        });
        pending.push(result);
        return await result;
      },
    },
  };
});

vi.mock("../services/budgets.ts", async () => {
  const actual = await vi.importActual("../services/budgets.ts");
  return {
    ...actual,
    budgetService: () => mockBudgetService,
  };
});

vi.mock("../agent-runtimes/index.ts", async () => {
  const actual = await vi.importActual("../agent-runtimes/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => mockRuntimeAdapter.adapter),
    runningProcesses: new Map(),
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
  const externalConnectionString = process.env.RUDDER_HEARTBEAT_CONCURRENCY_TEST_DATABASE_URL?.trim();
  if (externalConnectionString) {
    const parsed = new URL(externalConnectionString);
    const dbName = parsed.pathname.replace(/^\//, "");
    parsed.pathname = "/postgres";
    await ensurePostgresDatabase(parsed.toString(), dbName);
    await applyPendingMigrations(externalConnectionString);
    return { connectionString: externalConnectionString, instance: null, dataDir: "" };
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-heartbeat-concurrency-"));
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

async function waitForCondition(check: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for test condition");
}

describe("heartbeat run concurrency", () => {
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
    mockRuntimeAdapter.reset();
  });

  afterAll(async () => {
    if (db) {
      await db
        .update(heartbeatRuns)
        .set({
          status: "cancelled",
          finishedAt: new Date(),
          error: "Cancelled during test teardown",
        })
        .where(inArray(heartbeatRuns.status, ["queued"]));
    }
    await mockRuntimeAdapter.completePendingExecutions();
    await waitForCondition(async () => {
      if (!db) return true;
      const liveRuns = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, ["running"]));
      return liveRuns.length === 0;
    }, 10_000);
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  async function seedAgentFixture(options?: number | {
    runtimeConfig?: Record<string, unknown>;
    createdAt?: Date;
    lastHeartbeatAt?: Date | null;
  }) {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const orgName = `Rudder ${orgId.slice(0, 6)}`;
    const fixtureOptions = typeof options === "number"
      ? { runtimeConfig: { heartbeat: { maxConcurrentRuns: options } } }
      : options ?? {};

    await db.insert(organizations).values({
      id: orgId,
      name: orgName,
      urlKey: deriveOrganizationUrlKey(orgName),
      issuePrefix: `T${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Builder",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: fixtureOptions.runtimeConfig ?? {},
      permissions: {},
      lastHeartbeatAt: fixtureOptions.lastHeartbeatAt,
      createdAt: fixtureOptions.createdAt,
      updatedAt: fixtureOptions.createdAt,
    });

    return { orgId, agentId };
  }

  async function disableExistingTimerAgents() {
    await db.update(agents).set({
      runtimeConfig: {},
      lastHeartbeatAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async function seedIssueFixture(input: {
    orgId: string;
    agentId?: string;
    reviewerAgentId?: string | null;
    status?: string;
    originKind?: string | null;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      orgId: input.orgId,
      title: "Build concurrent execution",
      status: input.status ?? "todo",
      priority: "medium",
      assigneeAgentId: input.agentId ?? null,
      reviewerAgentId: input.reviewerAgentId ?? null,
      ...(input.originKind ? { originKind: input.originKind } : {}),
    });
    return issueId;
  }

  async function seedQueuedRun(input: {
    orgId: string;
    agentId: string;
    taskKey: string;
    issueId?: string;
    reason?: string;
    wakeReason?: string;
    wakeSource?: string;
    wakeCommentId?: string;
    createdAt: Date;
  }) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      orgId: input.orgId,
      agentId: input.agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: input.reason ?? "test_queue",
      payload: {
        taskKey: input.taskKey,
        ...(input.issueId ? { issueId: input.issueId } : {}),
        ...(input.wakeCommentId ? { commentId: input.wakeCommentId } : {}),
      },
      status: "queued",
      requestedAt: input.createdAt,
      updatedAt: input.createdAt,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      orgId: input.orgId,
      agentId: input.agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {
        taskId: input.issueId ?? input.taskKey,
        taskKey: input.taskKey,
        ...(input.issueId ? { issueId: input.issueId } : {}),
        ...(input.wakeReason ? { wakeReason: input.wakeReason } : {}),
        ...(input.wakeSource ? { wakeSource: input.wakeSource } : {}),
        ...(input.wakeCommentId ? { wakeCommentId: input.wakeCommentId } : {}),
      },
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    });

    return runId;
  }

  async function listRunStatuses(agentId: string) {
    return await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
  }

  async function listLiveRunsForAgent(agentId: string) {
    return await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])));
  }

  async function listWakeupRequestsForAgent(agentId: string) {
    return await db
      .select({
        id: agentWakeupRequests.id,
        status: agentWakeupRequests.status,
        source: agentWakeupRequests.source,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
        runId: agentWakeupRequests.runId,
        finishedAt: agentWakeupRequests.finishedAt,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
  }

  async function seedLiveIssueExecution(input: {
    orgId: string;
    agentId: string;
    issueId: string;
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      orgId: input.orgId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: {
        issueId: input.issueId,
        taskKey: `issue:${input.issueId}`,
      },
    });
    await db
      .update(issues)
      .set({
        executionRunId: runId,
        executionAgentNameKey: "builder",
        executionLockedAt: new Date(),
      })
      .where(eq(issues.id, input.issueId));
    return runId;
  }

  async function seedRunlessWakeup(input: {
    orgId: string;
    agentId: string;
    status: "queued" | "deferred_issue_execution";
    source?: string;
    reason?: string;
    issueId?: string;
    wakeSource?: string;
    wakeCommentId?: string;
    requestedAt?: Date;
  }) {
    const wakeupId = randomUUID();
    const context = input.issueId
      ? {
          issueId: input.issueId,
          wakeReason: input.reason ?? "issue_assigned",
          ...(input.wakeSource ? { wakeSource: input.wakeSource } : {}),
          ...(input.wakeCommentId ? { wakeCommentId: input.wakeCommentId } : {}),
        }
      : {};
    await db.insert(agentWakeupRequests).values({
      id: wakeupId,
      orgId: input.orgId,
      agentId: input.agentId,
      source: input.source ?? "assignment",
      triggerDetail: "system",
      reason: input.reason ?? "issue_assigned",
      payload: input.issueId
        ? {
            issueId: input.issueId,
            ...(input.wakeCommentId ? { commentId: input.wakeCommentId } : {}),
            _paperclipWakeContext: context,
          }
        : {},
      status: input.status,
      requestedAt: input.requestedAt ?? new Date("2026-04-27T06:00:00.000Z"),
      updatedAt: input.requestedAt ?? new Date("2026-04-27T06:00:00.000Z"),
    });
    return wakeupId;
  }

  it("promotes queued runs up to the configured concurrency limit", async () => {
    const { orgId, agentId } = await seedAgentFixture(2);
    const createdAt = new Date("2026-04-27T00:00:00.000Z");
    await seedQueuedRun({ orgId, agentId, taskKey: "issue:a", createdAt });
    await seedQueuedRun({ orgId, agentId, taskKey: "issue:b", createdAt: new Date(createdAt.getTime() + 1_000) });
    await seedQueuedRun({ orgId, agentId, taskKey: "issue:c", createdAt: new Date(createdAt.getTime() + 2_000) });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const statuses = await listRunStatuses(agentId);
      return (
        mockRuntimeAdapter.calls.length === 2
        && statuses.filter((run) => run.status === "running").length === 2
      );
    });

    const statuses = await listRunStatuses(agentId);
    expect(statuses.filter((run) => run.status === "running")).toHaveLength(2);
    expect(statuses.filter((run) => run.status === "queued")).toHaveLength(1);
    expect(new Set(mockRuntimeAdapter.calls.map((call) => call.taskKey))).toEqual(new Set(["issue:a", "issue:b"]));
  });

  it("keeps configured one-run agents serial", async () => {
    const { orgId, agentId } = await seedAgentFixture(1);
    const createdAt = new Date("2026-04-27T00:30:00.000Z");
    await seedQueuedRun({ orgId, agentId, taskKey: "serial:1", createdAt });
    await seedQueuedRun({ orgId, agentId, taskKey: "serial:2", createdAt: new Date(createdAt.getTime() + 1_000) });
    await seedQueuedRun({ orgId, agentId, taskKey: "serial:3", createdAt: new Date(createdAt.getTime() + 2_000) });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const statuses = await listRunStatuses(agentId);
      return (
        mockRuntimeAdapter.calls.length === 1
        && statuses.filter((run) => run.status === "running").length === 1
      );
    });

    const statuses = await listRunStatuses(agentId);
    expect(statuses.filter((run) => run.status === "running")).toHaveLength(1);
    expect(statuses.filter((run) => run.status === "queued")).toHaveLength(2);
    expect(mockRuntimeAdapter.calls.map((call) => call.taskKey)).toEqual(["serial:1"]);
  });

  it("defaults agents without an explicit value to three concurrent runs", async () => {
    const { orgId, agentId } = await seedAgentFixture();
    const createdAt = new Date("2026-04-27T01:00:00.000Z");
    await seedQueuedRun({ orgId, agentId, taskKey: "task:1", createdAt });
    await seedQueuedRun({ orgId, agentId, taskKey: "task:2", createdAt: new Date(createdAt.getTime() + 1_000) });
    await seedQueuedRun({ orgId, agentId, taskKey: "task:3", createdAt: new Date(createdAt.getTime() + 2_000) });
    await seedQueuedRun({ orgId, agentId, taskKey: "task:4", createdAt: new Date(createdAt.getTime() + 3_000) });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const statuses = await listRunStatuses(agentId);
      return (
        mockRuntimeAdapter.calls.length === 3
        && statuses.filter((run) => run.status === "running").length === 3
      );
    });

    const statuses = await listRunStatuses(agentId);
    expect(statuses.filter((run) => run.status === "running")).toHaveLength(3);
    expect(statuses.filter((run) => run.status === "queued")).toHaveLength(1);
    expect(new Set(mockRuntimeAdapter.calls.map((call) => call.taskKey))).toEqual(
      new Set(["task:1", "task:2", "task:3"]),
    );
  });

  it("clamps invalid and oversized concurrency values to the supported range", async () => {
    const low = await seedAgentFixture(0);
    const lowCreatedAt = new Date("2026-04-27T02:00:00.000Z");
    await seedQueuedRun({ ...low, taskKey: "low:1", createdAt: lowCreatedAt });
    await seedQueuedRun({ ...low, taskKey: "low:2", createdAt: new Date(lowCreatedAt.getTime() + 1_000) });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const statuses = await listRunStatuses(low.agentId);
      return (
        mockRuntimeAdapter.calls.length === 1
        && statuses.filter((run) => run.status === "running").length === 1
      );
    });

    let statuses = await listRunStatuses(low.agentId);
    expect(statuses.filter((run) => run.status === "running")).toHaveLength(1);
    expect(statuses.filter((run) => run.status === "queued")).toHaveLength(1);

    mockRuntimeAdapter.reset();
    const high = await seedAgentFixture(999);
    const highCreatedAt = new Date("2026-04-27T03:00:00.000Z");
    for (let i = 0; i < 11; i += 1) {
      await seedQueuedRun({
        ...high,
        taskKey: `high:${i + 1}`,
        createdAt: new Date(highCreatedAt.getTime() + i * 1_000),
      });
    }

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const highStatuses = await listRunStatuses(high.agentId);
      return (
        mockRuntimeAdapter.calls.length === 10
        && highStatuses.filter((run) => run.status === "running").length === 10
      );
    });

    statuses = await listRunStatuses(high.agentId);
    expect(statuses.filter((run) => run.status === "running")).toHaveLength(10);
    expect(statuses.filter((run) => run.status === "queued")).toHaveLength(1);
  });

  it("coalesces repeated wakeups for the same issue into one active execution run", async () => {
    const { orgId, agentId } = await seedAgentFixture(3);
    const issueId = await seedIssueFixture({ orgId, agentId });
    const heartbeat = heartbeatService(db);

    const firstRun = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: {
        issueId,
        source: "test.issue_assigned",
        wakeSource: "assignment",
        wakeReason: "issue_assigned",
      },
    });
    const secondRun = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: {
        issueId,
        source: "test.issue_reassigned",
        wakeSource: "assignment",
        wakeReason: "issue_assigned",
      },
    });

    expect(firstRun?.id).toBeTruthy();
    expect(secondRun?.id).toBe(firstRun?.id);

    await waitForCondition(async () => {
      const runs = await listLiveRunsForAgent(agentId);
      return runs.length === 1 && runs[0]?.status === "running" && mockRuntimeAdapter.calls.length === 1;
    });

    const liveRuns = await listLiveRunsForAgent(agentId);
    expect(liveRuns).toHaveLength(1);
    expect(mockRuntimeAdapter.calls).toHaveLength(1);
    expect((liveRuns[0]?.contextSnapshot as Record<string, unknown>)?.issueId).toBe(issueId);
  });

  it("skips timer heartbeats before launching the runtime when no actionable work exists", async () => {
    await disableExistingTimerAgents();
    const createdAt = new Date("2026-04-27T04:00:00.000Z");
    const tickAt = new Date("2026-04-27T04:05:00.000Z");
    const { orgId, agentId } = await seedAgentFixture({
      createdAt,
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60 } },
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(tickAt);

    expect(result).toEqual({ checked: 1, enqueued: 0, skipped: 1 });
    expect(mockBudgetService.getInvocationBlock).toHaveBeenCalledWith(orgId, agentId, {
      issueId: null,
      projectId: null,
    });
    expect(mockRuntimeAdapter.calls).toHaveLength(0);
    expect(await listRunStatuses(agentId)).toHaveLength(0);

    const wakeups = await listWakeupRequestsForAgent(agentId);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      status: "skipped",
      reason: "heartbeat.preflight.no_actionable_work",
      runId: null,
    });
    expect(wakeups[0]?.finishedAt).toBeInstanceOf(Date);

    const [agent] = await db
      .select({ lastHeartbeatAt: agents.lastHeartbeatAt })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(agent?.lastHeartbeatAt).toBeInstanceOf(Date);
  });

  it("allows timer heartbeats without actionable work when preflight is disabled", async () => {
    await disableExistingTimerAgents();
    const createdAt = new Date("2026-04-27T05:00:00.000Z");
    const tickAt = new Date("2026-04-27T05:05:00.000Z");
    const { agentId } = await seedAgentFixture({
      createdAt,
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, preflightEnabled: false } },
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(tickAt);

    expect(result).toEqual({ checked: 1, enqueued: 1, skipped: 0 });
    await waitForCondition(async () => mockRuntimeAdapter.calls.length === 1);
    expect(mockRuntimeAdapter.calls[0]?.taskKey).toBeNull();
    expect(await listRunStatuses(agentId)).toHaveLength(1);
  });

  it("allows timer heartbeats when assigned work exists", async () => {
    await disableExistingTimerAgents();
    const createdAt = new Date("2026-04-27T06:00:00.000Z");
    const tickAt = new Date("2026-04-27T06:05:00.000Z");
    const { orgId, agentId } = await seedAgentFixture({
      createdAt,
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60 } },
    });
    await seedIssueFixture({ orgId, agentId });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(tickAt);

    expect(result).toEqual({ checked: 1, enqueued: 1, skipped: 0 });
    await waitForCondition(async () => mockRuntimeAdapter.calls.length === 1);
    expect(await listRunStatuses(agentId)).toHaveLength(1);
  });

  it("allows timer heartbeats when assigned work exists alongside an unrelated deferred wakeup", async () => {
    await disableExistingTimerAgents();
    const createdAt = new Date("2026-04-27T06:10:00.000Z");
    const tickAt = new Date("2026-04-27T06:15:00.000Z");
    const { orgId, agentId } = await seedAgentFixture({
      createdAt,
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60 } },
    });
    const blockedIssueId = await seedIssueFixture({ orgId });
    await seedLiveIssueExecution({ orgId, agentId, issueId: blockedIssueId });
    const deferredWakeupId = await seedRunlessWakeup({
      orgId,
      agentId,
      status: "deferred_issue_execution",
      issueId: blockedIssueId,
      requestedAt: new Date("2026-04-27T06:11:00.000Z"),
    });
    await seedIssueFixture({ orgId, agentId });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(tickAt);

    expect(result).toEqual({ checked: 1, enqueued: 1, skipped: 0 });
    await waitForCondition(async () => mockRuntimeAdapter.calls.length === 1);

    const wakeups = await listWakeupRequestsForAgent(agentId);
    expect(wakeups.find((wakeup) => wakeup.id === deferredWakeupId)).toMatchObject({
      status: "deferred_issue_execution",
      runId: null,
    });
    expect(wakeups.some((wakeup) => wakeup.source === "timer" && wakeup.runId)).toBe(true);
  });

  it("recovers a runnable deferred issue wakeup before creating a generic timer run", async () => {
    await disableExistingTimerAgents();
    const createdAt = new Date("2026-04-27T06:20:00.000Z");
    const tickAt = new Date("2026-04-27T06:25:00.000Z");
    const { orgId, agentId } = await seedAgentFixture({
      createdAt,
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60 } },
    });
    const issueId = await seedIssueFixture({ orgId, agentId });
    const deferredWakeupId = await seedRunlessWakeup({
      orgId,
      agentId,
      status: "deferred_issue_execution",
      source: "assignment",
      reason: "issue_assigned",
      issueId,
      requestedAt: new Date("2026-04-27T06:21:00.000Z"),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(tickAt);

    expect(result).toEqual({ checked: 1, enqueued: 1, skipped: 0 });
    await waitForCondition(async () => mockRuntimeAdapter.calls.length === 1);

    const wakeups = await listWakeupRequestsForAgent(agentId);
    expect(wakeups.find((wakeup) => wakeup.id === deferredWakeupId)).toMatchObject({
      status: "claimed",
      source: "assignment",
    });
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      wakeupRequestId: deferredWakeupId,
      invocationSource: "assignment",
    });
  });

  it("skips deferred issue recovery when the linked issue is already done", async () => {
    await disableExistingTimerAgents();
    const createdAt = new Date("2026-04-27T06:26:00.000Z");
    const tickAt = new Date("2026-04-27T06:31:00.000Z");
    const { orgId, agentId } = await seedAgentFixture({
      createdAt,
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60 } },
    });
    const issueId = await seedIssueFixture({ orgId, agentId, status: "done" });
    const deferredWakeupId = await seedRunlessWakeup({
      orgId,
      agentId,
      status: "deferred_issue_execution",
      source: "review",
      reason: "issue_execution_deferred",
      issueId,
      requestedAt: new Date("2026-04-27T06:27:00.000Z"),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(tickAt);

    expect(result).toEqual({ checked: 1, enqueued: 0, skipped: 1 });
    expect(mockRuntimeAdapter.calls).toHaveLength(0);
    expect(await listRunStatuses(agentId)).toHaveLength(0);

    const wakeups = await listWakeupRequestsForAgent(agentId);
    expect(wakeups.find((wakeup) => wakeup.id === deferredWakeupId)).toMatchObject({
      status: "skipped",
      reason: "issue_execution_issue_not_actionable",
      runId: null,
    });
    expect(wakeups.some((wakeup) => wakeup.reason === "heartbeat.preflight.no_actionable_work")).toBe(true);
  });

  it("recovers deferred mention wakes even when the linked issue is already done", async () => {
    await disableExistingTimerAgents();
    const createdAt = new Date("2026-04-27T06:32:00.000Z");
    const tickAt = new Date("2026-04-27T06:37:00.000Z");
    const { orgId, agentId } = await seedAgentFixture({
      createdAt,
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60 } },
    });
    const issueId = await seedIssueFixture({ orgId, agentId, status: "done" });
    const wakeCommentId = randomUUID();
    const deferredWakeupId = await seedRunlessWakeup({
      orgId,
      agentId,
      status: "deferred_issue_execution",
      source: "automation",
      reason: "issue_comment_mentioned",
      issueId,
      wakeSource: "comment.mention",
      wakeCommentId,
      requestedAt: new Date("2026-04-27T06:33:00.000Z"),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(tickAt);

    expect(result).toEqual({ checked: 1, enqueued: 1, skipped: 0 });
    await waitForCondition(async () => mockRuntimeAdapter.calls.length === 1);

    const wakeups = await listWakeupRequestsForAgent(agentId);
    expect(wakeups.find((wakeup) => wakeup.id === deferredWakeupId)).toMatchObject({
      status: "claimed",
      reason: "issue_comment_mentioned",
      source: "automation",
    });

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      wakeupRequestId: deferredWakeupId,
      status: "running",
      invocationSource: "automation",
    });
    expect(runs[0]?.contextSnapshot).toMatchObject({
      issueId,
      wakeReason: "issue_comment_mentioned",
      wakeSource: "comment.mention",
      wakeCommentId,
    });
  });

  it("skips timer heartbeats without actionable work and records pending wakeup diagnostics", async () => {
    await disableExistingTimerAgents();
    const createdAt = new Date("2026-04-27T06:40:00.000Z");
    const tickAt = new Date("2026-04-27T06:45:00.000Z");
    const { orgId, agentId } = await seedAgentFixture({
      createdAt,
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60 } },
    });
    const blockedIssueId = await seedIssueFixture({ orgId });
    await seedLiveIssueExecution({ orgId, agentId, issueId: blockedIssueId });
    await seedRunlessWakeup({
      orgId,
      agentId,
      status: "deferred_issue_execution",
      issueId: blockedIssueId,
      requestedAt: new Date("2026-04-27T06:41:00.000Z"),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(tickAt);

    expect(result).toEqual({ checked: 1, enqueued: 0, skipped: 1 });
    expect(mockRuntimeAdapter.calls).toHaveLength(0);
    expect(await listRunStatuses(agentId)).toHaveLength(1);

    const wakeups = await listWakeupRequestsForAgent(agentId);
    const skipped = wakeups.find((wakeup) => wakeup.status === "skipped");
    expect(skipped).toMatchObject({
      reason: "heartbeat.preflight.pending_wakeup_request",
      runId: null,
    });
    expect(skipped?.payload).toMatchObject({
      preflight: {
        pendingWakeupCount: 1,
        pendingWakeupStatuses: { deferred_issue_execution: 1 },
      },
    });
  });

  it("allows timer heartbeats when visible reviewer work exists", async () => {
    await disableExistingTimerAgents();
    const createdAt = new Date("2026-04-27T06:30:00.000Z");
    const tickAt = new Date("2026-04-27T06:35:00.000Z");
    const { orgId, agentId } = await seedAgentFixture({
      createdAt,
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60 } },
    });
    await seedIssueFixture({ orgId, reviewerAgentId: agentId, status: "in_review" });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(tickAt);

    expect(result).toEqual({ checked: 1, enqueued: 1, skipped: 0 });
    await waitForCondition(async () => mockRuntimeAdapter.calls.length === 1);
    expect(await listRunStatuses(agentId)).toHaveLength(1);
  });

  it("skips timer heartbeats when only inbox-hidden automation execution work exists", async () => {
    await disableExistingTimerAgents();
    const createdAt = new Date("2026-04-27T07:00:00.000Z");
    const tickAt = new Date("2026-04-27T07:05:00.000Z");
    const { orgId, agentId } = await seedAgentFixture({
      createdAt,
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60 } },
    });
    await seedIssueFixture({ orgId, agentId, originKind: "automation_execution" });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(tickAt);

    expect(result).toEqual({ checked: 1, enqueued: 0, skipped: 1 });
    expect(mockRuntimeAdapter.calls).toHaveLength(0);
    expect(await listRunStatuses(agentId)).toHaveLength(0);

    const wakeups = await listWakeupRequestsForAgent(agentId);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      status: "skipped",
      reason: "heartbeat.preflight.no_actionable_work",
      runId: null,
    });
  });

  it("skips timer heartbeats when only reviewer inbox-hidden automation execution work exists", async () => {
    await disableExistingTimerAgents();
    const createdAt = new Date("2026-04-27T08:00:00.000Z");
    const tickAt = new Date("2026-04-27T08:05:00.000Z");
    const { orgId, agentId } = await seedAgentFixture({
      createdAt,
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60 } },
    });
    await seedIssueFixture({
      orgId,
      reviewerAgentId: agentId,
      status: "in_review",
      originKind: "automation_execution",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(tickAt);

    expect(result).toEqual({ checked: 1, enqueued: 0, skipped: 1 });
    expect(mockRuntimeAdapter.calls).toHaveLength(0);
    expect(await listRunStatuses(agentId)).toHaveLength(0);

    const wakeups = await listWakeupRequestsForAgent(agentId);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      status: "skipped",
      reason: "heartbeat.preflight.no_actionable_work",
      runId: null,
    });
  });

  it("skips timer heartbeats when only confirmed blocked reviewer handoff work exists", async () => {
    await disableExistingTimerAgents();
    const createdAt = new Date("2026-04-27T09:00:00.000Z");
    const tickAt = new Date("2026-04-27T09:05:00.000Z");
    const { orgId, agentId } = await seedAgentFixture({
      createdAt,
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60 } },
    });
    const issueId = await seedIssueFixture({ orgId, reviewerAgentId: agentId, status: "blocked" });
    await db.insert(activityLog).values([
      {
        orgId,
        actorType: "agent",
        actorId: agentId,
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        agentId,
        details: { status: "blocked" },
        createdAt: new Date("2026-04-27T09:01:00.000Z"),
      },
      {
        orgId,
        actorType: "agent",
        actorId: agentId,
        action: "issue.review_decision_recorded",
        entityType: "issue",
        entityId: issueId,
        agentId,
        details: { decision: "blocked", outcome: "human_handoff", operatorActionRequired: true },
        createdAt: new Date("2026-04-27T09:02:00.000Z"),
      },
    ]);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(tickAt);

    expect(result).toEqual({ checked: 1, enqueued: 0, skipped: 1 });
    expect(mockRuntimeAdapter.calls).toHaveLength(0);
    expect(await listRunStatuses(agentId)).toHaveLength(0);

    const wakeups = await listWakeupRequestsForAgent(agentId);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      status: "skipped",
      reason: "heartbeat.preflight.no_actionable_work",
      runId: null,
    });
  });

  it("cancels queued runs whose linked issue is already done before runtime start", async () => {
    const { orgId, agentId } = await seedAgentFixture(1);
    const issueId = await seedIssueFixture({ orgId, agentId, status: "done" });
    await seedQueuedRun({
      orgId,
      agentId,
      taskKey: `issue:${issueId}`,
      issueId,
      createdAt: new Date("2026-04-27T09:30:00.000Z"),
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();

    expect(mockRuntimeAdapter.calls).toHaveLength(0);
    const statuses = await listRunStatuses(agentId);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ status: "cancelled" });
    expect(await listLiveRunsForAgent(agentId)).toHaveLength(0);

    const wakeups = await listWakeupRequestsForAgent(agentId);
    expect(wakeups[0]).toMatchObject({
      status: "cancelled",
      runId: null,
    });
  });

  it("claims queued mention runs whose linked issue is already done", async () => {
    const { orgId, agentId } = await seedAgentFixture(1);
    const issueId = await seedIssueFixture({ orgId, agentId, status: "done" });
    const wakeCommentId = randomUUID();
    await seedQueuedRun({
      orgId,
      agentId,
      taskKey: `issue:${issueId}`,
      issueId,
      reason: "issue_comment_mentioned",
      wakeReason: "issue_comment_mentioned",
      wakeSource: "comment.mention",
      wakeCommentId,
      createdAt: new Date("2026-04-27T09:35:00.000Z"),
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const statuses = await listRunStatuses(agentId);
      const wakeups = await listWakeupRequestsForAgent(agentId);
      return statuses[0]?.status === "running" && wakeups[0]?.status === "claimed";
    });
    const statuses = await listRunStatuses(agentId);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ status: "running" });

    const wakeups = await listWakeupRequestsForAgent(agentId);
    expect(wakeups[0]).toMatchObject({
      status: "claimed",
      reason: "issue_comment_mentioned",
    });
  });
});
