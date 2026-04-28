import type { AgentRuntimeExecutionResult, ModelFallbackConfig } from "./types.js";

export interface ModelAttemptSpec {
  index: number;
  agentRuntimeType: string | null;
  model: string | null;
  config: Record<string, unknown> | null;
  isFallback: boolean;
  fallbackIndex: number | null;
  totalFallbacks: number;
}

function readModel(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sameRuntimeModel(left: { agentRuntimeType: string | null; model: string | null }, right: { agentRuntimeType: string | null; model: string | null }) {
  return left.agentRuntimeType === right.agentRuntimeType && left.model === right.model;
}

export function normalizeModelFallbacks(
  rawFallbacks: unknown,
  primary?: { agentRuntimeType?: unknown; model?: unknown } | unknown,
): ModelFallbackConfig[] {
  if (!Array.isArray(rawFallbacks)) return [];

  const primaryRecord = readRecord(primary);
  const primarySpec = {
    agentRuntimeType: readModel(primaryRecord?.agentRuntimeType),
    model: readModel(primaryRecord?.model ?? primary),
  };
  const normalized: ModelFallbackConfig[] = [];
  const seen = new Set<string>();
  if (primarySpec.agentRuntimeType && primarySpec.model) {
    seen.add(`${primarySpec.agentRuntimeType}\u0000${primarySpec.model}`);
  }

  for (const rawFallback of rawFallbacks) {
    const record = readRecord(rawFallback);
    const agentRuntimeType = record
      ? readModel(record.agentRuntimeType) ?? primarySpec.agentRuntimeType
      : primarySpec.agentRuntimeType;
    const model = record ? readModel(record.model) : readModel(rawFallback);
    if (!agentRuntimeType || !model) continue;

    const key = `${agentRuntimeType}\u0000${model}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const nestedConfig = readRecord(record?.config);
    const cleanedNestedConfig = nestedConfig
      ? Object.fromEntries(
          Object.entries(nestedConfig).filter(([key]) => !["agentRuntimeType", "model", "modelFallbacks", "config"].includes(key)),
        )
      : {};
    const topLevelConfig = record
      ? Object.fromEntries(
          Object.entries(record).filter(([key]) => !["agentRuntimeType", "model", "modelFallbacks", "config"].includes(key)),
        )
      : {};
    const config = {
      ...topLevelConfig,
      ...cleanedNestedConfig,
    };
    normalized.push({
      agentRuntimeType,
      model,
      ...(Object.keys(config).length > 0 ? { config } : {}),
    });
  }

  return normalized;
}

export function buildModelAttemptSpecs(
  config: Record<string, unknown>,
  primaryAgentRuntimeType?: string | null,
): ModelAttemptSpec[] {
  const primaryModel = readModel(config.model);
  const primary = {
    agentRuntimeType: readModel(primaryAgentRuntimeType),
    model: primaryModel,
  };
  const fallbackModels = normalizeModelFallbacks(config.modelFallbacks, primary)
    .filter((fallback) => !sameRuntimeModel(fallback, primary));

  return [
    {
      index: 0,
      agentRuntimeType: primary.agentRuntimeType,
      model: primaryModel,
      config,
      isFallback: false,
      fallbackIndex: null,
      totalFallbacks: fallbackModels.length,
    },
    ...fallbackModels.map((fallback, index) => ({
      index: index + 1,
      agentRuntimeType: fallback.agentRuntimeType,
      model: fallback.model,
      config: fallback.config ?? null,
      isFallback: true,
      fallbackIndex: index + 1,
      totalFallbacks: fallbackModels.length,
    })),
  ];
}

export function isSuccessfulRuntimeResult(result: AgentRuntimeExecutionResult): boolean {
  return !result.timedOut && (result.exitCode ?? 0) === 0 && !result.errorMessage;
}
