import { execute as executeCodexLocal } from "@rudderhq/agent-runtime-codex-local/server";
import {
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  applyPendingMigrations,
  chatConversations,
  chatMessages,
  costEvents,
  createDb,
  ensurePostgresDatabase,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  organizationSkills,
  organizations,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";

const mockBudgetService = vi.hoisted(() => ({
  evaluateCostEvent: vi.fn(),
  getInvocationBlock: vi.fn(),
}));

const mockRuntimeAdapter = vi.hoisted(() => ({
  execute: vi.fn(async () => ({
    summary: "preflight ok",
    resultJson: null,
    timedOut: false,
    exitCode: 0,
    errorMessage: null,
  })),
}));

const mockPreflight = vi.hoisted(() => ({
  fail: false,
  calls: [] as unknown[],
}));

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
    getServerAdapter: vi.fn(() => ({
      type: "codex_local",
      supportsLocalAgentJwt: false,
      execute: mockRuntimeAdapter.execute,
    })),
    findServerAdapter: vi.fn(() => ({
      type: "codex_local",
      supportsLocalAgentJwt: false,
      execute: mockRuntimeAdapter.execute,
    })),
    runningProcesses: new Map(),
  };
});

vi.mock("../services/managed-workspace-preflight.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/managed-workspace-preflight.js")>();
  return {
    ...actual,
    preflightManagedAgentWorkspace: vi.fn(async (input) => {
      mockPreflight.calls.push(input);
      if (mockPreflight.fail) {
        throw new actual.WorkspacePermissionPreflightError({
          kind: "life",
          path: "/tmp/rudder-unwritable-life",
          operation: "write_probe",
          code: "EACCES",
          message: "permission denied",
        });
      }
      return actual.preflightManagedAgentWorkspace(input);
    }),
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
  const externalConnectionString = process.env.RUDDER_HEARTBEAT_PREFLIGHT_TEST_DATABASE_URL?.trim();
  if (externalConnectionString) {
    await applyPendingMigrations(externalConnectionString);
    return { connectionString: externalConnectionString, dataDir: "", instance: null };
  }

  const dataDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "rudder-heartbeat-preflight-db-"));
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

async function waitForCondition(check: () => Promise<boolean>, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for test condition");
}

async function writeFakeCodexCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.RUDDER_TEST_CAPTURE_PATH;
const payload = {
  argv: process.argv.slice(2),
  prompt: fs.readFileSync(0, "utf8"),
  rudderEnvKeys: Object.keys(process.env)
    .filter((key) => key.startsWith("RUDDER_"))
    .sort(),
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } }));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

describe("heartbeat managed workspace preflight", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let rudderHome = "";
  let runLogDir = "";
  const previousRudderHome = process.env.RUDDER_HOME;
  const previousRudderInstanceId = process.env.RUDDER_INSTANCE_ID;
  const previousRunLogBasePath = process.env.RUN_LOG_BASE_PATH;

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  beforeEach(async () => {
    vi.clearAllMocks();
    mockBudgetService.evaluateCostEvent.mockResolvedValue(undefined);
    mockBudgetService.getInvocationBlock.mockResolvedValue(null);
    mockPreflight.fail = false;
    mockPreflight.calls = [];
    rudderHome = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-heartbeat-preflight-home-"));
    runLogDir = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-heartbeat-preflight-logs-"));
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "preflight-test";
    process.env.RUN_LOG_BASE_PATH = runLogDir;
  });

  afterEach(async () => {
    await db.delete(agentTaskSessions);
    await db.delete(costEvents);
    await db.delete(chatMessages);
    await db.delete(chatConversations);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentRuntimeState);
    await db.delete(agentWakeupRequests);
    await db.delete(organizationSkills);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(organizations);
    if (rudderHome) await fs.rm(rudderHome, { recursive: true, force: true });
    if (runLogDir) await fs.rm(runLogDir, { recursive: true, force: true });
    if (previousRudderHome === undefined) delete process.env.RUDDER_HOME;
    else process.env.RUDDER_HOME = previousRudderHome;
    if (previousRudderInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
    else process.env.RUDDER_INSTANCE_ID = previousRudderInstanceId;
    if (previousRunLogBasePath === undefined) delete process.env.RUN_LOG_BASE_PATH;
    else process.env.RUN_LOG_BASE_PATH = previousRunLogBasePath;
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
  });

  async function seedAgentFixture(agentRuntimeConfig: Record<string, unknown> = {}) {
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
      status: "idle",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig,
      runtimeConfig: {},
      permissions: {},
    });

    return { orgId, agentId, name: "Builder" };
  }

  async function getRun(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function getRunEvents(runId: string) {
    return db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
  }

  async function getAgent(agentId: string) {
    return db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
  }

  it("fails before adapter execution and records a workspace preflight event", async () => {
    const { agentId } = await seedAgentFixture();
    mockPreflight.fail = true;

    const run = await heartbeatService(db).wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "test_preflight_failure",
      contextSnapshot: { taskKey: "preflight:failure" },
    });

    expect(run?.id).toBeTruthy();
    await waitForCondition(async () => {
      const failedRun = await getRun(run!.id);
      if (failedRun?.status !== "failed") return false;
      const events = await getRunEvents(run!.id);
      return events.some((event) => event.eventType === "runtime.workspace_preflight_failed");
    });

    const failedRun = await getRun(run!.id);
    expect(failedRun).toEqual(expect.objectContaining({
      status: "failed",
      errorCode: "workspace_permission_repair_needed",
    }));
    const events = await getRunEvents(run!.id);
    expect(events).toEqual([
      expect.objectContaining({
        eventType: "runtime.workspace_preflight_failed",
        level: "error",
      }),
    ]);
    expect(mockRuntimeAdapter.execute).not.toHaveBeenCalled();
  });

  it("creates missing managed workspace directories before adapter execution", async () => {
    const agent = await seedAgentFixture();
    const agentHome = resolveDefaultAgentWorkspaceDir(agent.orgId, {
      id: agent.agentId,
      orgId: agent.orgId,
      name: agent.name,
    });

    await expect(fs.stat(agentHome)).rejects.toMatchObject({ code: "ENOENT" });

    const run = await heartbeatService(db).wakeup(agent.agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "test_preflight_success",
      contextSnapshot: { taskKey: "preflight:success" },
    });

    expect(run?.id).toBeTruthy();
    await waitForCondition(async () => {
      const succeededRun = await getRun(run!.id);
      if (succeededRun?.status !== "succeeded") return false;
      const events = await getRunEvents(run!.id);
      return events.some((event) => event.eventType === "lifecycle" && event.message === "run succeeded");
    });

    expect(mockRuntimeAdapter.execute).toHaveBeenCalledTimes(1);
    expect(mockPreflight.calls).toHaveLength(1);
    await expect(fs.stat(agentHome).then((stat) => stat.isDirectory())).resolves.toBe(true);
    await expect(fs.stat(path.join(agentHome, "instructions")).then((stat) => stat.isDirectory())).resolves.toBe(true);
    await expect(fs.stat(path.join(agentHome, "memory")).then((stat) => stat.isDirectory())).resolves.toBe(true);
    await expect(fs.stat(path.join(agentHome, "life")).then((stat) => stat.isDirectory())).resolves.toBe(true);
    await expect(fs.stat(path.join(agentHome, "skills")).then((stat) => stat.isDirectory())).resolves.toBe(true);
  });

  it("persists forbidden runtime skill marker evidence from adapter output", async () => {
    const forbiddenMarker = "ZST646_FORBIDDEN_GLOBAL_SKILL_LOADED";
    const { agentId } = await seedAgentFixture({
      runtimeSkillIsolation: {
        forbiddenMarkers: [forbiddenMarker],
      },
    });
    mockRuntimeAdapter.execute.mockImplementationOnce(async (ctx) => {
      await ctx.onMeta?.({
        agentRuntimeType: "codex_local",
        command: "codex",
        cwd: "/tmp/run-workspace",
        forbiddenMarkerObserved: false,
      });
      await ctx.onLog("stdout", `decoy loaded: ${forbiddenMarker}\n`);
      return {
        summary: "adapter completed after decoy leakage",
        resultJson: {
          summary: `final response repeated ${forbiddenMarker}`,
        },
        timedOut: false,
        exitCode: 0,
        errorMessage: null,
      };
    });

    const run = await heartbeatService(db).wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "test_forbidden_marker_observability",
      contextSnapshot: { taskKey: "runtime-skill-isolation:forbidden-marker" },
    });

    expect(run?.id).toBeTruthy();
    await waitForCondition(async () => {
      const latestRun = await getRun(run!.id);
      if (latestRun?.status !== "failed") return false;
      const events = await getRunEvents(run!.id);
      return events.some((event) => event.eventType === "adapter.forbidden_marker");
    });

    const latestRun = await getRun(run!.id);
    expect(latestRun).toMatchObject({
      status: "failed",
      errorCode: "runtime_skill_isolation_failed",
      error: "Forbidden runtime skill marker observed",
    });
    const events = await getRunEvents(run!.id);
    const markerEvent = events.find((event) => event.eventType === "adapter.forbidden_marker");
    expect(markerEvent).toMatchObject({
      eventType: "adapter.forbidden_marker",
      level: "error",
      message: "forbidden runtime skill marker observed",
      payload: {
        forbiddenMarkerObserved: true,
        forbiddenMarkerCount: 3,
        forbiddenMarkerEvidence: expect.arrayContaining([
          { marker: forbiddenMarker, source: "stdout_excerpt" },
          { marker: forbiddenMarker, source: "resultJson" },
          { marker: forbiddenMarker, source: "transcript" },
        ]),
      },
    });
  });

  it("fails a successful adapter run when forbidden marker evidence is nested in result JSON", async () => {
    const forbiddenMarker = "ZST646_FORBIDDEN_OPENCODE_NATIVE_SKILL";
    const { agentId } = await seedAgentFixture({
      runtimeSkillIsolation: {
        forbiddenMarkers: [forbiddenMarker],
      },
    });
    mockRuntimeAdapter.execute.mockImplementationOnce(async (ctx) => {
      await ctx.onMeta?.({
        agentRuntimeType: "opencode_local",
        command: "opencode",
        cwd: "/tmp/run-workspace",
        forbiddenMarkerObserved: false,
      });
      return {
        summary: "adapter completed",
        resultJson: {
          output: {
            steps: [
              {
                message: {
                  content: [
                    {
                      toolUse: {
                        name: "skill",
                        result: {
                          metadata: {
                            display: {
                              text: `loaded forbidden native skill ${forbiddenMarker}`,
                            },
                          },
                        },
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
        timedOut: false,
        exitCode: 0,
        errorMessage: null,
      };
    });

    const run = await heartbeatService(db).wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "test_forbidden_marker_nested_result_json",
      contextSnapshot: { taskKey: "runtime-skill-isolation:nested-result-json" },
    });

    expect(run?.id).toBeTruthy();
    await waitForCondition(async () => {
      const latestRun = await getRun(run!.id);
      if (latestRun?.status !== "failed") return false;
      const events = await getRunEvents(run!.id);
      return events.some((event) => event.eventType === "adapter.forbidden_marker");
    });

    const latestRun = await getRun(run!.id);
    expect(latestRun).toMatchObject({
      status: "failed",
      errorCode: "runtime_skill_isolation_failed",
      error: "Forbidden runtime skill marker observed",
    });
    const events = await getRunEvents(run!.id);
    expect(events.find((event) => event.eventType === "adapter.forbidden_marker")).toMatchObject({
      eventType: "adapter.forbidden_marker",
      level: "error",
      message: "forbidden runtime skill marker observed",
      payload: {
        forbiddenMarkerObserved: true,
        forbiddenMarkerEvidence: [
          { marker: forbiddenMarker, source: "resultJson" },
        ],
      },
    });
  });

  it("preserves timeout status when forbidden marker evidence is also present", async () => {
    const forbiddenMarker = "ZST646_FORBIDDEN_GLOBAL_SKILL_LOADED";
    const { agentId } = await seedAgentFixture({
      runtimeSkillIsolation: {
        forbiddenMarkers: [forbiddenMarker],
      },
    });
    mockRuntimeAdapter.execute.mockImplementationOnce(async (ctx) => {
      await ctx.onLog("stderr", `timeout tail contained ${forbiddenMarker}\n`);
      return {
        summary: "adapter timed out after decoy leakage",
        resultJson: null,
        timedOut: true,
        exitCode: null,
        errorMessage: null,
      };
    });

    const run = await heartbeatService(db).wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "test_forbidden_marker_timeout_priority",
      contextSnapshot: { taskKey: "runtime-skill-isolation:timeout-priority" },
    });

    expect(run?.id).toBeTruthy();
    await waitForCondition(async () => {
      const latestRun = await getRun(run!.id);
      if (latestRun?.status !== "timed_out") return false;
      const events = await getRunEvents(run!.id);
      return events.some((event) => event.eventType === "adapter.forbidden_marker");
    });

    const latestRun = await getRun(run!.id);
    expect(latestRun).toMatchObject({
      status: "timed_out",
      errorCode: "timeout",
      error: "Timed out",
    });
    const events = await getRunEvents(run!.id);
    expect(events.find((event) => event.eventType === "adapter.forbidden_marker")).toMatchObject({
      payload: {
        forbiddenMarkerObserved: true,
        forbiddenMarkerEvidence: expect.arrayContaining([
          { marker: forbiddenMarker, source: "stderr_excerpt" },
        ]),
      },
    });
  });

  it("preserves adapter failure codes when forbidden marker evidence is also present", async () => {
    const forbiddenMarker = "ZST646_FORBIDDEN_GLOBAL_SKILL_LOADED";
    const { agentId } = await seedAgentFixture({
      runtimeSkillIsolation: {
        forbiddenMarkers: [forbiddenMarker],
      },
    });
    mockRuntimeAdapter.execute.mockImplementationOnce(async (ctx) => {
      await ctx.onLog("stderr", `provider failed after ${forbiddenMarker}\n`);
      return {
        summary: "adapter failed after decoy leakage",
        resultJson: null,
        timedOut: false,
        exitCode: 1,
        errorCode: "provider_auth_failed",
        errorMessage: "Provider auth failed",
      };
    });

    const run = await heartbeatService(db).wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "test_forbidden_marker_adapter_failure_priority",
      contextSnapshot: { taskKey: "runtime-skill-isolation:adapter-failure-priority" },
    });

    expect(run?.id).toBeTruthy();
    await waitForCondition(async () => {
      const latestRun = await getRun(run!.id);
      if (latestRun?.status !== "failed") return false;
      const events = await getRunEvents(run!.id);
      return events.some((event) => event.eventType === "adapter.forbidden_marker");
    });

    const latestRun = await getRun(run!.id);
    expect(latestRun).toMatchObject({
      status: "failed",
      errorCode: "provider_auth_failed",
      error: "Provider auth failed",
    });
    const events = await getRunEvents(run!.id);
    expect(events.find((event) => event.eventType === "adapter.forbidden_marker")).toMatchObject({
      payload: {
        forbiddenMarkerObserved: true,
        forbiddenMarkerEvidence: expect.arrayContaining([
          { marker: forbiddenMarker, source: "stderr_excerpt" },
        ]),
      },
    });
  });

  it("persists forbidden marker evidence when an adapter throws after logging", async () => {
    const forbiddenMarker = "ZST646_FORBIDDEN_GLOBAL_SKILL_LOADED";
    const { agentId } = await seedAgentFixture({
      runtimeSkillIsolation: {
        forbiddenMarkers: [forbiddenMarker],
      },
    });
    mockRuntimeAdapter.execute.mockImplementationOnce(async (ctx) => {
      await ctx.onMeta?.({
        agentRuntimeType: "codex_local",
        command: "codex",
        forbiddenMarkerObserved: false,
      });
      await ctx.onLog("stderr", `throw path saw ${forbiddenMarker}\n`);
      throw new Error("Adapter crashed after output");
    });

    const run = await heartbeatService(db).wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "test_forbidden_marker_throw_path",
      contextSnapshot: { taskKey: "runtime-skill-isolation:throw-path" },
    });

    expect(run?.id).toBeTruthy();
    await waitForCondition(async () => {
      const latestRun = await getRun(run!.id);
      if (latestRun?.status !== "failed") return false;
      const events = await getRunEvents(run!.id);
      return events.some((event) => event.eventType === "adapter.forbidden_marker");
    });

    const latestRun = await getRun(run!.id);
    expect(latestRun).toMatchObject({
      status: "failed",
      errorCode: "adapter_failed",
      error: "Adapter crashed after output",
    });
    const events = await getRunEvents(run!.id);
    expect(events.find((event) => event.eventType === "adapter.forbidden_marker")).toMatchObject({
      payload: {
        forbiddenMarkerObserved: true,
        forbiddenMarkerEvidence: expect.arrayContaining([
          { marker: forbiddenMarker, source: "stderr_excerpt" },
        ]),
      },
    });
  });

  it("preserves forbidden marker meta from an earlier fallback attempt", async () => {
    const { agentId } = await seedAgentFixture({
      model: "primary-model",
      modelFallbacks: [{ agentRuntimeType: "codex_local", model: "backup-model" }],
    });
    const models: unknown[] = [];
    mockRuntimeAdapter.execute.mockImplementation(async (ctx) => {
      models.push(ctx.config.model);
      if (ctx.config.model === "primary-model") {
        await ctx.onMeta?.({
          agentRuntimeType: "codex_local",
          command: "codex",
          forbiddenMarkerObserved: true,
        });
        return {
          summary: "primary failed after forbidden marker",
          resultJson: null,
          timedOut: false,
          exitCode: 1,
          errorMessage: "primary failed",
        };
      }
      await ctx.onMeta?.({
        agentRuntimeType: "codex_local",
        command: "codex",
        forbiddenMarkerObserved: false,
      });
      return {
        summary: "fallback would have succeeded",
        resultJson: null,
        timedOut: false,
        exitCode: 0,
        errorMessage: null,
      };
    });

    const run = await heartbeatService(db).wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "test_forbidden_marker_fallback_meta",
      contextSnapshot: { taskKey: "runtime-skill-isolation:fallback-meta" },
    });

    expect(run?.id).toBeTruthy();
    await waitForCondition(async () => {
      const latestRun = await getRun(run!.id);
      if (latestRun?.status !== "failed") return false;
      const events = await getRunEvents(run!.id);
      return events.some((event) => event.eventType === "adapter.forbidden_marker");
    });

    expect(models).toEqual(["primary-model", "backup-model"]);
    const latestRun = await getRun(run!.id);
    expect(latestRun).toMatchObject({
      status: "failed",
      errorCode: "runtime_skill_isolation_failed",
      error: "Forbidden runtime skill marker observed",
    });
    const events = await getRunEvents(run!.id);
    expect(events.find((event) => event.eventType === "adapter.forbidden_marker")).toMatchObject({
      payload: {
        forbiddenMarkerObserved: true,
        forbiddenMarkerEvidence: expect.arrayContaining([
          { marker: null, source: "adapter_meta" },
        ]),
      },
    });
  });

  it("ignores legacy HEARTBEAT.md through the heartbeat service actor path", async () => {
    const agent = await seedAgentFixture();
    const agentHome = resolveDefaultAgentWorkspaceDir(agent.orgId, {
      id: agent.agentId,
      orgId: agent.orgId,
      name: agent.name,
    });
    const instructionsDir = path.join(agentHome, "instructions");
    const instructionsPath = path.join(instructionsDir, "SOUL.md");
    const heartbeatPath = path.join(instructionsDir, "HEARTBEAT.md");
    const commandPath = path.join(rudderHome, "codex");
    const capturePath = path.join(rudderHome, "codex-capture.json");
    await fs.mkdir(instructionsDir, { recursive: true });
    await fs.writeFile(instructionsPath, "# Persona\n\nYou are QA.\n", "utf8");
    await fs.writeFile(heartbeatPath, "# Heartbeat\n\n- Check assigned issues.\n", "utf8");
    await writeFakeCodexCommand(commandPath);
    await db
      .update(agents)
      .set({
        agentRuntimeConfig: {
          command: commandPath,
          instructionsFilePath: instructionsPath,
          env: { RUDDER_TEST_CAPTURE_PATH: capturePath },
          promptTemplate: "Follow the heartbeat prompt.",
        },
      })
      .where(eq(agents.id, agent.agentId));
    mockRuntimeAdapter.execute.mockImplementationOnce((ctx) => executeCodexLocal(ctx));

    const run = await heartbeatService(db).wakeup(agent.agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "test_heartbeat_instructions",
      contextSnapshot: { taskKey: "heartbeat:instructions" },
    });

    expect(run?.id).toBeTruthy();
    let invokeEventPayload: unknown = null;
    await waitForCondition(async () => {
      try {
        await fs.access(capturePath);
      } catch {
        return false;
      }
      const events = await getRunEvents(run!.id);
      const invokeEvent = events.find((event) => event.eventType === "adapter.invoke");
      if (!invokeEvent) return false;
      invokeEventPayload = invokeEvent.payload;
      return true;
    }, 10_000);

    const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
      prompt: string;
      rudderEnvKeys: string[];
    };
    expect(capture.prompt).toContain("# Persona");
    expect(capture.prompt).toContain("# Rudder Heartbeat Instruction");
    expect(capture.prompt).not.toContain("# Heartbeat\n\n- Check assigned issues.");
    expect(capture.prompt).toContain("Follow the heartbeat prompt.");
    expect(invokeEventPayload).toEqual(expect.objectContaining({
      agentRuntimeType: "codex_local",
      promptMetrics: expect.objectContaining({
        runtimeHeartbeatChars: expect.any(Number),
        heartbeatFileChars: expect.any(Number),
        heartbeatChars: expect.any(Number),
      }),
      commandNotes: expect.arrayContaining([
        "Loaded Rudder heartbeat instructions from runtime code",
      ]),
    }));
    const promptMetrics = (invokeEventPayload as {
      promptMetrics: { runtimeHeartbeatChars: number; heartbeatFileChars: number; heartbeatChars: number };
    }).promptMetrics;
    expect(promptMetrics.runtimeHeartbeatChars).toBeGreaterThan(0);
    expect(promptMetrics.heartbeatFileChars).toBe(0);
    expect(promptMetrics.heartbeatChars).toBe(promptMetrics.runtimeHeartbeatChars);
    await waitForCondition(async () => {
      const events = await getRunEvents(run!.id);
      return events.some((event) => event.eventType === "lifecycle" && event.message === "run succeeded");
    }, 15_000);
    await waitForCondition(async () => {
      const updatedAgent = await getAgent(agent.agentId);
      return updatedAgent?.status === "idle";
    }, 15_000);
  }, 25_000);

  it("injects the compact startup context bundle into the heartbeat prompt", async () => {
    const agent = await seedAgentFixture();
    const agentHome = resolveDefaultAgentWorkspaceDir(agent.orgId, {
      id: agent.agentId,
      orgId: agent.orgId,
      name: agent.name,
    });
    const now = new Date();
    const todayKey = now.toISOString().slice(0, 10);
    const yesterday = new Date(now);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdayKey = yesterday.toISOString().slice(0, 10);
    const memoryDir = path.join(agentHome, "memory");
    const commandPath = path.join(rudderHome, "codex");
    const capturePath = path.join(rudderHome, "codex-startup-context-capture.json");
    const issueId = randomUUID();
    const chatId = randomUUID();

    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(path.join(memoryDir, `${todayKey}.md`), "- Today startup memory signal\n", "utf8");
    await fs.writeFile(path.join(memoryDir, `${yesterdayKey}.md`), "- Yesterday startup memory signal\n", "utf8");
    await writeFakeCodexCommand(commandPath);

    await db.insert(issues).values({
      id: issueId,
      orgId: agent.orgId,
      title: "Agent startup memory context",
      description: "Define bounded startup context for agent runs.",
      status: "in_review",
      priority: "high",
      assigneeAgentId: agent.agentId,
      identifier: "RD-421",
    });
    await db.insert(chatConversations).values({
      id: chatId,
      orgId: agent.orgId,
      title: "Agent run startup memory",
      summary: "默认装载今天和昨天的 memory md",
      preferredAgentId: agent.agentId,
      lastMessageAt: new Date(),
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatMessages).values({
      id: randomUUID(),
      orgId: agent.orgId,
      conversationId: chatId,
      role: "user",
      kind: "message",
      status: "completed",
      body: "默认装载今天和昨天的 memory md",
    });
    await db
      .update(agents)
      .set({
        agentRuntimeConfig: {
          command: commandPath,
          env: { RUDDER_TEST_CAPTURE_PATH: capturePath },
          promptTemplate: "Follow the startup context.",
        },
      })
      .where(eq(agents.id, agent.agentId));
    mockRuntimeAdapter.execute.mockImplementationOnce((ctx) => executeCodexLocal(ctx));

    const run = await heartbeatService(db).wakeup(agent.agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      contextSnapshot: {
        issueId,
        taskKey: `issue:${issueId}`,
        wakeSource: "assignment",
        wakeReason: "issue_assigned",
      },
    });

    expect(run?.id).toBeTruthy();
    await waitForCondition(async () => {
      try {
        await fs.access(capturePath);
      } catch {
        return false;
      }
      const events = await getRunEvents(run!.id);
      return events.some((event) => event.eventType === "adapter.invoke");
    }, 10_000);

    const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as { prompt: string };
    expect(capture.prompt).toContain("## Recent Rudder Context");
    expect(capture.prompt).toContain(`#### today memory/${todayKey}.md`);
    expect(capture.prompt).toContain("- Today startup memory signal");
    expect(capture.prompt).toContain(`#### yesterday memory/${yesterdayKey}.md`);
    expect(capture.prompt).toContain("- Yesterday startup memory signal");
    expect(capture.prompt).toContain("| Issue | Status | Role | Assignee | Reviewer | Created | Updated | Title | Summary |");
    expect(capture.prompt).toContain("| `RD-421` | `in_review` | assignee |");
    expect(capture.prompt).toContain("Agent startup memory context | Define bounded startup context for agent runs.");
    expect(capture.prompt).toContain("| Chat | Last active | Title | Summary |");
    expect(capture.prompt).toContain(`| \`${chatId}\` |`);
    expect(capture.prompt).toContain("Agent run startup memory | 默认装载今天和昨天的 memory md");
    expect(capture.prompt).not.toContain("recent runs");
    expect(capture.prompt).not.toContain("# Rudder Heartbeat Instruction");

    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    expect(updatedRun?.contextSnapshot).toMatchObject({
      rudderScene: "issue",
      rudderStartupContextMetrics: {
        recentIssuesCount: 1,
        recentChatsCount: 1,
      },
      rudderStartupContext: {
        sourceRefs: expect.arrayContaining([
          expect.objectContaining({ kind: "memory", ref: `memory/${todayKey}.md` }),
          expect.objectContaining({ kind: "memory", ref: `memory/${yesterdayKey}.md` }),
          expect.objectContaining({ kind: "issue", ref: "RD-421" }),
          expect.objectContaining({ kind: "chat", ref: chatId }),
        ]),
      },
    });
    const persistedSnapshot = JSON.stringify(updatedRun?.contextSnapshot ?? {});
    expect(persistedSnapshot).not.toContain("Today startup memory signal");
    expect(persistedSnapshot).not.toContain("Yesterday startup memory signal");
    expect(persistedSnapshot).not.toContain("默认装载今天和昨天的 memory md");
    const events = await getRunEvents(run!.id);
    const adapterInvoke = events.find((event) => event.eventType === "adapter.invoke");
    expect(adapterInvoke?.payload).toMatchObject({
      promptSanitizedForPersistence: true,
    });
    const persistedAdapterPayload = JSON.stringify(adapterInvoke?.payload ?? {});
    expect(persistedAdapterPayload).toContain("[startup context omitted from persisted prompt]");
    expect(persistedAdapterPayload).not.toContain("Today startup memory signal");
    expect(persistedAdapterPayload).not.toContain("Yesterday startup memory signal");
    expect(persistedAdapterPayload).not.toContain("默认装载今天和昨天的 memory md");
    await waitForCondition(async () => {
      const latestEvents = await getRunEvents(run!.id);
      return latestEvents.some((event) => event.eventType === "lifecycle" && event.message === "run succeeded");
    }, 15_000);
    await waitForCondition(async () => {
      const updatedAgent = await getAgent(agent.agentId);
      return updatedAgent?.status === "idle";
    }, 15_000);
  }, 25_000);
});
