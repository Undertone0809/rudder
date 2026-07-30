import { chatMessages } from "@rudderhq/db";
import { and, eq, isNull, ne, or } from "drizzle-orm";

type BranchSourceMessage = Pick<
  typeof chatMessages.$inferSelect,
  "id" | "chatTurnId" | "turnVariant"
>;

export function selectedChatMessageBranchCondition(sourceMessage: BranchSourceMessage) {
  if (!sourceMessage.chatTurnId) {
    return or(
      isNull(chatMessages.supersededAt),
      eq(chatMessages.id, sourceMessage.id),
    )!;
  }

  return or(
    and(
      isNull(chatMessages.supersededAt),
      or(
        isNull(chatMessages.chatTurnId),
        ne(chatMessages.chatTurnId, sourceMessage.chatTurnId),
      ),
    ),
    and(
      eq(chatMessages.chatTurnId, sourceMessage.chatTurnId),
      eq(chatMessages.turnVariant, sourceMessage.turnVariant),
    ),
  )!;
}
