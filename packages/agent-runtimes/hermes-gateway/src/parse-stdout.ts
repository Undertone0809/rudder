import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join("\n");
  const item = record(value);
  return typeof item.text === "string" ? item.text : item.content ? text(item.content) : "";
}

/** Shared live and historical Hermes projection; excludes permission payloads. */
export function parseHermesGatewayStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  try {
    const envelope = record(JSON.parse(trimmed));
    if (envelope.type === "hermes_acp_update") {
      const update = record(envelope.update);
      const kind = update.sessionUpdate;
      if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
        const content = text(update.content);
        return content ? [{ kind: kind === "agent_message_chunk" ? "assistant" : "thinking", ts, text: content, delta: true }] : [];
      }
      if (kind === "tool_call" || kind === "tool_call_update") {
        const id = typeof update.toolCallId === "string" ? update.toolCallId : "";
        if (!id) return [];
        if (["completed", "failed", "cancelled"].includes(String(update.status))) {
          return [{ kind: "tool_result", ts, toolUseId: id,
            content: text(update.content) || text(update.rawOutput) || JSON.stringify(update.rawOutput ?? update.status),
            isError: update.status !== "completed" }];
        }
        if (kind === "tool_call") return [{ kind: "tool_call", ts, toolUseId: id,
          name: typeof update.title === "string" ? update.title : "Hermes tool", input: update.rawInput ?? {} }];
        return [];
      }
      if (kind === "plan") return [{ kind: "system", ts, text: JSON.stringify({ plan: update.entries ?? [] }) }];
      return [];
    }
  } catch { /* Legacy gateway output is not JSON. */ }
  if (trimmed.startsWith("[hermes-gateway:event]")) {
    const match = trimmed.match(/type=([^\s]+)\s+data=(.*)$/s);
    if (match?.[2]) {
      try {
        const event = record(JSON.parse(match[2]));
        const content = typeof event.delta === "string" ? event.delta : typeof event.output === "string" ? event.output : "";
        if (content) return [{ kind: "assistant", ts, text: content, delta: match[1] === "message.delta" }];
      } catch { /* Preserve legacy evidence. */ }
    }
    return [{ kind: "system", ts, text: trimmed.replace(/^\[hermes-gateway:event\]\s*/, "") }];
  }
  if (trimmed.startsWith("[hermes-gateway]")) return [{ kind: "system", ts, text: trimmed.replace(/^\[hermes-gateway\]\s*/, "") }];
  return [{ kind: "stdout", ts, text: line }];
}
