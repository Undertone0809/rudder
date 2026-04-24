import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  organizationSkills,
  organizations,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { heartbeatService } from "../services/heartbeat.ts";

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-passive-closeout-"));
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

describe("heartbeat passive issue closeout", () => {
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
        await db.delete(issueComments);
        await db.delete(issues);
        await db.delete(heartbeatRunEvents);
        await db.delete(heartbeatRuns);
        await db.delete(agentTaskSessions);
        await db.delete(agentRuntimeState);
        await db.delete(agentWakeupRequests);
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

  async function seedFixture(input?: {
    agentRuntimeConfig?: Record<string, unknown>;
    runtimeConfig?: Record<string, unknown>;
    issueStatus?: "todo" | "in_progress";
  }) {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `P${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const orgName = `Passive Closeout ${orgId.slice(0, 6)}`;

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
      name: "Builder",
      role: "engineer",
      status: "idle",
      agentRuntimeType: "process",
      agentRuntimeConfig: input?.agentRuntimeConfig ?? {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        timeoutSec: 5,
      },
      runtimeConfig: input?.runtimeConfig ?? {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Close out the issue",
      description: "The run must leave an issue close-out signal.",
      status: input?.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { orgId, agentId, issueId };
  }

  async function wakeIssueRun(input: {
    agentId: string;
    issueId: string;
    reason?: string;
    passiveFollowup?: Record<string, unknown>;
  }) {
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(input.agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: input.reason ?? "issue_assigned",
      payload: { issueId: input.issueId },
      requestedByActorType: "system",
      requestedByActorId: "test",
      contextSnapshot: {
        issueId: input.issueId,
        taskId: input.issueId,
        taskKey: input.issueId,
        wakeReason: input.reason ?? "issue_assigned",
        wakeSource: input.reason === "issue_passive_followup" ? "passive_issue_followup" : "assignment",
        issue: {
          id: input.issueId,
          title: "Close out the issue",
          status: "in_progress",
          priority: "medium",
          description: "The run must leave an issue close-out signal.",
        },
        ...(input.passiveFollowup ? { passiveFollowup: input.passiveFollowup } : {}),
      },
    });
    if (!run) throw new Error("Expected wakeup to create a run");
    return run;
  }

  async function getRun(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function getIssue(issueId: string) {
    return db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
  }

  it("queues a same-agent passive follow-up when a successful issue run exits without close-out", async () => {
    const { agentId, issueId } = await seedFixture();
    const run = await wakeIssueRun({ agentId, issueId });

    const followup = await waitFor(async () => {
      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      return runs.find((row) => row.id !== run.id) ?? null;
    });

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    expect(followup).toMatchObject({
      agentId,
      status: "queued",
      invocationSource: "automation",
      triggerDetail: "system",
    });
    expect(followup?.contextSnapshot).toMatchObject({
      issueId,
      wakeReason: "issue_passive_followup",
      passiveFollowup: {
        originRunId: run.id,
        previousRunId: run.id,
        attempt: 1,
        maxAttempts: 2,
        reason: "missing_closure",
      },
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, followup?.wakeupRequestId ?? ""))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_passive_followup");
    expect(new Date(wakeup?.requestedAt ?? 0).getTime()).toBeGreaterThan(Date.now());

    const issue = await getIssue(issueId);
    expect(issue?.executionRunId).toBe(followup?.id);
    expect(issue?.status).toBe("in_progress");
  });

  it("does not queue passive follow-up when the run leaves a run-attributed progress comment", async () => {
    const { agentId, issueId, orgId } = await seedFixture({
      agentRuntimeConfig: {
        command: process.execPath,
        args: ["-e", "setTimeout(() => process.exit(0), 750)"],
        timeoutSec: 5,
      },
    });
    const run = await wakeIssueRun({ agentId, issueId });

    await waitFor(async () => {
      const current = await getRun(run.id);
      return current?.status === "running" ? current : null;
    });

    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId,
      orgId,
      issueId,
      authorAgentId: agentId,
      body: "Progress: finished the first chunk and will continue next run.",
    });
    await db.insert(activityLog).values({
      orgId,
      actorType: "agent",
      actorId: agentId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issueId,
      agentId,
      runId: run.id,
      details: { commentId },
    });

    await waitFor(async () => {
      const issue = await getIssue(issueId);
      return issue?.executionRunId === null ? issue : null;
    });

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
  });

  it("does not queue passive follow-up when the run moves the issue out of trigger statuses", async () => {
    const { agentId, issueId } = await seedFixture({
      agentRuntimeConfig: {
        command: process.execPath,
        args: ["-e", "setTimeout(() => process.exit(0), 750)"],
        timeoutSec: 5,
      },
    });
    const run = await wakeIssueRun({ agentId, issueId });

    await waitFor(async () => {
      const current = await getRun(run.id);
      return current?.status === "running" ? current : null;
    });

    await db
      .update(issues)
      .set({
        status: "done",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(issues.id, issueId));

    await waitFor(async () => {
      const issue = await getIssue(issueId);
      return issue?.executionRunId === null ? issue : null;
    });

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
  });

  it("does not queue passive follow-up when timer heartbeat continuity is near-term", async () => {
    const { agentId, issueId } = await seedFixture({
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 300,
        },
      },
    });
    const run = await wakeIssueRun({ agentId, issueId });

    await waitFor(async () => {
      const issue = await getIssue(issueId);
      return issue?.executionRunId === null ? issue : null;
    });

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
  });

  it("stops after max passive follow-up attempts and emits operator review activity", async () => {
    const { agentId, issueId } = await seedFixture();
    const originRunId = randomUUID();
    const run = await wakeIssueRun({
      agentId,
      issueId,
      reason: "issue_passive_followup",
      passiveFollowup: {
        originRunId,
        previousRunId: randomUUID(),
        attempt: 2,
        maxAttempts: 2,
        reason: "missing_closure",
        queuedAt: new Date().toISOString(),
      },
    });

    const reviewEvent = await waitFor(async () => {
      return db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "issue.closure_needs_operator_review"))
        .then((rows) => rows[0] ?? null);
    });

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);

    expect(reviewEvent).toMatchObject({
      actorType: "system",
      actorId: "issue_closure_governance",
      entityType: "issue",
      entityId: issueId,
      runId: run.id,
    });
    expect(reviewEvent?.details).toMatchObject({
      originRunId,
      previousRunId: run.id,
      attempts: 2,
      maxAttempts: 2,
      reason: "missing_closure",
    });
  });
});
