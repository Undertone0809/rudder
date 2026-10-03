import type {
  AgentRuntimeApprovalDecision,
  AgentRuntimeApprovalRequest,
  AgentRuntimeControlAttemptLease,
  AgentRuntimeControlInterruptReason,
  AgentRuntimeControlInterruptResult,
  AgentRuntimeControlSteerInput,
  AgentRuntimeControlSteerResult,
  AgentRuntimeExecutionResult,
} from "@rudderhq/agent-runtime-utils";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  readHermesProductHistory,
  readHermesProductHistoryExecutionSpan,
  type HermesProductHistoryProfile,
  type HermesProductHistoryResult,
} from "./product-history.js";

export const HERMES_ACP_NATIVE_TRANSPORT = "hermes-acp-stdio";
const DEFAULT_PROTOCOL_VERSION = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;
const CLOSE_TIMEOUT_MS = 1_500;
const SIGKILL_CLOSE_TIMEOUT_MS = 1_500;
const MAX_UPDATE_COUNT = 512;
const MAX_UPDATE_TEXT = 512 * 1024;
const MAX_DIAGNOSTIC = 2_000;
const MAX_RPC_LINE_BYTES = 8 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;
type RpcId = number;

export type HermesNativeProcessDiagnostics = {
  processExited: boolean;
  exitCode: number | null;
  signal: string | null;
  closeAcknowledged: boolean;
  stderr: string;
  spawnError?: string;
};

export class HermesNativeProcessCloseError extends Error {
  override readonly name = "HermesNativeProcessCloseError";
  readonly closeAcknowledged = false;

  constructor(readonly diagnostics: HermesNativeProcessDiagnostics) {
    const exit = diagnostics.exitCode !== null
      ? `exit=${diagnostics.exitCode}`
      : diagnostics.signal
        ? `signal=${diagnostics.signal}`
        : diagnostics.spawnError
          ? `spawn=${diagnostics.spawnError}`
          : "exit=unknown";
    super(`Hermes ACP process close was not acknowledged after SIGKILL (${exit})${diagnostics.stderr ? `; stderr: ${diagnostics.stderr}` : ""}.`);
  }
}

export function isHermesNativeProcessCloseError(error: unknown): error is HermesNativeProcessCloseError {
  return error instanceof HermesNativeProcessCloseError;
}
type HermesAcpApprovalRequest = AgentRuntimeApprovalRequest;
type HermesAcpApprovalDecision = AgentRuntimeApprovalDecision;

export type HermesAcpBinding = {
  id?: string | null;
  orgId?: string | null;
  hostId: string;
  profileId: string;
  workspaceBindingId?: string | null;
  capabilityRevision?: string | null;
};

export type HermesAcpProfile = {
  binding: HermesAcpBinding;
  command: string;
  args: readonly string[];
  cwd: string;
  env?: Record<string, string>;
  /** Host-authorized read-only history profile; never inferred from ACP session state. */
  hermesPythonCommand?: string | null;
  hermesSourcePath?: string | null;
  hermesHome?: string | null;
  providerVersion?: string | null;
  protocolVersion?: number | null;
  authMethodId?: string | null;
  mcpServers?: readonly JsonRecord[];
};

export type HermesAcpWorkspace = {
  workspaceId?: string | null;
  repoUrl?: string | null;
  repoRef?: string | null;
  workspaceBindingId?: string | null;
};

export type HermesAcpSession = {
  sessionId: string;
  sessionParams: Record<string, unknown>;
  sessionDisplayId: string;
};

export type HermesAcpTranscriptRequest = {
  runtimeType: string;
  profile: HermesAcpProfile;
  session: HermesAcpSession;
  boundary?: string | null;
  binding?: HermesAcpBinding | null;
  workspace?: HermesAcpWorkspace | null;
  selector?: Record<string, unknown> | null;
  range?: { start?: string | number | null; end?: string | number | null; itemId?: string | null } | null;
  from?: string | number | null;
  through?: string | number | null;
  cursor?: string | null;
  signal?: AbortSignal;
};

export type HermesAcpTranscriptItem = {
  id: string;
  sourceEntryId: string;
  ordinal: number;
  kind: string;
  ts: string;
  payload: JsonRecord;
  origin: "native";
  visibility: "visible";
  text?: string;
};

export type HermesAcpTranscriptResult = {
  items: readonly HermesAcpTranscriptItem[];
  nextCursor: string | null;
  source: "native";
  revision: string;
  availability: "available" | "offline" | "missing" | "expired" | "incompatible";
  completeness: "complete" | "partial" | "terminal_only" | "unknown";
};

export type HermesAcpTranscriptBoundary = {
  status: "exact" | "unknown";
  sessionId: string;
  startExclusive: number | null;
  endInclusive: number | null;
  sourceRangeRef: string | null;
  reason?: string;
};

export type HermesAcpForkRequest = {
  runtimeType: string;
  session: HermesAcpSession;
  boundary: string;
  binding?: HermesAcpBinding | null;
  workspace?: HermesAcpWorkspace | null;
  signal?: AbortSignal;
};

export type HermesAcpForkResult = {
  session: HermesAcpSession;
  boundary: string;
  sourceBoundary: string;
  identityMap: Record<string, string>;
  continuity: "native";
};

export class HermesAcpNativeCapabilityError extends Error {
  override readonly name = "HermesAcpNativeCapabilityError";

  constructor(
    readonly status: "unsupported" | "unknown",
    message: string,
    readonly details: {
      sessionId?: string | null;
      sessionParams?: Record<string, unknown> | null;
      inputCorrelationId?: string | null;
      transcriptBoundary?: HermesAcpTranscriptBoundary | null;
    } = {},
  ) {
    super(message);
  }
}

type HermesHistoryTail = {
  availability: HermesProductHistoryResult["availability"];
  tailRowId: number | null;
  relation: HermesProductHistoryResult["metadata"]["lineage"]["relation"];
  successorSessionId: string | null;
};

function hermesHistoryProfile(profile: HermesAcpProfile): HermesProductHistoryProfile | null {
  const pythonCommand = nonEmpty(profile.hermesPythonCommand);
  const sourcePath = nonEmpty(profile.hermesSourcePath);
  const hermesHome = nonEmpty(profile.hermesHome);
  if (!pythonCommand || !sourcePath || !hermesHome) return null;
  return {
    pythonCommand,
    sourcePath,
    hermesHome,
    providerVersion: profile.providerVersion ?? null,
    hostId: profile.binding.hostId,
    profileId: profile.binding.profileId,
  };
}

async function readHermesHistoryTail(input: {
  profile: HermesAcpProfile;
  sessionId: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<HermesHistoryTail | null> {
  const profile = hermesHistoryProfile(input.profile);
  if (!profile) return null;
  try {
    const result = await readHermesProductHistory({
      runtimeType: "hermes_gateway",
      sessionId: input.sessionId,
      profile,
      limit: 1,
      timeoutMs: Math.min(input.timeoutMs, 60_000),
      signal: input.signal,
    });
    return {
      availability: result.availability,
      tailRowId: result.metadata.tailRowId,
      relation: result.metadata.lineage.relation,
      successorSessionId: result.metadata.lineage.successorSessionId,
    };
  } catch {
    return { availability: "offline", tailRowId: null, relation: "unknown", successorSessionId: null };
  }
}

function unknownHermesBoundary(sessionId: string, reason: string): HermesAcpTranscriptBoundary {
  return { status: "unknown", sessionId, startExclusive: null, endInclusive: null, sourceRangeRef: null, reason };
}

export function deriveHermesAcpTranscriptBoundary(input: {
  sessionId: string;
  historyProfileAvailable: boolean;
  before: HermesHistoryTail | null;
  after: HermesHistoryTail | null;
}): HermesAcpTranscriptBoundary {
  if (!input.historyProfileAvailable) return unknownHermesBoundary(input.sessionId, "Hermes host history profile is unavailable.");
  if (!input.after || input.after.availability !== "available") {
    return unknownHermesBoundary(input.sessionId, "Hermes persisted history tail could not be read after the native prompt.");
  }
  if (input.before && input.before.availability !== "available") {
    return unknownHermesBoundary(input.sessionId, "Hermes persisted history tail could not be read before the native prompt.");
  }
  if (input.before?.relation !== "none" || input.after.relation !== "none") {
    const lineage = input.after.relation !== "none" ? input.after : input.before;
    return unknownHermesBoundary(
      input.sessionId,
      `Hermes ACP compression successor ${lineage?.successorSessionId ?? "unknown"} is seeded from a compacted handoff and may clone concurrent parent-tail rows with new IDs. Hermes 0.21.0 persists no source-row locators for handoff rows and exposes no per-prompt Run watermark, so exact row ownership across session generations cannot be proven.`,
    );
  }
  const startExclusive = input.before?.tailRowId ?? null;
  const endInclusive = input.after.tailRowId;
  if (endInclusive === null || (startExclusive !== null && endInclusive <= startExclusive)) {
    return unknownHermesBoundary(input.sessionId, "Hermes native prompt produced no provable persisted message interval.");
  }
  return unknownHermesBoundary(
    input.sessionId,
    "Hermes 0.21.0 history rows have no prompt-scoped locator, and Rudder does not acquire a session-exclusive writer lease spanning both history snapshots. A same-session row-ID window can contain interleaved foreign rows, so Run ownership is unknown.",
  );
}

function exactSourceRange(selector: Record<string, unknown> | null | undefined, sessionId: string): { startExclusive: number | null; endInclusive: number } | null {
  const sourceRangeRef = nonEmpty(selector?.sourceRangeRef);
  if (!sourceRangeRef) return null;
  try {
    const value = asRecord(JSON.parse(sourceRangeRef));
    const startExclusive = value?.startExclusive;
    const endInclusive = value?.endInclusive;
    const validStart = startExclusive === null
      || (typeof startExclusive === "number" && Number.isSafeInteger(startExclusive) && startExclusive >= 0);
    const validEnd = typeof endInclusive === "number" && Number.isSafeInteger(endInclusive) && endInclusive >= 0;
    if (
      value?.version !== 1
      || value.status !== "exact"
      || value.sessionId !== sessionId
      || !validStart
      || !validEnd
      || (typeof startExclusive === "number" && endInclusive <= startExclusive)
    ) return null;
    return { startExclusive: startExclusive === null ? null : startExclusive as number, endInclusive: endInclusive as number };
  } catch {
    return null;
  }
}

type RpcMessage = {
  jsonrpc?: string;
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type AcpUpdate = JsonRecord;
type AcpServerRequest = RpcMessage & { id: RpcId; method: string; params?: JsonRecord };
type HermesAcpHandshake = {
  protocolVersion: number;
  providerVersion: string | null;
  agentName: string | null;
  capabilities: JsonRecord;
  authMethodIds: string[];
  authenticatedMethodId: string | null;
};

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boundedDiagnostic(value: unknown, maxChars = MAX_DIAGNOSTIC): string {
  const text = value instanceof Error ? value.message : typeof value === "string" ? value : String(value);
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length > maxChars ? `${compact.slice(0, maxChars)}... [truncated]` : compact;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function argsHash(args: readonly string[]): string {
  return stableHash(args);
}

function textFrom(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  if (!record) return "";
  const direct = ["text", "output", "message", "content", "title"].map((key) => textFrom(record[key])).find(Boolean);
  if (direct) return direct;
  if (Array.isArray(record.content)) return record.content.map(textFrom).filter(Boolean).join("\n");
  return "";
}

function secretValues(profile: HermesAcpProfile): string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries({ ...process.env, ...(profile.env ?? {}) })) {
    const secret = typeof value === "string" ? value.trim() : "";
    if (/(?:key|token|secret|password|auth|credential|cookie)/iu.test(key) && secret) values.push(secret);
  }
  return [...new Set(values)];
}

function redactText(value: string, secrets: readonly string[]): string {
  return secrets.reduce((result, secret) => secret ? result.split(secret).join("[REDACTED]") : result, value)
    .replace(/((?:api[-_]?key|authorization|bearer|token|secret|password|credential|cookie|value)\s*[:=]\s*)(?:bearer\s+)?[^\s,;}'"]+/giu, "$1[REDACTED]");
}

function redactValue(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth > 5) return "[TRUNCATED]";
  if (typeof value === "string") return redactText(value.slice(0, MAX_UPDATE_TEXT), secrets);
  if (Array.isArray(value)) return value.slice(0, 64).map((entry) => redactValue(entry, secrets, depth + 1));
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(Object.entries(record).slice(0, 64).map(([key, child]) => [
    key,
    /(?:api[-_]?key|authorization|bearer|token|secret|password|credential|cookie|private[-_]?key|^value$)/iu.test(key)
      ? "[REDACTED]"
      : redactValue(child, secrets, depth + 1),
  ]));
}

function safeUpdate(update: AcpUpdate, secrets: readonly string[]): JsonRecord {
  const kind = redactText(nonEmpty(update.sessionUpdate ?? update.session_update ?? update.type) ?? "unknown", secrets).slice(0, 80);
  const content = asRecord(update.content);
  const messageId = nonEmpty(update.messageId ?? update.message_id);
  const toolCallId = nonEmpty(update.toolCallId ?? update.tool_call_id);
  const contextSize = finiteTokenCount(update.size);
  const contextUsed = finiteTokenCount(update.used);
  const usage = usageProjection(update);
  const safeValue = redactValue(update, secrets);
  return {
    sessionUpdate: kind,
    ...(messageId ? { messageId: redactText(messageId, secrets).slice(0, 160) } : {}),
    ...(toolCallId ? { toolCallId: redactText(toolCallId, secrets).slice(0, 160) } : {}),
    ...(nonEmpty(update.status) ? { status: redactText(nonEmpty(update.status)!, secrets).slice(0, 80) } : {}),
    ...(nonEmpty(update.title) ? { title: redactText(nonEmpty(update.title)!, secrets).slice(0, 240) } : {}),
    ...(content?.type ? { contentType: content.type } : {}),
    ...(content?.text !== undefined ? { textHash: stableHash(redactText(String(content.text), secrets)) } : {}),
    ...(update.rawInput !== undefined ? { rawInputHash: stableHash(redactValue(update.rawInput, secrets)) } : {}),
    ...(update.rawOutput !== undefined ? { rawOutputHash: stableHash(redactValue(update.rawOutput, secrets)) } : {}),
    ...(contextSize !== null || contextUsed !== null
      ? { contextUsage: { ...(contextSize !== null ? { size: contextSize } : {}), ...(contextUsed !== null ? { used: contextUsed } : {}) } }
      : {}),
    ...(usage ? { tokenUsage: usage } : {}),
    eventHash: stableHash(safeValue),
  };
}

function updateText(update: AcpUpdate): string {
  const kind = nonEmpty(update.sessionUpdate ?? update.session_update ?? update.type) ?? "";
  if (kind !== "agent_message_chunk") return "";
  return textFrom(update.content);
}

function updateKind(update: AcpUpdate): string {
  return nonEmpty(update.sessionUpdate ?? update.session_update ?? update.type) ?? "unknown";
}

function providerHttpStatus(value: unknown, depth = 0): number | null {
  if (depth > 5) return null;
  if (typeof value === "number") return Number.isInteger(value) && value >= 400 && value <= 599 ? value : null;
  if (typeof value === "string") {
    const explicit = value.match(/\b(?:http(?:\s+status)?(?:\s+code)?|status(?:\s+code)?)\s*[:=]?\s*([45]\d{2})\b/iu);
    if (explicit) return Number(explicit[1]);
    const labeled = value.match(/\b([45]\d{2})\s+(?:bad request|unauthorized|forbidden|payment required|subscription|server error)\b/iu);
    return labeled ? Number(labeled[1]) : null;
  }

  const record = asRecord(value);
  if (!record) return null;
  for (const key of ["httpStatus", "http_status", "httpStatusCode", "http_status_code", "statusCode", "status_code", "status"]) {
    const status = providerHttpStatus(record[key], depth + 1);
    if (status !== null) return status;
  }
  for (const key of ["error", "data", "response", "cause"]) {
    const status = providerHttpStatus(record[key], depth + 1);
    if (status !== null) return status;
  }
  return typeof record.message === "string" ? providerHttpStatus(record.message, depth + 1) : null;
}

function providerHttpStatusFromUpdate(update: AcpUpdate): number | null {
  const status = providerHttpStatus({
    httpStatus: update.httpStatus ?? update.http_status,
    httpStatusCode: update.httpStatusCode ?? update.http_status_code,
    statusCode: update.statusCode ?? update.status_code,
    status: update.status,
    error: update.error,
  });
  if (status !== null) return status;
  const diagnostic = updateText(update);
  return hasNonRetryableClientErrorMarker(diagnostic) ? providerHttpStatus(diagnostic) : null;
}

function hasNonRetryableClientErrorMarker(value: string): boolean {
  return /^\s*non[_ -]retryable[_ -]client[_ -]error\s*:/iu.test(value);
}

function isProviderErrorText(value: string): boolean {
  const status = providerHttpStatus(value);
  if (hasNonRetryableClientErrorMarker(value) && status !== null) return true;
  if (/^\s*error\s*:/iu.test(value)) return true;
  return status !== null
    && /\b(?:provider|api|upstream|request|model)\b/iu.test(value)
    && /\b(?:error|failed|failure|rejected|forbidden|denied|subscription|entitlement)\b/iu.test(value);
}

function isProviderErrorUpdate(update: AcpUpdate): boolean {
  const kind = updateKind(update);
  if (/(?:^|[_-])(?:provider[_-]?)?error(?:[_-]update)?$/iu.test(kind)) return true;
  if (update.error !== undefined && update.error !== null && update.error !== false && update.error !== "") return true;
  if (update.providerError === true || update.nonRetryable === true || update.non_retryable === true || update.retryable === false) return true;
  const code = nonEmpty(update.errorCode ?? update.error_code ?? update.code);
  if (code && /^(?:provider[_-]?error|non[_ -]retryable[_ -]client[_ -]error)$/iu.test(code)) return true;
  const status = nonEmpty(update.status);
  if (status && /^(?:error|failed|failure|rejected|non[_ -]retryable[_ -]client[_ -]error)$/iu.test(status)) return true;
  return providerHttpStatusFromUpdate(update) !== null;
}

function rangeValue(value: unknown): { id: string | null; ordinal: number | null } {
  if (typeof value === "string" && value.trim()) return { id: value.trim(), ordinal: null };
  if (typeof value === "number" && Number.isFinite(value)) return { id: null, ordinal: Math.floor(value) };
  return { id: null, ordinal: null };
}

function applyRange(items: HermesAcpTranscriptItem[], request: HermesAcpTranscriptRequest): HermesAcpTranscriptItem[] {
  const range = request.range ?? (request.from !== null && request.from !== undefined || request.through !== null && request.through !== undefined
    ? { ...(request.from !== null && request.from !== undefined ? { start: request.from } : {}), ...(request.through !== null && request.through !== undefined ? { end: request.through } : {}) }
    : null);
  if (!range) return items;
  if (range.itemId) return items.filter((item) => item.id === range.itemId || item.sourceEntryId === range.itemId);
  const start = rangeValue(range.start);
  const end = rangeValue(range.end);
  let result = items;
  if (start.id) {
    const index = result.findIndex((item) => item.id === start.id || item.sourceEntryId === start.id);
    if (index >= 0) result = result.slice(index + (request.from !== undefined ? 1 : 0));
  } else if (start.ordinal !== null) {
    result = result.filter((item) => item.ordinal >= start.ordinal! + (request.from !== undefined ? 1 : 0));
  }
  if (end.id) {
    const index = result.findIndex((item) => item.id === end.id || item.sourceEntryId === end.id);
    if (index >= 0) result = result.slice(0, index + 1);
  } else if (end.ordinal !== null) {
    result = result.filter((item) => item.ordinal <= end.ordinal!);
  }
  return result;
}

function validateProfile(profile: HermesAcpProfile): void {
  if (!profile.command.trim()) throw new HermesAcpNativeCapabilityError("unknown", "Hermes ACP command is missing.");
  if (!profile.cwd.trim() || !path.isAbsolute(profile.cwd)) {
    throw new HermesAcpNativeCapabilityError("unknown", "Hermes ACP cwd must be an absolute path.");
  }
  if (!profile.binding.hostId.trim() || !profile.binding.profileId.trim()) {
    throw new HermesAcpNativeCapabilityError("unknown", "Hermes ACP requires an explicit host/profile binding.");
  }
  if (!profile.args.every((value) => typeof value === "string")) {
    throw new HermesAcpNativeCapabilityError("unknown", "Hermes ACP arguments must be strings.");
  }
}

export function validateHermesAcpSession(input: {
  sessionId: string;
  sessionParams: Record<string, unknown>;
  profile: HermesAcpProfile;
  workspace?: HermesAcpWorkspace | null;
}): string | null {
  const params = input.sessionParams;
  const storedSessionId = nonEmpty(params.hermesSessionId ?? params.sessionId);
  if (storedSessionId && storedSessionId !== input.sessionId) return "Hermes ACP persisted session identity does not match the requested session.";
  if (nonEmpty(params.transport) !== HERMES_ACP_NATIVE_TRANSPORT) return "Hermes persisted session transport is not Hermes ACP stdio.";
  if (nonEmpty(params.command) !== input.profile.command.trim()) return "Hermes ACP persisted command does not match the provider profile.";
  if (nonEmpty(params.cwd) && path.resolve(nonEmpty(params.cwd)!) !== path.resolve(input.profile.cwd)) return "Hermes ACP persisted cwd does not match the provider profile.";
  if (nonEmpty(params.acpArgsHash) !== argsHash(input.profile.args)) return "Hermes ACP persisted argument hash does not match the provider profile.";
  const storedAuthMethodId = nonEmpty(params.acpAuthMethodId);
  if ("authMethodId" in input.profile && storedAuthMethodId !== nonEmpty(input.profile.authMethodId)) return "Hermes ACP persisted authentication method does not match the provider profile.";
  if (input.profile.providerVersion && nonEmpty(params.hermesProviderVersion) !== input.profile.providerVersion) return "Hermes ACP persisted provider version does not match the provider profile.";
  if (input.profile.protocolVersion && Number(params.acpProtocolVersion) !== input.profile.protocolVersion) return "Hermes ACP persisted protocol version does not match the provider profile.";
  const identities: Array<[string, unknown, unknown]> = [
    ["host", params.profileHostId ?? params.hostId, input.profile.binding.hostId],
    ["profile", params.profileId, input.profile.binding.profileId],
    ["profile binding", params.profileBindingId, input.profile.binding.id],
    ["organization", params.profileOrgId, input.profile.binding.orgId],
    ["workspace binding", params.workspaceBindingId, input.profile.binding.workspaceBindingId],
    ["capability revision", params.capabilityRevision, input.profile.binding.capabilityRevision],
  ];
  for (const [label, stored, expected] of identities) {
    if (expected !== null && expected !== undefined && nonEmpty(stored) !== String(expected)) return `Hermes ACP persisted ${label} identity does not match the provider binding.`;
    if ((expected === null || expected === undefined) && nonEmpty(stored)) return `Hermes ACP current binding is missing persisted ${label} identity.`;
  }
  if (input.workspace) {
    for (const field of ["workspaceId", "repoUrl", "repoRef", "workspaceBindingId"] as const) {
      const expected = nonEmpty(input.workspace[field]);
      const stored = nonEmpty(params[field]);
      if (expected && stored !== expected) return `Hermes ACP persisted ${field} does not match the current workspace.`;
      if (!expected && stored) return `Hermes ACP current workspace is missing persisted ${field} identity.`;
    }
  }
  return null;
}

export function buildHermesAcpSessionParams(input: {
  sessionId: string;
  profile: HermesAcpProfile;
  providerVersion: string | null;
  protocolVersion: number;
  workspace?: HermesAcpWorkspace | null;
}): Record<string, unknown> {
  const { profile } = input;
  return {
    sessionId: input.sessionId,
    hermesSessionId: input.sessionId,
    transport: HERMES_ACP_NATIVE_TRANSPORT,
    command: profile.command,
    cwd: path.resolve(profile.cwd),
    acpArgsHash: argsHash(profile.args),
    acpProtocolVersion: input.protocolVersion,
    ...(profile.authMethodId ? { acpAuthMethodId: profile.authMethodId } : {}),
    ...(input.providerVersion ? { hermesProviderVersion: input.providerVersion } : {}),
    profileHostId: profile.binding.hostId,
    profileId: profile.binding.profileId,
    ...(profile.binding.id ? { profileBindingId: profile.binding.id } : {}),
    ...(profile.binding.orgId ? { profileOrgId: profile.binding.orgId } : {}),
    ...(profile.binding.workspaceBindingId ? { workspaceBindingId: profile.binding.workspaceBindingId } : {}),
    ...(profile.binding.capabilityRevision ? { capabilityRevision: profile.binding.capabilityRevision } : {}),
    ...(profile.hermesHome ? { hermesHome: path.resolve(profile.hermesHome) } : {}),
    ...(input.workspace?.workspaceId ? { workspaceId: input.workspace.workspaceId } : {}),
    ...(input.workspace?.repoUrl ? { repoUrl: input.workspace.repoUrl } : {}),
    ...(input.workspace?.repoRef ? { repoRef: input.workspace.repoRef } : {}),
  };
}

function spawnAcp(profile: HermesAcpProfile): ChildProcessWithoutNullStreams {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const [key, value] of Object.entries(profile.env ?? {})) {
    if (typeof value === "string") env[key] = value;
  }
  if (profile.hermesHome) env.HERMES_HOME = path.resolve(profile.hermesHome);
  return spawn(profile.command, [...profile.args], {
    cwd: profile.cwd,
    env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class HermesAcpRpcTimeoutError extends Error {
  override readonly name = "HermesAcpRpcTimeoutError";
  readonly code = "HERMES_ACP_RPC_TIMEOUT";
  readonly errorCode = "hermes_native_timeout";

  constructor(
    readonly method: string,
    readonly timeoutMs: number,
    readonly sessionId: string | null = null,
    readonly sessionParams: Record<string, unknown> | null = null,
  ) {
    super(`Hermes ACP ${method} timed out after ${timeoutMs}ms.`);
  }
}

class HermesAcpRpcClient {
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private readonly pending = new Map<RpcId, PendingRequest>();
  private readonly childClosePromise: Promise<void>;
  private readonly processExitPromise: Promise<HermesNativeProcessDiagnostics>;
  private readonly processSecrets: string[];
  private buffer = "";
  private bufferBytes = 0;
  private nextId = 1;
  private closed = false;
  private transportFailed = false;
  private shutdownPromise: Promise<void> | null = null;
  private stderr = "";
  private stderrPendingLine = "";
  private stderrPendingLineOverflow = false;
  private processExited = false;
  private exitCode: number | null = null;
  private exitSignal: string | null = null;
  private closeAcknowledged = false;
  private spawnError: string | undefined;
  private resolveProcessExit!: (value: HermesNativeProcessDiagnostics) => void;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onNotification: (method: string, params: JsonRecord) => void,
    private readonly onServerRequest: (request: AcpServerRequest) => Promise<unknown>,
    profile: HermesAcpProfile,
  ) {
    this.processSecrets = secretValues(profile);
    this.processExitPromise = new Promise((resolve) => { this.resolveProcessExit = resolve; });
    this.childClosePromise = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        this.appendStderrText(this.stderrDecoder.end(), true);
        this.closeAcknowledged = true;
        this.markProcessExit(code, signal);
        resolve();
      });
    });
    const finish = (error?: Error) => {
      if (this.closed) return;
      this.closed = true;
      this.buffer = "";
      this.bufferBytes = 0;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error ?? new Error("Hermes ACP process exited."));
      }
      this.pending.clear();
    };
    child.once("error", (error) => {
      this.spawnError = redactText(boundedDiagnostic(error), this.processSecrets);
      this.markProcessExit(null, null);
      finish(new Error(this.processFailureMessage("failed to start")));
    });
    child.once("exit", (code, signal) => {
      this.markProcessExit(code, signal);
      finish(new Error(this.processFailureMessage("exited")));
    });
    child.stdout.on("data", (chunk: Buffer) => this.consume(this.stdoutDecoder.write(chunk)));
    child.stderr.on("data", (chunk: Buffer) => {
      this.appendStderrText(this.stderrDecoder.write(chunk));
    });
  }

  private appendStderrText(value: string, flush = false): void {
    let offset = 0;
    while (offset < value.length) {
      const newline = value.indexOf("\n", offset);
      const completeLine = newline >= 0;
      const lineEnd = completeLine ? newline + 1 : value.length;

      if (this.stderrPendingLineOverflow) {
        if (!completeLine) return;
        this.stderrPendingLineOverflow = false;
        this.stderrPendingLine = "";
        offset = lineEnd;
        continue;
      }

      if (this.stderrPendingLine.length + lineEnd - offset > MAX_DIAGNOSTIC) {
        this.stderrPendingLine = "";
        this.stderrPendingLineOverflow = !completeLine;
      } else if (completeLine) {
        const safeLine = redactText(`${this.stderrPendingLine}${value.slice(offset, lineEnd)}`, this.processSecrets);
        this.stderr = `${this.stderr}${safeLine}`.slice(-MAX_DIAGNOSTIC);
        this.stderrPendingLine = "";
      } else {
        this.stderrPendingLine += value.slice(offset, lineEnd);
      }
      offset = lineEnd;
    }

    if (flush) {
      if (!this.stderrPendingLineOverflow && this.stderrPendingLine) {
        const safeLine = redactText(this.stderrPendingLine, this.processSecrets);
        this.stderr = `${this.stderr}${safeLine}`.slice(-MAX_DIAGNOSTIC);
      }
      this.stderrPendingLine = "";
      this.stderrPendingLineOverflow = false;
    }
  }

  get stderrDiagnostic(): string {
    return boundedDiagnostic(redactText(this.stderr, this.processSecrets));
  }

  get processExit(): Promise<HermesNativeProcessDiagnostics> {
    return this.processExitPromise;
  }

  getProcessDiagnostics(): HermesNativeProcessDiagnostics {
    return {
      processExited: this.processExited,
      exitCode: this.exitCode,
      signal: this.exitSignal,
      closeAcknowledged: this.closeAcknowledged,
      stderr: this.stderrDiagnostic,
      ...(this.spawnError ? { spawnError: this.spawnError } : {}),
    };
  }

  private markProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.processExited) return;
    this.processExited = true;
    this.exitCode = code;
    this.exitSignal = signal;
    this.resolveProcessExit(this.getProcessDiagnostics());
  }

  private processFailureMessage(verb: string): string {
    const diagnostics = this.getProcessDiagnostics();
    const exit = diagnostics.exitCode !== null
      ? `exit=${diagnostics.exitCode}`
      : diagnostics.signal
        ? `signal=${diagnostics.signal}`
        : diagnostics.spawnError
          ? `spawn=${diagnostics.spawnError}`
          : "exit=unknown";
    return `Hermes ACP process ${verb} (${exit})${diagnostics.stderr ? `; stderr: ${diagnostics.stderr}` : ""}.`;
  }

  private consume(chunk: string): void {
    if (this.closed || this.transportFailed) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf("\n", offset);
      const end = newline < 0 ? chunk.length : newline;
      const fragment = chunk.slice(offset, end);
      const fragmentBytes = Buffer.byteLength(fragment, "utf8");
      if (this.bufferBytes + fragmentBytes > MAX_RPC_LINE_BYTES) {
        this.failTransport(new Error(`Hermes ACP JSON-RPC line exceeded ${MAX_RPC_LINE_BYTES} UTF-8 bytes.`));
        return;
      }
      this.buffer += fragment;
      this.bufferBytes += fragmentBytes;
      if (newline < 0) return;

      const line = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
      this.buffer = "";
      this.bufferBytes = 0;
      this.consumeLine(line);
      if (this.closed || this.transportFailed) return;
      offset = newline + 1;
    }
  }

  private consumeLine(line: string): void {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.failTransport(new Error("Hermes ACP emitted malformed JSON-RPC output."));
      return;
    }
    const message = asRecord(parsed) as RpcMessage | null;
    if (!message) return;
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new HermesAcpRpcError(message.error.code ?? -32000, message.error.message ?? "Hermes ACP request failed."));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== "string") return;
    if (message.id !== undefined) {
      const request = message as AcpServerRequest;
      void this.onServerRequest(request).then(
        (result) => this.respond(request.id, result),
        (error) => this.respondError(request.id, -32000, boundedDiagnostic(error)),
      );
    } else {
      this.onNotification(message.method, asRecord(message.params) ?? {});
    }
  }

  private failTransport(error: Error): void {
    if (this.closed || this.transportFailed) return;
    this.transportFailed = true;
    this.buffer = "";
    this.bufferBytes = 0;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    void this.close().catch(() => {});
  }

  private write(message: JsonRecord): Promise<void> {
    if (this.closed || this.transportFailed || this.child.stdin.destroyed) return Promise.reject(new Error("Hermes ACP process is closed."));
    return new Promise((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`, (error) => error ? reject(error) : resolve());
    });
  }

  async request(method: string, params: JsonRecord, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.closed || this.transportFailed) throw new Error(this.processExited
      ? this.processFailureMessage("is not running")
      : "Hermes ACP process is closed.");
    const id = this.nextId++;
    const boundedTimeoutMs = Math.max(1, timeoutMs);
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new HermesAcpRpcTimeoutError(method, boundedTimeoutMs));
      }, boundedTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      await this.write({ id, method, params });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return response;
  }

  async notify(method: string, params: JsonRecord): Promise<void> {
    await this.write({ method, params });
  }

  private respond(id: RpcId, result: unknown): void {
    void this.write({ id, result }).catch(() => {});
  }

  private respondError(id: RpcId, code: number, message: string): void {
    void this.write({ id, error: { code, message } }).catch(() => {});
  }

  close(): Promise<void> {
    this.shutdownPromise ??= this.shutdownChild();
    return this.shutdownPromise;
  }

  private async shutdownChild(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
    let closeTimer: NodeJS.Timeout | undefined;
    const gracefulClose = await Promise.race([
      this.childClosePromise.then(() => true),
      new Promise<boolean>((resolve) => { closeTimer = setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS); }),
    ]);
    if (closeTimer) clearTimeout(closeTimer);
    if (gracefulClose) return;

    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    closeTimer = undefined;
    const forcedClose = await Promise.race([
      this.childClosePromise.then(() => true),
      new Promise<boolean>((resolve) => { closeTimer = setTimeout(() => resolve(false), SIGKILL_CLOSE_TIMEOUT_MS); }),
    ]);
    if (closeTimer) clearTimeout(closeTimer);
    if (!forcedClose) throw new HermesNativeProcessCloseError(this.getProcessDiagnostics());
  }
}

class HermesAcpRpcError extends Error {
  override readonly name = "HermesAcpRpcError";

  constructor(readonly code: number, message: string) {
    super(message);
  }
}

export function hermesNativeRpcErrorCode(error: unknown): number | null {
  return error instanceof HermesAcpRpcError ? error.code : null;
}

function capabilityFromInitialize(value: unknown): HermesAcpHandshake {
  const response = asRecord(value);
  const protocolVersion = typeof response?.protocolVersion === "number" ? response.protocolVersion : 0;
  const agentInfo = asRecord(response?.agentInfo);
  const capabilities = asRecord(response?.agentCapabilities) ?? {};
  const authMethodIds = Array.isArray(response?.authMethods)
    ? response.authMethods.map(asRecord).map((method) => nonEmpty(method?.id)).filter((id): id is string => Boolean(id))
    : [];
  if (!protocolVersion || !agentInfo) throw new HermesAcpNativeCapabilityError("unknown", "Hermes ACP initialize returned no protocol or agent identity.");
  return {
    protocolVersion,
    providerVersion: nonEmpty(agentInfo.version),
    agentName: nonEmpty(agentInfo.name),
    capabilities,
    authMethodIds,
    authenticatedMethodId: null,
  };
}

async function initializeClient(client: HermesAcpRpcClient, profile: HermesAcpProfile, timeoutMs: number): Promise<HermesAcpHandshake> {
  let response: unknown;
  try {
    response = await client.request("initialize", {
      protocolVersion: profile.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
      clientInfo: { name: "rudder", version: "native-chat" },
      clientCapabilities: {},
    }, timeoutMs);
  } catch (error) {
    if (error instanceof HermesAcpRpcTimeoutError) throw error;
    throw new HermesAcpNativeCapabilityError(
      error instanceof HermesAcpRpcError && error.code === -32601 ? "unsupported" : "unknown",
      `Hermes ACP initialize failed: ${boundedDiagnostic(error)}${client.stderrDiagnostic ? ` (${client.stderrDiagnostic})` : ""}`,
    );
  }
  const handshake = capabilityFromInitialize(response);
  if (!handshake.agentName?.toLowerCase().includes("hermes")) {
    throw new HermesAcpNativeCapabilityError("unsupported", `Hermes ACP initialize identified a different agent (${handshake.agentName ?? "unknown"}).`);
  }
  if (profile.protocolVersion && handshake.protocolVersion !== profile.protocolVersion) {
    throw new HermesAcpNativeCapabilityError("unsupported", `Hermes ACP protocol ${handshake.protocolVersion} does not match configured protocol ${profile.protocolVersion}.`);
  }
  const providerAuthMethods = handshake.authMethodIds.filter((methodId) => methodId !== "hermes-setup");
  const authMethodId = profile.authMethodId ?? (providerAuthMethods.length === 1 ? providerAuthMethods[0] : null);
  if (authMethodId) {
    if (!handshake.authMethodIds.includes(authMethodId)) {
      throw new HermesAcpNativeCapabilityError("unsupported", `Hermes ACP did not advertise authentication method ${authMethodId}.`);
    }
    try {
      const authenticated = await client.request("authenticate", { methodId: authMethodId }, timeoutMs);
      if (authenticated === null || authenticated === undefined) throw new Error("Hermes ACP authenticate returned no response.");
    } catch (error) {
      if (error instanceof HermesAcpRpcTimeoutError) throw error;
      throw new HermesAcpNativeCapabilityError("unknown", `Hermes ACP authentication failed: ${boundedDiagnostic(error)}.`);
    }
    handshake.authenticatedMethodId = authMethodId;
  }
  return handshake;
}

function sessionRequestParams(profile: HermesAcpProfile, cwd: string, sessionId?: string): JsonRecord {
  return {
    cwd,
    mcpServers: [...(profile.mcpServers ?? [])],
    ...(sessionId ? { sessionId } : {}),
  };
}

function responseSessionId(value: unknown): string | null {
  const result = asRecord(value);
  return nonEmpty(result?.sessionId ?? result?.session_id ?? result?.id);
}

function requireLoadedSession(value: unknown): void {
  if (value === null || value === undefined) {
    throw new HermesAcpNativeCapabilityError(
      "unsupported",
      "Hermes ACP session/load returned no session; refusing to prompt a missing persisted session.",
    );
  }
}

function promptParams(sessionId: string, text: string): JsonRecord {
  return { sessionId, prompt: [{ type: "text", text }] };
}

function finiteTokenCount(value: unknown): number | null {
  const count = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function usageProjection(value: unknown): JsonRecord | null {
  const usage = asRecord(value);
  if (!usage) return null;
  const projected: JsonRecord = {};
  const fields: Record<string, string[]> = {
    inputTokens: ["inputTokens", "input_tokens"],
    outputTokens: ["outputTokens", "output_tokens"],
    totalTokens: ["totalTokens", "total_tokens"],
    thoughtTokens: ["thoughtTokens", "thought_tokens"],
    cachedInputTokens: ["cachedInputTokens", "cached_input_tokens", "cachedReadTokens", "cached_read_tokens"],
  };
  for (const [target, keys] of Object.entries(fields)) {
    const raw = keys.map((key) => usage[key]).find((candidate) => candidate !== undefined && candidate !== null);
    const count = finiteTokenCount(raw);
    if (count !== null) projected[target] = count;
  }
  return Object.keys(projected).length > 0 ? projected : null;
}

function usageFrom(value: unknown): { inputTokens: number; outputTokens: number; cachedInputTokens?: number } | undefined {
  const projected = usageProjection(value);
  if (!projected || (projected.inputTokens === undefined && projected.outputTokens === undefined)) return undefined;
  return {
    inputTokens: typeof projected.inputTokens === "number" ? projected.inputTokens : 0,
    outputTokens: typeof projected.outputTokens === "number" ? projected.outputTokens : 0,
    ...(typeof projected.cachedInputTokens === "number" ? { cachedInputTokens: projected.cachedInputTokens } : {}),
  };
}

async function permissionOutcome(params: JsonRecord, input: {
  requestId: string;
  secrets: readonly string[];
  requestApproval?: (request: HermesAcpApprovalRequest) => Promise<{ id: string; status: string }>;
  waitForApproval?: (id: string, timeoutMs: number) => Promise<HermesAcpApprovalDecision>;
  timeoutMs: number;
  provider: string;
  onEvent: (event: JsonRecord) => Promise<void>;
}): Promise<JsonRecord> {
  const options = Array.isArray(params.options) ? params.options.map(asRecord).filter((value): value is JsonRecord => Boolean(value)) : [];
  const safeOptions = options.flatMap((option, index) => {
    const providerOptionId = nonEmpty(option.optionId ?? option.option_id);
    if (!providerOptionId) return [];
    return [{
      providerOptionId,
      clientOptionId: `option-${index + 1}`,
      kind: redactText(nonEmpty(option.kind) ?? "unknown", input.secrets).slice(0, 80),
      label: redactText(nonEmpty(option.name) ?? nonEmpty(option.kind) ?? `Option ${index + 1}`, input.secrets).slice(0, 100),
      ...(nonEmpty(option.description) ? { description: redactText(nonEmpty(option.description)!, input.secrets).slice(0, 220) } : {}),
    }];
  });
  const denied = (): JsonRecord => ({ outcome: { outcome: "cancelled" } });
  const toolCall = asRecord(params.toolCall ?? params.tool_call);
  const toolTitle = nonEmpty(toolCall?.title ?? toolCall?.name);
  const safeToolCall = {
    ...(toolTitle ? { title: redactText(toolTitle, input.secrets).slice(0, 240) } : {}),
    ...(nonEmpty(toolCall?.toolCallId ?? toolCall?.tool_call_id)
      ? { toolCallId: redactText(nonEmpty(toolCall?.toolCallId ?? toolCall?.tool_call_id)!, input.secrets).slice(0, 160) }
      : {}),
    ...(toolCall?.rawInput !== undefined || toolCall?.raw_input !== undefined
      ? { inputHash: stableHash(redactValue(toolCall.rawInput ?? toolCall.raw_input, input.secrets)) }
      : {}),
  };
  const safeEvent = {
    interactionKind: "permission",
    requestId: redactText(input.requestId, input.secrets).slice(0, 160),
    sessionId: nonEmpty(params.sessionId) ? redactText(nonEmpty(params.sessionId)!, input.secrets).slice(0, 160) : null,
    toolCall: safeToolCall,
    choices: safeOptions.map(({ clientOptionId, kind, label }) => ({ id: clientOptionId, kind, label })),
  };
  await input.onEvent({ ...safeEvent, status: "requested" });
  if (!input.requestApproval || !input.waitForApproval || safeOptions.length === 0) {
    await input.onEvent({ ...safeEvent, status: "cancelled", reason: "approval_bridge_unavailable" });
    return denied();
  }
  const questionId = "hermes_permission";
  const inputRequest: NonNullable<AgentRuntimeApprovalRequest["inputRequest"]> = {
    questions: [{
      id: questionId,
      header: "Hermes",
      question: toolTitle
        ? `Allow Hermes to perform ${redactText(toolTitle, input.secrets).slice(0, 180)}?`
        : "Allow Hermes to perform this action?",
      options: safeOptions.map(({ clientOptionId, label, description }) => ({
        id: clientOptionId,
        label,
        ...(description ? { description } : {}),
      })),
    }],
  };
  try {
    const request = await input.requestApproval({
      type: "agent_runtime",
      payload: {
        provider: input.provider,
        runtimeType: "hermes_gateway",
        protocol: "acp",
        sessionId: nonEmpty(params.sessionId) ? redactText(nonEmpty(params.sessionId)!, input.secrets).slice(0, 160) : null,
        requestId: redactText(input.requestId, input.secrets).slice(0, 160),
        interactionKind: "permission",
        toolCall: safeToolCall,
        choices: safeEvent.choices,
      },
      inputRequest,
    });
    if (request.status === "rejected" || request.status === "cancelled") {
      await input.onEvent({ ...safeEvent, status: request.status });
      return denied();
    }
    const decision = await input.waitForApproval(request.id, input.timeoutMs);
    const answer = decision.inputResponse?.answers.find((entry) => entry.questionId === questionId);
    const selectedId = answer?.optionIds.length === 1 ? answer.optionIds[0] : null;
    const selected = safeOptions.find((option) => option.clientOptionId === selectedId);
    if (decision.id !== request.id || decision.status !== "approved" || !selected?.providerOptionId) {
      await input.onEvent({ ...safeEvent, status: "cancelled" });
      return denied();
    }
    await input.onEvent({ ...safeEvent, status: "resolved", selected: selected.clientOptionId });
    return { outcome: { outcome: "selected", optionId: selected.providerOptionId } };
  } catch {
    await input.onEvent({ ...safeEvent, status: "cancelled" });
    return denied();
  }
}

function identityFor(profile: HermesAcpProfile, handshake: HermesAcpHandshake, sessionId: string, workspace?: HermesAcpWorkspace | null): Record<string, unknown> {
  return buildHermesAcpSessionParams({
    sessionId,
    profile: { ...profile, authMethodId: handshake.authenticatedMethodId },
    providerVersion: handshake.providerVersion ?? profile.providerVersion ?? null,
    protocolVersion: handshake.protocolVersion,
    workspace,
  });
}

async function createClient(
  profile: HermesAcpProfile,
  onNotification: (method: string, params: JsonRecord) => void,
  onServerRequest: (request: AcpServerRequest) => Promise<unknown>,
  onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>,
): Promise<HermesAcpRpcClient> {
  validateProfile(profile);
  const child = spawnAcp(profile);
  const client = new HermesAcpRpcClient(child, onNotification, onServerRequest, profile);
  try {
    if (typeof child.pid === "number") await onSpawn?.({ pid: child.pid, startedAt: new Date().toISOString() });
    return client;
  } catch (error) {
    try {
      await client.close();
    } catch (closeError) {
      if (closeError instanceof HermesNativeProcessCloseError) throw closeError;
      throw new HermesNativeProcessCloseError(client.getProcessDiagnostics());
    }
    throw error;
  }
}

// Both installed Hermes transports use the same framed JSON-RPC process
// lifecycle. Protocol methods remain specific to ACP or the product Gateway.
export { createClient as createHermesNativeRpcClient };

export async function executeHermesNativeChat(input: {
  profile: HermesAcpProfile;
  sessionId: string | null;
  sessionParams: Record<string, unknown> | null;
  workspace?: HermesAcpWorkspace | null;
  prompt: string;
  model?: string | null;
  mode?: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
  controlAttempt?: AgentRuntimeControlAttemptLease;
  requestApproval?: (request: HermesAcpApprovalRequest) => Promise<{ id: string; status: string }>;
  waitForApproval?: (id: string, timeoutMs: number) => Promise<HermesAcpApprovalDecision>;
  onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}): Promise<AgentRuntimeExecutionResult> {
  const updates: AcpUpdate[] = [];
  const assistant: string[] = [];
  const secrets = secretValues(input.profile);
  let client: HermesAcpRpcClient | null = null;
  let handshake: HermesAcpHandshake | null = null;
  let sessionId = input.sessionId;
  let sessionParams: Record<string, unknown> | null = input.sessionParams;
  let aborted = false;
  let promptActive = false;
  let promptTerminalHadUnresolvedInteraction = false;
  let liveLogs = Promise.resolve();
  let cancelSent = false;
  let pendingInteractions = 0;
  let interactionRequestFailed = false;
  let controlLease: { release(): Promise<void> } | null = null;
  const onNotification = (method: string, params: JsonRecord) => {
    if (method !== "session/update" || !promptActive || params.sessionId !== sessionId) return;
    const update = asRecord(params.update) ?? params;
    const serialized = `${JSON.stringify({ type: "hermes_acp_update", update: redactValue(update, secrets) })}\n`;
    liveLogs = liveLogs.then(() => input.onLog("stdout", serialized));
    // Keep a rejection handler attached while the provider is still running;
    // awaiting the chain below still propagates persistence failures.
    void liveLogs.catch(() => {});
    if (updates.length < MAX_UPDATE_COUNT) updates.push(update);
    const text = updateText(update);
    if (text) assistant.push(text.slice(0, MAX_UPDATE_TEXT));
  };
  const cancel = async () => {
    if (!client || !sessionId || cancelSent) return;
    cancelSent = true;
    try {
      await client.notify("session/cancel", { sessionId });
      await input.onLog("stdout", `[rudder] Hermes ACP cancel requested session=${sessionId}\n`);
    } catch {
      await input.onLog("stderr", "[rudder] Hermes ACP cancel request could not be delivered\n");
    }
  };
  const onServerRequest = async (request: AcpServerRequest): Promise<unknown> => {
    if (request.method === "session/request_permission") {
      pendingInteractions += 1;
      try {
        return await permissionOutcome(asRecord(request.params) ?? {}, {
          requestId: String(request.id),
          secrets,
          requestApproval: input.requestApproval,
          waitForApproval: input.waitForApproval,
          timeoutMs: input.timeoutMs,
          provider: "hermes",
          onEvent: async (event) => {
            await input.onLog("stdout", `${JSON.stringify({ type: "hermes_acp_interaction", ...event })}\n`);
          },
        });
      } catch (error) {
        interactionRequestFailed = true;
        throw error;
      } finally {
        pendingInteractions -= 1;
      }
    }
    interactionRequestFailed = true;
    throw new Error(`Hermes ACP client does not implement ${request.method}.`);
  };
  const abortHandler = () => {
    aborted = true;
    void cancel();
  };

  try {
    client = await createClient(input.profile, onNotification, onServerRequest, input.onSpawn);
    handshake = await initializeClient(client, input.profile, Math.min(input.timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS));
    if (handshake.capabilities.loadSession !== true) {
      throw new HermesAcpNativeCapabilityError("unsupported", "Hermes ACP did not advertise loadSession; native session continuity cannot be guaranteed.");
    }
    if (sessionId) {
      const sessionProfile: HermesAcpProfile = {
        ...input.profile,
        authMethodId: handshake.authenticatedMethodId,
        providerVersion: handshake.providerVersion ?? input.profile.providerVersion,
        protocolVersion: handshake.protocolVersion,
      };
      const rejection = validateHermesAcpSession({ sessionId, sessionParams: input.sessionParams ?? {}, profile: sessionProfile, workspace: input.workspace });
      if (rejection) throw new HermesAcpNativeCapabilityError("unsupported", rejection, { sessionId, sessionParams: input.sessionParams });
      const loaded = await client.request("session/load", sessionRequestParams(input.profile, input.profile.cwd, sessionId), input.timeoutMs);
      requireLoadedSession(loaded);
    } else {
      const created = await client.request("session/new", sessionRequestParams(input.profile, input.profile.cwd), input.timeoutMs);
      sessionId = responseSessionId(created);
      if (!sessionId) throw new HermesAcpNativeCapabilityError("unknown", "Hermes ACP session/new returned no session identity.");
    }
    sessionParams = identityFor(input.profile, handshake, sessionId, input.workspace);
    const configuredModel = nonEmpty(input.model);
    if (configuredModel) await client.request("session/set_model", { sessionId, modelId: configuredModel }, input.timeoutMs);
    const configuredMode = nonEmpty(input.mode);
    if (configuredMode) await client.request("session/set_mode", { sessionId, modeId: configuredMode }, input.timeoutMs);

    const historyProfileAvailable = hermesHistoryProfile(input.profile) !== null;
    const historyBefore = sessionId
      ? await readHermesHistoryTail({ profile: input.profile, sessionId, timeoutMs: input.timeoutMs, signal: input.signal })
      : null;

    const inputCorrelationId = randomUUID();
    if (input.controlAttempt) {
      controlLease = await input.controlAttempt.register({
        runtimeType: "hermes_gateway",
        providerThreadId: sessionId,
        providerTurnId: inputCorrelationId,
        capabilities: { steer: "interrupt_continue", interrupt: "native" },
        async steer(_controlInput: AgentRuntimeControlSteerInput): Promise<AgentRuntimeControlSteerResult> {
          if (!client || !sessionId) return { disposition: "closing", reason: "Hermes ACP session is closed." };
          return {
            disposition: "unsupported",
            reason: "Hermes ACP has no native steer method; a concurrent session/prompt is queued as a follow-up.",
          };
        },
        async interrupt(_reason: AgentRuntimeControlInterruptReason): Promise<AgentRuntimeControlInterruptResult> {
          await cancel();
          return cancelSent ? "acknowledged" : "unverified";
        },
        async dispose() {},
      });
      if (!controlLease) throw new HermesAcpNativeCapabilityError("unknown", "Hermes ACP runtime control lease was lost.", { sessionId, sessionParams });
    }

    input.signal?.addEventListener("abort", abortHandler, { once: true });
    if (input.signal?.aborted) {
      abortHandler();
    }
    await input.onLog("stdout", `[rudder] Hermes ACP native session started session=${sessionId} agent=${handshake.agentName ?? "unknown"}\n`);
    promptActive = true;
    let response: JsonRecord = {};
    let promptError: unknown = null;
    try {
      response = asRecord(await client.request("session/prompt", promptParams(sessionId, input.prompt), input.timeoutMs)) ?? {};
    } catch (error) {
      if (error instanceof HermesAcpRpcTimeoutError) throw error;
      promptError = error;
    }
    promptActive = false;
    promptTerminalHadUnresolvedInteraction = interactionRequestFailed || pendingInteractions > 0;
    await liveLogs;
    const historyAfter = await readHermesHistoryTail({
      profile: input.profile,
      sessionId,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
    const transcriptBoundary = deriveHermesAcpTranscriptBoundary({
      sessionId,
      historyProfileAvailable,
      before: historyBefore,
      after: historyAfter,
    });
    const stopReason = promptError ? "error" : nonEmpty(response.stopReason ?? response.stop_reason) ?? "unknown";
    const output = assistant.join("").trim();
    const promptErrorMessage = promptError instanceof Error ? promptError.message : "";
    const providerErrorUpdates = updates.filter(isProviderErrorUpdate);
    const rpcProviderError = promptError instanceof HermesAcpRpcError && isProviderErrorText(promptErrorMessage);
    const providerError = providerErrorUpdates.length > 0 || rpcProviderError;
    const providerStatus = providerErrorUpdates.map(providerHttpStatusFromUpdate).find((status) => status !== null)
      ?? (rpcProviderError ? providerHttpStatus(promptErrorMessage) : null);
    const emptyResponse = stopReason === "end_turn" && !output;
    const resultJson: JsonRecord = {
      nativeSession: true,
      transport: HERMES_ACP_NATIVE_TRANSPORT,
      sessionId,
      transcriptBoundary,
      protocol: {
        version: handshake.protocolVersion,
        agent: handshake.agentName,
        providerVersion: handshake.providerVersion,
      },
      stopReason,
      providerError,
      ...(providerStatus !== null ? { providerHttpStatus: providerStatus } : {}),
      emptyResponse,
      ...(promptError ? {
        promptFailure: {
          rpcCode: promptError instanceof HermesAcpRpcError ? promptError.code : null,
        },
      } : {}),
      updateCount: updates.length,
      updates: updates.map((update) => safeUpdate(update, secrets)),
      inputCorrelationId,
      control: { cancelRequested: cancelSent },
      continuity: {
        mode: "hermes_acp_session",
        native: true,
        lossless: true,
        loadReplay: Boolean(input.sessionId),
      },
    };
    const usage = usageFrom(response.usage);
    const cancelled = stopReason === "cancelled" || aborted || cancelSent;
    const unresolvedInteraction = promptTerminalHadUnresolvedInteraction || interactionRequestFailed || pendingInteractions > 0;
    const completed = stopReason === "end_turn" && !cancelled && !providerError && !emptyResponse && !unresolvedInteraction;
    await controlLease?.release();
    controlLease = null;
    return {
      exitCode: completed ? 0 : 1,
      signal: cancelled ? "SIGTERM" : null,
      timedOut: false,
      ...(completed ? { nativeWriterQuiescence: { status: "confirmed" as const, source: "provider_terminal" as const } } : {}),
      provider: "hermes",
      model: configuredModel,
      ...(usage ? { usage } : {}),
      sessionId,
      sessionParams,
      sessionDisplayId: sessionId,
      resultJson,
      ...(output ? { summary: redactText(output, secrets) } : {}),
      ...(completed ? {} : {
        errorMessage: cancelled
          ? "Hermes ACP prompt cancelled."
          : providerError
            ? "Hermes ACP provider returned an error response."
            : emptyResponse
              ? "Hermes ACP prompt ended without assistant output."
              : promptError
                ? "Hermes ACP session/prompt request failed."
                : `Hermes ACP prompt ended with ${stopReason}.`,
        errorCode: cancelled
          ? "hermes_native_cancelled"
          : providerError
            ? "hermes_native_provider_error"
            : emptyResponse
              ? "hermes_native_empty_response"
              : "hermes_native_prompt_failed",
      }),
    };
  } catch (error) {
    const details = error instanceof HermesAcpNativeCapabilityError ? error.details : { sessionId, sessionParams };
    if (error instanceof HermesAcpRpcTimeoutError) {
      if (handshake) await cancel().catch(() => {});
      throw new HermesAcpRpcTimeoutError(error.method, error.timeoutMs, sessionId, sessionParams);
    }
    if (error instanceof HermesAcpNativeCapabilityError) throw error;
    throw new HermesAcpNativeCapabilityError("unknown", `Hermes ACP native session failed: ${boundedDiagnostic(error)}.`, details);
  } finally {
    promptActive = false;
    input.signal?.removeEventListener("abort", abortHandler);
    await controlLease?.release().catch(() => {});
    await client?.close().catch(() => {});
  }
}

async function withLoadedAcpSession<T>(input: {
  profile: HermesAcpProfile;
  session: HermesAcpSession;
  workspace?: HermesAcpWorkspace | null;
  signal?: AbortSignal;
  operation: (client: HermesAcpRpcClient, handshake: HermesAcpHandshake) => Promise<T>;
  onUpdate?: (update: AcpUpdate) => void;
}): Promise<T> {
  const onNotification = (method: string, params: JsonRecord) => {
    if (method === "session/update") input.onUpdate?.(asRecord(params.update) ?? params);
  };
  const onServerRequest = async (_request: AcpServerRequest): Promise<unknown> => ({ outcome: { outcome: "cancelled" } });
  const client = await createClient(input.profile, onNotification, onServerRequest);
  try {
    const handshake = await initializeClient(client, input.profile, DEFAULT_REQUEST_TIMEOUT_MS);
    if (handshake.capabilities.loadSession !== true) {
      throw new HermesAcpNativeCapabilityError("unsupported", "Hermes ACP did not advertise loadSession; native session continuity cannot be guaranteed.");
    }
    const sessionProfile: HermesAcpProfile = {
      ...input.profile,
      authMethodId: handshake.authenticatedMethodId,
      providerVersion: handshake.providerVersion ?? input.profile.providerVersion,
      protocolVersion: handshake.protocolVersion,
    };
    const rejection = validateHermesAcpSession({ sessionId: input.session.sessionId, sessionParams: input.session.sessionParams, profile: sessionProfile, workspace: input.workspace });
    if (rejection) throw new HermesAcpNativeCapabilityError("unsupported", rejection, { sessionId: input.session.sessionId, sessionParams: input.session.sessionParams });
    const loaded = await client.request("session/load", sessionRequestParams(input.profile, input.profile.cwd, input.session.sessionId), DEFAULT_REQUEST_TIMEOUT_MS);
    requireLoadedSession(loaded);
    return await input.operation(client, handshake);
  } finally {
    await client.close();
  }
}

export async function readHermesAcpNativeTranscript(input: HermesAcpTranscriptRequest): Promise<HermesAcpTranscriptResult> {
  if (input.runtimeType !== "hermes_gateway") return { items: [], nextCursor: null, source: "native", revision: "runtime-mismatch", availability: "incompatible", completeness: "unknown" };
  const profile = hermesHistoryProfile(input.profile);
  if (!profile) {
    return {
      items: [],
      nextCursor: null,
      source: "native",
      revision: "history-profile-missing",
      availability: "missing",
      completeness: "unknown",
    };
  }
  const sessionId = input.session.sessionId.trim();
  const selectorKind = nonEmpty(input.selector?.kind);
  const exactRange = selectorKind === "hermes_execution"
    ? exactSourceRange(input.selector, sessionId)
    : null;
  if (selectorKind === "hermes_execution" && !exactRange) {
    return {
      items: [],
      nextCursor: null,
      source: "native",
      revision: "execution-boundary-unknown",
      availability: "missing",
      completeness: "unknown",
    };
  }
  try {
    const result = exactRange
      ? await readHermesProductHistoryExecutionSpan({
        runtimeType: "hermes_gateway",
        sessionId,
        profile,
        range: exactRange,
        cursor: input.cursor,
        timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        signal: input.signal,
      })
      : await readHermesProductHistory({
        runtimeType: "hermes_gateway",
        sessionId,
        profile,
        range: null,
        cursor: input.cursor,
        limit: 100,
        timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        signal: input.signal,
      });
    return {
      items: result.items,
      nextCursor: result.nextCursor,
      source: "native",
      revision: result.revision,
      availability: result.availability,
      completeness: result.completeness,
    };
  } catch (error) {
    return {
      items: [],
      nextCursor: null,
      source: "native",
      revision: `history-error:${boundedDiagnostic(error, 120)}`,
      availability: "offline",
      completeness: "unknown",
    };
  }
}

export async function forkHermesAcpNativeSession(input: HermesAcpForkRequest & { profile: HermesAcpProfile }): Promise<HermesAcpForkResult> {
  if (input.runtimeType !== "hermes_gateway") throw new HermesAcpNativeCapabilityError("unsupported", "Hermes ACP fork received a different runtime type.");
  // Installed Hermes ACP forks the entire loaded history and ignores additional
  // boundary parameters. Never label that operation an exact message fork.
  if (input.boundary !== "head") throw new HermesAcpNativeCapabilityError("unsupported", "Hermes ACP cannot fork at a selected historical message boundary.");
  const fork = await withLoadedAcpSession({
    profile: input.profile,
    session: input.session,
    workspace: input.workspace,
    signal: input.signal,
    operation: async (client, initialized) => {
      const response = await client.request("session/fork", sessionRequestParams(input.profile, input.profile.cwd, input.session.sessionId), DEFAULT_REQUEST_TIMEOUT_MS);
      const forkedId = responseSessionId(response);
      if (!forkedId) throw new HermesAcpNativeCapabilityError("unknown", "Hermes ACP session/fork returned no session identity.");
      return { forkedId, handshake: initialized };
    },
  });
  const forkedId = fork.forkedId;
  const sessionParams = buildHermesAcpSessionParams({
    sessionId: forkedId,
    profile: input.profile,
    providerVersion: fork.handshake.providerVersion ?? input.profile.providerVersion ?? null,
    protocolVersion: fork.handshake.protocolVersion ?? input.profile.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
    workspace: input.workspace,
  });
  return {
    session: { sessionId: forkedId, sessionParams, sessionDisplayId: forkedId },
    boundary: forkedId,
    sourceBoundary: input.boundary,
    identityMap: { [input.session.sessionId]: forkedId },
    continuity: "native",
  };
}
