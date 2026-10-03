import { describe, expect, it } from "vitest";
import { parseHermesGatewayStdoutLine } from "./parse-stdout.js";

const parse = (update: Record<string, unknown>) => parseHermesGatewayStdoutLine(JSON.stringify({ type: "hermes_acp_update", update }), "now");
const parseRpc = (event: string, payload: Record<string, unknown>) => parseHermesGatewayStdoutLine(
  JSON.stringify({ type: "hermes_product_rpc_event", event, payload }),
  "now",
);

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

  it("projects Product RPC message and tool events into the Run transcript", () => {
    expect(parseRpc("message.delta", { text: "working" })).toEqual([
      { kind: "assistant", ts: "now", text: "working", delta: true },
    ]);
    expect(parseRpc("tool.start", { tool_id: "tool-17", name: "Read", args: { path: "a.txt" } })).toEqual([
      { kind: "tool_call", ts: "now", toolUseId: "tool-17", name: "Read", input: { path: "a.txt" } },
    ]);
    expect(parseRpc("tool.complete", { tool_id: "tool-17", name: "Read", result_text: "file contents" })).toEqual([
      { kind: "tool_result", ts: "now", toolUseId: "tool-17", toolName: "Read", content: "file contents", isError: false },
    ]);
  });

  it("projects interaction status without replaying terminal answer payloads", () => {
    expect(parseRpc("approval.request", { status: "requested", description: "Allow tests?", command: "pnpm test" })).toEqual([
      { kind: "system", ts: "now", text: "Hermes approval requested: Allow tests?\npnpm test" },
    ]);
    expect(parseRpc("message.complete", { text: "already streamed answer", status: "complete" })).toEqual([]);
    expect(parseRpc("session.info", { running: false })).toEqual([]);
  });
});
