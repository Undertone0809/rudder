import {
  activityLog,
  agents,
  applyPendingMigrations,
  costEvents,
  costMonthlySpendRollups,
  createDb,
  ensurePostgresDatabase,
  heartbeatRuns,
  issues,
  organizations,
  projects,
} from "@rudderhq/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { costService } from "../services/costs.js";

const mockBudgetService = vi.hoisted(() => ({
  evaluateCostEvent: vi.fn(),
}));

vi.mock("../services/budgets.js", () => ({
  budgetService: () => mockBudgetService,
}));

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
  const externalConnectionString = process.env.RUDDER_COSTS_ROLLUPS_TEST_DATABASE_URL?.trim();
  if (externalConnectionString) {
    const parsed = new URL(externalConnectionString);
    const databaseName = parsed.pathname.replace(/^\//, "");
    parsed.pathname = "/postgres";
    await ensurePostgresDatabase(parsed.toString(), databaseName);
    await applyPendingMigrations(externalConnectionString);
    return { connectionString: externalConnectionString, dataDir: "", instance: null };
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-costs-rollups-"));
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

function currentMonthDate() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 12, 0, 0, 0, 0));
}

function previousMonthDate() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 12, 0, 0, 0, 0));
}

describe("costService monthly spend rollups", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 60_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.delete(costEvents);
    await db.delete(costMonthlySpendRollups);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await db?.$client?.end?.({ timeout: 1 });
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  async function seedOrgAndAgent() {
    const orgId = randomUUID();
    const agentId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Rollup Test",
      urlKey: `rollup-test-${orgId.slice(0, 8)}`,
      issuePrefix: "CRT",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Cost Agent",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { orgId, agentId };
  }

  it("persists current-month rollups and refreshed monthly spend fields", async () => {
    const { orgId, agentId } = await seedOrgAndAgent();
    const costs = costService(db);

    await costs.createEvent(orgId, {
      agentId,
      projectId: null,
      goalId: null,
      issueId: null,
      heartbeatRunId: null,
      billingCode: null,
      provider: "openai",
      model: "gpt-5",
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 20,
      costCents: 34,
      occurredAt: currentMonthDate(),
    });

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    const rollups = await db
      .select()
      .from(costMonthlySpendRollups)
      .where(eq(costMonthlySpendRollups.orgId, orgId));

    expect(agent?.spentMonthlyCents).toBe(34);
    expect(org?.spentMonthlyCents).toBe(34);
    expect(rollups.map((row) => ({
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      spendCents: row.spendCents,
    })).sort((a, b) => a.scopeType.localeCompare(b.scopeType))).toEqual([
      { scopeType: "agent", scopeId: agentId, spendCents: 34 },
      { scopeType: "organization", scopeId: orgId, spendCents: 34 },
    ]);
  });

  it("reconciles missing current-month rollups without adding historical event cost", async () => {
    const { orgId, agentId } = await seedOrgAndAgent();
    const costs = costService(db);

    await db.insert(costEvents).values({
      orgId,
      agentId,
      provider: "openai",
      biller: "openai",
      billingType: "metered_api",
      model: "gpt-5",
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 20,
      costCents: 20,
      occurredAt: currentMonthDate(),
    });

    await costs.createEvent(orgId, {
      agentId,
      projectId: null,
      goalId: null,
      issueId: null,
      heartbeatRunId: null,
      billingCode: null,
      provider: "openai",
      model: "gpt-5",
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 20,
      costCents: 99,
      occurredAt: previousMonthDate(),
    });

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    const currentRollups = await db
      .select()
      .from(costMonthlySpendRollups)
      .where(and(
        eq(costMonthlySpendRollups.orgId, orgId),
        eq(costMonthlySpendRollups.spendCents, 20),
      ));

    expect(agent?.spentMonthlyCents).toBe(20);
    expect(org?.spentMonthlyCents).toBe(20);
    expect(currentRollups).toHaveLength(2);
  });

  it("records heartbeat usage and cost exactly once under concurrent reconciliation", async () => {
    const { orgId, agentId } = await seedOrgAndAgent();
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        orgId,
        agentId,
        status: "timed_out",
        invocationSource: "on_demand",
        finishedAt: new Date(),
      })
      .returning();
    const costs = costService(db);
    let onInsertCalls = 0;

    await costs.createEvent(orgId, {
      agentId,
      heartbeatRunId: run!.id,
      provider: "manual",
      biller: "manual",
      billingType: "metered_api",
      model: "operator-entry",
      inputTokens: 1,
      outputTokens: 0,
      costCents: 1,
      occurredAt: currentMonthDate(),
    });

    const results = await Promise.all(Array.from({ length: 10 }, () =>
      costs.createHeartbeatRunEventOnce(orgId, {
        agentId,
        heartbeatRunId: run!.id,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 10,
        costCents: 25,
        occurredAt: currentMonthDate(),
      }, async () => {
        onInsertCalls += 1;
      })));

    expect(results.filter((result) => result.inserted)).toHaveLength(1);
    expect(onInsertCalls).toBe(1);
    const events = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.heartbeatRunId, run!.id));
    expect(events).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({
      idempotencyKey: `heartbeat-run-finalizer:${run!.id}`,
      costCents: 25,
      inputTokens: 100,
      outputTokens: 10,
    }));

    const rollups = await db
      .select()
      .from(costMonthlySpendRollups)
      .where(eq(costMonthlySpendRollups.orgId, orgId));
    expect(rollups).toHaveLength(2);
    expect(rollups.every((row) => row.spendCents === 26)).toBe(true);
  });

  it("adopts a matching pre-idempotency heartbeat finalizer without charging twice", async () => {
    const { orgId, agentId } = await seedOrgAndAgent();
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        orgId,
        agentId,
        status: "failed",
        invocationSource: "on_demand",
        finishedAt: new Date(),
      })
      .returning();
    const costs = costService(db);
    const payload = {
      agentId,
      heartbeatRunId: run!.id,
      provider: "openai",
      biller: "openai",
      billingType: "metered_api" as const,
      model: "gpt-5",
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 10,
      costCents: 25,
      occurredAt: currentMonthDate(),
    };
    await costs.createEvent(orgId, payload);
    let onInsertCalls = 0;

    const replay = await costs.createHeartbeatRunEventOnce(orgId, {
      ...payload,
      occurredAt: new Date(payload.occurredAt.getTime() + 60_000),
    }, async () => {
      onInsertCalls += 1;
    });

    expect(replay.inserted).toBe(false);
    expect(onInsertCalls).toBe(0);
    const events = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, run!.id));
    expect(events).toHaveLength(1);
    expect(events[0]?.idempotencyKey).toBe(`heartbeat-run-finalizer:${run!.id}`);
    const rollups = await db
      .select()
      .from(costMonthlySpendRollups)
      .where(eq(costMonthlySpendRollups.orgId, orgId));
    expect(rollups).toHaveLength(2);
    expect(rollups.every((row) => row.spendCents === 25)).toBe(true);
  });

  it("replays budget enforcement after an idempotent finalizer event already committed", async () => {
    const { orgId, agentId } = await seedOrgAndAgent();
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        orgId,
        agentId,
        invocationSource: "on_demand",
        status: "failed",
      })
      .returning();
    const costs = costService(db);
    let onInsertCalls = 0;
    const payload = {
      agentId,
      heartbeatRunId: run!.id,
      provider: "openai",
      biller: "openai",
      billingType: "metered_api" as const,
      model: "gpt-5",
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 10,
      costCents: 25,
      occurredAt: currentMonthDate(),
    };
    mockBudgetService.evaluateCostEvent
      .mockRejectedValueOnce(new Error("budget hook interrupted after ledger commit"))
      .mockResolvedValueOnce(undefined);

    await expect(costs.createHeartbeatRunEventOnce(orgId, payload, async () => {
      onInsertCalls += 1;
    })).rejects.toThrow("budget hook interrupted");
    const replay = await costs.createHeartbeatRunEventOnce(orgId, payload, async () => {
      onInsertCalls += 1;
    });

    expect(replay.inserted).toBe(false);
    expect(onInsertCalls).toBe(1);
    expect(mockBudgetService.evaluateCostEvent).toHaveBeenCalledTimes(2);
    const events = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, run!.id));
    expect(events).toHaveLength(1);
  });

  it("aggregates explicit UTC hour and day trend buckets", async () => {
    const { orgId, agentId } = await seedOrgAndAgent();
    await db.insert(costEvents).values([
      {
        orgId,
        agentId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 10,
        costCents: 25,
        occurredAt: new Date("2026-06-19T10:15:00.000Z"),
      },
      {
        orgId,
        agentId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 200,
        cachedInputTokens: 40,
        outputTokens: 20,
        costCents: 50,
        occurredAt: new Date("2026-06-19T11:05:00.000Z"),
      },
    ]);
    const costs = costService(db);
    const range = {
      from: new Date("2026-06-19T10:00:00.000Z"),
      to: new Date("2026-06-19T11:59:59.999Z"),
    };

    const hourly = await costs.trend(orgId, range, "hour");
    const daily = await costs.trend(orgId, range, "day");

    expect(hourly.map((row) => ({ date: row.date, costCents: row.costCents }))).toEqual([
      { date: "2026-06-19T10:00:00.000Z", costCents: 25 },
      { date: "2026-06-19T11:00:00.000Z", costCents: 50 },
    ]);
    expect(daily.map((row) => ({ date: row.date, costCents: row.costCents }))).toEqual([
      { date: "2026-06-19", costCents: 75 },
    ]);
  });

  it("clips and cumulatively sums each started run once within the selected range", async () => {
    const { orgId, agentId } = await seedOrgAndAgent();
    await db.insert(heartbeatRuns).values([
      {
        orgId,
        agentId,
        status: "completed",
        startedAt: new Date("2026-06-19T09:00:00.000Z"),
        finishedAt: new Date("2026-06-19T10:30:00.000Z"),
      },
      {
        orgId,
        agentId,
        status: "completed",
        startedAt: new Date("2026-06-19T10:15:00.000Z"),
        finishedAt: new Date("2026-06-19T11:15:00.000Z"),
      },
      {
        orgId,
        agentId,
        status: "running",
        startedAt: new Date("2026-06-19T10:30:00.000Z"),
        finishedAt: null,
      },
      {
        orgId,
        agentId,
        status: "completed",
        startedAt: new Date("2026-06-19T10:30:00.000Z"),
        finishedAt: new Date("2026-06-19T11:00:00.000Z"),
      },
      {
        orgId,
        agentId,
        status: "queued",
        startedAt: null,
        finishedAt: null,
      },
    ]);

    const summary = await costService(db).summary(orgId, {
      from: new Date("2026-06-19T10:00:00.000Z"),
      to: new Date("2026-06-19T12:00:00.000Z"),
    });

    expect(summary.activeDurationMs).toBe(210 * 60_000);
  });

  it("includes unattributed cost events in project aggregation totals", async () => {
    const { orgId, agentId } = await seedOrgAndAgent();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      orgId,
      name: "Attributed Project",
    });
    const foreignOrgId = randomUUID();
    await db.insert(organizations).values({
      id: foreignOrgId,
      name: "Foreign Rollup Test",
      urlKey: `foreign-rollup-${foreignOrgId.slice(0, 8)}`,
      issuePrefix: foreignOrgId.replaceAll("-", "").slice(0, 6).toUpperCase(),
      requireBoardApprovalForNewAgents: false,
    });
    const foreignProjectId = randomUUID();
    await db.insert(projects).values({
      id: foreignProjectId,
      orgId: foreignOrgId,
      name: "Foreign Project",
    });
    await db.insert(costEvents).values([
      {
        orgId,
        agentId,
        projectId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 10,
        costCents: 25,
        occurredAt: new Date("2026-06-19T10:15:00.000Z"),
      },
      {
        orgId,
        agentId,
        projectId: null,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 200,
        cachedInputTokens: 40,
        outputTokens: 20,
        costCents: 50,
        occurredAt: new Date("2026-06-19T10:45:00.000Z"),
      },
      {
        orgId,
        agentId,
        projectId: foreignProjectId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 50,
        cachedInputTokens: 10,
        outputTokens: 5,
        costCents: 30,
        occurredAt: new Date("2026-06-19T11:00:00.000Z"),
      },
    ]);

    const rows = await costService(db).byProject(orgId);

    expect(rows.map((row) => ({
      projectId: row.projectId,
      projectName: row.projectName,
      costCents: row.costCents,
    }))).toEqual([
      { projectId: null, projectName: null, costCents: 80 },
      { projectId, projectName: "Attributed Project", costCents: 25 },
    ]);
    expect(rows.reduce((sum, row) => sum + row.costCents, 0)).toBe(105);
  });

  it("attributes a run to only its latest linked project", async () => {
    const { orgId, agentId } = await seedOrgAndAgent();
    const olderProjectId = randomUUID();
    const latestProjectId = randomUUID();
    await db.insert(projects).values([
      { id: olderProjectId, orgId, name: "Older Project" },
      { id: latestProjectId, orgId, name: "Latest Project" },
    ]);

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      orgId,
      agentId,
      status: "completed",
      startedAt: new Date("2026-06-19T10:00:00.000Z"),
      finishedAt: new Date("2026-06-19T10:30:00.000Z"),
    });

    const olderIssueId = randomUUID();
    const latestIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: olderIssueId,
        orgId,
        projectId: olderProjectId,
        title: "Older project issue",
      },
      {
        id: latestIssueId,
        orgId,
        projectId: latestProjectId,
        title: "Latest project issue",
      },
    ]);
    await db.insert(activityLog).values([
      {
        orgId,
        actorId: "test",
        action: "issue.updated",
        entityType: "issue",
        entityId: olderIssueId,
        runId,
        createdAt: new Date("2026-06-19T10:05:00.000Z"),
      },
      {
        orgId,
        actorId: "test",
        action: "issue.updated",
        entityType: "issue",
        entityId: latestIssueId,
        runId,
        createdAt: new Date("2026-06-19T10:10:00.000Z"),
      },
    ]);
    await db.insert(costEvents).values({
      orgId,
      agentId,
      heartbeatRunId: runId,
      provider: "openai",
      biller: "openai",
      billingType: "metered_api",
      model: "gpt-5",
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 10,
      costCents: 40,
      occurredAt: new Date("2026-06-19T10:15:00.000Z"),
    });

    const costs = costService(db);
    const range = {
      from: new Date("2026-06-19T10:00:00.000Z"),
      to: new Date("2026-06-19T10:59:59.999Z"),
    };
    const [summary, rows, olderTrend, latestTrend] = await Promise.all([
      costs.summary(orgId, range),
      costs.byProject(orgId, range),
      costs.trend(orgId, range, "hour", { projectId: olderProjectId }),
      costs.trend(orgId, range, "hour", { projectId: latestProjectId }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId: latestProjectId,
      projectName: "Latest Project",
      costCents: 40,
    });
    expect(rows.reduce((sum, row) => sum + row.costCents, 0)).toBe(summary.spendCents);
    expect(olderTrend).toEqual([]);
    expect(latestTrend.map((row) => row.costCents)).toEqual([40]);
  });
});
