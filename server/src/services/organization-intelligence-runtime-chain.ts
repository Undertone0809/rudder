import { normalizeModelFallbacks } from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import { findServerAdapter } from "../agent-runtimes/index.js";
import { unprocessable } from "../errors.js";
import { secretService } from "./secrets.js";

export type RuntimeChainTestTarget = {
  label: string;
  runtimeType: string;
  config: Record<string, unknown>;
};

export function buildRuntimeChainTestTargets(
  agentRuntimeType: string,
  agentRuntimeConfig: Record<string, unknown>,
): RuntimeChainTestTarget[] {
  const primaryConfig = { ...agentRuntimeConfig };
  delete primaryConfig.modelFallbacks;
  const primaryModel = typeof primaryConfig.model === "string" ? primaryConfig.model : null;
  const fallbacks = normalizeModelFallbacks(agentRuntimeConfig.modelFallbacks, {
    agentRuntimeType,
    model: primaryModel,
  });
  return [
    {
      label: "Primary",
      runtimeType: agentRuntimeType,
      config: primaryConfig,
    },
    ...fallbacks.map((fallback, index) => ({
      label: `Fallback ${index + 1}`,
      runtimeType: fallback.agentRuntimeType,
      config: {
        ...(fallback.config ?? {}),
        model: fallback.model,
      },
    })),
  ];
}

export function blockingEnvironmentMessage(result: {
  status?: string;
  checks?: Array<{ level?: string; message?: string }>;
}) {
  if (result.status === "pass") return null;
  const errorCheck = result.checks?.find((check) => check.level === "error");
  return errorCheck?.message ?? `Runtime environment returned ${result.status ?? "unknown"} status.`;
}

export function organizationIntelligenceRuntimeChainService(db: Db, options?: {
  strictSecretsMode?: boolean;
}) {
  const secrets = secretService(db);
  const strictSecretsMode = options?.strictSecretsMode ?? false;

  async function assertUsable(
    orgId: string,
    agentRuntimeType: string,
    agentRuntimeConfig: Record<string, unknown>,
  ) {
    const targets = buildRuntimeChainTestTargets(agentRuntimeType, agentRuntimeConfig);
    for (const target of targets) {
      const adapter = findServerAdapter(target.runtimeType);
      if (!adapter) {
        throw unprocessable(`Unknown adapter type in ${target.label}: ${target.runtimeType}`);
      }
      const normalizedAdapterConfig = await secrets.normalizeAdapterConfigForPersistence(
        orgId,
        target.config,
        { strictMode: strictSecretsMode },
      );
      const { config: runtimeAdapterConfig } = await secrets.resolveAdapterConfigForRuntime(
        orgId,
        normalizedAdapterConfig,
      );
      const result = await adapter.testEnvironment({
        orgId,
        agentRuntimeType: target.runtimeType,
        config: runtimeAdapterConfig,
      });
      const blockingMessage = blockingEnvironmentMessage(result);
      if (blockingMessage) {
        throw unprocessable(`Runtime chain test failed for ${target.label}: ${blockingMessage}`, {
          runtimeType: target.runtimeType,
          result,
        });
      }
    }
  }

  return {
    assertUsable,
  };
}
