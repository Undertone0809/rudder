export type CachedInputTokenSemantics = "included_in_input" | "additional_to_input";

export const ADDITIONAL_CACHED_INPUT_TOKEN_PROVIDERS = ["anthropic", "claude"] as const;

export interface TokenUsageParts {
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokenSemantics?: CachedInputTokenSemantics | null;
  provider?: string | null;
}

export interface TokenUsageSummary {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  cachedInputTokenSemantics: CachedInputTokenSemantics;
  uncachedInputTokens: number;
  promptTokens: number;
  totalTokens: number;
}

function tokenCount(value: number | null | undefined): number {
  return Math.max(0, Math.floor(typeof value === "number" && Number.isFinite(value) ? value : 0));
}

export function cachedInputTokenSemanticsForProvider(
  provider: string | null | undefined,
): CachedInputTokenSemantics {
  const normalized = provider?.trim().toLowerCase();
  if (normalized && ADDITIONAL_CACHED_INPUT_TOKEN_PROVIDERS.some((value) => (
    normalized === value || normalized.startsWith(`${value}:`) || normalized.startsWith(`${value}/`)
  ))) {
    return "additional_to_input";
  }
  return "included_in_input";
}

export function summarizeTokenUsage(parts: TokenUsageParts): TokenUsageSummary {
  const inputTokens = tokenCount(parts.inputTokens);
  const cachedInputTokens = tokenCount(parts.cachedInputTokens);
  const outputTokens = tokenCount(parts.outputTokens);
  const cacheSemantics =
    parts.cachedInputTokenSemantics ?? cachedInputTokenSemanticsForProvider(parts.provider);
  const cachedIsInputSubset = cacheSemantics === "included_in_input";
  const uncachedInputTokens = cachedIsInputSubset
    ? Math.max(0, inputTokens - cachedInputTokens)
    : inputTokens;
  const promptTokens = cachedIsInputSubset
    ? inputTokens
    : inputTokens + cachedInputTokens;

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    cachedInputTokenSemantics: cacheSemantics,
    uncachedInputTokens,
    promptTokens,
    totalTokens: promptTokens + outputTokens,
  };
}

export function tokenUsageCacheRatio(parts: TokenUsageParts): number | null {
  const summary = summarizeTokenUsage(parts);
  if (summary.promptTokens <= 0) return null;
  return summary.cachedInputTokens / summary.promptTokens;
}

export function hasTokenUsage(parts: TokenUsageParts): boolean {
  const summary = summarizeTokenUsage(parts);
  return summary.totalTokens > 0 || summary.cachedInputTokens > 0;
}
