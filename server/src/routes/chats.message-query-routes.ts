import type { Router } from "express";
import { hasActiveChatGeneration } from "../services/chat-generation-locks.js";
import { paginateChatMessages } from "./chats.helpers.js";

type ChatMessageQueryRouteContext = {
  router: Router;
  svc: any;
  assertConversationAccess: (...args: any[]) => Promise<any>;
};

export function registerChatMessageQueryRoutes(ctx: ChatMessageQueryRouteContext) {
  const { router, svc, assertConversationAccess } = ctx;

  router.get("/chats/:id/messages", async (req, res) => {
    const requestedOrgId = typeof req.query.orgId === "string"
      ? req.query.orgId.trim()
      : undefined;
    if (req.query.orgId !== undefined && requestedOrgId === undefined) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    const conversation = await assertConversationAccess(
      req,
      req.params.id as string,
      requestedOrgId,
    );
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    if (conversation.mutability !== "external_bound_chat" && !hasActiveChatGeneration(conversation.id)) {
      await svc.markInterruptedStreamingMessages(conversation.id);
    }
    const includeTranscript = req.query.includeTranscript === "true";
    const messages = await svc.listMessages(conversation.id, { includeTranscript });
    if (req.query.envelope === "true") {
      res.json(paginateChatMessages(messages, req.query));
      return;
    }
    res.json(messages);
  });

  router.get("/chats/:id/messages/:messageId/transcript", async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    const transcript = await svc.getMessageTranscript(conversation.id, req.params.messageId as string);
    if (!transcript) {
      res.status(404).json({ error: "Chat message not found" });
      return;
    }
    res.json(transcript);
  });
}
