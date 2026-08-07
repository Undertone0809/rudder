import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseEvent(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseEventLine(line: string, ts: string): TranscriptEntry[] {
  const match = line.match(/^\[hermes-gateway:event\]\s+run=([^\s]+)\s+type=([^\s]+)\s+(?:data|summary)=(.*)$/s);
  if (!match) return [{ kind: "system", ts, text: line.replace(/^\[hermes-gateway:event\]\s*/, "") }];

  const event = parseEvent(match[3].trim());
  if (!event) return [{ kind: "system", ts, text: line.replace(/^\[hermes-gateway:event\]\s*/, "") }];

  const type = match[2].toLowerCase();
  if (["run.failed", "run.cancelled", "error"].includes(type)) {
    const error = asString(event.error) || asString(event.message) || asString(event.output);
    if (error) return [{ kind: "stderr", ts, text: error }];
  }

  const text = asString(event.delta) || asString(event.output) || asString(event.content) || asString(event.message);
  if (!text) return [];
  return [{ kind: "assistant", ts, text, ...(type === "message.delta" ? { delta: true } : {}) }];
}

export function parseHermesGatewayStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[hermes-gateway:event]")) return parseEventLine(trimmed, ts);
  if (trimmed.startsWith("[hermes-gateway]")) {
    return [{ kind: "system", ts, text: trimmed.replace(/^\[hermes-gateway\]\s*/, "") }];
  }
  return [{ kind: "stdout", ts, text: line }];
}
