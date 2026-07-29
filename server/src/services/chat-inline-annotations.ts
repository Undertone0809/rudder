import type { Db } from "@rudderhq/db";
import {
  chatInlineAnnotationsSchema,
  normalizeChatInlineAnnotations,
  type ChatInlineAnnotation,
  type ChatInlineAnnotationInput,
} from "@rudderhq/shared";
import { unprocessable } from "../errors.js";
import {
  asChatInlineAnnotationValidationQuery,
  validateCanonicalChatInlineAnnotations,
} from "./chat-inline-annotation-validation.js";

export { hashChatAnnotationSource } from "./chat-inline-annotation-validation.js";

export type PreparedChatInlineAnnotations = {
  annotations: ChatInlineAnnotation[];
  attachmentFileIndexesByAnnotationId: Map<string, number[]>;
};

export function bindPreparedChatInlineAnnotationFiles(
  prepared: PreparedChatInlineAnnotations,
  reboundAnnotations: readonly ChatInlineAnnotation[],
  uploadedAttachmentIds: readonly string[],
): ChatInlineAnnotation[] {
  const reboundById = new Map(reboundAnnotations.map((annotation) => [annotation.id, annotation]));
  const bound = prepared.annotations.map((preparedAnnotation) => {
    const rebound = reboundById.get(preparedAnnotation.id);
    if (!rebound) {
      throw unprocessable("Prepared annotation identity no longer matches the persisted message");
    }
    const fileIndexes = prepared.attachmentFileIndexesByAnnotationId.get(preparedAnnotation.id) ?? [];
    const fileAttachmentIds = fileIndexes.map((fileIndex) => {
      const attachmentId = uploadedAttachmentIds[fileIndex];
      if (!attachmentId) {
        throw unprocessable("Annotation file index could not be bound to an uploaded attachment");
      }
      return attachmentId;
    });
    return {
      ...rebound,
      attachmentIds: [...rebound.attachmentIds, ...fileAttachmentIds],
    };
  });
  return chatInlineAnnotationsSchema.parse(bound);
}

export function chatInlineAnnotationService(db: Db) {
  async function prepare(input: {
    orgId: string;
    conversationId: string;
    annotations: readonly ChatInlineAnnotationInput[];
    uploadedFileCount: number;
    editUserMessageId?: string | null;
  }): Promise<PreparedChatInlineAnnotations> {
    const annotations = normalizeChatInlineAnnotations(input.annotations);
    const attachmentFileIndexesByAnnotationId = new Map<string, number[]>();
    input.annotations.forEach((annotation) => {
      const indexes = annotation.attachmentFileIndexes ?? [];
      for (const fileIndex of indexes) {
        if (fileIndex < 0 || fileIndex >= input.uploadedFileCount) {
          throw unprocessable("Annotation file index does not match an uploaded file");
        }
      }
      attachmentFileIndexesByAnnotationId.set(annotation.id, [...indexes]);
    });
    await validateCanonicalChatInlineAnnotations(
      asChatInlineAnnotationValidationQuery(db),
      {
        orgId: input.orgId,
        conversationId: input.conversationId,
        editUserMessageId: input.editUserMessageId,
        annotations,
        uploadedFileCount: input.uploadedFileCount,
        attachmentFileIndexesByAnnotationId,
      },
    );
    return { annotations, attachmentFileIndexesByAnnotationId };
  }

  return { prepare };
}
