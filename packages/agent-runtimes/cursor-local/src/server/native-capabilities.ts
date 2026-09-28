import type {
  AgentRuntimeApprovalDecision,
  AgentRuntimeApprovalRequest,
  AgentRuntimeControlHandle,
  AgentRuntimeControlHandleLease,
  AgentRuntimeControlInterruptReason,
  AgentRuntimeControlInterruptResult,
  AgentRuntimeControlSteerInput,
  AgentRuntimeControlSteerResult,
  AgentRuntimeExecutionContext,
  AgentRuntimeExecutionResult,
  ChatAskUserRequest,
  ChatAskUserResponse,
} from "@rudderhq/agent-runtime-utils";
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

export type CursorCapabilityStatus = "supported" | "unsupported" | "unknown";

export type CursorCapabilityEvidence = {
  status: CursorCapabilityStatus;
  reason: string;
  providerVersion?: string | null;
  transport?: string | null;
  profileBound: boolean;
  profileRequired?: boolean;
};

export type CursorProviderBindingRef = {
  id?: string | null;
  orgId?: string | null;
  hostId: string;
  profileId: string;
  workspaceBindingId?: string | null;
  capabilityRevision?: string | null;
};

export type CursorProviderSessionRef = {
  sessionId: string;
  sessionParams: Record<string, unknown>;
  sessionDisplayId: string;
};

export type CursorWorkspaceIdentity = {
  workspaceId?: string | null;
  repoUrl?: string | null;
  repoRef?: string | null;
  workspaceBindingId?: string | null;
};

export type CursorAcpMcpServer = Record<string, unknown>;

export type CursorTranscriptRange = {
  start?: string | number | { itemId?: string | null; ordinal?: number | null } | null;
  end?: string | number | { itemId?: string | null; ordinal?: number | null } | null;
  fromExclusive?: string | number | { itemId?: string | null; ordinal?: number | null } | null;
  throughInclusive?: string | number | { itemId?: string | null; ordinal?: number | null } | null;
  itemId?: string | null;
};

export type CursorNativeTranscriptRawItem = {
  id: string;
  sourceEntryId: string;
  ordinal: number;
  kind: string;
  ts: string;
  payload: Record<string, unknown>;
  origin: "native";
  visibility: "visible";
  text?: string;
};

export type CursorNativeTranscriptReadRequest = {
  runtimeType: string;
  session: CursorProviderSessionRef;
  selector?: Record<string, unknown> | null;
  binding?: CursorProviderBindingRef | null;
  workspace?: CursorWorkspaceIdentity | null;
  range?: CursorTranscriptRange | null;
  from?: string | null;
  through?: string | null;
  cursor?: string | null;
  signal?: AbortSignal;
};

export type CursorNativeTranscriptReadResult = {
  items: readonly CursorNativeTranscriptRawItem[];
  nextCursor: string | null;
  source: "native";
  revision: string;
  availability: "available" | "offline" | "missing" | "expired" | "incompatible";
  completeness: "complete" | "partial" | "terminal_only" | "unknown";
};

type JsonRecord = Record<string, unknown>;
type CursorAcpProcess = ChildProcessWithoutNullStreams;
const CURSOR_SENSITIVE_FIELD = /(?:^|[-_])(?:authorization|proxy[-_]authorization|api[-_]?key|auth[-_]?token|access[-_]?token|refresh[-_]?token|session[-_]?token|token|password|secret|credential|cookie)(?:s|field|value|header)?(?:$|[-_])/i;
const CURSOR_SENSITIVE_TEXT_ASSIGNMENT = /((?:authorization|proxy[-_]authorization|api[-_]?key|auth[-_]?token|access[-_]?token|refresh[-_]?(?:token|key)|session[-_]?token|token|password|secret|credential|cookie)\s*[:=]\s*)(?:bearer\s+)?[^\s,;}'\"]+/gi;

/**
 * Credentials and the profile-owned environment stay in this closure. They
 * are intentionally not copied to Cursor sessionParams/providerStateJson.
 */
export type CursorLocalProfileTransport = {
  binding: CursorProviderBindingRef;
  command?: string;
  cwd: string;
  providerVersion: string;
  mcpServers?: readonly CursorAcpMcpServer[];
  env?: NodeJS.ProcessEnv;
  authMethodId?: string;
  protocolVersion?: number;
  requestTimeoutMs?: number;
  spawn?: typeof nodeSpawn;
};

export type CursorLocalProfileTransportResolver = (
  binding: CursorProviderBindingRef,
) => CursorLocalProfileTransport | null | undefined;

export type CursorNativeFailureKind =
  | "auth-required"
  | "missing-session"
  | "protocol-mismatch"
  | "transport-error"
  | "unsupported";

export class CursorNativeCapabilityError extends Error {
  override readonly name = "CursorNativeCapabilityError";

  constructor(
    readonly status: Exclude<CursorCapabilityStatus, "supported">,
    readonly kind: CursorNativeFailureKind,
    message: string,
  ) {
    super(message);
  }
}

class CursorAcpTimeoutError extends CursorNativeCapabilityError {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super("unknown", "transport-error", `Cursor ACP ${method} timed out after ${timeoutMs}ms.`);
  }
}

class CursorAcpRpcError extends Error {
  override readonly name = "CursorAcpRpcError";

  constructor(
    readonly code: number | string | null,
    message: string,
    readonly method: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

class CursorAcpMethodNotFoundError extends Error {
  override readonly name = "CursorAcpMethodNotFoundError";
}

type CursorAcpProviderError = { code: number; message: string };
type CursorAcpProviderResponse =
  | { result: unknown }
  | { error: CursorAcpProviderError };

const CURSOR_RPC_METHOD_NOT_FOUND = -32601;
const CURSOR_RPC_INTERNAL_ERROR = -32603;
const CURSOR_PROFILE_CAPABILITY_CACHE_SIZE = 128;

const CURSOR_ACP_PROTOCOL_VERSION = 1;
const CURSOR_NATIVE_PAGE_SIZE = 100;
const CURSOR_NATIVE_CLIENT_VERSION = "rudder-native-capabilities";
const CURSOR_DEFAULT_COMMAND = "agent";
const CURSOR_EXTENSION_APPROVAL_TIMEOUT_MS = 10 * 60_000;

export const CURSOR_NATIVE_TRANSPORT = "cursor-agent-acp-stdio";

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function recordValue(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

export function normalizeCursorAcpMcpServers(value: unknown): CursorAcpMcpServer[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new CursorNativeCapabilityError(
      "unsupported",
      "unsupported",
      "Cursor ACP MCP configuration must be an array of HTTP or SSE servers.",
    );
  }
  const names = new Set<string>();
  return value.map((candidate, index) => {
    const server = recordValue(candidate);
    const name = stringValue(server?.name);
    const url = stringValue(server?.url);
    const transport = stringValue(server?.transport ?? server?.type)?.toLowerCase();
    if (!server || !name || !url || names.has(name)) {
      throw new CursorNativeCapabilityError(
        "unsupported",
        "unsupported",
        `Cursor ACP MCP server ${index + 1} must have a unique name and HTTP/SSE URL.`,
      );
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new CursorNativeCapabilityError("unsupported", "unsupported", `Cursor ACP MCP server ${name} has an invalid URL.`);
    }
    if (!(parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") || (transport && transport !== "http" && transport !== "sse")) {
      throw new CursorNativeCapabilityError(
        "unsupported",
        "unsupported",
        `Cursor ACP only advertises HTTP/SSE MCP transport; server ${name} is not supported.`,
      );
    }
    names.add(name);
    return server;
  });
}

function stableHash(value: unknown): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}

function canonicalUpdate(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalUpdate);
  const record = recordValue(value);
  if (!record) return value;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalUpdate(record[key])]));
}

function profileSecrets(profile: CursorLocalProfileTransport): string[] {
  const values: string[] = [];
  const add = (value: unknown) => {
    const text = stringValue(value);
    if (!text) return;
    values.push(text, text.replace(/^bearer\s+/i, ""));
  };
  for (const [key, value] of Object.entries({ ...process.env, ...(profile.env ?? {}) })) {
    if (CURSOR_SENSITIVE_FIELD.test(key)) add(value);
  }
  for (const server of profile.mcpServers ?? []) {
    for (const field of ["env", "headers"]) {
      for (const [key, value] of Object.entries(recordValue(server[field]) ?? {})) {
        if (CURSOR_SENSITIVE_FIELD.test(key)) add(value);
      }
    }
  }
  return [...new Set(values.filter(Boolean))];
}

function redactProviderValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    const redacted = secrets.reduce((safe, secret) => secret ? safe.split(secret).join("[REDACTED]") : safe, value);
    return redacted.replace(CURSOR_SENSITIVE_TEXT_ASSIGNMENT, "$1[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((entry) => redactProviderValue(entry, secrets));
  const record = recordValue(value);
  if (!record) return value;
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [
    key,
    CURSOR_SENSITIVE_FIELD.test(key) ? "[REDACTED]" : redactProviderValue(child, secrets),
  ]));
}

function diagnosticText(value: unknown, secrets: readonly string[] = []): string {
  const text = value instanceof Error ? value.message : String(value);
  return String(redactProviderValue(text, secrets))
    .replace(/https?:\/\/[^\s"'<>]+/giu, "[URL REDACTED]")
    .slice(0, 2_000);
}

function safeAuthMethodDiagnostic(
  advertisedAuthMethodIds: readonly string[],
  chosenAuthMethodId: string | null,
  secrets: readonly string[],
): CursorAcpAuthMethodDiagnostic {
  const safeId = (id: string) => {
    if (id.length > 128) return "[REDACTED]";
    const safe = diagnosticText(id, secrets);
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(safe) ? safe : "[REDACTED]";
  };
  return {
    advertisedAuthMethodIds: advertisedAuthMethodIds.slice(0, 32).map(safeId),
    chosenAuthMethodId: chosenAuthMethodId ? safeId(chosenAuthMethodId) : null,
  };
}

function bindingMatches(requested: CursorProviderBindingRef, profile: CursorLocalProfileTransport): boolean {
  return profile.binding.hostId.trim() === requested.hostId.trim()
    && profile.binding.profileId.trim() === requested.profileId.trim()
    && (!requested.capabilityRevision
      || !profile.binding.capabilityRevision
      || requested.capabilityRevision === profile.binding.capabilityRevision);
}

function profileIdentityMatches(params: JsonRecord, binding: CursorProviderBindingRef): boolean {
  const storedHost = stringValue(params.profileHostId ?? params.providerHostId ?? params.hostId);
  const storedProfile = stringValue(params.profileId ?? params.providerProfileId);
  const storedRevision = stringValue(params.capabilityRevision);
  return (!storedHost || storedHost === binding.hostId)
    && (!storedProfile || storedProfile === binding.profileId)
    && (!storedRevision || !binding.capabilityRevision || storedRevision === binding.capabilityRevision);
}

function resolveSessionCwd(params: JsonRecord): string | null {
  return stringValue(params.cwd ?? params.workdir ?? params.folder);
}

function nativeResumeMismatch(input: {
  sessionId: string;
  params: JsonRecord;
  profile: CursorLocalProfileTransport;
  binding: CursorProviderBindingRef;
  workspace?: CursorWorkspaceIdentity | null;
}): string | null {
  const storedSessionId = stringValue(input.params.sessionId ?? input.params.session_id);
  if (storedSessionId !== input.sessionId) return "session-id-mismatch";
  const storedHost = stringValue(input.params.profileHostId ?? input.params.providerHostId ?? input.params.hostId);
  if (storedHost !== input.binding.hostId.trim()) return "profile-mismatch";
  const storedProfile = stringValue(input.params.profileId ?? input.params.providerProfileId);
  if (storedProfile !== input.binding.profileId.trim()) return "profile-mismatch";
  const storedRevision = stringValue(input.params.capabilityRevision);
  if (input.binding.capabilityRevision && storedRevision !== input.binding.capabilityRevision) return "capability-revision-mismatch";
  if (storedRevision && !input.binding.capabilityRevision) return "capability-revision-mismatch";
  if (stringValue(input.params.cursorAcpTransport) !== CURSOR_NATIVE_TRANSPORT) return "transport-mismatch";
  const command = input.profile.command?.trim() || CURSOR_DEFAULT_COMMAND;
  if (stringValue(input.params.cursorAcpCommand) !== command) return "command-mismatch";
  const protocol = input.profile.protocolVersion ?? CURSOR_ACP_PROTOCOL_VERSION;
  if (input.params.cursorAcpProtocolVersion !== protocol) return "protocol-version-mismatch";
  const storedAuthMethod = stringValue(input.params.cursorAcpAuthMethodId);
  const configuredAuthMethod = stringValue(input.profile.authMethodId);
  if (storedAuthMethod && configuredAuthMethod && storedAuthMethod !== configuredAuthMethod) return "auth-method-mismatch";
  if (stringValue(input.params.cursorProviderVersion) !== stringValue(input.profile.providerVersion)) return "provider-version-mismatch";
  const storedCwd = resolveSessionCwd(input.params);
  if (!storedCwd || path.resolve(storedCwd) !== path.resolve(input.profile.cwd)) return "session-cwd-mismatch";
  const workspaceFields = ["workspaceId", "repoUrl", "repoRef", "workspaceBindingId"] as const;
  if (input.workspace) {
    for (const field of workspaceFields) {
      const expected = stringValue(input.workspace[field]);
      const stored = stringValue(input.params[field]);
      if (expected !== stored) return "workspace-mismatch";
    }
  }
  if (input.binding.workspaceBindingId && stringValue(input.params.workspaceBindingId) !== input.binding.workspaceBindingId) {
    return "workspace-binding-mismatch";
  }
  return null;
}

function textFrom(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) {
    const text = value.map(textFrom).filter((entry): entry is string => Boolean(entry)).join("\n");
    return text || undefined;
  }
  const record = recordValue(value);
  if (!record) return undefined;
  const direct = stringValue(record.text);
  if (direct) return direct;
  return textFrom(record.content ?? record.entries ?? record.title);
}

function boundaryValue(
  value: string | number | { itemId?: string | null; ordinal?: number | null } | null | undefined,
): { id: string | null; ordinal: number | null } {
  if (typeof value === "string") return { id: value, ordinal: null };
  if (typeof value === "number" && Number.isFinite(value)) return { id: null, ordinal: value };
  if (value && typeof value === "object") {
    return {
      id: stringValue(value.itemId),
      ordinal: typeof value.ordinal === "number" && Number.isFinite(value.ordinal) ? value.ordinal : null,
    };
  }
  return { id: null, ordinal: null };
}

const CURSOR_EXECUTION_BOUNDARY_FIELDS = [
  "executionRef",
  "execution_ref",
  "executionId",
  "execution_id",
  "providerExecutionRef",
  "provider_execution_ref",
  "turnId",
  "turn_id",
  "runId",
  "run_id",
] as const;
const CURSOR_NATIVE_RANGE_FIELDS = [
  "nativeRangeRef",
  "native_range_ref",
  "rangeRef",
  "range_ref",
  "rangeId",
  "range_id",
  "sourceRangeRef",
  "source_range_ref",
] as const;

type CursorUpdateBoundaryEvidence = {
  executionRef: string | null;
  nativeRangeRef: string | null;
  hasExecutionRef: boolean;
  hasNativeRangeRef: boolean;
  ambiguous: boolean;
};

type IndexedCursorUpdate = {
  update: JsonRecord;
  ordinal: number;
};

type CursorRunSelector = {
  sessionId: string;
  executionRef: string | null;
  nativeRangeRef: string | null;
};

type CursorBoundaryResolution = {
  status: "ok" | "missing" | "ambiguous";
  selector?: CursorRunSelector;
  reason: string;
};

type CursorPromptBoundaryResolution = {
  status: "ok" | "missing" | "ambiguous";
  executionRef: string | null;
  nativeRangeRef: string | null;
  reason: string;
};

function explicitBoundaryValue(
  records: readonly JsonRecord[],
  fields: readonly string[],
): { value: string | null; present: boolean; ambiguous: boolean } {
  const values = [...new Set(records.flatMap((record) => fields
    .map((field) => stringValue(record[field]))
    .filter((value): value is string => Boolean(value))))];
  return {
    value: values.length === 1 ? values[0] : null,
    present: values.length > 0,
    ambiguous: values.length > 1,
  };
}

/**
 * Only explicit ACP/provider boundary fields are accepted here. Update order,
 * timestamps, message text, and generic event IDs are not Run attribution.
 */
function updateBoundaryEvidence(update: JsonRecord): CursorUpdateBoundaryEvidence {
  const records = [
    update,
    recordValue(update._meta),
    recordValue(update.meta),
    recordValue(update.boundary),
  ].filter((record): record is JsonRecord => Boolean(record));
  const execution = explicitBoundaryValue(records, CURSOR_EXECUTION_BOUNDARY_FIELDS);
  const nativeRange = explicitBoundaryValue(records, CURSOR_NATIVE_RANGE_FIELDS);
  return {
    executionRef: execution.value,
    nativeRangeRef: nativeRange.value,
    hasExecutionRef: execution.present,
    hasNativeRangeRef: nativeRange.present,
    ambiguous: execution.ambiguous || nativeRange.ambiguous,
  };
}

function persistedRunSelector(
  sessionId: string,
  selectorValue: Record<string, unknown> | null | undefined,
): CursorBoundaryResolution {
  if (!selectorValue) {
    return { status: "missing", reason: "Cursor transcript read has no persisted Run range selector." };
  }
  const kind = stringValue(selectorValue.kind);
  if (kind && kind !== "cursor_execution") {
    return { status: "ambiguous", reason: `Cursor transcript selector kind ${kind} is not a cursor execution selector.` };
  }
  const selectorSessionId = stringValue(selectorValue.sessionId);
  if (!selectorSessionId || selectorSessionId !== sessionId) {
    return { status: "ambiguous", reason: "Cursor transcript selector session identity is missing or does not match the loaded session." };
  }
  const executionRef = stringValue(selectorValue.executionRef);
  const nativeRangeRef = stringValue(selectorValue.nativeRangeRef);
  if (!executionRef && !nativeRangeRef) {
    return { status: "missing", reason: "Cursor transcript selector has no persisted executionRef or nativeRangeRef." };
  }
  return {
    status: "ok",
    selector: { sessionId, executionRef, nativeRangeRef },
    reason: "",
  };
}

function selectRunUpdates(
  sessionId: string,
  updates: readonly JsonRecord[],
  selectorValue: Record<string, unknown> | null | undefined,
): CursorBoundaryResolution & { updates?: readonly IndexedCursorUpdate[] } {
  const selector = persistedRunSelector(sessionId, selectorValue);
  if (selector.status !== "ok" || !selector.selector) return selector;
  if (updates.length === 0) {
    return { status: "missing", selector: selector.selector, reason: "Cursor ACP replay returned no updates with which to prove the persisted Run range." };
  }

  const indexed = updates.map((update, ordinal) => ({ update, ordinal }));
  const evidence = indexed.map(({ update }) => updateBoundaryEvidence(update));
  if (evidence.some((boundary) => boundary.ambiguous)) {
    return {
      status: "ambiguous",
      selector: selector.selector,
      reason: "Cursor ACP replay contains conflicting explicit execution/range boundary evidence.",
    };
  }
  if (selector.selector.executionRef && evidence.some((boundary) => !boundary.hasExecutionRef)) {
    return {
      status: "ambiguous",
      selector: selector.selector,
      reason: "Cursor ACP replay does not expose an explicit execution boundary for every update in the loaded session.",
    };
  }
  if (selector.selector.nativeRangeRef && evidence.some((boundary) => !boundary.hasNativeRangeRef)) {
    return {
      status: "ambiguous",
      selector: selector.selector,
      reason: "Cursor ACP replay does not expose an explicit native range boundary for every update in the loaded session.",
    };
  }

  const selected = indexed.filter(({ update }) => {
    const boundary = updateBoundaryEvidence(update);
    return (!selector.selector?.executionRef || boundary.executionRef === selector.selector.executionRef)
      && (!selector.selector?.nativeRangeRef || boundary.nativeRangeRef === selector.selector.nativeRangeRef);
  });
  if (selected.length === 0) {
    return {
      status: "missing",
      selector: selector.selector,
      reason: "Cursor ACP replay contains no update with the persisted Run execution/range boundary.",
    };
  }
  return { status: "ok", selector: selector.selector, reason: "", updates: selected };
}

/**
 * A completed ACP prompt is attributable to one Run only when every update
 * emitted for that prompt carries the same explicit execution boundary. The
 * provider may omit the optional native range, but it may not omit or change
 * the execution identity without making the Run unresolved.
 */
function resolvePromptBoundary(updates: readonly JsonRecord[]): CursorPromptBoundaryResolution {
  if (updates.length === 0) {
    return {
      status: "missing",
      executionRef: null,
      nativeRangeRef: null,
      reason: "Cursor ACP prompt completed without emitting an explicit execution boundary.",
    };
  }
  const evidence = updates.map(updateBoundaryEvidence);
  if (evidence.some((boundary) => boundary.ambiguous)) {
    return {
      status: "ambiguous",
      executionRef: null,
      nativeRangeRef: null,
      reason: "Cursor ACP prompt emitted conflicting explicit execution/range boundary evidence.",
    };
  }
  const executionRefs = [...new Set(evidence
    .map((boundary) => boundary.executionRef)
    .filter((value): value is string => Boolean(value)))];
  if (executionRefs.length === 0 || evidence.some((boundary) => !boundary.hasExecutionRef)) {
    return {
      status: "missing",
      executionRef: null,
      nativeRangeRef: null,
      reason: "Cursor ACP prompt did not expose an explicit executionRef for every update.",
    };
  }
  if (executionRefs.length !== 1) {
    return {
      status: "ambiguous",
      executionRef: null,
      nativeRangeRef: null,
      reason: "Cursor ACP prompt updates point to more than one executionRef.",
    };
  }

  const nativeRangeRefs = [...new Set(evidence
    .map((boundary) => boundary.nativeRangeRef)
    .filter((value): value is string => Boolean(value)))];
  if (nativeRangeRefs.length > 1 || (nativeRangeRefs.length === 1 && evidence.some((boundary) => !boundary.hasNativeRangeRef))) {
    return {
      status: "ambiguous",
      executionRef: null,
      nativeRangeRef: null,
      reason: "Cursor ACP prompt updates expose an incomplete or conflicting nativeRangeRef.",
    };
  }
  return {
    status: "ok",
    executionRef: executionRefs[0],
    nativeRangeRef: nativeRangeRefs[0] ?? null,
    reason: "",
  };
}

function applyRange(
  items: CursorNativeTranscriptRawItem[],
  range: CursorTranscriptRange | null | undefined,
): { items: CursorNativeTranscriptRawItem[]; reason?: string } {
  if (!range) return { items };
  if (range.itemId) {
    const selected = items.filter((item) => item.id === range.itemId || item.sourceEntryId === range.itemId);
    return selected.length === 1
      ? { items: selected }
      : { items: [], reason: selected.length === 0 ? "requested transcript item boundary is missing" : "requested transcript item boundary is ambiguous" };
  }
  const start = boundaryValue(range.start ?? range.fromExclusive);
  const end = boundaryValue(range.end ?? range.throughInclusive);
  let selected = items;
  if (start.id) {
    const index = selected.findIndex((item) => item.id === start.id || item.sourceEntryId === start.id);
    if (index < 0) return { items: [], reason: "requested transcript start boundary is missing" };
    selected = selected.slice(range.fromExclusive !== undefined ? index + 1 : index);
  } else if (start.ordinal !== null) {
    selected = selected.filter((item) => item.ordinal >= start.ordinal! + (range.fromExclusive !== undefined ? 1 : 0));
  }
  if (end.id) {
    const index = selected.findIndex((item) => item.id === end.id || item.sourceEntryId === end.id);
    if (index < 0) return { items: [], reason: "requested transcript end boundary is missing" };
    selected = selected.slice(0, index + 1);
  } else if (end.ordinal !== null) {
    selected = selected.filter((item) => item.ordinal <= end.ordinal!);
  }
  return { items: selected };
}

function decodeCursor(cursor: string | null | undefined, revision: string): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { revision?: string; offset?: number };
    return parsed.revision === revision && Number.isInteger(parsed.offset) && parsed.offset! >= 0 ? parsed.offset! : 0;
  } catch {
    return 0;
  }
}

function encodeCursor(revision: string, offset: number): string {
  return Buffer.from(JSON.stringify({ revision, offset }), "utf8").toString("base64url");
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const record = recordValue(value);
  if (!record) return "";
  return stringValue(record.message ?? record.error ?? record.detail ?? record.code) ?? "";
}

function normalizeRpcFailure(error: unknown, operation: string, secrets: readonly string[] = []): CursorNativeCapabilityError {
  if (error instanceof CursorNativeCapabilityError) return error;
  if (error instanceof CursorAcpRpcError) {
    const message = diagnosticText(error.message, secrets);
    if (/authentication required|not authenticated|run ['`]?agent login|cursor_login/i.test(message)) {
      return new CursorNativeCapabilityError("unknown", "auth-required", `Cursor ACP ${operation} requires Cursor authentication: ${message}`);
    }
    if (/unknown (?:session|chat)|(?:session|chat).*(?:not found|does not exist)|could not load session/i.test(message)) {
      return new CursorNativeCapabilityError("unknown", "missing-session", `Cursor ACP ${operation} could not load the requested session: ${message}`);
    }
    if (error.code === -32601 || /method not found|unsupported/i.test(message)) {
      return new CursorNativeCapabilityError("unsupported", "unsupported", `Cursor ACP ${operation} is unsupported: ${message}`);
    }
    return new CursorNativeCapabilityError("unknown", "protocol-mismatch", `Cursor ACP ${operation} failed: ${message}`);
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return new CursorNativeCapabilityError("unknown", "transport-error", `Cursor ACP ${operation} timed out: ${error.message}`);
  }
  return new CursorNativeCapabilityError(
    "unknown",
    "transport-error",
    `Cursor ACP ${operation} transport failed: ${diagnosticText(error, secrets)}`,
  );
}

function providerRequestError(error: unknown, secrets: readonly string[]): CursorAcpProviderError {
  if (error instanceof CursorAcpMethodNotFoundError) {
    return { code: CURSOR_RPC_METHOD_NOT_FOUND, message: error.message };
  }
  return {
    code: CURSOR_RPC_INTERNAL_ERROR,
    // Provider-facing errors must not echo approval/runtime diagnostics.
    message: "Cursor ACP client request failed.",
  };
}

function requireLoadedCursorSession(value: unknown, sessionId: string): JsonRecord {
  const loaded = recordValue(value);
  if (!loaded || Object.keys(loaded).length === 0) {
    throw new CursorNativeCapabilityError(
      "unsupported",
      "protocol-mismatch",
      `Cursor ACP session/load returned no session state for ${sessionId}; refusing to prompt a missing persisted session.`,
    );
  }
  const loadedSessionId = stringValue(loaded.sessionId ?? loaded.session_id);
  if (loadedSessionId && loadedSessionId !== sessionId) {
    throw new CursorNativeCapabilityError(
      "unsupported",
      "protocol-mismatch",
      `Cursor ACP session/load acknowledged ${loadedSessionId} instead of ${sessionId}.`,
    );
  }
  return loaded;
}

type CursorAcpMessage = {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

type CursorAcpRequestId = string | number;
type CursorAcpProviderRequestState = {
  requestIdentity: string;
  status: "pending" | "completed";
};

function cursorAcpRequestIdentity(message: CursorAcpMessage): string {
  const request = { ...(recordValue(message) ?? {}) };
  delete request.id;
  return stableHash(canonicalUpdate(request));
}

type CursorAcpRequestMethod = "initialize" | "authenticate" | "session/new" | "session/load"
  | "session/set_model" | "session/set_mode" | "session/prompt";
type CursorAcpAuthMethodDiagnostic = {
  advertisedAuthMethodIds: string[];
  chosenAuthMethodId: string | null;
};
type CursorAcpRequestDiagnostic = {
  method: CursorAcpRequestMethod;
  status: "started" | "completed" | "failed" | "timed_out";
  durationMs: number;
  errorCode?: number | string | null;
  errorMessage?: string;
  errorDataMessage?: string;
  advertisedAuthMethodIds?: string[];
  chosenAuthMethodId?: string | null;
};

class CursorAcpClient {
  private readonly pending = new Map<number, { method: CursorAcpRequestMethod; resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }>();
  private readonly child: CursorAcpProcess;
  private readonly timeoutMs: number;
  private nextRequestId = 1;
  private buffer = "";
  private closed = false;
  private readonly providerRequests = new Map<CursorAcpRequestId, CursorAcpProviderRequestState>();
  private readonly requestDiagnostics: CursorAcpRequestDiagnostic[] = [];

  constructor(
    private readonly profile: CursorLocalProfileTransport,
    private readonly onNotification: (message: CursorAcpMessage) => void,
    signal?: AbortSignal,
    private readonly onRequest?: (method: string, params: JsonRecord, id: string | number) => Promise<unknown>,
  ) {
    this.timeoutMs = Math.max(250, profile.requestTimeoutMs ?? 15_000);
    const command = profile.command?.trim() || CURSOR_DEFAULT_COMMAND;
    const spawn = profile.spawn ?? nodeSpawn;
    this.child = spawn(command, ["acp"], {
      cwd: profile.cwd,
      env: { ...process.env, ...(profile.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: Buffer | string) => this.consume(chunk.toString()));
    this.child.stderr.on("data", () => {
      // Drain provider diagnostics without persisting credentials from stderr.
    });
    this.child.on("error", (error) => this.failPending(normalizeRpcFailure(error, "process", profileSecrets(profile))));
    this.child.on("close", () => {
      this.closed = true;
      this.failPending(new CursorNativeCapabilityError(
        "unknown",
        "transport-error",
        "Cursor ACP process closed before completing a request.",
      ));
    });
    if (signal) {
      const abort = () => {
        this.failPending(new CursorNativeCapabilityError("unknown", "transport-error", "Cursor ACP request was aborted."));
        this.close();
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
  }

  request(
    method: CursorAcpRequestMethod,
    params: JsonRecord,
    timeoutMs = this.timeoutMs,
    authMethodDiagnostic?: CursorAcpAuthMethodDiagnostic,
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new CursorNativeCapabilityError("unknown", "transport-error", "Cursor ACP process is closed."));
    const id = this.nextRequestId++;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const startedAt = performance.now();
    const diagnostic: CursorAcpRequestDiagnostic = {
      method,
      status: "started",
      durationMs: 0,
      ...(method === "authenticate" && authMethodDiagnostic ? {
        advertisedAuthMethodIds: [...authMethodDiagnostic.advertisedAuthMethodIds],
        chosenAuthMethodId: authMethodDiagnostic.chosenAuthMethodId,
      } : {}),
    };
    const captureError = (error: unknown) => {
      diagnostic.errorCode = error instanceof CursorAcpRpcError ? error.code : null;
      diagnostic.errorMessage = diagnosticText(error, profileSecrets(this.profile));
      const dataMessage = error instanceof CursorAcpRpcError
        ? stringValue(recordValue(error.data)?.message)
        : null;
      if (dataMessage) diagnostic.errorDataMessage = diagnosticText(dataMessage, profileSecrets(this.profile));
    };
    this.requestDiagnostics.push(diagnostic);
    if (this.requestDiagnostics.length > 16) this.requestDiagnostics.shift();
    return new Promise((resolve, reject) => {
      const finish = (status: CursorAcpRequestDiagnostic["status"]) => {
        diagnostic.status = status;
        diagnostic.durationMs = Math.max(0, Math.round(performance.now() - startedAt));
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new CursorAcpTimeoutError(method, timeoutMs);
        captureError(error);
        finish("timed_out");
        reject(error);
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => { finish("completed"); resolve(value); },
        reject: (error) => { captureError(error); finish("failed"); reject(error); },
        timer,
      });
      try {
        this.child.stdin.write(`${message}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        const failure = normalizeRpcFailure(error, method, profileSecrets(this.profile));
        captureError(failure);
        finish("failed");
        reject(failure);
      }
    });
  }

  get requestTrace(): CursorAcpRequestDiagnostic[] {
    return this.requestDiagnostics.map((diagnostic) => ({
      ...diagnostic,
      ...(diagnostic.advertisedAuthMethodIds
        ? { advertisedAuthMethodIds: [...diagnostic.advertisedAuthMethodIds] }
        : {}),
    }));
  }

  get pid(): number | null {
    return typeof this.child.pid === "number" ? this.child.pid : null;
  }

  notify(method: string, params: JsonRecord): void {
    if (this.closed) throw new Error("Cursor ACP connection is closed");
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  close(error: unknown = new Error("Cursor ACP connection was closed")): void {
    this.closed = true;
    this.failPending(error);
    if (this.child.exitCode === null && !this.child.killed) {
      this.child.stdin.end();
      this.child.kill("SIGTERM");
    }
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: CursorAcpMessage;
      try {
        parsed = JSON.parse(trimmed) as CursorAcpMessage;
      } catch {
        this.failPending(new CursorNativeCapabilityError("unknown", "protocol-mismatch", "Cursor ACP emitted a non-JSON response."));
        continue;
      }
      if (typeof parsed.method === "string"
        && Object.prototype.hasOwnProperty.call(parsed, "id")
        && typeof parsed.id !== "string"
        && typeof parsed.id !== "number") {
        this.close(new CursorNativeCapabilityError(
          "unsupported",
          "protocol-mismatch",
          "Cursor ACP used an unsupported server request ID type; refusing ambiguous correlation.",
        ));
        continue;
      }
      if (typeof parsed.method === "string" && typeof parsed.id === "number" && !Number.isSafeInteger(parsed.id)) {
        this.close(new CursorNativeCapabilityError(
          "unsupported",
          "protocol-mismatch",
          "Cursor ACP used a non-safe-integer numeric server request ID; refusing ambiguous correlation.",
        ));
        continue;
      }
      // JSON-RPC request IDs are scoped to the sender. A provider request may
      // reuse one of our pending IDs; it must never resolve that request.
      if (typeof parsed.method === "string" && (typeof parsed.id === "string" || typeof parsed.id === "number")) {
        const requestId: CursorAcpRequestId = parsed.id;
        const requestIdentity = cursorAcpRequestIdentity(parsed);
        const previous = this.providerRequests.get(requestId);
        if (previous) {
          const reuse = previous.requestIdentity === requestIdentity
            ? "replayed"
            : "reused with a different request identity";
          this.close(new CursorNativeCapabilityError(
            "unsupported",
            "protocol-mismatch",
            `Cursor ACP ${reuse} server request ID ${JSON.stringify(requestId)}; terminating the connection to prevent approval response miscorrelation.`,
          ));
          continue;
        }
        const requestState: CursorAcpProviderRequestState = { requestIdentity, status: "pending" };
        this.providerRequests.set(requestId, requestState);
        const method = parsed.method;
        const response = Promise.resolve().then(async () => {
          if (this.closed || this.providerRequests.get(requestId) !== requestState) {
            throw new Error("Cursor ACP request correlation was invalidated.");
          }
          if (!this.onRequest) throw new CursorAcpMethodNotFoundError("Cursor ACP client method is not supported.");
          return this.onRequest(method, recordValue(parsed.params) ?? {}, requestId);
        }).then(
          (result): CursorAcpProviderResponse => ({ result: result === undefined ? null : result }),
          (error): CursorAcpProviderResponse => ({ error: providerRequestError(error, profileSecrets(this.profile)) }),
        );
        void response.then((resolved) => {
          this.writeProviderResponse(requestId, requestIdentity, requestState, resolved);
        });
        continue;
      }
      const id = typeof parsed.id === "number" ? parsed.id : null;
      if (id !== null && this.pending.has(id)) {
        const pending = this.pending.get(id)!;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (parsed.error) {
          const error = recordValue(parsed.error);
          pending.reject(new CursorAcpRpcError(
            typeof error?.code === "number" || typeof error?.code === "string" ? error.code : null,
            errorText(error) || "Cursor ACP returned an error.",
            pending.method,
            error?.data,
          ));
        } else {
          pending.resolve(parsed.result);
        }
        continue;
      }
      if (typeof parsed.method === "string") this.onNotification(parsed);
    }
  }

  private failPending(error: unknown): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private writeProviderResponse(
    requestId: CursorAcpRequestId,
    requestIdentity: string,
    requestState: CursorAcpProviderRequestState,
    response: CursorAcpProviderResponse,
  ): void {
    if (this.closed
      || this.providerRequests.get(requestId) !== requestState
      || requestState.requestIdentity !== requestIdentity
      || requestState.status !== "pending") return;
    requestState.status = "completed";
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, ...response })}\n`);
    } catch {
      this.close();
    }
  }
}

function itemsFromUpdates(
  sessionId: string,
  updates: readonly JsonRecord[],
  secrets: readonly string[],
  revision: string,
  sourceOrdinals?: readonly number[],
): CursorNativeTranscriptRawItem[] {
  const safeUpdates = updates.map((update) => recordValue(redactProviderValue(update, secrets)) ?? {});
  const identities = safeUpdates.map((update) => stableHash({ sessionId, update: canonicalUpdate(update) }));
  const counts = new Map<string, number>();
  for (const identity of identities) counts.set(identity, (counts.get(identity) ?? 0) + 1);
  return safeUpdates.map((safeUpdate, index) => {
    const ordinal = sourceOrdinals?.[index] ?? index;
    const sessionUpdate = stringValue(safeUpdate.sessionUpdate) ?? "unknown";
    const identity = identities[index]!;
    // Identical updates have no provider occurrence ID. Keep both visible, but
    // bind their IDs to this replay revision; they must not become anchors.
    const sourceEntryId = counts.get(identity)! > 1
      ? `acp:replay-window:${revision}:${ordinal}`
      : `acp:update:${identity}`;
    const text = textFrom(safeUpdate.content ?? safeUpdate.entries ?? safeUpdate.title);
    const meta = recordValue(safeUpdate._meta);
    const ts = stringValue(safeUpdate.ts ?? safeUpdate.timestamp ?? meta?.timestamp) ?? "";
    return {
      id: `cursor:${sourceEntryId}`,
      sourceEntryId,
      ordinal,
      kind: `cursor:acp:${sessionUpdate}`,
      ts,
      payload: {
        provider: "cursor_agent",
        transport: CURSOR_NATIVE_TRANSPORT,
        method: "session/update",
        sessionId,
        update: safeUpdate,
      },
      origin: "native",
      visibility: "visible",
      ...(text ? { text } : {}),
    };
  });
}

function requestedRange(input: CursorNativeTranscriptReadRequest): CursorTranscriptRange | null {
  if (input.range) return input.range;
  if (input.from !== null && input.from !== undefined || input.through !== null && input.through !== undefined) {
    return {
      ...(input.from !== null && input.from !== undefined ? { fromExclusive: input.from } : {}),
      ...(input.through !== null && input.through !== undefined ? { throughInclusive: input.through } : {}),
    };
  }
  return null;
}

function unavailableResult(error: CursorNativeCapabilityError): CursorNativeTranscriptReadResult {
  const availability: CursorNativeTranscriptReadResult["availability"] =
    error.kind === "missing-session" ? "missing" :
      error.kind === "transport-error" ? "offline" : "incompatible";
  return {
    items: [],
    nextCursor: null,
    source: "native",
    revision: `${error.kind}:${error.message}`,
    availability,
    completeness: "unknown",
  };
}

function profileEvidence(profile: CursorLocalProfileTransport): CursorCapabilityEvidence {
  const command = profile.command?.trim() || CURSOR_DEFAULT_COMMAND;
  if (!profile.binding.hostId.trim() || !profile.binding.profileId.trim() || !path.isAbsolute(profile.cwd)) {
    return {
      status: "unknown",
      reason: "Cursor ACP profile transport is missing host/profile identity or an absolute cwd.",
      providerVersion: profile.providerVersion || null,
      transport: CURSOR_NATIVE_TRANSPORT,
      profileBound: false,
      profileRequired: true,
    };
  }
  return {
    status: "unknown",
    reason: `Cursor ACP ${command} session/load has not been observed on this bound profile; provider version alone does not establish resume or transcript support.`,
    providerVersion: profile.providerVersion.trim() || null,
    transport: CURSOR_NATIVE_TRANSPORT,
    profileBound: true,
    profileRequired: true,
  };
}

type CursorProfileCapabilityObservation = {
  status: CursorCapabilityStatus;
  reason: string;
  providerVersion: string | null;
  transport: string;
  profileBound: boolean;
  profileRequired: true;
};
type CursorProfileCapabilityObserver = (
  observation: Pick<CursorProfileCapabilityObservation, "status" | "reason">,
) => void;

const cursorProfileCapabilityObservations = new Map<string, CursorProfileCapabilityObservation>();
const cursorSpawnIds = new WeakMap<NonNullable<CursorLocalProfileTransport["spawn"]>, number>();
let nextCursorSpawnId = 1;

function profileCapabilityObservationKey(profile: CursorLocalProfileTransport): string {
  const spawn = profile.spawn ?? nodeSpawn;
  let spawnId = 0;
  if (profile.spawn) {
    spawnId = cursorSpawnIds.get(spawn) ?? nextCursorSpawnId++;
    cursorSpawnIds.set(spawn, spawnId);
  }
  return stableHash({
    bindingId: profile.binding.id?.trim() ?? null,
    orgId: profile.binding.orgId?.trim() ?? null,
    hostId: profile.binding.hostId.trim(),
    profileId: profile.binding.profileId.trim(),
    workspaceBindingId: profile.binding.workspaceBindingId?.trim() ?? null,
    capabilityRevision: profile.binding.capabilityRevision?.trim() ?? null,
    command: profile.command?.trim() || CURSOR_DEFAULT_COMMAND,
    cwd: path.resolve(profile.cwd),
    providerVersion: profile.providerVersion.trim() || null,
    protocolVersion: profile.protocolVersion ?? CURSOR_ACP_PROTOCOL_VERSION,
    path: profile.env?.PATH ?? process.env.PATH ?? null,
    spawnId,
  });
}

function observeProfileCapability(
  profile: CursorLocalProfileTransport,
  observation: Pick<CursorProfileCapabilityObservation, "status" | "reason">,
): void {
  if (!profile.binding.hostId.trim() || !profile.binding.profileId.trim() || !path.isAbsolute(profile.cwd)) return;
  const key = profileCapabilityObservationKey(profile);
  cursorProfileCapabilityObservations.delete(key);
  cursorProfileCapabilityObservations.set(key, {
    ...observation,
    providerVersion: profile.providerVersion.trim() || null,
    transport: CURSOR_NATIVE_TRANSPORT,
    profileBound: true,
    profileRequired: true,
  });
  while (cursorProfileCapabilityObservations.size > CURSOR_PROFILE_CAPABILITY_CACHE_SIZE) {
    const oldestKey = cursorProfileCapabilityObservations.keys().next().value;
    if (oldestKey === undefined) break;
    cursorProfileCapabilityObservations.delete(oldestKey);
  }
}

function observedProfileEvidence(profile: CursorLocalProfileTransport): CursorCapabilityEvidence {
  const unobserved = profileEvidence(profile);
  if (!unobserved.profileBound) return unobserved;
  const key = profileCapabilityObservationKey(profile);
  const observation = cursorProfileCapabilityObservations.get(key);
  if (!observation) return unobserved;
  cursorProfileCapabilityObservations.delete(key);
  cursorProfileCapabilityObservations.set(key, observation);
  return { ...observation };
}

function profileCapabilityObservationFromFailure(error: unknown): Pick<CursorProfileCapabilityObservation, "status" | "reason"> {
  if (error instanceof CursorAcpRpcError && error.code === CURSOR_RPC_METHOD_NOT_FOUND && error.method === "session/load") {
    return {
      status: "unsupported",
      reason: "Cursor ACP returned JSON-RPC Method not found for session/load on the bound profile.",
    };
  }
  if (error instanceof CursorNativeCapabilityError && error.status === "unsupported"
    && /initialize did not advertise the requested protocol version|agentCapabilities\.loadSession=false/.test(error.message)) {
    return { status: "unsupported", reason: error.message };
  }
  return {
    status: "unknown",
    reason: "Cursor ACP session/load did not return a verified persisted session state; capability remains unconfirmed.",
  };
}

function unsupportedNativeEvidence(profile: CursorLocalProfileTransport, method: string): CursorCapabilityEvidence {
  const evidence = profileEvidence(profile);
  if (!evidence.profileBound) {
    return {
      ...evidence,
      reason: `${evidence.reason} Cursor ${method} remains unclassified until the ACP profile transport is bound.`,
    };
  }
  return {
    status: "unsupported",
    reason: `Cursor adapter exposes no verified native ${method} operation and will not synthesize one from CLI --resume.`,
    providerVersion: profile.providerVersion.trim() || null,
    transport: CURSOR_NATIVE_TRANSPORT,
    profileBound: true,
    profileRequired: true,
  };
}

type ProviderControlOperation =
  | { kind: "steer"; input: AgentRuntimeControlSteerInput }
  | { kind: "interrupt"; reason: AgentRuntimeControlInterruptReason };
type ProviderControlRequest = {
  runtimeType: string;
  handle: AgentRuntimeControlHandle | null;
  operation: ProviderControlOperation;
  session?: CursorProviderSessionRef | null;
  binding?: CursorProviderBindingRef | null;
};

async function unsupportedSteer(_input: ProviderControlRequest): Promise<AgentRuntimeControlSteerResult> {
  return { disposition: "unsupported", reason: "Cursor ACP has no verified exact steer operation for a loaded session." };
}

async function unsupportedInterrupt(_input: ProviderControlRequest): Promise<AgentRuntimeControlInterruptResult> {
  return "unverified";
}

async function initializeCursorClient(
  client: CursorAcpClient,
  profile: CursorLocalProfileTransport,
  requireLoadSession: boolean,
  persistedAuthMethodId?: string | null,
  observeCapability?: CursorProfileCapabilityObserver,
  observeAuthMethodDiagnostic?: (diagnostic: CursorAcpAuthMethodDiagnostic) => void,
): Promise<string | null> {
  const initialize = recordValue(await client.request("initialize", {
    protocolVersion: profile.protocolVersion ?? CURSOR_ACP_PROTOCOL_VERSION,
    clientInfo: { name: "rudder", version: CURSOR_NATIVE_CLIENT_VERSION },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  }));
  const advertisedProtocol = initialize?.protocolVersion;
  const capabilities = recordValue(initialize?.agentCapabilities);
  if (advertisedProtocol !== (profile.protocolVersion ?? CURSOR_ACP_PROTOCOL_VERSION)) {
    if (requireLoadSession) {
      observeCapability?.({
        status: "unsupported",
        reason: "Cursor ACP initialize negotiated a protocol version different from the requested version.",
      });
    }
    throw new CursorNativeCapabilityError(
      "unsupported",
      "protocol-mismatch",
      "Cursor ACP initialize did not advertise the requested protocol version.",
    );
  }
  if (requireLoadSession && capabilities?.loadSession !== true) {
    const explicitlyUnsupported = capabilities?.loadSession === false;
    const reason = explicitlyUnsupported
      ? "Cursor ACP initialize advertised agentCapabilities.loadSession=false."
      : "Cursor ACP initialize did not report agentCapabilities.loadSession; session/load support remains unconfirmed.";
    observeCapability?.({ status: explicitlyUnsupported ? "unsupported" : "unknown", reason });
    throw new CursorNativeCapabilityError(
      explicitlyUnsupported ? "unsupported" : "unknown",
      "protocol-mismatch",
      reason,
    );
  }
  if (requireLoadSession) {
    observeCapability?.({
      status: "unknown",
      reason: "Cursor ACP initialize advertised loadSession; awaiting a session/load method response.",
    });
  }
  client.notify("initialized", {});
  const authMethods = Array.isArray(initialize?.authMethods)
    ? [...new Set(initialize.authMethods.map((method) => stringValue(recordValue(method)?.id)).filter((id): id is string => Boolean(id)))]
    : [];
  const authSecrets = profileSecrets(profile);
  let authMethodDiagnostic = safeAuthMethodDiagnostic(authMethods, null, authSecrets);
  observeAuthMethodDiagnostic?.(authMethodDiagnostic);
  const configuredAuthMethodId = stringValue(profile.authMethodId) ?? stringValue(persistedAuthMethodId);
  let authMethodId: string | null = null;
  if (authMethods.length > 0 && configuredAuthMethodId) {
    if (authMethods.includes(configuredAuthMethodId)) authMethodId = configuredAuthMethodId;
    else {
      throw new CursorNativeCapabilityError(
        "unsupported",
        "protocol-mismatch",
        "Cursor ACP did not advertise the configured authentication method.",
      );
    }
  } else if (authMethods.includes("cursor_login")) {
    authMethodId = "cursor_login";
  } else if (authMethods.length === 1) {
    authMethodId = authMethods[0] ?? null;
  } else if (authMethods.length > 1) {
    throw new CursorNativeCapabilityError(
      "unsupported",
      "protocol-mismatch",
      "Cursor ACP advertised multiple authentication methods; configure one explicitly.",
    );
  }
  authMethodDiagnostic = safeAuthMethodDiagnostic(authMethods, authMethodId, authSecrets);
  observeAuthMethodDiagnostic?.(authMethodDiagnostic);
  if (authMethodId) await authenticateCursorClient(client, profile, authMethodId, authMethodDiagnostic);
  return authMethodId;
}

function cursorAskUserRequest(params: JsonRecord): ChatAskUserRequest | null {
  const toolCallId = stringValue(params.toolCallId);
  if (!toolCallId || !Array.isArray(params.questions) || params.questions.length === 0) return null;
  const questionIds = new Set<string>();
  const questions: ChatAskUserRequest["questions"] = [];
  for (const value of params.questions) {
    const question = recordValue(value);
    const id = stringValue(question?.id);
    const prompt = stringValue(question?.prompt);
    if (!id || !prompt || questionIds.has(id) || !Array.isArray(question?.options) || question.options.length === 0) {
      return null;
    }
    questionIds.add(id);
    const optionIds = new Set<string>();
    const options = [];
    for (const value of question.options) {
      const option = recordValue(value);
      const optionId = stringValue(option?.id);
      const label = stringValue(option?.label);
      if (!optionId || !label || optionIds.has(optionId)) return null;
      optionIds.add(optionId);
      options.push({ id: optionId, label });
    }
    questions.push({
      id,
      question: prompt,
      ...(stringValue(params.title) ? { header: stringValue(params.title)! } : {}),
      options,
      selectionMode: question.allowMultiple === true ? "multiple" : "single",
      allowFreeform: false,
    });
  }
  return { questions };
}

function cursorAskUserResponse(
  request: ChatAskUserRequest,
  response: ChatAskUserResponse | undefined,
): { answers: Array<{ questionId: string; selectedOptionIds: string[] }> } | null {
  if (!response || !Array.isArray(response.answers) || response.answers.length !== request.questions.length) return null;
  const byQuestionId = new Map(response.answers.map((answer) => [answer.questionId, answer]));
  if (byQuestionId.size !== request.questions.length) return null;
  const answers: Array<{ questionId: string; selectedOptionIds: string[] }> = [];
  for (const question of request.questions) {
    const answer = byQuestionId.get(question.id);
    if (!answer || (answer.freeformText && answer.freeformText.trim())) return null;
    const allowed = new Set(question.options.map((option) => option.id));
    const selected = answer.optionIds;
    if (
      selected.length === 0
      || new Set(selected).size !== selected.length
      || selected.some((id) => !allowed.has(id))
      || (question.selectionMode !== "multiple" && selected.length > 1)
    ) {
      return null;
    }
    answers.push({ questionId: question.id, selectedOptionIds: [...selected] });
  }
  return { answers };
}

async function resolveCursorExtensionApproval(
  request: AgentRuntimeApprovalRequest,
  input: CursorNativeChatRequest,
  isCurrent: () => boolean,
): Promise<AgentRuntimeApprovalDecision | null> {
  if (!input.requestApproval || !input.waitForApproval || !isCurrent()) return null;
  const handle = await input.requestApproval(request);
  if (!isCurrent()) return null;
  if (handle.status !== "pending") return { id: handle.id, status: handle.status };
  const decision = await input.waitForApproval(handle.id, CURSOR_EXTENSION_APPROVAL_TIMEOUT_MS);
  return isCurrent() && decision.id === handle.id ? decision : null;
}

async function authenticateCursorClient(
  client: CursorAcpClient,
  profile: CursorLocalProfileTransport,
  authMethodId: string,
  authMethodDiagnostic: CursorAcpAuthMethodDiagnostic,
): Promise<void> {
  try {
    const authentication = await client.request("authenticate", { methodId: authMethodId }, undefined, authMethodDiagnostic);
    if (authentication === null || authentication === undefined) {
      throw new CursorNativeCapabilityError(
        "unknown",
        "protocol-mismatch",
        "Cursor ACP authenticate returned no response.",
      );
    }
  } catch (error) {
    throw normalizeRpcFailure(error, "authenticate", profileSecrets(profile));
  }
}

export type CursorAcpAuthenticationProbeResult = CursorAcpAuthMethodDiagnostic & {
  status: "authenticated" | "no_auth_method" | "timed_out" | "failed";
  requestTrace: CursorAcpRequestDiagnostic[];
};

export async function probeCursorAcpAuthentication(
  profile: CursorLocalProfileTransport,
): Promise<CursorAcpAuthenticationProbeResult> {
  const client = new CursorAcpClient(profile, () => {});
  let status: CursorAcpAuthenticationProbeResult["status"] = "failed";
  let authMethodDiagnostic: CursorAcpAuthMethodDiagnostic = {
    advertisedAuthMethodIds: [],
    chosenAuthMethodId: null,
  };
  try {
    const authMethodId = await initializeCursorClient(
      client,
      profile,
      false,
      undefined,
      undefined,
      (diagnostic) => { authMethodDiagnostic = diagnostic; },
    );
    status = authMethodId ? "authenticated" : "no_auth_method";
  } catch (error) {
    status = error instanceof CursorAcpTimeoutError ? "timed_out" : "failed";
  } finally {
    client.close();
  }
  return {
    ...authMethodDiagnostic,
    status,
    requestTrace: client.requestTrace,
  };
}

async function loadCursorSession(
  profile: CursorLocalProfileTransport,
  sessionId: string,
  signal: AbortSignal | undefined,
  persistedAuthMethodId?: string | null,
  observeCapability?: CursorProfileCapabilityObserver,
): Promise<JsonRecord[]> {
  const updates: JsonRecord[] = [];
  let sessionMismatch = false;
  const client = new CursorAcpClient(profile, (message) => {
    if (message.method !== "session/update") return;
    const params = recordValue(message.params);
    const updateSessionId = stringValue(params?.sessionId);
    const update = recordValue(params?.update);
    if (!updateSessionId || updateSessionId !== sessionId || !update) {
      sessionMismatch = true;
      return;
    }
    updates.push(update);
  }, signal);
  try {
    await initializeCursorClient(client, profile, true, persistedAuthMethodId, observeCapability);
    const loaded = await client.request("session/load", {
      sessionId,
      cwd: profile.cwd,
      mcpServers: profile.mcpServers ?? [],
    });
    requireLoadedCursorSession(loaded, sessionId);
    if (sessionMismatch) {
      throw new CursorNativeCapabilityError(
        "unsupported",
        "protocol-mismatch",
        `Cursor ACP replay returned a session/update for a session other than ${sessionId}.`,
      );
    }
    observeCapability?.({
      status: "supported",
      reason: "Cursor ACP initialize advertised loadSession and session/load returned persisted session state; transcript completeness remains partial.",
    });
    return updates;
  } catch (error) {
    observeCapability?.(profileCapabilityObservationFromFailure(error));
    throw normalizeRpcFailure(error, "session/load", profileSecrets(profile));
  } finally {
    client.close();
  }
}

export type CursorNativeChatRequest = {
  profile: CursorLocalProfileTransport;
  binding: CursorProviderBindingRef;
  sessionId?: string | null;
  sessionParams?: Record<string, unknown> | null;
  workspace?: CursorWorkspaceIdentity | null;
  prompt: string;
  model: string;
  mode?: "agent" | "plan" | "ask" | null;
  signal?: AbortSignal;
  onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  controlAttempt?: AgentRuntimeExecutionContext["controlAttempt"];
  requestApproval?: AgentRuntimeExecutionContext["requestApproval"];
  waitForApproval?: AgentRuntimeExecutionContext["waitForApproval"];
};

function cursorNativeSessionParams(
  input: CursorNativeChatRequest,
  sessionId: string,
  authMethodId: string | null,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    sessionId,
    cwd: input.profile.cwd,
    profileHostId: input.binding.hostId,
    profileId: input.binding.profileId,
    cursorAcpTransport: CURSOR_NATIVE_TRANSPORT,
    cursorAcpCommand: input.profile.command?.trim() || CURSOR_DEFAULT_COMMAND,
    cursorAcpProtocolVersion: input.profile.protocolVersion ?? CURSOR_ACP_PROTOCOL_VERSION,
  };
  if (authMethodId) params.cursorAcpAuthMethodId = authMethodId;
  if (input.binding.capabilityRevision) params.capabilityRevision = input.binding.capabilityRevision;
  if (input.profile.providerVersion.trim()) params.cursorProviderVersion = input.profile.providerVersion.trim();
  for (const field of ["workspaceId", "repoUrl", "repoRef", "workspaceBindingId"] as const) {
    const value = stringValue(input.workspace?.[field]);
    if (value) params[field] = value;
  }
  return params;
}

export async function executeCursorNativeChat(input: CursorNativeChatRequest): Promise<AgentRuntimeExecutionResult> {
  const requestedSessionId = stringValue(input.sessionId);
  const requestedParams = input.sessionParams ?? {};
  let client: CursorAcpClient | null = null;
  let activeSessionId = requestedSessionId;
  let authMethodId: string | null = null;
  let sessionModes: JsonRecord | null = null;
  let resolvedModeId: string | null = null;
  const updates: JsonRecord[] = [];
  let sessionMismatch = false;
  let controlLease: AgentRuntimeControlHandleLease | null = null;
  let active = true;
  let cancellationRequested = false;
  let promptActive = false;
  let promptSubmitted = false;
  let logWrites = Promise.resolve();
  let logFailure: unknown;
  const failureParams = requestedSessionId
    ? requestedParams
    : null;
  try {
    if (!input.binding.hostId.trim() || !input.binding.profileId.trim()) {
      throw new CursorNativeCapabilityError("unknown", "protocol-mismatch", "Cursor native chat requires an explicit host and profile binding.");
    }
    if (!bindingMatches(input.binding, input.profile)) {
      throw new CursorNativeCapabilityError("unsupported", "protocol-mismatch", "Cursor native chat profile binding does not match the requested host/profile.");
    }
    if (requestedSessionId) {
      const mismatch = nativeResumeMismatch({
        sessionId: requestedSessionId,
        params: requestedParams,
        profile: input.profile,
        binding: input.binding,
        workspace: input.workspace,
      });
      if (mismatch) {
        throw new CursorNativeCapabilityError("unsupported", "protocol-mismatch", `Cursor native resume rejected: ${mismatch}.`);
      }
    }
    client = new CursorAcpClient(input.profile, (message) => {
      const method = stringValue(message.method);
      if (method !== "session/update") {
        if (!promptActive || !method?.startsWith("cursor/")) return;
        const event = redactProviderValue({ jsonrpc: "2.0", method, params: message.params }, profileSecrets(input.profile));
        logWrites = logWrites.then(() => input.onLog("stdout", `${JSON.stringify(event)}\n`))
          .catch((error) => { logFailure = error; client?.close(); });
        return;
      }
      const params = recordValue(message.params);
      const updateSessionId = stringValue(params?.sessionId);
      const update = recordValue(params?.update);
      if (!updateSessionId || !activeSessionId || updateSessionId !== activeSessionId || !update) {
        sessionMismatch = true;
        return;
      }
      updates.push(update);
      if (promptActive) {
        const event = redactProviderValue({ jsonrpc: "2.0", method: "session/update", params }, profileSecrets(input.profile));
        logWrites = logWrites.then(() => input.onLog("stdout", `${JSON.stringify(event)}\n`))
          .catch((error) => { logFailure = error; client?.close(); });
      }
    }, input.signal, async (method, params, requestId) => {
      if (method !== "session/request_permission") {
        if (method === "cursor/ask_question") {
          const request = cursorAskUserRequest(params);
          if (!request) return { outcome: { outcome: "skipped", reason: "Cursor ask_question contained an unsupported structured request." } };
          const current = () => active && !cancellationRequested && !input.signal?.aborted
            && (!input.controlAttempt || controlLease?.isCurrent() === true);
          const approval = await resolveCursorExtensionApproval({
            type: "agent_runtime",
            payload: redactProviderValue({
              runtimeType: "cursor",
              transport: CURSOR_NATIVE_TRANSPORT,
              nativeExtension: method,
              nativeRequestId: requestId,
              nativeSessionId: activeSessionId,
              toolCallId: params.toolCallId,
            }, profileSecrets(input.profile)) as JsonRecord,
            inputRequest: redactProviderValue(request, profileSecrets(input.profile)) as ChatAskUserRequest,
          }, input, current);
          if (!approval || approval.status === "cancelled") return { outcome: { outcome: "cancelled" } };
          if (approval.status !== "approved") {
            return { outcome: { outcome: "skipped", reason: redactProviderValue(approval.decisionNote ?? "User skipped the question.", profileSecrets(input.profile)) as string } };
          }
          const answers = cursorAskUserResponse(request, approval.inputResponse);
          return answers
            ? { outcome: { outcome: "answered", answers: answers.answers } }
            : { outcome: { outcome: "skipped", reason: "Rudder structured answer could not be validated." } };
        }
        if (method === "cursor/create_plan") {
          const plan = stringValue(params.plan);
          const toolCallId = stringValue(params.toolCallId);
          if (!plan || !toolCallId) {
            return { outcome: { outcome: "rejected", reason: "Cursor create_plan contained an unsupported structured request." } };
          }
          const current = () => active && !cancellationRequested && !input.signal?.aborted
            && (!input.controlAttempt || controlLease?.isCurrent() === true);
          const approval = await resolveCursorExtensionApproval({
            type: "agent_runtime",
            payload: redactProviderValue({
              runtimeType: "cursor",
              transport: CURSOR_NATIVE_TRANSPORT,
              nativeExtension: method,
              nativeRequestId: requestId,
              nativeSessionId: activeSessionId,
              toolCallId,
              name: params.name,
              overview: params.overview,
              plan,
              todos: params.todos,
              phases: params.phases,
              isProject: params.isProject,
            }, profileSecrets(input.profile)) as JsonRecord,
          }, input, current);
          if (!approval || approval.status === "cancelled") return { outcome: { outcome: "cancelled" } };
          if (approval.status === "approved") return { outcome: { outcome: "accepted" } };
          return {
            outcome: {
              outcome: "rejected",
              reason: redactProviderValue(approval.decisionNote ?? "User rejected the plan.", profileSecrets(input.profile)) as string,
            },
          };
        }
        throw new CursorAcpMethodNotFoundError(`Cursor ACP client method ${method} is not supported.`);
      }
      const cancelled = { outcome: { outcome: "cancelled" } };
      const isCurrent = () => active && !cancellationRequested && !input.signal?.aborted
        && params.sessionId === activeSessionId && controlLease?.isCurrent() === true;
      if (!isCurrent() || !input.requestApproval || !input.waitForApproval) return cancelled;
      const options = Array.isArray(params.options) ? params.options.map(recordValue).filter(Boolean) : [];
      const allow = options.find((option) => option?.kind === "allow_once" && stringValue(option.optionId));
      if (!allow) return cancelled;
      const approval = await input.requestApproval({ type: "agent_runtime", payload: {
        runtimeType: "cursor", transport: CURSOR_NATIVE_TRANSPORT, nativeRequestId: requestId,
        nativeSessionId: activeSessionId, attemptEpoch: input.controlAttempt?.attemptEpoch,
        toolCall: redactProviderValue(params.toolCall, profileSecrets(input.profile)),
      } });
      if (!isCurrent()) return cancelled;
      const decision = approval.status === "pending"
        ? await input.waitForApproval(approval.id, 10 * 60_000) : approval;
      if (!isCurrent() || decision.id !== approval.id || decision.status !== "approved") return cancelled;
      return { outcome: { outcome: "selected", optionId: allow.optionId } };
    });
    if (typeof client.pid === "number" && input.onSpawn) {
      await input.onSpawn({ pid: client.pid, startedAt: new Date().toISOString() });
    }
    authMethodId = await initializeCursorClient(
      client,
      input.profile,
      Boolean(requestedSessionId),
      stringValue(requestedParams.cursorAcpAuthMethodId),
      requestedSessionId
        ? (observation) => observeProfileCapability(input.profile, observation)
        : undefined,
    );
    if (requestedSessionId) {
      try {
        const loaded = await client.request("session/load", {
          sessionId: requestedSessionId,
          cwd: input.profile.cwd,
          mcpServers: input.profile.mcpServers ?? [],
        });
        sessionModes = recordValue(requireLoadedCursorSession(loaded, requestedSessionId).modes);
        observeProfileCapability(input.profile, {
          status: "supported",
          reason: "Cursor ACP initialize advertised loadSession and session/load returned persisted session state; transcript completeness remains partial.",
        });
      } catch (error) {
        observeProfileCapability(input.profile, profileCapabilityObservationFromFailure(error));
        throw error;
      }
    } else {
      const created = recordValue(await client.request("session/new", {
        cwd: input.profile.cwd,
        mcpServers: input.profile.mcpServers ?? [],
      }));
      activeSessionId = stringValue(created?.sessionId ?? created?.session_id);
      sessionModes = recordValue(created?.modes);
      if (!activeSessionId) {
        throw new CursorNativeCapabilityError("unknown", "protocol-mismatch", "Cursor ACP session/new returned no session identity.");
      }
    }
    if (!activeSessionId) {
      throw new CursorNativeCapabilityError("unknown", "protocol-mismatch", "Cursor ACP chat has no session identity.");
    }
    if (input.model.trim()) {
      // Installed Cursor ACP exposes the official unstable model selector.
      // A provider refusal is terminal; never silently use a different model.
      await client.request("session/set_model", { sessionId: activeSessionId, modelId: input.model.trim() });
    }
    if (input.mode) {
      const availableModes = Array.isArray(sessionModes?.availableModes)
        ? sessionModes.availableModes.map((value) => stringValue(recordValue(value)?.id)).filter((value): value is string => Boolean(value))
        : [];
      if (!availableModes.includes(input.mode)) {
        throw new CursorNativeCapabilityError(
          "unsupported",
          "unsupported",
          `Cursor ACP did not advertise the requested ${input.mode} mode for this session.`,
        );
      }
      resolvedModeId = input.mode;
      if (stringValue(sessionModes?.currentModeId) !== input.mode) {
        await client.request("session/set_mode", { sessionId: activeSessionId, modeId: input.mode });
      }
    } else {
      resolvedModeId = stringValue(sessionModes?.currentModeId);
    }
    if (input.controlAttempt) {
      controlLease = await input.controlAttempt.register({
        runtimeType: "cursor", providerThreadId: activeSessionId,
        capabilities: { steer: "interrupt_continue", interrupt: "native" },
        steer: async () => ({ disposition: "unsupported", reason: "Cursor ACP does not advertise active-turn steering." }),
        interrupt: async () => {
          if (!active || !controlLease?.isCurrent() || !client) return "unverified";
          cancellationRequested = true;
          client.notify("session/cancel", { sessionId: activeSessionId });
          return "waiting_safe_boundary";
        },
        dispose: async () => {},
      });
      if (!controlLease) throw new Error("Cursor ACP Run attempt lost ownership before prompt");
    }
    // session/load replays history for readers. It is not output of this Run.
    updates.length = 0;
    promptActive = true;
    promptSubmitted = true;
    const promptResult = recordValue(await client.request("session/prompt", {
      sessionId: activeSessionId,
      prompt: [{ type: "text", text: input.prompt }],
    }, input.profile.requestTimeoutMs ?? 30 * 60_000));
    promptActive = false;
    await logWrites;
    if (logFailure) throw logFailure;
    if (sessionMismatch) {
      throw new CursorNativeCapabilityError("unsupported", "protocol-mismatch", `Cursor ACP chat returned a session/update for a session other than ${activeSessionId}.`);
    }
    const summary = updates
      .filter((update) => stringValue(update.sessionUpdate) === "agent_message_chunk")
      .map((update) => {
        const content = recordValue(update.content);
        // ACP chunks are deltas: trimming each chunk loses word boundaries.
        return typeof content?.text === "string" ? content.text : textFrom(update.content ?? update.entries ?? update.title) ?? "";
      })
      .join("");
    const sessionParams = cursorNativeSessionParams(input, activeSessionId, authMethodId);
    const stopReason = stringValue(promptResult?.stopReason);
    const providerTerminalObserved = Boolean(stopReason && ["end_turn", "max_tokens", "cancelled", "refusal", "error"].includes(stopReason));
    const promptBoundary = resolvePromptBoundary(updates);
    const completed = stopReason === "end_turn" && !cancellationRequested
      && (!input.controlAttempt || controlLease?.isCurrent() === true);
    const incompleteReason = stopReason !== "end_turn"
      ? `Cursor ACP prompt did not complete a turn (${stopReason ?? "missing stop reason"}).`
      : cancellationRequested
        ? "Cursor ACP prompt was cancelled."
        : completed
          ? null
          : "Cursor ACP Run attempt lost ownership before prompt completion.";
    await input.onLog(completed ? "stdout" : "stderr", `[rudder] Cursor native chat ${completed ? "completed" : "failed"} ${JSON.stringify({
      sessionId: activeSessionId,
      updateCount: updates.length,
      executionRef: promptBoundary.executionRef,
      nativeRangeRef: promptBoundary.nativeRangeRef,
    })}\n`);
    return {
      exitCode: completed ? 0 : 1,
      signal: null,
      timedOut: false,
      nativeWriterQuiescence: providerTerminalObserved
        ? { status: "confirmed", source: "provider_terminal" }
        : { status: "unconfirmed", reason: "Cursor ACP returned without a recognized provider terminal stop reason." },
      errorMessage: completed ? null : incompleteReason,
      ...(!completed ? { errorCode: "cursor_native_incomplete_turn" } : {}),
      sessionId: activeSessionId,
      sessionParams,
      sessionDisplayId: activeSessionId,
      provider: input.model.includes("/") ? input.model.split("/", 1)[0] : null,
      model: input.model || null,
      billingType: "unknown",
      resultJson: {
        transport: CURSOR_NATIVE_TRANSPORT,
        nativeSession: true,
        sessionId: activeSessionId,
        updateCount: updates.length,
        stopReason,
        ...(resolvedModeId ? { modeId: resolvedModeId } : {}),
        boundaryStatus: promptBoundary.status,
        ...(promptBoundary.reason ? { boundaryReason: promptBoundary.reason } : {}),
        transcriptBoundary: {
          status: promptBoundary.status,
          ...(promptBoundary.reason ? { reason: promptBoundary.reason } : {}),
        },
        ...(promptBoundary.executionRef ? { executionRef: promptBoundary.executionRef } : {}),
        ...(promptBoundary.nativeRangeRef ? { nativeRangeRef: promptBoundary.nativeRangeRef } : {}),
      },
      summary,
    };
  } catch (error) {
    const normalized = normalizeRpcFailure(error, requestedSessionId ? "session/load" : "chat", profileSecrets(input.profile));
    await input.onLog("stderr", `[rudder] Cursor native chat failed ${JSON.stringify({ kind: normalized.kind, error: normalized.message })}\n`);
    const timedOut = error instanceof CursorAcpTimeoutError;
    const requestTrace = client?.requestTrace ?? [];
    const timedOutRequest = timedOut ? requestTrace.findLast((request) => request.status === "timed_out") : null;
    return {
      exitCode: 1,
      signal: null,
      timedOut,
      ...(promptSubmitted
        ? { nativeWriterQuiescence: { status: "unconfirmed" as const, reason: timedOut
          ? "Cursor ACP prompt timed out without a provider terminal response or stop acknowledgement."
          : "Cursor ACP prompt ended without a provider terminal response or stop acknowledgement." } }
        : {}),
      errorMessage: normalized.message,
      errorCode: timedOut ? "cursor_native_timeout" : `cursor_native_${normalized.kind}`,
      ...(activeSessionId ? {
        sessionId: activeSessionId,
        sessionParams: requestedSessionId ? failureParams : cursorNativeSessionParams(input, activeSessionId, authMethodId),
        sessionDisplayId: activeSessionId,
      } : {}),
      provider: input.model.includes("/") ? input.model.split("/", 1)[0] : null,
      model: input.model || null,
      billingType: "unknown",
      resultJson: {
        transport: CURSOR_NATIVE_TRANSPORT,
        nativeSession: true,
        ...(activeSessionId ? { sessionId: activeSessionId } : {}),
        error: normalized.message,
        ...(timedOut ? {
          acpRequestTrace: requestTrace,
          acpTimeout: {
            method: error.method,
            timeoutMs: error.timeoutMs,
            durationMs: timedOutRequest?.durationMs ?? error.timeoutMs,
          },
        } : {}),
      },
      summary: "",
    };
  } finally {
    active = false;
    promptActive = false;
    await logWrites;
    await controlLease?.release().catch(() => undefined);
    client?.close();
  }
}

async function readProfileSession(
  profile: CursorLocalProfileTransport,
  request: CursorNativeTranscriptReadRequest,
  capabilityEvidence: {
    sessionResume: CursorCapabilityEvidence;
    transcript: CursorCapabilityEvidence;
  },
): Promise<CursorNativeTranscriptReadResult> {
  const binding = request.binding;
  if (!binding || !binding.hostId.trim() || !binding.profileId.trim()) {
    return { items: [], nextCursor: null, source: "native", revision: "missing-binding", availability: "missing", completeness: "unknown" };
  }
  if (!bindingMatches(binding, profile)) {
    return { items: [], nextCursor: null, source: "native", revision: "profile-mismatch", availability: "incompatible", completeness: "unknown" };
  }
  const currentEvidence = observedProfileEvidence(profile);
  if (!currentEvidence.profileBound || currentEvidence.status === "unsupported") {
    return { items: [], nextCursor: null, source: "native", revision: "profile-unverified", availability: "incompatible", completeness: "unknown" };
  }
  if (request.runtimeType !== "cursor") {
    return { items: [], nextCursor: null, source: "native", revision: "runtime-mismatch", availability: "incompatible", completeness: "unknown" };
  }
  const sessionId = request.session.sessionId.trim();
  const params = request.session.sessionParams;
  if (!sessionId) {
    return { items: [], nextCursor: null, source: "native", revision: "session-profile-mismatch", availability: "incompatible", completeness: "unknown" };
  }
  const mismatch = nativeResumeMismatch({
    sessionId,
    params,
    profile,
    binding,
    workspace: request.workspace,
  });
  if (mismatch) {
    return { items: [], nextCursor: null, source: "native", revision: mismatch, availability: "incompatible", completeness: "unknown" };
  }
  const observeCapability: CursorProfileCapabilityObserver = (observation) => {
    observeProfileCapability(profile, observation);
    const evidence = observedProfileEvidence(profile);
    Object.assign(capabilityEvidence.sessionResume, evidence);
    Object.assign(capabilityEvidence.transcript, evidence);
  };
  try {
    const updates = await loadCursorSession(
      profile,
      sessionId,
      request.signal,
      stringValue(params.cursorAcpAuthMethodId),
      observeCapability,
    );
    const revision = stableHash(updates);
    const scoped = selectRunUpdates(sessionId, updates, request.selector);
    if (scoped.status !== "ok" || !scoped.updates) {
      return {
        items: [],
        nextCursor: null,
        source: "native",
        revision: `${scoped.status}-run-range-boundary:${revision}:${scoped.reason}`,
        availability: scoped.status === "missing" ? "missing" : "incompatible",
        completeness: "partial",
      };
    }
    const allItems = itemsFromUpdates(
      sessionId,
      scoped.updates.map(({ update }) => update),
      profileSecrets(profile),
      revision,
      scoped.updates.map(({ ordinal }) => ordinal),
    );
    const ranged = applyRange(allItems, requestedRange(request));
    if (ranged.reason) {
      return {
        items: [],
        nextCursor: null,
        source: "native",
        revision: `unavailable-run-range-boundary:${revision}:${ranged.reason}`,
        availability: "missing",
        completeness: "partial",
      };
    }
    const offset = decodeCursor(request.cursor, revision);
    const page = ranged.items.slice(offset, offset + CURSOR_NATIVE_PAGE_SIZE);
    const nextCursor = offset + page.length < ranged.items.length ? encodeCursor(revision, offset + page.length) : null;
    return {
      items: page,
      nextCursor,
      source: "native",
      revision,
      availability: "available",
      // ACP session/load replay has no Cursor completeness marker, so avoid
      // claiming the provider returned the full retained history.
      completeness: "partial",
    };
  } catch (error) {
    return unavailableResult(normalizeRpcFailure(error, "session/load", profileSecrets(profile)));
  }
}

export interface CursorRuntimeProviderCapabilityAdapter {
  runtimeType: "cursor";
  sessionResume: { evidence: CursorCapabilityEvidence };
  input: { evidence: CursorCapabilityEvidence };
  contextHandoff: { evidence: CursorCapabilityEvidence };
  transcript: {
    evidence: CursorCapabilityEvidence;
    readRange: (input: CursorNativeTranscriptReadRequest) => Promise<CursorNativeTranscriptReadResult>;
  };
  fork: { evidence: CursorCapabilityEvidence };
  control: {
    steer: {
      evidence: CursorCapabilityEvidence;
      mode?: "native";
      execute: (input: ProviderControlRequest) => Promise<AgentRuntimeControlSteerResult>;
    };
    interrupt: {
      evidence: CursorCapabilityEvidence;
      mode?: "native";
      execute: (input: ProviderControlRequest) => Promise<AgentRuntimeControlInterruptResult>;
    };
  };
}

const staticSessionResumeEvidence: CursorCapabilityEvidence = {
  status: "supported",
  reason: "Cursor Agent execute resumes a saved session through the provider --resume argument; this does not itself provide a transcript reader.",
  transport: "cursor-agent-cli",
  profileBound: false,
  profileRequired: true,
};
const staticInputEvidence: CursorCapabilityEvidence = {
  status: "supported",
  reason: "Cursor Agent execute is the registered prompt submission boundary.",
  transport: "cursor-agent-cli",
  profileBound: true,
  profileRequired: false,
};
const staticContextEvidence: CursorCapabilityEvidence = {
  status: "supported",
  reason: "Cursor Agent execute accepts selected visible context in its managed prompt input; context handoff is an auditable prompt projection.",
  transport: "cursor-agent-cli",
  profileBound: true,
  profileRequired: false,
};
const staticTranscriptEvidence: CursorCapabilityEvidence = {
  status: "unknown",
  reason: "Cursor native history requires a host-owned profile transport that can start the verified ACP initialize/authenticate/session-load sequence.",
  transport: CURSOR_NATIVE_TRANSPORT,
  profileBound: false,
  profileRequired: true,
};
const staticForkEvidence: CursorCapabilityEvidence = {
  status: "unknown",
  reason: "Cursor ACP boundary fork is not classified until the provider profile is bound; CLI --resume is not treated as fork.",
  transport: CURSOR_NATIVE_TRANSPORT,
  profileBound: false,
  profileRequired: true,
};

type CursorRuntimeProviderCapabilityRegistration = {
  runtimeType: "cursor";
  sessionResume: { evidence: CursorCapabilityEvidence };
  input: { evidence: CursorCapabilityEvidence };
  contextHandoff: { evidence: CursorCapabilityEvidence };
  transcript: { evidence: CursorCapabilityEvidence };
  fork: { evidence: CursorCapabilityEvidence };
  control: {
    steer: { evidence: CursorCapabilityEvidence };
    interrupt: { evidence: CursorCapabilityEvidence };
  };
};

export const runtimeProviderCapabilities: CursorRuntimeProviderCapabilityRegistration = {
  runtimeType: "cursor",
  sessionResume: { evidence: staticSessionResumeEvidence },
  input: { evidence: staticInputEvidence },
  contextHandoff: { evidence: staticContextEvidence },
  transcript: { evidence: staticTranscriptEvidence },
  fork: { evidence: staticForkEvidence },
  control: {
    steer: {
      evidence: {
        status: "unknown" as const,
        reason: "Cursor active-turn steer requires a profile-bound ACP control hook; this adapter does not infer it from CLI state.",
        transport: CURSOR_NATIVE_TRANSPORT,
        profileBound: false,
        profileRequired: true,
      } satisfies CursorCapabilityEvidence,
    },
    interrupt: {
      evidence: {
        status: "unknown" as const,
        reason: "Cursor active-turn interrupt requires the live ACP session handle; this adapter does not infer it from CLI state.",
        transport: CURSOR_NATIVE_TRANSPORT,
        profileBound: false,
        profileRequired: true,
      } satisfies CursorCapabilityEvidence,
    },
  },
};

function boundCapabilities(profile: CursorLocalProfileTransport): CursorRuntimeProviderCapabilityAdapter {
  const evidence = observedProfileEvidence(profile);
  const profileBindingEvidence = profileEvidence(profile);
  const command = profile.command?.trim() || CURSOR_DEFAULT_COMMAND;
  const cliEvidence: CursorCapabilityEvidence = {
    status: profileBindingEvidence.profileBound ? "supported" : "unknown",
    reason: `Cursor Agent uses the profile-bound ${command} CLI for prompt input and --resume; this is separate from ACP transcript replay.`,
    providerVersion: profile.providerVersion.trim() || null,
    transport: "cursor-agent-cli",
    profileBound: profileBindingEvidence.profileBound,
    profileRequired: false,
  };
  const resumeEvidence: CursorCapabilityEvidence = {
    ...evidence,
    profileRequired: true,
    reason: `${evidence.reason} ACP session/load is the profile-bound native resume transport; legacy CLI context-handoff sessions remain separately allowlisted.`,
  };
  const transcriptEvidence = { ...evidence };
  return {
    runtimeType: "cursor",
    sessionResume: { evidence: resumeEvidence },
    input: { evidence: cliEvidence },
    contextHandoff: {
      evidence: {
        ...cliEvidence,
        reason: `${cliEvidence.reason} Context handoff remains a bounded prompt projection, not a native branch.`,
      },
    },
    transcript: {
      evidence: transcriptEvidence,
      readRange: (input) => readProfileSession(profile, input, {
        sessionResume: resumeEvidence,
        transcript: transcriptEvidence,
      }),
    },
    fork: { evidence: unsupportedNativeEvidence(profile, "boundary fork") },
    control: {
      // Unsupported controls intentionally omit mode: no ACP control request is sent.
      steer: { evidence: unsupportedNativeEvidence(profile, "steer"), execute: unsupportedSteer },
      interrupt: { evidence: unsupportedNativeEvidence(profile, "interrupt"), execute: unsupportedInterrupt },
    },
  };
}

function unknownCapabilities(reason: string): CursorRuntimeProviderCapabilityAdapter {
  const evidence: CursorCapabilityEvidence = { ...staticTranscriptEvidence, reason: `${reason} A profile-bound ACP source was not resolved.` };
  return {
    runtimeType: "cursor",
    sessionResume: { evidence: { ...staticSessionResumeEvidence, status: "unknown", profileBound: false, reason } },
    input: { evidence: { ...staticInputEvidence, status: "unknown", profileBound: false, reason } },
    contextHandoff: { evidence: { ...staticContextEvidence, status: "unknown", profileBound: false, reason } },
    transcript: {
      evidence,
      readRange: async () => ({ items: [], nextCursor: null, source: "native", revision: "unavailable", availability: "offline", completeness: "unknown" }),
    },
    fork: { evidence: { ...staticForkEvidence, reason } },
    control: {
      steer: {
        evidence: { ...runtimeProviderCapabilities.control.steer.evidence, reason },
        execute: unsupportedSteer,
      },
      interrupt: {
        evidence: { ...runtimeProviderCapabilities.control.interrupt.evidence, reason },
        execute: unsupportedInterrupt,
      },
    },
  };
}

export function createCursorLocalProviderCapabilities(
  profile: CursorLocalProfileTransport,
): CursorRuntimeProviderCapabilityAdapter {
  return boundCapabilities(profile);
}

export function createCursorLocalProviderCapabilityResolver(
  resolveProfile: CursorLocalProfileTransportResolver | null | undefined,
): (runtimeType: string, binding?: CursorProviderBindingRef | null) => CursorRuntimeProviderCapabilityAdapter | null {
  return (runtimeType, binding) => {
    if (runtimeType !== "cursor") return null;
    if (!binding?.hostId?.trim() || !binding.profileId?.trim()) {
      return unknownCapabilities("Cursor native ACP history requires an explicit host/profile binding.");
    }
    if (!resolveProfile) return unknownCapabilities("No Cursor profile-bound ACP transport resolver is installed.");
    let profile: CursorLocalProfileTransport | null | undefined;
    try {
      profile = resolveProfile(binding);
    } catch (error) {
      return unknownCapabilities(`Cursor profile transport resolution failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!profile) return unknownCapabilities(`No Cursor ACP transport is authorized for profile ${binding.profileId}.`);
    if (!bindingMatches(binding, profile)) {
      const reason = `Cursor ACP profile transport identity mismatch; native history and control are unsupported for requested ${binding.hostId}/${binding.profileId}.`;
      const mismatch = unknownCapabilities(reason);
      mismatch.transcript.evidence = { ...mismatch.transcript.evidence, status: "unsupported", reason };
      mismatch.fork.evidence = { ...mismatch.fork.evidence, status: "unsupported", reason };
      mismatch.control.steer.evidence = { ...mismatch.control.steer.evidence, status: "unsupported", reason };
      mismatch.control.interrupt.evidence = { ...mismatch.control.interrupt.evidence, status: "unsupported", reason };
      return mismatch;
    }
    return boundCapabilities(profile);
  };
}

export const resolveCursorLocalProviderCapabilities = createCursorLocalProviderCapabilityResolver;
