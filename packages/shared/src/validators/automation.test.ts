import { describe, expect, it } from "vitest";
import { createAutomationSchema, updateAutomationSchema } from "./automation.js";

const baseAutomationInput = {
  title: "Daily result chat",
  assigneeAgentId: "11111111-1111-4111-8111-111111111111",
  outputMode: "chat_output" as const,
};

describe("automation validators", () => {
  it("defaults new automations to issue tracking", () => {
    const parsed = createAutomationSchema.safeParse({
      title: "Daily result chat",
      assigneeAgentId: "11111111-1111-4111-8111-111111111111",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.outputMode).toBe("track_issue");
      expect(parsed.data.notifyOnIssueCreated).toBe(false);
    }
  });

  it("accepts notification opt-in for issue-tracking automations", () => {
    const parsed = createAutomationSchema.safeParse({
      title: "Daily inbox sweep",
      assigneeAgentId: "11111111-1111-4111-8111-111111111111",
      outputMode: "track_issue",
      notifyOnIssueCreated: true,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.notifyOnIssueCreated).toBe(true);
    }
  });

  it("accepts instructions as the canonical automation run text", () => {
    const parsed = createAutomationSchema.safeParse({
      title: "Daily inbox sweep",
      instructions: "Review inbox items and create follow-up issues.",
      assigneeAgentId: "11111111-1111-4111-8111-111111111111",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.description).toBe("Review inbox items and create follow-up issues.");
    }
  });

  it("keeps description as a legacy alias for automation run text", () => {
    const parsed = updateAutomationSchema.safeParse({
      description: "Review inbox items and create follow-up issues.",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.description).toBe("Review inbox items and create follow-up issues.");
    }
  });

  it("normalizes notification opt-in off for chat-output automations", () => {
    const parsed = createAutomationSchema.safeParse({
      ...baseAutomationInput,
      notifyOnIssueCreated: true,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.outputMode).toBe("chat_output");
      expect(parsed.data.notifyOnIssueCreated).toBe(false);
    }
  });

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
