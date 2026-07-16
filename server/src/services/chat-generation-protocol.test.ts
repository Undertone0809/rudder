import {
  applyPendingMigrations,
  chatControlActions,
  chatConversations,
  chatGenerationEvents,
  chatGenerations,
  chatGenerationTerminalOutbox,
  chatQueuedMessages,
  createDb,
  ensurePostgresDatabase,
  organizations,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  chatGenerationProtocolService,
  hashChatGenerationBody,
} from "./chat-generation-protocol.js";

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
  return new Promise((resolve, reject) => {
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
  const externalUrl = process.env.RUDDER_CHAT_GENERATION_PROTOCOL_TEST_DATABASE_URL?.trim();
  if (externalUrl) {
    await applyPendingMigrations(externalUrl);
    return { connectionString: externalUrl, dataDir: "", instance: null };
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-chat-generation-protocol-"));
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

describe("chatGenerationProtocolService", () => {
  let db!: ReturnType<typeof createDb>;
  let protocol!: ReturnType<typeof chatGenerationProtocolService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    protocol = chatGenerationProtocolService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 30_000);

  afterEach(async () => {
    await db.delete(chatGenerationTerminalOutbox);
    await db.delete(chatGenerationEvents);
    await db.delete(chatControlActions);
    await db.delete(chatGenerations);
    await db.delete(chatConversations);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function seedGeneration(input: {
    orgId?: string;
    conversationId?: string;
    generationId?: string;
    status?: "active" | "running";
    attemptEpoch?: number;
    controlVersion?: number;
    ownerToken?: string | null;
    leaseExpiresAt?: Date | null;
  } = {}) {
    const orgId = input.orgId ?? randomUUID();
    const conversationId = input.conversationId ?? randomUUID();
    const generationId = input.generationId ?? randomUUID();
    const existingOrg = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (existingOrg.length === 0) {
      await db.insert(organizations).values({
        id: orgId,
        name: `Protocol ${orgId.slice(0, 6)}`,
        urlKey: deriveOrganizationUrlKey(`protocol-${orgId}`),
        issuePrefix: `P${orgId.replaceAll("-", "").slice(0, 5).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
    }
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Protocol test",
    });
    const [generation] = await db.insert(chatGenerations).values({
      id: generationId,
      orgId,
      conversationId,
      status: input.status ?? "running",
      attemptEpoch: input.attemptEpoch ?? 3,
      controlVersion: input.controlVersion ?? 0,
      controlState: input.ownerToken === null ? "unregistered" : "ready",
      controlOwnerToken: input.ownerToken === undefined ? "owner-1" : input.ownerToken,
      controlLeaseExpiresAt: input.leaseExpiresAt ?? new Date(Date.now() + 60_000),
    }).returning();
    if (!generation) throw new Error("Failed to seed generation");
    return generation;
  }

  it("serializes visible events and applies an idempotent Stop cutoff", async () => {
    const generation = await seedGeneration();
    const bodies = ["First", "First second"];
    const appended = await Promise.all(bodies.map((body, index) =>
      protocol.appendGenerationEvent({
        orgId: generation.orgId,
        conversationId: generation.conversationId,
        generationId: generation.id,
        attemptEpoch: generation.attemptEpoch,
        expectedOwnerToken: generation.controlOwnerToken,
        admission: "visible",
        eventKind: "assistant_delta",
        payload: { delta: index === 0 ? "First" : " second" },
        bodyOffset: index === 0 ? 0 : 5,
        bodyLength: index === 0 ? 5 : 7,
        bodyHash: hashChatGenerationBody(body),
      })));
    expect(appended.map(({ event }) => event.generationSeq).sort((a, b) => a - b)).toEqual([1, 2]);

    const latest = appended.reduce((left, right) =>
      left.event.generationSeq > right.event.generationSeq ? left : right);
    const latestHash = String(latest.event.payload.bodyHash);
    const checkpoint = await protocol.recordClientCheckpoint({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      generationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      expectedOwnerToken: generation.controlOwnerToken,
      generationSeq: latest.event.generationSeq,
      renderedBodyHash: latestHash,
    });
    expect(checkpoint.advanced).toBe(true);

    await expect(protocol.beginStopAction({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      controlActionId: randomUUID(),
      expectedGenerationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      expectedControlVersion: 0,
      requestedRenderSeq: latest.event.generationSeq,
      requestedBodyHash: hashChatGenerationBody("different body"),
    })).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(chatControlActions)).toHaveLength(0);
    expect(await db.select().from(chatGenerationEvents)).toHaveLength(3);

    const controlActionId = randomUUID();
    const stop = await protocol.beginStopAction({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      controlActionId,
      expectedGenerationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      expectedControlVersion: 0,
      requestedRenderSeq: latest.event.generationSeq,
      requestedBodyHash: latestHash,
    });
    expect(stop.idempotent).toBe(false);
    expect(stop.generation).toMatchObject({
      status: "stop_requested",
      controlState: "stopping",
      controlVersion: 1,
      acceptedThroughSeq: latest.event.generationSeq,
      frozenBodyHash: latestHash,
    });
    expect(stop.outputCutoffEvent?.generationSeq).toBe((stop.stopRequestedEvent?.generationSeq ?? 0) + 1);

    const repeated = await protocol.beginStopAction({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      controlActionId,
      expectedGenerationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      expectedControlVersion: 1,
      requestedRenderSeq: latest.event.generationSeq,
      requestedBodyHash: latestHash,
    });
    expect(repeated.idempotent).toBe(true);
    expect(await db.select().from(chatControlActions)).toHaveLength(1);
    expect(await db.select().from(chatGenerationEvents)).toHaveLength(5);

    await expect(protocol.appendGenerationEvent({
      orgId: generation.orgId,
      generationId: generation.id,
      attemptEpoch: generation.attemptEpoch,
      expectedOwnerToken: generation.controlOwnerToken,
      admission: "visible",
      eventKind: "assistant_delta",
      payload: { delta: " late" },
      bodyHash: hashChatGenerationBody("late"),
    })).rejects.toMatchObject({ status: 409 });
  });

  it("never regresses a Stop cutoff behind the latest acknowledged client checkpoint", async () => {
    const generation = await seedGeneration();
    const first = await protocol.appendGenerationEvent({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      generationId: generation.id,
      attemptEpoch: generation.attemptEpoch,
      expectedOwnerToken: generation.controlOwnerToken,
      admission: "visible",
      eventKind: "assistant_delta",
      payload: { delta: "Visible reply" },
      bodyOffset: 0,
      bodyLength: 13,
      bodyHash: hashChatGenerationBody("Visible reply"),
    });
    await protocol.recordClientCheckpoint({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      generationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      expectedOwnerToken: generation.controlOwnerToken,
      generationSeq: first.event.generationSeq,
      renderedBodyHash: hashChatGenerationBody("Visible reply"),
    });

    const stop = await protocol.beginStopAction({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      controlActionId: randomUUID(),
      expectedGenerationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      expectedControlVersion: 0,
      requestedRenderSeq: 0,
      requestedBodyHash: hashChatGenerationBody(""),
    });

    expect(stop.action).toMatchObject({
      acceptedThroughSeq: first.event.generationSeq,
      frozenBodyHash: hashChatGenerationBody("Visible reply"),
    });
  });

  it("linearizes runtime terminal evidence on either side of Stop", async () => {
    const terminalFirst = await seedGeneration();
    const terminal = await protocol.recordRuntimeTerminal({
      orgId: terminalFirst.orgId,
      conversationId: terminalFirst.conversationId,
      generationId: terminalFirst.id,
      expectedAttemptEpoch: terminalFirst.attemptEpoch,
      expectedOwnerToken: terminalFirst.controlOwnerToken,
      finalStatus: "completed",
      terminalReason: "completed",
    });
    await expect(protocol.beginStopAction({
      orgId: terminalFirst.orgId,
      conversationId: terminalFirst.conversationId,
      controlActionId: randomUUID(),
      expectedGenerationId: terminalFirst.id,
      expectedAttemptEpoch: terminalFirst.attemptEpoch,
      expectedControlVersion: terminalFirst.controlVersion,
      requestedRenderSeq: 0,
      requestedBodyHash: hashChatGenerationBody(""),
    })).rejects.toMatchObject({ status: 409 });
    const terminalClaim = await protocol.claimTerminalProjection({ workerId: "terminal-first", leaseMs: 1_000 });
    const terminalProjected = await protocol.completeTerminalProjection({
      outboxId: terminalClaim!.id,
      claimToken: terminalClaim!.claimToken!,
      claimEpoch: terminalClaim!.claimEpoch,
    });
    expect(terminalProjected?.generation.status).toBe("completed");

    const stopFirst = await seedGeneration();
    const stop = await protocol.beginStopAction({
      orgId: stopFirst.orgId,
      conversationId: stopFirst.conversationId,
      controlActionId: randomUUID(),
      expectedGenerationId: stopFirst.id,
      expectedAttemptEpoch: stopFirst.attemptEpoch,
      expectedControlVersion: stopFirst.controlVersion,
      requestedRenderSeq: 0,
      requestedBodyHash: hashChatGenerationBody(""),
    });
    const stoppedTerminal = await protocol.recordRuntimeTerminal({
      orgId: stopFirst.orgId,
      conversationId: stopFirst.conversationId,
      generationId: stopFirst.id,
      expectedAttemptEpoch: stopFirst.attemptEpoch,
      expectedOwnerToken: stopFirst.controlOwnerToken,
      finalStatus: "completed",
      terminalReason: "completed",
    });
    expect(stoppedTerminal.outbox).toMatchObject({
      expectedControlVersion: stop.generation.controlVersion,
      payload: expect.objectContaining({ finalStatus: "stopped", terminalReason: "operator_stop" }),
    });
    const stoppedClaim = await protocol.claimTerminalProjection({ workerId: "stop-first", leaseMs: 1_000 });
    const stoppedProjected = await protocol.completeTerminalProjection({
      outboxId: stoppedClaim!.id,
      claimToken: stoppedClaim!.claimToken!,
      claimEpoch: stoppedClaim!.claimEpoch,
      controlDisposition: "stopped",
    });
    expect(stoppedProjected?.generation.status).toBe("stopped");
  });

  it("never replays Steer when terminal projection cannot prove provider rejection", async () => {
    const generation = await seedGeneration({ controlVersion: 1 });
    const controlActionId = randomUUID();
    const queueItemId = randomUUID();
    await db.insert(chatControlActions).values({
      id: controlActionId,
      orgId: generation.orgId,
      expectedGenerationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      expectedControlVersion: 0,
      appliedControlVersion: 1,
      actionKind: "steer",
      localDisposition: "pending",
      providerDisposition: "sent",
    });
    await db.insert(chatQueuedMessages).values({
      id: queueItemId,
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      position: 1,
      status: "steer_pending",
      clientMutationId: randomUUID(),
      payload: { body: "Do not duplicate this feedback" },
      deliveryIntent: "steer",
      deliveryDisposition: "pending",
      controlActionId,
      expectedGenerationId: generation.id,
      activeGenerationId: generation.id,
      attemptEpoch: generation.attemptEpoch,
    });
    await protocol.recordRuntimeTerminal({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      generationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      expectedOwnerToken: generation.controlOwnerToken,
      finalStatus: "completed",
      terminalReason: "completed",
    });
    const claim = await protocol.claimTerminalProjection({ workerId: "unknown-receipt", leaseMs: 1_000 });
    await protocol.completeTerminalProjection({
      outboxId: claim!.id,
      claimToken: claim!.claimToken!,
      claimEpoch: claim!.claimEpoch,
    });

    const [item] = await db.select().from(chatQueuedMessages).where(eq(chatQueuedMessages.id, queueItemId));
    const [action] = await db.select().from(chatControlActions).where(eq(chatControlActions.id, controlActionId));
    expect(item).toMatchObject({ status: "acceptance_unknown", deliveryDisposition: "acceptance_unknown" });
    expect(action).toMatchObject({ localDisposition: "acceptance_unknown", providerDisposition: "sent" });
  });

  it("fences terminal projector retries by claim token and epoch", async () => {
    const generation = await seedGeneration();
    const emptyHash = hashChatGenerationBody("");
    const controlActionId = randomUUID();
    await protocol.beginStopAction({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      controlActionId,
      expectedGenerationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      expectedControlVersion: 0,
      requestedRenderSeq: 0,
      requestedBodyHash: emptyHash,
    });
    const terminal = await protocol.recordRuntimeTerminal({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      generationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      expectedOwnerToken: generation.controlOwnerToken,
      finalStatus: "stopped",
      terminalReason: "operator_stop",
      controlActionId,
      now: new Date("2026-07-16T00:00:00.000Z"),
    });
    expect(terminal.outbox.status).toBe("pending");

    const firstClaim = await protocol.claimTerminalProjection({
      workerId: "projector-a",
      leaseMs: 1_000,
      now: new Date("2026-07-16T00:00:00.000Z"),
    });
    expect(firstClaim).toMatchObject({ status: "claimed", claimEpoch: 1, attemptCount: 1 });
    expect(await protocol.getNextTerminalProjectionWakeAt()).toEqual(
      new Date("2026-07-16T00:00:01.000Z"),
    );
    const retryAt = new Date("2026-07-16T00:00:02.000Z");
    const retry = await protocol.retryTerminalProjection({
      outboxId: firstClaim!.id,
      claimToken: firstClaim!.claimToken!,
      claimEpoch: firstClaim!.claimEpoch,
      error: "projection unavailable",
      retryAt,
      maxAttempts: 3,
      now: new Date("2026-07-16T00:00:00.500Z"),
    });
    expect(retry?.status).toBe("retry_wait");
    expect(await protocol.getNextTerminalProjectionWakeAt()).toEqual(retryAt);

    const secondClaim = await protocol.claimTerminalProjection({
      workerId: "projector-b",
      leaseMs: 1_000,
      now: retryAt,
    });
    expect(secondClaim).toMatchObject({ status: "claimed", claimEpoch: 2, attemptCount: 2 });
    expect(await protocol.completeTerminalProjection({
      outboxId: firstClaim!.id,
      claimToken: firstClaim!.claimToken!,
      claimEpoch: firstClaim!.claimEpoch,
      now: retryAt,
    })).toBeNull();

    let projected = false;
    const completed = await protocol.completeTerminalProjection({
      outboxId: secondClaim!.id,
      claimToken: secondClaim!.claimToken!,
      claimEpoch: secondClaim!.claimEpoch,
      controlDisposition: "stopped",
      now: new Date("2026-07-16T00:00:02.500Z"),
      project: async () => {
        projected = true;
      },
    });
    expect(projected).toBe(true);
    expect(completed?.outbox.status).toBe("projected");
    expect(completed?.generation.status).toBe("stopped");
    const [action] = await db.select().from(chatControlActions);
    expect(action?.localDisposition).toBe("stopped");
  });

  it("recovers stale control owners without claiming runtime termination", async () => {
    const orgId = randomUUID();
    const expired = await seedGeneration({
      orgId,
      leaseExpiresAt: new Date("2026-07-15T23:59:00.000Z"),
    });
    const future = await seedGeneration({
      orgId,
      leaseExpiresAt: new Date("2026-07-16T01:00:00.000Z"),
    });
    const recovered = await protocol.recoverStaleControlOwners({
      now: new Date("2026-07-16T00:00:00.000Z"),
    });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.generation).toMatchObject({
      id: expired.id,
      status: "control_lost",
      controlState: "control_lost",
      controlOwnerToken: null,
      runtimeTerminalAt: null,
    });
    expect(recovered[0]?.outbox.payload).toMatchObject({
      finalStatus: "control_lost",
      runtimeTerminationVerified: false,
    });
    const [futureAfter] = await db
      .select()
      .from(chatGenerations)
      .where(eq(chatGenerations.id, future.id));
    expect(futureAfter?.status).toBe("running");

    const startupRecovered = await protocol.recoverStaleControlOwners({
      now: new Date("2026-07-16T00:00:01.000Z"),
      assumeAllOwnersStale: true,
    });
    expect(startupRecovered.map(({ generation }) => generation.id)).toContain(future.id);
    const events = await db
      .select()
      .from(chatGenerationEvents)
      .where(eq(chatGenerationEvents.generationId, future.id))
      .orderBy(asc(chatGenerationEvents.generationSeq));
    expect(events).toHaveLength(1);
    expect(events[0]?.eventKind).toBe("terminal_projection_requested");
  });
});
