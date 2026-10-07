import { asRecord } from "./chat-assistant.helpers.js";

const CURSOR_ACP_DIAGNOSTIC_METHODS = new Set([
  "initialize", "authenticate", "session/new", "session/load",
  "session/set_model", "session/set_mode", "session/prompt",
]);
const CURSOR_ACP_DIAGNOSTIC_STATUSES = new Set(["started", "completed", "failed", "timed_out"]);
const CURSOR_ACP_RPC_PARAMETER_TYPES = new Set(["null", "boolean", "number", "string", "array", "object"]);
const CURSOR_ACP_RPC_TRACE_MAX_ENTRIES = 8;
const CURSOR_ACP_RPC_TRACE_MAX_PARAMETERS = 24;
const CURSOR_ACP_RPC_TRACE_MAX_PARAMETER_NAME_LENGTH = 48;
const CURSOR_ACP_RPC_TRACE_MAX_BYTES = 16 * 1024;

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

export function cursorAcpRpcFailureEvidence(result: { errorCode?: string | null; resultJson?: Record<string, unknown> | null }) {
  if (!result.errorCode?.startsWith("cursor_native_") || result.errorCode === "cursor_native_timeout") return null;
  const sourceTrace = result.resultJson?.acpRpcFailureTrace;
  if (!Array.isArray(sourceTrace)) return null;

  const requestTrace: Array<{
    method: string;
    status: string;
    parameterTypes: Record<string, string>;
    jsonRpcCode?: number;
  }> = [];
  let traceBytes = 2;
  let hasRpcFailure = false;
  for (const raw of sourceTrace.slice(-CURSOR_ACP_RPC_TRACE_MAX_ENTRIES)) {
    const entry = asRecord(raw);
    if (!entry || typeof entry.method !== "string" || !CURSOR_ACP_DIAGNOSTIC_METHODS.has(entry.method)
      || typeof entry.status !== "string" || !CURSOR_ACP_DIAGNOSTIC_STATUSES.has(entry.status)) continue;
    const sourceParameters = asRecord(entry.parameterTypes) ?? {};
    const parameterTypes: Record<string, string> = {};
    for (const [name, type] of Object.entries(sourceParameters).slice(0, CURSOR_ACP_RPC_TRACE_MAX_PARAMETERS)) {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || name.length > CURSOR_ACP_RPC_TRACE_MAX_PARAMETER_NAME_LENGTH
        || typeof type !== "string" || !CURSOR_ACP_RPC_PARAMETER_TYPES.has(type)) continue;
      parameterTypes[name] = type;
    }
    const code = entry.jsonRpcCode;
    const hasSafeCode = typeof code === "number" && Number.isSafeInteger(code)
      && code >= -2_147_483_648 && code <= 2_147_483_647;
    const safeEntry = {
      method: entry.method,
      status: entry.status,
      parameterTypes,
      ...(entry.status === "failed" && hasSafeCode ? { jsonRpcCode: code } : {}),
    };
    const entryBytes = Buffer.byteLength(JSON.stringify(safeEntry), "utf8") + (requestTrace.length ? 1 : 0);
    if (traceBytes + entryBytes > CURSOR_ACP_RPC_TRACE_MAX_BYTES) continue;
    requestTrace.push(safeEntry);
    traceBytes += entryBytes;
    if (safeEntry.status === "failed" && safeEntry.jsonRpcCode !== undefined) hasRpcFailure = true;
  }
  return hasRpcFailure ? { requestTrace } : null;
}
