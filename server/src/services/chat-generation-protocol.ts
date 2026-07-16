import type { Db } from "@rudderhq/db";
import {
  chatControlActions,
  chatGenerationEvents,
  chatGenerations,
  chatGenerationTerminalOutbox,
  chatQueuedMessages,
} from "@rudderhq/db";
import type {
  ChatControlDisposition,
  ChatGenerationEventKind,
  ChatGenerationStatus,
} from "@rudderhq/shared";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { conflict, notFound, unprocessable } from "../errors.js";

type GenerationRow = typeof chatGenerations.$inferSelect;
type GenerationEventRow = typeof chatGenerationEvents.$inferSelect;
type ControlActionRow = typeof chatControlActions.$inferSelect;
type TerminalOutboxRow = typeof chatGenerationTerminalOutbox.$inferSelect;

export type ChatGenerationProtocolTransaction = Parameters<
  Parameters<Db["transaction"]>[0]
>[0];

const OUTPUT_ADMITTING_GENERATION_STATUSES = [
  "starting",
  "active",
  "running",
  "tool_busy",
] as const;

const CONTROL_ACTIVE_GENERATION_STATUSES = [
  ...OUTPUT_ADMITTING_GENERATION_STATUSES,
  "closing",
] as const;

const RECOVERABLE_CONTROL_GENERATION_STATUSES = [
  ...CONTROL_ACTIVE_GENERATION_STATUSES,
  "stop_requested",
  "stopping",
] as const;

const PROJECTABLE_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "stopped",
  "aborted",
  "interrupted_unverified",
  "control_lost",
] as const satisfies readonly ChatGenerationStatus[];

const EMPTY_BODY_SHA256 = createHash("sha256").update("").digest("hex");
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

export function hashChatGenerationBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function normalizeBodyHash(value: string): string {
  if (!SHA256_PATTERN.test(value)) {
    throw unprocessable("Chat generation body hash must be a SHA-256 hex digest");
  }
  return value.toLowerCase();
}

function assertGenerationFence(
  generation: GenerationRow,
  input: {
    conversationId?: string;
    expectedAttemptEpoch: number;
    expectedOwnerToken?: string | null;
  },
) {
  if (input.conversationId && generation.conversationId !== input.conversationId) {
    throw notFound("Chat generation not found");
  }
  if (generation.attemptEpoch !== input.expectedAttemptEpoch) {
    throw conflict("Chat generation runtime attempt changed");
  }
  if (
    input.expectedOwnerToken !== undefined
    && generation.controlOwnerToken !== input.expectedOwnerToken
  ) {
    throw conflict("Chat generation control owner changed");
  }
}

async function lockGeneration(
  tx: ChatGenerationProtocolTransaction,
  input: { orgId: string; generationId: string; conversationId?: string },
): Promise<GenerationRow> {
  await tx.execute(sql`
    select ${chatGenerations.id}
    from ${chatGenerations}
    where ${chatGenerations.id} = ${input.generationId}
      and ${chatGenerations.orgId} = ${input.orgId}
    for update
  `);
  const generation = await tx
    .select()
    .from(chatGenerations)
    .where(and(
      eq(chatGenerations.id, input.generationId),
      eq(chatGenerations.orgId, input.orgId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!generation || (input.conversationId && generation.conversationId !== input.conversationId)) {
    throw notFound("Chat generation not found");
  }
  return generation;
}

async function nextGenerationSeq(
  tx: ChatGenerationProtocolTransaction,
  generationId: string,
): Promise<number> {
  return tx
    .select({ value: sql<number>`coalesce(max(${chatGenerationEvents.generationSeq}), 0) + 1` })
    .from(chatGenerationEvents)
    .where(eq(chatGenerationEvents.generationId, generationId))
    .then((rows) => Number(rows[0]?.value ?? 1));
}

type AppendEventFields = {
  orgId: string;
  generationId: string;
  attemptEpoch: number;
  eventKind: ChatGenerationEventKind;
  payload?: Record<string, unknown>;
  bodyOffset?: number | null;
  bodyLength?: number | null;
  assistantMessageId?: string | null;
  runId?: string | null;
  controlActionId?: string | null;
  queueItemId?: string | null;
  emittedAt?: Date | null;
};

async function appendEventLocked(
  tx: ChatGenerationProtocolTransaction,
  input: AppendEventFields,
): Promise<GenerationEventRow> {
  const generationSeq = await nextGenerationSeq(tx, input.generationId);
  const [event] = await tx
    .insert(chatGenerationEvents)
    .values({
      orgId: input.orgId,
      generationId: input.generationId,
      generationSeq,
      attemptEpoch: input.attemptEpoch,
      eventKind: input.eventKind,
      payload: input.payload ?? {},
      bodyOffset: input.bodyOffset ?? null,
      bodyLength: input.bodyLength ?? null,
      assistantMessageId: input.assistantMessageId ?? null,
      runId: input.runId ?? null,
      controlActionId: input.controlActionId ?? null,
      queueItemId: input.queueItemId ?? null,
      emittedAt: input.emittedAt ?? null,
    })
    .returning();
  if (!event) throw new Error("Failed to append chat generation event");
  return event;
}

async function bodyHashAtSeq(
  tx: ChatGenerationProtocolTransaction,
  generationId: string,
  generationSeq: number,
): Promise<string | null> {
  if (generationSeq === 0) return EMPTY_BODY_SHA256;
  const event = await tx
    .select({ payload: chatGenerationEvents.payload })
    .from(chatGenerationEvents)
    .where(and(
      eq(chatGenerationEvents.generationId, generationId),
      eq(chatGenerationEvents.generationSeq, generationSeq),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const value = event?.payload?.bodyHash;
  return typeof value === "string" && SHA256_PATTERN.test(value)
    ? value.toLowerCase()
    : null;
}

function terminalStatusFromPayload(payload: Record<string, unknown>): ChatGenerationStatus | null {
  const status = payload.finalStatus;
  return typeof status === "string"
    && (PROJECTABLE_TERMINAL_STATUSES as readonly string[]).includes(status)
    ? status as ChatGenerationStatus
    : null;
}

export type ChatTerminalProjectionClaim = TerminalOutboxRow;

export function chatGenerationProtocolService(db: Db) {
  async function getLatestVisibleCheckpoint(input: {
    orgId: string;
    conversationId: string;
    generationId: string;
  }) {
    const generation = await db
      .select()
      .from(chatGenerations)
      .where(and(
        eq(chatGenerations.id, input.generationId),
        eq(chatGenerations.orgId, input.orgId),
        eq(chatGenerations.conversationId, input.conversationId),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!generation) throw notFound("Chat generation not found");
    const events = await db
      .select({
        generationSeq: chatGenerationEvents.generationSeq,
        payload: chatGenerationEvents.payload,
      })
      .from(chatGenerationEvents)
      .where(eq(chatGenerationEvents.generationId, input.generationId))
      .orderBy(desc(chatGenerationEvents.generationSeq))
      .limit(100);
    for (const event of events) {
      const bodyHash = event.payload?.bodyHash;
      if (typeof bodyHash === "string" && SHA256_PATTERN.test(bodyHash)) {
        return {
          generation,
          generationSeq: event.generationSeq,
          bodyHash: bodyHash.toLowerCase(),
        };
      }
    }
    return { generation, generationSeq: 0, bodyHash: EMPTY_BODY_SHA256 };
  }

  async function appendGenerationEvent(input: AppendEventFields & {
    conversationId?: string;
    expectedOwnerToken?: string | null;
    admission: "visible" | "control" | "diagnostic";
    bodyHash?: string;
    lateBytes?: number;
  }) {
    return db.transaction(async (tx) => {
      const generation = await lockGeneration(tx, input);
      assertGenerationFence(generation, {
        conversationId: input.conversationId,
        expectedAttemptEpoch: input.attemptEpoch,
        expectedOwnerToken: input.expectedOwnerToken,
      });

      if (
        input.admission === "visible"
        && !(OUTPUT_ADMITTING_GENERATION_STATUSES as readonly string[]).includes(generation.status)
      ) {
        throw conflict("Chat-visible output admission is closed for this generation");
      }

      const payload = { ...(input.payload ?? {}) };
      if (input.admission === "visible") {
        if (!input.bodyHash) {
          throw unprocessable("Visible chat generation events require the projected body hash");
        }
        const bodyHash = normalizeBodyHash(input.bodyHash);
        if (typeof payload.bodyHash === "string" && payload.bodyHash.toLowerCase() !== bodyHash) {
          throw conflict("Chat generation event body hash disagrees with its payload");
        }
        payload.bodyHash = bodyHash;
      }

      const event = await appendEventLocked(tx, { ...input, payload });
      let updatedGeneration = generation;
      if (input.admission === "diagnostic") {
        const [updated] = await tx
          .update(chatGenerations)
          .set({
            lateEventsDropped: sql`${chatGenerations.lateEventsDropped} + 1`,
            lateBytes: sql`${chatGenerations.lateBytes} + ${Math.max(0, input.lateBytes ?? 0)}`,
            updatedAt: new Date(),
          })
          .where(eq(chatGenerations.id, generation.id))
          .returning();
        updatedGeneration = updated ?? generation;
      }
      return { event, generation: updatedGeneration };
    });
  }

  async function recordClientCheckpoint(input: {
    orgId: string;
    conversationId: string;
    generationId: string;
    expectedAttemptEpoch: number;
    expectedOwnerToken?: string | null;
    generationSeq: number;
    renderedBodyHash: string;
    now?: Date;
  }) {
    const renderedBodyHash = normalizeBodyHash(input.renderedBodyHash);
    return db.transaction(async (tx) => {
      const generation = await lockGeneration(tx, input);
      assertGenerationFence(generation, input);
      if (!(OUTPUT_ADMITTING_GENERATION_STATUSES as readonly string[]).includes(generation.status)) {
        throw conflict("Chat generation checkpoint arrived after output admission closed");
      }
      const currentSeq = generation.lastClientCheckpointSeq ?? -1;
      if (input.generationSeq < currentSeq) {
        return { generation, event: null, advanced: false };
      }
      if (input.generationSeq === currentSeq) {
        if (generation.lastClientCheckpointHash !== renderedBodyHash) {
          throw conflict("Chat generation checkpoint hash changed at the same sequence");
        }
        return { generation, event: null, advanced: false };
      }

      const durableHash = await bodyHashAtSeq(tx, generation.id, input.generationSeq);
      if (!durableHash) {
        throw conflict("Chat generation checkpoint does not reference a durable visible event");
      }
      if (durableHash !== renderedBodyHash) {
        throw conflict("Chat generation checkpoint hash does not match the durable projection");
      }

      const now = input.now ?? new Date();
      const [updatedGeneration] = await tx
        .update(chatGenerations)
        .set({
          lastClientCheckpointSeq: input.generationSeq,
          lastClientCheckpointHash: renderedBodyHash,
          updatedAt: now,
        })
        .where(and(
          eq(chatGenerations.id, generation.id),
          eq(chatGenerations.attemptEpoch, input.expectedAttemptEpoch),
        ))
        .returning();
      if (!updatedGeneration) throw conflict("Chat generation changed while checkpointing");
      const event = await appendEventLocked(tx, {
        orgId: input.orgId,
        generationId: generation.id,
        attemptEpoch: input.expectedAttemptEpoch,
        eventKind: "client_checkpoint",
        payload: {
          generationSeq: input.generationSeq,
          renderedBodyHash,
        },
      });
      return { generation: updatedGeneration, event, advanced: true };
    });
  }

  async function beginStopAction(input: {
    orgId: string;
    conversationId: string;
    controlActionId: string;
    expectedGenerationId: string;
    expectedAttemptEpoch: number;
    expectedControlVersion: number;
    requestedRenderSeq: number;
    requestedBodyHash: string;
    now?: Date;
  }): Promise<{
    action: ControlActionRow;
    generation: GenerationRow;
    stopRequestedEvent: GenerationEventRow | null;
    outputCutoffEvent: GenerationEventRow | null;
    idempotent: boolean;
  }> {
    const requestedBodyHash = normalizeBodyHash(input.requestedBodyHash);
    return db.transaction(async (tx) => {
      const generation = await lockGeneration(tx, {
        orgId: input.orgId,
        conversationId: input.conversationId,
        generationId: input.expectedGenerationId,
      });
      const existingAction = await tx
        .select()
        .from(chatControlActions)
        .where(eq(chatControlActions.id, input.controlActionId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (existingAction) {
        if (
          existingAction.orgId !== input.orgId
          || existingAction.actionKind !== "stop"
          || existingAction.expectedGenerationId !== input.expectedGenerationId
          || existingAction.expectedAttemptEpoch !== input.expectedAttemptEpoch
          || existingAction.requestedRenderSeq !== input.requestedRenderSeq
          || existingAction.requestedBodyHash !== requestedBodyHash
        ) {
          throw conflict("Control action id was already used for a different Stop request");
        }
        return {
          action: existingAction,
          generation,
          stopRequestedEvent: null,
          outputCutoffEvent: null,
          idempotent: true,
        };
      }

      assertGenerationFence(generation, {
        conversationId: input.conversationId,
        expectedAttemptEpoch: input.expectedAttemptEpoch,
      });
      if (generation.runtimeTerminalAt) {
        throw conflict("Chat generation runtime is already terminal");
      }
      if (!(CONTROL_ACTIVE_GENERATION_STATUSES as readonly string[]).includes(generation.status)) {
        throw conflict("Chat generation is no longer stoppable");
      }
      if (generation.controlVersion !== input.expectedControlVersion) {
        throw conflict("Chat generation control version changed");
      }

      const durableCheckpointIsNewer = generation.lastClientCheckpointSeq !== null
        && generation.lastClientCheckpointHash
        && generation.lastClientCheckpointSeq > input.requestedRenderSeq;
      const requestedDurableHash = durableCheckpointIsNewer
        ? null
        : await bodyHashAtSeq(tx, generation.id, input.requestedRenderSeq);
      let acceptedThroughSeq: number;
      let frozenBodyHash: string;
      if (durableCheckpointIsNewer) {
        acceptedThroughSeq = generation.lastClientCheckpointSeq!;
        frozenBodyHash = generation.lastClientCheckpointHash!;
      } else if (requestedDurableHash) {
        if (requestedDurableHash !== requestedBodyHash) {
          throw conflict("Stop body hash does not match the durable visible projection");
        }
        acceptedThroughSeq = input.requestedRenderSeq;
        frozenBodyHash = requestedBodyHash;
      } else if (
        generation.lastClientCheckpointSeq !== null
        && generation.lastClientCheckpointHash
      ) {
        acceptedThroughSeq = generation.lastClientCheckpointSeq;
        frozenBodyHash = generation.lastClientCheckpointHash;
      } else {
        throw conflict("Stop could not establish a durable rendered checkpoint");
      }

      const now = input.now ?? new Date();
      const appliedControlVersion = generation.controlVersion + 1;
      const [action] = await tx
        .insert(chatControlActions)
        .values({
          id: input.controlActionId,
          orgId: input.orgId,
          expectedGenerationId: generation.id,
          expectedAttemptEpoch: input.expectedAttemptEpoch,
          expectedControlVersion: input.expectedControlVersion,
          appliedControlVersion,
          actionKind: "stop",
          localDisposition: "stop_requested",
          providerDisposition: "not_sent",
          controlOwnerToken: generation.controlOwnerToken,
          requestedRenderSeq: input.requestedRenderSeq,
          requestedBodyHash,
          acceptedThroughSeq,
          frozenBodyHash,
          requestedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!action) throw new Error("Failed to persist Stop control action");

      const stopRequestedEvent = await appendEventLocked(tx, {
        orgId: input.orgId,
        generationId: generation.id,
        attemptEpoch: input.expectedAttemptEpoch,
        eventKind: "stop_requested",
        controlActionId: action.id,
        payload: {
          controlActionId: action.id,
          requestedRenderSeq: input.requestedRenderSeq,
          requestedBodyHash,
          acceptedThroughSeq,
          frozenBodyHash,
          appliedControlVersion,
        },
      });
      const outputCutoffEvent = await appendEventLocked(tx, {
        orgId: input.orgId,
        generationId: generation.id,
        attemptEpoch: input.expectedAttemptEpoch,
        eventKind: "output_cutoff",
        controlActionId: action.id,
        payload: {
          controlActionId: action.id,
          acceptedThroughSeq,
          frozenBodyHash,
        },
      });
      const [updatedGeneration] = await tx
        .update(chatGenerations)
        .set({
          status: "stop_requested",
          controlState: "stopping",
          controlVersion: appliedControlVersion,
          acceptedThroughSeq,
          frozenBodyHash,
          stopRequestedAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(chatGenerations.id, generation.id),
          eq(chatGenerations.attemptEpoch, input.expectedAttemptEpoch),
          eq(chatGenerations.controlVersion, input.expectedControlVersion),
        ))
        .returning();
      if (!updatedGeneration) throw conflict("Chat generation changed while applying Stop");
      return {
        action,
        generation: updatedGeneration,
        stopRequestedEvent,
        outputCutoffEvent,
        idempotent: false,
      };
    });
  }

  async function recordRuntimeTerminal(input: {
    orgId: string;
    conversationId: string;
    generationId: string;
    expectedAttemptEpoch: number;
    expectedOwnerToken?: string | null;
    finalStatus: Extract<ChatGenerationStatus,
      "completed" | "failed" | "stopped" | "aborted" | "interrupted_unverified">;
    terminalReason: string;
    controlActionId?: string | null;
    payload?: Record<string, unknown>;
    now?: Date;
  }) {
    return db.transaction(async (tx) => {
      const generation = await lockGeneration(tx, input);
      assertGenerationFence(generation, input);
      const stopWon = generation.status === "stop_requested"
        || generation.status === "stopping"
        || generation.stopRequestedAt !== null;
      const finalStatus = stopWon ? "stopped" : input.finalStatus;
      const terminalReason = stopWon ? "operator_stop" : input.terminalReason;
      const projectionVersion = generation.controlVersion;

      const existingOutbox = await tx
        .select()
        .from(chatGenerationTerminalOutbox)
        .where(and(
          eq(chatGenerationTerminalOutbox.generationId, input.generationId),
          eq(chatGenerationTerminalOutbox.projectionVersion, projectionVersion),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (existingOutbox) {
        if (
          terminalStatusFromPayload(existingOutbox.payload) !== finalStatus
          || existingOutbox.payload.terminalReason !== terminalReason
        ) {
          throw conflict("Terminal projection version was reused with different evidence");
        }
        return { generation, event: null, outbox: existingOutbox, idempotent: true };
      }
      if (!(RECOVERABLE_CONTROL_GENERATION_STATUSES as readonly string[]).includes(generation.status)) {
        throw conflict("Chat generation is already terminal");
      }

      const now = input.now ?? new Date();
      const inferredControlActionId = input.controlActionId ?? (
        finalStatus === "stopped" || finalStatus === "interrupted_unverified"
          ? await tx
            .select({ id: chatControlActions.id })
            .from(chatControlActions)
            .where(and(
              eq(chatControlActions.orgId, input.orgId),
              eq(chatControlActions.expectedGenerationId, input.generationId),
              eq(chatControlActions.actionKind, "stop"),
            ))
            .orderBy(desc(chatControlActions.requestedAt))
            .limit(1)
            .then((rows) => rows[0]?.id ?? null)
          : null
      );
      const payload = {
        ...(input.payload ?? {}),
        attemptEpoch: generation.attemptEpoch,
        finalStatus,
        terminalReason,
        controlActionId: inferredControlActionId,
        runtimeTerminationVerified: finalStatus !== "interrupted_unverified",
      };
      const event = await appendEventLocked(tx, {
        orgId: input.orgId,
        generationId: input.generationId,
        attemptEpoch: input.expectedAttemptEpoch,
        eventKind: "runtime_terminal",
        controlActionId: inferredControlActionId,
        payload,
      });
      const [outbox] = await tx
        .insert(chatGenerationTerminalOutbox)
        .values({
          orgId: input.orgId,
          generationId: input.generationId,
          sourceEventId: event.id,
          projectionVersion,
          expectedControlVersion: generation.controlVersion,
          payload,
          availableAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!outbox) throw new Error("Failed to enqueue chat terminal projection");
      const stagingStatus = finalStatus === "stopped"
        || finalStatus === "interrupted_unverified"
        ? "stopping"
        : "closing";
      const [updatedGeneration] = await tx
        .update(chatGenerations)
        .set({
          status: stagingStatus,
          controlState: stagingStatus === "stopping" ? "stopping" : generation.controlState,
          terminalReason,
          runtimeTerminalAt: now,
          updatedAt: now,
        })
        .where(eq(chatGenerations.id, generation.id))
        .returning();
      return {
        generation: updatedGeneration ?? generation,
        event,
        outbox,
        idempotent: false,
      };
    });
  }

  async function claimTerminalProjection(input: {
    workerId: string;
    leaseMs: number;
    orgId?: string;
    now?: Date;
  }): Promise<ChatTerminalProjectionClaim | null> {
    const now = input.now ?? new Date();
    const leaseExpiresAt = new Date(now.getTime() + input.leaseMs);
    return db.transaction(async (tx) => {
      const conditions = [
        lte(chatGenerationTerminalOutbox.availableAt, now),
        or(
          inArray(chatGenerationTerminalOutbox.status, ["pending", "retry_wait"]),
          and(
            eq(chatGenerationTerminalOutbox.status, "claimed"),
            or(
              sql`${chatGenerationTerminalOutbox.leaseExpiresAt} is null`,
              lte(chatGenerationTerminalOutbox.leaseExpiresAt, now),
            ),
          ),
        ),
      ];
      if (input.orgId) conditions.push(eq(chatGenerationTerminalOutbox.orgId, input.orgId));
      const candidate = await tx
        .select()
        .from(chatGenerationTerminalOutbox)
        .where(and(...conditions))
        .orderBy(asc(chatGenerationTerminalOutbox.availableAt), asc(chatGenerationTerminalOutbox.createdAt))
        .limit(1)
        .for("update", { skipLocked: true })
        .then((rows) => rows[0] ?? null);
      if (!candidate) return null;

      const claimToken = randomUUID();
      const claimEpoch = candidate.claimEpoch + 1;
      const [claimed] = await tx
        .update(chatGenerationTerminalOutbox)
        .set({
          status: "claimed",
          claimToken,
          claimEpoch,
          claimOwner: input.workerId,
          leaseExpiresAt,
          attemptCount: sql`${chatGenerationTerminalOutbox.attemptCount} + 1`,
          replayCount: candidate.status === "claimed"
            ? sql`${chatGenerationTerminalOutbox.replayCount} + 1`
            : chatGenerationTerminalOutbox.replayCount,
          lastAttemptAt: now,
          updatedAt: now,
        })
        .where(eq(chatGenerationTerminalOutbox.id, candidate.id))
        .returning();
      return claimed ?? null;
    });
  }

  async function getNextTerminalProjectionWakeAt(input: { orgId?: string } = {}) {
    const conditions = [
      inArray(chatGenerationTerminalOutbox.status, ["pending", "retry_wait", "claimed"]),
    ];
    if (input.orgId) conditions.push(eq(chatGenerationTerminalOutbox.orgId, input.orgId));
    const next = await db
      .select({
        status: chatGenerationTerminalOutbox.status,
        availableAt: chatGenerationTerminalOutbox.availableAt,
        leaseExpiresAt: chatGenerationTerminalOutbox.leaseExpiresAt,
      })
      .from(chatGenerationTerminalOutbox)
      .where(and(...conditions))
      .orderBy(asc(sql`
        case
          when ${chatGenerationTerminalOutbox.status} = 'claimed'
            and ${chatGenerationTerminalOutbox.leaseExpiresAt} is not null
            and ${chatGenerationTerminalOutbox.leaseExpiresAt} > ${chatGenerationTerminalOutbox.availableAt}
          then ${chatGenerationTerminalOutbox.leaseExpiresAt}
          else ${chatGenerationTerminalOutbox.availableAt}
        end
      `))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!next) return null;
    if (
      next.status === "claimed"
      && next.leaseExpiresAt
      && next.leaseExpiresAt > next.availableAt
    ) {
      return next.leaseExpiresAt;
    }
    return next.availableAt;
  }

  async function completeTerminalProjection(input: {
    outboxId: string;
    claimToken: string;
    claimEpoch: number;
    finalStatus?: Extract<ChatGenerationStatus,
      "completed" | "failed" | "stopped" | "aborted" | "interrupted_unverified" | "control_lost">;
    terminalReason?: string;
    controlDisposition?: ChatControlDisposition;
    now?: Date;
    project?: (
      tx: ChatGenerationProtocolTransaction,
      claim: ChatTerminalProjectionClaim,
    ) => Promise<void>;
  }) {
    const now = input.now ?? new Date();
    return db.transaction(async (tx) => {
      const observedClaim = await tx
        .select({
          id: chatGenerationTerminalOutbox.id,
          orgId: chatGenerationTerminalOutbox.orgId,
          generationId: chatGenerationTerminalOutbox.generationId,
        })
        .from(chatGenerationTerminalOutbox)
        .where(eq(chatGenerationTerminalOutbox.id, input.outboxId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!observedClaim) return null;
      const generation = await lockGeneration(tx, {
        orgId: observedClaim.orgId,
        generationId: observedClaim.generationId,
      });
      await tx.execute(sql`
        select ${chatGenerationTerminalOutbox.id}
        from ${chatGenerationTerminalOutbox}
        where ${chatGenerationTerminalOutbox.id} = ${input.outboxId}
        for update
      `);
      const claim = await tx
        .select()
        .from(chatGenerationTerminalOutbox)
        .where(eq(chatGenerationTerminalOutbox.id, input.outboxId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (
        !claim
        || claim.status !== "claimed"
        || claim.claimToken !== input.claimToken
        || claim.claimEpoch !== input.claimEpoch
        || !claim.leaseExpiresAt
        || claim.leaseExpiresAt <= now
      ) {
        return null;
      }
      if (generation.controlVersion !== claim.expectedControlVersion) {
        throw conflict("Terminal projector claim has a stale control version");
      }
      const sourceAttemptEpoch = Number(claim.payload.attemptEpoch);
      if (!Number.isInteger(sourceAttemptEpoch) || sourceAttemptEpoch !== generation.attemptEpoch) {
        const [superseded] = await tx
          .update(chatGenerationTerminalOutbox)
          .set({
            status: "superseded",
            claimToken: null,
            claimOwner: null,
            leaseExpiresAt: null,
            projectedAt: now,
            lastError: "terminal_projection_attempt_superseded",
            updatedAt: now,
          })
          .where(and(
            eq(chatGenerationTerminalOutbox.id, claim.id),
            eq(chatGenerationTerminalOutbox.status, "claimed"),
            eq(chatGenerationTerminalOutbox.claimToken, input.claimToken),
            eq(chatGenerationTerminalOutbox.claimEpoch, input.claimEpoch),
          ))
          .returning();
        return superseded ? {
          outbox: superseded,
          generation,
          event: null,
          superseded: true as const,
        } : null;
      }
      const finalStatus = input.finalStatus ?? terminalStatusFromPayload(claim.payload);
      if (!finalStatus || !(PROJECTABLE_TERMINAL_STATUSES as readonly string[]).includes(finalStatus)) {
        throw unprocessable("Terminal projector claim does not name a supported final status");
      }
      const terminalReason = input.terminalReason
        ?? (typeof claim.payload.terminalReason === "string" ? claim.payload.terminalReason : finalStatus);

      await input.project?.(tx, claim);
      const deliveredSteers = await tx
        .update(chatQueuedMessages)
        .set({
          status: "delivered",
          deliveryDisposition: "delivered",
          reconciliationReason: null,
          lastDeliveryReason: null,
          version: sql`${chatQueuedMessages.version} + 1`,
          updatedAt: now,
        })
        .where(and(
          or(
            eq(chatQueuedMessages.status, "accepted_current"),
            and(
              eq(chatQueuedMessages.status, "steer_pending"),
              inArray(
                chatQueuedMessages.controlActionId,
                tx
                  .select({ id: chatControlActions.id })
                  .from(chatControlActions)
                  .where(eq(chatControlActions.providerDisposition, "acknowledged")),
              ),
            ),
          ),
          or(
            eq(chatQueuedMessages.expectedGenerationId, claim.generationId),
            eq(chatQueuedMessages.activeGenerationId, claim.generationId),
          ),
        ))
        .returning({ controlActionId: chatQueuedMessages.controlActionId });
      const deliveredControlActionIds = deliveredSteers
        .map((item) => item.controlActionId)
        .filter((id): id is string => Boolean(id));
      if (deliveredControlActionIds.length > 0) {
        await tx
          .update(chatControlActions)
          .set({ localDisposition: "delivered", resolvedAt: now, updatedAt: now })
          .where(inArray(chatControlActions.id, deliveredControlActionIds));
      }

      const uncertainSteers = await tx
        .update(chatQueuedMessages)
        .set({
          status: "acceptance_unknown",
          deliveryDisposition: "acceptance_unknown",
          reconciliationReason: `provider_receipt_unknown_at_${finalStatus}`,
          lastDeliveryReason: `provider_receipt_unknown_at_${finalStatus}`,
          version: sql`${chatQueuedMessages.version} + 1`,
          updatedAt: now,
        })
        .where(and(
          eq(chatQueuedMessages.status, "steer_pending"),
          inArray(
            chatQueuedMessages.controlActionId,
            tx
              .select({ id: chatControlActions.id })
              .from(chatControlActions)
              .where(inArray(chatControlActions.providerDisposition, [
                "sent",
                "timed_out",
                "connection_lost",
                "waiting_safe_boundary",
                "unverified",
              ])),
          ),
          or(
            eq(chatQueuedMessages.expectedGenerationId, claim.generationId),
            eq(chatQueuedMessages.activeGenerationId, claim.generationId),
          ),
        ))
        .returning({ controlActionId: chatQueuedMessages.controlActionId });
      const uncertainControlActionIds = uncertainSteers
        .map((item) => item.controlActionId)
        .filter((id): id is string => Boolean(id));
      if (uncertainControlActionIds.length > 0) {
        await tx
          .update(chatControlActions)
          .set({
            localDisposition: "acceptance_unknown",
            lastError: `provider_receipt_unknown_at_${finalStatus}`,
            resolvedAt: now,
            updatedAt: now,
          })
          .where(inArray(chatControlActions.id, uncertainControlActionIds));
      }

      const continuationSteers = await tx
        .update(chatQueuedMessages)
        .set({
          status: "continuation_pending",
          deliveryDisposition: "continuation_pending",
          reconciliationReason: `target_generation_${finalStatus}`,
          lastDeliveryReason: null,
          version: sql`${chatQueuedMessages.version} + 1`,
          updatedAt: now,
        })
        .where(and(
          eq(chatQueuedMessages.status, "steer_pending"),
          or(
            isNull(chatQueuedMessages.controlActionId),
            inArray(
              chatQueuedMessages.controlActionId,
              tx
                .select({ id: chatControlActions.id })
                .from(chatControlActions)
                .where(or(
                  eq(chatControlActions.providerDisposition, "not_sent"),
                  eq(chatControlActions.providerDisposition, "rejected"),
                  isNull(chatControlActions.providerDisposition),
                )),
            ),
          ),
          or(
            eq(chatQueuedMessages.expectedGenerationId, claim.generationId),
            eq(chatQueuedMessages.activeGenerationId, claim.generationId),
          ),
        ))
        .returning({ controlActionId: chatQueuedMessages.controlActionId });
      const continuationControlActionIds = continuationSteers
        .map((item) => item.controlActionId)
        .filter((id): id is string => Boolean(id));
      if (continuationControlActionIds.length > 0) {
        await tx
          .update(chatControlActions)
          .set({
            localDisposition: "continuation_pending",
            providerDisposition: "not_sent",
            lastError: `target_generation_${finalStatus}`,
            resolvedAt: now,
            updatedAt: now,
          })
          .where(inArray(chatControlActions.id, continuationControlActionIds));
      }
      const terminalProjectedEvent = await appendEventLocked(tx, {
        orgId: claim.orgId,
        generationId: claim.generationId,
        attemptEpoch: generation.attemptEpoch,
        eventKind: "terminal_projected",
        controlActionId: typeof claim.payload.controlActionId === "string"
          ? claim.payload.controlActionId
          : null,
        payload: {
          outboxId: claim.id,
          projectionVersion: claim.projectionVersion,
          finalStatus,
          terminalReason,
        },
      });
      const [updatedGeneration] = await tx
        .update(chatGenerations)
        .set({
          status: finalStatus,
          terminalReason,
          controlState: finalStatus === "control_lost" ? "control_lost" : "terminal",
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(chatGenerations.id, claim.generationId))
        .returning();

      const controlActionId = typeof claim.payload.controlActionId === "string"
        ? claim.payload.controlActionId
        : null;
      if (controlActionId && input.controlDisposition) {
        await tx
          .update(chatControlActions)
          .set({
            localDisposition: input.controlDisposition,
            resolvedAt: now,
            updatedAt: now,
          })
          .where(and(
            eq(chatControlActions.id, controlActionId),
            eq(chatControlActions.orgId, claim.orgId),
          ));
      }

      const [completed] = await tx
        .update(chatGenerationTerminalOutbox)
        .set({
          status: "projected",
          claimToken: null,
          claimOwner: null,
          leaseExpiresAt: null,
          projectedAt: now,
          lastError: null,
          updatedAt: now,
        })
        .where(and(
          eq(chatGenerationTerminalOutbox.id, claim.id),
          eq(chatGenerationTerminalOutbox.status, "claimed"),
          eq(chatGenerationTerminalOutbox.claimToken, input.claimToken),
          eq(chatGenerationTerminalOutbox.claimEpoch, input.claimEpoch),
        ))
        .returning();
      if (!completed || !updatedGeneration) {
        throw conflict("Terminal projector claim changed while completing");
      }
      return {
        outbox: completed,
        generation: updatedGeneration,
        event: terminalProjectedEvent,
      };
    });
  }

  async function retryTerminalProjection(input: {
    outboxId: string;
    claimToken: string;
    claimEpoch: number;
    error: string;
    retryAt: Date;
    maxAttempts: number;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const claim = await db
      .select({ attemptCount: chatGenerationTerminalOutbox.attemptCount })
      .from(chatGenerationTerminalOutbox)
      .where(and(
        eq(chatGenerationTerminalOutbox.id, input.outboxId),
        eq(chatGenerationTerminalOutbox.status, "claimed"),
        eq(chatGenerationTerminalOutbox.claimToken, input.claimToken),
        eq(chatGenerationTerminalOutbox.claimEpoch, input.claimEpoch),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!claim) return null;
    const failedActionable = claim.attemptCount >= input.maxAttempts;
    const [updated] = await db
      .update(chatGenerationTerminalOutbox)
      .set({
        status: failedActionable ? "failed_actionable" : "retry_wait",
        claimToken: null,
        claimOwner: null,
        leaseExpiresAt: null,
        availableAt: failedActionable ? now : input.retryAt,
        lastError: input.error,
        updatedAt: now,
      })
      .where(and(
        eq(chatGenerationTerminalOutbox.id, input.outboxId),
        eq(chatGenerationTerminalOutbox.status, "claimed"),
        eq(chatGenerationTerminalOutbox.claimToken, input.claimToken),
        eq(chatGenerationTerminalOutbox.claimEpoch, input.claimEpoch),
      ))
      .returning();
    return updated ?? null;
  }

  async function recoverStaleControlOwners(input: {
    now?: Date;
    limit?: number;
    assumeAllOwnersStale?: boolean;
  }) {
    const now = input.now ?? new Date();
    const candidates = await db
      .select({ id: chatGenerations.id, orgId: chatGenerations.orgId })
      .from(chatGenerations)
      .where(and(
        inArray(chatGenerations.status, RECOVERABLE_CONTROL_GENERATION_STATUSES),
        isNotNull(chatGenerations.controlOwnerToken),
        input.assumeAllOwnersStale
          ? sql`true`
          : and(
            isNotNull(chatGenerations.controlLeaseExpiresAt),
            lte(chatGenerations.controlLeaseExpiresAt, now),
          ),
      ))
      .orderBy(asc(chatGenerations.updatedAt))
      .limit(Math.max(1, input.limit ?? 100));

    const recovered: Array<{
      generation: GenerationRow;
      event: GenerationEventRow;
      outbox: TerminalOutboxRow;
    }> = [];
    for (const candidate of candidates) {
      const result = await db.transaction(async (tx) => {
        const generation = await lockGeneration(tx, {
          orgId: candidate.orgId,
          generationId: candidate.id,
        });
        if (
          !(RECOVERABLE_CONTROL_GENERATION_STATUSES as readonly string[]).includes(generation.status)
          || !generation.controlOwnerToken
          || (
            !input.assumeAllOwnersStale
            && (!generation.controlLeaseExpiresAt || generation.controlLeaseExpiresAt > now)
          )
        ) {
          return null;
        }
        const nextControlVersion = generation.controlVersion + 1;
        const payload = {
          attemptEpoch: generation.attemptEpoch,
          finalStatus: "control_lost",
          terminalReason: "control_owner_stale",
          runtimeTerminationVerified: false,
          staleOwnerToken: generation.controlOwnerToken,
          staleAttemptEpoch: generation.attemptEpoch,
        };
        const event = await appendEventLocked(tx, {
          orgId: generation.orgId,
          generationId: generation.id,
          attemptEpoch: generation.attemptEpoch,
          eventKind: "terminal_projection_requested",
          payload,
        });
        const [outbox] = await tx
          .insert(chatGenerationTerminalOutbox)
          .values({
            orgId: generation.orgId,
            generationId: generation.id,
            sourceEventId: event.id,
            projectionVersion: nextControlVersion,
            expectedControlVersion: nextControlVersion,
            payload,
            availableAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!outbox) throw new Error("Failed to enqueue stale chat control recovery");
        const [updatedGeneration] = await tx
          .update(chatGenerations)
          .set({
            status: "control_lost",
            terminalReason: "control_owner_stale",
            controlState: "control_lost",
            controlVersion: nextControlVersion,
            controlOwnerToken: null,
            controlLeaseExpiresAt: null,
            completedAt: now,
            updatedAt: now,
          })
          .where(and(
            eq(chatGenerations.id, generation.id),
            eq(chatGenerations.controlVersion, generation.controlVersion),
          ))
          .returning();
        if (!updatedGeneration) throw conflict("Stale chat control owner changed during recovery");
        return { generation: updatedGeneration, event, outbox };
      });
      if (result) recovered.push(result);
    }
    return recovered;
  }

  return {
    getLatestVisibleCheckpoint,
    appendGenerationEvent,
    recordClientCheckpoint,
    beginStopAction,
    recordRuntimeTerminal,
    claimTerminalProjection,
    getNextTerminalProjectionWakeAt,
    completeTerminalProjection,
    retryTerminalProjection,
    recoverStaleControlOwners,
  };
}
