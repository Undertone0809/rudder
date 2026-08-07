import {
  activityLog,
  agentRuntimeState,
  agents,
  agentTaskSessions,
  agentWakeupRequests,
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  organizations,
  organizationSkills,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { and, eq, sql } from "drizzle-orm";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runningProcesses } from "../agent-runtimes/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { appendHeartbeatRunEvent } from "../services/run-events.ts";
import {
  claimHeartbeatRunTerminalEffects,
  failHeartbeatRunTerminalEffect,
  MAX_TERMINAL_EFFECT_INTENT_BYTES,
  normalizeTerminalEffectIntent,
  reconcileHeartbeatRunTerminalEffectsIntent,
  renewHeartbeatRunExecutionLease,
  transitionHeartbeatRunToTerminal,
} from "../services/runtime-kernel/heartbeat.terminal.ts";

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
  const externalConnectionString = process.env.RUDDER_HEARTBEAT_RECOVERY_TEST_DATABASE_URL?.trim();
  if (externalConnectionString) {
    const parsed = new URL(externalConnectionString);
    const databaseName = parsed.pathname.replace(/^\//, "");
    parsed.pathname = "/postgres";
    await ensurePostgresDatabase(parsed.toString(), databaseName);
    await applyPendingMigrations(externalConnectionString);
    return { connectionString: externalConnectionString, instance: null, dataDir: "" };
  }

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
        await db.delete(activityLog);
        await db.delete(heartbeatRunEvents);
        await db.delete(agentTaskSessions);
        await db.delete(heartbeatRuns);
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
    issueStatus?: "todo" | "in_progress" | "in_review" | "done" | "cancelled";
    runErrorCode?: string | null;
    runError?: string | null;
    contextSnapshot?: Record<string, unknown> | null;
    startedAt?: Date;
    updatedAt?: Date;
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
      createdAt: input?.startedAt ?? now,
      startedAt: input?.startedAt ?? now,
      updatedAt: input?.updatedAt ?? new Date("2026-03-19T00:00:00.000Z"),
    });

    if (input?.includeIssue !== false) {
      await db.insert(issues).values({
        id: issueId,
        orgId,
        title: "Recover local adapter after lost process",
        status: input?.issueStatus ?? "in_progress",
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

  it("times out long-running active runs and releases issue execution locks", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const startedAt = new Date("2026-03-19T00:00:00.000Z");
    const timedOutAt = new Date("2026-03-19T13:00:00.000Z");
    const { agentId, runId, wakeupRequestId, issueId } = await seedRunFixture({
      processPid: child.pid ?? null,
      startedAt,
      updatedAt: startedAt,
    });
    runningProcesses.set(runId, { child, graceSec: 1 });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapTimedOutRuns({
      maxRuntimeMs: 12 * 60 * 60 * 1000,
      now: timedOutAt,
    });

    expect(result).toEqual({ timedOut: 1, runIds: [runId] });
    expect(await waitForProcessExit(child.pid ?? 0)).toBe(true);

    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("timed_out");
    expect(run?.errorCode).toBe("timeout");
    expect(run?.finishedAt?.toISOString()).toBe(timedOutAt.toISOString());

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("timed_out");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.executionLockedAt).toBeNull();

    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    expect(agent?.status).toBe("error");
  });

  it("times out active runs that stop producing server-visible activity", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const startedAt = new Date("2026-03-19T00:00:00.000Z");
    const timedOutAt = new Date("2026-03-19T00:31:00.000Z");
    const { agentId, runId, wakeupRequestId, issueId } = await seedRunFixture({
      processPid: child.pid ?? null,
      startedAt,
      updatedAt: startedAt,
    });
    runningProcesses.set(runId, { child, graceSec: 1 });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapInactiveRuns({
      maxInactivityMs: 30 * 60 * 1000,
      now: timedOutAt,
    });

    expect(result).toEqual({ timedOut: 1, runIds: [runId] });
    expect(await waitForProcessExit(child.pid ?? 0)).toBe(true);

    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("timed_out");
    expect(run?.errorCode).toBe("inactivity_timeout");
    expect(run?.error).toBe("Run had no recorded activity for 30m 0s");
    expect(run?.finishedAt?.toISOString()).toBe(timedOutAt.toISOString());

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("timed_out");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.executionLockedAt).toBeNull();

    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    expect(agent?.status).toBe("error");
  });

  it("times out inactive runs even when their execution lease renews repeatedly", async () => {
    const startedAt = new Date("2026-03-19T00:00:00.000Z");
    const ownerToken = randomUUID();
    const { runId } = await seedRunFixture({
      processPid: null,
      includeIssue: false,
      startedAt,
      updatedAt: startedAt,
    });
    await db
      .update(heartbeatRuns)
      .set({
        executionOwnerToken: ownerToken,
        executionLeaseExpiresAt: new Date("2026-03-19T00:05:00.000Z"),
      })
      .where(eq(heartbeatRuns.id, runId));

    for (const renewedAt of [
      "2026-03-19T00:10:00.000Z",
      "2026-03-19T00:20:00.000Z",
      "2026-03-19T00:29:00.000Z",
    ]) {
      await expect(renewHeartbeatRunExecutionLease(db, runId, ownerToken, new Date(renewedAt))).resolves.not.toBeNull();
    }
    const beforeTimeout = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]);
    expect(beforeTimeout?.updatedAt.toISOString()).toBe(startedAt.toISOString());

    const result = await heartbeatService(db).reapInactiveRuns({
      maxInactivityMs: 30 * 60 * 1000,
      now: new Date("2026-03-19T00:31:00.000Z"),
    });

    expect(result).toEqual({ timedOut: 1, runIds: [runId] });
    const timedOut = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]);
    expect(timedOut).toMatchObject({ status: "timed_out", errorCode: "inactivity_timeout" });
  });

  it("keeps active runs when a recent run event proves progress", async () => {
    const staleAt = new Date("2026-03-19T00:00:00.000Z");
    const recentAt = new Date("2026-03-19T00:25:00.000Z");
    const checkedAt = new Date("2026-03-19T00:40:00.000Z");
    const { orgId, agentId, runId } = await seedRunFixture({
      processPid: null,
      startedAt: staleAt,
      updatedAt: staleAt,
    });
    await db.insert(heartbeatRunEvents).values({
      orgId,
      agentId,
      runId,
      seq: 1,
      eventType: "adapter.invoke",
      stream: "system",
      level: "info",
      message: "adapter invocation",
      createdAt: recentAt,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapInactiveRuns({
      maxInactivityMs: 30 * 60 * 1000,
      now: checkedAt,
    });

    expect(result).toEqual({ timedOut: 0, runIds: [] });
    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("running");
  });

  it("rejects an inactivity terminal claim when its activity watermark is stale", async () => {
    const staleAt = new Date("2026-03-19T00:00:00.000Z");
    const recentAt = new Date("2026-03-19T00:31:00.000Z");
    const { orgId, agentId, runId } = await seedRunFixture({
      processPid: null,
      startedAt: staleAt,
      updatedAt: staleAt,
    });
    const observed = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]!);

    await appendHeartbeatRunEvent(db, {
      orgId,
      agentId,
      runId,
      eventType: "stdout",
      stream: "stdout",
      level: "info",
      message: "new activity after the reaper scan",
    });

    const claimed = await transitionHeartbeatRunToTerminal(db, {
      runId,
      status: "timed_out",
      patch: {
        finishedAt: recentAt,
        error: "stale timeout",
        errorCode: "inactivity_timeout",
      },
      activityWatermark: {
        updatedAt: observed.updatedAt,
        eventCount: 0,
      },
    });

    expect(claimed).toBeNull();
    const current = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    expect(current?.status).toBe("running");
    expect(current?.terminalEffectsPending).toBe(false);
  });

  it("orders a concurrent activity commit before the inactivity terminal CAS", async () => {
    const staleAt = new Date("2026-03-19T00:00:00.000Z");
    const { orgId, agentId, runId } = await seedRunFixture({
      processPid: null,
      startedAt: staleAt,
      updatedAt: staleAt,
    });
    let releaseActivity!: () => void;
    let activityLocked!: () => void;
    const activityGate = new Promise<void>((resolve) => { releaseActivity = resolve; });
    const locked = new Promise<void>((resolve) => { activityLocked = resolve; });

    const activityCommit = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${runId}))`);
      activityLocked();
      await activityGate;
      await tx.insert(heartbeatRunEvents).values({
        orgId,
        agentId,
        runId,
        seq: 1,
        eventType: "stdout",
        stream: "stdout",
        level: "info",
        message: "activity committed while terminal CAS is waiting",
      });
    });
    await locked;

    const terminalClaim = transitionHeartbeatRunToTerminal(db, {
      runId,
      status: "timed_out",
      patch: { finishedAt: new Date(), errorCode: "inactivity_timeout" },
      activityWatermark: { updatedAt: staleAt, eventCount: 0 },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseActivity();
    await activityCommit;

    await expect(terminalClaim).resolves.toBeNull();
    const current = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]);
    expect(current?.status).toBe("running");
  });

  it("reclaims an expired terminal-effects lease after a worker crash", async () => {
    const { runId } = await seedRunFixture({ processPid: null });
    const terminal = await transitionHeartbeatRunToTerminal(db, {
      runId,
      status: "failed",
      patch: { finishedAt: new Date(), error: "worker crashed after CAS" },
      processExitedAt: new Date(),
      terminalEffectsIntent: { version: 1 },
    });
    expect(terminal?.terminalEffectsPending).toBe(true);
    await db
      .update(heartbeatRuns)
      .set({
        terminalEffectsClaimToken: randomUUID(),
        terminalEffectsClaimedAt: new Date(Date.now() - 6 * 60_000),
      })
      .where(eq(heartbeatRuns.id, runId));

    const recoveryA = heartbeatService(db);
    const recoveryB = heartbeatService(db);
    const recoveryResults = await Promise.all([
      recoveryA.reapOrphanedRuns(),
      recoveryB.reapOrphanedRuns(),
    ]);

    const recovered = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]);
    expect(recovered).toMatchObject({
      status: "failed",
      terminalEffectsPending: false,
      terminalEffectsClaimToken: null,
      terminalEffectsLastError: null,
    });
    expect(recovered?.terminalEffectsAttemptCount).toBe(1);
    expect(recoveryResults.reduce((total, result) => total + result.reaped, 0)).toBe(1);
  });

  it("backs off transient terminal effects and dead-letters the fifth attempt", async () => {
    const { runId } = await seedRunFixture({ processPid: null, includeIssue: false });
    await transitionHeartbeatRunToTerminal(db, {
      runId,
      status: "failed",
      patch: { finishedAt: new Date() },
      processExitedAt: new Date(),
      terminalEffectsIntent: { version: 2, runtime: { legacySessionId: null, provider: "test" } },
    });
    let now = new Date("2026-03-19T01:00:00.000Z");
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const claim = await claimHeartbeatRunTerminalEffects(db, runId, { now });
      expect(claim).not.toBeNull();
      const failure = await failHeartbeatRunTerminalEffect(
        db,
        runId,
        claim!.claimToken,
        "runtime_cost",
        new Error("transient ledger outage with customer-secret-123"),
        { now },
      );
      expect(failure?.attempt).toBe(attempt);
      expect(failure?.deadLettered).toBe(attempt === 5);
      if (attempt < 5) {
        expect(failure?.nextAttemptAt).not.toBeNull();
        const beforeDue = new Date(failure!.nextAttemptAt!.getTime() - 1);
        await expect(claimHeartbeatRunTerminalEffects(db, runId, { now: beforeDue })).resolves.toBeNull();
        now = failure!.nextAttemptAt!;
      }
    }
    const events = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.eventType, "terminal_effect.dead_lettered"));
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      effect: "runtime_cost",
      attempt: 5,
      errorCode: "terminal_effect_failed",
      errorSummary: "Terminal effect runtime_cost failed",
    });
    expect(JSON.stringify(events[0]?.payload)).not.toContain("customer-secret-123");
    const attention = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "heartbeat.terminal_effect_dead_lettered"));
    expect(attention).toHaveLength(1);
    expect(JSON.stringify(attention[0]?.details)).not.toContain("customer-secret-123");
    const current = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]);
    expect(current?.terminalEffectsLastError).not.toContain("customer-secret-123");
  });

  it("never touches a persisted pid after process exit was acknowledged", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");
    const { runId } = await seedRunFixture({
      runStatus: "failed",
      processPid: child.pid ?? null,
      includeIssue: false,
    });
    await db
      .update(heartbeatRuns)
      .set({
        processExitedAt: new Date(),
        terminalEffectsPending: true,
        terminalEffectsJson: { version: 2 },
      })
      .where(eq(heartbeatRuns.id, runId));

    await heartbeatService(db).reapOrphanedRuns();

    expect(() => process.kill(child.pid ?? 0, 0)).not.toThrow();
    const current = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]);
    expect(current?.terminalEffectsPending).toBe(false);
    expect(current?.processExitedAt).not.toBeNull();
  });

  it("excludes post-cutoff admissions from startup orphan recovery", async () => {
    const startupCutoff = new Date("2026-03-19T00:00:00.000Z");
    const admittedAt = new Date("2026-03-19T00:00:01.000Z");
    const checkedAt = new Date("2026-03-19T00:10:00.000Z");
    const { runId } = await seedRunFixture({
      processPid: null,
      includeIssue: false,
      startedAt: admittedAt,
      updatedAt: admittedAt,
    });

    const result = await heartbeatService(db).reapOrphanedRuns({
      now: checkedAt,
      recoveryCutoff: startupCutoff,
    });

    expect(result).toEqual({ reaped: 0, runIds: [] });
    const current = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]);
    expect(current?.status).toBe("running");
  });

  it("persists only bounded replay intent and clears it after completion", async () => {
    const { orgId, agentId, runId } = await seedRunFixture({ processPid: null, includeIssue: false });
    const oversizedMarker = `unbounded-marker-${"x".repeat(100_000)}`;
    const oversizedUtf8Output = "\u{1F600}".repeat(32_000);
    const individuallyBoundedSessionParams = "y".repeat(60_000);
    const terminal = await transitionHeartbeatRunToTerminal(db, {
      runId,
      status: "succeeded",
      patch: { finishedAt: new Date() },
      processExitedAt: new Date(),
      terminalEffectsIntent: {
        version: 1,
        automation: { output: oversizedUtf8Output, transcript: [{ text: oversizedMarker }] },
        runtime: {
          adapterResult: { resultJson: { raw: oversizedMarker }, provider: "test", model: "model" },
          legacySessionId: null,
        },
        taskSession: {
          operation: "upsert",
          orgId,
          agentId,
          agentRuntimeType: "codex_local",
          taskKey: "bounded-intent",
          sessionParamsJson: { raw: individuallyBoundedSessionParams },
          sessionDisplayId: "session-1",
          lastRunId: runId,
          privateReplayState: oversizedMarker,
        },
      } as any,
    });
    const persisted = JSON.stringify(terminal?.terminalEffectsJson);
    expect(Buffer.byteLength(persisted, "utf8")).toBeLessThanOrEqual(MAX_TERMINAL_EFFECT_INTENT_BYTES);
    expect(persisted).not.toContain("unbounded-marker");
    expect(persisted).not.toContain("privateReplayState");
    expect(terminal?.terminalEffectsJson).toMatchObject({
      version: 2,
      automation: { output: expect.any(String) },
      runtime: { provider: "test", model: "model" },
      taskSession: { sessionParamsJson: null },
    });

    await heartbeatService(db).reapOrphanedRuns();
    const completed = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]);
    expect(completed?.terminalEffectsPending).toBe(false);
    expect(completed?.terminalEffectsJson).toBeNull();
  });

  it("reapplies the total intent cap after split terminal intent reconciliation", async () => {
    const { orgId, agentId, runId } = await seedRunFixture({ processPid: null, includeIssue: false });
    const existing = normalizeTerminalEffectIntent({
      version: 2,
      taskSession: {
        operation: "upsert",
        orgId,
        agentId,
        agentRuntimeType: "codex_local",
        taskKey: "split-reconcile",
        sessionParamsJson: { raw: "s".repeat(65_000) },
        sessionDisplayId: "session-1",
        lastRunId: runId,
      },
    });
    const normalizedUsage = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`metric_${String(index).padStart(3, "0")}`, index]),
    );
    const incoming = normalizeTerminalEffectIntent({
      version: 2,
      automation: { output: "a".repeat(32_000) },
      runtime: {
        provider: "test",
        model: "model",
        legacySessionId: null,
        normalizedUsage,
      },
    });
    const splitMerge = {
      ...existing,
      version: 2,
      automation: incoming.automation,
      runtime: incoming.runtime,
    };
    expect(Buffer.byteLength(JSON.stringify(existing), "utf8"))
      .toBeLessThanOrEqual(MAX_TERMINAL_EFFECT_INTENT_BYTES);
    expect(Buffer.byteLength(JSON.stringify(incoming), "utf8"))
      .toBeLessThanOrEqual(MAX_TERMINAL_EFFECT_INTENT_BYTES);
    expect(Buffer.byteLength(JSON.stringify(splitMerge), "utf8"))
      .toBeGreaterThan(MAX_TERMINAL_EFFECT_INTENT_BYTES);

    await transitionHeartbeatRunToTerminal(db, {
      runId,
      status: "succeeded",
      patch: { finishedAt: new Date() },
      processExitedAt: new Date(),
      terminalEffectsIntent: existing,
    });
    const reconciled = await reconcileHeartbeatRunTerminalEffectsIntent(db, runId, incoming);
    const persisted = JSON.stringify(reconciled?.terminalEffectsJson);

    expect(Buffer.byteLength(persisted, "utf8")).toBeLessThanOrEqual(MAX_TERMINAL_EFFECT_INTENT_BYTES);
    expect(reconciled?.terminalEffectsJson).toMatchObject({
      version: 2,
      automation: { output: "a".repeat(32_000) },
      runtime: { provider: "test", model: "model", normalizedUsage },
      taskSession: {
        operation: "upsert",
        taskKey: "split-reconcile",
        sessionParamsJson: null,
      },
    });
  });

  it("keeps issue release audit exactly once when replay resumes after a lost checkpoint", async () => {
    const { runId, issueId } = await seedRunFixture({ processPid: null });
    await transitionHeartbeatRunToTerminal(db, {
      runId,
      status: "failed",
      patch: { finishedAt: new Date(), error: "adapter failed" },
      processExitedAt: new Date(),
      terminalEffectsIntent: { version: 2 },
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.reapOrphanedRuns();

    // Model a crash after the release transaction committed but before the
    // terminal-effect checkpoint became durable.
    await db
      .update(heartbeatRuns)
      .set({
        terminalEffectsPending: true,
        terminalEffectsJson: { version: 2 },
        terminalEffectsClaimToken: null,
        terminalEffectsClaimedAt: null,
      })
      .where(eq(heartbeatRuns.id, runId));
    await heartbeat.reapOrphanedRuns();

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue?.executionRunId).toBeNull();
    const releaseEvents = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.eventType, "issue.execution_released"));
    expect(releaseEvents).toHaveLength(1);
    const releaseActivities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.execution_released"));
    expect(releaseActivities).toHaveLength(1);
  });

  it("does not overwrite a protected agent status while replaying terminal effects", async () => {
    const { agentId, runId } = await seedRunFixture({ processPid: null });
    await transitionHeartbeatRunToTerminal(db, {
      runId,
      status: "failed",
      patch: { finishedAt: new Date(), error: "replay after pause" },
      processExitedAt: new Date(),
      terminalEffectsIntent: { version: 1 },
    });
    await db.update(agents).set({ status: "paused", pauseReason: "manual" }).where(eq(agents.id, agentId));

    await heartbeatService(db).reapOrphanedRuns();

    const currentAgent = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]);
    expect(currentAgent).toMatchObject({ status: "paused", pauseReason: "manual" });
  });

  it("allows only one concurrent terminal claimant", async () => {
    const { runId } = await seedRunFixture({ processPid: null });
    const finishedAt = new Date("2026-03-19T00:31:00.000Z");

    const claims = await Promise.all([
      transitionHeartbeatRunToTerminal(db, {
        runId,
        status: "timed_out",
        patch: { finishedAt, error: "inactivity", errorCode: "inactivity_timeout" },
      }),
      transitionHeartbeatRunToTerminal(db, {
        runId,
        status: "failed",
        patch: { finishedAt, error: "adapter failed", errorCode: "adapter_failed" },
      }),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    const current = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    expect(["timed_out", "failed"]).toContain(current?.status);
    expect(current?.terminalEffectsPending).toBe(true);
  });

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

  it("preserves a live locally tracked child when its execution lease expires", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const now = new Date("2026-03-19T00:10:00.000Z");
    const ownerToken = randomUUID();
    const { runId } = await seedRunFixture({
      processPid: child.pid ?? null,
      includeIssue: false,
    });
    await db
      .update(heartbeatRuns)
      .set({
        executionOwnerToken: ownerToken,
        executionLeaseExpiresAt: new Date("2026-03-19T00:05:00.000Z"),
      })
      .where(eq(heartbeatRuns.id, runId));
    runningProcesses.set(runId, { child, graceSec: 1 });

    const result = await heartbeatService(db).reapOrphanedRuns({
      now,
      recoveryCutoff: now,
    });

    expect(result).toEqual({ reaped: 0, runIds: [] });
    expect(() => process.kill(child.pid ?? 0, 0)).not.toThrow();
    const current = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(current).toMatchObject({
      status: "running",
      executionOwnerToken: ownerToken,
    });
    expect(current?.executionLeaseExpiresAt?.toISOString()).toBe("2026-03-19T00:15:00.000Z");
  });

  it("stops a locally tracked child when another owner takes its execution lease", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const now = new Date("2026-03-19T00:10:00.000Z");
    const ownerToken = randomUUID();
    const takeoverOwnerToken = randomUUID();
    const { runId, agentId } = await seedRunFixture({
      processPid: child.pid ?? null,
      includeIssue: false,
    });
    await db
      .update(heartbeatRuns)
      .set({
        executionOwnerToken: ownerToken,
        executionLeaseExpiresAt: new Date("2026-03-19T00:05:00.000Z"),
      })
      .where(eq(heartbeatRuns.id, runId));
    runningProcesses.set(runId, { child, graceSec: 1 });

    const heartbeat = heartbeatService(db, {
      beforeRunExecutionLeaseRenewal: async ({ runId: renewedRunId, ownerToken: renewedOwnerToken }) => {
        await db
          .update(heartbeatRuns)
          .set({
            executionOwnerToken: takeoverOwnerToken,
            executionLeaseExpiresAt: new Date("2026-03-19T00:15:00.000Z"),
          })
          .where(and(
            eq(heartbeatRuns.id, renewedRunId),
            eq(heartbeatRuns.executionOwnerToken, renewedOwnerToken),
          ));
        expect(renewedOwnerToken).toBe(ownerToken);
      },
    });
    const result = await heartbeat.reapOrphanedRuns({
      now,
      recoveryCutoff: now,
    });

    expect(result).toEqual({ reaped: 0, runIds: [] });
    expect(await waitForProcessExit(child.pid ?? 0)).toBe(true);
    const current = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(current).toMatchObject({
      status: "running",
      executionOwnerToken: takeoverOwnerToken,
    });
    const runs = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
  });

  it("preserves a live local execution through inactivity recovery after sleep", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const startedAt = new Date("2026-03-19T00:00:00.000Z");
    const now = new Date("2026-03-19T00:31:00.000Z");
    const ownerToken = randomUUID();
    const { runId } = await seedRunFixture({
      processPid: child.pid ?? null,
      includeIssue: false,
      startedAt,
      updatedAt: startedAt,
    });
    await db
      .update(heartbeatRuns)
      .set({
        executionOwnerToken: ownerToken,
        executionLeaseExpiresAt: new Date("2026-03-19T00:05:00.000Z"),
      })
      .where(eq(heartbeatRuns.id, runId));
    runningProcesses.set(runId, { child, graceSec: 1 });

    const result = await heartbeatService(db).reapInactiveRuns({
      maxInactivityMs: 30 * 60 * 1000,
      now,
    });

    expect(result).toEqual({ timedOut: 0, runIds: [] });
    expect(() => process.kill(child.pid ?? 0, 0)).not.toThrow();
    const current = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(current).toMatchObject({
      status: "running",
      executionOwnerToken: ownerToken,
      updatedAt: now,
    });
    expect(current?.executionLeaseExpiresAt?.toISOString()).toBe("2026-03-19T00:36:00.000Z");
  });

  it("does not grant a second sleep grace when the max duration is already exceeded", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const startedAt = new Date("2026-03-19T00:00:00.000Z");
    const firstWakeAt = new Date("2026-03-19T13:00:00.000Z");
    const secondWakeAt = new Date("2026-03-19T13:06:00.000Z");
    const ownerToken = randomUUID();
    const { runId } = await seedRunFixture({
      processPid: child.pid ?? null,
      includeIssue: false,
      startedAt,
      updatedAt: startedAt,
    });
    await db
      .update(heartbeatRuns)
      .set({
        executionOwnerToken: ownerToken,
        executionLeaseExpiresAt: new Date("2026-03-19T00:05:00.000Z"),
      })
      .where(eq(heartbeatRuns.id, runId));
    runningProcesses.set(runId, { child, graceSec: 1 });

    const heartbeat = heartbeatService(db);
    await expect(heartbeat.reapTimedOutRuns({
      maxRuntimeMs: 12 * 60 * 60 * 1000,
      now: firstWakeAt,
    })).resolves.toEqual({ timedOut: 0, runIds: [] });
    await expect(heartbeat.reapTimedOutRuns({
      maxRuntimeMs: 12 * 60 * 60 * 1000,
      now: secondWakeAt,
    })).resolves.toEqual({ timedOut: 1, runIds: [runId] });
    expect(await waitForProcessExit(child.pid ?? 0)).toBe(true);
  });

  it("keeps a lease-timer wake renewal from racing the max-duration watchdog", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const startedAt = new Date("2026-03-19T00:00:00.000Z");
    const initialRenewalAt = new Date("2026-03-19T00:01:00.000Z");
    const wakeAt = new Date("2026-03-19T13:00:00.000Z");
    const ownerToken = randomUUID();
    const { runId } = await seedRunFixture({
      processPid: child.pid ?? null,
      includeIssue: false,
      startedAt,
      updatedAt: startedAt,
    });
    await db
      .update(heartbeatRuns)
      .set({
        executionOwnerToken: ownerToken,
        executionLeaseExpiresAt: new Date("2026-03-19T00:05:00.000Z"),
      })
      .where(eq(heartbeatRuns.id, runId));
    runningProcesses.set(runId, { child, graceSec: 1 });

    const heartbeat = heartbeatService(db);
    await expect(heartbeat.reapOrphanedRuns({ now: initialRenewalAt })).resolves.toEqual({ reaped: 0, runIds: [] });
    await expect(heartbeat.reapOrphanedRuns({ now: wakeAt })).resolves.toEqual({ reaped: 0, runIds: [] });

    const renewed = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(renewed?.updatedAt).toEqual(wakeAt);

    await expect(heartbeat.reapTimedOutRuns({
      maxRuntimeMs: 12 * 60 * 60 * 1000,
      now: wakeAt,
    })).resolves.toEqual({ timedOut: 0, runIds: [] });
    expect(() => process.kill(child.pid ?? 0, 0)).not.toThrow();
  });

  it("gives a live local execution one wake grace before max duration recovery", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const startedAt = new Date("2026-03-19T00:00:00.000Z");
    const wakeAt = new Date("2026-03-19T13:00:00.000Z");
    const ownerToken = randomUUID();
    const { runId } = await seedRunFixture({
      processPid: child.pid ?? null,
      includeIssue: false,
      startedAt,
      updatedAt: startedAt,
    });
    await db
      .update(heartbeatRuns)
      .set({
        executionOwnerToken: ownerToken,
        executionLeaseExpiresAt: new Date("2026-03-19T00:05:00.000Z"),
      })
      .where(eq(heartbeatRuns.id, runId));
    runningProcesses.set(runId, { child, graceSec: 1 });

    const heartbeat = heartbeatService(db);
    await expect(heartbeat.reapTimedOutRuns({
      maxRuntimeMs: 12 * 60 * 60 * 1000,
      now: wakeAt,
    })).resolves.toEqual({ timedOut: 0, runIds: [] });
    expect(() => process.kill(child.pid ?? 0, 0)).not.toThrow();

    const current = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(current?.executionLeaseExpiresAt?.toISOString()).toBe("2026-03-19T13:05:00.000Z");

    await expect(heartbeat.reapTimedOutRuns({
      maxRuntimeMs: 12 * 60 * 60 * 1000,
      now: new Date("2026-03-19T13:01:00.000Z"),
    })).resolves.toEqual({ timedOut: 1, runIds: [runId] });
    expect(await waitForProcessExit(child.pid ?? 0)).toBe(true);
  });

  it("serializes overlapping watchdog recovery while a wake lease renewal is in flight", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const startedAt = new Date("2026-03-19T00:00:00.000Z");
    const wakeAt = new Date("2026-03-19T13:00:00.000Z");
    const ownerToken = randomUUID();
    const { runId } = await seedRunFixture({
      processPid: child.pid ?? null,
      includeIssue: false,
      startedAt,
      updatedAt: startedAt,
    });
    await db
      .update(heartbeatRuns)
      .set({
        executionOwnerToken: ownerToken,
        executionLeaseExpiresAt: new Date("2026-03-19T00:05:00.000Z"),
      })
      .where(eq(heartbeatRuns.id, runId));
    runningProcesses.set(runId, { child, graceSec: 1 });

    let releaseRenewal!: () => void;
    let signalRenewalStarted!: () => void;
    const renewalStarted = new Promise<void>((resolve) => {
      signalRenewalStarted = resolve;
    });
    const renewalBlocked = new Promise<void>((resolve) => {
      releaseRenewal = resolve;
    });
    const heartbeat = heartbeatService(db, {
      beforeRunExecutionLeaseRenewal: async () => {
        signalRenewalStarted();
        await renewalBlocked;
      },
    });

    const first = heartbeat.reapTimedOutRuns({
      maxRuntimeMs: 12 * 60 * 60 * 1000,
      now: wakeAt,
    });
    await renewalStarted;

    let secondFinished = false;
    const second = heartbeat.reapTimedOutRuns({
      maxRuntimeMs: 12 * 60 * 60 * 1000,
      now: wakeAt,
    }).then((result) => {
      secondFinished = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(secondFinished).toBe(false);

    releaseRenewal();
    await expect(first).resolves.toEqual({ timedOut: 0, runIds: [] });
    await expect(second).resolves.toEqual({ timedOut: 0, runIds: [] });
    expect(() => process.kill(child.pid ?? 0, 0)).not.toThrow();
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

  it("preserves comment mention wake source when retrying a run linked to a closed issue", async () => {
    const wakeCommentId = randomUUID();
    const { agentId, runId, issueId } = await seedRunFixture({
      runStatus: "failed",
      runErrorCode: "network_error",
      runError: "Model connection dropped after the mention wake started",
      issueStatus: "done",
    });
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          issueId,
          taskId: issueId,
          taskKey: issueId,
          wakeReason: "issue_comment_mentioned",
          wakeSource: "comment.mention",
          wakeCommentId,
          issue: {
            id: issueId,
            title: "Recover local adapter after mention",
            status: "done",
            priority: "medium",
          },
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const heartbeat = heartbeatService(db);
    const retriedRun = await heartbeat.retryRun(runId, {
      requestedByActorType: "user",
      requestedByActorId: "local-board",
      now: new Date("2026-03-19T00:05:00.000Z"),
    });

    expect(retriedRun.contextSnapshot).toMatchObject({
      issueId,
      wakeReason: "retry_failed_run",
      wakeSource: "comment.mention",
      wakeCommentId,
      recovery: {
        originalRunId: runId,
        recoveryTrigger: "manual",
      },
    });

    await heartbeat.resumeQueuedRuns();

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const retryRun = runs.find((row) => row.id === retriedRun.id);
    expect(retryRun?.status).toBe("running");

    const retryWakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, retriedRun.wakeupRequestId!))
      .then((rows) => rows[0] ?? null);
    expect(retryWakeup?.status).toBe("claimed");
  });

  it("allows a cancelled adapter run to be retried manually", async () => {
    const { runId } = await seedRunFixture({
      runStatus: "cancelled",
      runErrorCode: "cancelled",
      runError: "Adapter failed",
    });
    const heartbeat = heartbeatService(db);

    const retriedRun = await heartbeat.retryRun(runId, {
      requestedByActorType: "user",
      requestedByActorId: "local-board",
      now: new Date("2026-03-19T00:06:00.000Z"),
    });

    expect(retriedRun.id).not.toBe(runId);
    expect(retriedRun.retryOfRunId).toBe(runId);
    expect(retriedRun.contextSnapshot).toMatchObject({
      retryOfRunId: runId,
      retryReason: "cancelled",
      recovery: {
        originalRunId: runId,
        failureKind: "cancelled",
        failureSummary: "Adapter failed",
        recoveryTrigger: "manual",
        recoveryMode: "continue_preferred",
      },
    });
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
