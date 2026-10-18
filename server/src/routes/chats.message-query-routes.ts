import type { Router } from "express";
import { hasActiveChatGeneration } from "../services/chat-generation-locks.js";
import { callNativeChatTranscript } from "../services/native-chat-transcript-bridge.js";
import { callNativeChatMessages } from "../services/native-chat-message-reader-bridge.js";
import type { RustFoundationBridge } from "../services/rust-foundation-bridge.js";
import { paginateChatMessages } from "./chats.helpers.js";

type ChatMessageQueryRouteContext = {
  router: Router;
  svc: any;
  assertConversationAccess: (...args: any[]) => Promise<any>;
  rustFoundationBridge?: RustFoundationBridge;
};

export function registerChatMessageQueryRoutes(ctx: ChatMessageQueryRouteContext) {
  const { router, svc, assertConversationAccess, rustFoundationBridge } = ctx;
  const boundedQueryNumber = (value: unknown, fallback: number) => {
    if (typeof value !== "string" || !/^\d+$/.test(value)) return fallback;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : fallback;
  };

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
    // Native Chat reads are strictly read-only from Node's perspective. A
    // Node recovery write here would race Rust's generation authority and
    // mutate chat_messages as a side effect of GET. Legacy external-bound
    // chats retain the old interrupted-stream cleanup.
    if (
      conversation.mutability === "external_bound_chat"
      && conversation.sourceMetadata?.source !== "agent_integration"
      && !hasActiveChatGeneration(conversation.id)
    ) {
      await svc.markInterruptedStreamingMessages(conversation.id);
    }
    const includeTranscript = req.query.includeTranscript === "true";
    // Side Chats still use the legacy projection until their copied
    // annotations, attachments, approvals, and transcript consumers are
    // migrated to the Rust Reader contract. Main Native Chat is Rust-owned.
    if (conversation.mutability === "native_chat" && conversation.conversationKind === "chat") {
      const response = await callNativeChatMessages(
        rustFoundationBridge,
        req.actor,
        conversation.orgId,
        {
          operation: "read_conversation_messages",
          conversationId: conversation.id,
          limit: boundedQueryNumber(req.query.limit, 200),
          cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
          includeTranscript,
        },
      );
      if (response.status === 200) {
        const value = JSON.parse(response.body.toString("utf8")) as { messages?: unknown[]; nextCursor?: string | null };
        if (req.query.envelope === "true") {
          res.json({ items: value.messages ?? [], nextCursor: value.nextCursor ?? null });
        } else {
          // Keep the public Chat API compatible with the legacy reader: the
          // non-envelope form is always a bare ChatMessage array.
          res.json(value.messages ?? []);
        }
        return;
      }
      res.status(response.status).type(response.contentType).send(response.body);
      return;
    }
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
    if (conversation.mutability === "native_chat" && conversation.conversationKind === "chat") {
      const response = await callNativeChatTranscript(
        rustFoundationBridge,
        req.actor,
        conversation.orgId,
        {
          operation: "read_message_transcript",
          conversationId: conversation.id,
          messageId: req.params.messageId as string,
          afterSeq: boundedQueryNumber(req.query.afterSeq, 0),
          limit: boundedQueryNumber(req.query.limit, 100),
        },
      );
      res.status(response.status).type(response.contentType).send(response.body);
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
