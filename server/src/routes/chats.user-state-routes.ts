import {
  updateChatConversationUserStateSchema,
  type ChatConversation,
} from "@rudderhq/shared";
import { validate } from "../middleware/validate.js";
import type { ChatStreamRouteContext } from "./chats.stream-support.js";

export function registerChatUserStateRoutes(ctx: ChatStreamRouteContext) {
  const {
    router,
    svc,
    assistantSvc,
    assertConversationAccess,
    boardUserId,
  } = ctx;

  router.post("/chats/:id/read", async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    const userId = boardUserId(req);
    const state = await svc.markRead(conversation.id, conversation.orgId, userId);
    res.status(201).json({
      conversationId: conversation.id,
      lastReadAt: state.lastReadAt,
    });
  });

  router.post(
    "/chats/:id/user-state",
    validate(updateChatConversationUserStateSchema),
    async (req, res) => {
      const conversation = await assertConversationAccess(req, req.params.id as string);
      if (!conversation) {
        res.status(404).json({ error: "Chat conversation not found" });
        return;
      }
      const userId = boardUserId(req);
      if (typeof req.body.pinned === "boolean") {
        await svc.setPinned(conversation.id, conversation.orgId, userId, req.body.pinned);
      }
      if (typeof req.body.unread === "boolean") {
        if (req.body.unread) {
          await svc.markUnread(conversation.id, conversation.orgId, userId);
        } else {
          await svc.markRead(conversation.id, conversation.orgId, userId);
        }
      }
      const refreshed = await svc.getById(conversation.id, userId);
      res.json(await assistantSvc.enrichConversation(refreshed as ChatConversation));
    },
  );
}
