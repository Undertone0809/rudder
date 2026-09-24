import { describe, expect, it } from "vitest";
import { parseHermesGatewayStdoutLine } from "./parse-stdout.js";

const parse = (update: Record<string, unknown>) => parseHermesGatewayStdoutLine(JSON.stringify({ type: "hermes_acp_update", update }), "now");

describe("Hermes live ACP transcript", () => {
  it("preserves whitespace and separates thought from assistant deltas", () => {
    expect(parse({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " hello " } }))
      .toEqual([{ kind: "assistant", ts: "now", text: " hello ", delta: true }]);
    expect(parse({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } })[0]?.kind).toBe("thinking");
  });
  it("keeps one tool start and resolves cancellation by the same tool id", () => {
    const sequence = [
      { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read", status: "pending", rawInput: { path: "a.txt" } },
      { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "in_progress" },
      { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "cancelled" },
    ].flatMap(parse);
    expect(sequence.map((entry) => entry.kind)).toEqual(["tool_call", "tool_result"]);
    expect(sequence[1]).toMatchObject({ toolUseId: "tool-1", isError: true });
  });
  it("does not project permission payloads and preserves legacy gateway deltas", () => {
    expect(parse({ sessionUpdate: "request_permission", privatePrompt: "hidden" })).toEqual([]);
    expect(parseHermesGatewayStdoutLine('[hermes-gateway:event] type=message.delta data={"delta":"legacy"}', "now"))
      .toEqual([{ kind: "assistant", ts: "now", text: "legacy", delta: true }]);
  });
});
