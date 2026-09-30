import type { TranscriptEntry } from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function readText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  const record = asRecord(value);
  if (!record) return "";
  const direct = asString(record.text).trim();
  if (direct) return direct;
  if (!Array.isArray(record.content)) return "";
  return record.content.flatMap((partRaw) => {
    const part = asRecord(partRaw);
    if (!part) return [];
    const type = asString(part.type);
    if (type !== "output_text" && type !== "text" && type !== "content") return [];
    const text = asString(part.text).trim() || asString(part.content).trim();
    return text ? [text] : [];
  }).join("\n");
}

function parseAssistantMessage(value: unknown, ts: string): TranscriptEntry[] {
  const message = asRecord(value);
  if (!message) {
    const text = readText(value);
    return text ? [{ kind: "assistant", ts, text }] : [];
  }

  const entries: TranscriptEntry[] = [];
  const directText = asString(message.text).trim();
  if (directText) entries.push({ kind: "assistant", ts, text: directText });
  if (!Array.isArray(message.content)) return entries;

  for (const partRaw of message.content) {
    const part = asRecord(partRaw);
    if (!part) continue;
    const type = asString(part.type);
    if (type === "output_text" || type === "text" || type === "content") {
      const text = asString(part.text).trim() || asString(part.content).trim();
      if (text) entries.push({ kind: "assistant", ts, text });
    } else if (type === "thinking") {
      const text = asString(part.text).trim();
      if (text) entries.push({ kind: "thinking", ts, text });
    } else if (type === "tool_call") {
      entries.push({
        kind: "tool_call",
        ts,
        name: asString(part.name, asString(part.tool, "tool")),
        input: part.input ?? part.arguments ?? part.args ?? {},
      });
    } else if (type === "tool_result" || type === "tool_response") {
      const content = part.output ?? part.text ?? part.result ?? part.response;
      entries.push({
        kind: "tool_result",
        ts,
        toolUseId: asString(part.tool_use_id)
          || asString(part.toolUseId)
          || asString(part.call_id)
          || asString(part.id)
          || "tool_result",
        content: stringify(content),
        isError: part.is_error === true || asString(part.status).toLowerCase() === "error",
      });
    }
  }
  return entries;
}

function parseToolCall(parsed: Record<string, unknown>, ts: string): TranscriptEntry[] {
  const subtype = asString(parsed.subtype).trim().toLowerCase();
  const callId = asString(parsed.call_id, asString(parsed.callId, asString(parsed.id, "tool_call")));
  const calls = asRecord(parsed.tool_call ?? parsed.toolCall);
  if (!calls) return [{ kind: "system", ts, text: `tool_call${subtype ? ` (${subtype})` : ""}` }];
  const [name] = Object.keys(calls);
  if (!name) return [{ kind: "system", ts, text: `tool_call${subtype ? ` (${subtype})` : ""}` }];
  const payload = asRecord(calls[name]) ?? {};

  if (subtype === "started" || subtype === "start") {
    return [{
      kind: "tool_call",
      ts,
      name,
      input: payload.args ?? payload.input ?? payload.arguments ?? payload,
    }];
  }
  if (subtype === "completed" || subtype === "complete" || subtype === "finished") {
    const result = payload.result ?? payload.output ?? payload.error;
    return [{
      kind: "tool_result",
      ts,
      toolUseId: callId,
      content: result === undefined ? `${name} completed` : stringify(result),
      isError: parsed.is_error === true
        || payload.is_error === true
        || payload.error !== undefined
        || asString(payload.status).toLowerCase() === "error",
    }];
  }
  return [{ kind: "system", ts, text: `tool_call${subtype ? ` (${subtype})` : ""}: ${name}` }];
}

/** Decodes stored Gemini CLI logs only. This is not an executable Runtime adapter. */
export function parseRemovedGeminiLocalHistoryLine(line: string, ts: string): TranscriptEntry[] {
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(line);
  } catch {
    return [{ kind: "stdout", ts, text: line }];
  }
  const parsed = asRecord(parsedValue);
  if (!parsed) return [{ kind: "stdout", ts, text: line }];

  const type = asString(parsed.type);
  if (type === "user") return [];
  if (type === "init" || (type === "system" && asString(parsed.subtype) === "init")) {
    const sessionId = asString(parsed.session_id)
      || asString(parsed.sessionId)
      || asString(parsed.sessionID)
      || asString(parsed.checkpoint_id)
      || asString(parsed.thread_id);
    return [{ kind: "init", ts, model: asString(parsed.model, "gemini"), sessionId }];
  }
  if (type === "system") {
    const subtype = asString(parsed.subtype);
    if (subtype === "error") {
      const error = parsed.error ?? parsed.message ?? parsed.detail;
      return [{ kind: "stderr", ts, text: asString(asRecord(error)?.message, asString(error, "error")) }];
    }
    return [{ kind: "system", ts, text: `system: ${subtype || "event"}` }];
  }
  if (type === "assistant") return parseAssistantMessage(parsed.message, ts);
  if (type === "message") {
    const role = asString(parsed.role).trim().toLowerCase();
    if (role === "user") return [];
    if (role === "assistant") return parseAssistantMessage(parsed.content ?? parsed.message, ts);
    const text = readText(parsed.content ?? parsed.message);
    return text ? [{ kind: "assistant", ts, text }] : [];
  }
  if (type === "thinking") {
    const text = asString(parsed.text).trim() || asString(asRecord(parsed.delta)?.text).trim();
    return text ? [{ kind: "thinking", ts, text }] : [];
  }
  if (type === "tool_call") return parseToolCall(parsed, ts);
  if (type === "tool_use") {
    return [{
      kind: "tool_call",
      ts,
      name: asString(parsed.tool_name)
        || asString(parsed.toolName)
        || asString(parsed.name)
        || asString(parsed.tool, "tool"),
      toolUseId: asString(parsed.tool_id) || asString(parsed.toolUseId) || asString(parsed.id) || undefined,
      input: parsed.parameters ?? parsed.input ?? parsed.arguments ?? parsed.args ?? {},
    }];
  }
  if (type === "tool_result") {
    const result = parsed.output ?? parsed.result ?? parsed.content ?? parsed.response;
    return [{
      kind: "tool_result",
      ts,
      toolUseId: asString(parsed.tool_id) || asString(parsed.toolUseId) || asString(parsed.id) || "tool_result",
      content: stringify(result),
      isError: parsed.is_error === true
        || parsed.error !== undefined
        || asString(parsed.status).toLowerCase() === "error",
    }];
  }
  if (type === "result") {
    const usage = asRecord(parsed.usage) ?? asRecord(parsed.usageMetadata) ?? {};
    const nestedUsage = asRecord(usage.usageMetadata) ?? usage;
    const errors = parsed.is_error === true
      ? [asString(asRecord(parsed.error)?.message, asString(parsed.error ?? parsed.message ?? parsed.result))].filter(Boolean)
      : [];
    return [{
      kind: "result",
      ts,
      text: asString(parsed.result) || asString(parsed.text) || asString(parsed.response),
      inputTokens: asNumber(nestedUsage.input_tokens, asNumber(nestedUsage.inputTokens, asNumber(nestedUsage.promptTokenCount))),
      outputTokens: asNumber(nestedUsage.output_tokens, asNumber(nestedUsage.outputTokens, asNumber(nestedUsage.candidatesTokenCount))),
      cachedTokens: asNumber(nestedUsage.cached_input_tokens, asNumber(nestedUsage.cachedInputTokens, asNumber(nestedUsage.cachedContentTokenCount))),
      costUsd: asNumber(parsed.total_cost_usd, asNumber(parsed.cost_usd, asNumber(parsed.cost))),
      subtype: asString(parsed.subtype, "result"),
      isError: parsed.is_error === true,
      errors,
    }];
  }
  if (type === "error") {
    const error = parsed.error ?? parsed.message ?? parsed.detail;
    return [{ kind: "stderr", ts, text: asString(asRecord(error)?.message, asString(error, "error")) }];
  }
  return [{ kind: "stdout", ts, text: line }];
}
