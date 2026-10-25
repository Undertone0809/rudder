import type { HeartbeatRun, HeartbeatRunEvent } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "../agent-runtimes";
import {
  chatTranscriptEntriesToRunTranscriptEntries,
  heartbeatRunEventsToTranscriptEntries,
  heartbeatRunEventText,
  heartbeatRunEventToTranscriptEntry,
  mergeTranscriptEntries,
  operatorVisibleInvocationRunEvents,
  resolveRunChatTranscriptTarget,
} from "./run-detail-events";

function makeEvent(overrides: Partial<HeartbeatRunEvent> = {}): HeartbeatRunEvent {
  return {
    id: 1,
    orgId: "org-1",
    runId: "run-1",
    agentId: "agent-1",
    seq: 1,
    eventType: "lifecycle",
    stream: "system",
    level: "info",
    color: null,
    message: "run started",
    payload: null,
    createdAt: new Date("2026-04-12T10:00:00.000Z"),
    ...overrides,
  };
}

describe("run-detail-events", () => {
  it("resolves the persisted chat transcript from the assistant message provenance", () => {
    const target = resolveRunChatTranscriptTarget({
      chatConversationId: "conversation-1",
      contextSnapshot: {
        conversationId: "legacy-conversation",
        assistantMessageId: "assistant-message-1",
        messageId: "user-message-1",
        userMessageId: "user-message-1",
      },
      } as HeartbeatRun);

    expect(target).toEqual({
      conversationId: "conversation-1",
      messageId: "assistant-message-1",
    });
  });

  it("does not use the prompt message when assistant provenance is missing", () => {
    expect(resolveRunChatTranscriptTarget({
      chatConversationId: "conversation-1",
      contextSnapshot: {
        conversationId: "conversation-1",
        messageId: "user-message-1",
        userMessageId: "user-message-1",
      },
    } as HeartbeatRun)).toBeNull();
  });

  it.each(["codex_local", "hermes_local"])("resolves a finalized %s run without an old-style log", (runtimeType) => {
    expect(resolveRunChatTranscriptTarget({
      id: "run-1",
      contextSnapshot: {
        conversationId: "conversation-1",
        messageId: "user-message-1",
        userMessageId: "user-message-1",
        runtimeBindingId: `${runtimeType}-binding`,
        nativeSegmentId: "native-segment-1",
        assistantMessageId: "stale-context-assistant",
      },
      resultJson: {
        nativeChatFinalization: {
          result: { runId: "run-1", assistantMessageId: "native-assistant-1" },
        },
      },
    } as unknown as HeartbeatRun)).toEqual({
      conversationId: "conversation-1",
      messageId: "native-assistant-1",
    });
  });

  it("rejects a native finalization belonging to a neighboring run", () => {
    expect(resolveRunChatTranscriptTarget({
      id: "run-1",
      chatConversationId: "conversation-1",
      contextSnapshot: { assistantMessageId: "stale-assistant" },
      resultJson: {
        nativeChatFinalization: {
          result: { runId: "another-run", assistantMessageId: "other-assistant" },
        },
      },
    } as unknown as HeartbeatRun)).toBeNull();
  });

  it("uses only a status event bound to the selected run", () => {
    const run = { id: "run-1", chatConversationId: "conversation-1" } as HeartbeatRun;
    const events = [
      makeEvent({ eventType: "status", seq: 2, payload: { runId: "run-1", assistantMessageId: "selected-assistant" } }),
      makeEvent({ eventType: "status", seq: 3, runId: "another-run", payload: { runId: "run-1", assistantMessageId: "wrong-event-owner" } }),
      makeEvent({ eventType: "status", seq: 4, payload: { runId: "another-run", assistantMessageId: "wrong-payload-owner" } }),
      makeEvent({ eventType: "transcript.entry", seq: 5, payload: { runId: "run-1", assistantMessageId: "not-a-status" } }),
    ];
    expect(resolveRunChatTranscriptTarget(run, events)).toEqual({
      conversationId: "conversation-1",
      messageId: "selected-assistant",
    });
    expect(resolveRunChatTranscriptTarget(run, events.slice(1))).toBeNull();
  });

  it.each([null, "", "   "])("keeps a native no-output result authoritative (%s)", (assistantMessageId) => {
    expect(resolveRunChatTranscriptTarget({
      id: "run-1",
      contextSnapshot: { conversationId: "conversation-1", messageId: "user-message-1", assistantMessageId: "stale-context-assistant" },
      resultJson: { nativeChatFinalization: { result: { runId: "run-1", assistantMessageId } } },
    } as unknown as HeartbeatRun, [
      makeEvent({ eventType: "status", payload: { runId: "run-1", assistantMessageId: "stale-event-assistant" } }),
    ])).toBeNull();
  });

  it.each([null, {}, { result: null }])("does not fall back through a malformed native finalization", (nativeChatFinalization) => {
    expect(resolveRunChatTranscriptTarget({
      id: "run-1",
      chatConversationId: "conversation-1",
      contextSnapshot: { assistantMessageId: "stale-context-assistant" },
      resultJson: { nativeChatFinalization },
    } as unknown as HeartbeatRun)).toBeNull();
  });

  it("maps persisted chat transcript entries into the redacted run transcript shape", () => {
    expect(chatTranscriptEntriesToRunTranscriptEntries([
      {
        kind: "assistant",
        ts: "2026-06-17T09:00:01.000Z",
        text: "Opened /Users/zeeland/project",
      },
      {
        kind: "tool_call",
        ts: "2026-06-17T09:00:02.000Z",
        name: "read",
        input: { path: "/Users/zeeland/project/README.md" },
      },
    ], true)).toEqual([
      {
        kind: "assistant",
        ts: "2026-06-17T09:00:01.000Z",
        text: "Opened /Users/z******/project",
      },
      {
        kind: "tool_call",
        ts: "2026-06-17T09:00:02.000Z",
        name: "read",
        input: { path: "/Users/z******/project/README.md" },
      },
    ]);
  });

  it("maps error events to stderr transcript entries", () => {
    const entry = heartbeatRunEventToTranscriptEntry(
      makeEvent({
        eventType: "error",
        level: "error",
        message: "Process lost -- child pid 123 is no longer running",
      }),
    );

    expect(entry).toEqual({
      kind: "stderr",
      sourceEntryId: "1",
      ts: "2026-04-12T10:00:00.000Z",
      text: "Process lost -- child pid 123 is no longer running",
    });
  });

  it("falls back to event type plus payload when message is absent", () => {
    const text = heartbeatRunEventText(
      makeEvent({
        eventType: "adapter.invoke",
        message: null,
        payload: { command: "/bin/codex", cwd: "/tmp/workspace" },
      }),
    );

    expect(text).toContain("Adapter Invoke:");
    expect(text).toContain("\"command\":\"/bin/codex\"");
  });

  it("hydrates transcript.entry event payloads instead of generic event labels", () => {
    const entry = heartbeatRunEventToTranscriptEntry(
      makeEvent({
        eventType: "transcript.entry",
        message: "chat transcript entry",
        payload: {
          kind: "assistant",
          ts: "2026-06-17T09:00:01.000Z",
          text: "web search completed",
        },
      }),
    );

    expect(entry).toEqual({
      kind: "assistant",
      sourceEntryId: "1",
      ts: "2026-06-17T09:00:01.000Z",
      text: "web search completed",
    });
  });

  it("uses embedded transcript entries as the replay timeline when run events contain them", () => {
    const entries = heartbeatRunEventsToTranscriptEntries([
      makeEvent({
        seq: 1,
        eventType: "lifecycle",
        message: "chat run started",
      }),
      makeEvent({
        seq: 2,
        eventType: "transcript.entry",
        message: "chat transcript entry",
        payload: {
          kind: "assistant",
          ts: "2026-06-17T09:00:01.000Z",
          text: "Loaded agent instructions file",
        },
      }),
      makeEvent({
        seq: 3,
        eventType: "transcript.entry",
        message: "chat transcript entry",
        payload: {
          kind: "tool_result",
          ts: "2026-06-17T09:00:02.000Z",
          toolUseId: "tool-1",
          toolName: "exec_command",
          content: "web search completed",
          isError: false,
        },
      }),
      makeEvent({
        seq: 4,
        eventType: "chat.message_linked",
        message: "chat message linked",
      }),
    ]);

    expect(entries).toEqual([
      {
        kind: "assistant",
        sourceEntryId: "1",
        ts: "2026-06-17T09:00:01.000Z",
        text: "Loaded agent instructions file",
      },
      {
        kind: "tool_result",
        sourceEntryId: "1",
        ts: "2026-06-17T09:00:02.000Z",
        toolUseId: "tool-1",
        toolName: "exec_command",
        content: "web search completed",
        isError: false,
      },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries).not.toContainEqual(expect.objectContaining({ text: "chat transcript entry" }));
  });

  it("omits internal issue execution release events from fallback run detail entries", () => {
    const entries = heartbeatRunEventsToTranscriptEntries([
      makeEvent({
        seq: 1,
        eventType: "lifecycle",
        message: "Visible terminal lifecycle evidence",
      }),
      makeEvent({
        seq: 2,
        eventType: "issue.execution_released",
        message: "Issue execution released after terminal run",
      }),
    ]);

    expect(entries).toEqual([
      expect.objectContaining({ text: "Visible terminal lifecycle evidence" }),
    ]);
  });

  it("does not project hidden or internal adapter events into annotatable fallback transcript blocks", () => {
    const entries = heartbeatRunEventsToTranscriptEntries([
      makeEvent({
        seq: 1,
        eventType: "adapter.skill_usage",
        message: "internal skill usage",
        payload: { hidden: true },
      }),
      makeEvent({
        seq: 2,
        eventType: "adapter.invoke",
        message: "reasoning boundary",
        payload: { kind: "system", text: "reasoning started" },
      }),
      makeEvent({
        seq: 3,
        eventType: "run.output",
        message: "Visible terminal output",
      }),
    ]);

    expect(entries).toEqual([
      expect.objectContaining({ text: "Visible terminal output" }),
    ]);
  });

  it("keeps transcript evidence out of invocation events without deleting diagnostic events", () => {
    const invocationEvents = operatorVisibleInvocationRunEvents([
      makeEvent({
        seq: 1,
        eventType: "adapter.invoke",
        message: "adapter invocation",
      }),
      makeEvent({
        seq: 2,
        eventType: "transcript.entry",
        message: "chat transcript entry",
        payload: {
          kind: "assistant",
          text: "Visible in the Transcript tab instead.",
        },
      }),
      makeEvent({
        seq: 3,
        eventType: "error",
        level: "error",
        message: "runtime failed",
      }),
      makeEvent({
        seq: 4,
        eventType: "issue.execution_released",
        message: "internal issue release",
      }),
    ]);

    expect(invocationEvents.map((event) => event.message)).toEqual([
      "adapter invocation",
      "runtime failed",
    ]);
  });

  it("merges log transcript entries and event entries in timestamp order", () => {
    const logEntries: TranscriptEntry[] = [
      { kind: "assistant", ts: "2026-04-12T10:00:02.000Z", text: "Working now." },
      { kind: "stdout", ts: "2026-04-12T10:00:04.000Z", text: "done" },
    ];
    const eventEntries: TranscriptEntry[] = [
      { kind: "system", ts: "2026-04-12T10:00:01.000Z", text: "run started" },
      { kind: "system", ts: "2026-04-12T10:00:03.000Z", text: "adapter invocation" },
    ];

    expect(mergeTranscriptEntries(logEntries, eventEntries)).toEqual([
      { kind: "system", ts: "2026-04-12T10:00:01.000Z", text: "run started" },
      { kind: "assistant", ts: "2026-04-12T10:00:02.000Z", text: "Working now." },
      { kind: "system", ts: "2026-04-12T10:00:03.000Z", text: "adapter invocation" },
      { kind: "stdout", ts: "2026-04-12T10:00:04.000Z", text: "done" },
    ]);
  });
});
