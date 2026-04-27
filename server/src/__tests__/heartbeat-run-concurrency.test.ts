import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  heartbeatRuns,
  organizations,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";

const mockBudgetService = vi.hoisted(() => ({
  getInvocationBlock: vi.fn(),
}));

const mockRuntimeAdapter = vi.hoisted(() => {
  const calls: Array<{ runId: string; taskKey: string | null }> = [];

  return {
    calls,
    reset() {
      calls.length = 0;
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
        return await new Promise(() => {});
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
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  async function seedAgentFixture(maxConcurrentRuns?: number) {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const orgName = `Rudder ${orgId.slice(0, 6)}`;

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
      runtimeConfig: maxConcurrentRuns === undefined
        ? {}
        : { heartbeat: { maxConcurrentRuns } },
      permissions: {},
    });

    return { orgId, agentId };
  }

  async function seedQueuedRun(input: {
    orgId: string;
    agentId: string;
    taskKey: string;
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
      reason: "test_queue",
      payload: { taskKey: input.taskKey },
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
        taskId: input.taskKey,
        taskKey: input.taskKey,
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
});
