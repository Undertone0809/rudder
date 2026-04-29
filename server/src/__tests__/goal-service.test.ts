import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  applyPendingMigrations,
  automations,
  costEvents,
  createDb,
  ensurePostgresDatabase,
  financeEvents,
  goals,
  issues,
  organizations,
  projectGoals,
  projects,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { goalService } from "../services/goals.js";

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-goal-service-"));
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

describe("goalService lifecycle guards", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof goalService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    svc = goalService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(financeEvents);
    await db.delete(costEvents);
    await db.delete(automations);
    await db.delete(issues);
    await db.delete(projectGoals);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  async function seedOrganization(name = "Rudder") {
    const orgId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name,
      urlKey: deriveOrganizationUrlKey(`${name}-${orgId}`),
      issuePrefix: `T${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return orgId;
  }

  async function seedAgent(orgId: string, name = "CodexCoder") {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name,
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedGoal(orgId: string, overrides: Partial<typeof goals.$inferInsert> = {}) {
    const goalId = overrides.id ?? randomUUID();
    await db.insert(goals).values({
      id: goalId,
      orgId,
      title: "Goal",
      level: "organization",
      status: "active",
      parentId: null,
      ...overrides,
    });
    return goalId;
  }

  it("hard-deletes a safe unused goal", async () => {
    const orgId = await seedOrganization();
    await seedGoal(orgId, { title: "Root to keep" });
    const deletedGoalId = await seedGoal(orgId, { title: "Mistaken goal" });

    const deleted = await svc.remove(deletedGoalId);

    expect(deleted?.id).toBe(deletedGoalId);
    const remaining = await db
      .select({ id: goals.id })
      .from(goals)
      .where(eq(goals.id, deletedGoalId));
    expect(remaining).toEqual([]);
  });

  it("blocks referenced goal deletion with a dependency summary", async () => {
    const orgId = await seedOrganization();
    const agentId = await seedAgent(orgId);
    await seedGoal(orgId, { title: "Root to keep" });
    const goalId = await seedGoal(orgId, { title: "Operational goal" });
    const projectId = randomUUID();

    await db.insert(projects).values({
      id: projectId,
      orgId,
      goalId,
      name: "Goal Center",
      status: "in_progress",
    });
    await db.insert(projectGoals).values({ projectId, goalId, orgId });
    await db.insert(issues).values({
      id: randomUUID(),
      orgId,
      projectId,
      goalId,
      title: "Expose goal blockers",
      status: "todo",
      priority: "medium",
      identifier: "TST-1",
    });
    await db.insert(automations).values({
      id: randomUUID(),
      orgId,
      projectId,
      goalId,
      title: "Daily goal review",
      assigneeAgentId: agentId,
      status: "active",
    });
    await db.insert(costEvents).values({
      id: randomUUID(),
      orgId,
      agentId,
      goalId,
      provider: "openai",
      biller: "openai",
      billingType: "token",
      model: "gpt-test",
      costCents: 12,
      occurredAt: new Date("2026-04-30T08:00:00.000Z"),
    });
    await db.insert(financeEvents).values({
      id: randomUUID(),
      orgId,
      agentId,
      goalId,
      eventKind: "usage",
      direction: "debit",
      biller: "openai",
      amountCents: 12,
      currency: "USD",
      occurredAt: new Date("2026-04-30T08:00:00.000Z"),
    });

    await expect(svc.remove(goalId)).rejects.toMatchObject({
      status: 409,
      details: {
        canDelete: false,
        blockers: ["linked_projects", "linked_issues", "automations", "cost_events", "finance_events"],
        counts: {
          linkedProjects: 1,
          linkedIssues: 1,
          automations: 1,
          costEvents: 1,
          financeEvents: 1,
        },
      },
    });
  });

  it("blocks deletion of the last root organization goal", async () => {
    const orgId = await seedOrganization();
    const goalId = await seedGoal(orgId, { title: "Only root" });

    await expect(svc.remove(goalId)).rejects.toMatchObject({
      status: 409,
      details: {
        isLastRootOrganizationGoal: true,
        blockers: ["last_root_organization_goal"],
      },
    });
  });

  it("rejects cross-organization owner and parent updates", async () => {
    const orgId = await seedOrganization("Org A");
    const otherOrgId = await seedOrganization("Org B");
    const goalId = await seedGoal(orgId);
    const otherGoalId = await seedGoal(otherOrgId);
    const otherAgentId = await seedAgent(otherOrgId, "OtherAgent");

    await expect(svc.update(goalId, { ownerAgentId: otherAgentId })).rejects.toMatchObject({
      status: 422,
      message: "Goal owner must belong to the same organization",
    });
    await expect(svc.update(goalId, { parentId: otherGoalId })).rejects.toMatchObject({
      status: 422,
      message: "Goal parent must belong to the same organization",
    });
  });

  it("rejects self-parenting and parent cycles", async () => {
    const orgId = await seedOrganization();
    const parentId = await seedGoal(orgId, { title: "Parent" });
    const childId = await seedGoal(orgId, { title: "Child", parentId });

    await expect(svc.update(parentId, { parentId })).rejects.toMatchObject({
      status: 422,
      message: "Goal cannot be its own parent",
    });
    await expect(svc.update(parentId, { parentId: childId })).rejects.toMatchObject({
      status: 422,
      message: "Goal parent cannot create a cycle",
    });
  });
});
