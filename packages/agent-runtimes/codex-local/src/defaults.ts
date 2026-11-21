/** Fallbacks for stored configurations that predate explicit model settings. */
export const DEFAULT_CODEX_LOCAL_MODEL = "gpt-5.6-luna";
export const DEFAULT_CODEX_LOCAL_REASONING_EFFORT = "medium";
export const NEW_AGENT_CODEX_LOCAL_MODEL = "gpt-6.2-sol";
export const NEW_AGENT_CODEX_LOCAL_REASONING_EFFORT = "high";

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

export function resolveCodexLocalModel(config: Record<string, unknown>): string {
  return nonEmptyString(config.model) ?? DEFAULT_CODEX_LOCAL_MODEL;
}

export function resolveCodexLocalReasoningEffort(config: Record<string, unknown>): string {
  return nonEmptyString(config.modelReasoningEffort)
    ?? nonEmptyString(config.reasoningEffort)
    ?? DEFAULT_CODEX_LOCAL_REASONING_EFFORT;
}

/** Fill omitted settings without mutating caller-owned configuration. */
export function withCodexLocalModelDefaults(
  config: Record<string, unknown>,
  mode: "create" | "update" = "create",
): Record<string, unknown> {
  const next = { ...config };
  const configuredModel = nonEmptyString(next.model);
  const model = configuredModel
    ?? (mode === "create" ? NEW_AGENT_CODEX_LOCAL_MODEL : DEFAULT_CODEX_LOCAL_MODEL);
  if (!configuredModel) next.model = model;
  if (!nonEmptyString(next.modelReasoningEffort) && !nonEmptyString(next.reasoningEffort)) {
    next.modelReasoningEffort = mode === "create" && model === NEW_AGENT_CODEX_LOCAL_MODEL
      ? NEW_AGENT_CODEX_LOCAL_REASONING_EFFORT
      : DEFAULT_CODEX_LOCAL_REASONING_EFFORT;
  }
  return next;
}
