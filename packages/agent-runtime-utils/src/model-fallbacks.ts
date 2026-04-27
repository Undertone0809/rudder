import type { AgentRuntimeExecutionResult } from "./types.js";

export const MAX_MODEL_FALLBACKS = 2;

export interface ModelAttemptSpec {
  index: number;
  model: string | null;
  isFallback: boolean;
  fallbackIndex: number | null;
  totalFallbacks: number;
}

function readModel(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function normalizeModelFallbacks(
  rawFallbacks: unknown,
  primaryModel?: unknown,
): string[] {
  if (!Array.isArray(rawFallbacks)) return [];

  const normalized: string[] = [];
  const seen = new Set<string>();
  const primary = readModel(primaryModel);
  if (primary) seen.add(primary);

  for (const rawFallback of rawFallbacks) {
    const model = readModel(rawFallback);
    if (!model || seen.has(model)) continue;
    seen.add(model);
    normalized.push(model);
    if (normalized.length >= MAX_MODEL_FALLBACKS) break;
  }

  return normalized;
}

export function buildModelAttemptSpecs(
  config: Record<string, unknown>,
): ModelAttemptSpec[] {
  const primaryModel = readModel(config.model);
  const fallbackModels = normalizeModelFallbacks(config.modelFallbacks, primaryModel);

  return [
    {
      index: 0,
      model: primaryModel,
      isFallback: false,
      fallbackIndex: null,
      totalFallbacks: fallbackModels.length,
    },
    ...fallbackModels.map((model, index) => ({
      index: index + 1,
      model,
      isFallback: true,
      fallbackIndex: index + 1,
      totalFallbacks: fallbackModels.length,
    })),
  ];
}

export function isSuccessfulRuntimeResult(result: AgentRuntimeExecutionResult): boolean {
  return !result.timedOut && (result.exitCode ?? 0) === 0 && !result.errorMessage;
}
