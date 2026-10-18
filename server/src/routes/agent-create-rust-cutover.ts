import type { Request, Response } from "express";
import type {
  RustAgentCreateCommand,
  RustAgentCreateIntelligenceDefaults,
} from "../services/agent-create-bridge.js";
import {
  buildRustAgentCreateCommand,
} from "../services/agent-create-bridge.js";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
} from "../services/default-agent-instructions.js";

type RustFoundationResponse = {
  status: number;
  contentType: string;
  body: Buffer;
};

type IntelligenceRuntimeChainTestInput = {
  agentRuntimeType: string;
  agentRuntimeConfig: Record<string, unknown>;
};

type IntelligenceProfilesForCreate = {
  prepareDefaultsFromRuntime(input: {
    orgId: string;
    agentRuntimeType: any;
    agentRuntimeConfig: Record<string, unknown>;
    testRuntimeChain: (input: {
      purpose: string;
      agentRuntimeType: any;
      agentRuntimeConfig: Record<string, unknown>;
    }) => Promise<void>;
  }): Promise<{
    status: "disabled" | "configured" | "invalid";
    lastError: string | null;
    lastVerifiedAt: Date | null;
  } | null>;
  ensureDefaultsFromRuntime(input: {
    orgId: string;
    agentRuntimeType: any;
    agentRuntimeConfig: Record<string, unknown>;
    testRuntimeChain: (input: {
      purpose: string;
      agentRuntimeType: any;
      agentRuntimeConfig: Record<string, unknown>;
    }) => Promise<void>;
  }): Promise<unknown>;
};

type IntelligenceRuntimeChainForCreate = {
  assertUsable(orgId: string, agentRuntimeType: string, agentRuntimeConfig: Record<string, unknown>): Promise<void>;
};

type RustAgentCreateHandlerInput = {
  req: Request;
  res: Response;
  orgId: string;
  createInput: Record<string, any>;
  requestedDesiredSkills: unknown;
  seedOrganizationIntelligenceDefaults?: boolean;
  normalizedAdapterConfig: Record<string, unknown>;
  desiredSkills: string[];
  normalizedAvatarIcon: string | null;
  defaultManagedInstructionsAdapterTypes: Set<string>;
  findFirstAgentId: (orgId: string) => Promise<string | undefined>;
  intelligenceProfiles: IntelligenceProfilesForCreate;
  intelligenceRuntimeChain: IntelligenceRuntimeChainForCreate;
  agentCreate: (actor: unknown, command: RustAgentCreateCommand) => Promise<RustFoundationResponse>;
  redactAgentForResponse: (value: unknown) => unknown;
};

const AGENT_CREATE_RUST_PUBLIC_GATE = "RUDDER_AGENT_CREATE_RUST_PUBLIC_ENABLED";
const AGENT_CREATE_RUST_SUBGATES = [
  ["RUDDER_AGENT_CREATE_RUST_ENABLED", "identity/skills"],
  ["RUDDER_AGENT_CREATE_INSTRUCTIONS_DURABLE_ENABLED", "instructions"],
  ["RUDDER_AGENT_CREATE_RUST_MANAGED_MCP_ENABLED", "managed-mcp"],
  ["RUDDER_AGENT_CREATE_INTELLIGENCE_AVATAR_RUST_ENABLED", "intelligence/avatar"],
] as const;

function envFlagEnabled(name: string) {
  return ["1", "true", "yes"].includes((process.env[name] ?? "").trim().toLowerCase());
}

export function publicRustAgentCreateReadiness(bridgeAvailable: boolean) {
  if (!envFlagEnabled(AGENT_CREATE_RUST_PUBLIC_GATE)) {
    return { enabled: false, ready: false, missing: [] as string[] };
  }
  const missing: string[] = AGENT_CREATE_RUST_SUBGATES
    .filter(([name]) => !envFlagEnabled(name))
    .map(([, label]) => label);
  if (!bridgeAvailable) missing.push("public-listener");
  return { enabled: true, ready: missing.length === 0, missing };
}

export function stripRustNodeOwnedRuntimeKeys(config: Record<string, unknown>): Record<string, unknown> {
  const nodeOwnedKeys = new Set([
    "promptTemplate",
    "bootstrapPromptTemplate",
    "instructionsFilePath",
    "instructionsRootPath",
    "instructionsEntryFile",
    "instructionsBundleMode",
    "agentsMdPath",
    "rudderBrowserEnabled",
    "rudderBrowserCapability",
    "rudderSkillSync",
    "paperclipSkillSync",
    "rudderRuntimeSkills",
    "paperclipRuntimeSkills",
    "workspaceStrategy",
    "workspaceRuntime",
    "cwd",
  ]);
  const output = { ...config };
  for (const key of nodeOwnedKeys) delete output[key];
  if (Array.isArray(output.modelFallbacks)) {
    output.modelFallbacks = output.modelFallbacks.map((fallback) => {
      if (!fallback || typeof fallback !== "object" || Array.isArray(fallback)) return fallback;
      const record = fallback as Record<string, unknown>;
      if (!record.config || typeof record.config !== "object" || Array.isArray(record.config)) return fallback;
      return { ...record, config: stripRustNodeOwnedRuntimeKeys(record.config as Record<string, unknown>) };
    });
  }
  return output;
}

export function containsExplicitInstructionConfig(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((child) => containsExplicitInstructionConfig(child));
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (key === "promptTemplate"
      || key === "bootstrapPromptTemplate"
      || key === "instructionsRootPath"
      || key === "instructionsFilePath"
      || key === "agentsMdPath"
      || key === "instructionsEntryFile"
      || key === "instructionsBundleMode") return true;
    if (containsExplicitInstructionConfig(child)) return true;
  }
  return false;
}

export async function prepareFirstAgentIntelligenceDefaults(
  intelligenceProfiles: IntelligenceProfilesForCreate,
  intelligenceRuntimeChain: IntelligenceRuntimeChainForCreate,
  orgId: string,
  agent: { agentRuntimeType: string; agentRuntimeConfig?: unknown },
  findFirstAgentId: (orgId: string) => Promise<string | undefined>,
): Promise<RustAgentCreateIntelligenceDefaults | undefined> {
  if (await findFirstAgentId(orgId)) return undefined;
  const prepared = await intelligenceProfiles.prepareDefaultsFromRuntime({
    orgId,
    agentRuntimeType: agent.agentRuntimeType,
    agentRuntimeConfig: (agent.agentRuntimeConfig ?? {}) as Record<string, unknown>,
    testRuntimeChain: async ({ agentRuntimeType, agentRuntimeConfig }: IntelligenceRuntimeChainTestInput) => {
      await intelligenceRuntimeChain.assertUsable(orgId, agentRuntimeType, agentRuntimeConfig);
    },
  });
  if (!prepared) return undefined;
  return {
    seed: true,
    status: prepared.status,
    lastError: prepared.lastError,
    lastVerifiedAt: prepared.lastVerifiedAt?.toISOString() ?? null,
  };
}

export async function ensureFirstAgentIntelligenceDefaults(
  intelligenceProfiles: IntelligenceProfilesForCreate,
  intelligenceRuntimeChain: IntelligenceRuntimeChainForCreate,
  orgId: string,
  agent: { id: string; agentRuntimeType: string; agentRuntimeConfig?: unknown },
  findFirstAgentId: (orgId: string) => Promise<string | undefined>,
) {
  const firstAgentId = await findFirstAgentId(orgId);
  if (firstAgentId !== agent.id) return;
  await intelligenceProfiles.ensureDefaultsFromRuntime({
    orgId,
    agentRuntimeType: agent.agentRuntimeType,
    agentRuntimeConfig: (agent.agentRuntimeConfig ?? {}) as Record<string, unknown>,
    testRuntimeChain: async ({ agentRuntimeType, agentRuntimeConfig }: IntelligenceRuntimeChainTestInput) => {
      await intelligenceRuntimeChain.assertUsable(orgId, agentRuntimeType, agentRuntimeConfig);
    },
  });
}

/**
 * Execute the public Rust Agent create branch after the Node preflight has
 * normalized adapter state, resolved skills, and validated the avatar asset.
 * This helper owns the Rust command assembly and response parity so the
 * transport route stays below the architecture ratchet size limit.
 */
export async function handleRustAgentCreate(input: RustAgentCreateHandlerInput): Promise<void> {
  const {
    req,
    res,
    orgId,
    createInput,
    requestedDesiredSkills,
    seedOrganizationIntelligenceDefaults,
    normalizedAdapterConfig,
    desiredSkills,
    normalizedAvatarIcon,
    defaultManagedInstructionsAdapterTypes,
    intelligenceProfiles,
    intelligenceRuntimeChain,
    agentCreate,
    redactAgentForResponse,
  } = input;
  const adapterConfig = (createInput.agentRuntimeConfig ?? {}) as Record<string, unknown>;
  const instructionConfigForCheck = { ...adapterConfig };
  if (defaultManagedInstructionsAdapterTypes.has(createInput.agentRuntimeType)) {
    delete instructionConfigForCheck.promptTemplate;
  }
  if (containsExplicitInstructionConfig(instructionConfigForCheck)) {
    res.status(503).json({
      error: "Rust Agent create cutover cannot atomically prepare explicit instructions paths",
      code: "rust_agent_create_instructions_preparation_unavailable",
    });
    return;
  }

  let instructionsBundle: {
    entryFile: string;
    files: Record<string, string>;
    clearLegacyPromptTemplate: boolean;
  } | undefined;
  if (defaultManagedInstructionsAdapterTypes.has(createInput.agentRuntimeType)) {
    const promptTemplate = typeof adapterConfig.promptTemplate === "string" ? adapterConfig.promptTemplate : "";
    const defaultFiles = await loadDefaultAgentInstructionsBundle(
      resolveDefaultAgentInstructionsBundleRole(createInput.role),
    );
    instructionsBundle = {
      entryFile: "SOUL.md",
      files: promptTemplate.trim().length === 0 ? defaultFiles : { ...defaultFiles, "SOUL.md": promptTemplate },
      clearLegacyPromptTemplate: true,
    };
  }

  let intelligenceDefaults: RustAgentCreateIntelligenceDefaults | undefined;
  if (seedOrganizationIntelligenceDefaults) {
    try {
      intelligenceDefaults = await prepareFirstAgentIntelligenceDefaults(
        intelligenceProfiles,
        intelligenceRuntimeChain,
        orgId,
        {
          agentRuntimeType: createInput.agentRuntimeType,
          agentRuntimeConfig: normalizedAdapterConfig,
        },
        input.findFirstAgentId,
      );
    } catch {
      res.status(503).json({
        error: "Rust Agent create intelligence preflight failed",
        code: "rust_agent_create_intelligence_preflight_failed",
      });
      return;
    }
  }

  const rustAgentRuntimeConfig = stripRustNodeOwnedRuntimeKeys(normalizedAdapterConfig);
  const command = buildRustAgentCreateCommand(orgId, {
    ...(createInput.name !== undefined ? { name: createInput.name } : {}),
    role: createInput.role,
    title: createInput.title,
    capabilities: createInput.capabilities,
    agentRuntimeType: createInput.agentRuntimeType,
    agentRuntimeConfig: rustAgentRuntimeConfig,
    runtimeConfig: (createInput.runtimeConfig ?? {}) as Record<string, unknown>,
    budgetMonthlyCents: createInput.budgetMonthlyCents,
    permissions: {
      canCreateAgents: createInput.permissions?.canCreateAgents ?? true,
      canManageSkills: createInput.permissions?.canManageSkills ?? true,
    },
    metadata: createInput.metadata ?? null,
    desiredSkills: Array.isArray(requestedDesiredSkills) ? desiredSkills : [],
    nodeOwned: {
      normalizedAgentRuntimeConfig: rustAgentRuntimeConfig,
      ...(instructionsBundle ? { instructionsBundle } : {}),
      ...(normalizedAvatarIcon ? { avatarIcon: normalizedAvatarIcon } : {}),
      ...(intelligenceDefaults ? { intelligenceDefaults } : {}),
    },
  });

  let result: RustFoundationResponse;
  try {
    result = await agentCreate(req.actor, command);
  } catch {
    res.status(503).json({
      error: "Rust Agent create bridge is unavailable",
      code: "rust_agent_create_cutover_request_failed",
    });
    return;
  }
  if (result.status === 201) {
    try {
      const value = JSON.parse(result.body.toString("utf8")) as unknown;
      res.status(result.status).json(redactAgentForResponse(value));
      return;
    } catch {
      // Preserve the Rust response if a future contract changes shape.
    }
  }
  res.status(result.status).set("content-type", result.contentType).send(result.body);
}
