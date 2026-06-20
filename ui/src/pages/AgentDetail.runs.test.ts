import type { HeartbeatRun } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import { getRunListSummary, runDetailFacts } from "./AgentDetail.runs";

function run(overrides: Partial<HeartbeatRun>): HeartbeatRun {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    orgId: "org-1",
    agentId: "agent-1",
    invocationSource: "on_demand",
    triggerDetail: "manual",
    status: "succeeded",
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
    processPid: null,
    processStartedAt: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    contextSnapshot: null,
    createdAt: new Date("2026-05-24T12:00:00.000Z"),
    updatedAt: new Date("2026-05-24T12:00:00.000Z"),
    ...overrides,
  };
}

describe("getRunListSummary", () => {
  it("does not expose failed run result JSON summaries", () => {
    expect(getRunListSummary(run({
      status: "failed",
      error: "Adapter failed",
      resultJson: { summary: "Raw adapter failure: token abc123" },
    }))).toBe("The run hit a system-level execution problem. Rudder saved the technical details for diagnostics.");
  });

  it("keeps successful run summaries visible", () => {
    expect(getRunListSummary(run({
      status: "succeeded",
      resultJson: { summary: "Updated the implementation plan" },
    }))).toBe("Updated the implementation plan");
  });

  it("describes cancelled runs as cancelled instead of failed", () => {
    expect(getRunListSummary(run({
      status: "cancelled",
      error: "Cancelled because the linked issue is no longer actionable",
      errorCode: "cancelled",
    }))).toBe("The run was cancelled before it could continue. Rudder kept the cancellation reason for context.");
  });

  it("exposes normalized scene and target facts for the run detail panel", () => {
    expect(runDetailFacts(run({
      invocationSource: "chat",
      triggerDetail: "chat_assistant_reply_stream",
      chatConversationId: "chat-1",
      contextSnapshot: {
        targetType: "automation_run",
        targetId: "automation-run-1",
        automationRunId: "automation-run-1",
        automationId: "automation-1",
        assistantMessageId: "assistant-message-1",
      },
    }))).toEqual([
      { label: "Scene", value: "Chat" },
      { label: "Target", value: "Automation run" },
      { label: "Target ID", value: "automation-run-1" },
      { label: "Automation", value: "automation-1", href: "/automations/automation-1" },
      { label: "Conversation", value: "chat-1", href: "/messenger/chat/chat-1" },
      { label: "Message", value: "assistant-message-1" },
    ]);
  });
});
