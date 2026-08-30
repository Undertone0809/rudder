import type { Db } from "@rudderhq/db";
import {
  activityLog,
  assets,
  chatAttachments,
  chatConversations,
  chatMessages,
  chatQueuedMessages,
} from "@rudderhq/db";
import {
  chatInlineAnnotationsFromStructuredPayload,
  sanitizeChatStructuredPayload,
  type ChatQueuedMessage,
  type ChatQueuedMessagePayload,
  type ChatQueuedMessageStatus,
} from "@rudderhq/shared";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { conflict, unprocessable } from "../errors.js";
import { validateCanonicalChatInlineAnnotations } from "./chat-inline-annotation-validation.js";
import { replaceDetachedChatTranscript } from "./chat-transcript-persistence.js";
import { chatTranscriptFromPayload, stripChatMetadataFromPayload } from "./chats.helpers.js";

type QueueRow = typeof chatQueuedMessages.$inferSelect;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const QUEUED_ANNOTATION_ASSETS_KEY = "__rudderQueueAnnotationAssets";

export type StagedQueuedAnnotationAttachment = {
  provider: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
};

type QueuedAnnotationAssetState = {
  version: 1;
  fingerprint: string;
  attachments: Array<{
    assetId: string;
    annotationId: string;
    fileIndex: number;
  }>;
};

export type QueueMessageActivityActor = {
  actorType: "agent" | "user" | "system";
  actorId: string;
  agentId?: string | null;
};

export function normalizeQueuedMessagePayload(
  payload: Record<string, unknown>,
): ChatQueuedMessagePayload & Record<string, unknown> {
  return {
    body: String(payload.body ?? ""),
    attachmentIds: [],
    inlineAnnotations: chatInlineAnnotationsFromStructuredPayload(payload),
    projectId: typeof payload.projectId === "string" ? payload.projectId : null,
    skillRefs: Array.isArray(payload.skillRefs)
      ? payload.skillRefs.filter((ref): ref is string => typeof ref === "string")
      : [],
    accessMode: typeof payload.accessMode === "string" ? payload.accessMode : null,
    agentId: typeof payload.agentId === "string" ? payload.agentId : null,
    model: typeof payload.model === "string" ? payload.model : null,
    effort: typeof payload.effort === "string" ? payload.effort : null,
    metadata:
      payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
        ? payload.metadata as Record<string, unknown>
        : null,
  } as ChatQueuedMessagePayload & Record<string, unknown>;
}

export function hydrateQueuedMessage(row: QueueRow): ChatQueuedMessage {
  const payload = normalizeQueuedMessagePayload(row.payload);
  return {
    ...row,
    payload,
    annotationCount: payload.inlineAnnotations?.length ?? 0,
  };
}

export function queuedAnnotationAssetState(
  payload: Record<string, unknown>,
): QueuedAnnotationAssetState | null {
  const raw = payload[QUEUED_ANNOTATION_ASSETS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || typeof value.fingerprint !== "string" || !Array.isArray(value.attachments)) {
    return null;
  }
  const attachments: QueuedAnnotationAssetState["attachments"] = [];
  for (const entry of value.attachments) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const ref = entry as Record<string, unknown>;
    if (
      typeof ref.assetId !== "string"
      || typeof ref.annotationId !== "string"
      || typeof ref.fileIndex !== "number"
      || !Number.isInteger(ref.fileIndex)
      || ref.fileIndex < 0
    ) {
      return null;
    }
    attachments.push({
      assetId: ref.assetId,
      annotationId: ref.annotationId,
      fileIndex: ref.fileIndex,
    });
  }
  return { version: 1, fingerprint: value.fingerprint, attachments };
}

function fileAnnotationBindings(
  stagedAttachments: readonly StagedQueuedAnnotationAttachment[],
  attachmentFileIndexesByAnnotationId: ReadonlyMap<string, readonly number[]>,
) {
  const annotationIdByFileIndex = new Map<number, string>();
  for (const [annotationId, indexes] of attachmentFileIndexesByAnnotationId) {
    for (const fileIndex of indexes) {
      if (
        fileIndex < 0
        || fileIndex >= stagedAttachments.length
        || annotationIdByFileIndex.has(fileIndex)
      ) {
        throw unprocessable("Each queued annotation file must have one valid annotation owner");
      }
      annotationIdByFileIndex.set(fileIndex, annotationId);
    }
  }
  if (annotationIdByFileIndex.size !== stagedAttachments.length) {
    throw unprocessable("Every queued file must belong to exactly one annotation");
  }
  return annotationIdByFileIndex;
}

export function queuedMessageMutationFingerprint(input: {
  payload: Record<string, unknown>;
  stagedAttachments: readonly StagedQueuedAnnotationAttachment[];
  attachmentFileIndexesByAnnotationId: ReadonlyMap<string, readonly number[]>;
  runtimeSnapshotVersion?: number | null;
}) {
  const annotationIdByFileIndex = fileAnnotationBindings(
    input.stagedAttachments,
    input.attachmentFileIndexesByAnnotationId,
  );
  const files = input.stagedAttachments.map((attachment, fileIndex) => ({
    annotationId: annotationIdByFileIndex.get(fileIndex),
    fileIndex,
    provider: attachment.provider,
    contentType: attachment.contentType,
    byteSize: attachment.byteSize,
    sha256: attachment.sha256,
    originalFilename: attachment.originalFilename,
  }));
  const normalizedPayload = normalizeQueuedMessagePayload(input.payload);
  // Version 1 marks Agent/model/effort as server-owned admission snapshots. Legacy
  // queue rows have no marker, so their historical client-controlled fields
  // remain part of the idempotency fingerprint for exact upgrade compatibility.
  const clientPayload = input.runtimeSnapshotVersion === 1
    ? (() => {
        const {
          agentId: _agentIdSnapshot,
          model: _modelSnapshot,
          effort: _effortSnapshot,
          ...rest
        } = normalizedPayload;
        return rest;
      })()
    : normalizedPayload;
  return createHash("sha256")
    .update(JSON.stringify({
      payload: clientPayload,
      files,
    }))
    .digest("hex");
}

export function withQueuedAnnotationAssetState(input: {
  payload: Record<string, unknown>;
  fingerprint: string;
  assetIds: readonly string[];
  stagedAttachments: readonly StagedQueuedAnnotationAttachment[];
  attachmentFileIndexesByAnnotationId: ReadonlyMap<string, readonly number[]>;
}) {
  const annotationIdByFileIndex = fileAnnotationBindings(
    input.stagedAttachments,
    input.attachmentFileIndexesByAnnotationId,
  );
  return {
    ...input.payload,
    [QUEUED_ANNOTATION_ASSETS_KEY]: {
      version: 1,
      fingerprint: input.fingerprint,
      attachments: input.assetIds.map((assetId, fileIndex) => ({
        assetId,
        annotationId: annotationIdByFileIndex.get(fileIndex)!,
        fileIndex,
      })),
    } satisfies QueuedAnnotationAssetState,
  };
}

function requestActorFallback(item: QueueRow): QueueMessageActivityActor {
  const actor = item.requestActor;
  if (actor?.type === "agent" && actor.agentId) {
    return { actorType: "agent", actorId: actor.agentId, agentId: actor.agentId };
  }
  return {
    actorType: actor?.type === "board" ? "user" : "system",
    actorId: actor?.type === "board" ? (actor.userId ?? "local-board") : "chat-queue",
  };
}

export async function materializeQueuedUserMessage(
  tx: Transaction,
  input: {
    orgId: string;
    conversationId: string;
    item: QueueRow;
    now: Date;
    actor?: QueueMessageActivityActor;
    structuredPayload?: Record<string, unknown> | null;
    expectedStatuses: readonly ChatQueuedMessageStatus[];
  },
) {
  const linkedMessageId = input.item.deliveredMessageId
    ?? input.item.continuationMessageId
    ?? input.item.sourceMessageId;
  if (linkedMessageId) {
    const linkedMessage = await tx
      .select()
      .from(chatMessages)
      .where(and(
        eq(chatMessages.id, linkedMessageId),
        eq(chatMessages.orgId, input.orgId),
        eq(chatMessages.conversationId, input.conversationId),
        eq(chatMessages.role, "user"),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (linkedMessage) {
      const linksConverged = input.item.sourceMessageId === linkedMessage.id
        && input.item.continuationMessageId === linkedMessage.id
        && input.item.deliveredMessageId === linkedMessage.id;
      if (linksConverged) {
        return { item: input.item, message: linkedMessage, created: false };
      }
      const [linkedItem] = await tx
        .update(chatQueuedMessages)
        .set({
          sourceMessageId: linkedMessage.id,
          continuationMessageId: linkedMessage.id,
          deliveredMessageId: linkedMessage.id,
          version: sql`${chatQueuedMessages.version} + 1`,
          updatedAt: input.now,
        })
        .where(and(
          eq(chatQueuedMessages.id, input.item.id),
          eq(chatQueuedMessages.orgId, input.orgId),
          eq(chatQueuedMessages.conversationId, input.conversationId),
          eq(chatQueuedMessages.version, input.item.version),
          inArray(chatQueuedMessages.status, [...input.expectedStatuses]),
          isNull(chatQueuedMessages.cancelledAt),
        ))
        .returning();
      if (!linkedItem) throw conflict("Queued message changed while its message links were repaired");
      return { item: linkedItem, message: linkedMessage, created: false };
    }
  }

  const payload = normalizeQueuedMessagePayload(input.item.payload);
  const annotations = payload.inlineAnnotations ?? [];
  const body = payload.body.trim();
  if (!body && annotations.length === 0) {
    throw unprocessable("Queued message has no user-visible body or annotation");
  }
  const privateState = queuedAnnotationAssetState(input.item.payload);
  const assetRefs = [...(privateState?.attachments ?? [])]
    .sort((left, right) => left.fileIndex - right.fileIndex);
  if (assetRefs.some((ref, index) => ref.fileIndex !== index)) {
    throw unprocessable("Queued annotation file references are incomplete");
  }
  const stagedAssets = assetRefs.length > 0
    ? await tx
      .select()
      .from(assets)
      .where(and(
        eq(assets.orgId, input.orgId),
        inArray(assets.id, assetRefs.map((ref) => ref.assetId)),
      ))
      .for("share")
    : [];
  const stagedAssetById = new Map(stagedAssets.map((asset) => [asset.id, asset]));
  if (
    stagedAssets.length !== assetRefs.length
    || assetRefs.some((ref) => !stagedAssetById.has(ref.assetId))
  ) {
    throw unprocessable("Queued annotation file asset is missing or outside the organization");
  }
  const attachmentFileIndexesByAnnotationId = new Map<string, number[]>();
  for (const ref of assetRefs) {
    const indexes = attachmentFileIndexesByAnnotationId.get(ref.annotationId);
    if (indexes) indexes.push(ref.fileIndex);
    else attachmentFileIndexesByAnnotationId.set(ref.annotationId, [ref.fileIndex]);
  }
  await validateCanonicalChatInlineAnnotations(tx, {
    orgId: input.orgId,
    conversationId: input.conversationId,
    annotations,
    uploadedFileCount: assetRefs.length,
    attachmentFileIndexesByAnnotationId,
  });

  let structuredPayload = sanitizeChatStructuredPayload({
    ...(input.structuredPayload ?? {}),
    ...(annotations.length > 0 ? { inlineAnnotations: annotations } : {}),
  });
  const transcript = chatTranscriptFromPayload(structuredPayload);
  const [message] = await tx
    .insert(chatMessages)
    .values({
      id: randomUUID(),
      orgId: input.orgId,
      conversationId: input.conversationId,
      role: "user",
      kind: "message",
      status: "completed",
      body,
      structuredPayload: stripChatMetadataFromPayload(structuredPayload),
      clientMutationId: input.item.clientMutationId,
      clientMutationFingerprint: privateState?.fingerprint ?? null,
      chatTurnId: randomUUID(),
      turnVariant: 0,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  if (!message) throw new Error("Failed to persist queued user message");

  const attachmentIdsByAnnotationId = new Map<string, string[]>();
  for (const ref of assetRefs) {
    const attachmentId = randomUUID();
    await tx.insert(chatAttachments).values({
      id: attachmentId,
      orgId: input.orgId,
      conversationId: input.conversationId,
      messageId: message.id,
      assetId: ref.assetId,
      createdAt: input.now,
      updatedAt: input.now,
    });
    const ids = attachmentIdsByAnnotationId.get(ref.annotationId);
    if (ids) ids.push(attachmentId);
    else attachmentIdsByAnnotationId.set(ref.annotationId, [attachmentId]);
  }
  const canonicalAnnotations = annotations.map((annotation) => ({
    ...annotation,
    attachmentIds: [
      ...annotation.attachmentIds,
      ...(attachmentIdsByAnnotationId.get(annotation.id) ?? []),
    ],
  }));
  structuredPayload = sanitizeChatStructuredPayload({
    ...(input.structuredPayload ?? {}),
    ...(canonicalAnnotations.length > 0 ? { inlineAnnotations: canonicalAnnotations } : {}),
  });
  await tx
    .update(chatMessages)
    .set({ structuredPayload: stripChatMetadataFromPayload(structuredPayload), updatedAt: input.now })
    .where(and(
      eq(chatMessages.id, message.id),
      eq(chatMessages.orgId, input.orgId),
      eq(chatMessages.conversationId, input.conversationId),
    ));
  if (transcript.length > 0) {
    await replaceDetachedChatTranscript(tx, {
      orgId: input.orgId,
      messageId: message.id,
      entries: transcript,
    });
  }
  const materializedPayload = {
    ...payload,
    inlineAnnotations: canonicalAnnotations,
  };
  const [linkedItem] = await tx
    .update(chatQueuedMessages)
    .set({
      payload: materializedPayload,
      sourceMessageId: message.id,
      continuationMessageId: message.id,
      deliveredMessageId: message.id,
      version: sql`${chatQueuedMessages.version} + 1`,
      updatedAt: input.now,
    })
    .where(and(
      eq(chatQueuedMessages.id, input.item.id),
      eq(chatQueuedMessages.orgId, input.orgId),
      eq(chatQueuedMessages.conversationId, input.conversationId),
      eq(chatQueuedMessages.version, input.item.version),
      inArray(chatQueuedMessages.status, [...input.expectedStatuses]),
      isNull(chatQueuedMessages.cancelledAt),
    ))
    .returning();
  if (!linkedItem) throw conflict("Queued message changed while its user message was materialized");

  await tx
    .update(chatConversations)
    .set({ lastMessageAt: input.now, updatedAt: input.now })
    .where(and(
      eq(chatConversations.id, input.conversationId),
      eq(chatConversations.orgId, input.orgId),
    ));
  const actor = input.actor ?? requestActorFallback(input.item);
  await tx
    .insert(activityLog)
    .values({
      orgId: input.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      action: "chat.message_added",
      entityType: "chat",
      entityId: input.conversationId,
      details: {
        messageId: message.id,
        role: "user",
        kind: "message",
        source: input.structuredPayload?.source === "steer" ? "steer" : "queue",
        queueItemId: input.item.id,
        annotationCount: annotations.length,
        annotationSourceMessageIds: [
          ...new Set(annotations.map((annotation) => annotation.sourceMessageId)),
        ],
      },
      idempotencyKey: `chat-queue-message:${message.id}`,
    })
    .onConflictDoNothing();
  for (const [annotationId, attachmentIds] of attachmentIdsByAnnotationId) {
    for (const attachmentId of attachmentIds) {
      await tx
        .insert(activityLog)
        .values({
          orgId: input.orgId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId ?? null,
          action: "chat.attachment_added",
          entityType: "chat",
          entityId: input.conversationId,
          details: {
            messageId: message.id,
            attachmentId,
            annotationId,
          },
          idempotencyKey: `chat-queue-attachment:${attachmentId}`,
        })
        .onConflictDoNothing();
    }
  }

  return {
    item: linkedItem,
    message: { ...message, structuredPayload },
    created: true,
  };
}
