import { describe, expect, it } from "vitest";
import { chatTranscriptEntryFromReaderItem } from "./chat-transcript-reader-item.js";
import type { TranscriptItem } from "./runtime-kernel/transcript-reader.js";

const ts = "2026-09-23T08:00:00.000Z";

function cursorItem(
  sessionUpdate: string,
  update: Record<string, unknown>,
  text?: string,
): TranscriptItem {
  return {
    id: `cursor:acp:update:${sessionUpdate}`,
    ordinal: 0,
    runId: "run-1",
    spanId: "span-1",
    sourceEntryId: `acp:update:${sessionUpdate}`,
    sourceRef: null,
    kind: `cursor:acp:${sessionUpdate}`,
    ts,
    payload: {
      provider: "cursor_agent",
      transport: "cursor-agent-acp-stdio",
      method: "session/update",
      sessionId: "cursor-session-1",
      update: { sessionUpdate, ...update },
    },
    origin: "native",
    visibility: "visible",
    ...(text === undefined ? {} : { text }),
  };
}

describe("Chat transcript Reader item conversion", () => {
  it("preserves raw ACP message and thought chunks without offering replay IDs as annotation anchors", () => {
    expect(chatTranscriptEntryFromReaderItem(cursorItem("agent_message_chunk", {
      content: { type: "text", text: "Hello " },
    }, "Hello"))).toEqual({
      kind: "assistant", ts, text: "Hello ", delta: true,
    });
    expect(chatTranscriptEntryFromReaderItem(cursorItem("agent_thought_chunk", {
      content: { type: "text", text: " reasoning" },
    }, "reasoning"))).toEqual({
      kind: "thinking", ts, text: " reasoning", delta: true,
    });
    expect(chatTranscriptEntryFromReaderItem(cursorItem("user_message_chunk", {
      content: { type: "text", text: " next" },
    }, "next"))).toEqual({
      kind: "user", ts, text: " next", delta: true,
    });
    expect(chatTranscriptEntryFromReaderItem(cursorItem("agent_message", {}, "Complete answer"))).toEqual({
      kind: "assistant", ts, text: "Complete answer",
    });
    expect(chatTranscriptEntryFromReaderItem({
      ...cursorItem("agent_message_chunk", { content: { type: "text", text: "Persisted" } }),
      origin: "object", sourceEntryId: "object-update-1",
    })).toEqual({ kind: "assistant", ts, text: "Persisted", delta: true, sourceEntryId: "object-update-1" });
  });

  it("projects ACP tool calls and terminal updates without discarding provider evidence", () => {
    const call = cursorItem("tool_call", {
      toolCallId: "tool-1", title: "read_file", rawInput: { path: "README.md" },
    }, "read_file");
    expect(chatTranscriptEntryFromReaderItem(call)).toEqual({
      kind: "tool_call", ts, name: "read_file", toolUseId: "tool-1",
      input: { path: "README.md" },
    });
    const result = cursorItem("tool_call_update", {
      toolCallId: "tool-1", status: "failed", rawOutput: { reason: "denied" },
    });
    expect(chatTranscriptEntryFromReaderItem(result)).toEqual({
      kind: "tool_result", ts, toolUseId: "tool-1", content: '{"reason":"denied"}',
      isError: true,
    });
    expect(chatTranscriptEntryFromReaderItem(cursorItem("tool_call_update", {
      toolCallId: "tool-1", status: "in_progress",
    }))).toEqual({
      kind: "system", ts, text: "Tool tool-1: in_progress",
    });
    for (const [status, isError] of [["completed", false], ["cancelled", true]] as const) {
      expect(chatTranscriptEntryFromReaderItem(cursorItem("tool_call", {
        toolCallId: "tool-terminal", title: "read_file", status, rawOutput: { status },
      }))).toEqual({
        kind: "tool_call", ts, toolUseId: "tool-terminal", name: "read_file",
        input: expect.objectContaining({ toolCallId: "tool-terminal", status }),
        status, result: JSON.stringify({ status }), isError,
      });
    }
    expect(chatTranscriptEntryFromReaderItem(cursorItem("tool_call_update", {
      toolCallId: "tool-1", status: "cancelled",
    }))).toMatchObject({ kind: "tool_result", isError: true });
  });

  it("projects a native ACP plan only when every checklist entry is valid", () => {
    const plan = cursorItem("plan", { entries: [
      { content: "Inspect", status: "completed" },
      { content: "Verify", status: "in_progress" },
    ] });
    expect(chatTranscriptEntryFromReaderItem(plan)).toEqual({
      kind: "todo_list", ts, items: [
        { text: "Inspect", status: "completed" },
        { text: "Verify", status: "in_progress" },
      ],
    });
    expect(chatTranscriptEntryFromReaderItem(cursorItem("plan", {
      entries: [{ content: "Inspect", status: "unknown" }],
    }))).toBeNull();
    expect(chatTranscriptEntryFromReaderItem(cursorItem("plan", { entries: [] }))).toBeNull();
  });

  it("rejects unsupported or mismatched ACP updates instead of guessing transcript roles", () => {
    const message = cursorItem("agent_message_chunk", { content: { type: "text", text: "Ready" } });
    expect(chatTranscriptEntryFromReaderItem({ ...message, kind: "cursor:acp:plan" })).toBeNull();
    expect(chatTranscriptEntryFromReaderItem({ ...message, payload: {
      provider: "another_provider", transport: "cursor-agent-acp-stdio", method: "session/update",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Ready" } },
    } })).toBeNull();
    expect(chatTranscriptEntryFromReaderItem(cursorItem("agent_message_chunk", {
      content: { type: "image", data: "not-text" },
    }))).toBeNull();
    expect(chatTranscriptEntryFromReaderItem(cursorItem("tool_call", { title: "read_file" }))).toBeNull();
  });
});
