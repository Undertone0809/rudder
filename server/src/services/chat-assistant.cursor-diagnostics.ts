import { asRecord } from "./chat-assistant.helpers.js";

const CURSOR_ACP_DIAGNOSTIC_METHODS = new Set([
  "initialize", "authenticate", "session/new", "session/load",
  "session/set_model", "session/set_mode", "session/prompt",
]);
const CURSOR_ACP_DIAGNOSTIC_STATUSES = new Set(["started", "completed", "failed", "timed_out"]);

export function cursorAcpTimeoutEvidence(result: { errorCode?: string | null; resultJson?: Record<string, unknown> | null }) {
  if (result.errorCode !== "cursor_native_timeout") return null;
  const timeout = asRecord(result.resultJson?.acpTimeout);
  if (!timeout || typeof timeout.method !== "string" || !CURSOR_ACP_DIAGNOSTIC_METHODS.has(timeout.method)) return null;
  const duration = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 86_400_000 ? value : null;
  const timeoutMs = duration(timeout.timeoutMs);
  const durationMs = duration(timeout.durationMs);
  if (timeoutMs === null || durationMs === null) return null;
  const requestTrace = Array.isArray(result.resultJson?.acpRequestTrace)
    ? result.resultJson.acpRequestTrace.slice(0, 16).flatMap((raw) => {
      const entry = asRecord(raw);
      if (!entry || typeof entry.method !== "string" || !CURSOR_ACP_DIAGNOSTIC_METHODS.has(entry.method)
        || typeof entry.status !== "string" || !CURSOR_ACP_DIAGNOSTIC_STATUSES.has(entry.status)) return [];
      const elapsed = duration(entry.durationMs);
      return elapsed === null ? [] : [{ method: entry.method, status: entry.status, durationMs: elapsed }];
    })
    : [];
  return { errorCode: "cursor_native_timeout", method: timeout.method, timeoutMs, durationMs, requestTrace };
}
