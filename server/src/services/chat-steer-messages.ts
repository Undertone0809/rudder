import type { Db } from "@rudderhq/db";
import {
  chatControlActions,
  chatGenerationEvents,
  chatGenerations,
  chatQueuedMessages,
} from "@rudderhq/db";
import type { ChatQueueRequestActor } from "@rudderhq/shared";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { conflict, notFound } from "../errors.js";
import {
  hydrateQueuedMessage,
  materializeQueuedUserMessage,
} from "./chat-queued-message-materialization.js";

type ActivityActor = {
  actorType: "agent" | "user" | "system";
  actorId: string;
  agentId?: string | null;
};

const NATIVE_STEER_GENERATION_STATUSES = ["starting", "active", "running", "tool_busy"] as const;

export function chatSteerMessageService(db: Db) {
  async function materializeUserMessage(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    input: {
      orgId: string;
      conversationId: string;
      item: typeof chatQueuedMessages.$inferSelect;
      actor: ActivityActor;
      now: Date;
    },
  ) {
    const targetGenerationId = input.item.activeGenerationId ?? input.item.expectedGenerationId;
    const transcriptAnchor = targetGenerationId
      ? await tx
        .select({
          afterTranscriptEntryCount: sql<number>`count(*)::int`,
          generationSeq: sql<number>`coalesce(max(${chatGenerationEvents.generationSeq}), 0)::int`,
        })
        .from(chatGenerationEvents)
        .where(and(
          eq(chatGenerationEvents.orgId, input.orgId),
          eq(chatGenerationEvents.generationId, targetGenerationId),
          eq(chatGenerationEvents.eventKind, "transcript"),
        ))
        .then((rows) => rows[0] ?? { afterTranscriptEntryCount: 0, generationSeq: 0 })
      : { afterTranscriptEntryCount: 0, generationSeq: 0 };
    const materialized = await materializeQueuedUserMessage(tx, {
      orgId: input.orgId,
      conversationId: input.conversationId,
      item: input.item,
      actor: input.actor,
      now: input.now,
      expectedStatuses: [input.item.status],
      structuredPayload: {
        source: "steer",
        targetGenerationId: targetGenerationId ?? null,
        afterTranscriptEntryCount: transcriptAnchor.afterTranscriptEntryCount,
        generationSeq: transcriptAnchor.generationSeq,
        queueItemId: input.item.id,
        controlActionId: input.item.controlActionId,
        deliveryDisposition: input.item.deliveryDisposition,
      },
    });
    return {
      ...materialized,
      item: hydrateQueuedMessage(materialized.item),
    };
  }

  async function controlActionById(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    input: { orgId: string; controlActionId: string | null },
  ) {
    if (!input.controlActionId) return null;
    return tx
      .select()
      .from(chatControlActions)
      .where(and(
        eq(chatControlActions.id, input.controlActionId),
        eq(chatControlActions.orgId, input.orgId),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function scheduleContinuation(input: {
    orgId: string;
    conversationId: string;
    itemId: string;
    controlActionId: string;
    requestActor?: ChatQueueRequestActor | null;
    actor: ActivityActor;
  }) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        select ${chatQueuedMessages.id}
        from ${chatQueuedMessages}
        where ${chatQueuedMessages.id} = ${input.itemId}
          and ${chatQueuedMessages.orgId} = ${input.orgId}
          and ${chatQueuedMessages.conversationId} = ${input.conversationId}
          and ${chatQueuedMessages.cancelledAt} is null
        for update
      `);
      const item = await tx
        .select()
        .from(chatQueuedMessages)
        .where(and(
          eq(chatQueuedMessages.id, input.itemId),
          eq(chatQueuedMessages.orgId, input.orgId),
          eq(chatQueuedMessages.conversationId, input.conversationId),
          isNull(chatQueuedMessages.cancelledAt),
          inArray(chatQueuedMessages.status, ["queued", "steer_pending", "continuation_pending"]),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!item) throw conflict("Queued feedback is no longer schedulable");

      const existingBoundAction = await controlActionById(tx, {
        orgId: input.orgId,
        controlActionId: item.controlActionId,
      });
      if (item.controlActionId && (!existingBoundAction || existingBoundAction.actionKind !== "steer")) {
        throw conflict("Queued feedback has an unresolved Steer action");
      }
      if (existingBoundAction) {
        const materialized = await materializeUserMessage(tx, {
          orgId: input.orgId,
          conversationId: input.conversationId,
          item,
          actor: input.actor,
          now: new Date(),
        });
        return { action: existingBoundAction, item: materialized.item, idempotent: true };
      }

      const actionWithRequestedId = await controlActionById(tx, {
        orgId: input.orgId,
        controlActionId: input.controlActionId,
      });
      if (actionWithRequestedId) {
        throw conflict("Control action id is not bound to this queued feedback");
      }

      const targetGenerationId = item.expectedGenerationId ?? item.activeGenerationId;
      const targetGeneration = targetGenerationId
        ? await tx
          .select()
          .from(chatGenerations)
          .where(and(
            eq(chatGenerations.id, targetGenerationId),
            eq(chatGenerations.orgId, input.orgId),
            eq(chatGenerations.conversationId, input.conversationId),
          ))
          .limit(1)
          .then((rows) => rows[0] ?? null)
        : await tx
          .select()
          .from(chatGenerations)
          .where(and(
            eq(chatGenerations.orgId, input.orgId),
            eq(chatGenerations.conversationId, input.conversationId),
          ))
          .orderBy(desc(chatGenerations.startedAt), desc(chatGenerations.createdAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);
      const now = new Date();
      const [action] = await tx
        .insert(chatControlActions)
        .values({
          id: input.controlActionId,
          orgId: input.orgId,
          expectedGenerationId: targetGeneration?.id ?? null,
          expectedAttemptEpoch: targetGeneration?.attemptEpoch ?? null,
          expectedControlVersion: targetGeneration?.controlVersion ?? null,
          actionKind: "steer",
          localDisposition: "continuation_pending",
          providerDisposition: "not_sent",
          providerClientMessageId: input.controlActionId,
          resolvedAt: now,
        })
        .returning();
      if (!action) throw new Error("Failed to persist Steer continuation action");
      const [updatedItem] = await tx
        .update(chatQueuedMessages)
        .set({
          status: "continuation_pending",
          deliveryIntent: "steer",
          deliveryDisposition: "continuation_pending",
          controlActionId: action.id,
          requestActor: item.requestActor ?? input.requestActor ?? null,
          activeGenerationId: targetGeneration?.id ?? item.activeGenerationId,
          attemptEpoch: targetGeneration?.attemptEpoch ?? item.attemptEpoch,
          providerClientMessageId: action.providerClientMessageId,
          reconciliationReason: targetGeneration ? "target_generation_terminal" : "no_active_generation",
          lastDeliveryReason: null,
          version: sql`${chatQueuedMessages.version} + 1`,
          updatedAt: now,
        })
        .where(and(
          eq(chatQueuedMessages.id, item.id),
          eq(chatQueuedMessages.version, item.version),
          isNull(chatQueuedMessages.cancelledAt),
        ))
        .returning();
      if (!updatedItem) throw conflict("Queued feedback changed while continuation was being scheduled");
      const materialized = await materializeUserMessage(tx, {
        orgId: input.orgId,
        conversationId: input.conversationId,
        item: updatedItem,
        actor: input.actor,
        now,
      });
      return { action, item: materialized.item, idempotent: false };
    });
  }

  async function beginControlAction(input: {
    orgId: string;
    conversationId: string;
    itemId: string;
    controlActionId: string;
    expectedGenerationId: string;
    expectedAttemptEpoch: number;
    expectedControlVersion: number;
    requestActor?: ChatQueueRequestActor | null;
    actor: ActivityActor;
  }) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        select ${chatGenerations.id}
        from ${chatGenerations}
        where ${chatGenerations.id} = ${input.expectedGenerationId}
          and ${chatGenerations.orgId} = ${input.orgId}
          and ${chatGenerations.conversationId} = ${input.conversationId}
        for update
      `);
      await tx.execute(sql`
        select ${chatQueuedMessages.id}
        from ${chatQueuedMessages}
        where ${chatQueuedMessages.id} = ${input.itemId}
          and ${chatQueuedMessages.orgId} = ${input.orgId}
          and ${chatQueuedMessages.conversationId} = ${input.conversationId}
          and ${chatQueuedMessages.cancelledAt} is null
        for update
      `);
      const item = await tx
        .select()
        .from(chatQueuedMessages)
        .where(and(
          eq(chatQueuedMessages.id, input.itemId),
          eq(chatQueuedMessages.orgId, input.orgId),
          eq(chatQueuedMessages.conversationId, input.conversationId),
          isNull(chatQueuedMessages.cancelledAt),
          inArray(chatQueuedMessages.status, ["queued", "steer_pending", "continuation_pending"]),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!item) throw conflict("Queued feedback is no longer steerable");

      const existingBoundAction = await controlActionById(tx, {
        orgId: input.orgId,
        controlActionId: item.controlActionId,
      });
      if (item.controlActionId && (!existingBoundAction || existingBoundAction.actionKind !== "steer")) {
        throw conflict("Queued feedback has an unresolved Steer action");
      }
      if (existingBoundAction) {
        const existingGeneration = existingBoundAction.expectedGenerationId
          ? await tx
            .select()
            .from(chatGenerations)
            .where(and(
              eq(chatGenerations.id, existingBoundAction.expectedGenerationId),
              eq(chatGenerations.orgId, input.orgId),
              eq(chatGenerations.conversationId, input.conversationId),
            ))
            .limit(1)
            .then((rows) => rows[0] ?? null)
          : null;
        const materialized = await materializeUserMessage(tx, {
          orgId: input.orgId,
          conversationId: input.conversationId,
          item,
          actor: input.actor,
          now: new Date(),
        });
        return {
          action: existingBoundAction,
          item: materialized.item,
          generation: existingGeneration,
          idempotent: true,
        };
      }

      const actionWithRequestedId = await controlActionById(tx, {
        orgId: input.orgId,
        controlActionId: input.controlActionId,
      });
      if (actionWithRequestedId) {
        throw conflict("Control action id is not bound to this queued feedback");
      }

      const generation = await tx
        .select()
        .from(chatGenerations)
        .where(and(
          eq(chatGenerations.id, input.expectedGenerationId),
          eq(chatGenerations.orgId, input.orgId),
          eq(chatGenerations.conversationId, input.conversationId),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      const acceptsNativeSteer = Boolean(
        generation && NATIVE_STEER_GENERATION_STATUSES.includes(
          generation.status as (typeof NATIVE_STEER_GENERATION_STATUSES)[number],
        ),
      );
      if (acceptsNativeSteer && generation && (
        generation.attemptEpoch !== input.expectedAttemptEpoch
        || generation.controlVersion !== input.expectedControlVersion
      )) {
        throw conflict("The targeted chat generation control version changed");
      }

      const now = new Date();
      if (!acceptsNativeSteer) {
        const [action] = await tx
          .insert(chatControlActions)
          .values({
            id: input.controlActionId,
            orgId: input.orgId,
            expectedGenerationId: generation?.id ?? null,
            expectedAttemptEpoch: generation?.attemptEpoch ?? null,
            expectedControlVersion: generation?.controlVersion ?? null,
            actionKind: "steer",
            localDisposition: "continuation_pending",
            providerDisposition: "not_sent",
            providerClientMessageId: input.controlActionId,
            resolvedAt: now,
          })
          .returning();
        if (!action) throw new Error("Failed to persist Steer continuation action");
        const [updatedItem] = await tx
          .update(chatQueuedMessages)
          .set({
            status: "continuation_pending",
            deliveryIntent: "steer",
            deliveryDisposition: "continuation_pending",
            controlActionId: action.id,
            requestActor: item.requestActor ?? input.requestActor ?? null,
            activeGenerationId: generation?.id ?? item.activeGenerationId,
            attemptEpoch: generation?.attemptEpoch ?? item.attemptEpoch,
            providerClientMessageId: action.providerClientMessageId,
            reconciliationReason: generation ? "target_generation_terminal" : "target_generation_missing",
            lastDeliveryReason: null,
            version: sql`${chatQueuedMessages.version} + 1`,
            updatedAt: now,
          })
          .where(and(
            eq(chatQueuedMessages.id, item.id),
            eq(chatQueuedMessages.version, item.version),
            isNull(chatQueuedMessages.cancelledAt),
          ))
          .returning();
        if (!updatedItem) throw conflict("Queued feedback changed while continuation was being scheduled");
        const materialized = await materializeUserMessage(tx, {
          orgId: input.orgId,
          conversationId: input.conversationId,
          item: updatedItem,
          actor: input.actor,
          now,
        });
        return { action, item: materialized.item, generation, idempotent: false };
      }

      if (!generation) throw notFound("Expected a native Steer generation");
      const appliedControlVersion = generation.controlVersion + 1;
      const [action] = await tx
        .insert(chatControlActions)
        .values({
          id: input.controlActionId,
          orgId: input.orgId,
          expectedGenerationId: generation.id,
          expectedAttemptEpoch: generation.attemptEpoch,
          expectedControlVersion: generation.controlVersion,
          appliedControlVersion,
          actionKind: "steer",
          localDisposition: "pending",
          providerDisposition: "not_sent",
          controlOwnerToken: generation.controlOwnerToken,
          providerClientMessageId: input.controlActionId,
        })
        .returning();
      if (!action) throw new Error("Failed to create chat Steer control action");
      const [updatedGeneration] = await tx
        .update(chatGenerations)
        .set({ controlVersion: appliedControlVersion, updatedAt: now })
        .where(and(
          eq(chatGenerations.id, generation.id),
          eq(chatGenerations.controlVersion, generation.controlVersion),
          eq(chatGenerations.attemptEpoch, generation.attemptEpoch),
        ))
        .returning();
      if (!updatedGeneration) throw conflict("The targeted chat generation control version changed");
      const [updatedItem] = await tx
        .update(chatQueuedMessages)
        .set({
          status: "steer_pending",
          deliveryIntent: "steer",
          deliveryDisposition: "pending",
          controlActionId: action.id,
          requestActor: item.requestActor ?? input.requestActor ?? null,
          activeGenerationId: generation.id,
          attemptEpoch: generation.attemptEpoch,
          providerClientMessageId: action.providerClientMessageId,
          deliveryAttempts: sql`${chatQueuedMessages.deliveryAttempts} + 1`,
          lastAttemptAt: now,
          lastDeliveryReason: null,
          version: sql`${chatQueuedMessages.version} + 1`,
          updatedAt: now,
        })
        .where(and(
          eq(chatQueuedMessages.id, item.id),
          eq(chatQueuedMessages.version, item.version),
          isNull(chatQueuedMessages.cancelledAt),
        ))
        .returning();
      if (!updatedItem) throw conflict("Queued feedback changed while Steer was being accepted");
      const materialized = await materializeUserMessage(tx, {
        orgId: input.orgId,
        conversationId: input.conversationId,
        item: updatedItem,
        actor: input.actor,
        now,
      });
      return {
        action,
        item: materialized.item,
        generation: updatedGeneration,
        idempotent: false,
      };
    });
  }

  return { beginControlAction, scheduleContinuation };
}
