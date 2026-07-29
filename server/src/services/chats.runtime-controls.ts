import {
  chatConversations,
  chatQueuedMessages,
  type Db,
} from "@rudderhq/db";
import type { ChatQueuedMessagePayload } from "@rudderhq/shared";
import { and, eq, isNull } from "drizzle-orm";
import { conflict } from "../errors.js";
import {
  normalizeQueuedMessagePayload,
  queuedAnnotationAssetState,
  queuedMessageMutationFingerprint,
} from "./chat-queued-message-materialization.js";

export async function findQueuedMessageReplay(
  db: Db,
  input: {
    conversationId: string;
    clientMutationId: string;
    payload: ChatQueuedMessagePayload;
  },
) {
  const existing = await db
    .select()
    .from(chatQueuedMessages)
    .where(
      and(
        eq(chatQueuedMessages.conversationId, input.conversationId),
        eq(chatQueuedMessages.clientMutationId, input.clientMutationId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!existing) return null;

  const privateState = queuedAnnotationAssetState(existing.payload);
  if ((privateState?.attachments.length ?? 0) > 0) {
    throw conflict("Queued message idempotency key reused without its original attachments");
  }
  const emptyBindings = new Map<string, readonly number[]>();
  const existingFingerprint = queuedMessageMutationFingerprint({
    payload: normalizeQueuedMessagePayload(existing.payload),
    stagedAttachments: [],
    attachmentFileIndexesByAnnotationId: emptyBindings,
    runtimeSnapshotVersion: existing.runtimeSnapshotVersion,
  });
  const replayFingerprint = queuedMessageMutationFingerprint({
    payload: normalizeQueuedMessagePayload(input.payload as unknown as Record<string, unknown>),
    stagedAttachments: [],
    attachmentFileIndexesByAnnotationId: emptyBindings,
    runtimeSnapshotVersion: existing.runtimeSnapshotVersion,
  });
  if (existingFingerprint !== replayFingerprint) {
    throw conflict("Queued message idempotency key reused with a different payload");
  }
  return existing;
}

export async function updateChatAgentRuntimeInvariant(
  db: Db,
  input: {
    id: string;
    patch: Partial<typeof chatConversations.$inferInsert>;
    expectedPreferredAgentId: string | null;
  },
) {
  const hasPreferredAgentPatch = Object.prototype.hasOwnProperty.call(
    input.patch,
    "preferredAgentId",
  );
  const requestedPreferredAgentId = hasPreferredAgentPatch
    ? input.patch.preferredAgentId ?? null
    : input.expectedPreferredAgentId;
  const preferredAgentChanged = requestedPreferredAgentId !== input.expectedPreferredAgentId;
  if (preferredAgentChanged && input.expectedPreferredAgentId !== null) {
    throw conflict("Chat agent is locked after the conversation starts");
  }
  const patch = preferredAgentChanged
    ? { ...input.patch, modelOverride: null, effortOverride: null }
    : input.patch;
  const preferredAgentCondition = input.expectedPreferredAgentId === null
    ? isNull(chatConversations.preferredAgentId)
    : eq(chatConversations.preferredAgentId, input.expectedPreferredAgentId);
  const [updated] = await db
    .update(chatConversations)
    .set({
      ...patch,
      updatedAt: new Date(),
    })
    .where(and(
      eq(chatConversations.id, input.id),
      preferredAgentCondition,
    ))
    .returning({ id: chatConversations.id });
  if (!updated) {
    throw conflict("Chat agent changed while applying the conversation runtime update");
  }
  return updated;
}
