import type {
  AgentRuntimeControlHandle,
  AgentRuntimeControlInterruptReason,
  AgentRuntimeControlInterruptResult,
  AgentRuntimeControlSteerInput,
  AgentRuntimeControlSteerResult,
} from "@rudderhq/agent-runtime-utils";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  baseUrl,
  endpoint,
  hasBearerAuth,
  HERMES_SUPPORTED_VERSIONS,
  preflightBaseUrl,
} from "./http.js";
import {
  forkHermesAcpNativeSession,
  HERMES_ACP_NATIVE_TRANSPORT,
  readHermesAcpNativeTranscript,
  type HermesAcpForkResult,
  type HermesAcpProfile,
  type HermesAcpTranscriptResult,
  type HermesAcpWorkspace
} from "./native-protocol.js";
import {
  HERMES_PRODUCT_HISTORY_TRANSPORT,
  HermesProductHistoryError,
  readHermesProductHistory,
  readHermesProductHistoryExecutionSpan,
  type HermesProductHistoryExecutionSpanProof,
  type HermesProductHistoryProfile,
  type HermesProductHistoryRange,
} from "./product-history.js";
import {
  forkHermesProductRpcNativeSession,
  HERMES_PRODUCT_RPC_TRANSPORT,
  hermesProductRpcProfileEvidence,
  isHermesProductRpcProfile,
  validateHermesProductRpcSession,
  type HermesProductRpcProfile,
} from "./product-rpc.js";

export type HermesCapabilityStatus = "supported" | "unsupported" | "unknown";

export type HermesCapabilityEvidence = {
  status: HermesCapabilityStatus;
  reason: string;
  providerVersion?: string | null;
  transport?: string | null;
  profileBound: boolean;
  profileRequired?: boolean;
};

export type HermesProviderBindingRef = {
  id?: string | null;
  orgId?: string | null;
  hostId: string;
  profileId: string;
  workspaceBindingId?: string | null;
  capabilityRevision?: string | null;
};

export type HermesProviderSessionRef = {
  sessionId: string;
  sessionParams: Record<string, unknown>;
  sessionDisplayId: string;
};

export type HermesTranscriptRange = {
  start?: string | number | { itemId?: string | null; ordinal?: number | null } | null;
  end?: string | number | { itemId?: string | null; ordinal?: number | null } | null;
  fromExclusive?: string | number | { itemId?: string | null; ordinal?: number | null } | null;
  throughInclusive?: string | number | { itemId?: string | null; ordinal?: number | null } | null;
  itemId?: string | null;
};

export type HermesNativeTranscriptRawItem = {
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

export type HermesNativeTranscriptReadRequest = {
  runtimeType: string;
  session: HermesProviderSessionRef;
  selector?: Record<string, unknown> | null;
  binding?: HermesProviderBindingRef | null;
  readerInput?: unknown | null;
  range?: HermesTranscriptRange | null;
  from?: string | null;
  through?: string | null;
  cursor?: string | null;
  signal?: AbortSignal;
};

export type HermesNativeTranscriptReadResult = {
  items: readonly HermesNativeTranscriptRawItem[];
  nextCursor: string | null;
  source: "native";
  revision: string;
  availability: "available" | "offline" | "missing" | "expired" | "incompatible";
  completeness: "complete" | "partial" | "terminal_only" | "unknown";
  limitReached?: { reason: "item_bytes" | "page_bytes" | "total_bytes" | "total_items"; maximum: number };
};

/** Credentials stay in this host-owned closure and never enter providerStateJson. */
export type HermesGatewayProfileTransport = {
  binding: HermesProviderBindingRef;
  baseUrl: string | URL;
  providerVersion: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Host-authorized read-only Hermes state reader; never inferred from session parameters. */
  pythonCommand?: string | null;
  sourcePath?: string | null;
  hermesHome?: string | null;
  fetch?: typeof fetch;
};

export type HermesGatewayProfileTransportResolver = (
  binding: HermesProviderBindingRef,
) => HermesGatewayProfileTransport | null | undefined;

type HermesRecord = Record<string, unknown>;
const HERMES_NATIVE_TRANSPORT = "hermes-http-sse";
const HERMES_ACP_VERIFIED_VERSIONS = ["0.21.0"] as const;
const TRANSCRIPT_PAGE_SIZE = 100;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const SENSITIVE_PROVIDER_FIELD = /(?:^|[-_])(?:authorization|proxy[-_]authorization|api[-_]?key|auth[-_]?token|access[-_]?token|refresh[-_]?token|session[-_]?token|token|password|secret|credential|cookie)(?:s|field|value|header)?(?:$|[-_])/i;
const SENSITIVE_TEXT_ASSIGNMENT = /((?:authorization|proxy[-_]authorization|api[-_]?key|auth[-_]?token|access[-_]?token|refresh[-_]?(?:token|key)|session[-_]?token|token|password|secret|credential|cookie)\s*[:=]\s*)(?:bearer\s+)?[^\s,;}'\"]+/gi;

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function recordValue(value: unknown): HermesRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as HermesRecord
    : null;
}

function redactSecrets(text: string, secrets: readonly string[]): string {
  const redacted = secrets.reduce((safe, secret) => secret ? safe.split(secret).join("[REDACTED]") : safe, text);
  return redacted.replace(SENSITIVE_TEXT_ASSIGNMENT, "$1[REDACTED]");
}

function profileSecrets(profile: HermesGatewayProfileTransport): string[] {
  const values: string[] = [];
  const add = (value: unknown) => {
    const text = stringValue(value);
    if (!text) return;
    values.push(text);
    values.push(text.replace(/^bearer\s+/i, ""));
  };
  add(profile.apiKey);
  for (const [key, value] of Object.entries(profile.headers ?? {})) {
    if (SENSITIVE_PROVIDER_FIELD.test(key) || key.toLowerCase() === "authorization") add(value);
  }
  return [...new Set(values.filter(Boolean))];
}

function redactProviderValue(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactProviderValue(entry, secrets));
  const record = recordValue(value);
  if (!record) return value;
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [
    key,
    SENSITIVE_PROVIDER_FIELD.test(key) ? "[REDACTED]" : redactProviderValue(child, secrets),
  ]));
}

function redactProviderRecord(record: HermesRecord, secrets: readonly string[] = []): HermesRecord {
  return redactProviderValue(record, secrets) as HermesRecord;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function bindingMatches(requested: HermesProviderBindingRef, profile: HermesGatewayProfileTransport): boolean {
  return profile.binding.hostId.trim() === requested.hostId.trim()
    && profile.binding.profileId.trim() === requested.profileId.trim()
    && (!requested.capabilityRevision
      || !profile.binding.capabilityRevision
      || requested.capabilityRevision === profile.binding.capabilityRevision);
}

function profileIdentityMatches(params: Record<string, unknown>, binding: HermesProviderBindingRef): boolean {
  const storedHost = stringValue(params.profileHostId ?? params.providerHostId ?? params.hostId);
  const storedProfile = stringValue(params.profileId ?? params.providerProfileId);
  return (!storedHost || storedHost === binding.hostId)
    && (!storedProfile || storedProfile === binding.profileId);
}

function historyProfileFieldsPresent(profile: HermesGatewayProfileTransport): boolean {
  return Boolean(stringValue(profile.pythonCommand) || stringValue(profile.sourcePath) || stringValue(profile.hermesHome));
}

function acpHistoryProfileAvailable(profile: HermesAcpProfileTransport): boolean {
  return [profile.hermesPythonCommand, profile.hermesSourcePath, profile.hermesHome].every((value) => {
    const candidate = stringValue(value);
    return Boolean(candidate && path.isAbsolute(candidate));
  });
}

function gatewayProfileForAcpHistory(profile: HermesAcpProfileTransport): HermesGatewayProfileTransport {
  return {
    binding: profile.binding,
    baseUrl: "",
    providerVersion: profile.providerVersion ?? "",
    pythonCommand: profile.hermesPythonCommand,
    sourcePath: profile.hermesSourcePath,
    hermesHome: profile.hermesHome,
  };
}

function historyProfileFromGatewayProfile(profile: HermesGatewayProfileTransport): HermesProductHistoryProfile | null {
  const pythonCommand = stringValue(profile.pythonCommand);
  const sourcePath = stringValue(profile.sourcePath);
  const hermesHome = stringValue(profile.hermesHome);
  if (
    !pythonCommand
    || !sourcePath
    || !hermesHome
    || !path.isAbsolute(pythonCommand)
    || !path.isAbsolute(sourcePath)
    || !path.isAbsolute(hermesHome)
  ) return null;
  return {
    pythonCommand,
    sourcePath,
    hermesHome,
    providerVersion: profile.providerVersion || null,
    hostId: profile.binding.hostId,
    profileId: profile.binding.profileId,
  };
}

function historyProfileEvidence(profile: HermesGatewayProfileTransport): HermesCapabilityEvidence {
  const historyProfile = historyProfileFromGatewayProfile(profile);
  if (historyProfile) {
    return {
      status: "supported",
      reason: `Hermes ${profile.providerVersion || "unknown"} profile ${profile.binding.hostId}/${profile.binding.profileId} is bound to the host-authorized read-only state.db reader.`,
      providerVersion: profile.providerVersion || null,
      transport: HERMES_PRODUCT_HISTORY_TRANSPORT,
      profileBound: true,
      profileRequired: true,
    };
  }
  return {
    status: "unknown",
    reason: historyProfileFieldsPresent(profile)
      ? "Hermes history profile is incomplete; pythonCommand, sourcePath, and hermesHome must all be host-authorized before native history can be read."
      : "Hermes native history requires host-authorized pythonCommand, sourcePath, and hermesHome.",
    providerVersion: profile.providerVersion || null,
    transport: HERMES_PRODUCT_HISTORY_TRANSPORT,
    profileBound: true,
    profileRequired: true,
  };
}

function safeHistoryBoundary(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

type HistoryExecutionRange = { range: HermesProductHistoryRange } | { unknown: true } | null;
type VerifiedHistoryExecutionSpan = {
  range: HermesProductHistoryRange;
  proof: HermesProductHistoryExecutionSpanProof;
};
type HistoryExecutionSpanCheck = { ok: true; value: VerifiedHistoryExecutionSpan } | { ok: false; reason: string };

function exactHistoryExecutionRange(
  selector: Record<string, unknown> | null | undefined,
  sessionId: string,
): HistoryExecutionRange {
  if (stringValue(selector?.kind) !== "hermes_execution") return null;
  const sourceRangeRef = stringValue(selector?.sourceRangeRef);
  if (!sourceRangeRef) return { unknown: true };
  try {
    const value = recordValue(JSON.parse(sourceRangeRef));
    const startExclusive = safeHistoryBoundary(value?.startExclusive);
    const endInclusive = safeHistoryBoundary(value?.endInclusive);
    if (
      value?.version !== 1
      || value.status !== "exact"
      || value.sessionId !== sessionId
      || startExclusive === undefined
      || endInclusive === null
      || endInclusive === undefined
      || (startExclusive !== null && endInclusive <= startExclusive)
    ) return { unknown: true };
    return { range: { startExclusive, endInclusive } };
  } catch {
    return { unknown: true };
  }
}

function canonicalJson(value: unknown): string | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : null;
  if (Array.isArray(value)) {
    const children = value.map(canonicalJson);
    return children.some((child) => child === null) ? null : `[${children.join(",")}]`;
  }
  const record = recordValue(value);
  if (!record) return null;
  const entries = Object.keys(record).sort().map((key) => {
    const child = canonicalJson(record[key]);
    return child === null ? null : `${JSON.stringify(key)}:${child}`;
  });
  return entries.some((entry) => entry === null) ? null : `{${entries.join(",")}}`;
}

function samePersistedSelector(left: unknown, right: unknown): boolean {
  const leftJson = canonicalJson(left);
  return leftJson !== null && leftJson === canonicalJson(right);
}

function verifiedHistoryExecutionSpan(
  request: HermesNativeTranscriptReadRequest,
  sessionId: string,
): HistoryExecutionSpanCheck {
  const fail = (reason: string): HistoryExecutionSpanCheck => ({ ok: false, reason });
  const reader = recordValue(request.readerInput);
  const run = recordValue(reader?.run);
  const binding = recordValue(reader?.binding);
  const segment = recordValue(reader?.segment);
  const span = recordValue(reader?.span);
  const persistedSelector = recordValue(span?.selectorJson);
  const readerSelector = recordValue(reader?.selector);
  if (!reader) return fail("reader-input-missing");
  if (reader.readonly !== true || reader.scope !== "run" || !run || !binding || !segment || !span) {
    return fail("reader-shape-invalid");
  }
  if (!persistedSelector || !readerSelector) return fail("persisted-selector-missing");
  if (!samePersistedSelector(persistedSelector, readerSelector)
    || !samePersistedSelector(persistedSelector, request.selector)) return fail("persisted-selector-mismatch");

  const orgId = stringValue(reader.orgId);
  const runId = stringValue(run.id);
  const spanId = stringValue(span.id);
  const bindingId = stringValue(binding.id);
  const segmentId = stringValue(segment.id);
  const sessionRef = stringValue(readerSelector.sessionRef);
  const providerExecutionRef = stringValue(readerSelector.providerExecutionRef);
  const sourceRangeRef = stringValue(readerSelector.sourceRangeRef);
  if (!orgId || !runId || !spanId || !bindingId || !segmentId
    || !stringValue(binding.orgId) || !stringValue(segment.orgId)
    || !sessionRef || !providerExecutionRef || !sourceRangeRef) return fail("reader-identity-missing");

  const scopeChecks: Array<[string, boolean]> = [
    ["runtime", request.runtimeType === "hermes_gateway" && stringValue(binding.runtimeType) === "hermes_gateway" && stringValue(segment.runtimeType) === "hermes_gateway"],
    ["organization", run.orgId === orgId && span.orgId === orgId && binding.orgId === orgId && segment.orgId === orgId],
    ["run-span", span.runId === runId],
    ["span-binding-segment", span.bindingId === bindingId && span.segmentId === segmentId && segment.bindingId === bindingId],
    ["native-session", sessionRef === sessionId && stringValue(segment.nativeSessionId) === sessionId && run.sessionIdAfter === sessionId],
    ["request-session", stringValue(request.session.sessionId) === sessionId && stringValue(request.session.sessionDisplayId) === sessionId],
    ["request-binding", stringValue(request.binding?.id) === bindingId && stringValue(request.binding?.orgId) === orgId],
    ["span-sealed-complete", span.state === "sealed" && span.completeness === "complete" && Boolean(span.closedAt)],
    ["writer-lease-released", Boolean(span.writerLeaseReleasedAt)],
    ["segment-continuous", (segment.state === "open" && segment.sealedAt === null)
      || (segment.state === "sealed" && Boolean(segment.sealedAt))],
  ];
  const failedScope = scopeChecks.find(([, valid]) => !valid);
  if (failedScope) return fail(`reader-${failedScope[0]}`);

  const execution = exactHistoryExecutionRange(readerSelector, sessionId);
  if (!execution || "unknown" in execution) return fail("persisted-range-invalid");
  const intent = recordValue(run.sessionIntentJson);
  const freshSessionVerified = run.sessionIdBefore === null
    && run.sessionReuseScope === "none"
    && run.sessionIdAfter === sessionId
    && intent?.kind === "fresh"
    && intent.reuseScope === "none"
    && intent.sourceRunId === null
    && intent.sessionId === null
    && intent.sessionParams === null
    && !("sourceBoundaryRef" in intent);
  if (execution.range.startExclusive === null && !freshSessionVerified) return fail("fresh-session-unproven");

  return {
    ok: true,
    value: {
      range: execution.range,
      proof: {
        version: 1,
        orgId,
        runId,
        spanId,
        bindingId,
        segmentId,
        sessionId,
        providerExecutionRef,
        sourceRangeRef,
        freshSessionVerified,
      },
    },
  };
}

function numericHistoryRange(input: HermesNativeTranscriptReadRequest): HermesProductHistoryRange | null | undefined {
  const range = requestedRange(input);
  if (!range) return null;
  const startValue = range.fromExclusive !== undefined ? range.fromExclusive : range.start;
  const endValue = range.throughInclusive !== undefined ? range.throughInclusive : range.end;
  const start = startValue === undefined || startValue === null
    ? null
    : range.fromExclusive !== undefined
      ? safeHistoryBoundary(startValue)
      : (() => {
        const inclusive = safeHistoryBoundary(startValue);
        return inclusive === null ? null : inclusive === undefined ? undefined : inclusive === 0 ? null : inclusive - 1;
      })();
  const end = endValue === undefined || endValue === null ? null : safeHistoryBoundary(endValue);
  if (start === undefined || end === undefined || (start !== null && end !== null && end < start)) return undefined;
  return { startExclusive: start, endInclusive: end };
}

function intersectHistoryRanges(
  source: HermesProductHistoryRange,
  requested: HermesProductHistoryRange | null | undefined,
): HermesProductHistoryRange | undefined {
  if (requested === undefined) return undefined;
  if (!requested) return source;
  const sourceStart = source.startExclusive ?? null;
  const requestedStart = requested.startExclusive ?? null;
  const sourceEnd = source.endInclusive ?? null;
  const requestedEnd = requested.endInclusive ?? null;
  const startExclusive = sourceStart === null
    ? requestedStart
    : requestedStart === null
      ? sourceStart
      : Math.max(sourceStart, requestedStart);
  const endInclusive = sourceEnd === null
    ? requestedEnd
    : requestedEnd === null
      ? sourceEnd
      : Math.min(sourceEnd, requestedEnd);
  if (startExclusive !== null && endInclusive !== null && endInclusive <= startExclusive) return undefined;
  return { startExclusive, endInclusive };
}

function historyBoundaryUnknownResult(revision: string): HermesNativeTranscriptReadResult {
  return {
    items: [],
    nextCursor: null,
    source: "native",
    revision,
    availability: "missing",
    completeness: "unknown",
  };
}

function historyOwnershipUnknownResult(revision: string): HermesNativeTranscriptReadResult {
  return {
    items: [],
    nextCursor: null,
    source: "native",
    revision,
    availability: "available",
    completeness: "unknown",
  };
}

async function readProfileProductHistory(
  request: HermesNativeTranscriptReadRequest,
  historyProfile: HermesProductHistoryProfile,
  execution: VerifiedHistoryExecutionSpan | null,
): Promise<HermesNativeTranscriptReadResult> {
  const requested = numericHistoryRange(request);
  const range = execution ? intersectHistoryRanges(execution.range, requested) : requested;
  if (range === undefined) {
    return execution
      ? historyOwnershipUnknownResult("history-range-unknown")
      : historyBoundaryUnknownResult("history-range-unknown");
  }
  const readerInput = recordValue(request.readerInput);
  const maxBytes = typeof readerInput?.maxBytes === "number" ? readerInput.maxBytes : undefined;
  const maxItemBytes = typeof readerInput?.maxItemBytes === "number" ? readerInput.maxItemBytes : undefined;
  try {
    const result = execution
      ? await readHermesProductHistoryExecutionSpan({
        runtimeType: request.runtimeType,
        sessionId: request.session.sessionId,
        profile: historyProfile,
        range,
        proof: execution.proof,
        maxBytes,
        maxItemBytes,
        cursor: request.cursor,
        signal: request.signal,
      })
      : await readHermesProductHistory({
        runtimeType: request.runtimeType,
        sessionId: request.session.sessionId,
        profile: historyProfile,
        range,
        cursor: request.cursor,
        limit: TRANSCRIPT_PAGE_SIZE,
        maxBytes,
        maxItemBytes,
        signal: request.signal,
      });
    return {
      items: result.items,
      nextCursor: result.nextCursor,
      source: "native",
      revision: result.revision,
      availability: result.availability,
      completeness: result.completeness,
      limitReached: result.limitReached ? {
        reason: result.limitReached.reason === "scan_bytes" ? "total_bytes"
          : result.limitReached.reason === "scan_items" ? "total_items" : result.limitReached.reason,
        maximum: result.limitReached.maximum,
      } : undefined,
    };
  } catch (error) {
    const code = error instanceof HermesProductHistoryError ? error.code : "helper_failed";
    return {
      items: [],
      nextCursor: null,
      source: "native",
      revision: `history-error:${code}`,
      availability: code === "invalid_profile" || code === "scope_violation" ? "incompatible" : "offline",
      completeness: "unknown",
    };
  }
}

function textFrom(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  const record = recordValue(value);
  if (!record) return undefined;
  for (const key of ["text", "content", "output", "message", "delta", "summary"]) {
    const text = textFrom(record[key]);
    if (text !== undefined) return text;
  }
  if (Array.isArray(record.content)) {
    const text = record.content.map((entry) => textFrom(entry)).filter((entry): entry is string => entry !== undefined).join("\n");
    return text || undefined;
  }
  return undefined;
}

function recordTimestamp(record: HermesRecord): string {
  return stringValue(record.timestamp ?? record.created_at ?? record.createdAt ?? record.ts) ?? "";
}

function responseData(body: HermesRecord): HermesRecord[] {
  const candidates = [body.data, body.messages, body.items];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.map(recordValue).filter((entry): entry is HermesRecord => Boolean(entry));
  }
  return [];
}

function responseSessionId(body: HermesRecord): string | null {
  const session = recordValue(body.session);
  return stringValue(session?.id ?? body.id ?? body.session_id ?? body.sessionId);
}

function selectorValue(selector: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!selector) return null;
  for (const key of keys) {
    const value = stringValue(selector[key]);
    if (value) return value;
  }
  return null;
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

function applyRange(items: HermesNativeTranscriptRawItem[], range: HermesTranscriptRange | null | undefined): HermesNativeTranscriptRawItem[] {
  if (!range) return items;
  if (range.itemId) return items.filter((item) => item.id === range.itemId || item.sourceEntryId === range.itemId);
  const start = boundaryValue(range.start ?? range.fromExclusive);
  const end = boundaryValue(range.end ?? range.throughInclusive);
  let selected = items;
  if (start.id) {
    const index = selected.findIndex((item) => item.id === start.id || item.sourceEntryId === start.id);
    if (index >= 0) selected = selected.slice(range.fromExclusive !== undefined ? index + 1 : index);
  } else if (start.ordinal !== null) {
    selected = selected.filter((item) => item.ordinal >= start.ordinal! + (range.fromExclusive !== undefined ? 1 : 0));
  }
  if (end.id) {
    const index = selected.findIndex((item) => item.id === end.id || item.sourceEntryId === end.id);
    if (index >= 0) selected = selected.slice(0, index + 1);
  } else if (end.ordinal !== null) {
    selected = selected.filter((item) => item.ordinal <= end.ordinal!);
  }
  return selected;
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

function requestedRange(input: HermesNativeTranscriptReadRequest): HermesTranscriptRange | null {
  if (input.range) return input.range;
  if (input.from !== null && input.from !== undefined || input.through !== null && input.through !== undefined) {
    return {
      ...(input.from !== null && input.from !== undefined ? { fromExclusive: input.from } : {}),
      ...(input.through !== null && input.through !== undefined ? { throughInclusive: input.through } : {}),
    };
  }
  return null;
}

function profileBaseUrl(profile: HermesGatewayProfileTransport): URL | null {
  return baseUrl(profile.baseUrl instanceof URL ? profile.baseUrl.toString() : profile.baseUrl);
}

function requestHeaders(profile: HermesGatewayProfileTransport): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json", ...profile.headers };
  if (profile.apiKey && !Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) {
    headers.authorization = /^bearer\s+/i.test(profile.apiKey) ? profile.apiKey : `Bearer ${profile.apiKey}`;
  }
  return headers;
}

async function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Hermes transcript read cancelled."));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function cancelBody(cancel: () => Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(cancel).catch(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 1_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readHttpResponse<T>(
  profile: HermesGatewayProfileTransport,
  url: URL,
  init: RequestInit,
  signal: AbortSignal | undefined,
  read: (response: Response, signal: AbortSignal) => Promise<T>,
): Promise<{ response: Response; body: T | null }> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Hermes HTTP response deadline exceeded.")), 15_000);
  let response: Response | undefined;
  let bodyReadStarted = false;
  try {
    response = await abortable(async () => {
      const value = await (profile.fetch ?? fetch)(url, {
        ...init,
        redirect: "error",
        headers: { ...requestHeaders(profile), ...(init.headers ?? {}) },
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        if (value.body) await cancelBody(() => value.body!.cancel());
        controller.signal.throwIfAborted();
      }
      return value;
    }, controller.signal);
    if (!response.ok) return { response, body: null };
    bodyReadStarted = true;
    return { response, body: await read(response, controller.signal) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    controller.abort();
    if (response?.body && !bodyReadStarted) await cancelBody(() => response!.body!.cancel());
  }
}

async function* boundedResponseChunks(response: Response, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  if (!response.body) return;
  const reader = response.body.getReader();
  let bytes = 0;
  let completed = false;
  try {
    for (;;) {
      const { done, value } = await abortable(() => reader.read(), signal);
      if (done) {
        completed = true;
        return;
      }
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new Error(`Hermes transcript response exceeded ${MAX_BODY_BYTES} bytes.`);
      yield value;
    }
  } finally {
    if (!completed) await cancelBody(() => reader.cancel());
    reader.releaseLock();
  }
}

async function readJsonBody(response: Response, signal: AbortSignal): Promise<HermesRecord> {
  const chunks: Buffer[] = [];
  for await (const chunk of boundedResponseChunks(response, signal)) chunks.push(Buffer.from(chunk));
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  return recordValue(parsed) ?? {};
}

function historyItems(records: HermesRecord[], secrets: readonly string[]): HermesNativeTranscriptRawItem[] {
  return records.map((record, index) => {
    const id = stringValue(record.id ?? record.message_id ?? record.messageId) ?? `message:${index}`;
    const role = stringValue(record.role ?? record.type ?? record.kind) ?? "message";
    const safeRecord = redactProviderRecord(record, secrets);
    const text = textFrom(safeRecord);
    return {
      id: `hermes:message:${redactSecrets(id, secrets)}`,
      sourceEntryId: redactSecrets(id, secrets),
      ordinal: index,
      kind: `hermes:message:${role}`,
      ts: recordTimestamp(record),
      payload: { provider: "hermes_gateway", record: safeRecord },
      origin: "native",
      visibility: "visible",
      ...(text !== undefined ? { text } : {}),
    };
  });
}

function eventItems(events: HermesRecord[], runId: string, secrets: readonly string[]): HermesNativeTranscriptRawItem[] {
  return events.map((event, index) => {
    const id = stringValue(event.id ?? event.event_id ?? event.eventId) ?? `event:${index}`;
    const eventType = stringValue(event.event ?? event.type ?? event.kind) ?? "event";
    const safeEvent = redactProviderRecord(event, secrets);
    const text = textFrom(safeEvent);
    return {
      id: `hermes:event:${runId}:${redactSecrets(id, secrets)}`,
      sourceEntryId: redactSecrets(id, secrets),
      ordinal: index,
      kind: `hermes:event:${eventType}`,
      ts: recordTimestamp(event),
      payload: { provider: "hermes_gateway", runId, event: safeEvent },
      origin: "native",
      visibility: "visible",
      ...(text !== undefined ? { text } : {}),
    };
  });
}

async function readSseEvents(
  response: Response,
  runId: string,
  signal: AbortSignal,
): Promise<{ events: HermesRecord[]; malformed: boolean }> {
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let malformed = false;
  const events: HermesRecord[] = [];
  const flush = () => {
    if (dataLines.length === 0) return;
    const raw = dataLines.join("\n").trim();
    dataLines = [];
    if (!raw || raw === "[DONE]") return;
    try {
      const value = JSON.parse(raw);
      const event = recordValue(value);
      if (event) events.push(event);
      else malformed = true;
    } catch {
      malformed = true;
    }
  };
  for await (const value of boundedResponseChunks(response, signal)) {
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line === "") flush();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    for (const line of buffer.split(/\r?\n/)) {
      if (line === "") flush();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
  }
  flush();
  return { events, malformed };
}

async function readProfileTranscript(
  profile: HermesGatewayProfileTransport,
  request: HermesNativeTranscriptReadRequest,
): Promise<HermesNativeTranscriptReadResult> {
  const binding = request.binding;
  if (!binding || !binding.hostId.trim() || !binding.profileId.trim()) {
    return { items: [], nextCursor: null, source: "native", revision: "missing-binding", availability: "missing", completeness: "unknown" };
  }
  if (request.runtimeType !== "hermes_gateway") {
    return { items: [], nextCursor: null, source: "native", revision: "runtime-mismatch", availability: "incompatible", completeness: "unknown" };
  }
  if (!bindingMatches(binding, profile)) {
    return { items: [], nextCursor: null, source: "native", revision: "profile-mismatch", availability: "incompatible", completeness: "unknown" };
  }
  if (!profileIdentityMatches(request.session.sessionParams, binding)) {
    return { items: [], nextCursor: null, source: "native", revision: "session-profile-mismatch", availability: "incompatible", completeness: "unknown" };
  }
  const sessionId = request.session.sessionId.trim();
  if (!sessionId || stringValue(request.session.sessionParams.hermesSessionId) && stringValue(request.session.sessionParams.hermesSessionId) !== sessionId) {
    return { items: [], nextCursor: null, source: "native", revision: "session-id-mismatch", availability: "incompatible", completeness: "unknown" };
  }
  const storedVersion = stringValue(request.session.sessionParams.hermesProviderVersion);
  if (storedVersion && storedVersion !== profile.providerVersion) {
    return { items: [], nextCursor: null, source: "native", revision: "provider-version-mismatch", availability: "incompatible", completeness: "unknown" };
  }
  const storedTransport = stringValue(request.session.sessionParams.hermesTransport);
  if (
    storedTransport
    && storedTransport !== HERMES_NATIVE_TRANSPORT
    && storedTransport !== HERMES_PRODUCT_HISTORY_TRANSPORT
    && storedTransport !== HERMES_PRODUCT_RPC_TRANSPORT
  ) {
    return { items: [], nextCursor: null, source: "native", revision: "transport-mismatch", availability: "incompatible", completeness: "unknown" };
  }

  const selectorKind = stringValue(request.selector?.kind);
  const readerBound = request.readerInput !== undefined && request.readerInput !== null;
  const proofCheck = selectorKind === "hermes_execution"
    ? verifiedHistoryExecutionSpan(request, sessionId)
    : null;
  const execution = proofCheck?.ok ? proofCheck.value : null;
  const proofFailure = proofCheck && !proofCheck.ok ? proofCheck.reason : "reader-selector-missing";
  if (readerBound && !execution) return historyOwnershipUnknownResult(`execution-proof-unavailable:${proofFailure}`);

  // A host-authorized state.db profile is the only source allowed to answer
  // Run-bound reads. In particular, do not turn a missing/unknown boundary
  // into a whole-session HTTP read when two Runs share one Hermes session.
  if (historyProfileFieldsPresent(profile)) {
    const historyProfile = historyProfileFromGatewayProfile(profile);
    if (!historyProfile) return historyBoundaryUnknownResult("history-profile-missing");
    if (selectorKind === "hermes_execution" && !execution) {
      return historyOwnershipUnknownResult(`execution-proof-unavailable:${proofFailure}`);
    }
    return readProfileProductHistory(
      request,
      historyProfile,
      execution,
    );
  }

  const base = profileBaseUrl(profile);
  const evidence = profileEvidence(profile);
  if (!base) {
    return { items: [], nextCursor: null, source: "native", revision: "profile-mismatch", availability: "incompatible", completeness: "unknown" };
  }
  if (evidence.status !== "supported") {
    return { items: [], nextCursor: null, source: "native", revision: "profile-unverified", availability: "incompatible", completeness: "unknown" };
  }
  const storedUrl = stringValue(request.session.sessionParams.hermesBaseUrl ?? request.session.sessionParams.gatewayUrl);
  const normalizedStoredUrl = storedUrl ? baseUrl(storedUrl)?.toString() : null;
  if (storedUrl && (!normalizedStoredUrl || normalizedStoredUrl !== base.toString())) {
    return { items: [], nextCursor: null, source: "native", revision: "gateway-url-mismatch", availability: "incompatible", completeness: "unknown" };
  }
  if (storedTransport && storedTransport !== HERMES_NATIVE_TRANSPORT) {
    return { items: [], nextCursor: null, source: "native", revision: "transport-mismatch", availability: "incompatible", completeness: "unknown" };
  }
  const providerExecutionRef = selectorValue(request.selector, ["providerExecutionRef", "executionRef", "runId"]);
  let rawItems: HermesNativeTranscriptRawItem[] = [];
  let revision: string;
  let completeness: HermesNativeTranscriptReadResult["completeness"] = "complete";
  const secrets = profileSecrets(profile);
  try {
    const preflight = await preflightBaseUrl(base);
    if (!preflight.ok) return { items: [], nextCursor: null, source: "native", revision: "endpoint-rejected", availability: "incompatible", completeness: "unknown" };
    const { response: sessionResponse, body: sessionBody } = await readHttpResponse(
      profile,
      endpoint(base, `/api/sessions/${encodeURIComponent(sessionId)}`),
      {},
      request.signal,
      readJsonBody,
    );
    if (!sessionResponse.ok) {
      return {
        items: [],
        nextCursor: null,
        source: "native",
        revision: `session-http-${sessionResponse.status}`,
        availability: sessionResponse.status === 404 ? "missing" : "offline",
        completeness: "unknown",
      };
    }
    const returnedSessionId = responseSessionId(sessionBody!);
    if (!returnedSessionId || returnedSessionId !== sessionId) {
      return { items: [], nextCursor: null, source: "native", revision: "response-session-mismatch", availability: "incompatible", completeness: "unknown" };
    }
    if (providerExecutionRef) {
      const { response, body: streamed } = await readHttpResponse(
        profile,
        endpoint(base, `/v1/runs/${encodeURIComponent(providerExecutionRef)}/events`),
        { headers: { accept: "text/event-stream" } },
        request.signal,
        (response, signal) => readSseEvents(response, providerExecutionRef, signal),
      );
      if (!response.ok) {
        return { items: [], nextCursor: null, source: "native", revision: `events-http-${response.status}`, availability: response.status === 404 ? "missing" : "offline", completeness: "unknown" };
      }
      let eventSessionMismatch = false;
      const sessionEvents = streamed!.events.filter((event) => {
        const eventRun = stringValue(event.run_id ?? event.runId);
        const eventSession = stringValue(
          event.session_id
          ?? event.sessionId
          ?? recordValue(event.session)?.id,
        );
        if (eventSession && eventSession !== sessionId) {
          eventSessionMismatch = true;
          return false;
        }
        return !eventRun || eventRun === providerExecutionRef;
      });
      if (eventSessionMismatch) {
        return { items: [], nextCursor: null, source: "native", revision: "event-session-mismatch", availability: "incompatible", completeness: "unknown" };
      }
      rawItems = eventItems(sessionEvents, providerExecutionRef, secrets);
      completeness = streamed!.malformed ? "partial" : "complete";
      revision = stableHash(streamed!.events);
    } else {
      const { response, body } = await readHttpResponse(
        profile,
        endpoint(base, `/api/sessions/${encodeURIComponent(sessionId)}/messages`),
        {},
        request.signal,
        readJsonBody,
      );
      if (!response.ok) {
        return { items: [], nextCursor: null, source: "native", revision: `messages-http-${response.status}`, availability: response.status === 404 ? "missing" : "offline", completeness: "unknown" };
      }
      const returnedSessionId = responseSessionId(body!);
      if (returnedSessionId && returnedSessionId !== sessionId) {
        return { items: [], nextCursor: null, source: "native", revision: "response-session-mismatch", availability: "incompatible", completeness: "unknown" };
      }
      const records = responseData(body!);
      rawItems = historyItems(records, secrets);
      revision = stableHash(body!);
    }
  } catch {
    return { items: [], nextCursor: null, source: "native", revision: "transport-error", availability: "offline", completeness: "unknown" };
  }

  const ranged = applyRange(rawItems, requestedRange(request));
  const offset = decodeCursor(request.cursor, revision!);
  const page = ranged.slice(offset, offset + TRANSCRIPT_PAGE_SIZE);
  const nextCursor = offset + page.length < ranged.length ? encodeCursor(revision!, offset + page.length) : null;
  return {
    items: page,
    nextCursor,
    source: "native",
    revision: revision!,
    availability: "available",
    completeness,
  };
}

function profileEvidence(profile: HermesGatewayProfileTransport): HermesCapabilityEvidence {
  const base = profileBaseUrl(profile);
  if (!base || !profile.binding.hostId.trim() || !profile.binding.profileId.trim()) {
    return {
      status: "unknown",
      reason: "Hermes profile transport is missing a loopback base URL or host/profile identity.",
      providerVersion: profile.providerVersion ?? null,
      transport: HERMES_NATIVE_TRANSPORT,
      profileBound: false,
      profileRequired: true,
    };
  }
  if (!hasBearerAuth({ apiKey: profile.apiKey, headers: profile.headers })) {
    return {
      status: "unknown",
      reason: "Hermes profile transport is missing an explicit Bearer API credential.",
      providerVersion: profile.providerVersion ?? null,
      transport: HERMES_NATIVE_TRANSPORT,
      profileBound: true,
      profileRequired: true,
    };
  }
  if (!profile.providerVersion.trim() || !HERMES_SUPPORTED_VERSIONS.includes(profile.providerVersion as (typeof HERMES_SUPPORTED_VERSIONS)[number])) {
    return {
      status: "unknown",
      reason: `Hermes endpoint compatibility is confirmed only for ${HERMES_SUPPORTED_VERSIONS.join(", ")}; profile version ${profile.providerVersion || "missing"} is not verified.`,
      providerVersion: profile.providerVersion ?? null,
      transport: HERMES_NATIVE_TRANSPORT,
      profileBound: true,
      profileRequired: true,
    };
  }
  return {
    status: "supported",
    reason: `Hermes ${profile.providerVersion} profile ${profile.binding.hostId}/${profile.binding.profileId} is bound to the verified Sessions API and Run SSE transport at ${base.origin}.`,
    providerVersion: profile.providerVersion,
    transport: HERMES_NATIVE_TRANSPORT,
    profileBound: true,
    profileRequired: true,
  };
}

function unsupportedNativeEvidence(
  profile: HermesGatewayProfileTransport,
  capability: "boundary fork" | "steer",
): HermesCapabilityEvidence {
  const evidence = profileEvidence(profile);
  if (evidence.status !== "supported") {
    return {
      ...evidence,
      reason: `${evidence.reason} Hermes ${capability} remains unclassified until the verified profile transport is available.`,
    };
  }
  return {
    status: "unsupported",
    reason: capability === "boundary fork"
      ? `Hermes ${profile.providerVersion} exposes /api/sessions/:id, /api/sessions/:id/messages, /v1/runs/:id/events, and /v1/runs/:id/stop, but no verified boundary-fork endpoint; this adapter will not synthesize a fork.`
      : `Hermes ${profile.providerVersion} has no native steer method in the verified Runs API.`,
    providerVersion: profile.providerVersion,
    transport: HERMES_NATIVE_TRANSPORT,
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
  session?: HermesProviderSessionRef | null;
  binding?: HermesProviderBindingRef | null;
};

async function forwardLiveSteer(input: ProviderControlRequest): Promise<AgentRuntimeControlSteerResult> {
  if (!input.handle || input.operation.kind !== "steer") {
    return {
      disposition: "acceptance_unknown",
      reason: "Hermes Gateway steer requires the live run handle registered for the active run.",
    };
  }
  return input.handle.steer(input.operation.input);
}

async function forwardLiveInterrupt(input: ProviderControlRequest): Promise<AgentRuntimeControlInterruptResult> {
  if (!input.handle || input.operation.kind !== "interrupt") return "unverified";
  return input.handle.interrupt(input.operation.reason);
}

export interface HermesRuntimeProviderControlCapabilities {
  steer: {
    evidence: HermesCapabilityEvidence;
    mode?: "native" | "remote" | "interrupt_continue";
    requiresHandle?: boolean;
    execute?: (input: ProviderControlRequest) => Promise<AgentRuntimeControlSteerResult>;
  };
  interrupt: {
    evidence: HermesCapabilityEvidence;
    mode: "native" | "remote" | "interrupt_continue";
    requiresHandle: boolean;
    execute: (input: ProviderControlRequest) => Promise<AgentRuntimeControlInterruptResult>;
  };
}

const staticSessionResumeEvidence: HermesCapabilityEvidence = {
  status: "supported",
  reason: "Hermes Gateway resolves persisted sessions through /api/sessions/:id and reads their messages before /v1/runs.",
  transport: HERMES_NATIVE_TRANSPORT,
  profileBound: false,
  profileRequired: true,
};
const staticInputEvidence: HermesCapabilityEvidence = {
  status: "supported",
  reason: "Hermes Gateway execute submits the registered run payload through POST /v1/runs.",
  transport: HERMES_NATIVE_TRANSPORT,
  profileBound: true,
  profileRequired: false,
};
const staticContextEvidence: HermesCapabilityEvidence = {
  status: "supported",
  reason: "Hermes context handoff is an auditable bounded prompt projection; it is not a native provider fork.",
  transport: HERMES_NATIVE_TRANSPORT,
  profileBound: true,
  profileRequired: false,
};
const staticTranscriptEvidence: HermesCapabilityEvidence = {
  status: "unknown",
  reason: "Hermes native history requires a host-owned profile transport with the verified Sessions API and Run SSE source.",
  transport: HERMES_NATIVE_TRANSPORT,
  profileBound: false,
  profileRequired: true,
};
const staticForkEvidence: HermesCapabilityEvidence = {
  status: "unknown",
  reason: "Hermes fork cannot be classified without a bound gateway version/profile; no fork endpoint is inferred from session resume.",
  transport: HERMES_NATIVE_TRANSPORT,
  profileBound: false,
  profileRequired: true,
};

const staticControlCapabilities: HermesRuntimeProviderControlCapabilities = {
  steer: {
    evidence: {
      status: "unsupported",
      reason: "The verified Hermes Runs API has no native steer operation.",
      transport: HERMES_NATIVE_TRANSPORT,
      profileBound: true,
      profileRequired: false,
    },
  },
  interrupt: {
    evidence: {
      status: "supported",
      reason: "Hermes Gateway registers the live run handle used for POST /v1/runs/:id/stop.",
      transport: HERMES_NATIVE_TRANSPORT,
      profileBound: false,
      profileRequired: true,
    },
    mode: "remote",
    requiresHandle: true,
    execute: forwardLiveInterrupt,
  },
};

type HermesRuntimeProviderCapabilityRegistration = {
  runtimeType: "hermes_gateway";
  sessionResume: { evidence: HermesCapabilityEvidence };
  input: { evidence: HermesCapabilityEvidence };
  contextHandoff: { evidence: HermesCapabilityEvidence };
  transcript: { evidence: HermesCapabilityEvidence };
  fork: { evidence: HermesCapabilityEvidence };
  control: HermesRuntimeProviderControlCapabilities;
};

export const runtimeProviderCapabilities: HermesRuntimeProviderCapabilityRegistration = {
  runtimeType: "hermes_gateway",
  sessionResume: { evidence: staticSessionResumeEvidence },
  input: { evidence: staticInputEvidence },
  contextHandoff: { evidence: staticContextEvidence },
  transcript: { evidence: staticTranscriptEvidence },
  fork: { evidence: staticForkEvidence },
  control: staticControlCapabilities,
};

export interface HermesRuntimeProviderCapabilityAdapter {
  runtimeType: "hermes_gateway";
  sessionResume: { evidence: HermesCapabilityEvidence };
  input: { evidence: HermesCapabilityEvidence };
  contextHandoff: { evidence: HermesCapabilityEvidence };
  transcript: {
    evidence: HermesCapabilityEvidence;
    readRange: (input: HermesNativeTranscriptReadRequest) => Promise<HermesNativeTranscriptReadResult>;
  };
  fork: { evidence: HermesCapabilityEvidence };
  control: HermesRuntimeProviderControlCapabilities;
}

function unknownCapabilities(reason: string): HermesRuntimeProviderCapabilityAdapter {
  return {
    runtimeType: "hermes_gateway",
    sessionResume: { evidence: { ...staticSessionResumeEvidence, reason } },
    input: { evidence: staticInputEvidence },
    contextHandoff: { evidence: staticContextEvidence },
    transcript: {
      evidence: { ...staticTranscriptEvidence, reason },
      readRange: async () => ({ items: [], nextCursor: null, source: "native", revision: "unavailable", availability: "offline", completeness: "unknown" }),
    },
    fork: { evidence: { ...staticForkEvidence, reason } },
    control: runtimeProviderCapabilities.control,
  };
}

function boundCapabilities(profile: HermesGatewayProfileTransport): HermesRuntimeProviderCapabilityAdapter {
  const evidence = profileEvidence(profile);
  const transcriptEvidence = historyProfileFieldsPresent(profile)
    ? historyProfileEvidence(profile)
    : evidence;
  return {
    runtimeType: "hermes_gateway",
    sessionResume: { evidence },
    input: { evidence },
    contextHandoff: {
      evidence: {
        ...evidence,
        reason: `${evidence.reason} Context handoff is recorded as a bounded prompt projection and is not lossless native continuity.`,
      },
    },
    transcript: {
      evidence: transcriptEvidence,
      readRange: (input) => readProfileTranscript(profile, input),
    },
    fork: { evidence: unsupportedNativeEvidence(profile, "boundary fork") },
    control: {
      steer: {
        evidence: unsupportedNativeEvidence(profile, "steer"),
      },
      interrupt: {
        evidence,
        mode: "remote",
        requiresHandle: true,
        execute: forwardLiveInterrupt,
      },
    },
  };
}

export function createHermesGatewayProviderCapabilities(
  profile: HermesGatewayProfileTransport,
): HermesRuntimeProviderCapabilityAdapter {
  return boundCapabilities(profile);
}

export function createHermesGatewayProviderCapabilityResolver(
  resolveProfile: HermesGatewayProfileTransportResolver | null | undefined,
): (runtimeType: string, binding?: HermesProviderBindingRef | null) => HermesRuntimeProviderCapabilityAdapter | null {
  return (runtimeType, binding) => {
    if (runtimeType !== "hermes_gateway") return null;
    if (!binding?.hostId?.trim() || !binding.profileId?.trim()) {
      return unknownCapabilities("Hermes native history and remote control require an explicit host/profile binding.");
    }
    if (!resolveProfile) return unknownCapabilities("No Hermes profile-bound HTTP/SSE transport resolver is installed.");
    let profile: HermesGatewayProfileTransport | null | undefined;
    try {
      profile = resolveProfile(binding);
    } catch (error) {
      return unknownCapabilities(`Hermes profile transport resolution failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!profile) return unknownCapabilities(`No Hermes gateway transport is authorized for profile ${binding.profileId}.`);
    if (!bindingMatches(binding, profile)) {
      const reason = `Hermes profile transport identity mismatch; native history and remote control are unsupported for requested ${binding.hostId}/${binding.profileId}.`;
      const mismatch = unknownCapabilities(reason);
      mismatch.transcript.evidence = { ...mismatch.transcript.evidence, status: "unsupported", reason };
      mismatch.fork.evidence = { ...mismatch.fork.evidence, status: "unsupported", reason };
      return mismatch;
    }
    return boundCapabilities(profile);
  };
}

export const resolveHermesGatewayProviderCapabilities = createHermesGatewayProviderCapabilityResolver;

/**
 * ACP is a separate profile transport from the legacy Hermes HTTP gateway.
 * Keep its credentials/process environment in the resolver closure and only
 * expose opaque binding/session identity to the server capability layer.
 */
export type HermesAcpProfileTransport = HermesAcpProfile;
export type HermesAcpProfileTransportResolver = (
  binding: HermesProviderBindingRef,
) => HermesAcpProfileTransport | null | undefined;

export type HermesAcpNativeTranscriptReadRequest = HermesNativeTranscriptReadRequest;

export type HermesAcpRuntimeProviderCapabilityAdapter = {
  runtimeType: "hermes_gateway";
  sessionResume: { evidence: HermesCapabilityEvidence };
  input: { evidence: HermesCapabilityEvidence };
  contextHandoff: { evidence: HermesCapabilityEvidence };
  transcript: {
    evidence: HermesCapabilityEvidence;
    readRange: (input: HermesAcpNativeTranscriptReadRequest) => Promise<HermesAcpTranscriptResult>;
  };
  fork: {
    evidence: HermesCapabilityEvidence;
    execute: (input: {
      runtimeType: string;
      session: HermesProviderSessionRef;
      boundary: string;
      binding?: HermesProviderBindingRef | null;
      signal?: AbortSignal;
    }) => Promise<HermesAcpForkResult>;
  };
  control: HermesRuntimeProviderControlCapabilities;
};

function acpBindingMatches(requested: HermesProviderBindingRef, profile: HermesAcpProfileTransport): boolean {
  return requested.hostId.trim() === profile.binding.hostId.trim()
    && requested.profileId.trim() === profile.binding.profileId.trim()
    && (!requested.id || !profile.binding.id || requested.id === profile.binding.id)
    && (!requested.orgId || !profile.binding.orgId || requested.orgId === profile.binding.orgId)
    && (!requested.workspaceBindingId || !profile.binding.workspaceBindingId || requested.workspaceBindingId === profile.binding.workspaceBindingId)
    && (!requested.capabilityRevision || !profile.binding.capabilityRevision || requested.capabilityRevision === profile.binding.capabilityRevision);
}

function acpWorkspaceFromSession(session: HermesProviderSessionRef): HermesAcpWorkspace | null {
  const params = session.sessionParams;
  const value = (keys: readonly string[]): string | null => {
    for (const key of keys) {
      const candidate = stringValue(params[key]);
      if (candidate) return candidate;
    }
    return null;
  };
  const workspace: HermesAcpWorkspace = {
    workspaceId: value(["workspaceId", "workspace_id"]),
    repoUrl: value(["repoUrl", "repo_url"]),
    repoRef: value(["repoRef", "repo_ref"]),
    workspaceBindingId: value(["workspaceBindingId", "workspace_binding_id"]),
  };
  return Object.values(workspace).some(Boolean) ? workspace : null;
}

function acpRangeValue(value: unknown): string | number | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const record = recordValue(value);
  if (record) {
    const itemId = stringValue(record.itemId);
    if (itemId) return itemId;
    if (typeof record.ordinal === "number" && Number.isFinite(record.ordinal)) return record.ordinal;
  }
  return null;
}

function acpProfileEvidence(profile: HermesAcpProfileTransport): HermesCapabilityEvidence {
  if (!profile.binding.hostId.trim() || !profile.binding.profileId.trim()) {
    return {
      status: "unknown",
      reason: "Hermes ACP profile is missing explicit host/profile identity.",
      providerVersion: profile.providerVersion ?? null,
      transport: HERMES_ACP_NATIVE_TRANSPORT,
      profileBound: false,
      profileRequired: true,
    };
  }
  if (!profile.command.trim() || !path.isAbsolute(profile.cwd)) {
    return {
      status: "unknown",
      reason: "Hermes ACP profile requires a command and absolute cwd.",
      providerVersion: profile.providerVersion ?? null,
      transport: HERMES_ACP_NATIVE_TRANSPORT,
      profileBound: false,
      profileRequired: true,
    };
  }
  if (!stringValue(profile.providerVersion)) {
    return {
      status: "unknown",
      reason: "Hermes ACP capability evidence requires the installed provider version.",
      transport: HERMES_ACP_NATIVE_TRANSPORT,
      profileBound: true,
      profileRequired: true,
    };
  }
  if (!HERMES_ACP_VERIFIED_VERSIONS.includes(profile.providerVersion as (typeof HERMES_ACP_VERIFIED_VERSIONS)[number])) {
    return {
      status: "unknown",
      reason: `Hermes ACP session capabilities are verified only for ${HERMES_ACP_VERIFIED_VERSIONS.join(", ")}; profile version ${profile.providerVersion} is unverified.`,
      providerVersion: profile.providerVersion,
      transport: HERMES_ACP_NATIVE_TRANSPORT,
      profileBound: true,
      profileRequired: true,
    };
  }
  if (profile.protocolVersion !== undefined && profile.protocolVersion !== 1) {
    return {
      status: "unknown",
      reason: `Hermes ACP protocol ${profile.protocolVersion} has not been verified; the installed Hermes contract uses protocol 1.`,
      providerVersion: profile.providerVersion,
      transport: HERMES_ACP_NATIVE_TRANSPORT,
      profileBound: true,
      profileRequired: true,
    };
  }
  return {
    status: "supported",
    reason: `Hermes ${profile.providerVersion} exposes ACP initialize, session/new, session/load, session/prompt, session/cancel, and session/fork on the bound stdio profile transport.`,
    providerVersion: profile.providerVersion,
    transport: HERMES_ACP_NATIVE_TRANSPORT,
    profileBound: true,
    profileRequired: true,
  };
}

function acpUnavailable(reason: string): HermesAcpRuntimeProviderCapabilityAdapter {
  const evidence: HermesCapabilityEvidence = {
    status: "unknown",
    reason,
    transport: HERMES_ACP_NATIVE_TRANSPORT,
    profileBound: false,
    profileRequired: true,
  };
  return {
    runtimeType: "hermes_gateway",
    sessionResume: { evidence },
    input: { evidence },
    contextHandoff: { evidence },
    transcript: {
      evidence,
      readRange: async () => ({ items: [], nextCursor: null, source: "native", revision: "unavailable", availability: "offline", completeness: "unknown" }),
    },
    fork: {
      evidence,
      execute: async () => { throw new Error(reason); },
    },
    control: {
      steer: { evidence },
      interrupt: { evidence, mode: "native", requiresHandle: true, execute: async () => "unverified" },
    },
  };
}

async function forwardAcpSteer(input: ProviderControlRequest): Promise<AgentRuntimeControlSteerResult> {
  if (!input.handle || input.operation.kind !== "steer") {
    return {
      disposition: "acceptance_unknown",
      reason: "Hermes ACP session/prompt input requires the live run control handle for delivery acknowledgement.",
    };
  }
  return input.handle.steer(input.operation.input);
}

async function forwardAcpInterrupt(input: ProviderControlRequest): Promise<AgentRuntimeControlInterruptResult> {
  if (!input.handle || input.operation.kind !== "interrupt") return "unverified";
  return input.handle.interrupt(input.operation.reason);
}

function boundAcpCapabilities(
  profile: HermesAcpProfileTransport,
  productRpcProfile?: boolean,
): HermesAcpRuntimeProviderCapabilityAdapter {
  const productProfile = productRpcProfile ?? isHermesProductRpcProfile(profile as Partial<HermesProductRpcProfile>);
  const productEvidence = hermesProductRpcProfileEvidence(profile as Partial<HermesProductRpcProfile>);
  const evidence: HermesCapabilityEvidence = productProfile
    ? {
      ...productEvidence,
      providerVersion: profile.providerVersion ?? null,
      transport: HERMES_PRODUCT_RPC_TRANSPORT,
      profileBound: true,
      profileRequired: true,
    }
    : acpProfileEvidence(profile);
  const steerEvidence: HermesCapabilityEvidence = productProfile
    ? {
      ...evidence,
      status: evidence.status === "supported" ? "unknown" : evidence.status,
      reason: evidence.status === "supported"
        ? "Hermes Product Gateway exposes session.redirect, but active-turn redirect support is model-specific and is confirmed only by the live RPC response."
        : evidence.reason,
    }
    : evidence.status === "supported"
      ? {
        ...evidence,
        status: "unsupported",
        reason: "Hermes ACP has no native steer method; a concurrent session/prompt is queued as a follow-up.",
      }
      : evidence;
  const historyProfileAvailable = acpHistoryProfileAvailable(profile);
  const readRange = async (input: HermesAcpNativeTranscriptReadRequest): Promise<HermesAcpTranscriptResult> => {
    if (input.runtimeType !== "hermes_gateway") return { items: [], nextCursor: null, source: "native", revision: "runtime-mismatch", availability: "incompatible", completeness: "unknown" };
    if (!input.binding || !acpBindingMatches(input.binding, profile)) return { items: [], nextCursor: null, source: "native", revision: "profile-mismatch", availability: "incompatible", completeness: "unknown" };
    const params = input.session.sessionParams;
    const transport = stringValue(params.transport);
    if (transport !== HERMES_ACP_NATIVE_TRANSPORT && transport !== HERMES_PRODUCT_RPC_TRANSPORT) return { items: [], nextCursor: null, source: "native", revision: "transport-mismatch", availability: "incompatible", completeness: "unknown" };
    const range = input.range
      ? {
        ...(acpRangeValue(input.range.start) !== null ? { start: acpRangeValue(input.range.start) } : {}),
        ...(acpRangeValue(input.range.end) !== null ? { end: acpRangeValue(input.range.end) } : {}),
        ...(input.range.itemId ? { itemId: input.range.itemId } : {}),
      }
      : null;
    if (productProfile && transport === HERMES_PRODUCT_RPC_TRANSPORT) {
      const rejection = validateHermesProductRpcSession({
        sessionId: input.session.sessionId,
        sessionParams: params,
        profile: profile as HermesProductRpcProfile,
      });
      if (rejection) {
        return { items: [], nextCursor: null, source: "native", revision: "session-profile-mismatch", availability: "incompatible", completeness: "unknown" };
      }
      const history = await readProfileTranscript(gatewayProfileForAcpHistory(profile), input);
      return history;
    }
    if (!profileIdentityMatches(params, profile.binding)) {
      return { items: [], nextCursor: null, source: "native", revision: "session-profile-mismatch", availability: "incompatible", completeness: "unknown" };
    }
    const result = await readHermesAcpNativeTranscript({
      runtimeType: input.runtimeType,
      profile,
      session: input.session,
      binding: input.binding,
      workspace: acpWorkspaceFromSession(input.session),
      selector: input.selector,
      range,
      from: input.from,
      through: input.through,
      cursor: input.cursor,
      signal: input.signal,
    });
    return result;
  };
  return {
    runtimeType: "hermes_gateway",
    sessionResume: { evidence },
    input: { evidence },
    contextHandoff: {
      evidence: {
        ...evidence,
        reason: `${evidence.reason} Context handoff stays inside the provider session; it is not synthetic HTTP continuity.`,
      },
    },
    transcript: {
      evidence: historyProfileAvailable
        ? {
          ...evidence,
          status: "supported",
          transport: HERMES_PRODUCT_HISTORY_TRANSPORT,
          reason: `${evidence.reason} Session history is readable, but Hermes 0.21.0 provides no prompt-scoped row locator. Product Gateway advertises and enforces per_session_exclusive_submit by claiming a durable per-session lease before prompt mutation and retaining it until session finalization. Rudder's before-history snapshot precedes prompt.submit, where that lease is acquired; another owner can append rows and release its lease in the gap, so same-session row windows can contain foreign assistant/tool rows and Run spans remain unknown. Exact-span reads reject cursors, cap selection at 200 rows, and bind revision to the selected row locators and raw payloads before returning no Run-owned rows. Compression successors also remain unknown because compacted handoffs have no source-row locators.`,
        }
        : {
          ...evidence,
          status: "unknown",
          reason: `${evidence.reason} A host-authorized Python/source/HERMES_HOME history profile is required before ACP transcript ranges can be read.`,
        },
      readRange,
    },
    fork: {
      evidence: {
        ...evidence,
        status: productProfile || evidence.status !== "supported" ? evidence.status : "unsupported",
        transport: productProfile ? HERMES_PRODUCT_RPC_TRANSPORT : evidence.transport,
        reason: productProfile
          ? evidence.status === "supported"
            ? `${evidence.reason} The versioned SessionDB helper copies and verifies the visible prefix through an exact assistant row boundary.`
            : `${evidence.reason} Exact native Fork remains unclassified for this Product Gateway profile.`
          : evidence.status === "supported"
            ? "Hermes ACP session/fork copies the current head and cannot honor a selected historical message boundary."
            : `${evidence.reason} Historical Fork remains unclassified for this ACP profile.`,
      },
      execute: (input) => {
        if (productProfile) {
          return forkHermesProductRpcNativeSession({
            runtimeType: input.runtimeType,
            profile: profile as HermesProductRpcProfile,
            session: input.session,
            boundary: input.boundary,
            binding: input.binding,
            workspace: acpWorkspaceFromSession(input.session),
            signal: input.signal,
          });
        }
        return forkHermesAcpNativeSession({
          runtimeType: input.runtimeType,
          session: input.session,
          boundary: input.boundary,
          binding: input.binding,
          workspace: acpWorkspaceFromSession(input.session),
          signal: input.signal,
          profile,
        });
      },
    },
    control: {
      steer: {
        evidence: steerEvidence,
        mode: "native",
        requiresHandle: true,
        execute: forwardAcpSteer,
      },
      interrupt: {
        evidence,
        mode: "native",
        requiresHandle: true,
        execute: forwardAcpInterrupt,
      },
    },
  };
}

export function createHermesAcpProviderCapabilities(
  profile: HermesAcpProfileTransport,
  options: { productRpcProfile?: boolean } = {},
): HermesAcpRuntimeProviderCapabilityAdapter {
  return boundAcpCapabilities(profile, options.productRpcProfile);
}

export function createHermesAcpProviderCapabilityResolver(
  resolveProfile: HermesAcpProfileTransportResolver | null | undefined,
): (runtimeType: string, binding?: HermesProviderBindingRef | null) => HermesAcpRuntimeProviderCapabilityAdapter | null {
  return (runtimeType, binding) => {
    if (runtimeType !== "hermes_gateway") return null;
    if (!binding?.hostId?.trim() || !binding.profileId?.trim()) return acpUnavailable("Hermes ACP requires an explicit host/profile binding.");
    if (!resolveProfile) return acpUnavailable("No Hermes ACP profile resolver is installed.");
    let profile: HermesAcpProfileTransport | null | undefined;
    try {
      profile = resolveProfile(binding);
    } catch (error) {
      return acpUnavailable(`Hermes ACP profile resolution failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!profile) return acpUnavailable(`No Hermes ACP profile is authorized for ${binding.profileId}.`);
    if (!acpBindingMatches(binding, profile)) return acpUnavailable(`Hermes ACP profile identity mismatch for ${binding.hostId}/${binding.profileId}.`);
    return boundAcpCapabilities(profile);
  };
}
