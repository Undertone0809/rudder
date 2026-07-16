import { describe, expect, it } from "vitest";
import { toAgentRun, toHeartbeatRun, type HeartbeatRun } from "./index.js";

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
    sessionReuseScope: "none",
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
  it("strips internal recovery and terminal-effect fields from public run shapes", () => {
    const internalRun = {
      ...heartbeatRun({
        id: "internal-run",
        contextSnapshot: {
          resumeFromRunId: "source-run-id",
          resumeSessionDisplayId: "public-display-id",
          resumeSessionParams: {
            sessionId: "nested-private-session",
            cwd: "/nested/private/cwd",
            workspaceId: "private-workspace",
            repoUrl: "https://private.example/repo.git",
            repoRef: "private-ref",
          },
          forceFreshSession: true,
          sessionResumeSuppressed: true,
          sessionReuseSuppression: {
            kind: "source_session_cleared",
            sourceRunId: "source-run-id",
          },
        },
      }),
      executionOwnerToken: "owner-secret",
      executionLeaseExpiresAt: new Date(),
      processExitedAt: new Date(),
      terminalEffectsPending: true,
      terminalEffectsJson: { transcript: "large-secret" },
      terminalEffectsClaimToken: "claim-secret",
      terminalEffectsLastError: "internal-error",
      sessionParamsBeforeJson: { sessionId: "private-before" },
      sessionParamsAfterJson: { sessionId: "private-after" },
    } as HeartbeatRun;

    for (const publicRun of [toHeartbeatRun(internalRun), toAgentRun(internalRun)]) {
      expect(publicRun).not.toHaveProperty("executionOwnerToken");
      expect(publicRun).not.toHaveProperty("executionLeaseExpiresAt");
      expect(publicRun).not.toHaveProperty("processExitedAt");
      expect(publicRun).not.toHaveProperty("terminalEffectsPending");
      expect(publicRun).not.toHaveProperty("terminalEffectsJson");
      expect(publicRun).not.toHaveProperty("terminalEffectsClaimToken");
      expect(publicRun).not.toHaveProperty("terminalEffectsLastError");
      expect(publicRun).not.toHaveProperty("sessionParamsBeforeJson");
      expect(publicRun).not.toHaveProperty("sessionParamsAfterJson");
      expect(publicRun.contextSnapshot).toEqual({
        resumeFromRunId: "source-run-id",
        sessionReuseSuppression: {
          kind: "source_session_cleared",
          sourceRunId: "source-run-id",
        },
      });
    }
  });

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

  it("treats issue-comment automation wakes as issue scene runs", () => {
    const run = toAgentRun(heartbeatRun({
      invocationSource: "automation",
      triggerDetail: "system",
      contextSnapshot: {
        issueId: "issue-1",
        commentId: "comment-1",
        wakeReason: "issue_commented",
        wakeSource: "issue.comment",
      },
    }));

    expect(run.scene).toBe("issue");
    expect(run.triggerKind).toBe("system");
    expect(run.targetType).toBe("issue");
    expect(run.targetId).toBe("issue-1");
  });

  it("keeps automation run identity as automation scene even when linked to an issue", () => {
    const run = toAgentRun(heartbeatRun({
      invocationSource: "automation",
      triggerDetail: "system",
      contextSnapshot: {
        automationRunId: "automation-run-1",
        automationId: "automation-1",
        issueId: "issue-1",
      },
    }));

    expect(run.scene).toBe("automation");
    expect(run.targetType).toBe("automation_run");
    expect(run.targetId).toBe("automation-run-1");
    expect(run.automationRunId).toBe("automation-run-1");
  });

  it("lets an explicit issue scene override automation run linkage", () => {
    const run = toAgentRun(heartbeatRun({
      invocationSource: "automation",
      triggerDetail: "system",
      contextSnapshot: {
        scene: "issue",
        automationRunId: "automation-run-1",
        issueId: "issue-1",
      },
    }));

    expect(run.scene).toBe("issue");
    expect(run.targetType).toBe("automation_run");
    expect(run.targetId).toBe("automation-run-1");
  });

  it("honors persisted runtime rudderScene metadata", () => {
    const run = toAgentRun(heartbeatRun({
      invocationSource: "automation",
      triggerDetail: "system",
      contextSnapshot: {
        rudderScene: "issue",
        automationRunId: "automation-run-1",
        issueId: "issue-1",
      },
    }));

    expect(run.scene).toBe("issue");
    expect(run.targetType).toBe("automation_run");
    expect(run.targetId).toBe("automation-run-1");
  });

  it("treats review wakeups as review scene runs even when issue-backed", () => {
    const run = toAgentRun(heartbeatRun({
      invocationSource: "review",
      triggerDetail: "system",
      contextSnapshot: {
        issueId: "issue-1",
        wakeReason: "issue_review_closeout_missing",
      },
    }));

    expect(run.scene).toBe("review");
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
    expect(run.targetType).toBe("wakeup_request");
    expect(run.targetId).toBeNull();
  });

  it("treats on-demand manual invocations without another target as heartbeat scene runs", () => {
    const run = toAgentRun(heartbeatRun({
      invocationSource: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: {
        triggeredBy: "board",
      },
    }));

    expect(run.scene).toBe("heartbeat");
    expect(run.triggerKind).toBe("manual");
    expect(run.targetType).toBe("wakeup_request");
    expect(run.targetId).toBeNull();
  });
});
