import { describe, expect, it } from "vitest";
import { createAutomationSchema, updateAutomationSchema } from "./automation.js";

const baseAutomationInput = {
  title: "Daily result chat",
  assigneeAgentId: "11111111-1111-4111-8111-111111111111",
  outputMode: "chat_output" as const,
};

describe("automation validators", () => {
  it("allows chat output without an existing chat destination", () => {
    const parsed = createAutomationSchema.safeParse({
      ...baseAutomationInput,
      chatConversationId: null,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.chatConversationId).toBeNull();
    }
  });

  it("rejects selecting an existing chat destination on create", () => {
    const parsed = createAutomationSchema.safeParse({
      ...baseAutomationInput,
      chatConversationId: "22222222-2222-4222-8222-222222222222",
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ["chatConversationId"],
          message: "Chat output creates an automation-owned conversation; existing chats cannot be selected",
        }),
      ]));
    }
  });

  it("rejects selecting an existing chat destination on update", () => {
    const parsed = updateAutomationSchema.safeParse({
      outputMode: "chat_output",
      chatConversationId: "22222222-2222-4222-8222-222222222222",
    });

    expect(parsed.success).toBe(false);
  });
});
