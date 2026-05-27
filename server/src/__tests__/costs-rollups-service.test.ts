import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  applyPendingMigrations,
  costEvents,
  costMonthlySpendRollups,
  createDb,
  ensurePostgresDatabase,
  organizations,
} from "@rudderhq/db";
import { costService } from "../services/costs.js";

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
  }, 20_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(costMonthlySpendRollups);
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
});
