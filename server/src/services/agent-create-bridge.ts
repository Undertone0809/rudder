import { hostname } from "node:os";
import { resolveOrganizationWorkspaceHomeDir, resolvePreviousDocumentsOrganizationWorkspaceRoot, resolveRudderInstanceRoot } from "../home-paths.js";

/**
 * Typed private boundary for public Agent create preparation.
 *
 * The public route may only pass fields assembled by the Node preflight. The
 * explicit builder keeps client pseudo-fields and future bridge additions out
 * of the Rust command unless this contract is updated deliberately.
 */
export type RustAgentCreateInstructionsBundle = {
  entryFile: string;
  files: Record<string, string>;
  clearLegacyPromptTemplate?: boolean;
};

export type RustAgentCreateIntelligenceDefaults = {
  seed?: boolean;
  status?: "disabled" | "configured" | "invalid";
  lastError?: string | null;
  lastVerifiedAt?: string | null;
};

export type RustAgentCreateNodeOwned = {
  normalizedAgentRuntimeConfig: Record<string, unknown>;
  instructionsBundle?: RustAgentCreateInstructionsBundle;
  avatarIcon?: string;
  intelligenceDefaults?: RustAgentCreateIntelligenceDefaults;
};

export type RustAgentCreateInput = {
  name?: string;
  role: string;
  title?: string | null;
  capabilities?: string | null;
  agentRuntimeType: string;
  agentRuntimeConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  budgetMonthlyCents: number;
  permissions: {
    canCreateAgents: boolean;
    canManageSkills: boolean;
  };
  metadata?: Record<string, unknown> | null;
  desiredSkills?: string[];
  nodeOwned?: RustAgentCreateNodeOwned;
};

export type RustAgentCreateCommand = {
  operation: "create";
  orgId: string;
  input: RustAgentCreateInput;
};

/** Collect trusted local installation facts; Rust validates and applies them. */
export function resolveRustAgentInstructionsHost(orgId: string) {
  return {
    instanceRoot: resolveRudderInstanceRoot(),
    workspaceHome: resolveOrganizationWorkspaceHomeDir(),
    previousDocumentsRoot: resolvePreviousDocumentsOrganizationWorkspaceRoot(orgId),
    friendlyWorkspaceHome: Boolean(process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME?.trim()) || !process.env.RUDDER_HOME?.trim(),
    hostname: hostname(),
  };
}

/** Build a private AgentCore command from server-owned preparation facts. */
export function buildRustAgentCreateCommand(
  orgId: string,
  input: RustAgentCreateInput,
): RustAgentCreateCommand {
  const output: RustAgentCreateInput = {
    role: input.role,
    agentRuntimeType: input.agentRuntimeType,
    agentRuntimeConfig: input.agentRuntimeConfig,
    runtimeConfig: input.runtimeConfig,
    budgetMonthlyCents: input.budgetMonthlyCents,
    permissions: {
      canCreateAgents: input.permissions.canCreateAgents,
      canManageSkills: input.permissions.canManageSkills,
    },
  };
  if (input.name !== undefined) output.name = input.name;
  if (input.title !== undefined) output.title = input.title;
  if (input.capabilities !== undefined) output.capabilities = input.capabilities;
  if (input.metadata !== undefined) output.metadata = input.metadata;
  if (input.desiredSkills !== undefined) output.desiredSkills = [...input.desiredSkills];
  if (input.nodeOwned !== undefined) {
    output.nodeOwned = {
      normalizedAgentRuntimeConfig: input.nodeOwned.normalizedAgentRuntimeConfig,
      ...(input.nodeOwned.instructionsBundle
        ? { instructionsBundle: {
          entryFile: input.nodeOwned.instructionsBundle.entryFile,
          files: { ...input.nodeOwned.instructionsBundle.files },
          ...(input.nodeOwned.instructionsBundle.clearLegacyPromptTemplate !== undefined
            ? { clearLegacyPromptTemplate: input.nodeOwned.instructionsBundle.clearLegacyPromptTemplate }
            : {}),
        } }
        : {}),
      ...(input.nodeOwned.avatarIcon !== undefined ? { avatarIcon: input.nodeOwned.avatarIcon } : {}),
      ...(input.nodeOwned.intelligenceDefaults
        ? { intelligenceDefaults: { ...input.nodeOwned.intelligenceDefaults } }
        : {}),
    };
  }
  return { operation: "create", orgId, input: output };
}
