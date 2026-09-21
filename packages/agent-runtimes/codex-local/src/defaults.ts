/** Shared by creation, environment probes, exec, and app-server chat. */
export const DEFAULT_CODEX_LOCAL_MODEL = "gpt-5.6-luna";
export const DEFAULT_CODEX_LOCAL_REASONING_EFFORT = "medium";

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

/** Fill omitted creation settings without mutating caller-owned configuration. */
export function withCodexLocalModelDefaults(config: Record<string, unknown>): Record<string, unknown> {
  const next = { ...config };
  if (!nonEmptyString(next.model)) next.model = DEFAULT_CODEX_LOCAL_MODEL;
  if (!nonEmptyString(next.modelReasoningEffort) && !nonEmptyString(next.reasoningEffort)) {
    next.modelReasoningEffort = DEFAULT_CODEX_LOCAL_REASONING_EFFORT;
  }
  return next;
}
