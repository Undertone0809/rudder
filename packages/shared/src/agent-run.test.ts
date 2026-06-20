import { describe, expect, it } from "vitest";
import { toAgentRun, type HeartbeatRun } from "./index.js";

function heartbeatRun(overrides: Partial<HeartbeatRun>): HeartbeatRun {
  return {
    id: "run-1",
    orgId: "org-1",
    agentId: "agent-1",
    invocationSource: "on_demand",
    triggerDetail: null,
    status: "running",
    startedAt: null,
    finishedAt: null,
    error: null,
    wakeupRequestId: null,
    exitCode: null,
    signal: null,
    usageJson: null,
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    errorCode: null,
    externalRunId: null,
    chatConversationId: null,
    processPid: null,
    processStartedAt: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    contextSnapshot: null,
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
    ...overrides,
  };
}

describe("toAgentRun", () => {
  it("normalizes chat run scene and target from legacy heartbeat fields", () => {
    const run = toAgentRun(heartbeatRun({
      id: "chat-run",
      invocationSource: "chat",
      triggerDetail: "chat_assistant_reply_stream",
      chatConversationId: "conversation-1",
      contextSnapshot: {
        assistantMessageId: "assistant-message-1",
      },
    }));

    expect(run.scene).toBe("chat");
    expect(run.triggerKind).toBe("chat_assistant_reply_stream");
    expect(run.targetType).toBe("chat_conversation");
    expect(run.targetId).toBe("conversation-1");
    expect(run.conversationId).toBe("conversation-1");
    expect(run.messageId).toBe("assistant-message-1");
  });

  it("honors explicit automation target metadata while preserving linked chat facts", () => {
    const run = toAgentRun(heartbeatRun({
      id: "automation-chat-run",
      invocationSource: "chat",
      triggerDetail: "chat_assistant_reply_stream",
      chatConversationId: "conversation-1",
      contextSnapshot: {
        scene: "chat",
        targetType: "automation_run",
        targetId: "automation-run-1",
        automationRunId: "automation-run-1",
        automationId: "automation-1",
        conversationId: "conversation-1",
        userMessageId: "user-message-1",
        assistantMessageId: "assistant-message-1",
      },
    }));

    expect(run.scene).toBe("chat");
    expect(run.targetType).toBe("automation_run");
    expect(run.targetId).toBe("automation-run-1");
    expect(run.automationRunId).toBe("automation-run-1");
    expect(run.automationId).toBe("automation-1");
    expect(run.conversationId).toBe("conversation-1");
    expect(run.messageId).toBe("assistant-message-1");
  });

  it("falls back to issue target metadata for issue-backed runs", () => {
    const run = toAgentRun(heartbeatRun({
      invocationSource: "assignment",
      triggerDetail: "manual",
      contextSnapshot: {
        issueId: "issue-1",
      },
    }));

    expect(run.scene).toBe("issue");
    expect(run.triggerKind).toBe("manual");
    expect(run.targetType).toBe("issue");
    expect(run.targetId).toBe("issue-1");
  });

  it("normalizes timer invocations to the heartbeat scene", () => {
    const run = toAgentRun(heartbeatRun({
      invocationSource: "timer",
      triggerDetail: "system",
      contextSnapshot: {
        wakeReason: "heartbeat_timer",
      },
    }));

    expect(run.scene).toBe("heartbeat");
    expect(run.triggerKind).toBe("system");
    expect(run.targetType).toBe("manual");
    expect(run.targetId).toBeNull();
  });
});
