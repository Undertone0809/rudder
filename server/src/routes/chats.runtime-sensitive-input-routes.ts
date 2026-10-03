import type { ChatConversation, ChatStreamEvent } from "@rudderhq/shared";
import type { Request, Response, Router } from "express";
import { markHttpRequestBodySensitive } from "../middleware/logger.js";
import {
  ChatRuntimeSensitiveInputBrokerError,
  chatRuntimeSensitiveInputBroker,
  type ChatRuntimeSensitiveInputRequest,
  type ChatRuntimeSensitiveInputRequestHandler,
} from "../services/chat-runtime-sensitive-input.js";
import { getActorInfo } from "./authz.js";

type RuntimeSensitiveInputRouteDependencies = {
  router: Router;
  assertConversationAccess: (
    request: Request,
    conversationId: string,
  ) => Promise<ChatConversation | null | undefined>;
  assertChatLocalMutationAllowed: (conversation: ChatConversation) => void;
  assertSideChatMutationAllowed: (
    request: Request,
    conversation: ChatConversation,
  ) => Promise<void>;
};

export function createChatRuntimeSensitiveInputStreamHandler(input: {
  orgId: string;
  chatId: string;
  principalId: string;
  response: Response;
  writeStreamEvent: (response: Response, event: ChatStreamEvent) => unknown;
}): ChatRuntimeSensitiveInputRequestHandler {
  return (request: ChatRuntimeSensitiveInputRequest) => chatRuntimeSensitiveInputBroker.request({
    binding: {
      ...request.binding,
      orgId: input.orgId,
      chatId: input.chatId,
      principalId: input.principalId,
    },
    kind: request.kind,
    ...(request.signal ? { signal: request.signal } : {}),
    onRequest: ({ requestId, kind }) => {
      input.writeStreamEvent(input.response, { type: "sensitive_input_request", requestId, kind });
    },
  }).result;
}

export function registerChatRuntimeSensitiveInputRoutes({
  router,
  assertConversationAccess,
  assertChatLocalMutationAllowed,
  assertSideChatMutationAllowed,
}: RuntimeSensitiveInputRouteDependencies) {
  router.get("/chats/:id/runtime-sensitive-inputs", async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    const actor = getActorInfo(req);
    if (actor.actorType !== "user") {
      res.status(403).json({ error: "Only an operator can answer runtime input requests" });
      return;
    }
    const requests = chatRuntimeSensitiveInputBroker.pendingForPrincipal({
      orgId: conversation.orgId,
      chatId: conversation.id,
      principalId: `${actor.actorType}:${actor.actorId}`,
    }).map(({ requestId, kind }) => ({ requestId, kind }));
    res.json({ requests });
  });

  router.post("/chats/:id/runtime-sensitive-inputs/:requestId/respond", async (req, res) => {
    markHttpRequestBodySensitive(req);
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    const actor = getActorInfo(req);
    if (actor.actorType !== "user") {
      res.status(403).json({ error: "Only an operator can answer runtime input requests" });
      return;
    }
    assertChatLocalMutationAllowed(conversation);
    await assertSideChatMutationAllowed(req, conversation);
    try {
      const status = chatRuntimeSensitiveInputBroker.respondFromPrincipal({
        requestId: req.params.requestId as string,
        orgId: conversation.orgId,
        chatId: conversation.id,
        principalId: `${actor.actorType}:${actor.actorId}`,
        value: req.body?.value,
      });
      res.status(status === "accepted" ? 202 : 200).json({ status });
    } catch (error) {
      if (!(error instanceof ChatRuntimeSensitiveInputBrokerError)) throw error;
      const httpStatus = error.code === "chat_runtime_sensitive_input_binding_mismatch"
        ? 404
        : error.code === "chat_runtime_sensitive_input_invalid_value"
          ? 422
          : 409;
      res.status(httpStatus).json({ error: error.message, code: error.code });
    }
  });

  router.post("/chats/:id/runtime-sensitive-inputs/:requestId/cancel", async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    const actor = getActorInfo(req);
    if (actor.actorType !== "user") {
      res.status(403).json({ error: "Only an operator can cancel runtime input requests" });
      return;
    }
    assertChatLocalMutationAllowed(conversation);
    await assertSideChatMutationAllowed(req, conversation);
    const cancelled = chatRuntimeSensitiveInputBroker.cancelFromPrincipal({
      requestId: req.params.requestId as string,
      orgId: conversation.orgId,
      chatId: conversation.id,
      principalId: `${actor.actorType}:${actor.actorId}`,
    });
    if (!cancelled) {
      res.status(409).json({ error: "Sensitive input request is no longer pending" });
      return;
    }
    res.json({ cancelled: true });
  });
}
