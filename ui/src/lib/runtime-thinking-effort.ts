export const CODEX_LOCAL_REASONING_EFFORT_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
] as const;

export function withDefaultThinkingEffortOption<T extends ReadonlyArray<{ value: string; label: string }>>(
  defaultLabel: string,
  options: T,
) {
  return [{ value: "", label: defaultLabel }, ...options] as const;
}
