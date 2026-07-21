const FAILED_RUN_USER_SUMMARY =
  "The run hit a system-level execution problem. Rudder saved the technical details for diagnostics.";

export function failedRunUserSummary(run: { resultJson?: Record<string, unknown> | null }): string {
  const value = run.resultJson?.userMessage;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : FAILED_RUN_USER_SUMMARY;
}
