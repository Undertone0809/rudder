import type { UsageSummary } from "@rudderhq/agent-runtime-utils";

export type CodexTokenPrice = {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
};

// Static API-equivalent pricing used only when a subscription-authenticated
// Codex run opts into cost estimation. Source: Vibe Usage model prices,
// checked 2026-06-18. When cache-read pricing is unpublished, use input price.
const OPENAI_CODEX_MODEL_PRICES = {
  "codex-mini-latest": { inputUsdPerMillion: 1.5, cachedInputUsdPerMillion: 0.375, outputUsdPerMillion: 6 },
  "gpt-3.5-turbo": { inputUsdPerMillion: 0.5, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 1.5 },
  "gpt-4": { inputUsdPerMillion: 30, cachedInputUsdPerMillion: 30, outputUsdPerMillion: 60 },
  "gpt-4-turbo": { inputUsdPerMillion: 10, cachedInputUsdPerMillion: 10, outputUsdPerMillion: 30 },
  "gpt-4.1": { inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 8 },
  "gpt-4.1-mini": { inputUsdPerMillion: 0.4, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 1.6 },
  "gpt-4.1-nano": { inputUsdPerMillion: 0.1, cachedInputUsdPerMillion: 0.025, outputUsdPerMillion: 0.4 },
  "gpt-4o": { inputUsdPerMillion: 2.5, cachedInputUsdPerMillion: 1.25, outputUsdPerMillion: 10 },
  "gpt-4o-mini": { inputUsdPerMillion: 0.15, cachedInputUsdPerMillion: 0.075, outputUsdPerMillion: 0.6 },
  "gpt-5": { inputUsdPerMillion: 1.25, cachedInputUsdPerMillion: 0.125, outputUsdPerMillion: 10 },
  "gpt-5-codex": { inputUsdPerMillion: 1.25, cachedInputUsdPerMillion: 0.125, outputUsdPerMillion: 10 },
  "gpt-5-mini": { inputUsdPerMillion: 0.25, cachedInputUsdPerMillion: 0.025, outputUsdPerMillion: 2 },
  "gpt-5-nano": { inputUsdPerMillion: 0.05, cachedInputUsdPerMillion: 0.005, outputUsdPerMillion: 0.4 },
  "gpt-5.1": { inputUsdPerMillion: 1.25, cachedInputUsdPerMillion: 0.125, outputUsdPerMillion: 10 },
  "gpt-5.1-codex": { inputUsdPerMillion: 1.25, cachedInputUsdPerMillion: 0.125, outputUsdPerMillion: 10 },
  "gpt-5.1-codex-max": { inputUsdPerMillion: 1.25, cachedInputUsdPerMillion: 0.125, outputUsdPerMillion: 10 },
  "gpt-5.1-codex-mini": { inputUsdPerMillion: 0.25, cachedInputUsdPerMillion: 0.025, outputUsdPerMillion: 2 },
  "gpt-5.2": { inputUsdPerMillion: 1.75, cachedInputUsdPerMillion: 0.175, outputUsdPerMillion: 14 },
  "gpt-5.2-codex": { inputUsdPerMillion: 1.75, cachedInputUsdPerMillion: 0.175, outputUsdPerMillion: 14 },
  "gpt-5.3-codex": { inputUsdPerMillion: 1.75, cachedInputUsdPerMillion: 0.175, outputUsdPerMillion: 14 },
  "gpt-5.3-codex-spark": { inputUsdPerMillion: 1.75, cachedInputUsdPerMillion: 0.175, outputUsdPerMillion: 14 },
  "gpt-5.4": { inputUsdPerMillion: 2.5, cachedInputUsdPerMillion: 0.25, outputUsdPerMillion: 15 },
  "gpt-5.4-codex": { inputUsdPerMillion: 2.5, cachedInputUsdPerMillion: 0.25, outputUsdPerMillion: 15 },
  "gpt-5.4-mini": { inputUsdPerMillion: 0.75, cachedInputUsdPerMillion: 0.075, outputUsdPerMillion: 4.5 },
  "gpt-5.4-nano": { inputUsdPerMillion: 0.2, cachedInputUsdPerMillion: 0.02, outputUsdPerMillion: 1.25 },
  "gpt-5.4-pro": { inputUsdPerMillion: 30, cachedInputUsdPerMillion: 30, outputUsdPerMillion: 180 },
  "gpt-5.5": { inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 30 },
  "gpt-5.5-codex": { inputUsdPerMillion: 2.5, cachedInputUsdPerMillion: 0.25, outputUsdPerMillion: 15 },
  "gpt-5.5-fast": { inputUsdPerMillion: 12.5, cachedInputUsdPerMillion: 1.25, outputUsdPerMillion: 75 },
  "gpt-5.5-flex": { inputUsdPerMillion: 2.5, cachedInputUsdPerMillion: 0.25, outputUsdPerMillion: 15 },
  "gpt-5.5-pro": { inputUsdPerMillion: 30, cachedInputUsdPerMillion: 30, outputUsdPerMillion: 180 },
  o1: { inputUsdPerMillion: 15, cachedInputUsdPerMillion: 7.5, outputUsdPerMillion: 60 },
  "o1-mini": { inputUsdPerMillion: 1.1, cachedInputUsdPerMillion: 0.55, outputUsdPerMillion: 4.4 },
  "o1-preview": { inputUsdPerMillion: 15, cachedInputUsdPerMillion: 7.5, outputUsdPerMillion: 60 },
  o3: { inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 8 },
  "o3-mini": { inputUsdPerMillion: 1.1, cachedInputUsdPerMillion: 0.55, outputUsdPerMillion: 4.4 },
  "o3-pro": { inputUsdPerMillion: 20, cachedInputUsdPerMillion: 20, outputUsdPerMillion: 80 },
  "o4-mini": { inputUsdPerMillion: 1.1, cachedInputUsdPerMillion: 0.275, outputUsdPerMillion: 4.4 },
} satisfies Record<string, CodexTokenPrice>;

function normalizeModelId(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^openai\//, "");
}

function tokenCount(value: number | null | undefined): number {
  return Math.max(0, Math.floor(typeof value === "number" && Number.isFinite(value) ? value : 0));
}

export function resolveCodexTokenPrice(model: string): CodexTokenPrice | null {
  const normalized = normalizeModelId(model);
  if (!normalized) return null;
  return OPENAI_CODEX_MODEL_PRICES[normalized as keyof typeof OPENAI_CODEX_MODEL_PRICES] ?? null;
}

export function estimateCodexCostUsd(model: string, usage: UsageSummary | null | undefined): number | null {
  const price = resolveCodexTokenPrice(model);
  if (!price || !usage) return null;

  const inputTokens = tokenCount(usage.inputTokens);
  const cachedInputTokens = Math.min(inputTokens, tokenCount(usage.cachedInputTokens));
  const outputTokens = tokenCount(usage.outputTokens);
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const costUsd =
    (uncachedInputTokens * price.inputUsdPerMillion
      + cachedInputTokens * price.cachedInputUsdPerMillion
      + outputTokens * price.outputUsdPerMillion)
    / 1_000_000;

  return costUsd > 0 ? costUsd : null;
}
