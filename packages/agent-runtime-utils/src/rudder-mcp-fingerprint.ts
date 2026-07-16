import { createHash } from "node:crypto";
import type { RudderMcpSemanticToolContract } from "./rudder-mcp-contract.js";

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, stableJsonValue(entry)]),
  );
}

export function stableRudderMcpContractJson(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

export function fingerprintRudderMcpToolManifest(
  tools: readonly RudderMcpSemanticToolContract[],
): string {
  return createHash("sha256")
    .update(stableRudderMcpContractJson(tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }))))
    .digest("hex");
}
