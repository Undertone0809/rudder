import { describe, expect, it } from "vitest";
import { parseCursorStdoutLine } from "./parse-stdout.js";

const parse = (update: Record<string, unknown>) => parseCursorStdoutLine(JSON.stringify({
  jsonrpc: "2.0", method: "session/update", params: { sessionId: "session", update },
}), "now");

describe("Cursor ACP transcript projection", () => {
  it("projects Cursor extension notifications into visible transcript entries", () => {
    const todos = parseCursorStdoutLine(JSON.stringify({
      jsonrpc: "2.0", method: "cursor/update_todos", params: {
        toolCallId: "todos-1", merge: true, todos: [
          { id: "1", content: "Inspect", status: "completed" },
          { id: "2", content: "Ship", status: "in_progress" },
          { id: "3", content: "Drop", status: "cancelled" },
        ],
      },
    }), "now");
    const task = parseCursorStdoutLine(JSON.stringify({
      jsonrpc: "2.0", method: "cursor/task", params: {
        description: "Inspect the auth flow", prompt: "Read the auth module", subagentType: "explore", agentId: "agent-1",
      },
    }), "now");
    const image = parseCursorStdoutLine(JSON.stringify({
      jsonrpc: "2.0", method: "cursor/generate_image", params: {
        description: "App icon", filePath: "/tmp/icon.png", referenceImagePaths: ["/tmp/ref.png"],
      },
    }), "now");

    expect(todos).toEqual([
      { kind: "todo_list", ts: "now", todoListId: "todos-1", items: [
        { text: "Inspect", status: "completed" }, { text: "Ship", status: "in_progress" },
      ] },
      { kind: "system", ts: "now", text: "Cursor todo cancelled: Drop" },
    ]);
    expect(task).toEqual([{
      kind: "system", ts: "now", text: "Cursor task\nInspect the auth flow\nPrompt: Read the auth module\nType: explore\nAgent: agent-1",
    }]);
    expect(image).toEqual([{
      kind: "system", ts: "now", text: "Cursor image\nApp icon\nFile: /tmp/icon.png\nReferences: /tmp/ref.png",
    }]);
  });

  it("preserves streamed whitespace and visible thought deltas", () => {
    expect(parse({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " hello 世界 " } }))
      .toEqual([{ kind: "assistant", ts: "now", text: " hello 世界 ", delta: true }]);
    expect(parse({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "considering" } }))
      .toEqual([{ kind: "thinking", ts: "now", text: "considering", delta: true }]);
  });

  it("projects ACP user message chunks as user transcript entries", () => {
    expect(parse({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "  inspect this  " } }))
      .toEqual([{ kind: "user", ts: "now", text: "  inspect this  " }]);
  });

  it("keeps complete tool details and failure status", () => {
    const fullOutput = "output".repeat(1000);
    expect(parse({ sessionUpdate: "tool_call", toolCallId: "call-1", title: "Read", rawInput: { path: "file" } }))
      .toEqual([{ kind: "tool_call", ts: "now", toolUseId: "call-1", name: "Read", input: { path: "file" } }]);
    expect(parse({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "failed", rawOutput: fullOutput }))
      .toEqual([{ kind: "tool_result", ts: "now", toolUseId: "call-1", toolName: undefined, content: fullOutput, isError: true }]);
  });

  it("preserves both call input and terminal output when tool_call arrives completed", () => {
    expect(parse({ sessionUpdate: "tool_call", toolCallId: "call-fast", title: "Read", status: "completed",
      rawInput: { path: "file" }, rawOutput: "contents" })).toEqual([
      { kind: "tool_call", ts: "now", toolUseId: "call-fast", name: "Read", input: { path: "file" } },
      { kind: "tool_result", ts: "now", toolUseId: "call-fast", toolName: "Read", content: "contents", isError: false },
    ]);
  });

  it("keeps one tool lifecycle card while ignoring progress updates", () => {
    expect(parse({ sessionUpdate: "tool_call", toolCallId: "call-1", status: "pending", title: "Read", rawInput: { path: "file" } }))
      .toEqual([{ kind: "tool_call", ts: "now", toolUseId: "call-1", name: "Read", input: { path: "file" } }]);
    expect(parse({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "in_progress", content: "reading" }))
      .toEqual([]);
    expect(parse({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", rawOutput: "contents" }))
      .toEqual([{ kind: "tool_result", ts: "now", toolUseId: "call-1", toolName: undefined, content: "contents", isError: false }]);
  });

  it("closes cancelled and error tool updates as failed results", () => {
    expect(parse({ sessionUpdate: "tool_call_update", toolCallId: "call-cancelled", status: "cancelled" }))
      .toEqual([{ kind: "tool_result", ts: "now", toolUseId: "call-cancelled", toolName: undefined, content: "Tool call cancelled", isError: true }]);
    expect(parse({ sessionUpdate: "tool_call_update", toolCallId: "call-error", status: "error", content: "provider error" }))
      .toEqual([{ kind: "tool_result", ts: "now", toolUseId: "call-error", toolName: undefined, content: "provider error", isError: true }]);
    expect(parse({ sessionUpdate: "tool_call_update", toolCallId: "call-unknown", status: "unknown", content: "progress" }))
      .toEqual([]);
  });

  it("projects native plans without dropping steps", () => {
    expect(parse({ sessionUpdate: "plan", entries: [
      { content: "Read", status: "completed" }, { content: "Test", status: "in_progress" },
    ] })).toEqual([{ kind: "todo_list", ts: "now", items: [
      { text: "Read", status: "completed" }, { text: "Test", status: "in_progress" },
    ] }]);
  });
});
