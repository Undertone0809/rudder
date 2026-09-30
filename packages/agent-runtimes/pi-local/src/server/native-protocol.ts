import type {
  AgentRuntimeApprovalRequest,
  AgentRuntimeControlAttemptLease,
  AgentRuntimeControlHandle,
  AgentRuntimeControlInterruptReason,
  AgentRuntimeControlInterruptResult,
  AgentRuntimeControlSteerInput,
  AgentRuntimeControlSteerResult,
  AgentRuntimeExecutionContext,
  AgentRuntimeExecutionResult,
  TranscriptEntry,
} from "@rudderhq/agent-runtime-utils";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parsePiStdoutLine } from "../ui/parse-stdout.js";

export type PiBinding = {
  id?: string | null;
  orgId?: string | null;
  hostId: string;
  profileId: string;
  workspaceBindingId?: string | null;
  capabilityRevision?: string | null;
  providerVersion?: string | null;
};

export const PI_NATIVE_TRANSPORT = "pi-rpc-stdio";

export type PiSession = {
  sessionId: string;
  sessionParams: Record<string, unknown>;
  sessionDisplayId: string;
};

export type PiWorkspaceIdentity = {
  workspaceId?: string | null;
  repoUrl?: string | null;
  repoRef?: string | null;
  workspaceBindingId?: string | null;
};

export type PiTranscriptRequest = {
  runtimeType: string;
  session: PiSession;
  selector?: unknown;
  binding?: PiBinding | null;
  workspace?: PiWorkspaceIdentity | null;
  range?: unknown;
  from?: unknown;
  through?: unknown;
  cursor?: string | null;
  readerInput?: unknown | null;
  signal?: AbortSignal;
};

export type PiTranscriptResult = {
  items: readonly Record<string, unknown>[];
  nextCursor: null;
  revision: string;
  source: "native";
  availability: "available" | "offline" | "missing" | "incompatible";
  completeness: "complete" | "partial" | "unknown";
  visibilityCutoffHandled?: string;
  limitReached?: { reason: "page_bytes" | "item_bytes" | "total_bytes" | "total_items"; maximum: number } | null;
  rangeHandled?: {
    startItemId?: string;
    endItemId?: string;
    exclusiveStartItemId?: string;
    throughInclusiveItemId?: string;
    beforeItemId?: string;
  };
};

export type PiForkRequest = {
  runtimeType: string;
  session: PiSession;
  boundary: string;
  selector?: unknown;
  binding?: PiBinding | null;
  workspace?: PiWorkspaceIdentity | null;
  signal?: AbortSignal;
};

export type PiForkResult = {
  session: PiSession;
  boundary: string;
  sourceBoundary: string;
  identityMap: Record<string, string>;
  continuity: "native";
};

export class PiNativeCapabilityError extends Error {
  override readonly name = "PiNativeCapabilityError";

  constructor(
    readonly status: "unsupported" | "unknown",
    message: string,
  ) {
    super(message);
  }
}

type PiTranscriptIndexLimit = { reason: "total_bytes" | "total_items"; maximum: number };

class PiTranscriptIndexLimitError extends Error {
  constructor(readonly limit: PiTranscriptIndexLimit, readonly prefixRevision: string) {
    super("Pi transcript index exceeded " + limit.reason + ": " + limit.maximum + ".");
  }
}

type JsonRecord = Record<string, unknown>;
type PiRpcResponse = { type: "response"; command: string; success: boolean; data?: unknown; error?: string };
type PiSessionEntry = { id: string; parentId: string | null; type: string; value: JsonRecord };
type PiIndexedTranscriptEntry = {
  id: string;
  parentId: string | null;
  type: string;
  sourceOrdinal: number | null;
  byteStart: number;
  byteLength: number;
  normalizedByteLength: number;
  lineHash: string;
  projectionKinds: string[];
  exceedsItemBudget: boolean;
};
type PiTranscriptIndex = {
  entries: PiIndexedTranscriptEntry[];
  leafId: string | null;
  hasInvalidEntries: boolean;
  sessionHeaderIds: string[];
  sourceVersion: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
};
type PiTranscriptItemRef = { entryIndex: number; projectionIndex: number; ordinal: number; id: string };
type PiRequestApproval = NonNullable<AgentRuntimeExecutionContext["requestApproval"]>;
type PiWaitForApproval = NonNullable<AgentRuntimeExecutionContext["waitForApproval"]>;
type PiApprovalQuestion = NonNullable<AgentRuntimeApprovalRequest["inputRequest"]>;
type PiApprovalDecision = Awaited<ReturnType<PiWaitForApproval>>;
type PiEventSummary = {
  count: number;
  counts: Map<string, number>;
  lastType: string | null;
  finalAssistantText: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    costUsd: number;
  };
};

const RPC_TIMEOUT_MS = 45_000;
const RPC_SETTLED_POLL_MS = 50;
const APPROVAL_TIMEOUT_MS = 30 * 60_000;
const CONTROL_ATTEMPT_POLL_MS = 100;
const MAX_RPC_FRAME_CHARS = 8_000_000;
const MAX_RPC_IMAGE_BYTES = 20_000_000;
const MAX_NATIVE_DIAGNOSTIC_TYPES = 32;
const NATIVE_TRANSCRIPT_PAGE_ITEMS = 100;
const NATIVE_TRANSCRIPT_PAGE_BYTES = 1024 * 1024;
const NATIVE_TRANSCRIPT_MAX_PAGE_BYTES = 8 * 1024 * 1024;
const NATIVE_TRANSCRIPT_ITEM_BYTES = 1024 * 1024;
const NATIVE_TRANSCRIPT_CHUNK_BYTES = 64 * 1024;
const NATIVE_TRANSCRIPT_MAX_RECORD_BYTES = 8 * 1024 * 1024;
const NATIVE_TRANSCRIPT_MAX_ITEMS_PER_RECORD = 10_000;
const NATIVE_TRANSCRIPT_MAX_SCAN_BYTES = 64 * 1024 * 1024;
const NATIVE_TRANSCRIPT_MAX_INDEX_BYTES = 8 * 1024 * 1024;
const NATIVE_TRANSCRIPT_MAX_INDEX_ENTRIES = 20_000;
const NATIVE_TRANSCRIPT_MAX_INDEX_ITEMS = 100_000;
const SAFE_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_OFFLINE",
] as const;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boundedDiagnostic(value: unknown, maxChars = 2_000): string {
  const text = value instanceof Error ? value.message : typeof value === "string" ? value : String(value);
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length > maxChars ? `${compact.slice(0, maxChars)}... [truncated]` : compact;
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function addAssistantUsage(summary: PiEventSummary, message: JsonRecord | null): void {
  if (message?.role !== "assistant") return;
  const usage = asRecord(message.usage);
  if (!usage) return;
  const cost = asRecord(usage.cost);
  summary.usage.inputTokens += finiteNonNegative(usage.input ?? usage.inputTokens);
  summary.usage.outputTokens += finiteNonNegative(usage.output ?? usage.outputTokens);
  summary.usage.cachedInputTokens += finiteNonNegative(usage.cacheRead ?? usage.cachedInputTokens);
  summary.usage.costUsd += finiteNonNegative(cost?.total ?? usage.costUsd);
}

function recordPiEvent(summary: PiEventSummary, event: JsonRecord): void {
  const type = boundedDiagnostic(nonEmpty(event.type) ?? "unknown", 80);
  summary.count += 1;
  summary.counts.set(type, (summary.counts.get(type) ?? 0) + 1);
  summary.lastType = type;
  if (event.type === "message_end") addAssistantUsage(summary, asRecord(event.message));
  if (event.type !== "agent_end") return;
  const messages = Array.isArray(event.messages) ? event.messages.map(asRecord).filter((message): message is JsonRecord => Boolean(message)) : [];
  const assistant = messages.findLast((message) => message.role === "assistant");
  if (!assistant) {
    summary.finalAssistantText = "";
  } else if (Array.isArray(assistant.content)) {
    summary.finalAssistantText = assistant.content
      .map(asRecord)
      .filter((part): part is JsonRecord => Boolean(part))
      .map((part) => nonEmpty(part.text) ?? "")
      .join("");
  } else {
    summary.finalAssistantText = nonEmpty(assistant.content) ?? "";
  }
}

function eventMetadata(summary: PiEventSummary): JsonRecord {
  return {
    eventCount: summary.count,
    eventTypes: [...summary.counts.entries()]
      .slice(0, MAX_NATIVE_DIAGNOSTIC_TYPES)
      .map(([type, count]) => `${type}:${count}`),
    ...(summary.lastType
      ? { lastEventType: summary.lastType }
      : {}),
  };
}

function boundaryId(value: unknown): string | null {
  return nonEmpty(value) ?? nonEmpty(asRecord(value)?.itemId);
}

function safeEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) result[key] = value;
  }
  return result;
}

function persistedEnv(value: unknown): Record<string, string> | null {
  const record = asRecord(value);
  if (!record) return null;
  if (!Object.keys(record).every((key) => SAFE_ENV_KEYS.includes(key as typeof SAFE_ENV_KEYS[number]))) return null;
  const values = Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0,
    ),
  );
  return safeEnv(values);
}

function persistedArgs(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return null;
  return [...value];
}

function bindingIsUsable(binding: PiBinding | null | undefined): binding is PiBinding {
  return Boolean(binding?.hostId?.trim() && binding.profileId?.trim());
}

function requireBoundSession(
  session: PiSession,
  binding: PiBinding | null | undefined,
  workspace?: PiWorkspaceIdentity | null,
): {
  params: JsonRecord;
  sessionFile: string;
  sessionDir: string;
  cwd: string;
  command: string;
  rpcEnv: Record<string, string>;
  rpcArgs: string[];
} {
  if (!bindingIsUsable(binding)) {
    throw new PiNativeCapabilityError("unknown", "Pi native I/O requires an explicit host and provider profile binding.");
  }
  const params = session.sessionParams;
  const sessionId = nonEmpty(session.sessionId);
  const storedSessionId = nonEmpty(params.sessionId);
  if (!sessionId || storedSessionId !== sessionId) {
    throw new PiNativeCapabilityError("unsupported", "Pi persisted session identity does not match the requested session.");
  }
  const storedHost = nonEmpty(params.hostId);
  const storedProfile = nonEmpty(params.profileId);
  if (storedHost !== binding.hostId.trim() || storedProfile !== binding.profileId.trim()) {
    throw new PiNativeCapabilityError(
      "unsupported",
      `Pi session is bound to ${storedHost ?? "unknown"}/${storedProfile ?? "unknown"}, not ${binding.hostId}/${binding.profileId}.`,
    );
  }
  if (binding.capabilityRevision && nonEmpty(params.capabilityRevision) !== binding.capabilityRevision) {
    throw new PiNativeCapabilityError("unsupported", "Pi session capability revision does not match the requested profile binding.");
  }
  if (binding.providerVersion && nonEmpty(params.providerVersion) !== binding.providerVersion) {
    throw new PiNativeCapabilityError("unsupported", "Pi session provider version does not match the requested profile binding.");
  }
  const storedTransport = nonEmpty(params.transport);
  if (!storedTransport) {
    throw new PiNativeCapabilityError("unknown", "Pi persisted session transport is missing.");
  }
  if (storedTransport !== PI_NATIVE_TRANSPORT) {
    throw new PiNativeCapabilityError(
      "unsupported",
      `Pi session transport ${storedTransport ?? "missing"} does not match ${PI_NATIVE_TRANSPORT}.`,
    );
  }
  const identityFields: Array<[string, unknown, unknown]> = [
    ["profile binding", params.profileBindingId, binding.id],
    ["organization", params.profileOrgId, binding.orgId],
    ["workspace binding", params.workspaceBindingId, binding.workspaceBindingId],
  ];
  for (const [label, storedValue, expectedValue] of identityFields) {
    const stored = nonEmpty(storedValue);
    const expected = nonEmpty(expectedValue);
    if (expected && stored !== expected) {
      throw new PiNativeCapabilityError("unsupported", `Pi persisted ${label} identity does not match the requested binding.`);
    }
    if (!expected && stored) {
      throw new PiNativeCapabilityError("unsupported", `Pi current binding is missing persisted ${label} identity.`);
    }
  }
  const sessionFile = nonEmpty(params.sessionFile);
  const sessionDir = nonEmpty(params.sessionDir);
  const cwd = nonEmpty(params.cwd);
  const command = nonEmpty(params.command);
  const rpcEnv = persistedEnv(params.rpcEnv);
  const rpcArgs = persistedArgs(params.rpcArgs);
  if (!sessionFile || !sessionDir || !cwd || !command || !rpcEnv || !rpcArgs) {
    throw new PiNativeCapabilityError("unknown", "Pi native session parameters do not contain session-file, session-dir, and command boundaries.");
  }
  if (!path.isAbsolute(sessionFile) || !path.isAbsolute(sessionDir) || !path.isAbsolute(cwd)) {
    throw new PiNativeCapabilityError("unknown", "Pi native session parameters contain a non-absolute path.");
  }
  if (path.resolve(sessionFile) !== path.resolve(sessionId)) {
    throw new PiNativeCapabilityError("unsupported", "Pi persisted session file does not match the requested session.");
  }
  if (path.resolve(sessionDir) !== path.dirname(path.resolve(sessionFile))) {
    throw new PiNativeCapabilityError("unsupported", "Pi persisted session directory does not contain the persisted session file.");
  }
  const workspaceFields = ["workspaceId", "repoUrl", "repoRef", "workspaceBindingId"] as const;
  if (workspace) {
    for (const field of workspaceFields) {
      const expected = nonEmpty(workspace[field]);
      const stored = nonEmpty(params[field]);
      if (expected && stored !== expected) {
        throw new PiNativeCapabilityError("unsupported", `Pi persisted ${field} does not match the current workspace.`);
      }
      if (!expected && stored) {
        throw new PiNativeCapabilityError("unsupported", `Pi current workspace is missing persisted ${field} identity.`);
      }
    }
  }
  return {
    params: {
      sessionId,
      sessionFile,
      sessionDir,
      cwd,
      command,
      rpcArgs,
      rpcEnv,
      transport: PI_NATIVE_TRANSPORT,
      ...(nonEmpty(params.providerSessionId) ? { providerSessionId: nonEmpty(params.providerSessionId) } : {}),
      ...(nonEmpty(params.leafId) ? { leafId: nonEmpty(params.leafId) } : {}),
      ...(nonEmpty(params.previousLeafId) ? { previousLeafId: nonEmpty(params.previousLeafId) } : {}),
      hostId: binding.hostId.trim(),
      profileId: binding.profileId.trim(),
      ...(binding.id ? { profileBindingId: binding.id } : {}),
      ...(binding.orgId ? { profileOrgId: binding.orgId } : {}),
      ...(binding.workspaceBindingId ? { workspaceBindingId: binding.workspaceBindingId } : {}),
      ...(nonEmpty(params.capabilityRevision) ? { capabilityRevision: nonEmpty(params.capabilityRevision) } : {}),
      ...Object.fromEntries(workspaceFields.flatMap((field) => {
        const value = nonEmpty(params[field]);
        return value ? [[field, value]] : [];
      })),
    },
    sessionFile,
    sessionDir,
    cwd,
    command,
    rpcEnv,
    rpcArgs,
  };
}

function spawnRpc(input: {
  command: string;
  cwd: string;
  env: Record<string, string>;
  sessionDir: string;
  sessionFile: string;
  args?: readonly string[];
}): ChildProcessWithoutNullStreams {
  return spawn(input.command, [
    ...(input.args ?? []),
    "--mode", "rpc",
    "--session-dir", input.sessionDir,
    "--session", input.sessionFile,
  ], {
    cwd: input.cwd,
    env: { ...process.env, ...input.env },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function nativePiImages(media: AgentRuntimeExecutionContext["media"]): Promise<JsonRecord[]> {
  if (!media?.length) return [];
  const images: JsonRecord[] = [];
  let totalBytes = 0;
  for (const attachment of media) {
    const mimeType = attachment.contentType.trim().toLowerCase();
    if (!/^image\/[a-z0-9.+-]+$/u.test(mimeType)) {
      throw new PiNativeCapabilityError("unsupported", `Pi RPC native prompt input does not support ${mimeType || "this attachment type"}.`);
    }
    const data = await fs.readFile(attachment.localPath);
    if (data.length !== attachment.byteSize) {
      throw new PiNativeCapabilityError("unknown", `Pi image attachment ${attachment.attachmentId} changed size before submission.`);
    }
    totalBytes += data.length;
    if (totalBytes > MAX_RPC_IMAGE_BYTES) {
      throw new PiNativeCapabilityError("unsupported", "Pi RPC image attachments exceed the native input size limit.");
    }
    images.push({ type: "image", data: data.toString("base64"), mimeType });
  }
  return images;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function requireKnownProviderSession(
  sessionFile: string,
  expectedProviderSessionId: string | null,
): Promise<void> {
  const tree = await readSessionEntries(sessionFile);
  const marker = tree.entries.find((entry) => entry.type === "session");
  if (!marker) {
    throw new PiNativeCapabilityError(
      "unknown",
      "Pi native resume refused because the persisted session file has no known provider session marker.",
    );
  }
  if (expectedProviderSessionId && marker.id !== expectedProviderSessionId) {
    throw new PiNativeCapabilityError(
      "unsupported",
      "Pi native resume refused because the persisted provider session marker does not match the bound session.",
    );
  }
}

function rpcError(response: PiRpcResponse): PiNativeCapabilityError {
  return new PiNativeCapabilityError(
    response.error && /invalid|unsupported|unknown/i.test(response.error) ? "unsupported" : "unknown",
    `Pi RPC ${response.command} failed${response.error ? `: ${response.error}` : "."}`,
  );
}

function boundedUiText(value: unknown, limit: number): string {
  return (typeof value === "string" ? value : "").trim().slice(0, limit);
}

type PiExtensionDialog = {
  method: "select" | "confirm" | "input" | "editor";
  question: PiApprovalQuestion;
  optionValues: Map<string, string>;
};

function extensionDialog(event: JsonRecord): PiExtensionDialog | null {
  const method = nonEmpty(event.method);
  if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") return null;
  const title = boundedUiText(event.title, 32) || "Pi extension";
  const details = [
    boundedUiText(event.message, 1_000),
    boundedUiText(event.placeholder, 240) ? `Placeholder: ${boundedUiText(event.placeholder, 240)}` : "",
    boundedUiText(event.prefill, 1_000) ? `Current text:\n${boundedUiText(event.prefill, 1_000)}` : "",
  ].filter(Boolean).join("\n");
  const prompt = boundedUiText(details ? `${title}: ${details}` : title, 240) || "Pi extension requests input";
  const optionValues = new Map<string, string>();
  let labels: string[];
  if (method === "select") {
    if (!Array.isArray(event.options) || event.options.length < 2 || event.options.length > 4) return null;
    labels = event.options.map((value) => typeof value === "string" ? value.trim() : "");
    if (labels.some((label) => !label || label.length > 80)) return null;
  } else if (method === "confirm") {
    labels = ["Yes", "No"];
  } else {
    labels = ["Submit", "Cancel"];
  }
  const options = labels.map((label, index) => {
    const id = `choice_${index + 1}`;
    optionValues.set(id, label);
    return { id, label };
  });
  return {
    method,
    optionValues,
    question: {
      questions: [{
        id: "pi_extension",
        header: title,
        question: prompt,
        options,
        selectionMode: "single",
        allowFreeform: method === "input" || method === "editor",
      }],
    },
  };
}

function extensionUiLogPayload(event: JsonRecord): JsonRecord {
  const method = nonEmpty(event.method) ?? "unknown";
  const payload: JsonRecord = { method };
  for (const key of ["title", "message", "placeholder", "prefill", "notifyType", "statusKey", "statusText", "widgetPlacement", "text"] as const) {
    const value = event[key];
    if (typeof value === "string") payload[key] = boundedUiText(value, key === "prefill" ? 2_000 : 500);
  }
  if (Array.isArray(event.options)) {
    payload.options = event.options.filter((option): option is string => typeof option === "string")
      .slice(0, 8)
      .map((option) => boundedUiText(option, 120));
  }
  if (Array.isArray(event.widgetLines)) {
    payload.widgetLines = event.widgetLines
      .filter((line): line is string => typeof line === "string")
      .slice(0, 20)
      .map((line) => boundedUiText(line, 500));
  }
  return payload;
}

async function racePiControl<T>(input: {
  operation: Promise<T>;
  signal?: AbortSignal;
  isCurrent: () => boolean;
}): Promise<T> {
  if (input.signal?.aborted || !input.isCurrent()) {
    throw new PiNativeCapabilityError("unknown", "Pi extension interaction is no longer current.");
  }
  let pollTimer: NodeJS.Timeout | null = null;
  let abortListener: (() => void) | null = null;
  const stale = new Promise<never>((_, reject) => {
    const check = () => {
      if (input.signal?.aborted || !input.isCurrent()) {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        reject(new PiNativeCapabilityError("unknown", "Pi extension interaction is no longer current."));
      }
    };
    if (input.signal) {
      abortListener = check;
      input.signal.addEventListener("abort", abortListener, { once: true });
    }
    check();
    if (!input.signal?.aborted && input.isCurrent()) pollTimer = setInterval(check, CONTROL_ATTEMPT_POLL_MS);
  });
  try {
    return await Promise.race([input.operation, stale]);
  } finally {
    if (pollTimer) clearInterval(pollTimer);
    if (abortListener) input.signal?.removeEventListener("abort", abortListener);
  }
}

async function withRpc<T>(input: {
  command: string;
  cwd: string;
  env: Record<string, string>;
  sessionDir: string;
  sessionFile: string;
  args?: readonly string[];
  signal?: AbortSignal;
  onEvent?: (event: JsonRecord) => Promise<void>;
  operation: (rpc: PiRpcClient) => Promise<T>;
}): Promise<T> {
  const child = spawnRpc(input);
  const rpc = new PiRpcClient(child, input.signal, input.onEvent);
  try {
    return await input.operation(rpc);
  } finally {
    await rpc.close();
  }
}

class PiRpcClient {
  private readonly pending = new Map<string, Array<(response: PiRpcResponse) => void>>();
  private readonly eventTasks = new Set<Promise<void>>();
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private closed = false;
  private eventFailure: unknown = null;
  private activeRetries = 0;
  private agentEndCount = 0;
  private agentEndWillRetry: boolean | null = null;
  private readonly closePromise: Promise<void>;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly signal?: AbortSignal,
    private readonly onEvent?: (event: JsonRecord) => Promise<void>,
  ) {
    this.closePromise = new Promise((resolve) => {
      const close = () => {
        if (this.closed) return;
        const remainder = this.decoder.end();
        if (remainder) this.consumeText(remainder);
        if (this.buffer.length > 0) {
          this.eventFailure ??= new PiNativeCapabilityError("unknown", "Pi RPC ended with an incomplete JSONL frame.");
        }
        this.closed = true;
        for (const waiters of this.pending.values()) {
          for (const waiter of waiters) waiter({ type: "response", command: "process", success: false, error: "Pi RPC process exited" });
        }
        this.pending.clear();
        resolve();
      };
      child.once("exit", close);
      child.once("error", close);
    });
    child.stdout.on("data", (chunk: Buffer) => this.consumeText(this.decoder.write(chunk)));
  }

  private consumeText(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.consumeLine(line);
      newline = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > MAX_RPC_FRAME_CHARS) {
      this.eventFailure ??= new PiNativeCapabilityError("unknown", "Pi RPC JSONL frame exceeded the native stream limit.");
      this.child.kill("SIGTERM");
    }
  }

  private consumeLine(line: string): void {
    if (!line.trim()) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      this.eventFailure ??= new PiNativeCapabilityError("unknown", "Pi RPC returned an invalid JSONL frame.");
      this.child.kill("SIGTERM");
      return;
    }
    const record = asRecord(event);
    if (!record) {
      this.eventFailure ??= new PiNativeCapabilityError("unknown", "Pi RPC returned a non-object JSONL frame.");
      this.child.kill("SIGTERM");
      return;
    }
    if (record.type === "agent_end") {
      this.agentEndCount += 1;
      this.agentEndWillRetry = typeof record.willRetry === "boolean" ? record.willRetry : null;
    }
    if (record.type === "auto_retry_start") this.activeRetries += 1;
    if (record.type === "auto_retry_end") this.activeRetries = Math.max(0, this.activeRetries - 1);
    if (this.onEvent) {
      let task: Promise<void>;
      task = Promise.resolve().then(() => this.onEvent?.(record)).then(() => undefined).catch((error: unknown) => {
        this.eventFailure ??= error;
      }).finally(() => this.eventTasks.delete(task));
      this.eventTasks.add(task);
    }
    if (record.type !== "response") return;
    const response = record as unknown as PiRpcResponse;
    const waiters = this.pending.get(response.command);
    if (!waiters) return;
    this.pending.delete(response.command);
    for (const waiter of waiters) waiter(response);
  }

  private waitFor(command: string, timeoutMs = RPC_TIMEOUT_MS): Promise<PiRpcResponse> {
    if (this.closed) return Promise.reject(new PiNativeCapabilityError("unknown", "Pi RPC process exited before its response."));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new PiNativeCapabilityError("unknown", `Pi RPC ${command} timed out.`)), timeoutMs);
      const abort = () => {
        clearTimeout(timeout);
        reject(this.signal?.reason ?? new Error("Pi RPC request cancelled"));
      };
      this.signal?.addEventListener("abort", abort, { once: true });
      const waiter = (response: PiRpcResponse) => {
        clearTimeout(timeout);
        this.signal?.removeEventListener("abort", abort);
        resolve(response);
      };
      const waiters = this.pending.get(command) ?? [];
      waiters.push(waiter);
      this.pending.set(command, waiters);
    });
  }

  async command(command: string, extra: JsonRecord = {}, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
    if (!this.child.stdin.writable) throw new PiNativeCapabilityError("unknown", "Pi RPC stdin is not writable.");
    const response = this.waitFor(command, timeoutMs);
    this.child.stdin.write(`${JSON.stringify({ type: command, ...extra })}\n`);
    const result = await response;
    if (!result.success) throw rpcError(result);
    return result.data ?? null;
  }

  send(value: JsonRecord): void {
    if (!this.child.stdin.writable) throw new PiNativeCapabilityError("unknown", "Pi RPC stdin is not writable.");
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  get isRetrying(): boolean {
    return this.activeRetries > 0;
  }

  get willRetryAfterAgentEnd(): boolean {
    return this.agentEndWillRetry === true;
  }

  async drainEvents(): Promise<void> {
    while (this.eventTasks.size > 0) await Promise.all([...this.eventTasks]);
    if (this.eventFailure) {
      if (this.eventFailure instanceof Error) throw this.eventFailure;
      throw new PiNativeCapabilityError("unknown", boundedDiagnostic(this.eventFailure));
    }
  }

  async prompt(message: string, timeoutMs = RPC_TIMEOUT_MS): Promise<void> {
    const startAgentEndCount = this.agentEndCount;
    const agentEnd = new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        if (this.agentEndCount > startAgentEndCount) return resolve();
        if (this.closed) return reject(new PiNativeCapabilityError("unknown", "Pi RPC ended before agent_end."));
        if (this.eventFailure) return reject(this.eventFailure);
        if (Date.now() - started > timeoutMs) return reject(new PiNativeCapabilityError("unknown", "Pi RPC prompt timed out."));
        setTimeout(poll, 10);
      };
      poll();
    });
    await this.command("prompt", { message }, timeoutMs);
    await agentEnd;
    await this.drainEvents();
  }

  async close(): Promise<void> {
    if (!this.closed) {
      try { this.child.stdin.end(); } catch { /* already closed */ }
      const deadline = Date.now() + 1_000;
      while (!this.closed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      if (!this.closed) this.child.kill("SIGTERM");
    }
    await this.closePromise;
  }
}

async function readSessionEntries(sessionFile: string): Promise<{
  entries: PiSessionEntry[];
  leafId: string | null;
  hasInvalidEntries: boolean;
  sessionHeaderIds: string[];
}> {
  let content: string;
  try {
    content = await fs.readFile(sessionFile, "utf8");
  } catch {
    throw new PiNativeCapabilityError("unknown", "Pi provider session history could not be read.");
  }
  const entries: PiSessionEntry[] = [];
  let hasInvalidEntries = false;
  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch {
      hasInvalidEntries = true;
      continue;
    }
    const record = asRecord(value);
    const id = nonEmpty(record?.id);
    if (!record || !id) {
      hasInvalidEntries = true;
      continue;
    }
    entries.push({ id, parentId: nonEmpty(record.parentId), type: nonEmpty(record.type) ?? "unknown", value: record });
  }
  const sessionHeaderIds = entries.filter((entry) => entry.type === "session").map((entry) => entry.id);
  const historyEntries = entries.filter((entry) => entry.type !== "session");
  const ids = new Set(historyEntries.map((entry) => entry.id));
  const childIds = new Set(historyEntries.map((entry) => entry.parentId).filter((id): id is string => Boolean(id && ids.has(id))));
  const leafId = [...historyEntries].reverse().find((entry) => !childIds.has(entry.id))?.id ?? historyEntries.at(-1)?.id ?? null;
  return { entries, leafId, hasInvalidEntries, sessionHeaderIds };
}

function isAppendOnlySessionFile(before: string, after: string): boolean {
  if (!after.startsWith(before)) return false;
  const appended = after.slice(before.length);
  if (!appended) return true;
  if (!before.endsWith("\n")) return false;

  const ids = new Set<string>();
  for (const line of before.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const id = nonEmpty(asRecord(JSON.parse(line))?.id);
      if (id) ids.add(id);
    } catch {
      return false;
    }
  }
  for (const line of appended.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let record: JsonRecord | null;
    try {
      record = asRecord(JSON.parse(line));
    } catch {
      return false;
    }
    const id = nonEmpty(record?.id);
    if (!record || !id || record.type === "session" || ids.has(id)) return false;
    ids.add(id);
  }
  return true;
}

function messageKind(entry: PiSessionEntry | undefined): string {
  const message = asRecord(entry?.value.message);
  const role = nonEmpty(message?.role);
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  if (role === "toolResult" || role === "tool_result") return "tool_result";
  const type = entry?.type.toLowerCase() ?? "unknown";
  if (type.includes("user")) return "user";
  if (type.includes("assistant")) return "assistant";
  if (type.includes("tool")) return "tool_result";
  if (type.includes("thinking")) return "thinking";
  return "system";
}

function messageRole(entry: PiSessionEntry | undefined): string | null {
  return nonEmpty(asRecord(entry?.value.message)?.role);
}

function textFromEntry(entry: PiSessionEntry | undefined): string {
  const message = asRecord(entry?.value.message);
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(asRecord)
      .filter((part): part is JsonRecord => Boolean(part))
      .map((part) => nonEmpty(part.text) ?? "")
      .filter(Boolean)
      .join("\n");
  }
  return nonEmpty(entry?.value.text) ?? "";
}

function transcriptEntriesFor(entry: PiSessionEntry, ts: string): TranscriptEntry[] {
  const message = asRecord(entry.value.message);
  const role = messageRole(entry);
  if (role === "toolResult" || role === "tool_result") {
    return parsePiStdoutLine(JSON.stringify({
      type: "tool_execution_end", toolCallId: message?.toolCallId,
      toolName: message?.toolName, result: message?.content ?? "", isError: message?.isError === true,
    }), ts);
  }
  if (role === "assistant") {
    const content = message?.content;
    if (typeof content === "string") return [{ kind: "assistant", ts, text: content }];
    const entries: TranscriptEntry[] = [];
    for (const value of Array.isArray(content) ? content : []) {
      const part = asRecord(value);
      if (part?.type === "text" && typeof part.text === "string") {
        entries.push({ kind: "assistant", ts, text: part.text });
      } else if (part?.type === "thinking" && typeof part.thinking === "string") {
        entries.push({ kind: "thinking", ts, text: part.thinking });
      } else if (part?.type === "toolCall") {
        entries.push(...parsePiStdoutLine(JSON.stringify({
          type: "tool_execution_start", toolName: part.name, args: part.arguments,
        }), ts).map((projected) => projected.kind === "tool_call"
          ? { ...projected, toolUseId: nonEmpty(part.id) ?? undefined }
          : projected));
      } else {
        entries.push({ kind: "system", ts, text: JSON.stringify(value) });
      }
    }
    if (entries.length > 0) return entries;
  }
  const kind = messageKind(entry);
  return [{ kind: kind === "user" ? "user" : "system", ts, text: textFromEntry(entry) || JSON.stringify(entry.value) }];
}

function branchForLeaf<T extends { id: string; parentId: string | null }>(entries: readonly T[], leafId: string): T[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: T[] = [];
  const seen = new Set<string>();
  let current = byId.get(leafId);
  while (current) {
    if (seen.has(current.id)) throw new PiNativeCapabilityError("unknown", "Pi provider session contains a cyclic parent boundary.");
    seen.add(current.id);
    branch.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  if (branch.length === 0 || branch.at(-1)?.id !== leafId) {
    throw new PiNativeCapabilityError("unsupported", "Pi provider session does not contain the requested exact leaf boundary.");
  }
  return branch;
}

function planAssistantFork(
  entries: readonly PiSessionEntry[],
  currentLeafId: string | null,
  boundary: string,
): {
  branch: PiSessionEntry[];
  boundaryIndex: number;
  command: "fork" | "clone";
  extra: JsonRecord;
} {
  if (!currentLeafId) {
    throw new PiNativeCapabilityError("unknown", "Pi native fork has no persisted provider head for the requested assistant boundary.");
  }
  const branch = branchForLeaf(entries, currentLeafId);
  const boundaryIndex = branch.findIndex((entry) => entry.id === boundary);
  if (boundaryIndex < 0) {
    throw new PiNativeCapabilityError("unsupported", "Pi native fork boundary is not on the persisted provider head branch.");
  }
  const selected = branch[boundaryIndex];
  if (selected.type !== "message" || messageRole(selected) !== "assistant") {
    throw new PiNativeCapabilityError("unsupported", "Pi native fork boundary must be a persisted assistant message.");
  }
  if (selected.id === currentLeafId) {
    return { branch, boundaryIndex, command: "clone", extra: {} };
  }
  const next = branch[boundaryIndex + 1];
  if (!next || next.parentId !== boundary || next.type !== "message" || messageRole(next) !== "user") {
    throw new PiNativeCapabilityError(
      "unsupported",
      "Pi native fork cannot map this assistant boundary to the provider's exact user-fork boundary.",
    );
  }
  return { branch, boundaryIndex, command: "fork", extra: { entryId: next.id } };
}

function revisionFor(sessionFile: string, leafId: string | null, entries: readonly PiSessionEntry[]): string {
  return `pi:${createHash("sha256").update(JSON.stringify({
    sessionFile,
    leafId,
    entries: entries.map((entry) => ({ id: entry.id, parentId: entry.parentId, type: entry.type, value: entry.value })),
  })).digest("hex")}`;
}

function samePiFileVersion(
  left: PiTranscriptIndex["sourceVersion"],
  right: Awaited<ReturnType<typeof fs.stat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function transcriptItemKinds(entry: PiSessionEntry): string[] {
  const content = asRecord(entry.value.message)?.content;
  if (Array.isArray(content) && content.length > NATIVE_TRANSCRIPT_MAX_ITEMS_PER_RECORD) {
    throw new PiNativeCapabilityError("unknown", "Pi provider session record exceeds the bounded transcript projection limit.");
  }
  const timestamp = nonEmpty(entry.value.timestamp) ?? new Date(0).toISOString();
  const kinds = transcriptEntriesFor(entry, timestamp).map((projected) => projected.kind);
  if (kinds.length > NATIVE_TRANSCRIPT_MAX_ITEMS_PER_RECORD) {
    throw new PiNativeCapabilityError("unknown", "Pi provider session record exceeds the bounded transcript projection limit.");
  }
  return kinds;
}

function scanPiRecordMetadata(content: string): {
  id: string;
  parentId: string | null;
  type: string;
  sourceOrdinal: number | null;
} | null {
  let index = 0;
  const metadata: { id?: string; parentId?: string | null; type?: string; sourceOrdinal?: number | null } = {};
  const skipWhitespace = () => {
    while (/\s/u.test(content[index] ?? "")) index += 1;
  };
  const stringEnd = (start: number): number => {
    let escaped = false;
    for (let cursor = start + 1; cursor < content.length; cursor += 1) {
      const char = content[cursor]!;
      if (char === '"' && !escaped) return cursor + 1;
      if (char === "\\" && !escaped) escaped = true;
      else escaped = false;
    }
    return -1;
  };
  const skipValue = (): boolean => {
    skipWhitespace();
    const first = content[index];
    if (first === '"') {
      const end = stringEnd(index);
      if (end < 0) return false;
      index = end;
      return true;
    }
    if (first === "{" || first === "[") {
      const closers = [first === "{" ? "}" : "]"];
      index += 1;
      let inString = false;
      let escaped = false;
      while (index < content.length && closers.length > 0) {
        const char = content[index]!;
        if (inString) {
          if (char === '"' && !escaped) inString = false;
          if (char === "\\" && !escaped) escaped = true;
          else escaped = false;
        } else if (char === '"') {
          inString = true;
        } else if (char === "{" || char === "[") {
          closers.push(char === "{" ? "}" : "]");
        } else if (char === "}" || char === "]") {
          if (closers.pop() !== char) return false;
        }
        index += 1;
      }
      return closers.length === 0;
    }
    const start = index;
    while (index < content.length && !/[\s,}\]]/u.test(content[index]!)) index += 1;
    return index > start;
  };

  skipWhitespace();
  if (content[index] !== "{") return null;
  index += 1;
  while (index < content.length) {
    skipWhitespace();
    if (content[index] === "}") {
      index += 1;
      skipWhitespace();
      const id = nonEmpty(metadata.id);
      return index === content.length && id
        ? {
            id,
            parentId: metadata.parentId ?? null,
            type: nonEmpty(metadata.type) ?? "unknown",
            sourceOrdinal: metadata.sourceOrdinal ?? null,
          }
        : null;
    }
    if (content[index] !== '"') return null;
    const keyStart = index;
    const keyEnd = stringEnd(keyStart);
    if (keyEnd < 0 || keyEnd - keyStart > 256) return null;
    let key: string;
    try {
      key = JSON.parse(content.slice(keyStart, keyEnd)) as string;
    } catch {
      return null;
    }
    index = keyEnd;
    skipWhitespace();
    if (content[index] !== ":") return null;
    index += 1;
    skipWhitespace();
    if (["id", "parentId", "type"].includes(key) && content[index] === '"') {
      const valueStart = index;
      const valueEnd = stringEnd(valueStart);
      if (valueEnd < 0 || valueEnd - valueStart > 4096) return null;
      let value: string;
      try {
        value = JSON.parse(content.slice(valueStart, valueEnd)) as string;
      } catch {
        return null;
      }
      if (key === "id") metadata.id = value;
      else if (key === "parentId") metadata.parentId = nonEmpty(value);
      else metadata.type = value;
      index = valueEnd;
    } else if (key === "parentId" && content.startsWith("null", index)) {
      metadata.parentId = null;
      index += 4;
    } else if (key === "ordinal" && /^-?\d/u.test(content[index] ?? "")) {
      const start = index;
      while (/[-\d.eE+]/u.test(content[index] ?? "")) index += 1;
      const ordinal = Number(content.slice(start, index));
      metadata.sourceOrdinal = Number.isSafeInteger(ordinal) && ordinal >= 0 ? ordinal : null;
    } else if (!skipValue()) {
      return null;
    }
    skipWhitespace();
    if (content[index] === ",") {
      index += 1;
      continue;
    }
    if (content[index] !== "}") return null;
  }
  return null;
}

function piIndexMetadataBytes(entry: PiIndexedTranscriptEntry): number {
  return 128
    + Buffer.byteLength(entry.id, "utf8")
    + Buffer.byteLength(entry.parentId ?? "", "utf8")
    + Buffer.byteLength(entry.type, "utf8")
    + Buffer.byteLength(entry.lineHash, "utf8")
    + entry.projectionKinds.reduce((total, kind) => total + Buffer.byteLength(kind, "utf8") + 4, 0);
}

function revisionForTranscriptIndex(
  sessionFile: string,
  leafId: string | null,
  entries: readonly PiIndexedTranscriptEntry[],
): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify([sessionFile, leafId]));
  for (const entry of entries) {
    hash.update(JSON.stringify([entry.id, entry.parentId, entry.type, entry.lineHash]));
  }
  return "pi:" + hash.digest("hex");
}

async function readPiTranscriptIndex(
  sessionFile: string,
  maxItemBytes: number,
  signal?: AbortSignal,
): Promise<PiTranscriptIndex> {
  let before: Awaited<ReturnType<typeof fs.stat>>;
  try {
    before = await fs.stat(sessionFile);
  } catch {
    throw new PiNativeCapabilityError("unknown", "Pi provider session history could not be read.");
  }
  const sourceVersion = {
    dev: before.dev,
    ino: before.ino,
    size: before.size,
    mtimeMs: before.mtimeMs,
    ctimeMs: before.ctimeMs,
  };
  const entries: PiIndexedTranscriptEntry[] = [];
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let byteStart = 0;
  let hasInvalidEntries = false;
  let scannedBytes = 0;
  let indexBytes = 0;
  let indexedItems = 0;
  const limitIndex = (limit: PiTranscriptIndexLimit): never => {
    throw new PiTranscriptIndexLimitError(limit, revisionForTranscriptIndex(sessionFile, null, entries));
  };
  const appendIndexEntry = (entry: PiIndexedTranscriptEntry): void => {
    if (entries.length >= NATIVE_TRANSCRIPT_MAX_INDEX_ENTRIES) {
      limitIndex({ reason: "total_items", maximum: NATIVE_TRANSCRIPT_MAX_INDEX_ENTRIES });
    }
    const nextItems = indexedItems + Math.max(1, entry.projectionKinds.length);
    if (nextItems > NATIVE_TRANSCRIPT_MAX_INDEX_ITEMS) {
      limitIndex({ reason: "total_items", maximum: NATIVE_TRANSCRIPT_MAX_INDEX_ITEMS });
    }
    const nextBytes = indexBytes + piIndexMetadataBytes(entry);
    if (nextBytes > NATIVE_TRANSCRIPT_MAX_INDEX_BYTES) {
      limitIndex({ reason: "total_bytes", maximum: NATIVE_TRANSCRIPT_MAX_INDEX_BYTES });
    }
    entries.push(entry);
    indexedItems = nextItems;
    indexBytes = nextBytes;
  };
  const indexLine = (content: string, start: number) => {
    const byteLength = Buffer.byteLength(content, "utf8");
    if (byteLength > NATIVE_TRANSCRIPT_MAX_RECORD_BYTES) {
      throw new PiNativeCapabilityError("unknown", "Pi provider session has a row larger than the bounded transcript record limit.");
    }
    if (!content.trim()) return;
    if (entries.length >= NATIVE_TRANSCRIPT_MAX_INDEX_ENTRIES) {
      limitIndex({ reason: "total_items", maximum: NATIVE_TRANSCRIPT_MAX_INDEX_ENTRIES });
    }
    if (byteLength > maxItemBytes) {
      const metadata = scanPiRecordMetadata(content);
      if (!metadata) {
        hasInvalidEntries = true;
        return;
      }
      const exceedsItemBudget = metadata.type !== "session";
      appendIndexEntry({
        ...metadata,
        byteStart: start,
        byteLength,
        normalizedByteLength: maxItemBytes + 1,
        lineHash: createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex"),
        projectionKinds: exceedsItemBudget ? ["system"] : [],
        exceedsItemBudget,
      });
      return;
    }
    let parsed: JsonRecord | null;
    try {
      parsed = asRecord(JSON.parse(content));
    } catch {
      hasInvalidEntries = true;
      return;
    }
    const id = nonEmpty(parsed?.id);
    if (!parsed || !id) {
      hasInvalidEntries = true;
      return;
    }
    const entry: PiSessionEntry = {
      id,
      parentId: nonEmpty(parsed.parentId),
      type: nonEmpty(parsed.type) ?? "unknown",
      value: parsed,
    };
    appendIndexEntry({
      id: entry.id,
      parentId: entry.parentId,
      type: entry.type,
      sourceOrdinal: Number.isSafeInteger(parsed.ordinal) && typeof parsed.ordinal === "number" && parsed.ordinal >= 0
        ? parsed.ordinal
        : null,
      byteStart: start,
      byteLength,
      normalizedByteLength: Buffer.byteLength(JSON.stringify(parsed), "utf8"),
      lineHash: createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex"),
      projectionKinds: transcriptItemKinds(entry),
      exceedsItemBudget: false,
    });
  };

  try {
    for await (const chunk of createReadStream(sessionFile, { highWaterMark: NATIVE_TRANSCRIPT_CHUNK_BYTES, signal })) {
      if (signal?.aborted) throw new Error("Pi transcript read cancelled");
      scannedBytes += chunk.byteLength;
      if (scannedBytes > NATIVE_TRANSCRIPT_MAX_SCAN_BYTES) {
        limitIndex({ reason: "total_bytes", maximum: NATIVE_TRANSCRIPT_MAX_SCAN_BYTES });
      }
      pending += decoder.write(chunk);
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        const physicalBytes = Buffer.byteLength(line, "utf8") + 1;
        indexLine(line, byteStart);
        byteStart += physicalBytes;
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (Buffer.byteLength(pending, "utf8") > NATIVE_TRANSCRIPT_MAX_RECORD_BYTES) {
        throw new PiNativeCapabilityError("unknown", "Pi provider session has a row larger than the bounded transcript record limit.");
      }
    }
    pending += decoder.end();
    if (pending.length > 0) indexLine(pending, byteStart);
  } catch (error) {
    if (error instanceof PiTranscriptIndexLimitError) throw error;
    if (error instanceof PiNativeCapabilityError) throw error;
    if (signal?.aborted) throw error;
    throw new PiNativeCapabilityError("unknown", "Pi provider session history could not be streamed.");
  }

  const after = await fs.stat(sessionFile).catch(() => null);
  if (!after || !samePiFileVersion(sourceVersion, after)) {
    throw new PiNativeCapabilityError("unknown", "Pi provider session changed while its transcript index was built.");
  }
  const sessionHeaderIds = entries.filter((entry) => entry.type === "session").map((entry) => entry.id);
  const historyEntries = entries.filter((entry) => entry.type !== "session");
  const ids = new Set(historyEntries.map((entry) => entry.id));
  const childIds = new Set(historyEntries.map((entry) => entry.parentId)
    .filter((id): id is string => Boolean(id && ids.has(id))));
  const leafId = [...historyEntries].reverse().find((entry) => !childIds.has(entry.id))?.id
    ?? historyEntries.at(-1)?.id
    ?? null;
  return { entries, leafId, hasInvalidEntries, sessionHeaderIds, sourceVersion };
}

async function readPiIndexedEntry(
  sessionFile: string,
  indexed: PiIndexedTranscriptEntry,
  signal?: AbortSignal,
): Promise<PiSessionEntry> {
  if (indexed.normalizedByteLength > NATIVE_TRANSCRIPT_MAX_RECORD_BYTES) {
    throw new PiNativeCapabilityError("unknown", "Pi provider session row exceeds the bounded transcript record limit.");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  const range = { start: indexed.byteStart, end: indexed.byteStart + indexed.byteLength - 1 };
  for await (const chunk of createReadStream(sessionFile, {
    ...range,
    highWaterMark: NATIVE_TRANSCRIPT_CHUNK_BYTES,
    signal,
  })) {
    if (signal?.aborted) throw new Error("Pi transcript read cancelled");
    bytes += chunk.length;
    if (bytes > indexed.byteLength) {
      throw new PiNativeCapabilityError("unknown", "Pi provider session changed while reading a bounded transcript page.");
    }
    chunks.push(chunk);
  }
  if (bytes !== indexed.byteLength) {
    throw new PiNativeCapabilityError("unknown", "Pi provider session changed while reading a bounded transcript page.");
  }
  const raw = Buffer.concat(chunks, bytes);
  if (createHash("sha256").update(raw).digest("hex") !== indexed.lineHash) {
    throw new PiNativeCapabilityError("unknown", "Pi provider session changed while reading a bounded transcript page.");
  }
  const value = asRecord(JSON.parse(raw.toString("utf8")));
  if (!value || nonEmpty(value.id) !== indexed.id || nonEmpty(value.parentId) !== indexed.parentId
    || (nonEmpty(value.type) ?? "unknown") !== indexed.type) {
    throw new PiNativeCapabilityError("unknown", "Pi provider session changed while reading a bounded transcript page.");
  }
  return { id: indexed.id, parentId: indexed.parentId, type: indexed.type, value };
}

async function verifyPiTranscriptFileVersion(index: PiTranscriptIndex, sessionFile: string): Promise<void> {
  const current = await fs.stat(sessionFile).catch(() => null);
  if (!current || !samePiFileVersion(index.sourceVersion, current)) {
    throw new PiNativeCapabilityError("unknown", "Pi provider session changed during bounded transcript reading.");
  }
}

function piTranscriptLimits(input: PiTranscriptRequest): { limit: number; maxBytes: number; maxItemBytes: number } {
  const readerInput = asRecord(input.readerInput) ?? {};
  const bounded = (value: unknown, fallback: number, maximum: number) => (
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback
  );
  const maxBytes = bounded(readerInput.maxBytes, NATIVE_TRANSCRIPT_PAGE_BYTES, NATIVE_TRANSCRIPT_MAX_PAGE_BYTES);
  return {
    limit: NATIVE_TRANSCRIPT_PAGE_ITEMS,
    maxBytes,
    maxItemBytes: Math.min(maxBytes, bounded(readerInput.maxItemBytes, NATIVE_TRANSCRIPT_ITEM_BYTES, NATIVE_TRANSCRIPT_MAX_PAGE_BYTES)),
  };
}

function selectorRecord(value: unknown): JsonRecord | null {
  return asRecord(value);
}

function requestedRange(input: PiTranscriptRequest): JsonRecord | null {
  const range = asRecord(input.range);
  if (range) return range;
  if (input.from !== undefined || input.through !== undefined) {
    return {
      ...(input.from !== undefined ? { fromExclusive: input.from } : {}),
      ...(input.through !== undefined ? { throughInclusive: input.through } : {}),
    };
  }
  return null;
}

function applyIndexedRange(
  items: PiTranscriptItemRef[],
  branch: readonly PiIndexedTranscriptEntry[],
  range: JsonRecord | null,
): PiTranscriptItemRef[] {
  if (!range) return items;
  const idFor = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : nonEmpty(asRecord(value)?.itemId);
  const ordinalFor = (value: unknown) => {
    const ordinal = asRecord(value)?.ordinal;
    return typeof ordinal === "number" && Number.isFinite(ordinal) ? ordinal : null;
  };
  const matchesId = (item: PiTranscriptItemRef, id: string) => item.id === id || branch[item.entryIndex]?.id === id;
  const firstIndexFor = (records: PiTranscriptItemRef[], id: string) => records.findIndex((item) => matchesId(item, id));
  const lastIndexFor = (records: PiTranscriptItemRef[], id: string) => {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (matchesId(records[index]!, id)) return index;
    }
    return -1;
  };
  let result = [...items];
  const start = range.start;
  if (start !== undefined && start !== null) {
    const id = idFor(start);
    const index = id ? firstIndexFor(result, id) : -1;
    const ordinal = ordinalFor(start);
    result = index >= 0
      ? result.slice(index)
      : typeof start === "number"
        ? result.slice(Math.floor(start))
        : ordinal !== null
          ? result.filter((item) => item.ordinal >= ordinal)
          : [];
  }
  const end = range.end;
  if (end !== undefined && end !== null) {
    const id = idFor(end);
    const index = id ? lastIndexFor(result, id) : -1;
    const ordinal = ordinalFor(end);
    result = index >= 0
      ? result.slice(0, index + 1)
      : typeof end === "number"
        ? result.slice(0, Math.floor(end) + 1)
        : ordinal !== null
          ? result.filter((item) => item.ordinal <= ordinal)
          : [];
  }
  const from = range.fromExclusive ?? range.after;
  if (from !== undefined && from !== null) {
    const id = idFor(from);
    const index = id ? lastIndexFor(result, id) : -1;
    const ordinal = ordinalFor(from);
    result = index >= 0
      ? result.slice(index + 1)
      : typeof from === "number"
        ? result.slice(Math.floor(from) + 1)
        : ordinal !== null
          ? result.filter((item) => item.ordinal > ordinal)
          : [];
  }
  const through = range.throughInclusive;
  if (through !== undefined && through !== null) {
    const id = idFor(through);
    const index = id ? lastIndexFor(result, id) : -1;
    const ordinal = ordinalFor(through);
    result = index >= 0
      ? result.slice(0, index + 1)
      : typeof through === "number"
        ? result.slice(0, Math.floor(through) + 1)
        : ordinal !== null
          ? result.filter((item) => item.ordinal <= ordinal)
          : [];
  }
  const before = range.before;
  if (before !== undefined && before !== null) {
    const id = idFor(before);
    const index = id ? firstIndexFor(result, id) : -1;
    const ordinal = ordinalFor(before);
    result = index >= 0
      ? result.slice(0, index)
      : typeof before === "number"
        ? result.slice(0, Math.floor(before))
        : ordinal !== null
          ? result.filter((item) => item.ordinal < ordinal)
          : [];
  }
  if (range.itemId !== undefined && range.itemId !== null) {
    const id = idFor(range.itemId);
    result = id ? result.filter((item) => item.id === id || branch[item.entryIndex]?.id === id) : [];
  }
  return result;
}

function piRangeHandling(range: JsonRecord | null): PiTranscriptResult["rangeHandled"] {
  if (!range) return undefined;
  const idFor = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : nonEmpty(asRecord(value)?.itemId);
  const handled: NonNullable<PiTranscriptResult["rangeHandled"]> = {};
  const startItemId = idFor(range.start);
  const endItemId = idFor(range.end);
  const exclusiveStartItemId = idFor(range.fromExclusive ?? range.after);
  const throughInclusiveItemId = idFor(range.throughInclusive);
  const beforeItemId = idFor(range.before);
  if (startItemId) handled.startItemId = startItemId;
  if (endItemId) handled.endItemId = endItemId;
  if (exclusiveStartItemId) handled.exclusiveStartItemId = exclusiveStartItemId;
  if (throughInclusiveItemId) handled.throughInclusiveItemId = throughInclusiveItemId;
  if (beforeItemId) handled.beforeItemId = beforeItemId;
  return Object.keys(handled).length > 0 ? handled : undefined;
}

function assertIndexedTranscriptBoundary(
  items: readonly PiTranscriptItemRef[],
  branch: readonly PiIndexedTranscriptEntry[],
  boundary: unknown,
  label: string,
  allowPosition = false,
): void {
  if (boundary === undefined || boundary === null || (allowPosition && typeof boundary === "number")) return;
  const id = boundaryId(boundary);
  if (!id) {
    throw new PiNativeCapabilityError("unknown", `Pi transcript ${label} is not a supported exact boundary.`);
  }
  if (!items.some((item) => item.id === id || branch[item.entryIndex]?.id === id)) {
    throw new PiNativeCapabilityError("unknown", `Pi transcript ${label} is not present on the selected provider branch.`);
  }
}

function indexedTranscriptItems(branch: readonly PiIndexedTranscriptEntry[]): PiTranscriptItemRef[] {
  const items: PiTranscriptItemRef[] = [];
  branch.forEach((entry, entryIndex) => {
    entry.projectionKinds.forEach((kind, projectionIndex) => {
      items.push({
        entryIndex,
        projectionIndex,
        ordinal: entry.sourceOrdinal ?? entryIndex,
        id: projectionIndex === 0 ? entry.id : `${entry.id}:${kind}:${projectionIndex}`,
      });
    });
  });
  return items;
}

function applyRange(items: JsonRecord[], range: JsonRecord | null): JsonRecord[] {
  if (!range) return items;
  const idFor = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : nonEmpty(asRecord(value)?.itemId);
  const lastIndexFor = (records: JsonRecord[], id: string) => {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (records[index]?.id === id || records[index]?.sourceEntryId === id) return index;
    }
    return -1;
  };
  let result = [...items];
  const start = range.start;
  if (start !== undefined && start !== null) {
    const id = idFor(start);
    const index = id ? lastIndexFor(result, id) : -1;
    result = index >= 0 ? result.slice(index) : typeof start === "number" ? result.slice(Math.floor(start)) : [];
  }
  const from = range.fromExclusive ?? range.after;
  if (from !== undefined && from !== null) {
    const id = idFor(from);
    const index = id ? lastIndexFor(result, id) : -1;
    result = index >= 0 ? result.slice(index + 1) : typeof from === "number" ? result.slice(Math.floor(from) + 1) : [];
  }
  const through = range.throughInclusive ?? range.end;
  if (through !== undefined && through !== null) {
    const id = idFor(through);
    const index = id ? lastIndexFor(result, id) : -1;
    result = index >= 0 ? result.slice(0, index + 1) : typeof through === "number" ? result.slice(0, Math.floor(through) + 1) : [];
  }
  if (range.itemId !== undefined && range.itemId !== null) {
    const id = idFor(range.itemId);
    result = id ? result.filter((item) => item.id === id || item.sourceEntryId === id) : [];
  }
  return result;
}

function assertTranscriptBoundary(
  items: readonly JsonRecord[],
  boundary: unknown,
  label: string,
  allowPosition = false,
): void {
  if (boundary === undefined || boundary === null || (allowPosition && typeof boundary === "number")) return;
  const id = boundaryId(boundary);
  if (!id) {
    throw new PiNativeCapabilityError("unknown", `Pi transcript ${label} is not a supported exact boundary.`);
  }
  if (!items.some((item) => item.id === id || item.sourceEntryId === id)) {
    throw new PiNativeCapabilityError("unknown", `Pi transcript ${label} is not present on the selected provider branch.`);
  }
}

function unavailable(error: PiNativeCapabilityError): PiTranscriptResult {
  return {
    items: [],
    nextCursor: null,
    revision: `${error.status}:${error.message}`,
    source: "native",
    availability: "incompatible",
    completeness: "unknown",
  };
}

export async function readPiNativeTranscript(input: PiTranscriptRequest): Promise<PiTranscriptResult> {
  const bound = requireBoundSession(input.session, input.binding, input.workspace);
  if (input.runtimeType !== "pi_local") throw new PiNativeCapabilityError("unsupported", `Pi transport cannot serve ${input.runtimeType}.`);
  if (input.cursor) throw new PiNativeCapabilityError("unknown", "Pi native session history is a complete snapshot transport; provider cursors are unsupported.");
  try {
    const selector = selectorRecord(input.selector);
    if (selector && selector.kind !== "pi_branch_range") throw new PiNativeCapabilityError("unsupported", "The Pi native reader received a non-Pi span selector.");
    const range = requestedRange(input);
    const state = parseState(await withRpc({
      command: bound.command,
      cwd: bound.cwd,
      env: bound.rpcEnv,
      sessionDir: bound.sessionDir,
      sessionFile: bound.sessionFile,
      args: bound.rpcArgs,
      signal: input.signal,
      operation: async (rpc) => rpc.command("get_state"),
    }));
    const stateSessionFile = nonEmpty(state.sessionFile);
    if (stateSessionFile && path.resolve(stateSessionFile) !== path.resolve(bound.sessionFile)) {
      throw new PiNativeCapabilityError("unsupported", "Pi RPC resumed a different provider session file.");
    }
    const limits = piTranscriptLimits(input);
    const tree = await readPiTranscriptIndex(bound.sessionFile, limits.maxItemBytes, input.signal);
    const rangeLeafId = boundaryId(range?.throughInclusive)
      ?? boundaryId(range?.end);
    const leafId = boundaryId(selector?.leafId)
      ?? boundaryId(selector?.throughInclusive)
      ?? boundaryId(bound.params.leafId)
      ?? rangeLeafId;
    const rangeHasBoundary = ["start", "end", "fromExclusive", "after", "throughInclusive", "before", "itemId"]
      .some((key) => range?.[key] !== undefined && range[key] !== null);
    const hasSessionAnchor = Boolean(
      boundaryId(bound.params.leafId)
      || boundaryId(bound.params.previousLeafId)
      || boundaryId(range?.fromExclusive)
      || boundaryId(range?.after)
      || rangeLeafId
      || boundaryId(selector?.fromExclusive)
      || boundaryId(selector?.throughInclusive)
      || boundaryId(selector?.leafId),
    );
    const expectedSessionIds = [nonEmpty(state.sessionId), nonEmpty(bound.params.providerSessionId)]
      .filter((value): value is string => Boolean(value));
    if (
      !leafId
      && input.selector == null
      && !rangeHasBoundary
      && !hasSessionAnchor
      && !tree.hasInvalidEntries
      && tree.sessionHeaderIds.length === 1
      && expectedSessionIds.length > 0
      && expectedSessionIds.every((id) => id === tree.sessionHeaderIds[0])
      && tree.entries.every((entry) => entry.type === "session")
    ) {
      const revision = revisionForTranscriptIndex(bound.sessionFile, null, tree.entries);
      await verifyPiTranscriptFileVersion(tree, bound.sessionFile);
      return {
        items: [],
        nextCursor: null,
        revision,
        source: "native",
        availability: "available",
        completeness: "complete",
      };
    }
    if (!leafId) throw new PiNativeCapabilityError("unknown", "Pi transcript selector has no provider leaf boundary.");
    const branch = branchForLeaf(tree.entries, leafId);
    if (!branch.some((entry) => entry.id === leafId) || branch.at(-1)?.id !== leafId) {
      throw new PiNativeCapabilityError("unknown", "Pi transcript selected leaf is not present on the resolved provider branch.");
    }
    const previousLeaf = selector && Object.prototype.hasOwnProperty.call(selector, "fromExclusive")
      ? boundaryId(selector.fromExclusive)
      : boundaryId(bound.params.previousLeafId);
    const records = indexedTranscriptItems(branch);
    for (const [label, boundary] of [
      ["selector exclusive start", selector?.fromExclusive],
      ["selector inclusive end", selector?.throughInclusive],
      ["selector leaf", selector?.leafId],
      ["selected branch leaf", leafId],
      ["session exclusive start", previousLeaf],
    ] as const) {
      assertIndexedTranscriptBoundary(records, branch, boundary, label);
    }
    const scopedRecords = applyIndexedRange(records, branch, {
      fromExclusive: previousLeaf,
      throughInclusive: selector?.throughInclusive ?? leafId,
    });
    const visibilityCutoff = nonEmpty(asRecord(input.readerInput)?.visibilityCutoffRef);
    let visibleRecords = scopedRecords;
    if (visibilityCutoff) {
      const isItem = scopedRecords.some((item) => item.id === visibilityCutoff || branch[item.entryIndex]?.id === visibilityCutoff);
      if (isItem) {
        visibleRecords = applyIndexedRange(scopedRecords, branch, { throughInclusive: visibilityCutoff });
      } else if (/^\d+$/u.test(visibilityCutoff)) {
        visibleRecords = scopedRecords.filter((item) => item.ordinal <= Number(visibilityCutoff));
      } else {
        throw new PiNativeCapabilityError("unknown", "Pi transcript visibility boundary is not present on the selected provider interval.");
      }
    }
    let ranged = visibleRecords;
    for (const [key, boundary] of Object.entries({
      start: range?.start,
      end: range?.end,
      fromExclusive: range?.fromExclusive ?? range?.after,
      throughInclusive: range?.throughInclusive,
      before: range?.before,
      itemId: range?.itemId,
    })) {
      if (boundary === undefined || boundary === null) continue;
      if (key === "fromExclusive" && previousLeaf !== null && boundaryId(boundary) === previousLeaf) continue;
      assertIndexedTranscriptBoundary(scopedRecords, branch, boundary, "range " + key, key !== "itemId");
      const matching = new Set(applyIndexedRange(scopedRecords, branch, { [key]: boundary }));
      ranged = ranged.filter((item) => matching.has(item));
    }
    const hasNumericRange = ["start", "end", "fromExclusive", "throughInclusive", "after", "before"]
      .some((key) => typeof range?.[key] === "number");
    if (hasNumericRange && branch.some((entry) => entry.exceedsItemBudget)) {
      throw new PiNativeCapabilityError("unknown", "Pi transcript numeric positions are unavailable while a selected provider record exceeds the item budget.");
    }
    const revision = revisionForTranscriptIndex(bound.sessionFile, leafId, branch);
    await verifyPiTranscriptFileVersion(tree, bound.sessionFile);
    const targetEnd = Math.min(ranged.length, limits.limit);
    const page: JsonRecord[] = [];
    let pageBytes = 2;
    let limitReached: PiTranscriptResult["limitReached"] = null;
    let cachedEntryIndex = -1;
    let cachedSource: PiSessionEntry | null = null;
    let cachedProjection: TranscriptEntry[] = [];
    let cachedText = "";
    let cachedTimestamp = "";
    for (const ref of ranged.slice(0, targetEnd)) {
      const indexed = branch[ref.entryIndex]!;
      if (cachedEntryIndex !== ref.entryIndex) {
        if (indexed.exceedsItemBudget || indexed.normalizedByteLength > limits.maxItemBytes) {
          limitReached = { reason: "item_bytes", maximum: limits.maxItemBytes };
          break;
        }
        cachedSource = await readPiIndexedEntry(bound.sessionFile, indexed, input.signal);
        cachedTimestamp = nonEmpty(cachedSource.value.timestamp) ?? new Date(0).toISOString();
        cachedProjection = transcriptEntriesFor(cachedSource, cachedTimestamp);
        if (cachedProjection.length !== indexed.projectionKinds.length
          || cachedProjection.some((item, index) => item.kind !== indexed.projectionKinds[index])) {
          throw new PiNativeCapabilityError("unknown", "Pi provider session projection changed during transcript reading.");
        }
        cachedText = textFromEntry(cachedSource);
        cachedEntryIndex = ref.entryIndex;
      }
      const source = cachedSource!;
      const projected = cachedProjection[ref.projectionIndex]!;
      const item: JsonRecord = {
        id: ref.id,
        sourceEntryId: source.id,
        ordinal: ref.ordinal,
        kind: projected.kind,
        ts: cachedTimestamp,
        entry: { ...projected, sourceEntryId: source.id },
        payload: { provider: "pi", entryId: source.id, text: cachedText, entry: source.value },
        origin: "native",
        visibility: "visible",
        ...(cachedText ? { text: cachedText } : {}),
      };
      const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
      if (itemBytes > limits.maxItemBytes) {
        limitReached = { reason: "item_bytes", maximum: limits.maxItemBytes };
        break;
      }
      const nextBytes = pageBytes + (page.length > 0 ? 1 : 0) + itemBytes;
      if (nextBytes > limits.maxBytes) {
        limitReached = { reason: "page_bytes", maximum: limits.maxBytes };
        break;
      }
      page.push(item);
      pageBytes = nextBytes;
    }
    if (!limitReached && ranged.length > targetEnd) {
      limitReached = { reason: "total_items", maximum: limits.limit };
    }
    await verifyPiTranscriptFileVersion(tree, bound.sessionFile);
    const rangeHandled = piRangeHandling(range);
    return {
      items: page,
      nextCursor: null,
      revision,
      source: "native",
      availability: "available",
      completeness: tree.hasInvalidEntries || branch.some((entry) => entry.exceedsItemBudget) || limitReached
        ? "partial"
        : "complete",
      limitReached,
      ...(visibilityCutoff ? { visibilityCutoffHandled: visibilityCutoff } : {}),
      ...(rangeHandled ? { rangeHandled } : {}),
    };
  } catch (error) {
    if (error instanceof PiTranscriptIndexLimitError) {
      return {
        items: [],
        nextCursor: null,
        revision: `pi:index-limited:${error.prefixRevision}:${error.limit.reason}:${error.limit.maximum}`,
        source: "native",
        availability: "available",
        completeness: "partial",
        limitReached: error.limit,
      };
    }
    if (error instanceof PiNativeCapabilityError) return unavailable(error);
    throw error;
  }
}

export async function forkPiNativeSession(input: PiForkRequest): Promise<PiForkResult> {
  const bound = requireBoundSession(input.session, input.binding, input.workspace);
  if (input.runtimeType !== "pi_local") throw new PiNativeCapabilityError("unsupported", `Pi transport cannot serve ${input.runtimeType}.`);
  const boundary = nonEmpty(input.boundary);
  if (!boundary) throw new PiNativeCapabilityError("unsupported", "Pi native fork requires an entry boundary.");
  const selector = selectorRecord(input.selector);
  if (selector?.kind !== undefined && selector.kind !== "pi_branch_range") throw new PiNativeCapabilityError("unsupported", "Pi fork received a non-Pi span selector.");
  for (const selectedValue of [selector?.throughInclusive, selector?.leafId]) {
    const selectedBoundary = boundaryId(selectedValue);
    if (selectedBoundary && selectedBoundary !== boundary) {
      throw new PiNativeCapabilityError("unsupported", "Pi fork boundary does not match the selected provider leaf.");
    }
  }
  const sourceSnapshot = await fs.readFile(bound.sessionFile, "utf8").catch(() => null);
  if (sourceSnapshot === null) {
    throw new PiNativeCapabilityError("unknown", "Pi native fork source session file is unavailable.");
  }
  const sourceTree = await readSessionEntries(bound.sessionFile);
  const plan = planAssistantFork(sourceTree.entries, sourceTree.leafId, boundary);
  const stateValue = await withRpc({
    command: bound.command,
    cwd: bound.cwd,
    env: bound.rpcEnv,
    sessionDir: bound.sessionDir,
    sessionFile: bound.sessionFile,
    args: bound.rpcArgs,
    signal: input.signal,
    operation: async (rpc) => {
      const beforeState = parseState(await rpc.command("get_state"));
      const beforeSessionFile = nonEmpty(beforeState.sessionFile);
      if (!beforeSessionFile || path.resolve(beforeSessionFile) !== path.resolve(bound.sessionFile)) {
        throw new PiNativeCapabilityError("unsupported", "Pi RPC fork started from a different provider session file.");
      }
      const expectedProviderSessionId = nonEmpty(bound.params.providerSessionId);
      if (expectedProviderSessionId && beforeState.sessionId !== expectedProviderSessionId) {
        throw new PiNativeCapabilityError("unsupported", "Pi RPC fork provider session identity does not match the bound session.");
      }
      const forkResult = asRecord(await rpc.command(plan.command, plan.extra));
      if (forkResult?.cancelled === true) {
        throw new PiNativeCapabilityError("unsupported", "Pi native fork was cancelled by a provider extension.");
      }
      if (forkResult?.cancelled !== false) {
        throw new PiNativeCapabilityError("unknown", "Pi native fork did not report an explicit completion status.");
      }
      return parseState(await rpc.command("get_state"));
    },
  });
  const state = stateValue;
  const childFile = nonEmpty(state?.sessionFile);
  const childProviderId = nonEmpty(state?.sessionId);
  if (!childFile || childFile === bound.sessionFile) throw new PiNativeCapabilityError("unsupported", "Pi RPC fork did not return a distinct session file.");
  if (!path.isAbsolute(childFile)) throw new PiNativeCapabilityError("unsupported", "Pi RPC fork returned a non-absolute child session file.");
  const sourceAfter = await fs.readFile(bound.sessionFile, "utf8").catch(() => null);
  if (sourceAfter === null || !isAppendOnlySessionFile(sourceSnapshot, sourceAfter)) {
    throw new PiNativeCapabilityError("unsupported", "Pi native fork rewrote or truncated the parent session file.");
  }
  const childTree = await readSessionEntries(childFile);
  const childMarker = childTree.entries.find((entry) => entry.type === "session");
  if (!childMarker || childMarker.id !== childProviderId) {
    throw new PiNativeCapabilityError("unsupported", "Pi RPC fork child session identity is not persisted in the returned session file.");
  }
  const expectedChildIds = plan.branch
    .slice(0, plan.boundaryIndex + 1)
    .filter((entry) => entry.type !== "label")
    .map((entry) => entry.id);
  const actualChildIds = childTree.entries
    .filter((entry) => entry.type !== "session" && entry.type !== "label")
    .map((entry) => entry.id);
  if (!sameJson(actualChildIds, expectedChildIds)) {
    throw new PiNativeCapabilityError(
      "unsupported",
      `Pi native fork did not preserve exactly the provider path through assistant boundary ${boundary}.`,
    );
  }
  const childParams: JsonRecord = {
    ...Object.fromEntries(["workspaceId", "repoUrl", "repoRef"].flatMap((field) => {
      const value = nonEmpty(bound.params[field]);
      return value ? [[field, value]] : [];
    })),
    sessionId: childFile,
    sessionFile: childFile,
    sessionDir: path.dirname(childFile),
    cwd: bound.cwd,
    command: bound.command,
    rpcArgs: [...bound.rpcArgs],
    rpcEnv: bound.rpcEnv,
    providerSessionId: childProviderId,
    leafId: childTree.leafId,
    previousLeafId: null,
    hostId: input.binding?.hostId,
    profileId: input.binding?.profileId,
    transport: PI_NATIVE_TRANSPORT,
    ...(input.binding?.id ? { profileBindingId: input.binding.id } : {}),
    ...(input.binding?.orgId ? { profileOrgId: input.binding.orgId } : {}),
    ...(input.binding?.workspaceBindingId ? { workspaceBindingId: input.binding.workspaceBindingId } : {}),
    ...(input.binding?.capabilityRevision ? { capabilityRevision: input.binding.capabilityRevision } : {}),
    ...(input.binding?.providerVersion ? { providerVersion: input.binding.providerVersion } : {}),
  };
  return {
    session: { sessionId: childFile, sessionParams: childParams, sessionDisplayId: childProviderId ?? childFile },
    boundary,
    sourceBoundary: boundary,
    identityMap: { [boundary]: boundary },
    continuity: "native",
  };
}

function extractLeafId(sessionFile: string): Promise<string | null> {
  return readSessionEntries(sessionFile).then((result) => result.leafId);
}

function parseState(value: unknown): JsonRecord {
  const state = asRecord(value);
  if (!state || !nonEmpty(state.sessionFile) || !nonEmpty(state.sessionId)) {
    throw new PiNativeCapabilityError("unknown", "Pi RPC get_state returned no session identity.");
  }
  return state;
}

async function waitForPiSettled(rpc: PiRpcClient, signal?: AbortSignal, timeoutMs = RPC_TIMEOUT_MS): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason ?? new Error("Pi RPC session was cancelled.");
    const state = parseState(await rpc.command("get_state", {}, Math.max(1, deadline - Date.now())));
    const isStreaming = state.isStreaming;
    const isCompacting = state.isCompacting;
    const pendingMessageCount = state.pendingMessageCount;
    if (typeof isStreaming !== "boolean" || typeof isCompacting !== "boolean"
      || typeof pendingMessageCount !== "number" || !Number.isSafeInteger(pendingMessageCount) || pendingMessageCount < 0) {
      throw new PiNativeCapabilityError(
        "unknown",
        "Pi RPC get_state did not expose streaming, compaction, and pending-message state required to settle the Run.",
      );
    }
    await rpc.drainEvents();
    if (!isStreaming && !isCompacting && pendingMessageCount === 0 && !rpc.isRetrying && !rpc.willRetryAfterAgentEnd) return state;
    await new Promise((resolve) => setTimeout(resolve, RPC_SETTLED_POLL_MS));
  }
    throw new PiNativeCapabilityError("unknown", "Pi RPC did not reach a native settled state before timing out.");
}

async function handlePiExtensionUiRequest(input: {
  event: JsonRecord;
  rpc: PiRpcClient;
  runId: string;
  sessionId: string;
  signal?: AbortSignal;
  isCurrent: () => boolean;
  requestApproval?: PiRequestApproval;
  waitForApproval?: PiWaitForApproval;
  onLog: AgentRuntimeExecutionContext["onLog"];
}): Promise<void> {
  const requestId = nonEmpty(input.event.id);
  const method = nonEmpty(input.event.method) ?? "unknown";
  if (!requestId) throw new PiNativeCapabilityError("unknown", "Pi extension UI request has no correlation ID.");
  const dialog = extensionDialog(input.event);
  const supportedFireAndForget = new Set([
    "notify", "setStatus", "setWidget", "setTitle", "set_editor_text",
  ]);
  if (!dialog) {
    const knownDialog = ["select", "confirm", "input", "editor"].includes(method);
    const reason = supportedFireAndForget.has(method)
      ? "displayed_as_runtime_event"
      : knownDialog ? "dialog_not_mappable_to_runtime_question" : "unsupported_extension_ui_method";
    await input.onLog("stdout", `[rudder] Pi extension UI ${JSON.stringify({ requestId, reason, ...extensionUiLogPayload(input.event) })}\n`);
    if (supportedFireAndForget.has(method)) return;
    input.rpc.send({ type: "extension_ui_response", id: requestId, cancelled: true });
    return;
  }

  let response: JsonRecord = { cancelled: true };
  let reason = "approval_bridge_unavailable";
  if (input.requestApproval && input.waitForApproval && input.isCurrent()) {
    try {
      const request: AgentRuntimeApprovalRequest = {
        type: "agent_runtime",
        payload: {
          provider: "pi",
          runtimeType: "pi_local",
          protocol: "rpc",
          ...(input.runId ? { runId: input.runId } : {}),
          sessionId: input.sessionId,
          requestId,
          interactionKind: "extension_ui",
          method,
        },
        inputRequest: dialog.question,
      };
      const approval = await racePiControl({
        operation: input.requestApproval(request),
        signal: input.signal,
        isCurrent: input.isCurrent,
      });
      if (approval.status === "approved" || approval.status === "pending") {
        const decision: PiApprovalDecision = await racePiControl({
          operation: input.waitForApproval(approval.id, APPROVAL_TIMEOUT_MS),
          signal: input.signal,
          isCurrent: input.isCurrent,
        });
        if (decision.id === approval.id && decision.status === "approved" && input.isCurrent()) {
          const answer = decision.inputResponse?.answers.find((item) => item.questionId === "pi_extension");
          const selected = answer?.optionIds ?? [];
          const freeform = nonEmpty(answer?.freeformText);
          if (dialog.method === "select" && selected.length === 1 && !freeform) {
            const value = dialog.optionValues.get(selected[0]);
            if (value !== undefined) response = { value };
          } else if (dialog.method === "confirm" && selected.length === 1) {
            const value = dialog.optionValues.get(selected[0]);
            if (value === "Yes" || value === "No") response = { confirmed: value === "Yes" };
          } else if (dialog.method === "input" || dialog.method === "editor") {
            if (selected.includes("choice_2")) response = { cancelled: true };
            else if (freeform) response = { value: freeform };
          }
          reason = Object.hasOwn(response, "cancelled") ? "invalid_or_empty_response" : "answered";
        } else {
          reason = "approval_rejected_or_stale";
        }
      } else {
        reason = "approval_rejected_or_cancelled";
      }
    } catch {
      reason = input.isCurrent() ? "approval_resolution_failed" : "stale_attempt";
    }
  }

  await input.onLog("stdout", `[rudder] Pi extension UI ${JSON.stringify({
    requestId,
    reason,
    ...extensionUiLogPayload(input.event),
  })}\n`);
  input.rpc.send({ type: "extension_ui_response", id: requestId, ...response });
}

export function createPiRpcControlHandle(input: {
  rpc: { command(command: string, extra?: JsonRecord): Promise<unknown> };
  sessionId: string;
  providerTurnId: string | null;
  onStopAcknowledged?: () => void;
}): AgentRuntimeControlHandle {
  return {
    runtimeType: "pi_local",
    providerThreadId: input.sessionId,
    providerTurnId: input.providerTurnId,
    capabilities: { steer: "native", interrupt: "native" },
    async steer(steerInput: AgentRuntimeControlSteerInput): Promise<AgentRuntimeControlSteerResult> {
      await input.rpc.command("steer", { message: steerInput.text });
      if (!input.providerTurnId) {
        return {
          disposition: "acceptance_unknown",
          providerThreadId: input.sessionId,
          reason: "Pi RPC accepted steer, but no provider turn boundary is available yet.",
        };
      }
      return {
        disposition: "accepted_current",
        providerThreadId: input.sessionId,
        providerTurnId: input.providerTurnId,
      };
    },
    async interrupt(_reason: AgentRuntimeControlInterruptReason): Promise<AgentRuntimeControlInterruptResult> {
      await input.rpc.command("abort");
      input.onStopAcknowledged?.();
      return "acknowledged";
    },
    async dispose() {
      // The owning RPC operation closes the process and stdin.
    },
  };
}

export async function executePiNativeChat(input: {
  runId?: string | null;
  command: string;
  cwd: string;
  env: Record<string, string>;
  sessionFile: string;
  sessionDir: string;
  prompt: string;
  model: string;
  timeoutSec: number;
  binding: PiBinding;
  sessionParams?: Record<string, unknown> | null;
  workspace?: PiWorkspaceIdentity | null;
  signal?: AbortSignal;
  controlAttempt?: AgentRuntimeControlAttemptLease;
  requestApproval?: PiRequestApproval;
  waitForApproval?: PiWaitForApproval;
  rpcArgs?: readonly string[];
  onNativeTransportProfile?: (profile: Record<string, unknown>) => Promise<void>;
  onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}): Promise<AgentRuntimeExecutionResult> {
  const persisted = input.sessionParams
    ? requireBoundSession({
        sessionId: input.sessionFile,
        sessionParams: input.sessionParams,
        sessionDisplayId: input.sessionFile,
      }, input.binding, input.workspace)
    : null;
  const command = persisted?.command ?? input.command;
  const cwd = persisted?.cwd ?? input.cwd;
  const sessionFile = persisted?.sessionFile ?? input.sessionFile;
  const sessionDir = persisted?.sessionDir ?? input.sessionDir;
  const env = persisted?.rpcEnv ?? input.env;
  const rpcArgs = persisted?.rpcArgs ?? [...(input.rpcArgs ?? [])];
  if (persisted) {
    if (path.resolve(cwd) !== path.resolve(input.cwd)) {
      throw new PiNativeCapabilityError("unsupported", "Pi persisted session cwd does not match the current workspace cwd.");
    }
    if (command !== input.command) {
      throw new PiNativeCapabilityError("unsupported", "Pi persisted command does not match the current provider profile.");
    }
    if (path.resolve(sessionDir) !== path.resolve(input.sessionDir)) {
      throw new PiNativeCapabilityError("unsupported", "Pi persisted session directory does not match the current provider profile.");
    }
    if (JSON.stringify(rpcArgs) !== JSON.stringify(input.rpcArgs ?? [])) {
      throw new PiNativeCapabilityError("unsupported", "Pi persisted RPC args do not match the current provider profile.");
    }
    if (JSON.stringify(env) !== JSON.stringify(safeEnv(input.env))) {
      throw new PiNativeCapabilityError("unsupported", "Pi persisted RPC environment does not match the current provider profile.");
    }
    await requireKnownProviderSession(
      persisted.sessionFile,
      nonEmpty(input.sessionParams?.providerSessionId),
    );
  }
  if (input.signal?.aborted) throw input.signal.reason ?? new Error("Pi RPC request cancelled");
  const rpcProcess = spawnRpc({
    command,
    cwd,
    env,
    sessionDir,
    sessionFile,
    args: rpcArgs,
  });
  const eventSummary: PiEventSummary = {
    count: 0,
    counts: new Map(),
    lastType: null,
    finalAssistantText: "",
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 },
  };
  let lease: Awaited<ReturnType<NonNullable<AgentRuntimeControlAttemptLease["register"]>>> | null = null;
  let rpc!: PiRpcClient;
  let providerSessionId: string | null = null;
  let promptSent = false;
  let stopAcknowledged = false;
  const currentAttemptIsCurrent = () => {
    if (!input.controlAttempt || !lease) return !input.controlAttempt || !input.signal?.aborted;
    try {
      return lease.isCurrent() && !input.signal?.aborted;
    } catch {
      return false;
    }
  };
  rpc = new PiRpcClient(rpcProcess, input.signal, async (event) => {
    recordPiEvent(eventSummary, event);
    if (event.type === "extension_ui_request") {
      await handlePiExtensionUiRequest({
        event,
        rpc,
        runId: input.runId ?? "",
        sessionId: providerSessionId ?? input.sessionFile,
        signal: input.signal,
        isCurrent: currentAttemptIsCurrent,
        requestApproval: input.requestApproval,
        waitForApproval: input.waitForApproval,
        onLog: input.onLog,
      });
    }
  });
  try {
    if (typeof rpcProcess.pid === "number" && input.onSpawn) {
      await input.onSpawn({ pid: rpcProcess.pid, startedAt: new Date().toISOString() });
    }
    const beforeLeafId = await extractLeafId(sessionFile);
    const state = parseState(await rpc.command("get_state"));
    if (input.controlAttempt) {
      lease = await input.controlAttempt.register(createPiRpcControlHandle({
        rpc,
        sessionId: nonEmpty(state.sessionId) ?? input.sessionFile,
        providerTurnId: null,
        onStopAcknowledged: () => { stopAcknowledged = true; },
      }));
      if (!lease) throw new PiNativeCapabilityError("unknown", "Pi RPC control handle lost its attempt lease.");
    }
    if (!currentAttemptIsCurrent()) throw new PiNativeCapabilityError("unknown", "Pi RPC attempt lost ownership before prompt submission.");
    await input.onNativeTransportProfile?.({
      runtimeType: "pi_local",
      command: input.command,
      cwd: input.cwd,
      sessionDir: input.sessionDir,
      rpcArgs: [...(input.rpcArgs ?? [])],
      rpcEnv: safeEnv(input.env),
    });
    if (!currentAttemptIsCurrent()) throw new PiNativeCapabilityError("unknown", "Pi RPC attempt lost ownership before prompt submission.");
    const runTimeoutMs = Number.isFinite(input.timeoutSec) && input.timeoutSec > 0
      ? Math.max(1, input.timeoutSec * 1_000)
      : RPC_TIMEOUT_MS;
    promptSent = true;
    await rpc.prompt(input.prompt, runTimeoutMs);
    const finalState = await waitForPiSettled(rpc, input.signal, runTimeoutMs);
    providerSessionId = nonEmpty(finalState.sessionId) ?? nonEmpty(state.sessionId);
    const leafId = await extractLeafId(nonEmpty(finalState.sessionFile) ?? sessionFile);
    const content = eventSummary.finalAssistantText;
    const params: JsonRecord = {
      sessionId: sessionFile,
      sessionFile: nonEmpty(finalState.sessionFile) ?? sessionFile,
      sessionDir,
      cwd,
      command,
      rpcArgs: [...rpcArgs],
      rpcEnv: safeEnv(env),
      transport: PI_NATIVE_TRANSPORT,
      providerSessionId,
      leafId,
      previousLeafId: beforeLeafId,
      hostId: input.binding.hostId,
      profileId: input.binding.profileId,
      ...(input.binding.id ? { profileBindingId: input.binding.id } : {}),
      ...(input.binding.orgId ? { profileOrgId: input.binding.orgId } : {}),
      ...(input.binding.workspaceBindingId ? { workspaceBindingId: input.binding.workspaceBindingId } : {}),
      ...(input.binding.capabilityRevision ? { capabilityRevision: input.binding.capabilityRevision } : {}),
      ...(input.binding.providerVersion ? { providerVersion: input.binding.providerVersion } : {}),
      ...Object.fromEntries(["workspaceId", "repoUrl", "repoRef", "workspaceBindingId"].flatMap((field) => {
        const value = nonEmpty(input.workspace?.[field as keyof PiWorkspaceIdentity]);
        return value ? [[field, value]] : [];
      })),
    };
    await input.onLog(
      "stdout",
      `[rudder] Pi native chat completed ${JSON.stringify({
        providerSessionId,
        leafId,
        ...eventMetadata(eventSummary),
      })}\n`,
    );
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      nativeWriterQuiescence: { status: "confirmed", source: "provider_terminal" },
      errorMessage: null,
      sessionId: sessionFile,
      sessionParams: params,
      sessionDisplayId: input.sessionFile,
      provider: input.model.includes("/") ? input.model.split("/", 1)[0] : null,
      model: input.model || null,
      billingType: "unknown",
      resultJson: {
        transport: "pi_rpc",
        providerSessionId,
        sessionId: input.sessionFile,
        leafId,
        providerTurnId: leafId,
        previousLeafId: beforeLeafId,
        ...eventMetadata(eventSummary),
      },
      usage: {
        inputTokens: eventSummary.usage.inputTokens,
        outputTokens: eventSummary.usage.outputTokens,
        cachedInputTokens: eventSummary.usage.cachedInputTokens,
      },
      costUsd: eventSummary.usage.costUsd,
      summary: content,
    };
  } catch (error) {
    const message = boundedDiagnostic(error);
    const metadata = eventMetadata(eventSummary);
    await input.onLog(
      "stderr",
      `[rudder] Pi native chat failed ${JSON.stringify({ ...metadata, error: message })}\n`,
    );
    return {
      exitCode: 1,
      signal: null,
      timedOut: /timed out/iu.test(message),
      ...(stopAcknowledged
        ? { nativeWriterQuiescence: { status: "confirmed" as const, source: "provider_stop_ack" as const } }
        : promptSent
          ? { nativeWriterQuiescence: { status: "unconfirmed" as const, reason: "Pi RPC prompt ended without an observed agent_end or abort acknowledgement." } }
          : {}),
      errorMessage: message,
      errorCode: error instanceof PiNativeCapabilityError ? `pi_native_${error.status}` : "pi_native_rpc_error",
      sessionId: input.sessionFile,
      sessionParams: {
        sessionId: sessionFile,
        sessionFile,
        sessionDir,
        cwd,
        command,
        rpcArgs: [...rpcArgs],
        rpcEnv: safeEnv(env),
        transport: PI_NATIVE_TRANSPORT,
        hostId: input.binding.hostId,
        profileId: input.binding.profileId,
        ...(input.binding.id ? { profileBindingId: input.binding.id } : {}),
        ...(input.binding.orgId ? { profileOrgId: input.binding.orgId } : {}),
        ...(input.binding.workspaceBindingId ? { workspaceBindingId: input.binding.workspaceBindingId } : {}),
        ...(input.binding.providerVersion ? { providerVersion: input.binding.providerVersion } : {}),
        ...Object.fromEntries(["workspaceId", "repoUrl", "repoRef", "workspaceBindingId"].flatMap((field) => {
          const value = nonEmpty(input.workspace?.[field as keyof PiWorkspaceIdentity]);
          return value ? [[field, value]] : [];
        })),
      },
      sessionDisplayId: input.sessionFile,
      provider: input.model.includes("/") ? input.model.split("/", 1)[0] : null,
      model: input.model || null,
      billingType: "unknown",
      resultJson: { transport: "pi_rpc", ...metadata, error: message },
      usage: {
        inputTokens: eventSummary.usage.inputTokens,
        outputTokens: eventSummary.usage.outputTokens,
        cachedInputTokens: eventSummary.usage.cachedInputTokens,
      },
      costUsd: eventSummary.usage.costUsd,
      summary: "",
    };
  } finally {
    await lease?.release();
    await rpc.close();
  }
}
