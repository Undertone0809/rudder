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

function valueText(value: unknown): string {
  const direct = text(value);
  if (direct) return direct;
  const item = record(value);
  return Object.keys(item).length > 0 ? JSON.stringify(item) : "";
}

function parseProductRpcEvent(envelope: Record<string, unknown>, ts: string): TranscriptEntry[] {
  const event = typeof envelope.event === "string" ? envelope.event : "";
  const payload = record(envelope.payload);
  if (!event) return [];

  if (event === "message.delta") {
    const content = text(payload.text ?? payload.delta);
    return content ? [{ kind: "assistant", ts, text: content, delta: true }] : [];
  }
  if (event === "message.interim") {
    if (payload.already_streamed === true) return [];
    const content = text(payload.text);
    return content ? [{ kind: "assistant", ts, text: content }] : [];
  }
  if (event === "tool.start") {
    const toolUseId = typeof payload.tool_id === "string" ? payload.tool_id : "";
    if (!toolUseId) return [];
    return [{
      kind: "tool_call",
      ts,
      toolUseId,
      name: typeof payload.name === "string" ? payload.name : "Hermes tool",
      input: payload.args ?? payload.context ?? {},
    }];
  }
  if (event === "tool.complete") {
    const toolUseId = typeof payload.tool_id === "string" ? payload.tool_id : "";
    if (!toolUseId) return [];
    const content = valueText(payload.result_text ?? payload.summary ?? payload.result ?? payload.error);
    return content ? [{
      kind: "tool_result",
      ts,
      toolUseId,
      ...(typeof payload.name === "string" ? { toolName: payload.name } : {}),
      content,
      isError: payload.is_error === true || payload.status === "failed" || payload.status === "error",
    }] : [];
  }
  if (event === "approval.request" || event === "clarify.request") {
    const status = typeof payload.status === "string" ? payload.status : "requested";
    const details = event === "approval.request"
      ? [text(payload.description), text(payload.command)].filter(Boolean).join("\n")
      : Array.isArray(payload.questions)
        ? payload.questions.map((question) => text(record(question).question)).filter(Boolean).join("\n")
        : text(payload.question);
    const label = event === "approval.request" ? "approval" : "clarification";
    return [{ kind: "system", ts, text: `Hermes ${label} ${status}${details ? `: ${details}` : "."}` }];
  }
  if (event === "secret.request" || event === "sudo.request") {
    return [{ kind: "system", ts, text: "Hermes requested protected input; Rudder cancelled the request." }];
  }
  if (event === "message.complete" || event === "message.start" || event === "session.info") return [];

  const summary = text(payload.message ?? payload.text ?? payload.summary);
  return summary ? [{ kind: "system", ts, text: `Hermes ${event}: ${summary}` }] : [];
}

/** Shared live and historical Hermes projection; excludes permission payloads. */
export function parseHermesGatewayStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  try {
    const envelope = record(JSON.parse(trimmed));
    if (envelope.type === "hermes_product_rpc_event") return parseProductRpcEvent(envelope, ts);
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
