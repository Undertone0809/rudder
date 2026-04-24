import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  organizations,
  organizationSkills,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { runningProcesses } from "../agent-runtimes/index.ts";
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-heartbeat-recovery-"));
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

function spawnAliveProcess() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
}

async function waitForProcessExit(pid: number, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ESRCH") {
        return true;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

describe("heartbeat orphaned process recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  const childProcesses = new Set<ChildProcess>();

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    runningProcesses.clear();
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
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
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    runningProcesses.clear();
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  async function seedRunFixture(input?: {
    agentRuntimeType?: string;
    agentStatus?: "active" | "paused" | "idle" | "running" | "error";
    runStatus?: "running" | "queued" | "failed";
    processPid?: number | null;
    processLossRetryCount?: number;
    includeIssue?: boolean;
    runErrorCode?: string | null;
    runError?: string | null;
    contextSnapshot?: Record<string, unknown> | null;
  }) {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    const issuePrefix = `T${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const orgName = `Rudder ${orgId.slice(0, 6)}`;

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
      name: "CodexCoder",
      role: "engineer",
      status: input?.agentStatus ?? "active",
      agentRuntimeType: input?.agentRuntimeType ?? "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const contextSnapshot =
      input?.contextSnapshot ??
      (
        input?.includeIssue === false
          ? {}
          : {
            issueId,
            taskId: issueId,
            taskKey: issueId,
            wakeReason: "issue_assigned",
            wakeSource: "assignment",
            issue: {
              id: issueId,
              title: "Recover local adapter after lost process",
              status: "in_progress",
              priority: "medium",
              description: "Check prior progress, then finish the remaining cleanup.",
            },
          }
      );

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      orgId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: input?.includeIssue === false ? {} : { issueId },
      status: "claimed",
      runId,
      claimedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      orgId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input?.runStatus ?? "running",
      wakeupRequestId,
      contextSnapshot,
      processPid: input?.processPid ?? null,
      processLossRetryCount: input?.processLossRetryCount ?? 0,
      errorCode: input?.runErrorCode ?? null,
      error: input?.runError ?? null,
      startedAt: now,
      updatedAt: new Date("2026-03-19T00:00:00.000Z"),
    });

    if (input?.includeIssue !== false) {
      await db.insert(issues).values({
        id: issueId,
        orgId,
        title: "Recover local adapter after lost process",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        checkoutRunId: runId,
        executionRunId: runId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });
    }

    return { orgId, agentId, runId, wakeupRequestId, issueId };
  }

  it("terminates a detached local child and queues a retry instead of leaving the run stuck", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const { agentId, runId, wakeupRequestId } = await seedRunFixture({
      processPid: child.pid ?? null,
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    expect(await waitForProcessExit(child.pid ?? 0)).toBe(true);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(["queued", "running"]).toContain(retryRun?.status);

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("failed");
  });

  it("queues exactly one retry when the recorded local pid is dead", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(["queued", "running"]).toContain(retryRun?.status);
    expect(retryRun?.retryOfRunId).toBe(runId);
    expect(retryRun?.processLossRetryCount).toBe(1);
    expect(retryRun?.contextSnapshot).toMatchObject({
      issueId,
      taskId: issueId,
      taskKey: issueId,
      issue: expect.objectContaining({
        id: issueId,
        title: "Recover local adapter after lost process",
      }),
      recovery: {
        originalRunId: runId,
        failureKind: "process_lost",
        recoveryTrigger: "automatic",
        recoveryMode: "continue_preferred",
        failureSummary: expect.stringContaining("Process lost"),
      },
    });

    const retryWakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.runId, retryRun?.id ?? ""))
      .then((rows) => rows[0] ?? null);
    expect(retryWakeup).toMatchObject({
      reason: "process_lost_retry",
      payload: expect.objectContaining({
        issueId,
        originalRunId: runId,
        failureKind: "process_lost",
        recoveryTrigger: "automatic",
      }),
    });

    const retryEvents = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, retryRun?.id ?? ""))
      .orderBy(heartbeatRunEvents.seq);
    expect(retryEvents[0]?.payload).toEqual(
      expect.objectContaining({
        originalRunId: runId,
        failureKind: "process_lost",
        recoveryTrigger: "automatic",
      }),
    );

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
    expect(issue?.checkoutRunId).toBe(runId);
  });

  it("manual retry clones full recovery context instead of rebuilding a lossy wakeup", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      runStatus: "failed",
      runErrorCode: "network_error",
      runError: "Model connection dropped after creating the agent",
    });
    const heartbeat = heartbeatService(db);

    const retriedRun = await heartbeat.retryRun(runId, {
      requestedByActorType: "user",
      requestedByActorId: "local-board",
      now: new Date("2026-03-19T00:05:00.000Z"),
    });

    expect(retriedRun.id).not.toBe(runId);
    expect(retriedRun.retryOfRunId).toBe(runId);
    expect(retriedRun.contextSnapshot).toMatchObject({
      issueId,
      taskId: issueId,
      taskKey: issueId,
      issue: expect.objectContaining({
        id: issueId,
        title: "Recover local adapter after lost process",
      }),
      recovery: {
        originalRunId: runId,
        failureKind: "network_error",
        failureSummary: "Model connection dropped after creating the agent",
        recoveryTrigger: "manual",
        recoveryMode: "continue_preferred",
      },
    });

    const retryWakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, retriedRun.wakeupRequestId!))
      .then((rows) => rows[0] ?? null);
    expect(retryWakeup).toMatchObject({
      source: "on_demand",
      triggerDetail: "manual",
      reason: "retry_failed_run",
      payload: expect.objectContaining({
        originalRunId: runId,
        issueId,
        failureKind: "network_error",
        recoveryTrigger: "manual",
      }),
    });

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retriedRun.id);
    expect(issue?.checkoutRunId).toBe(runId);
  });

  it("backfills recovery context from the retry chain when the source retry run is lossy", async () => {
    const { orgId, agentId, runId, issueId } = await seedRunFixture({
      runStatus: "failed",
      runErrorCode: "model_error",
      runError: "The prior retry failed after partial completion",
    });
    const lossyRetryRunId = randomUUID();
    const lossyWakeupRequestId = randomUUID();

    await db.insert(agentWakeupRequests).values({
      id: lossyWakeupRequestId,
      orgId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "retry_failed_run",
      payload: { issueId, originalRunId: runId },
      status: "failed",
      runId: lossyRetryRunId,
    });

    await db.insert(heartbeatRuns).values({
      id: lossyRetryRunId,
      orgId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "failed",
      wakeupRequestId: lossyWakeupRequestId,
      retryOfRunId: runId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        taskKey: issueId,
        recovery: {
          originalRunId: runId,
          failureKind: "model_error",
          failureSummary: "The prior retry failed after partial completion",
          recoveryTrigger: "manual",
          recoveryMode: "continue_preferred",
        },
      },
      errorCode: "model_error",
      error: "The prior retry failed after partial completion",
      startedAt: new Date("2026-03-19T00:10:00.000Z"),
      updatedAt: new Date("2026-03-19T00:10:00.000Z"),
    });

    const heartbeat = heartbeatService(db);
    const retriedRun = await heartbeat.retryRun(lossyRetryRunId, {
      requestedByActorType: "user",
      requestedByActorId: "local-board",
      now: new Date("2026-03-19T00:15:00.000Z"),
    });

    expect(retriedRun.contextSnapshot).toMatchObject({
      issueId,
      issue: expect.objectContaining({
        id: issueId,
        title: "Recover local adapter after lost process",
      }),
      recovery: {
        originalRunId: lossyRetryRunId,
        failureKind: "model_error",
        recoveryTrigger: "manual",
      },
    });
  });

  it("does not queue a second retry after the first process-loss retry was already used", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
      processLossRetryCount: 1,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.checkoutRunId).toBe(runId);
  });

  it("clears the detached warning when the run reports activity again", async () => {
    const { runId } = await seedRunFixture({
      includeIssue: false,
      runErrorCode: "process_detached",
      runError: "Lost in-memory process handle, but child pid 123 is still alive",
    });
    const heartbeat = heartbeatService(db);

    const updated = await heartbeat.reportRunActivity(runId);
    expect(updated?.errorCode).toBeNull();
    expect(updated?.error).toBeNull();

    const run = await heartbeat.getRun(runId);
    expect(run?.errorCode).toBeNull();
    expect(run?.error).toBeNull();
  });
});
