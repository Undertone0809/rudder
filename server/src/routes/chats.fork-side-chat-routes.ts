import type { Db } from "@rudderhq/db";
import {
  createSideChatSchema,
  forkChatConversationSchema,
  type ChatContextLink,
  type ChatConversation,
} from "@rudderhq/shared";
import type { Request, Router } from "express";
import { conflict } from "../errors.js";
import { validate } from "../middleware/validate.js";
import type { logActivity } from "../services/activity-log.js";
import type { agentService } from "../services/agents.js";
import type { chatAssistantService } from "../services/chat-assistant.js";
import { hasActiveChatGeneration } from "../services/chat-generation-locks.js";
import type { chatService } from "../services/chats.js";
import { sideChatCloseService } from "../services/side-chat-close.js";
import type { sideChatService } from "../services/side-chats.js";
import type { StorageService } from "../storage/types.js";
import { assertBoard, getActorInfo } from "./authz.js";

type ChatService = ReturnType<typeof chatService>;
type AssertConversationAccess = (
  req: Request,
  conversationId: string,
  expectedOrgId?: string,
) => Promise<Awaited<ReturnType<ChatService["getById"]>>>;

export function registerChatForkSideChatRoutes(input: {
  router: Router;
  db: Db;
  storage: StorageService;
  svc: ChatService;
  assistantSvc: ReturnType<typeof chatAssistantService>;
  agentsSvc: ReturnType<typeof agentService>;
  sideChats: ReturnType<typeof sideChatService>;
  logActivity: typeof logActivity;
  assertConversationAccess: AssertConversationAccess;
  boardUserId: (req: Request) => string;
}) {
  const {
    router,
    db,
    storage,
    svc,
    assistantSvc,
    agentsSvc,
    sideChats,
    logActivity: writeActivity,
    assertConversationAccess,
    boardUserId,
  } = input;
  const closeSideChats = sideChatCloseService(db, storage, sideChats);

  router.post("/chats/:id/fork", validate(forkChatConversationSchema), async (req, res) => {
    assertBoard(req);
    const existing = await assertConversationAccess(req, req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    const sourceMessageId = req.body.sourceMessageId ?? null;
    if (!sourceMessageId && hasActiveChatGeneration(existing.id)) {
      throw conflict("Cannot fork a chat while a reply is in progress");
    }

    const actor = getActorInfo(req);
    const userId = boardUserId(req);
    const forked = await svc.forkConversation({
      sourceConversationId: existing.id,
      orgId: existing.orgId,
      userId,
      sourceMessageId,
      title: req.body.title,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await writeActivity(db, {
      orgId: existing.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.forked",
      entityType: "chat",
      entityId: forked?.id ?? "unknown",
      details: {
        sourceConversationId: existing.id,
        sourceMessageId,
        forkRootConversationId: forked?.forkRootConversationId ?? existing.id,
      },
    });

    res.status(201).json(await assistantSvc.enrichConversation(forked as ChatConversation));
  });

  router.post("/chats/:id/side-chats", validate(createSideChatSchema), async (req, res) => {
    assertBoard(req);
    const existing = await assertConversationAccess(req, req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    const userId = boardUserId(req);
    const preferredAgentId = req.body.preferredAgentId ?? existing.preferredAgentId;
    const createInput = {
      sourceConversationId: existing.id,
      sourceMessageId: req.body.sourceMessageId,
      clientMutationId: req.body.clientMutationId,
      orgId: existing.orgId,
      userId,
      preferredAgentId: preferredAgentId ?? undefined,
    };
    const recoveredSideChat = await sideChats.findExistingForCreate({
      ...createInput,
      // An omitted Agent is resolved only for a new creation. Replaying the
      // same request must survive a later change to the parent's default.
      preferredAgentId: req.body.preferredAgentId,
    });
    if (!recoveredSideChat) {
      if (!preferredAgentId) {
        res.status(422).json({ error: "Side Chat requires an available agent" });
        return;
      }
      const preferredAgent = await agentsSvc.getById(preferredAgentId);
      if (
        !preferredAgent
        || preferredAgent.orgId !== existing.orgId
        || preferredAgent.status === "terminated"
      ) {
        res.status(422).json({ error: "Preferred agent must be available in the same organization" });
        return;
      }
      const availability = await assistantSvc.getDraftChatAssistantAvailability({
        orgId: existing.orgId,
        preferredAgentId,
        modelOverride: null,
        effortOverride: null,
        contextLinks: existing.contextLinks as ChatContextLink[],
        planMode: existing.planMode,
      });
      if (!availability.available) {
        res.status(503).json({ error: availability.error });
        return;
      }
    }
    const sideChat = recoveredSideChat ?? await sideChats.create(createInput);
    const actor = getActorInfo(req);
    await writeActivity(db, {
      orgId: existing.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.side_chat_created",
      entityType: "chat",
      entityId: sideChat.id,
      idempotencyKey: `chat.side_chat_created:${sideChat.id}`,
      details: {
        sourceConversationId: existing.id,
        sourceMessageId: req.body.sourceMessageId,
      },
    });
    res.status(201).json(await assistantSvc.enrichConversation(sideChat));
  });

  router.delete("/chats/:id/side-chat", async (req, res) => {
    assertBoard(req);
    const existing = await assertConversationAccess(req, req.params.id as string);
    if (!existing || existing.conversationKind !== "side_chat") {
      res.status(404).json({ error: "Side Chat not found" });
      return;
    }
    if (existing.sideChatState === "kept" || existing.messengerVisible) {
      throw conflict("A kept Side Chat is a normal Messenger chat");
    }
    const userId = boardUserId(req);
    const intent = await sideChats.requestClose({
      conversationId: req.params.id as string,
      userId,
    });
    const actor = getActorInfo(req);
    await writeActivity(db, {
      orgId: existing.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.side_chat_close_requested",
      entityType: "chat",
      entityId: existing.id,
      idempotencyKey: `chat.side_chat_close_requested:${intent.id}`,
      details: {
        sourceConversationId: existing.forkedFromConversationId,
        sourceMessageId: existing.forkedFromMessageId,
      },
    });
    const outcome = await closeSideChats.processIntent(intent.id);
    if (outcome === "review_required") {
      res.status(409).json({ error: "Side Chat close requires review", closeIntentId: intent.id });
      return;
    }
    res.status(outcome === "closed" ? 200 : 202).json({
      id: existing.id,
      ...(outcome === "pending" ? { status: "closing", closeIntentId: intent.id } : {}),
    });
  });

  router.post("/chats/:id/side-chat/keep", async (req, res) => {
    assertBoard(req);
    const existing = await assertConversationAccess(req, req.params.id as string);
    if (!existing || existing.conversationKind !== "side_chat") {
      res.status(404).json({ error: "Side Chat not found" });
      return;
    }
    const userId = boardUserId(req);
    const sideChat = await sideChats.keepInMessenger({
      conversationId: req.params.id as string,
      userId,
    });
    const actor = getActorInfo(req);
    await writeActivity(db, {
      orgId: sideChat.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.side_chat_kept",
      entityType: "chat",
      entityId: sideChat.id,
      details: {
        sourceConversationId: sideChat.forkedFromConversationId,
        sourceMessageId: sideChat.forkedFromMessageId,
      },
    });
    res.json(await assistantSvc.enrichConversation(sideChat));
  });
}
