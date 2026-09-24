import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseCodexStdoutLine } from "../ui/parse-stdout.js";
import { createCodexAppServerServerRequestHandlers, normalizeThreadItem } from "./app-server-chat.js";
import {
  CodexAppServerClient,
  CodexAppServerClosedError,
  CodexAppServerProtocolError,
  CodexAppServerRpcError,
  CodexAppServerTimeoutError,
  createCodexAppServerStdioTransport,
} from "./app-server-client.js";

export type CodexNativeCapabilityStatus = "supported" | "unsupported" | "unknown";

export interface CodexProviderBindingRef {
  id?: string | null;
  orgId?: string | null;
  hostId: string;
  profileId: string;
  workspaceBindingId?: string | null;
  capabilityRevision?: string | null;
}

export interface CodexProviderSessionRef {
  sessionId: string;
  sessionParams: Record<string, unknown>;
  sessionDisplayId: string;
}

export interface CodexNativeTranscriptReadRequest {
  runtimeType: string;
  session: CodexProviderSessionRef;
  selector?: unknown;
  binding?: CodexProviderBindingRef | null;
  range?: unknown;
  from?: unknown;
  through?: unknown;
  cursor?: string | null;
  readerInput?: unknown | null;
  signal?: AbortSignal;
}

export interface CodexNativeTranscriptReadResult {
  items?: readonly Record<string, unknown>[];
  entries?: readonly Record<string, unknown>[];
  nextCursor?: string | null;
  revision?: string | null;
  source?: "native" | "native_plus_objects" | "legacy";
  availability?: "available" | "offline" | "missing" | "expired" | "incompatible";
  completeness?: "complete" | "partial" | "terminal_only" | "unknown";
}

export interface CodexNativeForkRequest {
  runtimeType: string;
  session: CodexProviderSessionRef;
  boundary: string;
  selector?: unknown;
  binding?: CodexProviderBindingRef | null;
  signal?: AbortSignal;
}

export interface CodexNativeForkResult {
  session: CodexProviderSessionRef;
  boundary: string;
  sourceBoundary?: string | null;
  identityMap?: Record<string, string>;
  continuity: "native";
}

export interface CodexAppServerProfileTransport {
  /** The profile that authorized this exact command, cwd, and environment. */
  binding: CodexProviderBindingRef;
  command: string;
  args?: readonly string[];
  cwd: string;
  /** This environment is owned by the resolver; it is never merged from the caller. */
  env: Readonly<Record<string, string>>;
  providerVersion?: string | null;
  /** Explicit protocol evidence. Missing flags remain unknown. */
  methods?: {
    threadResume?: boolean;
    threadRead?: boolean;
    threadFork?: boolean;
  };
}

export type CodexAppServerProfileTransportResolver = (
  binding: CodexProviderBindingRef,
) => CodexAppServerProfileTransport | null | undefined;

export interface CodexCapabilityEvidence {
  status: CodexNativeCapabilityStatus;
  reason: string;
  providerVersion?: string | null;
  transport?: string | null;
  profileBound: boolean;
  profileRequired?: boolean;
}

export class CodexNativeCapabilityError extends Error {
  override readonly name = "CodexNativeCapabilityError";

  constructor(
    readonly status: Exclude<CodexNativeCapabilityStatus, "supported">,
    message: string,
  ) {
    super(message);
  }
}

type JsonRecord = Record<string, unknown>;
type NativeTranscriptRecord = Record<string, unknown>;

const APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;
const APP_SERVER_PROCESS_HARD_DEADLINE_MS = 2_000;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function hasFullItemsView(value: unknown): boolean {
  return value === undefined || value === "full" || asRecord(value)?.type === "full";
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringAt(record: JsonRecord | null, keys: readonly string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = nonEmptyString(record[key]);
    if (value) return value;
  }
  return null;
}

function bindingIsUsable(binding: CodexProviderBindingRef | null | undefined): binding is CodexProviderBindingRef {
  return Boolean(
    typeof binding?.hostId === "string"
      && binding.hostId.trim()
      && typeof binding.profileId === "string"
      && binding.profileId.trim(),
  );
}

function profileBindingMatches(
  requested: CodexProviderBindingRef,
  profile: CodexAppServerProfileTransport,
): boolean {
  const actual = profile?.binding;
  if (!bindingIsUsable(actual)) return false;
  const optionalIdentityMatches = (key: keyof CodexProviderBindingRef): boolean => {
    const expected = requested[key];
    return expected === undefined || expected === null
      ? true
      : actual[key] === expected;
  };
  return actual.hostId.trim() === requested.hostId.trim()
    && actual.profileId.trim() === requested.profileId.trim()
    && optionalIdentityMatches("id")
    && optionalIdentityMatches("orgId")
    && optionalIdentityMatches("workspaceBindingId")
    && optionalIdentityMatches("capabilityRevision");
}

function validProfile(profile: CodexAppServerProfileTransport): boolean {
  const binding = profile?.binding;
  const cwd = profile?.cwd;
  const codeHome = profile?.env?.CODEX_HOME;
  return Boolean(
    typeof profile?.command === "string"
      && profile.command.trim()
      && typeof cwd === "string"
      && path.isAbsolute(cwd)
      && bindingIsUsable(binding)
      && typeof codeHome === "string"
      && path.isAbsolute(codeHome.trim()),
  );
}

export function codexProfileMethodEvidence(
  profile: CodexAppServerProfileTransport | null | undefined,
  method: "thread/resume" | "thread/read" | "thread/fork",
): CodexCapabilityEvidence {
  const methodKey = method === "thread/resume"
    ? "threadResume"
    : method === "thread/read"
      ? "threadRead"
      : "threadFork";
  const methodLabel = method === "thread/resume"
    ? "thread resume"
    : method === "thread/read"
      ? "transcript history"
      : "boundary fork";
  if (!profile) {
    return {
      status: "unknown",
      reason: `Codex ${methodLabel} requires a resolved profile-bound App Server transport.`,
      transport: "codex-app-server-stdio",
      profileBound: false,
      profileRequired: true,
    };
  }
  if (!validProfile(profile)) {
    return {
      status: "unknown",
      reason: `Codex ${methodLabel} transport is missing an absolute cwd, CODEX_HOME, or profile identity.`,
      providerVersion: profile.providerVersion ?? null,
      transport: "codex-app-server-stdio",
      profileBound: false,
      profileRequired: true,
    };
  }
  if (!profile.providerVersion?.trim()) {
    return {
      status: "unknown",
      reason: `Codex ${methodLabel} is disabled because the App Server provider version is unknown.`,
      transport: "codex-app-server-stdio",
      profileBound: true,
      profileRequired: true,
    };
  }
  const methodSupport = profile.methods?.[methodKey];
  if (methodSupport === false) {
    return {
      status: "unsupported",
      reason: `Codex App Server ${method} is not supported by provider version ${profile.providerVersion}.`,
      providerVersion: profile.providerVersion,
      transport: "codex-app-server-stdio",
      profileBound: true,
      profileRequired: true,
    };
  }
  if (methodSupport !== true) {
    return {
      status: "unknown",
      reason: `Codex App Server ${method} support is not verified for provider version ${profile.providerVersion}.`,
      providerVersion: profile.providerVersion,
      transport: "codex-app-server-stdio",
      profileBound: true,
      profileRequired: true,
    };
  }
  return {
    status: "supported",
    reason: `Codex App Server ${method} is verified for the bound profile ${profile.binding.profileId}.`,
    providerVersion: profile.providerVersion,
    transport: "codex-app-server-stdio",
    profileBound: true,
    profileRequired: true,
  };
}

function capabilityError(status: Exclude<CodexNativeCapabilityStatus, "supported">, message: string): CodexNativeCapabilityError {
  return new CodexNativeCapabilityError(status, message);
}

function normalizeTransportError(error: unknown, operation: string): CodexNativeCapabilityError | null {
  if (error instanceof CodexNativeCapabilityError) return error;
  if (error instanceof CodexAppServerRpcError) {
    return capabilityError(
      error.code === -32601 ? "unsupported" : "unknown",
      `Codex App Server ${operation} failed: ${error.message}`,
    );
  }
  if (error instanceof CodexAppServerTimeoutError || error instanceof CodexAppServerClosedError) {
    return capabilityError("unknown", `Codex App Server ${operation} is unavailable: ${error.message}`);
  }
  if (error instanceof CodexAppServerProtocolError) {
    return capabilityError("unknown", `Codex App Server ${operation} is unavailable: ${error.message}`);
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return capabilityError("unknown", `Codex App Server ${operation} is unavailable: ${error.message}`);
  }
  if (error instanceof Error) {
    return capabilityError("unknown", `Codex App Server ${operation} is unavailable: ${error.message}`);
  }
  return capabilityError("unknown", `Codex App Server ${operation} is unavailable: ${String(error)}`);
}

function requireProfile(
  profile: CodexAppServerProfileTransport,
  binding: CodexProviderBindingRef | null | undefined,
): void {
  if (!bindingIsUsable(binding)) {
    throw capabilityError("unknown", "Codex native App Server I/O requires an explicit host and profile binding.");
  }
  if (!profileBindingMatches(binding, profile)) {
    throw capabilityError(
      "unsupported",
      `Codex native App Server transport is bound to ${profile.binding.hostId}/${profile.binding.profileId}, not ${binding.hostId}/${binding.profileId}.`,
    );
  }
  if (!validProfile(profile)) {
    throw capabilityError("unknown", "Codex native App Server transport is not fully profile-bound.");
  }
}

function requireSupportedMethod(
  profile: CodexAppServerProfileTransport,
  method: "thread/resume" | "thread/read" | "thread/fork",
): void {
  const evidence = codexProfileMethodEvidence(profile, method);
  if (evidence.status !== "supported") {
    throw capabilityError(evidence.status, evidence.reason);
  }
}

function signalProcessGroup(child: ChildProcess, force: boolean): void {
  const signal = force ? "SIGKILL" : "SIGTERM";
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process group may already have exited.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process may already have exited.
  }
}

function processTreeAlive(child: ChildProcess): boolean {
  if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
  if (!child.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!processTreeAlive(child)) return;
  signalProcessGroup(child, false);
  const deadline = Date.now() + APP_SERVER_PROCESS_HARD_DEADLINE_MS;
  while (processTreeAlive(child) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (processTreeAlive(child)) signalProcessGroup(child, true);
}

async function withProfileClient<T>(
  profile: CodexAppServerProfileTransport,
  signal: AbortSignal | undefined,
  operation: (client: CodexAppServerClient) => Promise<T>,
): Promise<T> {
  const child = spawn(
    profile.command,
    [...(profile.args ?? []), "app-server", "--stdio"],
    {
      cwd: profile.cwd,
      env: { ...profile.env },
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const client = new CodexAppServerClient({
    transport: createCodexAppServerStdioTransport(child),
    clientInfo: { name: "rudder-native", title: "Rudder", version: "0.0.0" },
    capabilities: { experimentalApi: true },
    requestTimeoutMs: APP_SERVER_REQUEST_TIMEOUT_MS,
    serverRequestHandlers: createCodexAppServerServerRequestHandlers(false),
    onError: () => undefined,
    abortSignal: signal,
  });
  try {
    await client.initialize();
    return await operation(client);
  } finally {
    client.dispose("Codex native App Server operation complete");
    await terminateProcessTree(child);
  }
}

type ParsedThread = {
  thread: JsonRecord;
  turns: JsonRecord[];
  rootSessionId: string;
};

function parseThreadResponse(
  response: unknown,
  expectedThreadId: string | null,
  requireTurns = true,
): ParsedThread {
  const thread = asRecord(asRecord(response)?.thread);
  const threadId = nonEmptyString(thread?.id);
  if (!thread || !threadId) {
    throw capabilityError("unknown", "Codex App Server returned no thread identity.");
  }
  if (expectedThreadId && threadId !== expectedThreadId) {
    throw capabilityError(
      "unsupported",
      `Codex App Server returned thread ${threadId}, not requested thread ${expectedThreadId}.`,
    );
  }
  const rootSessionId = nonEmptyString(thread.sessionId);
  if (!rootSessionId) {
    throw capabilityError("unknown", "Codex App Server returned a thread without its root session ID.");
  }
  if (!Array.isArray(thread.turns)) {
    if (!requireTurns) return { thread, turns: [], rootSessionId };
    throw capabilityError("unknown", "Codex App Server did not return thread turns for the requested native read.");
  }
  const turns = thread.turns
    .map(asRecord)
    .filter((turn): turn is JsonRecord => Boolean(turn));
  for (const turn of turns) {
    if (!nonEmptyString(turn.id) || typeof turn.status !== "string") {
      throw capabilityError("unknown", "Codex App Server returned a turn without a stable ID or status.");
    }
  }
  return { thread, turns, rootSessionId };
}

async function readThread(
  client: CodexAppServerClient,
  threadId: string,
  requireFullItems: boolean,
): Promise<ParsedThread> {
  const response = await client.request("thread/read", {
    threadId,
    includeTurns: true,
  });
  const parsed = parseThreadResponse(response, threadId);
  if (requireFullItems) {
    for (const turn of parsed.turns) {
      if (!hasFullItemsView(turn.itemsView)) {
        throw capabilityError(
          "unsupported",
          `Codex App Server returned ${String(turn.itemsView ?? "missing")} items for turn ${String(turn.id)}; full native history is unavailable.`,
        );
      }
      if (!Array.isArray(turn.items)) {
        throw capabilityError("unsupported", `Codex App Server returned no items for turn ${String(turn.id)}.`);
      }
    }
  }
  return parsed;
}

function sessionThreadId(session: CodexProviderSessionRef, profile: CodexAppServerProfileTransport): string {
  const sessionId = nonEmptyString(session.sessionId);
  if (!sessionId) throw capabilityError("unknown", "Codex native operation has no provider thread ID.");
  const params = session.sessionParams;
  const identity: Array<[string, string | null | undefined]> = [
    ["transport", "codex_app_server"],
    ["profileHostId", profile.binding.hostId],
    ["profileId", profile.binding.profileId],
    ["profileOrgId", profile.binding.orgId],
    ["profileBindingId", profile.binding.id],
    ["workspaceBindingId", profile.binding.workspaceBindingId],
    ["capabilityRevision", profile.binding.capabilityRevision],
  ];
  for (const [key, expected] of identity) {
    if (!expected) continue;
    if (nonEmptyString(params[key]) !== expected) {
      throw capabilityError("unsupported", `Codex session ${key} attestation does not match the authorized provider profile.`);
    }
  }
  for (const key of ["sessionId", "threadId"]) {
    const persisted = nonEmptyString(params[key]);
    if (persisted && persisted !== sessionId) {
      throw capabilityError("unsupported", `Codex session binding contains conflicting ${key} identity.`);
    }
  }
  return sessionId;
}

function selectorRecord(selector: unknown): JsonRecord | null {
  return asRecord(selector);
}

function selectedTurnId(
  selector: unknown,
  threadId: string,
  requireTurn: boolean,
): string | null {
  const record = selectorRecord(selector);
  if (!record) {
    if (requireTurn) throw capabilityError("unknown", "A Codex Run transcript requires a concrete turn selector.");
    return null;
  }
  if (record.kind !== "codex_turn") {
    throw capabilityError("unsupported", "The Codex native reader received a non-Codex span selector.");
  }
  const selectedThreadId = nonEmptyString(record.threadId);
  if (!selectedThreadId || selectedThreadId !== threadId) {
    throw capabilityError("unsupported", "Codex span selector does not match the bound provider thread.");
  }
  const turnId = nonEmptyString(record.turnId);
  if (requireTurn && !turnId) {
    throw capabilityError("unknown", "A Codex Run transcript selector has no completed turn ID.");
  }
  return turnId;
}

function numericTimestamp(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value > 10_000_000_000 ? value : value * 1_000;
}

function timestampFor(item: JsonRecord, turn: JsonRecord, thread: JsonRecord): string {
  const raw = item.createdAtMs ?? item.createdAt ?? item.timestamp ?? turn.completedAt ?? turn.startedAt ?? thread.updatedAt;
  const numeric = numericTimestamp(raw);
  if (numeric !== null) return new Date(numeric).toISOString();
  if (typeof raw === "string" && Number.isFinite(Date.parse(raw))) return new Date(raw).toISOString();
  return new Date(0).toISOString();
}

function canonicalItemType(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .toLowerCase() || "unknown";
}

function textFromContent(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => {
      const record = asRecord(entry);
      return nonEmptyString(record?.text) ?? nonEmptyString(record?.value) ?? "";
    })
    .filter(Boolean)
    .join("");
}

function textForItem(item: JsonRecord, canonicalType: string): string | null {
  const direct = nonEmptyString(item.text);
  if (direct) return direct;
  if (canonicalType === "user_message") return textFromContent(item.content) || null;
  if (canonicalType === "reasoning") {
    const summary = Array.isArray(item.summary)
      ? item.summary.filter((value): value is string => typeof value === "string")
      : [];
    const content = Array.isArray(item.content)
      ? item.content.filter((value): value is string => typeof value === "string")
      : [];
    return [...summary, ...content].join("\n") || null;
  }
  return null;
}

function stableRevision(thread: JsonRecord, turns: readonly JsonRecord[]): string {
  const value = JSON.stringify({
    id: thread.id,
    sessionId: thread.sessionId,
    updatedAt: thread.updatedAt,
    turns: turns.map((turn) => ({
      id: turn.id,
      status: turn.status,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      items: turn.items,
    })),
  });
  return `codex:${createHash("sha256").update(value).digest("hex")}`;
}

function recordsForTurns(
  threadId: string,
  thread: JsonRecord,
  turns: readonly JsonRecord[],
): NativeTranscriptRecord[] {
  let ordinal = 0;
  const records: NativeTranscriptRecord[] = [];
  for (const turn of turns) {
    const turnId = nonEmptyString(turn.id)!;
    const turnItems = Array.isArray(turn.items) ? turn.items : [];
    for (let index = 0; index < turnItems.length; index += 1) {
      const item = asRecord(turnItems[index]) ?? {};
      const rawItemId = nonEmptyString(item.id) ?? `${turnId}:item:${index}`;
      const canonicalType = canonicalItemType(nonEmptyString(item.type) ?? "unknown");
      const text = textForItem(item, canonicalType);
      const ts = timestampFor(item, turn, thread);
      const normalized = normalizeThreadItem(item);
      const completed = canonicalType === "user_message"
        ? [{ kind: "user" as const, ts, text: text ?? "", messageId: rawItemId }]
        : parseCodexStdoutLine(JSON.stringify({ type: "item.completed", item: normalized }), ts);
      const calls = parseCodexStdoutLine(JSON.stringify({ type: "item.started", item: normalized }), ts)
        .filter((entry) => entry.kind === "tool_call"
          && !completed.some((candidate) => candidate.kind === "tool_call" && candidate.toolUseId === entry.toolUseId));
      const parsed = [...calls, ...completed];
      const entries: TranscriptEntry[] = parsed.length > 0 ? parsed : [{
        kind: "system", ts, text: text ?? `Codex ${canonicalType}: ${JSON.stringify(item)}`,
      }];
      for (const [entryIndex, entry] of entries.entries()) {
        records.push({
          id: entryIndex === 0 ? rawItemId : `${rawItemId}:${entry.kind}:${entryIndex}`,
          sourceEntryId: rawItemId,
          ordinal,
          kind: entry.kind,
          ts,
          entry: { ...entry, sourceEntryId: rawItemId },
          payload: {
            provider: "codex",
            threadId,
            rootSessionId: nonEmptyString(thread.sessionId),
            turnId,
            turnStatus: turn.status,
            item,
          },
          origin: "native",
          visibility: "visible",
          ...(text ? { text } : {}),
        });
        ordinal += 1;
      }
    }
  }
  return records;
}

function rangeRecord(value: unknown): JsonRecord | null {
  return asRecord(value);
}

function refId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  return nonEmptyString(rangeRecord(value)?.itemId);
}

function refOrdinal(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  const ordinal = rangeRecord(value)?.ordinal;
  return typeof ordinal === "number" && Number.isFinite(ordinal) ? Math.floor(ordinal) : null;
}

function matchesRecord(item: NativeTranscriptRecord, value: unknown): boolean {
  const id = refId(value);
  return Boolean(id && (item.id === id || item.sourceEntryId === id));
}

function lastMatchingRecord(items: NativeTranscriptRecord[], value: unknown): number {
  // A native item can project to both a tool call and its result. Native
  // boundaries encompass that entire item; projected IDs remain precise.
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (matchesRecord(items[index]!, value)) return index;
  }
  return -1;
}

function applyNativeRange(
  items: NativeTranscriptRecord[],
  range: JsonRecord | null,
): NativeTranscriptRecord[] {
  if (!range) return items;
  if (typeof range.itemId === "string") return items.filter((item) => matchesRecord(item, range.itemId));
  let selected = [...items];
  const start = range.start;
  if (start !== undefined && start !== null) {
    const index = selected.findIndex((item) => matchesRecord(item, start));
    if (index >= 0) selected = selected.slice(index);
    else {
      const ordinal = refOrdinal(start);
      selected = ordinal !== null
        ? selected.filter((item) => Number(item.ordinal) >= ordinal)
        : typeof start === "number" ? selected.slice(Math.max(0, Math.floor(start))) : [];
    }
  }
  const end = range.end;
  if (end !== undefined && end !== null) {
    const index = lastMatchingRecord(selected, end);
    if (index >= 0) selected = selected.slice(0, index + 1);
    else {
      const ordinal = refOrdinal(end);
      selected = ordinal !== null
        ? selected.filter((item) => Number(item.ordinal) <= ordinal)
        : typeof end === "number" ? selected.filter((item) => Number(item.ordinal) <= Math.floor(end)) : [];
    }
  }
  const fromExclusive = range.fromExclusive ?? range.after;
  if (fromExclusive !== undefined && fromExclusive !== null) {
    const index = lastMatchingRecord(selected, fromExclusive);
    if (index >= 0) selected = selected.slice(index + 1);
    else {
      const ordinal = refOrdinal(fromExclusive);
      selected = ordinal !== null
        ? selected.filter((item) => Number(item.ordinal) > ordinal)
        : typeof fromExclusive === "number"
          ? selected.filter((item) => Number(item.ordinal) > Math.floor(fromExclusive))
          : [];
    }
  }
  const throughInclusive = range.throughInclusive;
  if (throughInclusive !== undefined && throughInclusive !== null) {
    const index = lastMatchingRecord(selected, throughInclusive);
    if (index >= 0) selected = selected.slice(0, index + 1);
    else {
      const ordinal = refOrdinal(throughInclusive);
      selected = ordinal !== null
        ? selected.filter((item) => Number(item.ordinal) <= ordinal)
        : typeof throughInclusive === "number"
          ? selected.filter((item) => Number(item.ordinal) <= Math.floor(throughInclusive))
          : [];
    }
  }
  const before = range.before;
  if (before !== undefined && before !== null) {
    const index = selected.findIndex((item) => matchesRecord(item, before));
    if (index >= 0) selected = selected.slice(0, index);
    else {
      const ordinal = refOrdinal(before);
      selected = ordinal !== null
        ? selected.filter((item) => Number(item.ordinal) < ordinal)
        : typeof before === "number"
          ? selected.filter((item) => Number(item.ordinal) < Math.floor(before))
          : [];
    }
  }
  return selected;
}

function requestedRange(input: CodexNativeTranscriptReadRequest): JsonRecord | null {
  const direct = rangeRecord(input.range);
  if (direct) return direct;
  if (input.from !== undefined || input.through !== undefined) {
    return {
      ...(input.from !== undefined ? { fromExclusive: input.from } : {}),
      ...(input.through !== undefined ? { throughInclusive: input.through } : {}),
    };
  }
  return null;
}

function unavailableResult(error: CodexNativeCapabilityError): CodexNativeTranscriptReadResult {
  return {
    items: [],
    nextCursor: null,
    source: "native",
    revision: `${error.status}:${error.message}`,
    availability: error.message.includes(" unavailable:") ? "offline" : "incompatible",
    completeness: "unknown",
  };
}

export async function readCodexNativeTranscript(
  input: CodexNativeTranscriptReadRequest,
  profile: CodexAppServerProfileTransport,
): Promise<CodexNativeTranscriptReadResult> {
  requireProfile(profile, input.binding);
  requireSupportedMethod(profile, "thread/read");
  const threadId = sessionThreadId(input.session, profile);
  if (input.runtimeType !== "codex_local") {
    throw capabilityError("unsupported", `Codex native transport cannot serve runtime ${input.runtimeType}.`);
  }
  if (input.cursor) {
    throw capabilityError("unknown", "Codex App Server thread/read is a complete snapshot transport; provider cursors are unsupported.");
  }
  const requireTurn = input.readerInput !== null && input.readerInput !== undefined;
  const selector = selectorRecord(input.selector);
  if (requireTurn && selector?.kind === "codex_turn" && selector.threadId === threadId && !nonEmptyString(selector.turnId)) {
    return {
      items: [], nextCursor: null, source: "native", availability: "missing", completeness: "unknown",
      revision: `codex:pending-turn:${threadId}`,
    };
  }
  const selectedId = selectedTurnId(input.selector, threadId, requireTurn);
  try {
    return await withProfileClient(profile, input.signal, async (client) => {
      const parsed = await readThread(client, threadId, true);
      let selectedTurns = parsed.turns;
      if (selectedId) {
        const selected = parsed.turns.find((turn) => turn.id === selectedId);
        if (!selected) {
          throw capabilityError("unknown", `Codex App Server did not return requested turn ${selectedId}.`);
        }
        selectedTurns = [selected];
      }
      const records = recordsForTurns(threadId, parsed.thread, selectedTurns);
      const items = requireTurn ? records : applyNativeRange(records, requestedRange(input));
      const complete = selectedTurns.every((turn) => turn.status !== "inProgress") && selectedTurns.length > 0;
      return {
        items,
        nextCursor: null,
        source: "native" as const,
        revision: stableRevision(parsed.thread, selectedTurns),
        availability: "available" as const,
        completeness: (complete ? "complete" : "partial") as "complete" | "partial",
      };
    });
  } catch (error) {
    const normalized = normalizeTransportError(error, "thread/read");
    if (normalized) return unavailableResult(normalized);
    throw error;
  }
}

function identityMapForFork(
  parentTurns: readonly JsonRecord[],
  childTurns: readonly JsonRecord[],
  boundary: string,
): Record<string, string> {
  const boundaryIndex = parentTurns.findIndex((turn) => turn.id === boundary);
  const sourceTurns = boundaryIndex >= 0 ? parentTurns.slice(0, boundaryIndex + 1) : [];
  const identityMap: Record<string, string> = {};
  for (let index = 0; index < sourceTurns.length && index < childTurns.length; index += 1) {
    const sourceId = nonEmptyString(sourceTurns[index]?.id);
    const childId = nonEmptyString(childTurns[index]?.id);
    if (sourceId && childId) identityMap[sourceId] = childId;
  }
  return identityMap;
}

export async function forkCodexNativeThread(
  input: CodexNativeForkRequest,
  profile: CodexAppServerProfileTransport,
): Promise<CodexNativeForkResult> {
  requireProfile(profile, input.binding);
  requireSupportedMethod(profile, "thread/fork");
  const parentThreadId = sessionThreadId(input.session, profile);
  if (input.runtimeType !== "codex_local") {
    throw capabilityError("unsupported", `Codex native transport cannot serve runtime ${input.runtimeType}.`);
  }
  const boundary = nonEmptyString(input.boundary);
  if (!boundary) throw capabilityError("unsupported", "Codex native fork requires a turn boundary.");
  const selectedId = selectedTurnId(input.selector, parentThreadId, false);
  if (selectedId && selectedId !== boundary) {
    throw capabilityError("unsupported", "Codex fork boundary does not match the selected Codex turn.");
  }
  try {
    return await withProfileClient(profile, input.signal, async (client) => {
      const parent = await readThread(client, parentThreadId, false);
      const target = parent.turns.find((turn) => turn.id === boundary);
      if (!target) throw capabilityError("unknown", `Codex App Server did not return fork boundary turn ${boundary}.`);
      if (target.status !== "completed") {
        throw capabilityError(
          "unsupported",
          `Codex fork boundary ${boundary} is ${String(target.status)}; only a completed turn is safe to fork.`,
        );
      }
      const model = nonEmptyString(parent.thread.model);
      const modelProvider = nonEmptyString(parent.thread.modelProvider);
      if (!model || !modelProvider) {
        throw capabilityError(
          "unknown",
          "Codex App Server parent thread is missing model or model provider fork metadata.",
        );
      }
      const response = await client.request("thread/fork", {
        threadId: parentThreadId,
        lastTurnId: boundary,
        ephemeral: false,
        excludeTurns: false,
        model,
        modelProvider,
        cwd: profile.cwd,
      });
      const child = parseThreadResponse(response, null, false);
      const childId = nonEmptyString(child.thread.id);
      if (!childId || childId === parentThreadId) {
        throw capabilityError("unsupported", "Codex App Server fork did not return a distinct child thread ID.");
      }
      // A fork can start a new native session tree. sessionId identifies that
      // tree, while forkedFromId and the copied turn boundary prove lineage.
      // Requiring the parent's sessionId rejects real App Server forks.
      const forkedFromId = nonEmptyString(child.thread.forkedFromId);
      if (forkedFromId !== parentThreadId) {
        throw capabilityError("unsupported", "Codex App Server fork did not preserve its parent thread identity.");
      }
      if (child.thread.ephemeral === true) {
        throw capabilityError("unsupported", "Codex App Server returned an ephemeral fork for a persistent native branch.");
      }
      const boundaryIndex = parent.turns.findIndex((turn) => turn.id === boundary);
      const expectedTurnCount = boundaryIndex + 1;
      if (boundaryIndex < 0 || child.turns.length !== expectedTurnCount) {
        throw capabilityError(
          "unsupported",
          `Codex App Server fork did not preserve exactly the ${expectedTurnCount} turn${expectedTurnCount === 1 ? "" : "s"} through boundary ${boundary}.`,
        );
      }
      if (child.turns.some((turn) => turn.status === "inProgress")) {
        throw capabilityError("unsupported", "Codex App Server fork returned an in-progress turn in the completed boundary.");
      }
      const identityMap = identityMapForFork(parent.turns, child.turns, boundary);
      if (Object.keys(identityMap).length !== expectedTurnCount) {
        throw capabilityError("unsupported", "Codex App Server fork did not return stable identities for every copied turn.");
      }
      return {
        session: {
          sessionId: childId,
          sessionDisplayId: childId,
          sessionParams: {
            sessionId: childId,
            threadId: childId,
            rootSessionId: child.rootSessionId,
            forkedFromId,
            cwd: profile.cwd,
            transport: "codex_app_server",
            profileHostId: profile.binding.hostId,
            profileId: profile.binding.profileId,
            ...(profile.binding.orgId ? { profileOrgId: profile.binding.orgId } : {}),
            ...(profile.binding.id ? { profileBindingId: profile.binding.id } : {}),
            ...(profile.binding.workspaceBindingId ? { workspaceBindingId: profile.binding.workspaceBindingId } : {}),
            ...(profile.binding.capabilityRevision ? { capabilityRevision: profile.binding.capabilityRevision } : {}),
          },
        },
        boundary,
        sourceBoundary: boundary,
        identityMap,
        continuity: "native",
      };
    });
  } catch (error) {
    const normalized = normalizeTransportError(error, "thread/fork");
    if (normalized) throw normalized;
    throw error;
  }
}

export async function resumeCodexNativeThread(
  input: {
    runtimeType: string;
    session: CodexProviderSessionRef;
    binding?: CodexProviderBindingRef | null;
    signal?: AbortSignal;
  },
  profile: CodexAppServerProfileTransport,
): Promise<CodexProviderSessionRef> {
  requireProfile(profile, input.binding);
  requireSupportedMethod(profile, "thread/resume");
  if (input.runtimeType !== "codex_local") {
    throw capabilityError("unsupported", `Codex native transport cannot serve runtime ${input.runtimeType}.`);
  }
  const threadId = sessionThreadId(input.session, profile);
  try {
    return await withProfileClient(profile, input.signal, async (client) => {
      const response = await client.request("thread/resume", {
        threadId,
        cwd: profile.cwd,
        excludeTurns: true,
      });
      const parsed = parseThreadResponse(response, threadId, false);
      return {
        sessionId: threadId,
        sessionDisplayId: threadId,
        sessionParams: {
          ...input.session.sessionParams,
          sessionId: threadId,
          threadId,
          rootSessionId: parsed.rootSessionId,
          cwd: profile.cwd,
        },
      };
    });
  } catch (error) {
    const normalized = normalizeTransportError(error, "thread/resume");
    if (normalized) throw normalized;
    throw error;
  }
}
