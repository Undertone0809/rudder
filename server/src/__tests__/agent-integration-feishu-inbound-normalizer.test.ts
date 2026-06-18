import { describe, expect, it } from "vitest";
import { normalizeMockFeishuInboundEvent } from "../services/integrations/feishu/inbound-normalizer.js";

describe("normalizeMockFeishuInboundEvent", () => {
  it("normalizes Feishu event_callback text payloads into dispatcher input", () => {
    const event = normalizeMockFeishuInboundEvent({
      botOpenId: "ou_bot",
      header: {
        event_id: "event-1",
        app_id: "cli_a_app",
      },
      event: {
        sender: {
          sender_id: {
            open_id: "ou_sender",
            union_id: "on_sender",
          },
        },
        message: {
          message_id: "om_1",
          chat_id: "oc_group",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "@Rudder /issue Fix login\nDetails" }),
          mentions: [{ id: { open_id: "ou_bot" }, key: "@Rudder" }],
          parent_id: "om_parent",
        },
      },
    });

    expect(event).toMatchObject({
      provider: "feishu",
      eventId: "event-1",
      appId: "cli_a_app",
      botOpenId: "ou_bot",
      chatId: "oc_group",
      chatType: "group",
      messageId: "om_1",
      senderOpenId: "ou_sender",
      senderUnionId: "on_sender",
      body: "@Rudder /issue Fix login\nDetails",
      commandBody: "@Rudder /issue Fix login\nDetails",
      addressedToBot: true,
      messageType: "text",
      parentMessageId: "om_parent",
    });
  });

  it("lets explicit mock fields override raw Feishu fields for local drills", () => {
    const event = normalizeMockFeishuInboundEvent({
      eventId: "event-explicit",
      appId: "app-explicit",
      messageId: "message-explicit",
      chatId: "chat-explicit",
      chatType: "p2p",
      senderOpenId: "sender-explicit",
      body: "hello",
      commandBody: "/issue Hello",
      messageType: "text",
      addressedToBot: false,
      header: { event_id: "event-raw", app_id: "app-raw" },
      event: {
        message: {
          message_id: "message-raw",
          chat_id: "chat-raw",
          chat_type: "group",
          content: JSON.stringify({ text: "raw" }),
        },
        sender: { sender_id: { open_id: "sender-raw" } },
      },
    });

    expect(event).toMatchObject({
      eventId: "event-explicit",
      appId: "app-explicit",
      messageId: "message-explicit",
      chatId: "chat-explicit",
      chatType: "p2p",
      senderOpenId: "sender-explicit",
      body: "hello",
      commandBody: "/issue Hello",
      addressedToBot: false,
    });
  });
});
