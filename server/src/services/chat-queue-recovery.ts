import { chatControlActions, chatConversations, chatGenerations, chatQueuedMessages, heartbeatRuns, type Db } from "@rudderhq/db";
import type { ChatQueueRequestActor, ContinueChatQueuedMessage } from "@rudderhq/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import { conflict, forbidden, notFound } from "../errors.js";
import { hydrateQueuedMessage } from "./chat-queued-message-materialization.js";
import { ACTIVE_CHAT_GENERATION_STATUSES } from "./chats.constants.js";

type QueueRow = typeof chatQueuedMessages.$inferSelect;
type ActionRow = typeof chatControlActions.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function boardOwner(actor: ChatQueueRequestActor | null): string | null {
  if (actor?.type !== "board") return null;
  return actor.userId ?? (actor.source === "local_implicit" ? "local-board" : null);
}

export function isUndeliveredRecoveryQueue(item: QueueRow): boolean {
  return item.status === "queued" && item.deliveryIntent === "queue"
    && !item.cancelledAt && item.deliveryAttempts === 0 && item.deliveryLeaseEpoch === 0
    && !item.deliveryLeaseToken && !item.continuationGenerationId && !item.continuationMessageId
    && !item.sourceMessageId && !item.deliveredMessageId && !item.providerClientMessageId
    && !item.providerThreadId && !item.providerTurnId && !item.providerEvidence;
}

export async function hasQueueRecoveryActiveExecution(tx: Tx, orgId: string, conversationId: string) {
  const [generation] = await tx.select({ id: chatGenerations.id }).from(chatGenerations).where(and(
    eq(chatGenerations.orgId, orgId), eq(chatGenerations.conversationId, conversationId),
    inArray(chatGenerations.status, [...ACTIVE_CHAT_GENERATION_STATUSES]),
  )).limit(1);
  const [run] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.orgId, orgId), eq(heartbeatRuns.chatConversationId, conversationId),
    inArray(heartbeatRuns.status, ["queued", "running"]),
  )).limit(1);
  return Boolean(generation || run);
}

/** A Continue command is local admission evidence, never provider acceptance evidence. */
export function matchesQueueRecoveryAuthorization(item: QueueRow, action: ActionRow | null, generationId: string) {
  const proof = action?.providerEvidence;
  return isUndeliveredRecoveryQueue(item) && action?.actionKind === "continue"
    && action.orgId === item.orgId && action.id === item.controlActionId
    && action.expectedGenerationId === generationId
    && action.localDisposition === "continuation_pending" && action.providerDisposition === "not_sent"
    && proof?.kind === "queue_recovery_authorization_v1"
    && proof.queueId === item.id && proof.conversationId === item.conversationId
    && proof.authorizedQueueVersion === item.version && proof.ownerUserId === boardOwner(item.requestActor);
}

export async function authorizeQueuedRecovery(db: Db, input: ContinueChatQueuedMessage & {
  orgId: string; conversationId: string; itemId: string; requestActor: ChatQueueRequestActor;
}) {
  return db.transaction(async (tx) => {
    // Same row lock as cancellation, editing and the worker: a double command cannot authorize twice.
    const [item] = await tx.select().from(chatQueuedMessages).where(and(
      eq(chatQueuedMessages.id, input.itemId), eq(chatQueuedMessages.orgId, input.orgId),
      eq(chatQueuedMessages.conversationId, input.conversationId),
    )).for("update");
    if (!item) throw notFound("Queued message not found");
    const owner = boardOwner(input.requestActor);
    if (!owner || owner !== boardOwner(item.requestActor)) throw forbidden("Only the queued message owner can continue it");
    const [conversation] = await tx.select().from(chatConversations).where(and(
      eq(chatConversations.id, input.conversationId), eq(chatConversations.orgId, input.orgId),
    ));
    if (!conversation || (conversation.createdByUserId && conversation.createdByUserId !== owner)) {
      throw forbidden("Only the conversation owner can continue queued input");
    }
    if (item.cancelledAt || item.status === "cancelled") throw conflict("Cancelled queued input cannot be continued");
    const [existing] = await tx.select().from(chatControlActions).where(eq(chatControlActions.id, input.controlActionId));
    if (existing) {
      const proof = existing.providerEvidence;
      if (existing.orgId !== input.orgId || existing.actionKind !== "continue"
        || item.controlActionId !== existing.id || existing.expectedGenerationId !== input.expectedFailedGenerationId
        || proof?.queueId !== item.id || proof.requestedQueueVersion !== input.version || proof.ownerUserId !== owner) {
        throw conflict("Continue command id is already bound to another request");
      }
      return { item: hydrateQueuedMessage(item), controlActionId: existing.id, idempotent: true };
    }
    if (item.version !== input.version || !isUndeliveredRecoveryQueue(item)) {
      throw conflict("Continue requires the current version of new undelivered queued input");
    }
    const [latest] = await tx.select().from(chatGenerations).where(and(
      eq(chatGenerations.orgId, input.orgId), eq(chatGenerations.conversationId, input.conversationId),
    )).orderBy(desc(chatGenerations.startedAt), desc(chatGenerations.createdAt)).limit(1);
    if (!latest || latest.id !== input.expectedFailedGenerationId || latest.status !== "failed") {
      throw conflict("The latest failed reply changed; refresh before continuing");
    }
    if (await hasQueueRecoveryActiveExecution(tx, input.orgId, input.conversationId)) {
      throw conflict("Cannot continue queued input while execution is active");
    }
    if (item.controlActionId) {
      const [previous] = await tx.select().from(chatControlActions).where(and(
        eq(chatControlActions.id, item.controlActionId), eq(chatControlActions.orgId, input.orgId),
      ));
      if (previous?.actionKind !== "continue" || previous.localDisposition !== "continuation_pending") {
        throw conflict("Queued input already has an unresolved control action");
      }
      if (matchesQueueRecoveryAuthorization(item, previous, latest.id)) {
        throw conflict("Queued input is already authorized to continue");
      }
      await tx.update(chatControlActions).set({ localDisposition: "failed_actionable", lastError: "superseded_queue_recovery", resolvedAt: new Date() })
        .where(eq(chatControlActions.id, previous.id));
    }
    await tx.insert(chatControlActions).values({
      id: input.controlActionId, orgId: input.orgId, actionKind: "continue",
      expectedGenerationId: latest.id, expectedAttemptEpoch: latest.attemptEpoch,
      expectedControlVersion: latest.controlVersion, localDisposition: "continuation_pending", providerDisposition: "not_sent",
      providerEvidence: { kind: "queue_recovery_authorization_v1", queueId: item.id, conversationId: item.conversationId,
        requestedQueueVersion: item.version, authorizedQueueVersion: item.version + 1, ownerUserId: owner },
    });
    const [updated] = await tx.update(chatQueuedMessages).set({
      controlActionId: input.controlActionId, version: item.version + 1, updatedAt: new Date(),
    }).where(eq(chatQueuedMessages.id, item.id)).returning();
    return { item: hydrateQueuedMessage(updated!), controlActionId: input.controlActionId, idempotent: false };
  });
}
