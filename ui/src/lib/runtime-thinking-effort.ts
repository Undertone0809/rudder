import {
  CODEX_LOCAL_REASONING_EFFORTS,
  CODEX_LOCAL_REASONING_EFFORTS_BY_MODEL,
} from "@rudderhq/agent-runtime-codex-local";
import { PI_LOCAL_THINKING_LEVELS } from "@rudderhq/agent-runtime-pi-local";

export type RuntimeThinkingEffortOption = {
  value: string;
  label: string;
};

export type RuntimeModelMetadata = {
  variants?: readonly string[];
  capabilities?: {
    reasoning?: boolean;
  };
};

function effortOption(value: string): RuntimeThinkingEffortOption {
  return {
    value,
    label: value === "xhigh"
      ? "Extra High"
      : value.charAt(0).toUpperCase() + value.slice(1),
  };
}

export const CODEX_LOCAL_REASONING_EFFORT_OPTIONS = CODEX_LOCAL_REASONING_EFFORTS.map(effortOption);

export const GPT_5_6_CODEX_LOCAL_REASONING_EFFORT_OPTIONS =
  CODEX_LOCAL_REASONING_EFFORTS_BY_MODEL["gpt-5.6-sol"].map(effortOption);

export const PI_LOCAL_THINKING_EFFORT_OPTIONS = PI_LOCAL_THINKING_LEVELS.map(effortOption);

// Pi's official model registry omits xhigh when a reasoning model has no
// model-specific thinkingLevelMap. xhigh remains a valid CLI level when the
// model explicitly maps it.
const PI_LOCAL_DEFAULT_THINKING_EFFORT_OPTIONS = PI_LOCAL_THINKING_LEVELS
  .filter((level) => level !== "xhigh")
  .map(effortOption);

function normalizedThinkingEffortOptions(
  options: readonly RuntimeThinkingEffortOption[],
): RuntimeThinkingEffortOption[] {
  const seen = new Set<string>();
  return options.flatMap((option) => {
    const value = option.value.trim();
    if (!value || seen.has(value)) return [];
    seen.add(value);
    return [{ value, label: option.label }];
  });
}

function withAutoOption<T extends ReadonlyArray<RuntimeThinkingEffortOption>>(
  options: T,
): RuntimeThinkingEffortOption[] {
  return [{ value: "", label: "Auto" }, ...normalizedThinkingEffortOptions(options)];
}

export function claudeLocalThinkingEffortOptionsForModel(
  model: string,
  metadata?: RuntimeModelMetadata,
) {
  if (metadata?.variants !== undefined) {
    const options = normalizedThinkingEffortOptions(metadata.variants.map(effortOption));
    if (options.length === 0) return [];
    return withAutoOption(options);
  }
  return [];
}

export function openCodeLocalVariantOptionsForModel(
  _model: string,
  metadata?: RuntimeModelMetadata,
) {
  if (!metadata || !Array.isArray(metadata.variants) || metadata.variants.length === 0) return [];
  return withAutoOption(
    normalizedThinkingEffortOptions(metadata.variants.map(effortOption)),
  );
}

export function codexLocalReasoningEffortOptionsForModel(
  model: string,
  metadata?: RuntimeModelMetadata,
) {
  if (metadata?.variants !== undefined) {
    return metadata.variants.map(effortOption);
  }
  if (metadata) return [];
  const configuredLevels = CODEX_LOCAL_REASONING_EFFORTS_BY_MODEL[model.trim().toLowerCase()];
  return configuredLevels ? configuredLevels.map(effortOption) : [];
}

export function piLocalThinkingEffortOptionsForModel(
  _model: string,
  metadata?: RuntimeModelMetadata,
) {
  if (metadata?.capabilities?.reasoning === false) return [];
  if (metadata?.variants !== undefined) {
    const options = normalizedThinkingEffortOptions(metadata.variants.map(effortOption));
    if (options.length === 0) return [];
    return withAutoOption(options);
  }
  // Pi's official registry supports xhigh only when the model supplies an
  // explicit thinkingLevelMap entry for it.
  if (metadata?.capabilities?.reasoning === true) {
    return withAutoOption(PI_LOCAL_DEFAULT_THINKING_EFFORT_OPTIONS);
  }
  return [];
}

export function cursorLocalThinkingEffortOptionsForModel(
  _model: string,
  metadata?: RuntimeModelMetadata,
) {
  if (!metadata) return [];
  if (Array.isArray(metadata.variants)) {
    const options = normalizedThinkingEffortOptions(metadata.variants.map(effortOption));
    if (options.length === 0) return [];
    return withAutoOption(
      options,
    );
  }
  return [];
}

export function withDefaultThinkingEffortOption<T extends ReadonlyArray<{ value: string; label: string }>>(
  defaultLabel: string,
  options: T,
) {
  return [{ value: "", label: defaultLabel }, ...normalizedThinkingEffortOptions(options)] as const;
}
