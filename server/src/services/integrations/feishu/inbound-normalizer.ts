import type { MockFeishuInboundEvent } from "@rudderhq/shared";
import { badRequest } from "../../../errors.js";
import type { FeishuInboundMessage } from "./inbound-dispatcher.js";

function firstNonEmpty(...values: Array<string | null | undefined>) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim() ?? null;
}

function parseTextContent(content: string | null | undefined) {
  if (!content) return "";
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    if (typeof parsed.text === "string") return parsed.text;
  } catch {
    // Plain text is accepted by the mock hook to keep local Feishu drills simple.
  }
  return content;
}

function mentionAddressesBot(input: MockFeishuInboundEvent, botOpenId: string | null) {
  if (typeof input.addressedToBot === "boolean") return input.addressedToBot;
  if (!botOpenId) return false;
  const mentions = input.event?.message?.mentions ?? [];
  return mentions.some((mention) => mention.id?.open_id === botOpenId);
}

export function normalizeMockFeishuInboundEvent(input: MockFeishuInboundEvent): FeishuInboundMessage {
  const message = input.event?.message;
  const senderId = input.event?.sender?.sender_id;
  const body = firstNonEmpty(input.body, parseTextContent(message?.content)) ?? "";
  const appId = firstNonEmpty(input.appId, input.header?.app_id);
  const eventId = firstNonEmpty(input.eventId, input.header?.event_id, input.messageId, message?.message_id);
  const messageId = firstNonEmpty(input.messageId, message?.message_id, eventId);
  const chatId = firstNonEmpty(input.chatId, message?.chat_id);
  const senderOpenId = firstNonEmpty(input.senderOpenId, senderId?.open_id);
  const botOpenId = firstNonEmpty(input.botOpenId, null);

  const missing = [
    ["appId", appId],
    ["eventId", eventId],
    ["messageId", messageId],
    ["chatId", chatId],
    ["senderOpenId", senderOpenId],
  ].filter(([, value]) => !value);
  if (missing.length > 0) {
    throw badRequest("Invalid Feishu inbound event", { missing: missing.map(([key]) => key) });
  }

  const chatType = input.chatType ?? message?.chat_type ?? "p2p";
  const addressedToBot = typeof input.addressedToBot === "boolean"
    ? input.addressedToBot
    : mentionAddressesBot(input, botOpenId) || chatType === "p2p";
  const receivedAt = input.receivedAt ? new Date(input.receivedAt) : undefined;

  return {
    provider: "feishu",
    eventId: eventId!,
    appId: appId!,
    botOpenId,
    chatId: chatId!,
    chatType,
    messageId: messageId!,
    senderOpenId: senderOpenId!,
    senderUnionId: firstNonEmpty(input.senderUnionId, senderId?.union_id),
    body,
    commandBody: input.commandBody ?? body,
    addressedToBot,
    messageType: input.messageType ?? message?.message_type ?? "text",
    parentMessageId: firstNonEmpty(input.parentMessageId, message?.parent_id),
    receivedAt,
  };
}
