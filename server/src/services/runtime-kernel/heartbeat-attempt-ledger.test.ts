import {
  agents,
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  heartbeatRunAttempts,
  heartbeatRuns,
  organizations,
} from "@rudderhq/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  beginHeartbeatRunAttempt,
  checkpointHeartbeatRunAttempt,
  finishHeartbeatRunAttempt,
  finishLatestHeartbeatRunAttempt,
  markHeartbeatRunAttemptWaiting,
  type HeartbeatAttemptOwnerFence,
  type HeartbeatAttemptRef,
} from "./heartbeat-attempt-ledger.js";

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
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function startTempDatabase() {
  const externalUrl = process.env.RUDDER_HEARTBEAT_ATTEMPT_LEDGER_TEST_DATABASE_URL?.trim();
  if (externalUrl) {
    await applyPendingMigrations(externalUrl);
    return { connectionString: externalUrl, dataDir: "", instance: null };
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-heartbeat-attempt-ledger-"));
  const port = await getAvailablePort();
  const mod = await import("embedded-postgres");
  const EmbeddedPostgres = mod.default as EmbeddedPostgresCtor;
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
  const adminUrl = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminUrl, "rudder");
  const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

describe("heartbeat attempt owner fencing", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 30_000);

  afterEach(async () => {
    await db.delete(heartbeatRunAttempts);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function seedAttempt(fence: HeartbeatAttemptOwnerFence): Promise<{
    runId: string;
    ref: HeartbeatAttemptRef;
  }> {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      urlKey: `ledger-${orgId}`,
      name: "Heartbeat ledger test",
      issuePrefix: "HAL",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Heartbeat ledger agent",
      role: "engineer",
      agentRuntimeType: "process",
      agentRuntimeConfig: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      orgId,
      agentId,
      status: "running",
      executionOwnerToken: fence.ownerToken,
      executionLeaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });
    const ref = await beginHeartbeatRunAttempt(db, {
      orgId,
      runId,
      agentId,
      attemptIndex: 0,
      fallbackIndex: null,
      runtimeType: "process",
      model: null,
      isFallback: false,
      resumeSource: "fresh",
      ownerToken: fence.ownerToken,
      attemptEpoch: fence.attemptEpoch,
    });
    if (!ref) throw new Error("attempt fixture was not admitted");
    return { runId, ref };
  }

  async function rotateAttemptOwner(ref: HeartbeatAttemptRef, fence: HeartbeatAttemptOwnerFence) {
    const [updated] = await db
      .update(heartbeatRunAttempts)
      .set({ ownerToken: fence.ownerToken, attemptEpoch: fence.attemptEpoch })
      .where(eq(heartbeatRunAttempts.id, ref.id))
      .returning();
    if (!updated) throw new Error("attempt fixture owner rotation failed");
    await db
      .update(heartbeatRuns)
      .set({ executionOwnerToken: fence.ownerToken })
      .where(eq(heartbeatRuns.id, updated.runId));
  }

  it("makes late waiting, checkpoint, finish, and latest-finish calls no-op after owner rotation", async () => {
    const oldFence = { ownerToken: "worker-a", attemptEpoch: 1 } as const;
    const newFence = { ownerToken: "worker-b", attemptEpoch: 2 } as const;
    const fixture = await seedAttempt(oldFence);
    await rotateAttemptOwner(fixture.ref, newFence);

    const lateRef = fixture.ref;
    expect(await markHeartbeatRunAttemptWaiting(db, lateRef, {
      errorCode: "late_wait",
      error: "old worker returned",
      checkpointJson: { owner: "old" },
    })).toBeNull();
    expect(await checkpointHeartbeatRunAttempt(db, lateRef, { owner: "old" })).toBeNull();
    expect(await finishHeartbeatRunAttempt(db, lateRef, {
      status: "failed",
      errorCode: "late_finish",
      error: "old worker returned",
    })).toBeNull();
    expect(await finishLatestHeartbeatRunAttempt(db, fixture.runId, {
      status: "failed",
      errorCode: "late_latest_finish",
    }, oldFence)).toBeNull();

    const beforeNewOwnerWrite = await db
      .select()
      .from(heartbeatRunAttempts)
      .where(eq(heartbeatRunAttempts.id, fixture.ref.id))
      .then((rows) => rows[0]);
    expect(beforeNewOwnerWrite).toMatchObject({
      status: "started",
      ownerToken: newFence.ownerToken,
      attemptEpoch: newFence.attemptEpoch,
      errorCode: null,
    });

    const newRef = { ...fixture.ref, ...newFence };
    const waiting = await markHeartbeatRunAttemptWaiting(db, newRef, {
      errorCode: "network_wait",
      error: "new worker suspended",
      checkpointJson: { owner: "new" },
    });
    expect(waiting).toMatchObject({
      status: "waiting_for_network",
      ownerToken: newFence.ownerToken,
      attemptEpoch: newFence.attemptEpoch,
    });

    const finished = await finishHeartbeatRunAttempt(db, newRef, {
      status: "succeeded",
      errorCode: null,
      error: null,
      finishedAt: new Date("2026-09-22T00:00:01.000Z"),
    });
    expect(finished).toMatchObject({ status: "succeeded" });
    expect(await finishHeartbeatRunAttempt(db, newRef, { status: "failed" })).toBeNull();

    const after = await db
      .select()
      .from(heartbeatRunAttempts)
      .where(eq(heartbeatRunAttempts.id, fixture.ref.id))
      .then((rows) => rows[0]);
    expect(after).toMatchObject({
      status: "succeeded",
      ownerToken: newFence.ownerToken,
      attemptEpoch: newFence.attemptEpoch,
      errorCode: "network_wait",
      error: "new worker suspended",
    });
  });

  it("wins the CAS when owner rotation commits before a late finish", async () => {
    const oldFence = { ownerToken: "worker-a", attemptEpoch: 7 } as const;
    const newFence = { ownerToken: "worker-b", attemptEpoch: 8 } as const;
    const fixture = await seedAttempt(oldFence);
    let releaseRotation!: () => void;
    let rotationEntered!: () => void;
    const rotationReleased = new Promise<void>((resolve) => { releaseRotation = resolve; });
    const rotationStarted = new Promise<void>((resolve) => { rotationEntered = resolve; });

    const rotation = db.transaction(async (tx) => {
      await tx
        .update(heartbeatRunAttempts)
        .set({ ownerToken: newFence.ownerToken, attemptEpoch: newFence.attemptEpoch })
        .where(eq(heartbeatRunAttempts.id, fixture.ref.id));
      rotationEntered();
      await rotationReleased;
    });
    await rotationStarted;

    const lateFinish = finishHeartbeatRunAttempt(db, fixture.ref, {
      status: "failed",
      errorCode: "stale_finish",
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseRotation();
    await rotation;
    expect(await lateFinish).toBeNull();

    const row = await db
      .select()
      .from(heartbeatRunAttempts)
      .where(eq(heartbeatRunAttempts.id, fixture.ref.id))
      .then((rows) => rows[0]);
    expect(row).toMatchObject({
      status: "started",
      ownerToken: newFence.ownerToken,
      attemptEpoch: newFence.attemptEpoch,
    });
  });
});
