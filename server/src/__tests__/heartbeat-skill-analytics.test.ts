import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  heartbeatRunEvents,
  heartbeatRuns,
  organizations,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-heartbeat-skills-"));
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

describe("heartbeatService.getAgentSkillAnalytics", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof heartbeatService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    svc = heartbeatService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("aggregates recent loaded skills from adapter invoke events", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix: "RUD",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Penelope",
      role: "ceo",
      status: "idle",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const runOneId = randomUUID();
    const runTwoId = randomUUID();
    const runThreeId = randomUUID();
    const oldRunId = randomUUID();

    await db.insert(heartbeatRuns).values([
      {
        id: runOneId,
        orgId,
        agentId,
        invocationSource: "on_demand",
        status: "succeeded",
        createdAt: new Date("2026-04-20T08:00:00.000Z"),
        updatedAt: new Date("2026-04-20T08:05:00.000Z"),
      },
      {
        id: runTwoId,
        orgId,
        agentId,
        invocationSource: "on_demand",
        status: "succeeded",
        createdAt: new Date("2026-04-20T16:00:00.000Z"),
        updatedAt: new Date("2026-04-20T16:05:00.000Z"),
      },
      {
        id: runThreeId,
        orgId,
        agentId,
        invocationSource: "on_demand",
        status: "succeeded",
        createdAt: new Date("2026-04-18T09:00:00.000Z"),
        updatedAt: new Date("2026-04-18T09:05:00.000Z"),
      },
      {
        id: oldRunId,
        orgId,
        agentId,
        invocationSource: "on_demand",
        status: "succeeded",
        createdAt: new Date("2026-03-10T09:00:00.000Z"),
        updatedAt: new Date("2026-03-10T09:05:00.000Z"),
      },
    ]);

    await db.insert(heartbeatRunEvents).values([
      {
        orgId,
        runId: runOneId,
        agentId,
        seq: 1,
        eventType: "adapter.invoke",
        stream: "system",
        level: "info",
        message: "adapter invocation",
        payload: {
          loadedSkills: [
            { key: "rudder/build-advisor", runtimeName: "build-advisor", name: "Build Advisor" },
            { key: "rudder/build-advisor", runtimeName: "build-advisor", name: "Build Advisor" },
            { key: "screenshot", runtimeName: "screenshot", name: "Screenshot" },
          ],
        },
        createdAt: new Date("2026-04-20T08:00:05.000Z"),
      },
      {
        orgId,
        runId: runTwoId,
        agentId,
        seq: 1,
        eventType: "adapter.invoke",
        stream: "system",
        level: "info",
        message: "adapter invocation",
        payload: {
          loadedSkills: [
            { key: "rudder/build-advisor", runtimeName: "build-advisor", name: "Build Advisor" },
            { key: "pua", runtimeName: "pua", name: "PUA" },
          ],
        },
        createdAt: new Date("2026-04-20T16:00:05.000Z"),
      },
      {
        orgId,
        runId: runThreeId,
        agentId,
        seq: 1,
        eventType: "adapter.invoke",
        stream: "system",
        level: "info",
        message: "adapter invocation",
        payload: {
          loadedSkills: [
            { key: "pua", runtimeName: "pua", name: "PUA" },
          ],
        },
        createdAt: new Date("2026-04-18T09:00:05.000Z"),
      },
      {
        orgId,
        runId: runThreeId,
        agentId,
        seq: 2,
        eventType: "adapter.invoke",
        stream: "system",
        level: "info",
        message: "adapter invocation",
        payload: {},
        createdAt: new Date("2026-04-18T09:00:10.000Z"),
      },
      {
        orgId,
        runId: oldRunId,
        agentId,
        seq: 1,
        eventType: "adapter.invoke",
        stream: "system",
        level: "info",
        message: "adapter invocation",
        payload: {
          loadedSkills: [
            { key: "old-skill", runtimeName: "old-skill", name: "Old Skill" },
          ],
        },
        createdAt: new Date("2026-03-10T09:00:05.000Z"),
      },
    ]);

    const analytics = await svc.getAgentSkillAnalytics(agentId, {
      now: new Date("2026-04-22T12:00:00.000Z"),
    });

    expect(analytics.windowDays).toBe(30);
    expect(analytics.startDate).toBe("2026-03-24");
    expect(analytics.endDate).toBe("2026-04-22");
    expect(analytics.totalCount).toBe(5);
    expect(analytics.totalRunsWithSkills).toBe(3);
    expect(analytics.skills).toEqual([
      { key: "rudder/build-advisor", label: "build-advisor", count: 2 },
      { key: "pua", label: "pua", count: 2 },
      { key: "screenshot", label: "screenshot", count: 1 },
    ]);

    const april20 = analytics.days.find((day) => day.date === "2026-04-20");
    expect(april20).toEqual({
      date: "2026-04-20",
      totalCount: 4,
      runCount: 2,
      skills: [
        { key: "rudder/build-advisor", label: "build-advisor", count: 2 },
        { key: "pua", label: "pua", count: 1 },
        { key: "screenshot", label: "screenshot", count: 1 },
      ],
    });

    const april18 = analytics.days.find((day) => day.date === "2026-04-18");
    expect(april18).toEqual({
      date: "2026-04-18",
      totalCount: 1,
      runCount: 1,
      skills: [
        { key: "pua", label: "pua", count: 1 },
      ],
    });

    expect(analytics.days.find((day) => day.date === "2026-03-10")).toBeUndefined();

    const customAnalytics = await svc.getAgentSkillAnalytics(agentId, {
      startDate: "2026-04-20",
      endDate: "2026-04-20",
    });

    expect(customAnalytics.windowDays).toBe(1);
    expect(customAnalytics.startDate).toBe("2026-04-20");
    expect(customAnalytics.endDate).toBe("2026-04-20");
    expect(customAnalytics.totalCount).toBe(4);
    expect(customAnalytics.totalRunsWithSkills).toBe(2);
    expect(customAnalytics.days).toEqual([
      {
        date: "2026-04-20",
        totalCount: 4,
        runCount: 2,
        skills: [
          { key: "rudder/build-advisor", label: "build-advisor", count: 2 },
          { key: "pua", label: "pua", count: 1 },
          { key: "screenshot", label: "screenshot", count: 1 },
        ],
      },
    ]);
  });
});
