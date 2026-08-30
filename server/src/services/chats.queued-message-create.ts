import {
  assets,
  chatQueuedMessages,
  type Db,
} from "@rudderhq/db";
import type {
  ChatQueuedMessagePayload,
  ChatQueueRequestActor,
} from "@rudderhq/shared";
import { and, eq, sql } from "drizzle-orm";
import { conflict, unprocessable } from "../errors.js";
import { validateCanonicalChatInlineAnnotations } from "./chat-inline-annotation-validation.js";
import {
  hydrateQueuedMessage,
  normalizeQueuedMessagePayload,
  queuedAnnotationAssetState,
  queuedMessageMutationFingerprint,
  withQueuedAnnotationAssetState,
  type StagedQueuedAnnotationAttachment,
} from "./chat-queued-message-materialization.js";
import { isPostgresError } from "./postgres-errors.js";

export async function createQueuedMessageWithStagedAttachments(
  db: Db,
  input: {
    orgId: string;
    conversationId: string;
    clientMutationId: string;
    payload: ChatQueuedMessagePayload;
    idempotencyPayload?: ChatQueuedMessagePayload;
    mutationFingerprint?: string;
    runtimeSnapshotVersion?: 1 | null;
    expectedGenerationId?: string | null;
    requestActor?: ChatQueueRequestActor | null;
    stagedAttachments: readonly StagedQueuedAnnotationAttachment[];
    attachmentFileIndexesByAnnotationId: ReadonlyMap<string, readonly number[]>;
  },
) {
  if ((input.payload.attachmentIds?.length ?? 0) > 0) {
    throw unprocessable("Queued messages cannot reference client-provided attachment ids");
  }
  const payload = normalizeQueuedMessagePayload(input.payload as unknown as Record<string, unknown>);
  if (!payload.body.trim() && (payload.inlineAnnotations?.length ?? 0) === 0) {
    throw unprocessable("Queued message body or at least one inline annotation is required");
  }
  const fingerprint = input.mutationFingerprint ?? queuedMessageMutationFingerprint({
    payload,
    stagedAttachments: input.stagedAttachments,
    attachmentFileIndexesByAnnotationId: input.attachmentFileIndexesByAnnotationId,
    runtimeSnapshotVersion: input.runtimeSnapshotVersion,
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(chatQueuedMessages)
          .where(
            and(
              eq(chatQueuedMessages.orgId, input.orgId),
              eq(chatQueuedMessages.conversationId, input.conversationId),
              eq(chatQueuedMessages.clientMutationId, input.clientMutationId),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (existing) {
          const existingPrivateState = queuedAnnotationAssetState(existing.payload);
          const replayPayload = existing.runtimeSnapshotVersion === 1
            ? payload
            : normalizeQueuedMessagePayload(
                (input.idempotencyPayload ?? input.payload) as unknown as Record<string, unknown>,
              );
          const existingFingerprint = existingPrivateState?.fingerprint
            ?? queuedMessageMutationFingerprint({
              payload: normalizeQueuedMessagePayload(existing.payload),
              stagedAttachments: [],
              attachmentFileIndexesByAnnotationId: new Map(),
              runtimeSnapshotVersion: existing.runtimeSnapshotVersion,
            });
          const replayFingerprint = input.mutationFingerprint ?? queuedMessageMutationFingerprint({
            payload: replayPayload,
            stagedAttachments: input.stagedAttachments,
            attachmentFileIndexesByAnnotationId: input.attachmentFileIndexesByAnnotationId,
            runtimeSnapshotVersion: existing.runtimeSnapshotVersion,
          });
          if (existingFingerprint !== replayFingerprint) {
            throw conflict("Queued message idempotency key reused with a different payload");
          }
          return {
            item: hydrateQueuedMessage(existing),
            accepted: false,
            cleanupAttachments: [...input.stagedAttachments],
          };
        }

        await validateCanonicalChatInlineAnnotations(tx, {
          orgId: input.orgId,
          conversationId: input.conversationId,
          annotations: payload.inlineAnnotations ?? [],
          uploadedFileCount: input.stagedAttachments.length,
          attachmentFileIndexesByAnnotationId: input.attachmentFileIndexesByAnnotationId,
        });
        const assetIds: string[] = [];
        for (const attachment of input.stagedAttachments) {
          const [asset] = await tx
            .insert(assets)
            .values({
              orgId: input.orgId,
              provider: attachment.provider,
              objectKey: attachment.objectKey,
              contentType: attachment.contentType,
              byteSize: attachment.byteSize,
              sha256: attachment.sha256,
              originalFilename: attachment.originalFilename,
              createdByAgentId: attachment.createdByAgentId,
              createdByUserId: attachment.createdByUserId,
            })
            .returning({ id: assets.id });
          if (!asset) throw new Error("Failed to stage queued annotation asset");
          assetIds.push(asset.id);
        }
        const persistedPayload = withQueuedAnnotationAssetState({
          payload,
          fingerprint,
          assetIds,
          stagedAttachments: input.stagedAttachments,
          attachmentFileIndexesByAnnotationId: input.attachmentFileIndexesByAnnotationId,
        });
        const [positionRow] = await tx
          .select({
            nextPosition: sql<number>`coalesce(max(${chatQueuedMessages.position}), 0) + 1`,
          })
          .from(chatQueuedMessages)
          .where(and(
            eq(chatQueuedMessages.orgId, input.orgId),
            eq(chatQueuedMessages.conversationId, input.conversationId),
          ));
        const [row] = await tx
          .insert(chatQueuedMessages)
          .values({
            orgId: input.orgId,
            conversationId: input.conversationId,
            clientMutationId: input.clientMutationId,
            position: Number(positionRow?.nextPosition ?? 1),
            payload: persistedPayload,
            runtimeSnapshotVersion: input.runtimeSnapshotVersion ?? null,
            requestActor: input.requestActor ?? null,
            expectedGenerationId: input.expectedGenerationId ?? null,
          })
          .returning();
        if (!row) throw new Error("Failed to create queued chat message");
        return {
          item: hydrateQueuedMessage(row),
          accepted: true,
          cleanupAttachments: [] as StagedQueuedAnnotationAttachment[],
        };
      });
    } catch (error) {
      if (attempt < 2 && isPostgresError(error, "23505")) continue;
      throw error;
    }
  }
  throw new Error("Failed to create queued chat message");
}
