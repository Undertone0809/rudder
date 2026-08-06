import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";

export function parseHermesGatewayStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[hermes-gateway:event]")) {
    const match = trimmed.match(/type=([^\s]+)\s+data=(.*)$/s);
    if (match?.[2]) {
      try {
        const event = JSON.parse(match[2]) as Record<string, unknown>;
        const text = typeof event.delta === "string" ? event.delta : typeof event.output === "string" ? event.output : "";
        if (text) return [{ kind: "assistant", ts, text, delta: match[1] === "message.delta" }];
      } catch {
        // Preserve the structured line as system evidence below.
      }
    }
    return [{ kind: "system", ts, text: trimmed.replace(/^\[hermes-gateway:event\]\s*/, "") }];
  }
  if (trimmed.startsWith("[hermes-gateway]")) {
    return [{ kind: "system", ts, text: trimmed.replace(/^\[hermes-gateway\]\s*/, "") }];
  }
  return [{ kind: "stdout", ts, text: line }];
}
