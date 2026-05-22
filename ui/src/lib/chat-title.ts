import { formatMessengerTitle } from "@rudderhq/shared";

const DEFAULT_CHAT_TITLE = "New chat";
const CHAT_TITLE_MAX_LENGTH = 80;

export function isDefaultChatTitle(title: string | null | undefined) {
  return title?.trim() === DEFAULT_CHAT_TITLE;
}

export function promoteDefaultChatTitle(title: string, body: string) {
  if (!isDefaultChatTitle(title)) return title;
  return formatMessengerTitle(body, { max: CHAT_TITLE_MAX_LENGTH }) ?? title;
}

export function displayChatTitle(conversation: {
  title: string;
  summary?: string | null;
  latestReplyPreview?: string | null;
}) {
  if (isDefaultChatTitle(conversation.title)) {
    const fallback =
      formatMessengerTitle(conversation.summary, { max: CHAT_TITLE_MAX_LENGTH }) ??
      formatMessengerTitle(conversation.latestReplyPreview, { max: CHAT_TITLE_MAX_LENGTH });
    if (fallback) return fallback;
  }

  return formatMessengerTitle(conversation.title, { max: CHAT_TITLE_MAX_LENGTH }) ?? conversation.title;
}
