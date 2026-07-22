import type { HeartbeatRun } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import { buildRunRailEntries, getRunListSummary, runDetailFacts } from "./AgentDetail.runs";

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

  it("shows recoverable chat failure guidance in failed run summaries", () => {
    expect(getRunListSummary(run({
      status: "failed",
      error: "Chat adapter completed without the required Rudder result sentinel",
      errorCode: "chat_result_missing_sentinel",
      resultJson: {
        userMessage: "The assistant finished without a final Rudder reply. Rudder saved the attempt and transcript; retry when ready.",
      },
    }))).toBe("The assistant finished without a final Rudder reply. Rudder saved the attempt and transcript; retry when ready.");
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

  it("marks Feishu-sourced chat runs in the run detail facts", () => {
    expect(runDetailFacts(run({
      invocationSource: "chat",
      triggerDetail: "chat_assistant_reply_stream",
      chatConversationId: "chat-1",
      contextSnapshot: {
        source: "feishu",
        conversationId: "chat-1",
        userMessageId: "user-message-1",
      },
    }))).toContainEqual({ label: "Source", value: "Feishu", badge: true });
  });
});

describe("buildRunRailEntries", () => {
  it("groups three runs from the same conversation into one entry", () => {
    const runs = [
      run({ id: "run-3", chatConversationId: "conversation-1" }),
      run({ id: "run-2", chatConversationId: "conversation-1" }),
      run({ id: "run-1", chatConversationId: "conversation-1" }),
    ];

    expect(buildRunRailEntries(runs, null)).toEqual([
      {
        kind: "conversation",
        conversationId: "conversation-1",
        runs,
        matchingRunCount: 3,
        representativeRun: runs[0],
        isSelected: false,
      },
    ]);
  });

  it("keeps separate conversations in first-member input order", () => {
    const conversationBFirst = run({ id: "run-b-2", chatConversationId: "conversation-b" });
    const conversationAFirst = run({ id: "run-a-2", chatConversationId: "conversation-a" });
    const conversationBSecond = run({ id: "run-b-1", chatConversationId: "conversation-b" });
    const conversationASecond = run({ id: "run-a-1", chatConversationId: "conversation-a" });

    const entries = buildRunRailEntries([
      conversationBFirst,
      conversationAFirst,
      conversationBSecond,
      conversationASecond,
    ], null);

    expect(entries.map((entry) => entry.kind === "conversation" ? entry.conversationId : entry.run.id)).toEqual([
      "conversation-b",
      "conversation-a",
    ]);
    expect(entries[0]?.kind === "conversation" ? entries[0].runs : []).toEqual([
      conversationBFirst,
      conversationBSecond,
    ]);
    expect(entries[1]?.kind === "conversation" ? entries[1].runs : []).toEqual([
      conversationAFirst,
      conversationASecond,
    ]);
  });

  it("uses the first member from the already sorted input as the default representative", () => {
    const oldest = run({
      id: "oldest",
      chatConversationId: "conversation-1",
      createdAt: new Date("2026-05-24T10:00:00.000Z"),
    });
    const newest = run({
      id: "newest",
      chatConversationId: "conversation-1",
      createdAt: new Date("2026-05-24T12:00:00.000Z"),
    });

    const entries = buildRunRailEntries([oldest, newest], null);

    expect(entries[0]).toMatchObject({
      kind: "conversation",
      runs: [oldest, newest],
      matchingRunCount: 2,
      representativeRun: oldest,
      isSelected: false,
    });
  });

  it("keeps unlinked runs as standalone entries in input order", () => {
    const standaloneFirst = run({ id: "standalone-1" });
    const linked = run({ id: "linked-1", chatConversationId: "conversation-1" });
    const standaloneLast = run({ id: "standalone-2" });

    const entries = buildRunRailEntries([standaloneFirst, linked, standaloneLast], null);

    expect(entries.map((entry) => entry.kind)).toEqual(["run", "conversation", "run"]);
    expect(entries[0]).toMatchObject({ kind: "run", run: standaloneFirst, isSelected: false });
    expect(entries[2]).toMatchObject({ kind: "run", run: standaloneLast, isSelected: false });
  });

  it("groups legacy snapshot conversation ids with canonical ids", () => {
    const canonical = run({ id: "canonical", chatConversationId: "conversation-1" });
    const legacy = run({ id: "legacy", contextSnapshot: { conversationId: "conversation-1" } });

    const entries = buildRunRailEntries([canonical, legacy], null);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "conversation",
      conversationId: "conversation-1",
      runs: [canonical, legacy],
    });
  });

  it("uses the selected older member as the active group representative", () => {
    const newest = run({ id: "newest", chatConversationId: "conversation-1" });
    const older = run({ id: "older", chatConversationId: "conversation-1" });

    const entries = buildRunRailEntries([newest, older], older.id);

    expect(entries[0]).toMatchObject({
      kind: "conversation",
      representativeRun: older,
      isSelected: true,
    });
  });

  it("uses a selected outside-filter run as representative without counting it as a match", () => {
    const selectedOutsideFilters = run({ id: "selected", chatConversationId: "conversation-1" });
    const filteredConversationRun = run({ id: "filtered", chatConversationId: "conversation-1" });
    const standalone = run({ id: "standalone" });

    const entries = buildRunRailEntries([
      filteredConversationRun,
      standalone,
    ], selectedOutsideFilters.id, selectedOutsideFilters);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: "conversation",
      runs: [selectedOutsideFilters, filteredConversationRun],
      matchingRunCount: 1,
      representativeRun: selectedOutsideFilters,
      isSelected: true,
    });
    expect(entries[1]).toMatchObject({ kind: "run", run: standalone });
  });

  it("keeps a selected outside-filter standalone run visible and active", () => {
    const selectedOutsideFilters = run({ id: "selected-standalone" });
    const matchingConversationRun = run({ id: "filtered", chatConversationId: "conversation-1" });

    const entries = buildRunRailEntries(
      [matchingConversationRun],
      selectedOutsideFilters.id,
      selectedOutsideFilters,
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: "run",
      run: selectedOutsideFilters,
      isSelected: true,
    });
    expect(entries[1]).toMatchObject({
      kind: "conversation",
      matchingRunCount: 1,
      representativeRun: matchingConversationRun,
      isSelected: false,
    });
  });

  it("ignores an outside-filter argument whose id does not match the selected run", () => {
    const mismatchedOutsideRun = run({ id: "not-the-selection", chatConversationId: "conversation-1" });
    const matchingConversationRun = run({ id: "matching", chatConversationId: "conversation-1" });

    const entries = buildRunRailEntries(
      [matchingConversationRun],
      "actual-selected-run",
      mismatchedOutsideRun,
    );

    expect(entries).toEqual([{
      kind: "conversation",
      conversationId: "conversation-1",
      runs: [matchingConversationRun],
      matchingRunCount: 1,
      representativeRun: matchingConversationRun,
      isSelected: false,
    }]);
  });
});
