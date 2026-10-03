import {
  createChatAttachmentMetadataSchema,
} from "@rudderhq/shared";
import type { Request } from "express";
import multer from "multer";
import { isAllowedContentType, MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import type { ChatStreamRouteContext } from "./chats.stream-support.js";

export function registerChatAttachmentRoute(ctx: ChatStreamRouteContext) {
  const {
    router,
    db,
    storage,
    svc,
    assertConversationAccess,
    assertChatLocalMutationAllowed,
    assertSideChatMutationAllowed,
    runSingleFileUpload,
  } = ctx;

  router.post("/orgs/:orgId/chats/:chatId/attachments", async (req, res) => {
    const orgId = req.params.orgId as string;
    const chatId = req.params.chatId as string;
    assertCompanyAccess(req, orgId);

    const conversation = await assertConversationAccess(req, chatId);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    if (conversation.orgId !== orgId) {
      res.status(422).json({ error: "Chat conversation does not belong to organization" });
      return;
    }
    assertChatLocalMutationAllowed(conversation);
    await assertSideChatMutationAllowed(req, conversation);

    try {
      await runSingleFileUpload(req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }
    const contentType = (file.mimetype || "").toLowerCase();
    if (!isAllowedContentType(contentType)) {
      res.status(422).json({ error: `Unsupported attachment type: ${contentType || "unknown"}` });
      return;
    }
    if (file.buffer.length <= 0) {
      res.status(422).json({ error: "Attachment is empty" });
      return;
    }

    const parsedMeta = createChatAttachmentMetadataSchema.safeParse(req.body ?? {});
    if (!parsedMeta.success) {
      res.status(400).json({ error: "Invalid attachment metadata", details: parsedMeta.error.issues });
      return;
    }

    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      orgId,
      namespace: `chats/${chatId}`,
      originalFilename: file.originalname || null,
      contentType,
      body: file.buffer,
    });

    const attachment = await svc.createAttachment({
      orgId,
      conversationId: chatId,
      messageId: parsedMeta.data.messageId,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.attachment_added",
      entityType: "chat",
      entityId: chatId,
      details: {
        attachmentId: attachment.id,
        messageId: attachment.messageId,
        originalFilename: attachment.originalFilename,
        contentType: attachment.contentType,
      },
    });

    res.status(201).json(attachment);
  });
}
