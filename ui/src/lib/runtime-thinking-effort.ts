import { GPT_5_6_CODEX_LOCAL_MODEL_IDS } from "@rudderhq/agent-runtime-codex-local";

export const CODEX_LOCAL_REASONING_EFFORT_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
] as const;

export const GPT_5_6_CODEX_LOCAL_REASONING_EFFORT_OPTIONS = [
  { value: "light", label: "Light" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
  { value: "max", label: "Max" },
  { value: "ultra", label: "Ultra" },
] as const;

const GPT_5_6_CODEX_LOCAL_MODEL_ID_SET = new Set<string>(GPT_5_6_CODEX_LOCAL_MODEL_IDS);

export function codexLocalReasoningEffortOptionsForModel(model: string) {
  return GPT_5_6_CODEX_LOCAL_MODEL_ID_SET.has(model.trim().toLowerCase())
    ? GPT_5_6_CODEX_LOCAL_REASONING_EFFORT_OPTIONS
    : CODEX_LOCAL_REASONING_EFFORT_OPTIONS;
}

export function withDefaultThinkingEffortOption<T extends ReadonlyArray<{ value: string; label: string }>>(
  defaultLabel: string,
  options: T,
) {
  return [{ value: "", label: defaultLabel }, ...options] as const;
}
