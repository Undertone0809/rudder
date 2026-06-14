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
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { listObservedRuns } from "../services/run-intelligence.ts";

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
  const externalConnectionString = process.env.RUDDER_RUN_INTELLIGENCE_TEST_DATABASE_URL?.trim();
  if (externalConnectionString) {
    await applyPendingMigrations(externalConnectionString);
    return { connectionString: externalConnectionString, dataDir: "", instance: null };
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-run-intelligence-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const postgresLogs: string[] = [];
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "rudder",
    password: "rudder",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: (message) => postgresLogs.push(String(message)),
    onError: (message) => postgresLogs.push(String(message)),
  });
  try {
    await instance.initialise();
    await instance.start();
  } catch (error) {
    const details = postgresLogs.slice(-20).join("\n");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${details}`);
  }

  const adminConnectionString = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "rudder");
  const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

describe("listObservedRuns skill filters", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 40_000);

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

  it("keeps used and loaded skill evidence distinct", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const loadedOnlyRunId = randomUUID();
    const usedRunId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix: "RST",
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

    await db.insert(heartbeatRuns).values([
      {
        id: loadedOnlyRunId,
        orgId,
        agentId,
        invocationSource: "on_demand",
        status: "succeeded",
        createdAt: new Date("2026-06-10T10:00:00.000Z"),
        updatedAt: new Date("2026-06-10T10:05:00.000Z"),
      },
      {
        id: usedRunId,
        orgId,
        agentId,
        invocationSource: "on_demand",
        status: "failed",
        error: "Skill failed while optimizing evidence",
        createdAt: new Date("2026-06-11T10:00:00.000Z"),
        updatedAt: new Date("2026-06-11T10:05:00.000Z"),
      },
    ]);

    await db.insert(heartbeatRunEvents).values([
      {
        orgId,
        runId: loadedOnlyRunId,
        agentId,
        seq: 1,
        eventType: "adapter.invoke",
        stream: "system",
        level: "info",
        message: "adapter invocation",
        payload: {
          loadedSkillKeys: ["skill-optimizer"],
          loadedSkills: [
            { key: "skill-optimizer", label: "Skill Optimizer" },
          ],
        },
        createdAt: new Date("2026-06-10T10:00:05.000Z"),
      },
      {
        orgId,
        runId: usedRunId,
        agentId,
        seq: 1,
        eventType: "adapter.skill_usage",
        stream: "system",
        level: "info",
        message: "skill usage inferred from transcript",
        payload: {
          source: "transcript.skill_file_read",
          usedSkillKeys: ["skill-optimizer"],
          usedSkills: [
            { key: "skill-optimizer", label: "Skill Optimizer" },
          ],
        },
        createdAt: new Date("2026-06-11T10:01:00.000Z"),
      },
    ]);

    const usedResults = await listObservedRuns(db, {
      orgId,
      usedSkill: "skill-optimizer",
      loadedSkill: null,
      limit: 10,
    });

    expect(usedResults.map((row) => row.run.id)).toEqual([usedRunId]);
    expect(usedResults[0]?.skillEvidence).toMatchObject({
      evidenceType: "used",
      matchedSkillKey: "skill-optimizer",
      matchedSkillLabel: "Skill Optimizer",
      sourceEventType: "adapter.skill_usage",
      sourceEventCreatedAt: "2026-06-11T10:01:00.000Z",
    });
    expect(usedResults[0]?.skillEvidence?.sourceEventId).toEqual(expect.any(Number));
    expect(usedResults[0]?.errorSummary).toBe("Skill failed while optimizing evidence");

    const loadedResults = await listObservedRuns(db, {
      orgId,
      usedSkill: null,
      loadedSkill: "Skill Optimizer",
      limit: 10,
    });

    expect(loadedResults.map((row) => row.run.id)).toEqual([loadedOnlyRunId]);
    expect(loadedResults[0]?.skillEvidence).toMatchObject({
      evidenceType: "loaded",
      matchedSkillKey: "skill-optimizer",
      matchedSkillLabel: "Skill Optimizer",
      sourceEventType: "adapter.invoke",
      sourceEventCreatedAt: "2026-06-10T10:00:05.000Z",
    });
    expect(loadedResults[0]?.skillEvidence?.sourceEventId).toEqual(expect.any(Number));
  });
});
