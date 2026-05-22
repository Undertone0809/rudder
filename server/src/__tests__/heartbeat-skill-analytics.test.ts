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
  const externalConnectionString = process.env.RUDDER_HEARTBEAT_SKILLS_TEST_DATABASE_URL?.trim();
  if (externalConnectionString) {
    await applyPendingMigrations(externalConnectionString);
    return { connectionString: externalConnectionString, dataDir: "", instance: null };
  }

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
  let runLogDir = "";
  const previousRunLogBasePath = process.env.RUN_LOG_BASE_PATH;

  beforeAll(async () => {
    runLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-heartbeat-skill-logs-"));
    process.env.RUN_LOG_BASE_PATH = runLogDir;
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
    if (previousRunLogBasePath === undefined) delete process.env.RUN_LOG_BASE_PATH;
    else process.env.RUN_LOG_BASE_PATH = previousRunLogBasePath;
    if (runLogDir) {
      fs.rmSync(runLogDir, { recursive: true, force: true });
    }
  });

  it("aggregates recent used skills from adapter invoke events", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const secondAgentId = randomUUID();

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
    await db.insert(agents).values({
      id: secondAgentId,
      orgId,
      name: "Blake",
      role: "engineer",
      status: "idle",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const runOneId = randomUUID();
    const runTwoId = randomUUID();
    const runThreeId = randomUUID();
    const usedRunId = randomUUID();
    const oldRunId = randomUUID();
    const secondAgentRunId = randomUUID();

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
        id: usedRunId,
        orgId,
        agentId,
        invocationSource: "on_demand",
        status: "succeeded",
        createdAt: new Date("2026-04-19T10:00:00.000Z"),
        updatedAt: new Date("2026-04-19T10:05:00.000Z"),
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
      {
        id: secondAgentRunId,
        orgId,
        agentId: secondAgentId,
        invocationSource: "on_demand",
        status: "succeeded",
        createdAt: new Date("2026-04-20T18:00:00.000Z"),
        updatedAt: new Date("2026-04-20T18:05:00.000Z"),
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
          prompt: "Use these skills [$build-advisor](/workspace/.agents/skills/build-advisor/SKILL.md) [$screenshot](/workspace/.agents/skills/screenshot/SKILL.md)",
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
          prompt: "Use [$build-advisor](/workspace/.agents/skills/build-advisor/SKILL.md) and [$pua](/workspace/.agents/skills/pua/SKILL.md)",
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
          prompt: "Use [$pua](/workspace/.agents/skills/pua/SKILL.md)",
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
        payload: {
          loadedSkills: [
            { key: "unused-skill", runtimeName: "unused-skill", name: "Unused Skill" },
          ],
        },
        createdAt: new Date("2026-04-18T09:00:10.000Z"),
      },
      {
        orgId,
        runId: usedRunId,
        agentId,
        seq: 1,
        eventType: "adapter.invoke",
        stream: "system",
        level: "info",
        message: "adapter invocation",
        payload: {
          prompt: "Use [$build-advisor](/workspace/.agents/skills/build-advisor/SKILL.md)",
          usedSkills: [
            { key: "runtime-used", runtimeName: "runtime-used", name: "Runtime Used" },
          ],
          loadedSkills: [
            { key: "rudder/build-advisor", runtimeName: "build-advisor", name: "Build Advisor" },
            { key: "runtime-used", runtimeName: "runtime-used", name: "Runtime Used" },
          ],
        },
        createdAt: new Date("2026-04-19T10:00:05.000Z"),
      },
      {
        orgId,
        runId: usedRunId,
        agentId,
        seq: 2,
        eventType: "adapter.skill_usage",
        stream: "system",
        level: "info",
        message: "skill usage inferred from transcript",
        payload: {
          source: "transcript.skill_file_read",
          usedSkills: [
            { key: "skill-read", label: "skill-read" },
          ],
        },
        createdAt: new Date("2026-04-19T10:04:05.000Z"),
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
          prompt: "Use [$old-skill](/workspace/.agents/skills/old-skill/SKILL.md)",
          loadedSkills: [
            { key: "old-skill", runtimeName: "old-skill", name: "Old Skill" },
          ],
        },
        createdAt: new Date("2026-03-10T09:00:05.000Z"),
      },
      {
        orgId,
        runId: secondAgentRunId,
        agentId: secondAgentId,
        seq: 1,
        eventType: "adapter.invoke",
        stream: "system",
        level: "info",
        message: "adapter invocation",
        payload: {
          prompt: "Use [$deep-research](/workspace/.agents/skills/deep-research/SKILL.md) and [$pua](/workspace/.agents/skills/pua/SKILL.md)",
          loadedSkills: [
            { key: "deep-research", runtimeName: "deep-research", name: "Deep Research" },
            { key: "pua", runtimeName: "pua", name: "PUA" },
          ],
        },
        createdAt: new Date("2026-04-20T18:00:05.000Z"),
      },
    ]);

    const analytics = await svc.getAgentSkillAnalytics(agentId, {
      now: new Date("2026-04-22T12:00:00.000Z"),
    });

    expect(analytics.windowDays).toBe(30);
    expect(analytics.startDate).toBe("2026-03-24");
    expect(analytics.endDate).toBe("2026-04-22");
    expect(analytics.totalCount).toBe(2);
    expect(analytics.totalRunsWithSkills).toBe(1);
    expect(analytics.evidenceCounts).toEqual({ used: 2, requested: 0, loaded: 0 });
    expect(analytics.skills).toEqual([
      { key: "runtime-used", label: "runtime-used", count: 1, evidence: "used", evidenceCounts: { used: 1, requested: 0, loaded: 0 } },
      { key: "skill-read", label: "skill-read", count: 1, evidence: "used", evidenceCounts: { used: 1, requested: 0, loaded: 0 } },
    ]);

    const april20 = analytics.days.find((day) => day.date === "2026-04-20");
    expect(april20).toEqual({
      date: "2026-04-20",
      totalCount: 0,
      runCount: 0,
      evidenceCounts: { used: 0, requested: 0, loaded: 0 },
      skills: [],
    });

    const april19 = analytics.days.find((day) => day.date === "2026-04-19");
    expect(april19).toEqual({
      date: "2026-04-19",
      totalCount: 2,
      runCount: 1,
      evidenceCounts: { used: 2, requested: 0, loaded: 0 },
      skills: [
        { key: "runtime-used", label: "runtime-used", count: 1, evidence: "used", evidenceCounts: { used: 1, requested: 0, loaded: 0 } },
        { key: "skill-read", label: "skill-read", count: 1, evidence: "used", evidenceCounts: { used: 1, requested: 0, loaded: 0 } },
      ],
    });

    const april18 = analytics.days.find((day) => day.date === "2026-04-18");
    expect(april18).toEqual({
      date: "2026-04-18",
      totalCount: 0,
      runCount: 0,
      evidenceCounts: { used: 0, requested: 0, loaded: 0 },
      skills: [],
    });

    expect(analytics.days.find((day) => day.date === "2026-03-10")).toBeUndefined();

    const customAnalytics = await svc.getAgentSkillAnalytics(agentId, {
      startDate: "2026-04-20",
      endDate: "2026-04-20",
    });

    expect(customAnalytics.windowDays).toBe(1);
    expect(customAnalytics.startDate).toBe("2026-04-20");
    expect(customAnalytics.endDate).toBe("2026-04-20");
    expect(customAnalytics.totalCount).toBe(0);
    expect(customAnalytics.totalRunsWithSkills).toBe(0);
    expect(customAnalytics.evidenceCounts).toEqual({ used: 0, requested: 0, loaded: 0 });
    expect(customAnalytics.days).toEqual([
      {
        date: "2026-04-20",
        totalCount: 0,
        runCount: 0,
        evidenceCounts: { used: 0, requested: 0, loaded: 0 },
        skills: [],
      },
    ]);

    const organizationAnalytics = await svc.getOrganizationSkillAnalytics(orgId, {
      now: new Date("2026-04-22T12:00:00.000Z"),
    });

    expect(organizationAnalytics.agentId).toBe("__all__");
    expect(organizationAnalytics.orgId).toBe(orgId);
    expect(organizationAnalytics.totalCount).toBe(2);
    expect(organizationAnalytics.totalRunsWithSkills).toBe(1);
    expect(organizationAnalytics.evidenceCounts).toEqual({ used: 2, requested: 0, loaded: 0 });
    expect(organizationAnalytics.skills).toEqual([
      { key: "runtime-used", label: "runtime-used", count: 1, evidence: "used", evidenceCounts: { used: 1, requested: 0, loaded: 0 } },
      { key: "skill-read", label: "skill-read", count: 1, evidence: "used", evidenceCounts: { used: 1, requested: 0, loaded: 0 } },
    ]);

    const orgApril20 = organizationAnalytics.days.find((day) => day.date === "2026-04-20");
    expect(orgApril20).toEqual({
      date: "2026-04-20",
      totalCount: 0,
      runCount: 0,
      evidenceCounts: { used: 0, requested: 0, loaded: 0 },
      skills: [],
    });
  });

  it("infers used skills from short SKILL.md paths in stored local runtime logs", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const logRef = path.join(orgId, agentId, `${runId}.ndjson`);
    const command = [
      "cat build-advisor/SKILL.md",
      "cat ./screenshot/SKILL.md",
      "cat skills/deep-research/SKILL.md",
      "cat /tmp/skills/pua/SKILL.md",
      "cat SKILL.md",
    ].join(" && ");
    const chunk = `${JSON.stringify({
      type: "item.started",
      item: {
        id: "item_1",
        type: "command_execution",
        command,
        status: "in_progress",
      },
    })}\n`;
    const logContent = `${JSON.stringify({
      ts: "2026-04-21T10:00:05.000Z",
      stream: "stdout",
      chunk,
    })}\n`;

    fs.mkdirSync(path.dirname(path.join(runLogDir, logRef)), { recursive: true });
    fs.writeFileSync(path.join(runLogDir, logRef), logContent, "utf8");

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
      name: "Wesley",
      role: "engineer",
      status: "idle",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      orgId,
      agentId,
      invocationSource: "on_demand",
      status: "succeeded",
      createdAt: new Date("2026-04-21T10:00:00.000Z"),
      updatedAt: new Date("2026-04-21T10:05:00.000Z"),
      logStore: "local_file",
      logRef,
      logBytes: Buffer.byteLength(logContent, "utf8"),
    });

    const analytics = await svc.getAgentSkillAnalytics(agentId, {
      startDate: "2026-04-21",
      endDate: "2026-04-21",
    });

    expect(analytics.totalCount).toBe(4);
    expect(analytics.totalRunsWithSkills).toBe(1);
    expect(analytics.evidenceCounts).toEqual({ used: 4, requested: 0, loaded: 0 });
    expect(analytics.skills).toEqual([
      { key: "build-advisor", label: "build-advisor", count: 1, evidence: "used", evidenceCounts: { used: 1, requested: 0, loaded: 0 } },
      { key: "deep-research", label: "deep-research", count: 1, evidence: "used", evidenceCounts: { used: 1, requested: 0, loaded: 0 } },
      { key: "pua", label: "pua", count: 1, evidence: "used", evidenceCounts: { used: 1, requested: 0, loaded: 0 } },
      { key: "screenshot", label: "screenshot", count: 1, evidence: "used", evidenceCounts: { used: 1, requested: 0, loaded: 0 } },
    ]);
    expect(analytics.days).toEqual([
      {
        date: "2026-04-21",
        totalCount: 4,
        runCount: 1,
        evidenceCounts: { used: 4, requested: 0, loaded: 0 },
        skills: [
          { key: "build-advisor", label: "build-advisor", count: 1, evidence: "used", evidenceCounts: { used: 1, requested: 0, loaded: 0 } },
          { key: "deep-research", label: "deep-research", count: 1, evidence: "used", evidenceCounts: { used: 1, requested: 0, loaded: 0 } },
          { key: "pua", label: "pua", count: 1, evidence: "used", evidenceCounts: { used: 1, requested: 0, loaded: 0 } },
          { key: "screenshot", label: "screenshot", count: 1, evidence: "used", evidenceCounts: { used: 1, requested: 0, loaded: 0 } },
        ],
      },
    ]);
  });
});
