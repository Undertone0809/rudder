import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Db } from "@rudderhq/db";
import type {
  AgentRuntimeExecutionResult,
  AgentRuntimeInvocationMeta,
  ServerAgentRuntimeModule,
} from "@rudderhq/agent-runtime-utils";
import type { OrganizationIntelligenceProfile, OrganizationIntelligenceProfilePurpose } from "@rudderhq/shared";
import { unprocessable } from "../errors.js";
import { findServerAdapter } from "../agent-runtimes/registry.js";
import { executeAdapterWithModelFallbacks } from "./runtime-kernel/model-fallback.js";
import {
  organizationIntelligenceProfileService,
  sanitizeConfigForProductIntelligence,
} from "./organization-intelligence-profiles.js";
import { secretService } from "./secrets.js";

export interface ProductIntelligenceExecuteInput {
  orgId: string;
  purpose: OrganizationIntelligenceProfilePurpose;
  feature: string;
  prompt: string;
  context?: Record<string, unknown>;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onMeta?: (meta: AgentRuntimeInvocationMeta) => Promise<void>;
  abortSignal?: AbortSignal;
}

interface ExecuteResolvedProductIntelligenceInput extends ProductIntelligenceExecuteInput {
  profile: OrganizationIntelligenceProfile;
  config: Record<string, unknown>;
  secretKeys?: Set<string>;
  adapter: ServerAgentRuntimeModule;
  resolveAdapter?: (agentRuntimeType: string) => ServerAgentRuntimeModule | null;
  runId?: string;
  workspaceCwd?: string;
}

function intelligenceLabel(purpose: OrganizationIntelligenceProfilePurpose) {
  return purpose === "lightweight" ? "Fast" : "Smart";
}

function defaultProductIntelligenceCwd() {
  return path.join(os.tmpdir(), "rudder-product-intelligence");
}

function redactRuntimeMeta(meta: AgentRuntimeInvocationMeta, secretKeys: Set<string>): AgentRuntimeInvocationMeta {
  if (!meta.env || secretKeys.size === 0) return meta;
  const env = { ...meta.env };
  for (const key of secretKeys) {
    if (key in env) env[key] = "***REDACTED***";
  }
  return {
    ...meta,
    env,
  };
}

export async function executeResolvedProductIntelligenceProfile(
  input: ExecuteResolvedProductIntelligenceInput,
): Promise<AgentRuntimeExecutionResult> {
  const runId = input.runId ?? `product-intelligence-${randomUUID()}`;
  const secretKeys = input.secretKeys ?? new Set<string>();
  const config = {
    ...sanitizeConfigForProductIntelligence(input.config),
    promptTemplate: input.prompt,
  };
  const workspaceCwd = input.workspaceCwd ?? defaultProductIntelligenceCwd();
  const label = intelligenceLabel(input.purpose);

  return executeAdapterWithModelFallbacks(input.adapter, {
    runId,
    agent: {
      id: `product-intelligence-${input.purpose}`,
      orgId: input.orgId,
      name: `${label} Intelligence`,
      agentRuntimeType: input.profile.agentRuntimeType,
      agentRuntimeConfig: config,
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {
      ...(input.context ?? {}),
      rudderScene: "product_intelligence",
      productIntelligence: {
        purpose: input.purpose,
        feature: input.feature,
      },
      rudderWorkspace: {
        source: "product_intelligence",
        strategy: "none",
        cwd: workspaceCwd,
      },
    },
    onLog: input.onLog ?? (async () => {}),
    onMeta: input.onMeta
      ? async (meta) => input.onMeta?.(redactRuntimeMeta(meta, secretKeys))
      : undefined,
    abortSignal: input.abortSignal,
  }, {
    resolveAdapter: input.resolveAdapter,
  });
}

export function productIntelligenceService(db: Db) {
  const profiles = organizationIntelligenceProfileService(db);
  const secrets = secretService(db);

  async function execute(input: ProductIntelligenceExecuteInput): Promise<AgentRuntimeExecutionResult> {
    const profile = await profiles.getByPurpose(input.orgId, input.purpose);
    const label = intelligenceLabel(input.purpose);
    if (!profile) {
      throw unprocessable(`${label} Intelligence is not configured`);
    }
    if (profile.status === "disabled") {
      throw unprocessable(`${label} Intelligence is disabled`);
    }
    if (profile.status !== "configured") {
      throw unprocessable(`${label} Intelligence is invalid`);
    }

    const adapter = findServerAdapter(profile.agentRuntimeType);
    if (!adapter) {
      throw unprocessable(`${label} Intelligence provider is not available`);
    }

    const { config, secretKeys } = await secrets.resolveAdapterConfigForRuntime(
      input.orgId,
      profile.agentRuntimeConfig,
    );

    return executeResolvedProductIntelligenceProfile({
      ...input,
      profile,
      config,
      secretKeys,
      adapter,
      resolveAdapter: findServerAdapter,
    });
  }

  return {
    execute,
  };
}
