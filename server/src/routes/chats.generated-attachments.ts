import {
  parseCodexInlineVisualDirectives,
  parseRudderInlineVisualPlacements,
  type ChatAttachment,
  type ChatConversation,
  type ChatInlineVisualMapping,
  type ChatMessage,
  type RudderInlineVisualMapping,
} from "@rudderhq/shared";
import { MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { logger } from "../middleware/logger.js";
import {
  ChatAssistantStreamError,
  type ChatAssistantResult,
  type ChatGeneratedAttachment,
} from "../services/chat-assistant.js";
import type { chatService } from "../services/chats.js";
import type { StorageService } from "../storage/types.js";

type GeneratedAttachmentChatService = Pick<
  ReturnType<typeof chatService>,
  "createAttachment" | "removeAttachment" | "updateMessageInternalInlineVisuals"
>;

export async function attachGeneratedChatFiles(input: {
  assistantReply: ChatAssistantResult;
  generatedAttachments: ChatGeneratedAttachment[] | undefined;
  message: ChatMessage;
  conversation: ChatConversation;
  replyingAgentId: string | null;
  storage: StorageService;
  chats: GeneratedAttachmentChatService;
}) {
  const finalDirectives = parseCodexInlineVisualDirectives(input.assistantReply.body).directives;
  const finalPlacements = parseRudderInlineVisualPlacements(input.assistantReply.body).placements;
  const inlineVisuals = (input.assistantReply.inlineVisuals ?? []).filter((visual) =>
    finalDirectives.some((directive) =>
      directive.index === visual.directiveIndex && directive.file === visual.file
    )
  );
  const inlineVisualsV1 = (input.assistantReply.inlineVisualsV1 ?? []).filter((visual) =>
    finalPlacements.some((placement) => placement.slot === visual.slot)
  );
  const generatedFiles = (input.generatedAttachments ?? []).filter((generated) =>
    (generated.source !== "codex_inline_visual" && generated.source !== "rudder_inline_visual")
    || (generated.source === "codex_inline_visual" && inlineVisuals.some((visual) =>
      visual.status === "captured"
      && visual.directiveIndex === generated.directiveIndex
      && visual.file === generated.directiveFile
    ))
    || (generated.source === "rudder_inline_visual" && inlineVisualsV1.some((visual) =>
      visual.status === "captured"
      && visual.slot === generated.slot
      && visual.file === generated.originalFilename
    ))
  );
  if (generatedFiles.length === 0 && inlineVisuals.length === 0 && inlineVisualsV1.length === 0) {
    return input.message;
  }
  const attachments: ChatAttachment[] = [];
  const attachmentByVisualIndex = new Map<number, ChatAttachment>();
  const attachmentByVisualSlot = new Map<number, ChatAttachment>();
  const createdAttachmentRecords: Array<{ attachmentId: string; orgId: string; objectKey: string }> = [];
  try {
    for (const generated of generatedFiles) {
      if (generated.body.length > MAX_ATTACHMENT_BYTES) {
        throw new ChatAssistantStreamError(
          `Generated attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`,
          input.assistantReply.body,
          generatedFiles,
          { partialBodyUserVisible: true },
        );
      }
      const stored = await input.storage.putFile({
        orgId: input.conversation.orgId,
        namespace: `chats/${input.conversation.id}/generated`,
        originalFilename: generated.originalFilename,
        contentType: generated.contentType,
        body: generated.body,
      });
      let attachment;
      try {
        attachment = await input.chats.createAttachment({
          orgId: input.conversation.orgId,
          conversationId: input.conversation.id,
          messageId: input.message.id,
          provider: stored.provider,
          objectKey: stored.objectKey,
          contentType: stored.contentType,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          originalFilename: stored.originalFilename,
          createdByAgentId: input.replyingAgentId,
          createdByUserId: null,
        });
      } catch (error) {
        await input.storage.deleteObject(input.conversation.orgId, stored.objectKey).catch((cleanupError) => {
          logger.warn({ err: cleanupError, objectKey: stored.objectKey }, "failed to clean up generated chat object");
        });
        throw error;
      }
      createdAttachmentRecords.push({
        attachmentId: attachment.id,
        orgId: input.conversation.orgId,
        objectKey: stored.objectKey,
      });
      const typedAttachment = attachment as ChatAttachment;
      const publicAttachment = generated.source === "codex_inline_visual" || generated.source === "rudder_inline_visual"
        ? (({ provider: _provider, objectKey: _objectKey, ...safe }) => safe)(typedAttachment)
        : typedAttachment;
      attachments.push(publicAttachment as ChatAttachment);
      if (generated.source === "codex_inline_visual") {
        attachmentByVisualIndex.set(generated.directiveIndex, publicAttachment as ChatAttachment);
      } else if (generated.source === "rudder_inline_visual") {
        attachmentByVisualSlot.set(generated.slot, publicAttachment as ChatAttachment);
      }
    }
    let structuredPayload = input.message.structuredPayload ?? null;
    let persistedLegacyMappings: ChatInlineVisualMapping[] = [];
    let persistedRudderMappings: RudderInlineVisualMapping[] = [];
    if (inlineVisuals.length > 0) {
      persistedLegacyMappings = inlineVisuals.map((visual) => {
        if (visual.status === "captured") {
          const attachment = attachmentByVisualIndex.get(visual.directiveIndex);
          if (attachment) {
            return {
              directiveIndex: visual.directiveIndex,
              file: visual.file,
              status: "ready" as const,
              attachmentId: attachment.id,
            };
          }
        }
        return {
          directiveIndex: visual.directiveIndex,
          file: visual.file,
          status: "unavailable" as const,
          reason: visual.status === "unavailable" ? visual.reason : "capture_failed",
        };
      });
      structuredPayload = { ...(structuredPayload ?? {}), inlineVisuals: persistedLegacyMappings };
    }
    if (inlineVisualsV1.length > 0) {
      persistedRudderMappings = inlineVisualsV1.map((visual) => {
        if (visual.status === "captured") {
          const attachment = attachmentByVisualSlot.get(visual.slot);
          if (attachment) {
            return {
              version: 1 as const,
              slot: visual.slot,
              file: visual.file,
              status: "ready" as const,
              attachmentId: attachment.id,
              contentType: "text/html" as const,
              byteSize: attachment.byteSize,
              sha256: attachment.sha256,
            };
          }
        }
        return {
          version: 1 as const,
          slot: visual.slot,
          file: visual.file,
          status: "unavailable" as const,
          reason: visual.status === "unavailable" ? visual.reason : "capture_failed",
        };
      });
      structuredPayload = { ...(structuredPayload ?? {}), inlineVisualsV1: persistedRudderMappings };
    }
    if (persistedLegacyMappings.length > 0 || persistedRudderMappings.length > 0) {
      const internallyUpdated = await input.chats.updateMessageInternalInlineVisuals(
        input.conversation.id,
        input.message.id,
        {
          ...(persistedLegacyMappings.length > 0 ? { inlineVisuals: persistedLegacyMappings } : {}),
          ...(persistedRudderMappings.length > 0 ? { inlineVisualsV1: persistedRudderMappings } : {}),
        },
      );
      if (!internallyUpdated) throw new Error("Failed to persist trusted inline visual mapping");
      structuredPayload = internallyUpdated.structuredPayload ?? structuredPayload;
    }
    return {
      ...input.message,
      structuredPayload,
      attachments: [...(input.message.attachments ?? []), ...attachments],
    } as ChatMessage;
  } catch (error) {
    for (const created of createdAttachmentRecords.reverse()) {
      const removed = await input.chats.removeAttachment(created.attachmentId).catch((cleanupError) => {
        logger.warn({ err: cleanupError, attachmentId: created.attachmentId }, "failed to remove generated chat attachment");
        return null;
      });
      if (removed?.assetDeleted) {
        await input.storage.deleteObject(created.orgId, created.objectKey).catch((cleanupError) => {
          logger.warn({ err: cleanupError, objectKey: created.objectKey }, "failed to remove generated chat object");
        });
      }
    }
    throw error;
  }
}
