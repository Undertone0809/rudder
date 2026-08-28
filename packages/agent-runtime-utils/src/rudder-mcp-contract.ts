import {
  GENERATED_RUDDER_BROWSER_MCP_CONTRACT_HASH,
  GENERATED_RUDDER_CORE_MCP_CONTRACT_HASH,
  RUDDER_MCP_TOOL_DESCRIPTORS,
} from "./rudder-mcp-tool-descriptors.generated.js";

export const RUDDER_MCP_CONTRACT_VERSION = "rudder.agent-mcp-tools/v1";

export interface RudderMcpSemanticToolContract {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface RudderMcpToolContractSource extends RudderMcpSemanticToolContract {
  capabilityId: string;
  mutating: boolean;
  requiresOrgId: boolean;
  requiresAgentId: boolean;
  attachesRunIdWhenAvailable: boolean;
  semanticDescription?: string;
}

interface RudderMcpInputSchema extends Record<string, unknown> {
  type: "object";
  additionalProperties: false;
  properties: Record<string, unknown>;
  required?: readonly string[];
  anyOf?: ReadonlyArray<{ required: readonly string[] }>;
}

export function rudderMcpInputSchemaForCapability(id: string): RudderMcpInputSchema {
  const descriptor = RUDDER_MCP_TOOL_DESCRIPTORS.find((tool) => tool.capabilityId === id);
  if (!descriptor) throw new Error(`Missing exact Rudder MCP input schema for capability: ${id}`);
  return descriptor.inputSchema as RudderMcpInputSchema;
}

export const RUDDER_MCP_CANONICAL_TOOL_DEFINITIONS = RUDDER_MCP_TOOL_DESCRIPTORS;

export function rudderMcpSemanticToolContract(
  tool: RudderMcpToolContractSource,
): RudderMcpSemanticToolContract {
  return {
    name: tool.name,
    description: tool.semanticDescription ?? tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  };
}

export const RUDDER_MCP_CANONICAL_TOOL_CONTRACTS = RUDDER_MCP_CANONICAL_TOOL_DEFINITIONS
  .map(rudderMcpSemanticToolContract);

export const RUDDER_CORE_MCP_TOOL_CONTRACTS = RUDDER_MCP_CANONICAL_TOOL_CONTRACTS
  .filter((tool) => !tool.name.startsWith("rudder_browser_"));
export const RUDDER_BROWSER_MCP_TOOL_CONTRACTS = RUDDER_MCP_CANONICAL_TOOL_CONTRACTS
  .filter((tool) => tool.name.startsWith("rudder_browser_"));

export const RUDDER_CORE_MCP_TOOL_NAMES = RUDDER_CORE_MCP_TOOL_CONTRACTS.map((tool) => tool.name);
export const RUDDER_BROWSER_MCP_TOOL_NAMES = RUDDER_BROWSER_MCP_TOOL_CONTRACTS.map((tool) => tool.name);

export const RUDDER_CORE_MCP_CONTRACT_HASH = GENERATED_RUDDER_CORE_MCP_CONTRACT_HASH;
export const RUDDER_BROWSER_MCP_CONTRACT_HASH = GENERATED_RUDDER_BROWSER_MCP_CONTRACT_HASH;
