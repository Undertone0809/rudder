import {
  RUDDER_BROWSER_MCP_TOOL_NAMES,
  RUDDER_CORE_MCP_TOOL_NAMES
} from "./rudder-mcp-contract.js";

export {
  RUDDER_BROWSER_MCP_CONTRACT_HASH,
  RUDDER_BROWSER_MCP_TOOL_CONTRACTS,
  RUDDER_BROWSER_MCP_TOOL_NAMES,
  RUDDER_CORE_MCP_CONTRACT_HASH,
  RUDDER_CORE_MCP_TOOL_CONTRACTS,
  RUDDER_CORE_MCP_TOOL_NAMES,
  RUDDER_MCP_CANONICAL_TOOL_CONTRACTS,
  RUDDER_MCP_CANONICAL_TOOL_DEFINITIONS,
  RUDDER_MCP_CONTRACT_VERSION, rudderMcpSemanticToolContract, type RudderMcpSemanticToolContract,
  type RudderMcpToolContractSource
} from "./rudder-mcp-contract.js";

export const RUDDER_MCP_SERVER_NAME = "rudder-tools";
export const RUDDER_BROWSER_MCP_SERVER_NAME = "rudder-browser";
export const RUDDER_COMPUTER_MCP_SERVER_NAME = "rudder-computer";
export const RUDDER_MCP_LEGACY_SERVER_NAMES = [
  ["rudder", "control", "plane"].join("-"),
  ["rudder", "operating", "layer"].join("-"),
] as const;
export const RUDDER_MCP_TOOL_COUNT = RUDDER_CORE_MCP_TOOL_NAMES.length;
export const RUDDER_BROWSER_MCP_TOOL_COUNT = RUDDER_BROWSER_MCP_TOOL_NAMES.length;
export const RUDDER_MCP_MANAGED_ENV_KEYS = [
  "RUDDER_API_URL",
  "RUDDER_API_KEY",
  "RUDDER_ORG_ID",
  "RUDDER_AGENT_ID",
  "RUDDER_RUN_ID",
  "RUDDER_BROWSER_ENABLED",
  "RUDDER_COMPUTER_ENABLED",
  "RUDDER_PROJECT_LIBRARY_PATH",
] as const;

export type RudderMcpManagedEnvKey = typeof RUDDER_MCP_MANAGED_ENV_KEYS[number];
export type RudderMcpManagedEnv = Partial<Record<RudderMcpManagedEnvKey, string>>;

export interface RudderMcpCliCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
  provenance: RudderMcpCliProvenance;
  expectedVersion?: string | null;
}

export type RudderMcpCliProvenance = "desktop_bundle" | "external_runtime" | "repo" | "path";

export type RudderMcpPreflightDiagnosticCode =
  | "core_bundle_handshake_failed"
  | "core_bundle_server_mismatch"
  | "core_bundle_version_mismatch"
  | "core_bundle_contract_mismatch"
  | "core_bundle_tools_mismatch"
  | "browser_bundle_handshake_failed"
  | "browser_bundle_server_mismatch"
  | "browser_bundle_version_mismatch"
  | "browser_bundle_contract_mismatch"
  | "browser_bundle_tools_mismatch";

export interface RudderMcpPreflightResult {
  available: boolean;
  browserAvailable?: boolean;
  provenance: RudderMcpCliProvenance;
  version: string | null;
  contractVersion: string | null;
  coreContractHash: string | null;
  contractHash?: string | null;
  diagnosticCode: RudderMcpPreflightDiagnosticCode | null;
  diagnostic: string | null;
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
}

export interface RudderMcpRuntimeMetadata {
  available: boolean;
  serverName: typeof RUDDER_MCP_SERVER_NAME;
  toolCount: number;
  provenance?: RudderMcpCliProvenance | null;
  version?: string | null;
  contractVersion?: string | null;
  coreContractHash?: string | null;
  fallbackReason?: string | null;
}

export interface RudderBrowserMcpRuntimeMetadata {
  available: boolean;
  serverName: typeof RUDDER_BROWSER_MCP_SERVER_NAME;
  toolCount: number;
  provenance?: RudderMcpCliProvenance | null;
  version?: string | null;
  contractVersion?: string | null;
  contractHash?: string | null;
  diagnosticCode?: RudderMcpPreflightDiagnosticCode | null;
  fallbackReason?: string | null;
}

export function rudderMcpRuntimeMetadata(
  input: {
    available?: boolean;
    /** @deprecated Ignored; Browser capability state is reported only by browserMcp. */
    browserEnabled?: boolean;
    preflight?: RudderMcpPreflightResult | null;
    fallbackReason?: string | null;
  } = {},
): RudderMcpRuntimeMetadata {
  const metadata: RudderMcpRuntimeMetadata = {
    available: input.available ?? input.preflight?.available ?? true,
    serverName: RUDDER_MCP_SERVER_NAME,
    toolCount: RUDDER_MCP_TOOL_COUNT,
    fallbackReason: input.fallbackReason ?? input.preflight?.diagnostic ?? null,
  };
  if (input.preflight) {
    metadata.provenance = input.preflight.provenance;
    metadata.version = input.preflight.version;
    metadata.contractVersion = input.preflight.contractVersion;
    metadata.coreContractHash = input.preflight.coreContractHash;
  }
  return metadata;
}

export function rudderBrowserMcpRuntimeMetadata(
  input: {
    available?: boolean;
    preflight?: RudderMcpPreflightResult | null;
    fallbackReason?: string | null;
  } = {},
): RudderBrowserMcpRuntimeMetadata {
  return {
    available: input.available ?? input.preflight?.browserAvailable ?? true,
    serverName: RUDDER_BROWSER_MCP_SERVER_NAME,
    toolCount: RUDDER_BROWSER_MCP_TOOL_COUNT,
    provenance: input.preflight?.provenance ?? null,
    version: input.preflight?.version ?? null,
    contractVersion: input.preflight?.contractVersion ?? null,
    contractHash: input.preflight?.contractHash ?? null,
    diagnosticCode: input.preflight?.diagnosticCode ?? null,
    fallbackReason: input.fallbackReason ?? input.preflight?.diagnostic ?? null,
  };
}

export function applyRudderBrowserCapabilityEnv(
  env: Record<string, string>,
  config: Record<string, unknown>,
): boolean {
  const browserEnabled = config.rudderBrowserEnabled === true;
  env.RUDDER_BROWSER_ENABLED = browserEnabled ? "true" : "false";
  return browserEnabled;
}

export function filterRudderMcpToolsForBrowserCapability<T extends { name: string }>(
  tools: readonly T[],
  browserEnabled: boolean,
): T[] {
  const allowedNames = new Set<string>([
    ...RUDDER_CORE_MCP_TOOL_NAMES,
    ...(browserEnabled ? RUDDER_BROWSER_MCP_TOOL_NAMES : []),
  ]);
  return tools.filter((tool) => allowedNames.has(tool.name));
}

export function isRudderBrowserMcpToolCandidate(name: string): boolean {
  return name.trim().startsWith("rudder_browser_");
}

export function rudderMcpCliCommand(): RudderMcpCliCommand {
  return {
    command: "rudder",
    args: ["mcp-server"],
    provenance: "path",
  };
}

export function rudderBrowserMcpCliCommand(): RudderMcpCliCommand {
  return {
    command: "rudder",
    args: ["mcp-server", "--server", "browser"],
    provenance: "path",
  };
}

export function rudderComputerMcpCliCommand(): RudderMcpCliCommand {
  return {
    command: "rudder",
    args: ["mcp-server", "--server", "computer"],
    provenance: "path",
  };
}

export function pickRudderMcpManagedEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): RudderMcpManagedEnv {
  const managedEnv: RudderMcpManagedEnv = {};
  for (const key of RUDDER_MCP_MANAGED_ENV_KEYS) {
    const value = env[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    managedEnv[key] = trimmed;
  }
  return managedEnv;
}
