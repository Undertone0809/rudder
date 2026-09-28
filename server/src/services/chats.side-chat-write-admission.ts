import { chatConversations, type Db } from "@rudderhq/db";
import { and, eq } from "drizzle-orm";
import { conflict, notFound } from "../errors.js";

type ChatWriteTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function assertChatWriteAdmitted(
  tx: ChatWriteTx,
  orgId: string,
  conversationId: string,
) {
  const scope = and(
    eq(chatConversations.orgId, orgId),
    eq(chatConversations.id, conversationId),
  );
  const [kind] = await tx.select({ conversationKind: chatConversations.conversationKind })
    .from(chatConversations).where(scope).limit(1);
  if (!kind) throw notFound("Chat conversation not found");
  if (kind.conversationKind !== "side_chat") return false;

  const [conversation] = await tx.select({
    sideChatState: chatConversations.sideChatState,
    sideChatExpiresAt: chatConversations.sideChatExpiresAt,
    messengerVisible: chatConversations.messengerVisible,
  }).from(chatConversations).where(scope).for("update").limit(1);
  if (!conversation) throw notFound("Chat conversation not found");
  if (conversation.sideChatState === "kept" && conversation.messengerVisible) return true;
  if (
    conversation.sideChatState === "active"
    && !conversation.messengerVisible
    && conversation.sideChatExpiresAt
    && conversation.sideChatExpiresAt.getTime() > Date.now()
  ) return true;
  throw conflict("Side Chat is read-only");
}
