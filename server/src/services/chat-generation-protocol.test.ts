import {
  applyPendingMigrations,
  chatControlActions,
  chatConversations,
  chatGenerationEvents,
  chatGenerations,
  chatGenerationTerminalOutbox,
  chatMessages,
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
    status?: "active" | "running" | "closing";
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
      expectedControlVersion: 0,
      requestedRenderSeq: latest.event.generationSeq,
      requestedBodyHash: latestHash,
    });
    expect(repeated.idempotent).toBe(true);
    expect(await db.select().from(chatControlActions)).toHaveLength(1);
    expect(await db.select().from(chatGenerationEvents)).toHaveLength(5);

    const repeatedWithNewAction = await protocol.beginStopAction({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      controlActionId: randomUUID(),
      expectedGenerationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      expectedControlVersion: 1,
      requestedRenderSeq: latest.event.generationSeq,
      requestedBodyHash: latestHash,
    });
    expect(repeatedWithNewAction).toMatchObject({
      outcome: "stop_in_progress",
      idempotent: false,
      action: {
        localDisposition: "stopping",
        acceptedThroughSeq: latest.event.generationSeq,
        frozenBodyHash: latestHash,
      },
      generation: { status: "stop_requested", controlVersion: 1 },
    });
    expect(await db.select().from(chatControlActions)).toHaveLength(2);
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

  it("persists a completion outcome when final output admission wins ahead of Stop", async () => {
    const generation = await seedGeneration({ status: "closing" });
    const finalBody = "Committed final reply";
    const controlActionId = randomUUID();
    const completion = await protocol.appendVisibleEventAndProject({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      generationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      eventKind: "runtime_output",
      payload: { resultKind: "message", body: finalBody },
      bodyOffset: 0,
      bodyLength: finalBody.length,
      bodyHash: hashChatGenerationBody(finalBody),
      body: finalBody,
      transcript: [],
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    const stop = await protocol.beginStopAction({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      controlActionId,
      expectedGenerationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      expectedControlVersion: generation.controlVersion,
      requestedRenderSeq: completion.event.generationSeq,
      requestedBodyHash: hashChatGenerationBody(finalBody),
    });
    expect(stop).toMatchObject({
      outcome: "completion_committed",
      idempotent: false,
      action: {
        id: controlActionId,
        localDisposition: "cancelled",
        providerDisposition: "not_sent",
        lastError: "generation_result_already_committed",
      },
    });
    expect(stop.stopRequestedEvent).toBeNull();
    expect(stop.outputCutoffEvent).toBeNull();
    expect(stop.action.providerEvidence).toMatchObject({
      completionEventId: completion.event.id,
      completionGenerationSeq: completion.event.generationSeq,
    });
    expect(await db.select().from(chatControlActions)).toHaveLength(1);
    expect(completion.message).toMatchObject({
      body: finalBody,
      status: "streaming",
    });

    const repeated = await protocol.beginStopAction({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      controlActionId,
      expectedGenerationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      expectedControlVersion: generation.controlVersion,
      requestedRenderSeq: completion.event.generationSeq,
      requestedBodyHash: hashChatGenerationBody(finalBody),
    });
    expect(repeated).toMatchObject({
      outcome: "completion_committed",
      idempotent: true,
      action: { id: controlActionId },
    });

    await expect(protocol.appendVisibleEventAndProject({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      generationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      eventKind: "assistant_delta",
      payload: { delta: " late" },
      messageId: completion.message.id,
      bodyHash: hashChatGenerationBody(`${finalBody} late`),
      body: `${finalBody} late`,
      transcript: [],
      chatTurnId: completion.message.chatTurnId!,
      turnVariant: completion.message.turnVariant,
    })).rejects.toMatchObject({
      status: 409,
      message: "Chat-visible output admission is closed for this generation",
    });
    await expect(protocol.appendGenerationEvent({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      generationId: generation.id,
      attemptEpoch: generation.attemptEpoch,
      admission: "visible",
      eventKind: "assistant_delta",
      payload: { delta: " legacy late" },
      bodyHash: hashChatGenerationBody(`${finalBody} legacy late`),
    })).rejects.toMatchObject({
      status: 409,
      message: "Chat-visible output admission is closed for this generation",
    });
  });

  it("schedules fallback Steer without a cutoff when final output admission already won", async () => {
    const generation = await seedGeneration({ status: "closing", controlVersion: 1 });
    const finalBody = "Committed before fallback";
    const completion = await protocol.appendVisibleEventAndProject({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      generationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      eventKind: "runtime_output",
      payload: { resultKind: "message", body: finalBody },
      bodyHash: hashChatGenerationBody(finalBody),
      body: finalBody,
      transcript: [],
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });
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
      providerSentAt: new Date(),
    });
    await db.insert(chatQueuedMessages).values({
      id: queueItemId,
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      position: 1,
      clientMutationId: randomUUID(),
      status: "steer_pending",
      deliveryIntent: "steer",
      deliveryDisposition: "pending",
      controlActionId,
      expectedGenerationId: generation.id,
      activeGenerationId: generation.id,
      attemptEpoch: generation.attemptEpoch,
      payload: { body: "Use the public API" },
    });

    const fallback = await protocol.beginSteerFallbackCutoff({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      generationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      controlActionId,
      queueItemId,
      requestedRenderSeq: completion.event.generationSeq,
      requestedBodyHash: hashChatGenerationBody(finalBody),
    });

    expect(fallback).toMatchObject({
      outcome: "completion_committed",
      idempotent: false,
      generation: { status: "closing", acceptedThroughSeq: null },
      action: {
        localDisposition: "continuation_pending",
        providerDisposition: "not_sent",
        acceptedThroughSeq: null,
        frozenBodyHash: null,
        lastError: "target_generation_completion_committed",
      },
      item: {
        status: "continuation_pending",
        deliveryDisposition: "continuation_pending",
        reconciliationReason: "target_generation_completion_committed",
      },
    });
    expect(fallback.outputCutoffEvent).toBeNull();
    expect(fallback.continuationEvent).toMatchObject({
      eventKind: "continuation_scheduled",
      payload: {
        reason: "target_generation_completion_committed",
        completionEventId: completion.event.id,
      },
    });
    const generationEvents = await db
      .select()
      .from(chatGenerationEvents)
      .where(eq(chatGenerationEvents.generationId, generation.id));
    expect(generationEvents.filter((event) => event.eventKind === "output_cutoff")).toHaveLength(0);
    const [persistedMessage] = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, completion.message.id));
    expect(persistedMessage).toMatchObject({ body: finalBody, status: "streaming" });

    const repeated = await protocol.beginSteerFallbackCutoff({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      generationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      controlActionId,
      queueItemId,
      requestedRenderSeq: completion.event.generationSeq,
      requestedBodyHash: hashChatGenerationBody(finalBody),
    });
    expect(repeated).toMatchObject({
      outcome: "completion_committed",
      idempotent: true,
      continuationEvent: { id: fallback.continuationEvent?.id },
    });
  });

  it("rewinds an atomically projected event beyond the client Stop checkpoint", async () => {
    const generation = await seedGeneration();
    const chatTurnId = randomUUID();
    const first = await protocol.appendVisibleEventAndProject({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      generationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      eventKind: "assistant_delta",
      payload: { delta: "Visible prefix" },
      bodyOffset: 0,
      bodyLength: 14,
      bodyHash: hashChatGenerationBody("Visible prefix"),
      body: "Visible prefix",
      transcript: [],
      chatTurnId,
      turnVariant: 0,
    });
    await protocol.appendVisibleEventAndProject({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      generationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      eventKind: "assistant_delta",
      payload: { delta: " hidden tail" },
      messageId: first.message.id,
      bodyOffset: 14,
      bodyLength: 12,
      bodyHash: hashChatGenerationBody("Visible prefix hidden tail"),
      body: "Visible prefix hidden tail",
      transcript: [],
      chatTurnId,
      turnVariant: 0,
    });

    await protocol.beginStopAction({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      controlActionId: randomUUID(),
      expectedGenerationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      expectedControlVersion: generation.controlVersion,
      requestedRenderSeq: first.event.generationSeq,
      requestedBodyHash: hashChatGenerationBody("Visible prefix"),
    });
    const [message] = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, first.message.id));
    expect(message).toMatchObject({
      body: "Visible prefix",
      status: "stopped",
    });
    await expect(protocol.appendVisibleEventAndProject({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      generationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      eventKind: "runtime_output",
      payload: { resultKind: "message", body: "Completed too late" },
      messageId: first.message.id,
      bodyHash: hashChatGenerationBody("Completed too late"),
      body: "Completed too late",
      transcript: [],
      chatTurnId,
      turnVariant: 0,
    })).rejects.toMatchObject({
      status: 409,
      message: "Chat-visible output admission is closed for this generation",
    });
  });

  it("freezes visible output before scheduling an unsupported-runtime Steer continuation", async () => {
    const generation = await seedGeneration({ controlVersion: 1 });
    const visible = await protocol.appendGenerationEvent({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      generationId: generation.id,
      attemptEpoch: generation.attemptEpoch,
      expectedOwnerToken: generation.controlOwnerToken,
      admission: "visible",
      eventKind: "assistant_delta",
      payload: { delta: "Before fallback" },
      bodyOffset: 0,
      bodyLength: 15,
      bodyHash: hashChatGenerationBody("Before fallback"),
    });
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
      providerSentAt: new Date(),
    });
    await db.insert(chatQueuedMessages).values({
      id: queueItemId,
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      position: 1,
      clientMutationId: randomUUID(),
      status: "steer_pending",
      deliveryIntent: "steer",
      deliveryDisposition: "pending",
      controlActionId,
      expectedGenerationId: generation.id,
      activeGenerationId: generation.id,
      attemptEpoch: generation.attemptEpoch,
      payload: { body: "Use the public API" },
    });

    const fallback = await protocol.beginSteerFallbackCutoff({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      generationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      controlActionId,
      queueItemId,
      requestedRenderSeq: visible.event.generationSeq,
      requestedBodyHash: hashChatGenerationBody("Before fallback"),
    });

    expect(fallback.idempotent).toBe(false);
    expect(fallback.generation).toMatchObject({
      status: "stop_requested",
      terminalReason: "steer_fallback",
      acceptedThroughSeq: visible.event.generationSeq,
      frozenBodyHash: hashChatGenerationBody("Before fallback"),
    });
    expect(fallback.action).toMatchObject({
      localDisposition: "continuation_pending",
      providerDisposition: "not_sent",
      acceptedThroughSeq: visible.event.generationSeq,
      frozenBodyHash: hashChatGenerationBody("Before fallback"),
    });
    expect(fallback.item).toMatchObject({
      status: "continuation_pending",
      deliveryDisposition: "continuation_pending",
    });
    expect(fallback.outputCutoffEvent?.eventKind).toBe("output_cutoff");
    expect(fallback.continuationEvent?.eventKind).toBe("continuation_scheduled");
    await expect(protocol.appendGenerationEvent({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      generationId: generation.id,
      attemptEpoch: generation.attemptEpoch,
      admission: "visible",
      eventKind: "assistant_delta",
      payload: { delta: " after" },
      bodyHash: hashChatGenerationBody("Before fallback after"),
    })).rejects.toMatchObject({ status: 409 });

    const repeated = await protocol.beginSteerFallbackCutoff({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      generationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      controlActionId,
      queueItemId,
      requestedRenderSeq: visible.event.generationSeq,
      requestedBodyHash: hashChatGenerationBody("Before fallback"),
    });
    expect(repeated.idempotent).toBe(true);

    const terminal = await protocol.recordRuntimeTerminal({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      generationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      finalStatus: "completed",
      terminalReason: "completed",
    });
    expect(terminal.outbox.payload).toMatchObject({
      finalStatus: "stopped",
      terminalReason: "steer_fallback",
      controlActionId,
      controlActionKind: "steer",
    });
  });

  it("reuses a Stop cutoff when Stop wins after Steer provider admission", async () => {
    const generation = await seedGeneration({ controlVersion: 1 });
    const steerActionId = randomUUID();
    const queueItemId = randomUUID();
    await db.insert(chatControlActions).values({
      id: steerActionId,
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
      clientMutationId: randomUUID(),
      status: "steer_pending",
      deliveryIntent: "steer",
      deliveryDisposition: "pending",
      controlActionId: steerActionId,
      expectedGenerationId: generation.id,
      activeGenerationId: generation.id,
      attemptEpoch: generation.attemptEpoch,
      payload: { body: "Continue with this" },
    });
    const stop = await protocol.beginStopAction({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      controlActionId: randomUUID(),
      expectedGenerationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      expectedControlVersion: 1,
      requestedRenderSeq: 0,
      requestedBodyHash: hashChatGenerationBody(""),
    });

    const fallback = await protocol.beginSteerFallbackCutoff({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      generationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      controlActionId: steerActionId,
      queueItemId,
      requestedRenderSeq: 0,
      requestedBodyHash: hashChatGenerationBody(""),
    });

    expect(fallback.generation).toMatchObject({
      terminalReason: "operator_stop",
      acceptedThroughSeq: stop.action.acceptedThroughSeq,
      frozenBodyHash: stop.action.frozenBodyHash,
    });
    expect(fallback.outputCutoffEvent).toBeNull();
    expect(fallback.action.localDisposition).toBe("continuation_pending");
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
    const terminalFirstStop = await protocol.beginStopAction({
      orgId: terminalFirst.orgId,
      conversationId: terminalFirst.conversationId,
      controlActionId: randomUUID(),
      expectedGenerationId: terminalFirst.id,
      expectedAttemptEpoch: terminalFirst.attemptEpoch,
      expectedControlVersion: terminalFirst.controlVersion,
      requestedRenderSeq: 0,
      requestedBodyHash: hashChatGenerationBody(""),
    });
    expect(terminalFirstStop).toMatchObject({
      outcome: "already_terminal",
      idempotent: false,
      generation: { id: terminalFirst.id, runtimeTerminalAt: terminal.generation.runtimeTerminalAt },
      action: { localDisposition: "cancelled", lastError: "generation_runtime_already_terminal" },
    });
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

  it("releases generation ownership as an actionable failure when terminal projection exhausts", async () => {
    const generation = await seedGeneration();
    const controlActionId = randomUUID();
    await protocol.beginStopAction({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      controlActionId,
      expectedGenerationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      expectedControlVersion: generation.controlVersion,
      requestedRenderSeq: 0,
      requestedBodyHash: hashChatGenerationBody(""),
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
      now: new Date("2026-07-16T01:00:00.000Z"),
    });
    expect(terminal.generation.status).toBe("stopping");

    const claim = await protocol.claimTerminalProjection({
      workerId: "exhausting-projector",
      leaseMs: 1_000,
      now: new Date("2026-07-16T01:00:00.000Z"),
    });
    const exhaustedAt = new Date("2026-07-16T01:00:00.500Z");
    const exhausted = await protocol.retryTerminalProjection({
      outboxId: claim!.id,
      claimToken: claim!.claimToken!,
      claimEpoch: claim!.claimEpoch,
      error: "assistant projection failed",
      retryAt: new Date("2026-07-16T01:00:02.000Z"),
      maxAttempts: 1,
      now: exhaustedAt,
    });

    expect(exhausted).toMatchObject({
      status: "failed_actionable",
      lastError: "assistant projection failed",
      projectedAt: null,
      payload: expect.objectContaining({
        finalStatus: "stopped",
        terminalReason: "operator_stop",
      }),
    });
    const [failedGeneration] = await db
      .select()
      .from(chatGenerations)
      .where(eq(chatGenerations.id, generation.id));
    expect(failedGeneration).toMatchObject({
      status: "failed",
      terminalReason: "terminal_projection_failed_actionable",
      controlState: "terminal",
      controlOwnerToken: null,
      controlLeaseExpiresAt: null,
      completedAt: exhaustedAt,
    });
    const [failedAction] = await db
      .select()
      .from(chatControlActions)
      .where(eq(chatControlActions.id, controlActionId));
    expect(failedAction).toMatchObject({
      localDisposition: "failed_actionable",
      lastError: "assistant projection failed",
      resolvedAt: exhaustedAt,
    });
    expect(await protocol.getNextTerminalProjectionWakeAt()).toBeNull();
    expect(await protocol.completeTerminalProjection({
      outboxId: claim!.id,
      claimToken: claim!.claimToken!,
      claimEpoch: claim!.claimEpoch,
      now: exhaustedAt,
    })).toBeNull();

    const events = await db
      .select()
      .from(chatGenerationEvents)
      .where(eq(chatGenerationEvents.generationId, generation.id))
      .orderBy(asc(chatGenerationEvents.generationSeq));
    expect(events.map(({ eventKind }) => eventKind)).toEqual([
      "stop_requested",
      "output_cutoff",
      "runtime_terminal",
    ]);

    const [nextGeneration] = await db
      .insert(chatGenerations)
      .values({
        orgId: generation.orgId,
        conversationId: generation.conversationId,
        status: "active",
      })
      .returning();
    expect(nextGeneration?.status).toBe("active");
  });

  it("releases a closing generation when terminal projection exhausts", async () => {
    const generation = await seedGeneration();
    const terminal = await protocol.recordRuntimeTerminal({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      generationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      expectedOwnerToken: generation.controlOwnerToken,
      finalStatus: "completed",
      terminalReason: "completed",
      now: new Date("2026-07-16T02:00:00.000Z"),
    });
    expect(terminal.generation.status).toBe("closing");

    const claim = await protocol.claimTerminalProjection({
      workerId: "closing-projector",
      leaseMs: 1_000,
      now: new Date("2026-07-16T02:00:00.000Z"),
    });
    await protocol.retryTerminalProjection({
      outboxId: claim!.id,
      claimToken: claim!.claimToken!,
      claimEpoch: claim!.claimEpoch,
      error: "run projection failed",
      retryAt: new Date("2026-07-16T02:00:02.000Z"),
      maxAttempts: 1,
      now: new Date("2026-07-16T02:00:00.500Z"),
    });

    const [failedGeneration] = await db
      .select()
      .from(chatGenerations)
      .where(eq(chatGenerations.id, generation.id));
    expect(failedGeneration).toMatchObject({
      status: "failed",
      terminalReason: "terminal_projection_failed_actionable",
      controlState: "terminal",
    });
    const [nextGeneration] = await db
      .insert(chatGenerations)
      .values({
        orgId: generation.orgId,
        conversationId: generation.conversationId,
        status: "active",
      })
      .returning();
    expect(nextGeneration?.status).toBe("active");
  });

  it("reconciles generation-linked Steers when terminal projection exhausts", async () => {
    const generation = await seedGeneration();
    const states = [
      {
        itemId: randomUUID(),
        actionId: randomUUID(),
        queueStatus: "accepted_current" as const,
        localDisposition: "accepted_current" as const,
        providerDisposition: "acknowledged" as const,
      },
      {
        itemId: randomUUID(),
        actionId: randomUUID(),
        queueStatus: "steer_pending" as const,
        localDisposition: "pending" as const,
        providerDisposition: "sent" as const,
      },
      {
        itemId: randomUUID(),
        actionId: randomUUID(),
        queueStatus: "continuation_pending" as const,
        localDisposition: "continuation_pending" as const,
        providerDisposition: "not_sent" as const,
      },
    ];
    await db.insert(chatControlActions).values(states.map((state) => ({
      id: state.actionId,
      orgId: generation.orgId,
      expectedGenerationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      expectedControlVersion: generation.controlVersion,
      actionKind: "steer" as const,
      localDisposition: state.localDisposition,
      providerDisposition: state.providerDisposition,
    })));
    await db.insert(chatQueuedMessages).values(states.map((state, index) => ({
      id: state.itemId,
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      position: index + 1,
      status: state.queueStatus,
      clientMutationId: randomUUID(),
      payload: { body: `Steer ${index + 1}` },
      deliveryIntent: "steer" as const,
      deliveryDisposition: state.localDisposition,
      controlActionId: state.actionId,
      expectedGenerationId: generation.id,
      activeGenerationId: generation.id,
      attemptEpoch: generation.attemptEpoch,
    })));
    await protocol.recordRuntimeTerminal({
      orgId: generation.orgId,
      conversationId: generation.conversationId,
      generationId: generation.id,
      expectedAttemptEpoch: generation.attemptEpoch,
      expectedOwnerToken: generation.controlOwnerToken,
      finalStatus: "completed",
      terminalReason: "completed",
      now: new Date("2026-07-16T03:00:00.000Z"),
    });
    const claim = await protocol.claimTerminalProjection({
      workerId: "steer-reconciliation-projector",
      leaseMs: 1_000,
      now: new Date("2026-07-16T03:00:00.000Z"),
    });
    await protocol.retryTerminalProjection({
      outboxId: claim!.id,
      claimToken: claim!.claimToken!,
      claimEpoch: claim!.claimEpoch,
      error: "terminal projection exhausted",
      retryAt: new Date("2026-07-16T03:00:02.000Z"),
      maxAttempts: 1,
      now: new Date("2026-07-16T03:00:00.500Z"),
    });

    const items = await db
      .select()
      .from(chatQueuedMessages)
      .orderBy(asc(chatQueuedMessages.position));
    expect(items.map(({ status, deliveryDisposition, reconciliationReason }) => ({
      status,
      deliveryDisposition,
      reconciliationReason,
    }))).toEqual([
      { status: "delivered", deliveryDisposition: "delivered", reconciliationReason: null },
      {
        status: "acceptance_unknown",
        deliveryDisposition: "acceptance_unknown",
        reconciliationReason: "terminal_projection_failed_provider_receipt_unknown",
      },
      {
        status: "failed_actionable",
        deliveryDisposition: "failed_actionable",
        reconciliationReason: "terminal_projection_failed_actionable",
      },
    ]);
    const actions = await db
      .select()
      .from(chatControlActions)
      .orderBy(asc(chatControlActions.requestedAt), asc(chatControlActions.id));
    const actionById = new Map(actions.map((action) => [action.id, action]));
    expect(actionById.get(states[0]!.actionId)?.localDisposition).toBe("delivered");
    expect(actionById.get(states[1]!.actionId)?.localDisposition).toBe("acceptance_unknown");
    expect(actionById.get(states[2]!.actionId)?.localDisposition).toBe("failed_actionable");
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
