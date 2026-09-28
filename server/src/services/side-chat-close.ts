import type { Db } from "@rudderhq/db";
import {
  assets,
  chatAttachments,
  chatConversations,
  chatGenerations,
  chatQueuedMessages,
  heartbeatRuns,
  issueAttachments,
  organizationLogos,
  sideChatCloseIntents,
} from "@rudderhq/db";
import { and, asc, eq, gt, inArray, lte, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { startingChatGenerationGates } from "../routes/chats.stream-support.js";
import type { StorageService } from "../storage/types.js";
import { logActivity } from "./activity-log.js";
import {
  cancelActiveChatGeneration,
  getActiveChatGeneration,
  hasActiveChatGeneration,
} from "./chat-generation-locks.js";
import { chatGenerationProtocolService } from "./chat-generation-protocol.js";
import { queuedAnnotationAssetState } from "./chat-queued-message-materialization.js";
import { ACTIVE_CHAT_GENERATION_STATUSES } from "./chats.constants.js";
import { sideChatRunReference, sideChatService } from "./side-chats.js";

type CloseIntent = typeof sideChatCloseIntents.$inferSelect;
type CloseOutcome = "closed" | "pending" | "review_required";

const LEASE_MS = 30_000;
const RETRY_MS = 1_000;
const DEFAULT_INTERVAL_MS = 2_000;

export function sideChatCloseService(
  db: Db,
  storage: StorageService,
  sideChats = sideChatService(db),
  workerId = randomUUID(),
) {
  const generationProtocol = chatGenerationProtocolService(db);
  const claimCondition = (intent: CloseIntent) => and(
    eq(sideChatCloseIntents.id, intent.id),
    eq(sideChatCloseIntents.state, "claimed"),
    eq(sideChatCloseIntents.leaseOwner, workerId),
    eq(sideChatCloseIntents.leaseEpoch, intent.leaseEpoch),
    gt(sideChatCloseIntents.leaseExpiresAt, new Date()),
  );

  async function claim(intentId?: string): Promise<CloseIntent | null> {
    const now = new Date();
    return db.transaction(async (tx) => {
      const due = or(
        and(inArray(sideChatCloseIntents.state, ["requested", "retry_wait"]),
          lte(sideChatCloseIntents.nextAttemptAt, now)),
        and(eq(sideChatCloseIntents.state, "claimed"), lte(sideChatCloseIntents.leaseExpiresAt, now)),
      );
      const [candidate] = await tx.select().from(sideChatCloseIntents)
        .where(intentId ? and(eq(sideChatCloseIntents.id, intentId), due) : due)
        .orderBy(asc(sideChatCloseIntents.nextAttemptAt), asc(sideChatCloseIntents.createdAt))
        .limit(1).for("update", { skipLocked: true });
      if (!candidate) return null;
      const [claimed] = await tx.update(sideChatCloseIntents).set({
        state: "claimed",
        leaseOwner: workerId,
        leaseEpoch: candidate.leaseEpoch + 1,
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        attemptCount: candidate.attemptCount + 1,
        updatedAt: now,
      }).where(eq(sideChatCloseIntents.id, candidate.id)).returning();
      return claimed ?? null;
    });
  }

  async function release(intent: CloseIntent, reason: string, review = false): Promise<CloseOutcome> {
    const now = new Date();
    const [released] = await db.update(sideChatCloseIntents).set({
      state: review ? "review_required" : "retry_wait",
      lastError: reason,
      nextAttemptAt: new Date(now.getTime() + RETRY_MS),
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: now,
    }).where(claimCondition(intent)).returning({ id: sideChatCloseIntents.id });
    return review && released ? "review_required" : "pending";
  }

  async function requestStop(intent: CloseIntent, generation: typeof chatGenerations.$inferSelect) {
    if (generation.status === "stop_requested" || generation.status === "stopping") {
      cancelActiveChatGeneration(intent.conversationId);
      startingChatGenerationGates.get(intent.conversationId)?.resolveStopApplied();
      return;
    }
    let actionId = intent.stopControlActionId;
    if (intent.stopGenerationId !== generation.id) {
      actionId = intent.stopGenerationId ? randomUUID() : actionId;
      const [updated] = await db.update(sideChatCloseIntents).set({
        stopGenerationId: generation.id,
        stopControlActionId: actionId,
        updatedAt: new Date(),
      }).where(claimCondition(intent)).returning({ id: sideChatCloseIntents.id });
      if (!updated) throw new Error("Side Chat close claim changed before Stop");
    }
    const checkpoint = await generationProtocol.getLatestVisibleCheckpoint({
      orgId: intent.orgId,
      conversationId: intent.conversationId,
      generationId: generation.id,
    });
    if (checkpoint.generation.runtimeTerminalAt) return;
    const stop = await generationProtocol.beginStopAction({
      orgId: intent.orgId,
      conversationId: intent.conversationId,
      controlActionId: actionId,
      expectedGenerationId: generation.id,
      expectedAttemptEpoch: checkpoint.generation.attemptEpoch,
      expectedControlVersion: checkpoint.generation.controlVersion,
      requestedRenderSeq: checkpoint.generationSeq,
      requestedBodyHash: checkpoint.bodyHash,
    });
    if (stop.outcome === "stop_applied" || stop.outcome === "stop_in_progress") {
      cancelActiveChatGeneration(intent.conversationId);
      startingChatGenerationGates.get(intent.conversationId)?.resolveStopApplied();
    }
  }

  async function cleanupAttachments(intent: CloseIntent): Promise<CloseOutcome> {
    let cursor = intent.attachmentCursor;
    while (cursor < intent.attachmentsJson.length) {
      const attachment = intent.attachmentsJson[cursor]!;
      if (storage.provider && attachment.provider !== storage.provider) {
        return release(intent, "attachment_storage_provider_changed", true);
      }
      const step = await db.transaction(async (tx) => {
        // Remove the asset identity before I/O. A crash or expired lease can
        // repeat object deletion, but cannot admit a new FK to this asset.
        const [current] = await tx.select().from(sideChatCloseIntents)
          .where(and(
            eq(sideChatCloseIntents.id, intent.id),
            eq(sideChatCloseIntents.state, "claimed"),
            eq(sideChatCloseIntents.leaseOwner, workerId),
            eq(sideChatCloseIntents.leaseEpoch, intent.leaseEpoch),
          )).for("update").limit(1);
        if (!current || current.attachmentCursor !== cursor) return "lost" as const;
        const [asset] = await tx.select().from(assets)
          .where(and(eq(assets.orgId, attachment.orgId), eq(assets.id, attachment.assetId)))
          .for("update").limit(1);
        if (asset) {
          if (asset.objectKey !== attachment.objectKey || asset.provider !== attachment.provider) {
            return "review" as const;
          }
          const [chatRef] = await tx.select({ id: chatAttachments.id }).from(chatAttachments)
            .where(eq(chatAttachments.assetId, asset.id)).limit(1);
          const [issueRef] = await tx.select({ id: issueAttachments.id }).from(issueAttachments)
            .where(eq(issueAttachments.assetId, asset.id)).limit(1);
          const [logoRef] = await tx.select({ id: organizationLogos.id }).from(organizationLogos)
            .where(eq(organizationLogos.assetId, asset.id)).limit(1);
          const queueRows = await tx.select({ payload: chatQueuedMessages.payload })
            .from(chatQueuedMessages).where(eq(chatQueuedMessages.orgId, attachment.orgId));
          const queueRef = queueRows.some((row) => queuedAnnotationAssetState(row.payload)
            ?.attachments.some((ref) => ref.assetId === asset.id));
          if (chatRef || issueRef || logoRef || queueRef) {
            await tx.update(sideChatCloseIntents).set({
              attachmentCursor: cursor + 1,
              updatedAt: new Date(),
            }).where(eq(sideChatCloseIntents.id, intent.id));
            return "shared" as const;
          }
          await tx.delete(assets).where(eq(assets.id, asset.id));
        } else {
          const [reusedKey] = await tx.select({ id: assets.id }).from(assets)
            .where(and(eq(assets.orgId, attachment.orgId), eq(assets.objectKey, attachment.objectKey)))
            .limit(1);
          if (reusedKey) return "review" as const;
        }
        return "delete" as const;
      });
      if (step === "lost") return "pending";
      if (step === "review") return release(intent, "attachment_identity_or_provider_changed", true);
      if (step === "delete") {
        await storage.deleteObject(attachment.orgId, attachment.objectKey);
        if ((await storage.headObject(attachment.orgId, attachment.objectKey)).exists) {
          throw new Error("Side Chat attachment object still exists after deletion");
        }
        const [advanced] = await db.update(sideChatCloseIntents).set({
          attachmentCursor: cursor + 1,
          updatedAt: new Date(),
        }).where(claimCondition(intent)).returning({ id: sideChatCloseIntents.id });
        if (!advanced) return "pending";
      }
      cursor += 1;
    }
    await logActivity(db, {
      orgId: intent.orgId,
      actorType: "user",
      actorId: intent.ownerUserId,
      action: "chat.side_chat_destroyed",
      entityType: "chat",
      entityId: intent.conversationId,
      idempotencyKey: `chat.side_chat_destroyed:${intent.conversationId}`,
      details: {
        sourceConversationId: intent.sourceConversationId,
        sourceMessageId: intent.sourceMessageId,
      },
    });
    const [removed] = await db.delete(sideChatCloseIntents).where(claimCondition(intent))
      .returning({ id: sideChatCloseIntents.id });
    return removed ? "closed" : "pending";
  }

  async function processClaim(intent: CloseIntent): Promise<CloseOutcome> {
    const [conversation] = await db.select({
      id: chatConversations.id,
      sideChatState: chatConversations.sideChatState,
      messengerVisible: chatConversations.messengerVisible,
    }).from(chatConversations).where(and(
      eq(chatConversations.orgId, intent.orgId),
      eq(chatConversations.id, intent.conversationId),
    )).limit(1);
    if (!conversation) return cleanupAttachments(intent);
    if (conversation.sideChatState !== "completed" || conversation.messengerVisible) {
      return release(intent, "Side Chat changed after close was requested", true);
    }

    const local = getActiveChatGeneration(intent.conversationId);
    if (local && !local.generationId) {
      const gate = startingChatGenerationGates.get(intent.conversationId);
      if (gate) gate.stopRequested = true;
      cancelActiveChatGeneration(intent.conversationId);
      return release(intent, "waiting_for_generation_registration");
    }
    const generations = await db.select().from(chatGenerations).where(and(
      eq(chatGenerations.orgId, intent.orgId),
      eq(chatGenerations.conversationId, intent.conversationId),
    ));
    const active = generations.find((generation) => (
      ACTIVE_CHAT_GENERATION_STATUSES.includes(generation.status as (typeof ACTIVE_CHAT_GENERATION_STATUSES)[number])
    ));
    if (active) {
      await requestStop(intent, active);
      return release(intent, "waiting_for_generation_terminal");
    }
    if (hasActiveChatGeneration(intent.conversationId)) {
      cancelActiveChatGeneration(intent.conversationId);
      return release(intent, "waiting_for_local_runtime_owner");
    }
    if (generations.some((generation) => (
      !generation.runtimeTerminalAt
      || generation.status === "interrupted_unverified"
      || generation.status === "control_lost"
      || generation.controlState === "control_lost"
    ))) {
      return release(intent, "generation_terminal_not_verified", intent.attemptCount >= 3);
    }
    const [unfinishedRun] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.orgId, intent.orgId),
        sideChatRunReference(intent.conversationId),
        or(inArray(heartbeatRuns.status, ["queued", "running"]),
          eq(heartbeatRuns.terminalEffectsPending, true)),
      )).limit(1);
    if (unfinishedRun) return release(intent, "waiting_for_provider_run_terminal");

    await sideChats.destroy({
      conversationId: intent.conversationId,
      userId: intent.ownerUserId,
      closeClaim: { id: intent.id, owner: workerId, epoch: intent.leaseEpoch },
    });
    const [deleted] = await db.select().from(sideChatCloseIntents)
      .where(claimCondition(intent)).limit(1);
    return deleted ? cleanupAttachments(deleted) : "pending";
  }

  async function processIntent(intentId: string): Promise<CloseOutcome> {
    const intent = await claim(intentId);
    if (!intent) {
      const [pending] = await db.select({ state: sideChatCloseIntents.state })
        .from(sideChatCloseIntents).where(eq(sideChatCloseIntents.id, intentId)).limit(1);
      return pending?.state === "review_required" ? "review_required" : pending ? "pending" : "closed";
    }
    try {
      return await processClaim(intent);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return release(intent, reason);
    }
  }

  async function processBatch(limit = 25): Promise<number> {
    let processed = 0;
    while (processed < limit) {
      const intent = await claim();
      if (!intent) break;
      try {
        await processClaim(intent);
      } catch (error) {
        await release(intent, error instanceof Error ? error.message : String(error));
      }
      processed += 1;
    }
    return processed;
  }

  return { processIntent, processBatch };
}

export function startSideChatCloseWorker(
  db: Db,
  storage: StorageService,
  options: {
    intervalMs?: number;
    logger?: { error?(details: Record<string, unknown>, message: string): void };
  } = {},
) {
  const service = sideChatCloseService(db, storage);
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  const sweep = () => {
    if (stopped || inFlight) return;
    inFlight = service.processBatch().then(() => undefined)
      .catch((error) => options.logger?.error?.({ error }, "Side Chat close recovery failed"))
      .finally(() => { inFlight = null; });
  };
  sweep();
  const timer = setInterval(sweep, Math.max(options.intervalMs ?? DEFAULT_INTERVAL_MS, 1_000));
  timer.unref?.();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
