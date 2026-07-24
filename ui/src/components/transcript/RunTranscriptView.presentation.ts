import { asRecord } from "./RunTranscriptView.common";
import {
  extractMcpToolDetails,
  formatToolPayload,
} from "./RunTranscriptView.semantic";

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

export function formatNiceToolRequest(
  name: string,
  input: unknown,
): string {
  const mcpDetails = extractMcpToolDetails(name, input);
  return formatToolPayload(mcpDetails ? (mcpDetails.args ?? {}) : input) || "<empty>";
}

export function formatNiceToolResponse(
  name: string,
  input: unknown,
  result: string | undefined,
): string | null {
  if (!result) return null;
  if (!extractMcpToolDetails(name, input)) return formatToolPayload(result);

  const response = parseJsonRecord(result);
  if (
    response
    && Object.prototype.hasOwnProperty.call(response, "structuredContent")
  ) {
    return formatToolPayload(response.structuredContent);
  }

  return formatToolPayload(result);
}
