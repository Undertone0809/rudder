import { asRecord } from "./RunTranscriptView.common";
import {
  extractMcpSearchExtraArgs,
  extractMcpToolDetails,
  formatMcpSearchQuery,
  formatToolPayload,
  hasNonEmptyToolPayload,
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
  const searchQuery = mcpDetails ? formatMcpSearchQuery(mcpDetails) : null;
  const payload = mcpDetails ? (mcpDetails.args ?? {}) : input;
  if (!hasNonEmptyToolPayload(payload)) return "<empty>";
  return searchQuery ?? formatToolPayload(payload);
}

export function getNiceToolRequestLabel(name: string, input: unknown): "Input" | "Query" {
  const mcpDetails = extractMcpToolDetails(name, input);
  return mcpDetails && formatMcpSearchQuery(mcpDetails) ? "Query" : "Input";
}

export function formatNiceToolRequestParameters(name: string, input: unknown): string | null {
  const mcpDetails = extractMcpToolDetails(name, input);
  const extraArgs = mcpDetails ? extractMcpSearchExtraArgs(mcpDetails) : null;
  return extraArgs ? formatToolPayload(extraArgs) : null;
}

export function formatNiceToolResponse(
  name: string,
  input: unknown,
  result: string | undefined,
): string | null {
  if (typeof result !== "string" || !result.trim()) return null;
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
