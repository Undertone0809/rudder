import { describe, expect, it, vi } from "vitest";
import { publishAutomationRunOutputToChat } from "./automation-chat-output.js";
import { CHAT_TRANSCRIPT_KEY } from "./chats.helpers.js";

describe("publishAutomationRunOutputToChat", () => {
  it("does not mirror native transcript entries into automation chat output", async () => {
    const createdAt = new Date("2026-09-22T00:00:00.000Z");
    const insertedValues: Record<string, unknown>[] = [];
    let selectCount = 0;
    const row = {
      issueId: "issue-1",
      automationId: "automation-1",
      automationTitle: "Native automation",
      automationOutputMode: "chat_output",
      projectId: null,
      assigneeAgentId: "agent-1",
      runId: "run-1",
      orgId: "org-1",
      linkedChatConversationId: "conversation-1",
    };
    const tx = {
      select: vi.fn(() => {
        const rows = selectCount++ === 0 ? [row] : [];
        const chain = {
          from: () => chain,
          innerJoin: () => chain,
          where: () => chain,
          then: (onFulfilled: (value: typeof rows) => unknown, onRejected?: (reason: unknown) => unknown) =>
            Promise.resolve(rows).then(onFulfilled, onRejected),
        };
        return chain;
      }),
      execute: vi.fn().mockResolvedValue(undefined),
      insert: vi.fn(() => ({
        values: vi.fn((values: Record<string, unknown>) => {
          insertedValues.push(values);
          return { returning: vi.fn().mockResolvedValue([{ id: "message-1", createdAt, ...values }]) };
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
      })),
    };
    const db = {
      transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    };

    await publishAutomationRunOutputToChat(db as never, {
      issueId: "issue-1",
      output: "Native answer",
      status: "completed",
      transcriptSource: "native",
      transcript: [{
        kind: "assistant",
        ts: createdAt.toISOString(),
        text: "provider-owned raw transcript",
      }],
    });

    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]?.structuredPayload).not.toHaveProperty(CHAT_TRANSCRIPT_KEY);
    expect(insertedValues[0]?.body).toBe("Native answer");
  });
});
