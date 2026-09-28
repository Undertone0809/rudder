import { diagnoseOpenCodeNativeFailure } from "@rudderhq/agent-runtime-utils";
import type {
  AgentRuntimeControlAttemptLease,
  AgentRuntimeControlHandle,
  AgentRuntimeControlHandleLease,
  AgentRuntimeControlInterruptReason,
  AgentRuntimeControlInterruptResult,
  AgentRuntimeControlSteerInput,
  AgentRuntimeControlSteerResult,
  AgentRuntimeExecutionContext,
  AgentRuntimeExecutionResult,
  OpenCodeNativeFailureDiagnostic,
  TranscriptEntry,
} from "@rudderhq/agent-runtime-utils";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  openCodeForkCleanupSafetyError,
  openCodeSideChatCleanupContractError,
} from "./side-chat-cleanup.js";

export type OpenCodeBinding = {
  id?: string | null;
  orgId?: string | null;
  hostId: string;
  profileId: string;
  workspaceBindingId?: string | null;
  capabilityRevision?: string | null;
};

export type OpenCodeSession = {
  sessionId: string;
  sessionParams: Record<string, unknown>;
  sessionDisplayId: string;
};

export type OpenCodeWorkspaceIdentity = {
  workspaceId?: string | null;
  repoUrl?: string | null;
  repoRef?: string | null;
  workspaceBindingId?: string | null;
};

export type OpenCodeTranscriptRequest = {
  runtimeType: string;
  session: OpenCodeSession;
  selector?: unknown;
  binding?: OpenCodeBinding | null;
  workspace?: OpenCodeWorkspaceIdentity | null;
  range?: unknown;
  from?: unknown;
  through?: unknown;
  cursor?: string | null;
  readerInput?: unknown | null;
  signal?: AbortSignal;
};

export type OpenCodeTranscriptResult = {
  items: readonly Record<string, unknown>[];
  nextCursor: null;
  revision: string;
  source: "native";
  availability: "available" | "offline" | "missing" | "incompatible";
  completeness: "complete" | "partial" | "unknown";
};

export type OpenCodeForkRequest = {
  runtimeType: string;
  session: OpenCodeSession;
  boundary: string;
  selector?: unknown;
  binding?: OpenCodeBinding | null;
  workspace?: OpenCodeWorkspaceIdentity | null;
  signal?: AbortSignal;
};

export type OpenCodeForkResult = {
  session: OpenCodeSession;
  boundary: string;
  sourceBoundary: string;
  identityMap: Record<string, string>;
  continuity: "native";
};

export class OpenCodeNativeCapabilityError extends Error {
  override readonly name = "OpenCodeNativeCapabilityError";

  constructor(
    readonly status: "unsupported" | "unknown",
    message: string,
    readonly sessionContext?: {
      sessionId: string;
      sessionParams: Record<string, unknown>;
      submissionPhase: "pre_submission" | "accepted" | "indeterminate";
      userMessageId?: string;
      observedAssistantMessageIds?: string[];
      providerAbortAcknowledged?: boolean;
      terminalObserved?: boolean;
    },
    readonly timedOut = false,
    readonly source: "adapter" | "provider" = "adapter",
    readonly nativeFailure?: OpenCodeNativeFailureDiagnostic,
  ) {
    super(message);
  }
}

class OpenCodeNativeTurnTimeoutError extends Error {}

type JsonRecord = Record<string, unknown>;
type OpenCodeMessage = { info: JsonRecord; parts: JsonRecord[] };
type OpenCodeRequestApproval = NonNullable<AgentRuntimeExecutionContext["requestApproval"]>;
type OpenCodeApprovalRequest = NonNullable<Parameters<OpenCodeRequestApproval>[0]["inputRequest"]>;
type OpenCodeApprovalDecision = Awaited<ReturnType<NonNullable<AgentRuntimeExecutionContext["waitForApproval"]>>>;
type OpenCodeApprovalResponse = NonNullable<OpenCodeApprovalDecision["inputResponse"]>;
type OpenCodeWaitForApproval = NonNullable<AgentRuntimeExecutionContext["waitForApproval"]>;
type AgentRuntimeApprovalRequest = Parameters<OpenCodeRequestApproval>[0];
type OpenCodeNativeEvent = { id?: string; type: string; properties: JsonRecord };
type OpenCodeApprovalResolution = {
  approvalId: string;
  decision: OpenCodeApprovalDecision | null;
};

type OpenCodeNativeEventStream = {
  idle: Promise<void>;
  task: Promise<void>;
};

const REQUEST_TIMEOUT_MS = 45_000;
const TURN_ABORT_TIMEOUT_MS = 2_000;
const PARTIAL_EXPORT_TIMEOUT_MS = 3_000;
// Native turns have an absolute one-hour ceiling even if output or approvals continue.
const MAX_NATIVE_TURN_SEC = 60 * 60;
const SERVER_START_TIMEOUT_MS = 15_000;
const CONTROL_APPROVAL_TIMEOUT_MS = 30 * 60_000;
const CONTROL_ATTEMPT_POLL_MS = 100;
const MAX_NATIVE_DIAGNOSTIC_TYPES = 32;
const MAX_NATIVE_EVENT_FRAME_CHARS = 8_000_000;
const MAX_NATIVE_EXPORT_BYTES = 32_000_000;
const MAX_NATIVE_EVENT_RECONNECTS = 8;
const NATIVE_EVENT_RECONNECT_DELAY_MS = 50;
const OPENCODE_NATIVE_TRANSPORT = "opencode-managed-server-http";
const SAFE_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "OPENCODE_CONFIG",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_CLAUDE_CODE_PROMPT",
  "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
  "RUDDER_OPERATOR_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
] as const;
const MANAGED_DISABLE_FLAGS = [
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_CLAUDE_CODE_PROMPT",
  "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
] as const;
const SERVER_RUN_SCOPED_ENV_KEYS = [
  "RUDDER_RUN_ID", "RUDDER_API_KEY", "RUDDER_TASK_ID", "RUDDER_WAKE_REASON",
  "RUDDER_WAKE_COMMENT_ID", "RUDDER_APPROVAL_ID", "RUDDER_APPROVAL_STATUS",
  "RUDDER_LINKED_ISSUE_IDS",
] as const;

type ManagedOpenCodeServerProcess = ChildProcessByStdio<null, Readable, Readable>;

const managedServers = new Map<string, {
  url: string;
  child: ManagedOpenCodeServerProcess;
  authorization: string;
  scope: string;
  configPath: string | null;
  active: number;
  retire: boolean;
}>();
const startingManagedServers = new Map<string, Promise<void>>();
const nativeSessionMutationTails = new Map<string, Promise<void>>();

type ManagedServer = { url: string; providerVersion: string | null; authorization: string; release: () => void };

async function withNativeSessionMutationLock<T>(
  sessionId: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = nativeSessionMutationTails.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate, () => gate);
  nativeSessionMutationTails.set(sessionId, tail);
  await previous;
  try {
    if (signal?.aborted) throw signal.reason ?? new Error("OpenCode session operation cancelled");
    return await operation();
  } finally {
    release();
    if (nativeSessionMutationTails.get(sessionId) === tail) nativeSessionMutationTails.delete(sessionId);
  }
}

function retireManagedServer(key: string): void {
  const server = managedServers.get(key);
  if (!server) return;
  server.retire = true;
  if (server.active > 0) return;
  managedServers.delete(key);
  if (server.child.exitCode === null) server.child.kill("SIGTERM");
  if (server.configPath) void rm(server.configPath, { force: true }).catch(() => undefined);
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeErrorMessage(value: unknown): string | null {
  return diagnoseOpenCodeNativeFailure(value).message;
}

function nativeFailureLabel(failure: OpenCodeNativeFailureDiagnostic): string {
  const label = `${failure.errorName ?? "Error"}${failure.statusCode ? ` HTTP ${failure.statusCode}` : ""}${failure.responseErrorType ? ` (${failure.responseErrorType})` : ""}`;
  return failure.message ? `${label}: ${failure.message}` : label;
}

function boundedDiagnostic(value: unknown, maxChars = 2_000): string {
  const text = value instanceof Error ? value.message : typeof value === "string" ? value : String(value);
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length > maxChars ? `${compact.slice(0, maxChars)}... [truncated]` : compact;
}

function responseMetadata(parts: readonly JsonRecord[], summary: string): JsonRecord {
  return {
    responsePartCount: parts.length,
    responsePartTypes: parts
      .slice(0, MAX_NATIVE_DIAGNOSTIC_TYPES)
      .map((part) => boundedDiagnostic(nonEmpty(part.type) ?? "unknown", 80)),
    summaryChars: summary.length,
  };
}

function stringAt(value: unknown, keys: readonly string[]): string | null {
  const record = asRecord(value);
  if (!record) return null;
  for (const key of keys) {
    const result = nonEmpty(record[key]);
    if (result) return result;
  }
  return null;
}

function bindingIsUsable(binding: OpenCodeBinding | null | undefined): binding is OpenCodeBinding {
  return Boolean(binding?.hostId?.trim() && binding.profileId?.trim());
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
  const entries = Object.entries(record);
  if (!entries.every(([key, entry]) => SAFE_ENV_KEYS.includes(key as typeof SAFE_ENV_KEYS[number])
    && typeof entry === "string"
    && entry.trim().length > 0)) return null;
  const values = Object.fromEntries(entries) as Record<string, string>;
  return safeEnv(values);
}

function sameRecord(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function withoutRunConfig(env: Record<string, string>): Record<string, string> {
  const result = { ...env };
  delete result.OPENCODE_CONFIG;
  return result;
}

function managedOpenCodeHome(env: Record<string, string>): string | null {
  const configHome = nonEmpty(env.XDG_CONFIG_HOME);
  const dataHome = nonEmpty(env.XDG_DATA_HOME);
  const cacheHome = nonEmpty(env.XDG_CACHE_HOME);
  if (!configHome || !dataHome || !cacheHome
    || ![configHome, dataHome, cacheHome].every(path.isAbsolute)) return null;
  const managedHome = path.dirname(configHome);
  if (managedHome === path.parse(managedHome).root
    || configHome !== path.join(managedHome, ".config")
    || dataHome !== path.join(managedHome, ".local", "share")
    || cacheHome !== path.join(managedHome, ".cache")) return null;
  return managedHome;
}

function managedRunConfigPath(env: Record<string, string>, runId?: string | null): string | null {
  const configPath = nonEmpty(env.OPENCODE_CONFIG);
  const managedHome = managedOpenCodeHome(env);
  if (!configPath || !managedHome) return null;
  const configRunId = runId ?? path.basename(path.dirname(configPath));
  if (!configRunId || configRunId === "." || configRunId === ".." || path.basename(configRunId) !== configRunId) return null;
  return configPath === path.join(managedHome, "runtime-tmp", configRunId, "opencode.json")
    ? configPath
    : null;
}

async function durableManagedOpenCodeConfigPath(env: Record<string, string>): Promise<string | null> {
  const managedHome = managedOpenCodeHome(env);
  if (!managedHome) return null;
  const configHome = path.join(managedHome, ".config");
  const configDirectory = path.join(configHome, "opencode");
  const configPath = path.join(configDirectory, "opencode.json");
  const [homeStat, configHomeStat, configDirectoryStat, configStat] = await Promise.all([
    lstat(managedHome).catch(() => null),
    lstat(configHome).catch(() => null),
    lstat(configDirectory).catch(() => null),
    lstat(configPath).catch(() => null),
  ]);
  if (!homeStat?.isDirectory() || !configHomeStat?.isDirectory()
    || !configDirectoryStat?.isDirectory() || !configStat?.isFile()) return null;
  return configPath;
}

async function exportEnvironmentForTranscript(env: Record<string, string>): Promise<Record<string, string>> {
  if (env.OPENCODE_CONFIG) return env;
  const durableConfigPath = await durableManagedOpenCodeConfigPath(env);
  return durableConfigPath ? { ...env, OPENCODE_CONFIG: durableConfigPath } : env;
}

export function isManagedOpenCodeRunConfigEnvironment(env: Record<string, string>): boolean {
  return managedRunConfigPath(env) !== null;
}

export function restoreOpenCodeManagedSessionFlags(input: {
  params: Record<string, unknown>;
  env: Record<string, string>;
  runId: string;
  verifiedConfigPath: string;
}): Record<string, unknown> {
  const stored = persistedEnv(input.params.exportEnv);
  const current = safeEnv(input.env);
  if (!stored || managedRunConfigPath(current, input.runId) !== input.verifiedConfigPath
    || (stored.OPENCODE_CONFIG && !managedRunConfigPath(stored))) return input.params;
  const restored = { ...stored };
  let changed = false;
  for (const flag of MANAGED_DISABLE_FLAGS) {
    if (restored[flag] !== undefined) continue;
    if (current[flag] !== "true") return input.params;
    restored[flag] = "true";
    changed = true;
  }
  if (!changed || !sameRecord(withoutRunConfig(restored), withoutRunConfig(current))) return input.params;
  return { ...input.params, exportEnv: restored };
}

function providerProcessEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  const result = { ...process.env, ...env };
  if (!env.OPENCODE_CONFIG) delete result.OPENCODE_CONFIG;
  delete result.OPENCODE_CONFIG_CONTENT;
  delete result.OPENCODE_CONFIG_DIR;
  return result;
}

function managedServerProcessEnv(env: Record<string, string>, managedConfig: boolean): NodeJS.ProcessEnv {
  const result = providerProcessEnv(env);
  for (const key of SERVER_RUN_SCOPED_ENV_KEYS) delete result[key];
  if (managedConfig) delete result.OPENCODE_CONFIG;
  return result;
}

function environmentFingerprint(env: NodeJS.ProcessEnv): string {
  return createHash("sha256")
    .update(JSON.stringify(Object.entries(env).sort(([left], [right]) => left.localeCompare(right))))
    .digest("hex");
}

function workspaceMismatch(
  params: JsonRecord,
  expected: OpenCodeWorkspaceIdentity | null | undefined,
): string | null {
  if (!expected) return null;
  const fields = ["workspaceId", "repoUrl", "repoRef", "workspaceBindingId"] as const;
  for (const field of fields) {
    const expectedValue = nonEmpty(expected[field]);
    const storedValue = nonEmpty(params[field]);
    if (expectedValue && storedValue !== expectedValue) {
      return `OpenCode persisted ${field} does not match the current workspace.`;
    }
    if (!expectedValue && storedValue) {
      return `OpenCode current workspace is missing persisted ${field} identity.`;
    }
  }
  return null;
}

function localServerUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol)
      && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)
      ? url
      : null;
  } catch {
    return null;
  }
}

function sessionParams(input: OpenCodeSession): JsonRecord {
  return input.sessionParams;
}

async function requireBoundSession(
  session: OpenCodeSession,
  binding: OpenCodeBinding | null | undefined,
  expected: {
    cwd?: string | null;
    command?: string | null;
    serverUrl?: string | null;
    env?: Record<string, string> | null;
    runId?: string | null;
    verifiedConfigPath?: string | null;
    workspace?: OpenCodeWorkspaceIdentity | null;
  } = {},
): Promise<{
  params: JsonRecord;
  serverUrl: string;
  cwd: string;
  serverCommand: string;
  exportCommand: string;
  command: string;
  exportEnv: Record<string, string>;
}> {
  if (!bindingIsUsable(binding)) {
    throw new OpenCodeNativeCapabilityError(
      "unknown",
      "OpenCode native I/O requires an explicit host and provider profile binding.",
    );
  }
  const params = sessionParams(session);
  const sessionId = nonEmpty(session.sessionId);
  const storedSessionId = nonEmpty(params.sessionId);
  if (!sessionId || storedSessionId !== sessionId) {
    throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode persisted session identity does not match the requested session.");
  }
  const storedHost = nonEmpty(params.hostId);
  const storedProfile = nonEmpty(params.profileId);
  if (storedHost !== binding.hostId.trim() || storedProfile !== binding.profileId.trim()) {
    throw new OpenCodeNativeCapabilityError(
      "unsupported",
      `OpenCode session is bound to ${storedHost ?? "unknown"}/${storedProfile ?? "unknown"}, not ${binding.hostId}/${binding.profileId}.`,
    );
  }
  if (binding.capabilityRevision && nonEmpty(params.capabilityRevision) !== binding.capabilityRevision) {
    throw new OpenCodeNativeCapabilityError(
      "unsupported",
      "OpenCode session capability revision does not match the requested profile binding.",
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
      throw new OpenCodeNativeCapabilityError("unsupported", `OpenCode persisted ${label} identity does not match the requested binding.`);
    }
    if (!expected && stored) {
      throw new OpenCodeNativeCapabilityError("unsupported", `OpenCode current binding is missing persisted ${label} identity.`);
    }
  }
  if (nonEmpty(params.transport) !== OPENCODE_NATIVE_TRANSPORT) {
    throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode persisted session transport does not match the managed server transport.");
  }
  const serverUrl = nonEmpty(params.serverUrl);
  const cwd = nonEmpty(params.cwd) ?? nonEmpty(params.directory);
  const serverCommand = nonEmpty(params.serverCommand);
  const exportCommand = nonEmpty(params.exportCommand);
  const exportEnv = persistedEnv(params.exportEnv);
  if (!serverUrl || !localServerUrl(serverUrl) || !cwd || !path.isAbsolute(cwd) || !serverCommand || !exportCommand || !exportEnv) {
    throw new OpenCodeNativeCapabilityError(
      "unknown",
      "OpenCode native session parameters do not contain a loopback server, absolute cwd, server/export commands, and safe export environment.",
    );
  }
  if (serverCommand !== exportCommand) {
    throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode persisted server and export commands do not match.");
  }
  if (expected.cwd && path.resolve(cwd) !== path.resolve(expected.cwd)) {
    throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode persisted session cwd does not match the current workspace cwd.");
  }
  if (expected.command && serverCommand !== expected.command.trim()) {
    throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode persisted server command does not match the current provider profile.");
  }
  if (expected.serverUrl) {
    const expectedUrl = localServerUrl(expected.serverUrl.trim());
    if (!expectedUrl || expectedUrl.toString() !== localServerUrl(serverUrl)?.toString()) {
      throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode persisted server URL does not match the current provider profile.");
    }
  }
  const workspaceError = workspaceMismatch(params, expected.workspace);
  if (workspaceError) throw new OpenCodeNativeCapabilityError("unsupported", workspaceError);
  let effectiveExportEnv = exportEnv;
  if (expected.env) {
    const currentEnv = safeEnv(expected.env);
    if (!sameRecord(exportEnv, currentEnv)) {
      const currentConfigPath = managedRunConfigPath(currentEnv, expected.runId);
      if (!sameRecord(withoutRunConfig(exportEnv), withoutRunConfig(currentEnv))
        || (exportEnv.OPENCODE_CONFIG && !managedRunConfigPath(exportEnv))
        || !currentConfigPath
        || currentConfigPath !== expected.verifiedConfigPath) {
        throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode persisted export environment does not match the current provider profile.");
      }
      const runDir = path.dirname(currentConfigPath);
      const [configFile, runDirectory, runtimeDirectory, managedHome] = await Promise.all([
        lstat(currentConfigPath).catch(() => null),
        lstat(runDir).catch(() => null),
        lstat(path.dirname(runDir)).catch(() => null),
        lstat(path.dirname(path.dirname(runDir))).catch(() => null),
      ]);
      if (!configFile?.isFile() || !runDirectory?.isDirectory()
        || !runtimeDirectory?.isDirectory() || !managedHome?.isDirectory()) {
        throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode current managed Run config is missing or is not a regular file.");
      }
    }
    effectiveExportEnv = currentEnv;
  } else if (exportEnv.OPENCODE_CONFIG) {
    if (!managedRunConfigPath(exportEnv)) {
      throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode persisted export config path is not adapter-managed.");
    }
    // Export and fork do not need a deleted Run's config; never inherit it from the host process.
    effectiveExportEnv = withoutRunConfig(exportEnv);
  }
  return {
    params: {
      sessionId,
      cwd,
      directory: cwd,
      serverUrl,
      serverCommand,
      exportCommand,
      exportEnv: effectiveExportEnv,
      transport: OPENCODE_NATIVE_TRANSPORT,
      hostId: binding.hostId.trim(),
      profileId: binding.profileId.trim(),
      ...(nonEmpty(params.capabilityRevision) ? { capabilityRevision: nonEmpty(params.capabilityRevision) } : {}),
      ...(nonEmpty(params.providerVersion) ? { providerVersion: nonEmpty(params.providerVersion) } : {}),
    },
    serverUrl,
    cwd,
    serverCommand,
    exportCommand,
    command: exportCommand,
    exportEnv: effectiveExportEnv,
  };
}

function requestUrl(base: string, pathname: string, query: Record<string, string | undefined> = {}): string {
  const url = new URL(pathname, base.endsWith("/") ? base : `${base}/`);
  for (const [key, value] of Object.entries(query)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

async function fetchJson(
  url: string,
  init: RequestInit = {},
  signal?: AbortSignal,
  authorization?: string,
  expectedStatus?: number,
  maxResponseBytes?: number,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    const headers = new Headers(init.headers);
    if (authorization) headers.set("authorization", authorization);
    response = await fetch(url, { ...init, headers, signal: combined });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw new OpenCodeNativeCapabilityError("unknown", `OpenCode server request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  let text: string;
  if (maxResponseBytes && response.body) {
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > maxResponseBytes) {
          await reader.cancel();
          throw new OpenCodeNativeCapabilityError("unknown", "OpenCode server response exceeded the native size limit.");
        }
        chunks.push(Buffer.from(next.value));
      }
    } finally {
      reader.releaseLock();
    }
    text = Buffer.concat(chunks).toString("utf8");
  } else {
    text = await response.text();
  }
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok || (expectedStatus !== undefined && response.status !== expectedStatus)) {
    const message = safeErrorMessage(stringAt(payload, ["message", "error", "name"])) ?? "request rejected";
    throw new OpenCodeNativeCapabilityError(
      response.status === 404 ? "unknown" : "unsupported",
      `OpenCode server ${response.status}: ${message}`,
    );
  }
  return payload;
}

function eventSessionId(event: OpenCodeNativeEvent): string | null {
  const info = asRecord(event.properties.info);
  return nonEmpty(
    event.properties.sessionID
    ?? event.properties.sessionId
    ?? event.properties.session_id
    ?? info?.sessionID
    ?? info?.sessionId,
  );
}

function assistantMessageIdFromEvent(event: OpenCodeNativeEvent): string | null {
  if (event.type === "message.updated") {
    const info = asRecord(event.properties.info);
    return info?.role === "assistant" ? nonEmpty(info.id) : null;
  }
  if (
    event.type === "message.part.delta"
    || event.type.endsWith(".text.delta")
    || event.type.endsWith(".reasoning.delta")
    || event.type.endsWith(".tool.input.delta")
  ) {
    return nonEmpty(event.properties.messageID);
  }
  return null;
}

function parseNativeEvent(value: unknown): OpenCodeNativeEvent | null {
  const record = asRecord(value);
  const type = nonEmpty(record?.type);
  const properties = asRecord(record?.properties);
  if (!type || !properties) return null;
  return {
    ...(nonEmpty(record?.id) ? { id: nonEmpty(record?.id)! } : {}),
    type,
    properties,
  };
}

async function consumeOpenCodeEventStream(
  response: Response,
  signal: AbortSignal,
  onEvent: (event: OpenCodeNativeEvent) => Promise<void>,
  onEventId: (eventId: string) => void,
): Promise<void> {
  if (!response.body) throw new OpenCodeNativeCapabilityError("unknown", "OpenCode event stream returned no body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let dataChars = 0;

  const dispatch = async () => {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n").trim();
    dataLines = [];
    dataChars = 0;
    if (!data || data === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new OpenCodeNativeCapabilityError("unknown", "OpenCode event stream returned invalid JSON data.");
    }
    const event = parseNativeEvent(parsed);
    if (event) {
      if (event.id) onEventId(event.id);
      await onEvent(event);
    }
  };

  const consumeLine = async (line: string) => {
    if (line === "") {
      await dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /u, "");
    if (field === "id" && !value.includes("\u0000")) onEventId(value);
    if (field === "data") {
      dataChars += value.length + (dataLines.length > 0 ? 1 : 0);
      if (dataChars > MAX_NATIVE_EVENT_FRAME_CHARS) {
        throw new OpenCodeNativeCapabilityError("unknown", "OpenCode event frame exceeded the native stream limit.");
      }
      dataLines.push(value);
    }
  };

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/u, "");
        buffer = buffer.slice(newline + 1);
        await consumeLine(line);
        newline = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_NATIVE_EVENT_FRAME_CHARS) {
        throw new OpenCodeNativeCapabilityError("unknown", "OpenCode event line exceeded the native stream limit.");
      }
    }
    buffer += decoder.decode();
    if (buffer) await consumeLine(buffer.replace(/\r$/u, ""));
    await dispatch();
  } finally {
    reader.releaseLock();
  }
  if (signal.aborted) throw signal.reason ?? new Error("OpenCode event stream cancelled");
}

async function openOpenCodeEventStream(
  url: string,
  cwd: string,
  signal: AbortSignal,
  authorization: string,
  lastEventId: string | null,
): Promise<Response> {
  const connectionController = new AbortController();
  const connectionSignal = AbortSignal.any([signal, connectionController.signal]);
  const timer = setTimeout(() => connectionController.abort(new Error("OpenCode event stream connection timed out")), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(
      requestUrl(url, "/event", { directory: cwd }),
      {
        headers: {
          accept: "text/event-stream",
          authorization,
          ...(lastEventId ? { "last-event-id": lastEventId } : {}),
        },
        signal: connectionSignal,
      },
    );
    if (!response.ok) {
      throw new OpenCodeNativeCapabilityError("unsupported", `OpenCode event stream returned HTTP ${response.status}.`);
    }
    return response;
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    if (error instanceof OpenCodeNativeCapabilityError) throw error;
    throw new OpenCodeNativeCapabilityError(
      "unknown",
      `OpenCode event stream connection failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function abortOpenCodeSession(url: string, sessionId: string, cwd: string, authorization: string): Promise<boolean> {
  // OpenCode returns a session-wide boolean, not a turn-scoped terminal receipt.
  return fetchJson(
    requestUrl(url, `/session/${encodeURIComponent(sessionId)}/abort`, { directory: cwd }),
    { method: "POST" },
    undefined,
    authorization,
    undefined,
    undefined,
    TURN_ABORT_TIMEOUT_MS,
  ).then((result) => result === true, () => false);
}

function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function parseListeningUrl(output: string): string | null {
  const match = output.match(/https?:\/\/[^\s\r\n]+/u);
  return match?.[0]?.replace(/[),.]+$/u, "") ?? null;
}

async function allocateManagedServerPort(): Promise<number> {
  const server = createNetServer();
  try {
    await new Promise<void>((resolve, reject) => {
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      server.once("listening", onListening);
      server.once("error", onError);
      server.listen({ host: "127.0.0.1", port: 0 });
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    if (!port) throw new Error("OS did not return a managed OpenCode server port.");
    return port;
  } catch (error) {
    throw new OpenCodeNativeCapabilityError(
      "unknown",
      `OpenCode managed server port allocation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

async function waitForServer(
  child: ManagedOpenCodeServerProcess,
  output: { value: string },
  authorization: string,
  signal?: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason ?? new Error("OpenCode server startup cancelled");
    const url = parseListeningUrl(output.value);
    if (url) {
      await fetchJson(requestUrl(url, "/global/health"), {}, signal, authorization);
      return url;
    }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new OpenCodeNativeCapabilityError(
    "unknown",
    `OpenCode managed server did not announce a healthy URL${output.value ? `: ${output.value.trim().slice(-500)}` : "."}`,
  );
}

export async function ensureManagedOpenCodeServer(input: {
  command: string;
  cwd: string;
  env: Record<string, string>;
  binding: OpenCodeBinding;
  signal?: AbortSignal;
  onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
}): Promise<ManagedServer> {
  if (!bindingIsUsable(input.binding)) {
    throw new OpenCodeNativeCapabilityError("unknown", "OpenCode managed server startup requires a profile binding.");
  }
  const stableEnv = safeEnv(input.env);
  const runConfig = managedRunConfigPath(stableEnv);
  const serverEnv = managedServerProcessEnv(input.env, Boolean(runConfig));
  const scope = JSON.stringify([
    input.command,
    input.binding.id ?? null,
    input.binding.orgId ?? null,
    input.binding.hostId.trim(),
    input.binding.profileId.trim(),
    input.binding.workspaceBindingId ?? null,
    input.binding.capabilityRevision ?? null,
    path.resolve(input.cwd),
  ]);
  const envFingerprint = environmentFingerprint(serverEnv);
  let configPath: string | null = null;
  let configHash: string | null = null;
  if (runConfig) {
    const stat = await lstat(runConfig).catch(() => null);
    if (!stat?.isFile()) throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode current managed Run config is missing or is not a regular file.");
    const contents = await readFile(runConfig);
    configHash = createHash("sha256").update(contents).digest("hex");
    const managedHome = path.dirname(path.dirname(path.dirname(runConfig)));
    const [runDirStat, runtimeDirStat, homeStat] = await Promise.all([
      lstat(path.dirname(runConfig)).catch(() => null),
      lstat(path.dirname(path.dirname(runConfig))).catch(() => null),
      lstat(managedHome).catch(() => null),
    ]);
    if (!runDirStat?.isDirectory() || !runtimeDirStat?.isDirectory() || !homeStat?.isDirectory()) {
      throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode managed Run config directory is not a regular directory.");
    }
    const baseDir = path.join(managedHome, "native-server-config");
    const existingBase = await lstat(baseDir).catch(() => null);
    if (existingBase && !existingBase.isDirectory()) throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode managed server config directory is not a regular directory.");
    await mkdir(baseDir, { recursive: true, mode: 0o700 });
    const snapshotDir = path.join(baseDir, createHash("sha256").update(JSON.stringify([scope, envFingerprint])).digest("hex"));
    const existingDir = await lstat(snapshotDir).catch(() => null);
    if (existingDir && !existingDir.isDirectory()) throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode managed server profile directory is not a regular directory.");
    await mkdir(snapshotDir, { recursive: true, mode: 0o700 });
    configPath = path.join(snapshotDir, `${configHash}.json`);
    const existingSnapshot = await lstat(configPath).catch(() => null);
    if (existingSnapshot && !existingSnapshot.isFile()) throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode managed server config snapshot is not a regular file.");
    if (existingSnapshot && createHash("sha256").update(await readFile(configPath)).digest("hex") !== configHash) {
      throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode managed server config snapshot changed unexpectedly.");
    }
    if (!existingSnapshot) await writeFile(configPath, contents, { flag: "wx", mode: 0o600 }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST" || !(await lstat(configPath!).catch(() => null))?.isFile()) throw error;
    });
  }
  const key = JSON.stringify([scope, envFingerprint, configHash]);
  const starting = startingManagedServers.get(key);
  if (starting) {
    await starting;
    return ensureManagedOpenCodeServer(input);
  }
  const existing = managedServers.get(key);
  if (existing && existing.child.exitCode === null) {
    let health: JsonRecord | null = null;
    try {
      health = asRecord(await fetchJson(requestUrl(existing.url, "/global/health"), {}, input.signal, existing.authorization));
    } catch (error) {
      if (existing.active > 0 || input.signal?.aborted) throw error;
      retireManagedServer(key);
    }
    if (health) {
    existing.active += 1;
    return { url: existing.url, providerVersion: nonEmpty(health?.version), authorization: existing.authorization, release: () => {
      existing.active -= 1;
      if (existing.retire) retireManagedServer(key);
    } };
    }
  }
  let finishStart!: () => void;
  const startPromise = new Promise<void>((resolve) => { finishStart = resolve; });
  startingManagedServers.set(key, startPromise);
  try {
  for (const [oldKey, server] of managedServers) {
    if (server.scope === scope && oldKey !== key) retireManagedServer(oldKey);
  }

  const port = await allocateManagedServerPort();
  const username = "rudder-managed";
  const password = randomBytes(32).toString("base64url");
  const authorization = basicAuthorization(username, password);
  const child = spawn(input.command, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: input.cwd,
    env: {
      ...serverEnv,
      ...(configPath ? { OPENCODE_CONFIG: configPath } : {}),
      OPENCODE_SERVER_USERNAME: username,
      OPENCODE_SERVER_PASSWORD: password,
    },
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { value: "" };
  child.stdout.on("data", (chunk: Buffer) => { output.value += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { output.value += chunk.toString("utf8"); });
  child.unref();
  try {
  if (typeof child.pid === "number" && input.onSpawn) {
    await input.onSpawn({ pid: child.pid, startedAt: new Date().toISOString() });
  }
  const url = await waitForServer(child, output, authorization, input.signal);
  const entry = { url, child, authorization, scope, configPath, active: 1, retire: false };
  const health = asRecord(await fetchJson(requestUrl(url, "/global/health"), {}, input.signal, authorization));
  managedServers.set(key, entry);
  child.once("exit", () => {
    if (managedServers.get(key)?.child === child) {
      managedServers.delete(key);
      if (configPath) void rm(configPath, { force: true }).catch(() => undefined);
    }
  });
  return { url, providerVersion: nonEmpty(health?.version), authorization, release: () => {
    entry.active -= 1;
    if (entry.retire) retireManagedServer(key);
  } };
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGTERM");
    throw error;
  }
  } finally {
    startingManagedServers.delete(key);
    finishStart();
  }
}

function modelBody(model: string): JsonRecord | undefined {
  const value = model.trim();
  const slash = value.indexOf("/");
  if (slash <= 0 || slash >= value.length - 1) return undefined;
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) };
}

function sessionModelBody(model: string): JsonRecord | undefined {
  const selectedModel = modelBody(model);
  if (!selectedModel) return undefined;
  return { id: selectedModel.modelID, providerID: selectedModel.providerID };
}

async function getSession(url: string, sessionId: string, cwd: string, signal: AbortSignal | undefined, authorization: string): Promise<JsonRecord> {
  const payload = asRecord(await fetchJson(
    requestUrl(url, `/session/${encodeURIComponent(sessionId)}`, { directory: cwd }),
    {},
    signal,
    authorization,
  ));
  if (!payload || !nonEmpty(payload.id)) throw new OpenCodeNativeCapabilityError("unknown", "OpenCode returned no session identity.");
  if (payload.id !== sessionId) throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode resumed a different session.");
  return payload;
}

export async function deleteOpenCodeSideChatForkSession(input: {
  session: OpenCodeSession;
  expectedParentSessionId: string;
  binding: OpenCodeBinding;
  profileCommand: string;
  profileCwd: string;
  signal?: AbortSignal;
}): Promise<void> {
  const sessionId = nonEmpty(input.session.sessionId);
  if (!sessionId) throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode cleanup requires an exact session id.");
  const bound = await requireBoundSession(input.session, input.binding, {
    command: input.profileCommand,
    cwd: input.profileCwd,
  });
  const managed = await ensureManagedOpenCodeServer({
    command: bound.serverCommand,
    cwd: bound.cwd,
    env: bound.exportEnv,
    binding: input.binding,
    signal: input.signal,
  });
  try {
    await withNativeSessionMutationLock(sessionId, input.signal, async () => {
      // The running profile's own OpenAPI document is the version-specific deletion attestation.
      const apiDocument = await fetchJson(
        requestUrl(managed.url, "/doc"),
        {},
        input.signal,
        managed.authorization,
        undefined,
        MAX_NATIVE_EXPORT_BYTES,
      );
      const contractError = openCodeSideChatCleanupContractError(apiDocument);
      if (contractError) throw new OpenCodeNativeCapabilityError("unsupported", contractError);

      let session: JsonRecord;
      try {
        session = await getSession(managed.url, sessionId, bound.cwd, input.signal, managed.authorization);
      } catch (error) {
        if (error instanceof OpenCodeNativeCapabilityError && error.message.startsWith("OpenCode server 404:")) {
          return;
        }
        throw error;
      }
      const children = await fetchJson(
        requestUrl(managed.url, `/session/${encodeURIComponent(sessionId)}/children`, { directory: bound.cwd }),
        {},
        input.signal,
        managed.authorization,
        undefined,
        MAX_NATIVE_EXPORT_BYTES,
      );
      const safetyError = openCodeForkCleanupSafetyError({
        session,
        sessionId,
        expectedParentSessionId: input.expectedParentSessionId.trim(),
        children,
      });
      if (safetyError) throw new OpenCodeNativeCapabilityError("unsupported", safetyError);

      const deleted = await fetchJson(
        requestUrl(managed.url, `/session/${encodeURIComponent(sessionId)}`, { directory: bound.cwd }),
        { method: "DELETE" },
        input.signal,
        managed.authorization,
        undefined,
        1_024,
      );
      if (deleted !== true) {
        throw new OpenCodeNativeCapabilityError("unknown", "OpenCode session.delete did not confirm deletion.");
      }
    });
  } finally {
    managed.release();
  }
}

async function createSession(url: string, cwd: string, model: string, signal: AbortSignal | undefined, authorization: string): Promise<JsonRecord> {
  const body: JsonRecord = {};
  const selectedModel = sessionModelBody(model);
  if (selectedModel) body.model = selectedModel;
  const payload = asRecord(await fetchJson(
    requestUrl(url, "/session", { directory: cwd }),
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    signal,
    authorization,
  ));
  const id = nonEmpty(payload?.id);
  if (!payload || !id) throw new OpenCodeNativeCapabilityError("unknown", "OpenCode session.create returned no session identity.");
  return payload;
}

function messageParts(message: OpenCodeMessage): JsonRecord[] {
  return Array.isArray(message.parts) ? message.parts : [];
}

function textFromParts(parts: readonly JsonRecord[]): string {
  return parts.map((part) => {
    const text = nonEmpty(part.text);
    if (text) return text;
    const state = asRecord(part.state);
    if (state) return nonEmpty(state.output) ?? nonEmpty(state.error) ?? "";
    return "";
  }).filter(Boolean).join("\n");
}

function finalTextFromParts(parts: readonly JsonRecord[]): string {
  return parts
    .filter((part) => nonEmpty(part.type) === "text" && part.ignored !== true)
    .map((part) => nonEmpty(part.text) ?? "")
    .filter(Boolean)
    .join("\n");
}

function providerPartText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return boundedDiagnostic(value, 4_000);
  }
}

function providerMessageTimestamp(message: OpenCodeMessage): string {
  const time = asRecord(message.info.time);
  const value = time?.created ?? message.info.createdAt ?? message.info.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value > 10_000_000_000 ? value : value * 1_000).toISOString();
  }
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return new Date(0).toISOString();
}

function providerToolEntries(part: JsonRecord, ts: string, fallbackToolId: string): TranscriptEntry[] {
  const state = asRecord(part.state);
  const partType = nonEmpty(part.type);
  const toolName = nonEmpty(part.tool ?? part.name) ?? "tool";
  const toolUseId = nonEmpty(part.callID ?? part.callId ?? part.id) ?? fallbackToolId;
  if (partType === "tool_result") {
    const rawContent = state?.output ?? state?.error ?? part.output ?? part.error;
    const content = providerPartText(rawContent);
    return [{
      kind: "tool_result",
      ts,
      toolUseId,
      toolName,
      content,
      isError: Boolean(state?.status === "error" || state?.error !== undefined || part.error !== undefined),
    }];
  }

  const call: TranscriptEntry = {
    kind: "tool_call",
    ts,
    name: toolName,
    input: state?.input ?? part.input ?? {},
    toolUseId,
  };
  const status = nonEmpty(state?.status);
  if (status !== "completed" && status !== "error") return [call];
  const rawContent = state?.output ?? state?.error ?? part.output ?? part.error;
  return [
    call,
    {
      kind: "tool_result",
      ts,
      toolUseId,
      toolName,
      content: providerPartText(rawContent),
      isError: status === "error" || state?.error !== undefined || part.error !== undefined,
    },
  ];
}

type OpenCodeProjectedTranscriptEntry = {
  entry: TranscriptEntry;
  partIndex: number | null;
  partId: string | null;
};

function transcriptEntriesForMessage(message: OpenCodeMessage): OpenCodeProjectedTranscriptEntry[] {
  const role = nonEmpty(message.info.role);
  const ts = providerMessageTimestamp(message);
  const messageId = nonEmpty(message.info.id) ?? "message";
  const entries: OpenCodeProjectedTranscriptEntry[] = [];
  for (const [partIndex, part] of messageParts(message).entries()) {
    const type = nonEmpty(part.type);
    const partId = nonEmpty(part.id) ?? `${messageId}:part:${partIndex}`;
    if (type === "text") {
      const text = typeof part.text === "string" ? part.text : "";
      if (text.trim()) {
        entries.push({
          entry: {
            kind: role === "user" ? "user" : role === "assistant" ? "assistant" : "system",
            ts,
            text,
            ...(role === "assistant" ? { phase: "final_answer" as const } : {}),
          },
          partIndex,
          partId,
        });
      }
      continue;
    }
    if (type === "reasoning") {
      const text = typeof part.text === "string" ? part.text : "";
      if (text.trim()) entries.push({ entry: { kind: "thinking", ts, text }, partIndex, partId });
      continue;
    }
    if (type === "tool" || type === "tool_use" || type === "tool_result") {
      entries.push(...providerToolEntries(part, ts, `${messageId}:tool:${partIndex}`).map((entry) => ({
        entry,
        partIndex,
        partId,
      })));
      continue;
    }
    if (type === "step-finish" || type === "step_finish") {
      const tokens = asRecord(part.tokens);
      const cache = asRecord(tokens?.cache);
      const reason = nonEmpty(part.reason) ?? "step";
      entries.push({
        entry: {
          kind: "result",
          ts,
          text: reason,
          inputTokens: Number(tokens?.input ?? 0) || 0,
          outputTokens: (Number(tokens?.output ?? 0) || 0) + (Number(tokens?.reasoning ?? 0) || 0),
          cachedTokens: Number(cache?.read ?? 0) || 0,
          costUsd: Number(part.cost ?? 0) || 0,
          subtype: reason,
          isError: false,
          errors: [],
        },
        partIndex,
        partId,
      });
    }
  }
  if (entries.length > 0) return entries;

  const fallbackText = textFromParts(messageParts(message));
  if (!fallbackText) return [];
  return [{
    entry: {
      kind: role === "user" ? "user" : role === "assistant" ? "assistant" : "system",
      ts,
      text: fallbackText,
      ...(role === "assistant" ? { phase: "final_answer" as const } : {}),
    },
    partIndex: null,
    partId: null,
  }];
}

function validateNativeChatResponse(response: unknown, sessionId: string, expectedUserMessageId?: string): {
  info: JsonRecord;
  parts: JsonRecord[];
  messageId: string;
  userMessageId: string | null;
  summary: string;
} {
  const payload = asRecord(response);
  if (!payload) {
    throw new OpenCodeNativeCapabilityError("unknown", "OpenCode native message response was empty or not an object.");
  }
  const info = asRecord(payload.info);
  if (!info) {
    throw new OpenCodeNativeCapabilityError("unknown", "OpenCode native message response has no message info.");
  }
  if (info.error !== undefined && info.error !== null) {
    const nativeFailure = diagnoseOpenCodeNativeFailure(info.error, "message.error");
    const provider = nativeFailure.source === "provider";
    const cancelled = !provider && /abort|cancel/iu.test([nativeFailure.errorName, nativeFailure.message].filter(Boolean).join(" "));
    throw new OpenCodeNativeCapabilityError(
      "unknown",
      `OpenCode native message ${cancelled ? "was cancelled" : "failed"}: ${nativeFailureLabel(nativeFailure)}`,
      undefined,
      false,
      provider ? "provider" : "adapter",
      nativeFailure,
    );
  }
  if (info.role !== "assistant") {
    throw new OpenCodeNativeCapabilityError("unknown", "OpenCode native message response is not an assistant message.");
  }
  const messageId = nonEmpty(info.id);
  if (!messageId) {
    throw new OpenCodeNativeCapabilityError("unknown", "OpenCode native message response has no provider message ID.");
  }
  const responseSessionId = nonEmpty(info.sessionID ?? info.sessionId ?? info.session_id);
  if (responseSessionId && responseSessionId !== sessionId) {
    throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode native message response belongs to a different provider session.");
  }
  const finish = nonEmpty(info.finish);
  if (!finish) {
    throw new OpenCodeNativeCapabilityError("unknown", "OpenCode native message response has no terminal finish reason.");
  }
  if (/abort|cancel/iu.test(finish)) {
    throw new OpenCodeNativeCapabilityError("unknown", `OpenCode native message was cancelled (${finish}).`);
  }
  if (/error|fail/iu.test(finish)) {
    throw new OpenCodeNativeCapabilityError("unknown", `OpenCode native message failed (${finish}).`);
  }
  const completed = asRecord(info.time)?.completed;
  if (typeof completed !== "number" || !Number.isSafeInteger(completed) || completed < 0) {
    throw new OpenCodeNativeCapabilityError("unknown", "OpenCode native message response has no terminal completion timestamp.");
  }
  const parts = Array.isArray(payload.parts)
    ? payload.parts.map(asRecord).filter((part): part is JsonRecord => Boolean(part))
    : [];
  const summary = finalTextFromParts(parts);
  if (!summary) {
    throw new OpenCodeNativeCapabilityError("unknown", "OpenCode native message response has no final text part; reasoning-only or partial output is not final.");
  }
  return {
    info,
    parts,
    messageId,
    userMessageId: expectedUserMessageId ?? nonEmpty(info.parentID),
    summary,
  };
}

function parseMessages(value: unknown, expectedSessionId?: string): OpenCodeMessage[] {
  if (!Array.isArray(value)) throw new OpenCodeNativeCapabilityError("unknown", "OpenCode returned no session messages.");
  const seenIds = new Set<string>();
  return value.map((entry) => {
    const record = asRecord(entry);
    const info = asRecord(record?.info);
    const parts = Array.isArray(record?.parts) ? record.parts.map(asRecord).filter((part): part is JsonRecord => Boolean(part)) : [];
    const id = nonEmpty(info?.id);
    if (!info || !id || !nonEmpty(info.role)) {
      throw new OpenCodeNativeCapabilityError("unknown", "OpenCode returned a message without a stable role or ID.");
    }
    if (seenIds.has(id)) {
      throw new OpenCodeNativeCapabilityError("unsupported", `OpenCode export returned duplicate message ID ${id}.`);
    }
    seenIds.add(id);
    const messageSessionId = nonEmpty(info.sessionID) ?? nonEmpty(info.sessionId);
    if (expectedSessionId && messageSessionId && messageSessionId !== expectedSessionId) {
      throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode export returned a message from a different session.");
    }
    return { info, parts };
  });
}

function parseExport(stdout: string): JsonRecord {
  const clean = stdout.replace(/\u001b\[[0-9;]*m/gu, "").trim();
  const parseDocument = (candidate: string): JsonRecord | null => {
    try {
      const payload = JSON.parse(candidate) as unknown;
      const record = asRecord(payload);
      return record && (Array.isArray(record.messages) || asRecord(record.info)) ? record : null;
    } catch {
      return null;
    }
  };
  const direct = parseDocument(clean);
  if (direct) return direct;
  // A CLI warning may precede the document, but nested pretty-printed objects are indented.
  const documentStart = clean.lastIndexOf("\n{");
  if (documentStart >= 0) {
    const prefixed = parseDocument(clean.slice(documentStart + 1));
    if (prefixed) return prefixed;
  }
  throw new OpenCodeNativeCapabilityError("unknown", "OpenCode export did not return a JSON session document.");
}

async function exportSession(input: {
  command: string;
  serverCommand: string;
  sessionId: string;
  cwd: string;
  env: Record<string, string>;
  binding: OpenCodeBinding;
  managed?: { url: string; authorization: string };
  signal?: AbortSignal;
}): Promise<{ info: JsonRecord; messages: OpenCodeMessage[] }> {
  const child = spawn(input.command, ["export", input.sessionId], {
    cwd: input.cwd,
    env: providerProcessEnv(input.env),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let exportTooLarge = false;
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_NATIVE_EXPORT_BYTES) {
      exportTooLarge = true;
      child.kill("SIGTERM");
      return;
    }
    stdoutChunks.push(chunk);
  });
  child.stderr.resume();
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new OpenCodeNativeCapabilityError("unknown", "OpenCode export timed out."));
    }, REQUEST_TIMEOUT_MS);
    const abort = () => {
      child.kill("SIGKILL");
      reject(input.signal?.reason ?? new Error("OpenCode export cancelled"));
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
      reject(new OpenCodeNativeCapabilityError("unknown", `OpenCode export process failed: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
      resolve({ code, signal });
    });
  });
  if (exportTooLarge) {
    throw new OpenCodeNativeCapabilityError("unknown", "OpenCode export exceeded the native size limit.");
  }
  if (exit.code !== 0) {
    throw new OpenCodeNativeCapabilityError(
      "unknown",
      `OpenCode export exited with ${exit.code ?? exit.signal ?? "unknown"}.`,
    );
  }
  let document: JsonRecord;
  try {
    document = parseExport(Buffer.concat(stdoutChunks).toString("utf8"));
  } catch (error) {
    if (!(error instanceof OpenCodeNativeCapabilityError) || stdoutBytes < 65_536) throw error;
    const ownedManaged = input.managed ? null : await ensureManagedOpenCodeServer({
      command: input.serverCommand,
      cwd: input.cwd,
      env: input.env,
      binding: input.binding,
      signal: input.signal,
    });
    const managed = input.managed ?? ownedManaged!;
    try {
      const info = await getSession(managed.url, input.sessionId, input.cwd, input.signal, managed.authorization);
      const messages = await fetchJson(
        requestUrl(managed.url, `/session/${encodeURIComponent(input.sessionId)}/message`, { directory: input.cwd }),
        {}, input.signal, managed.authorization, undefined, MAX_NATIVE_EXPORT_BYTES,
      );
      document = { info, messages };
    } finally {
      ownedManaged?.release();
    }
  }
  const info = asRecord(document.info);
  if (!info || nonEmpty(info.id) !== input.sessionId) {
    throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode export returned a different session identity.");
  }
  return { info, messages: parseMessages(document.messages, input.sessionId) };
}

const FORK_REWRITTEN_ID_KEYS = new Set([
  "id",
  "sessionID",
  "sessionId",
  "messageID",
  "messageId",
  "parentID",
  "parentId",
]);

function normalizeForkContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForkContent);
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => !FORK_REWRITTEN_ID_KEYS.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalizeForkContent(child)]),
  );
}

function forkMessageFingerprint(message: OpenCodeMessage): string {
  return JSON.stringify({
    role: nonEmpty(message.info.role),
    parts: messageParts(message).map(normalizeForkContent),
  });
}

function completedAssistantBoundary(messages: readonly OpenCodeMessage[], boundary: string): {
  index: number;
  nextMessageId: string | null;
} {
  const index = messages.findIndex((message) => message.info.id === boundary);
  if (index < 0) {
    throw new OpenCodeNativeCapabilityError("unknown", `OpenCode export did not return fork boundary ${boundary}.`);
  }
  const message = messages[index];
  if (message.info.role !== "assistant") {
    throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode fork boundary must be an assistant message.");
  }
  const finish = nonEmpty(message.info.finish);
  const time = asRecord(message.info.time);
  const completedAt = time?.completed;
  const hasCompletedAt = (typeof completedAt === "number" && Number.isFinite(completedAt))
    || Boolean(nonEmpty(completedAt));
  if (!finish || !hasCompletedAt) {
    throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode fork boundary must be a completed assistant message.");
  }
  return {
    index,
    nextMessageId: nonEmpty(messages[index + 1]?.info.id),
  };
}

function verifyForkContinuity(
  sourceMessages: readonly OpenCodeMessage[],
  childMessages: readonly OpenCodeMessage[],
  boundary: string,
): Record<string, string> {
  const boundaryIndex = sourceMessages.findIndex((message) => message.info.id === boundary);
  if (boundaryIndex < 0) {
    throw new OpenCodeNativeCapabilityError("unknown", `OpenCode export did not return fork boundary ${boundary}.`);
  }
  const sourcePrefix = sourceMessages.slice(0, boundaryIndex + 1);
  if (childMessages.length !== sourcePrefix.length) {
    throw new OpenCodeNativeCapabilityError(
      "unsupported",
      `OpenCode fork did not preserve exactly the ${sourcePrefix.length} messages through boundary ${boundary}.`,
    );
  }

  const sourceIds = new Set(sourcePrefix.map((message) => nonEmpty(message.info.id)!));
  const childIds = new Set(childMessages.map((message) => nonEmpty(message.info.id)!));
  if (childIds.size !== childMessages.length || childMessages.some((message) => sourceIds.has(nonEmpty(message.info.id)!))) {
    throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode fork did not rewrite copied message identities.");
  }

  const sourceFingerprints = new Set<string>();
  const childFingerprints = new Set<string>();
  const identityMap: Record<string, string> = {};
  for (let index = 0; index < sourcePrefix.length; index += 1) {
    const sourceFingerprint = forkMessageFingerprint(sourcePrefix[index]);
    const childFingerprint = forkMessageFingerprint(childMessages[index]);
    if (sourceFingerprints.has(sourceFingerprint) || childFingerprints.has(childFingerprint)) {
      throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode fork prefix has ambiguous message content.");
    }
    sourceFingerprints.add(sourceFingerprint);
    childFingerprints.add(childFingerprint);
    if (sourceFingerprint !== childFingerprint) {
      throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode fork did not preserve the exact source message prefix.");
    }
    identityMap[nonEmpty(sourcePrefix[index].info.id)!] = nonEmpty(childMessages[index].info.id)!;
  }
  if (Object.keys(identityMap).length !== sourcePrefix.length) {
    throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode fork did not return a stable identity map for every copied message.");
  }
  return identityMap;
}

function selectorRecord(value: unknown): JsonRecord | null {
  return asRecord(value);
}

function requestedRange(input: OpenCodeTranscriptRequest): JsonRecord | null {
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

function refId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : nonEmpty(asRecord(value)?.itemId);
}

function applyRange(items: JsonRecord[], range: JsonRecord | null): JsonRecord[] {
  if (!range) return items;
  const matchesRef = (item: JsonRecord, id: string) =>
    item.id === id || item.sourceEntryId === id || item.sourcePartId === id;
  if (range.itemId !== undefined && range.itemId !== null) {
    const id = refId(range.itemId);
    return id ? items.filter((item) => matchesRef(item, id)) : [];
  }
  let result = [...items];
  const sliceFrom = (value: unknown, inclusive: boolean) => {
    const id = refId(value);
    const index = id ? result.findIndex((item) => matchesRef(item, id)) : -1;
    if (index >= 0) result = result.slice(index + (inclusive ? 0 : 1));
    else if (typeof value === "number") result = result.slice(Math.max(0, Math.floor(value) + (inclusive ? 0 : 1)));
    else result = [];
  };
  const sliceTo = (value: unknown, inclusive: boolean) => {
    const id = refId(value);
    const index = id
      ? result.reduce((found, item, itemIndex) => matchesRef(item, id) ? itemIndex : found, -1)
      : -1;
    if (index >= 0) result = result.slice(0, index + (inclusive ? 1 : 0));
    else if (typeof value === "number") result = result.filter((item) => Number(item.ordinal) <= Math.floor(value) - (inclusive ? 0 : 1));
    else result = [];
  };
  if (range.start !== undefined && range.start !== null) sliceFrom(range.start, true);
  if (range.end !== undefined && range.end !== null) sliceTo(range.end, true);
  if (range.fromExclusive !== undefined || range.after !== undefined) sliceFrom(range.fromExclusive ?? range.after, false);
  if (range.throughInclusive !== undefined) sliceTo(range.throughInclusive, true);
  if (range.before !== undefined && range.before !== null) sliceTo(range.before, false);
  return result;
}

function ancestorUserId(messages: readonly OpenCodeMessage[], messageId: string): string | null {
  const byId = new Map(messages.map((message) => [nonEmpty(message.info.id)!, message]));
  const seen = new Set<string>();
  let current: string | null = messageId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const message = byId.get(current);
    if (!message) return null;
    if (message.info.role === "user") return current;
    current = nonEmpty(message.info.parentID);
  }
  return null;
}

function providerMessagesForSelector(
  messages: readonly OpenCodeMessage[],
  sessionId: string,
  selector: unknown,
): OpenCodeMessage[] {
  const record = selectorRecord(selector);
  if (!record) throw new OpenCodeNativeCapabilityError("unknown", "OpenCode transcript requires a concrete message selector.");
  if (record.kind !== "opencode_input") {
    throw new OpenCodeNativeCapabilityError("unsupported", "The OpenCode native reader received a non-OpenCode span selector.");
  }
  const selectedSession = nonEmpty(record.sessionId);
  if (selectedSession && selectedSession !== sessionId) {
    throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode transcript selector targets a different provider session.");
  }
  if (record.completeness === "partial") {
    const userMessageId = nonEmpty(record.userMessageId);
    const observedIds = Array.isArray(record.observedAssistantMessageIds)
      ? record.observedAssistantMessageIds.map(nonEmpty).filter((id): id is string => Boolean(id))
      : [];
    if (!userMessageId || observedIds.length === 0 || new Set(observedIds).size !== observedIds.length) {
      throw new OpenCodeNativeCapabilityError("unknown", "OpenCode partial transcript selector has no exact observed assistant boundary.");
    }
    const byId = new Map(messages.map((message) => [nonEmpty(message.info.id)!, message]));
    const userMessage = byId.get(userMessageId);
    if (!userMessage || userMessage.info.role !== "user") {
      throw new OpenCodeNativeCapabilityError("unknown", "OpenCode partial transcript selector has no matching provider user message.");
    }
    const userSessionId = nonEmpty(userMessage.info.sessionID ?? userMessage.info.sessionId);
    if (userSessionId && userSessionId !== sessionId) {
      throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode partial input belongs to a different provider session.");
    }
    for (const id of observedIds) {
      const message = byId.get(id);
      if (!message || message.info.role !== "assistant") {
        throw new OpenCodeNativeCapabilityError("unknown", "OpenCode partial selector references an unobserved or non-assistant provider message.");
      }
      const messageSessionId = nonEmpty(message.info.sessionID ?? message.info.sessionId);
      if (messageSessionId && messageSessionId !== sessionId) {
        throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode observed assistant message belongs to a different provider session.");
      }
      if (ancestorUserId(messages, id) !== userMessageId) {
        throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode observed assistant message does not descend from the selected Run input.");
      }
    }
    const userIndex = messages.indexOf(userMessage);
    if (observedIds.some((id) => messages.indexOf(byId.get(id)!) <= userIndex)) {
      throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode observed assistant message precedes the selected Run input.");
    }
    const selectedIds = new Set([userMessageId, ...observedIds]);
    return messages.filter((message) => selectedIds.has(nonEmpty(message.info.id) ?? ""));
  }
  const terminalIds = Array.isArray(record.terminalMessageIds)
    ? record.terminalMessageIds.map(nonEmpty).filter((id): id is string => Boolean(id))
    : [];
  const messageIds = new Set(messages.map((message) => nonEmpty(message.info.id)).filter((id): id is string => Boolean(id)));
  if (terminalIds.length === 0) {
    throw new OpenCodeNativeCapabilityError("unknown", "OpenCode transcript selector has no provider message boundary.");
  }
  if (terminalIds.some((id) => !messageIds.has(id))) {
    throw new OpenCodeNativeCapabilityError("unknown", "OpenCode transcript selector references a message absent from provider export.");
  }
  const firstTerminal = messages.find((message) => terminalIds.includes(nonEmpty(message.info.id) ?? ""));
  const startId = messageIds.has(nonEmpty(record.userMessageId) ?? "")
    ? nonEmpty(record.userMessageId)
    : firstTerminal ? ancestorUserId(messages, nonEmpty(firstTerminal.info.id)!) : null;
  if (!startId) {
    throw new OpenCodeNativeCapabilityError("unknown", "OpenCode transcript selector has no provider user-message boundary.");
  }
  const startIndex = messages.findIndex((message) => message.info.id === startId && message.info.role === "user");
  const terminalIndices = terminalIds.map((id) => messages.findIndex((message) => message.info.id === id));
  const endIndex = Math.max(...terminalIndices);
  if (startIndex < 0 || endIndex < startIndex) {
    throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode provider message boundaries are not an ordered native range.");
  }
  if (terminalIds.some((id) => ancestorUserId(messages, id) !== startId)) {
    throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode terminal messages do not descend from the selected Run input.");
  }
  const selected = messages.slice(startIndex, endIndex + 1).filter((message) =>
    ancestorUserId(messages, nonEmpty(message.info.id)!) === startId,
  );
  if (terminalIds.some((id) => !selected.some((message) => message.info.id === id))) {
    throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode transcript range does not contain every selected terminal message.");
  }
  return selected;
}

function terminalAssistantForInput(
  messages: readonly OpenCodeMessage[],
  sessionId: string,
  userMessageId: string,
): OpenCodeMessage {
  const userMessage = messages.find((message) => message.info.id === userMessageId);
  if (!userMessage || userMessage.info.role !== "user") {
    throw new OpenCodeNativeCapabilityError("unknown", "OpenCode accepted input has no matching persisted user message.");
  }
  const userSessionId = nonEmpty(userMessage.info.sessionID ?? userMessage.info.sessionId);
  if (userSessionId && userSessionId !== sessionId) {
    throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode accepted input belongs to a different provider session.");
  }
  const assistantMessages = messages.filter((message) =>
    message.info.role === "assistant"
    && ancestorUserId(messages, nonEmpty(message.info.id)!) === userMessageId,
  );
  const terminal = assistantMessages.at(-1);
  if (!terminal) {
    throw new OpenCodeNativeCapabilityError("unknown", "OpenCode session became idle without an assistant message for the accepted input.");
  }
  return terminal;
}

function assertConcreteTranscriptSelector(selector: unknown, sessionId: string): JsonRecord {
  const record = selectorRecord(selector);
  if (!record) {
    throw new OpenCodeNativeCapabilityError("unknown", "OpenCode transcript requires a concrete message selector.");
  }
  if (record.kind === "pending" || record.kind === "unresolved") {
    throw new OpenCodeNativeCapabilityError("unknown", "OpenCode transcript selector has no sealed provider message boundary.");
  }
  if (record.kind !== "opencode_input") {
    throw new OpenCodeNativeCapabilityError("unsupported", "The OpenCode native reader received a non-OpenCode span selector.");
  }
  const selectedSession = nonEmpty(record.sessionId);
  if (selectedSession && selectedSession !== sessionId) {
    throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode transcript selector targets a different provider session.");
  }
  const terminalIds = Array.isArray(record.terminalMessageIds)
    ? record.terminalMessageIds.map(nonEmpty).filter((id): id is string => Boolean(id))
    : [];
  if (record.completeness === "partial") {
    const observedIds = Array.isArray(record.observedAssistantMessageIds)
      ? record.observedAssistantMessageIds.map(nonEmpty).filter((id): id is string => Boolean(id))
      : [];
    if (
      !nonEmpty(record.userMessageId)
      || observedIds.length === 0
      || new Set(observedIds).size !== observedIds.length
      || terminalIds.length > 0
    ) {
      throw new OpenCodeNativeCapabilityError("unknown", "OpenCode partial transcript selector has no exact observed assistant boundary.");
    }
  } else if (terminalIds.length === 0) {
    throw new OpenCodeNativeCapabilityError("unknown", "OpenCode transcript selector has no provider message boundary.");
  }
  return record;
}

function transcriptEntryText(entry: TranscriptEntry): string | null {
  if ("text" in entry && typeof entry.text === "string" && entry.text.length > 0) return entry.text;
  if (entry.kind === "tool_result" && entry.content.length > 0) return entry.content;
  return null;
}

function recordsForMessages(messages: readonly OpenCodeMessage[]): JsonRecord[] {
  const records: JsonRecord[] = [];
  for (const message of messages) {
    const id = nonEmpty(message.info.id)!;
    const timestamp = providerMessageTimestamp(message);
    const entries = transcriptEntriesForMessage(message);
    const normalizedEntries: OpenCodeProjectedTranscriptEntry[] = entries.length > 0
      ? entries
      : [{
        entry: { kind: "system", ts: timestamp, text: `OpenCode message ${id} has no transcript parts.` },
        partIndex: null,
        partId: null,
      }];
    for (const [entryIndex, projected] of normalizedEntries.entries()) {
      const { entry, partIndex, partId } = projected;
      const sourceEntryId = entry.sourceEntryId ?? id;
      const normalizedEntry = { ...entry, sourceEntryId };
      const text = transcriptEntryText(normalizedEntry);
      const part = partIndex === null ? null : message.parts[partIndex] ?? null;
      records.push({
        id: entryIndex === 0 ? id : `${id}:${entry.kind}:${entryIndex}`,
        sourceEntryId: id,
        ...(partId ? { sourcePartId: partId } : {}),
        ordinal: records.length,
        kind: normalizedEntry.kind,
        ts: normalizedEntry.ts,
        entry: normalizedEntry,
        payload: {
          provider: "opencode",
          message: { info: message.info, parts: part ? [part] : [] },
          ...(part ? { part } : {}),
          entry: normalizedEntry,
        },
        origin: "native",
        visibility: "visible",
        ...(text ? { text } : {}),
      });
    }
  }
  return records;
}

function revisionFor(info: JsonRecord, messages: readonly OpenCodeMessage[]): string {
  const value = JSON.stringify({
    id: info.id,
    updatedAt: info.time ?? info.updatedAt,
    messages: messages.map((message) => ({ id: message.info.id, parentID: message.info.parentID, role: message.info.role, partCount: message.parts.length })),
  });
  return `opencode:${createHash("sha256").update(value).digest("hex")}`;
}

function unavailable(error: OpenCodeNativeCapabilityError): OpenCodeTranscriptResult {
  return {
    items: [],
    nextCursor: null,
    revision: `${error.status}:${error.message}`,
    source: "native",
    availability: error.status === "unknown" ? "missing" : "incompatible",
    completeness: "unknown",
  };
}

function requestIdFromEvent(event: OpenCodeNativeEvent): string | null {
  return nonEmpty(event.properties.id ?? event.properties.requestID ?? event.properties.requestId);
}

function boundedField(value: unknown, maxChars: number): string | null {
  const result = nonEmpty(value);
  return result ? result.slice(0, maxChars) : null;
}

type OpenCodeQuestionBridge = {
  inputRequest: OpenCodeApprovalRequest;
  questions: Map<string, {
    optionLabels: Map<string, string>;
    multiple: boolean;
    allowFreeform: boolean;
  }>;
};

function questionBridgeFromEvent(event: OpenCodeNativeEvent): OpenCodeQuestionBridge | null {
  if (!Array.isArray(event.properties.questions) || event.properties.questions.length < 1 || event.properties.questions.length > 4) {
    return null;
  }
  const questions: OpenCodeApprovalRequest["questions"] = [];
  const questionMap = new Map<string, { optionLabels: Map<string, string>; multiple: boolean; allowFreeform: boolean }>();
  for (const [questionIndex, value] of event.properties.questions.entries()) {
    const record = asRecord(value);
    const question = boundedField(record?.question, 240);
    const rawOptions = Array.isArray(record?.options) ? record.options : [];
    if (!question || rawOptions.length < 2 || rawOptions.length > 4) return null;
    const questionId = `q${questionIndex + 1}`;
    const optionLabels = new Map<string, string>();
    const options: OpenCodeApprovalRequest["questions"][number]["options"] = [];
    for (const [optionIndex, optionValue] of rawOptions.entries()) {
      const option = asRecord(optionValue);
      const label = boundedField(option?.label, 80);
      if (!label) return null;
      const optionId = `o${optionIndex + 1}`;
      if (optionLabels.has(optionId)) return null;
      optionLabels.set(optionId, label);
      options.push({
        id: optionId,
        label,
        ...(boundedField(option?.description, 220) ? { description: boundedField(option?.description, 220)! } : {}),
      });
    }
    const header = boundedField(record?.header, 32);
    const multiple = record?.multiple === true;
    const allowFreeform = record?.custom === true;
    questions.push({
      id: questionId,
      ...(header ? { header } : {}),
      question,
      options,
      ...(multiple ? { selectionMode: "multiple" as const } : {}),
      ...(allowFreeform ? { allowFreeform: true } : {}),
    });
    questionMap.set(questionId, { optionLabels, multiple, allowFreeform });
  }
  return { inputRequest: { questions }, questions: questionMap };
}

function providerQuestionAnswers(
  response: OpenCodeApprovalResponse | undefined,
  bridge: OpenCodeQuestionBridge,
): string[][] | null {
  if (!response || !Array.isArray(response.answers) || response.answers.length !== bridge.questions.size) return null;
  const seen = new Set<string>();
  const answersByQuestion = new Map<string, string[]>();
  for (const answer of response.answers) {
    const questionId = nonEmpty(answer?.questionId);
    if (!questionId || seen.has(questionId)) return null;
    const question = bridge.questions.get(questionId);
    if (!question || !Array.isArray(answer.optionIds)) return null;
    const optionIds = answer.optionIds.map(nonEmpty);
    if (optionIds.some((optionId): optionId is null => optionId === null)) return null;
    const uniqueOptionIds = new Set(optionIds as string[]);
    if (uniqueOptionIds.size !== optionIds.length || (!question.multiple && optionIds.length > 1)) return null;
    const labels = (optionIds as string[]).map((optionId) => question.optionLabels.get(optionId));
    if (labels.some((label): label is undefined => label === undefined)) return null;
    const freeformText = nonEmpty(answer.freeformText);
    if (freeformText && !question.allowFreeform) return null;
    if (labels.length === 0 && !freeformText) return null;
    answersByQuestion.set(questionId, [...labels.filter((label): label is string => Boolean(label)), ...(freeformText ? [freeformText] : [])]);
    seen.add(questionId);
  }
  if (seen.size !== bridge.questions.size) return null;
  return [...bridge.questions.keys()].map((questionId) => answersByQuestion.get(questionId) ?? []);
}

function interactionApprovalRequest(input: {
  sessionId: string;
  requestId: string;
  attemptEpoch: number | null;
  kind: "permission" | "question";
  payload: JsonRecord;
  inputRequest?: OpenCodeApprovalRequest;
}): AgentRuntimeApprovalRequest {
  return {
    type: "agent_runtime",
    payload: {
      provider: "opencode",
      runtimeType: "opencode_local",
      protocol: "sse",
      sessionId: input.sessionId,
      requestId: input.requestId,
      interactionKind: input.kind,
      ...(input.attemptEpoch !== null ? { attemptEpoch: input.attemptEpoch } : {}),
      ...input.payload,
      ...(input.inputRequest ? { inputRequest: input.inputRequest } : {}),
    },
    ...(input.inputRequest ? { inputRequest: input.inputRequest } : {}),
  };
}

async function raceNativeControlOperation<T>(input: {
  operation: Promise<T>;
  signal: AbortSignal;
  isCurrent: () => boolean;
}): Promise<T> {
  if (input.signal.aborted || !input.isCurrent()) throw new OpenCodeNativeCapabilityError("unknown", "OpenCode control request is no longer current.");
  let pollTimer: NodeJS.Timeout | null = null;
  const stale = new Promise<never>((_, reject) => {
    const check = () => {
      if (input.signal.aborted || !input.isCurrent()) {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        reject(new OpenCodeNativeCapabilityError("unknown", "OpenCode control request is no longer current."));
      }
    };
    check();
    if (!input.signal.aborted && input.isCurrent()) pollTimer = setInterval(check, CONTROL_ATTEMPT_POLL_MS);
  });
  try {
    return await Promise.race([input.operation, stale]);
  } finally {
    if (pollTimer) clearInterval(pollTimer);
  }
}

export async function readOpenCodeNativeTranscript(input: OpenCodeTranscriptRequest): Promise<OpenCodeTranscriptResult> {
  const bound = await requireBoundSession(input.session, input.binding, { workspace: input.workspace });
  if (input.runtimeType !== "opencode_local") throw new OpenCodeNativeCapabilityError("unsupported", `OpenCode transport cannot serve ${input.runtimeType}.`);
  if (input.cursor) throw new OpenCodeNativeCapabilityError("unknown", "OpenCode export is a complete snapshot transport; provider cursors are unsupported.");
  try {
    assertConcreteTranscriptSelector(input.selector, input.session.sessionId);
    const exportEnv = await exportEnvironmentForTranscript(bound.exportEnv);
    const exported = await exportSession({
      command: bound.command,
      serverCommand: bound.serverCommand,
      sessionId: input.session.sessionId,
      cwd: bound.cwd,
      env: exportEnv,
      binding: input.binding!,
      signal: input.signal,
    });
    const selected = providerMessagesForSelector(
      exported.messages,
      input.session.sessionId,
      input.selector,
    );
    const partial = selectorRecord(input.selector)?.completeness === "partial";
    const records = recordsForMessages(selected);
    return {
      items: applyRange(records, requestedRange(input)),
      nextCursor: null,
      revision: revisionFor(exported.info, selected),
      source: "native",
      availability: "available",
      completeness: partial ? "partial" : "complete",
    };
  } catch (error) {
    if (error instanceof OpenCodeNativeCapabilityError) return unavailable(error);
    throw error;
  }
}

export async function forkOpenCodeNativeSession(input: OpenCodeForkRequest): Promise<OpenCodeForkResult> {
  const bound = await requireBoundSession(input.session, input.binding, { workspace: input.workspace });
  if (input.runtimeType !== "opencode_local") throw new OpenCodeNativeCapabilityError("unsupported", `OpenCode transport cannot serve ${input.runtimeType}.`);
  const boundary = nonEmpty(input.boundary);
  if (!boundary) throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode native fork requires a message boundary.");
  const selector = selectorRecord(input.selector);
  if (selector?.kind !== undefined && selector.kind !== "opencode_input") {
    throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode fork received a non-OpenCode span selector.");
  }
  const selectedSession = nonEmpty(selector?.sessionId);
  if (selectedSession && selectedSession !== input.session.sessionId) {
    throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode fork selector targets a different provider session.");
  }
  const terminalIds = Array.isArray(selector?.terminalMessageIds)
    ? selector.terminalMessageIds.map(nonEmpty).filter((id): id is string => Boolean(id))
    : [];
  if (terminalIds.length > 0 && !terminalIds.includes(boundary)) {
    throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode fork boundary does not match the selected provider message.");
  }
  const managed = await ensureManagedOpenCodeServer({
    command: bound.serverCommand,
    cwd: bound.cwd,
    env: bound.exportEnv,
    binding: input.binding!,
    signal: input.signal,
  });
  try {
    return await withNativeSessionMutationLock(input.session.sessionId, input.signal, async () => {
      const sourceExport = await exportSession({
        command: bound.exportCommand,
        serverCommand: bound.serverCommand,
        sessionId: input.session.sessionId,
        cwd: bound.cwd,
        env: bound.exportEnv,
        binding: input.binding!,
        signal: input.signal,
      });
      const sourceBoundary = completedAssistantBoundary(sourceExport.messages, boundary);
      const response = asRecord(await fetchJson(
        requestUrl(managed.url, `/session/${encodeURIComponent(input.session.sessionId)}/fork`, { directory: bound.cwd }),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(sourceBoundary.nextMessageId ? { messageID: sourceBoundary.nextMessageId } : {}),
        },
        input.signal,
        managed.authorization,
      ));
      const childId = nonEmpty(response?.id);
      if (!childId || childId === input.session.sessionId) {
        throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode session.fork did not return a distinct child session.");
      }
      if (nonEmpty(response?.parentID) && response?.parentID !== input.session.sessionId) {
        throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode session.fork returned a different parent session.");
      }
      const childExport = await exportSession({
        command: bound.exportCommand,
        serverCommand: bound.serverCommand,
        sessionId: childId,
        cwd: bound.cwd,
        env: bound.exportEnv,
        binding: input.binding!,
        managed,
        signal: input.signal,
      });
      const identityMap = verifyForkContinuity(sourceExport.messages, childExport.messages, boundary);
      const childParams: JsonRecord = {
        sessionId: childId,
        serverUrl: managed.url,
        cwd: bound.cwd,
        directory: bound.cwd,
        serverCommand: bound.serverCommand,
        exportCommand: bound.exportCommand,
        exportEnv: bound.exportEnv,
        hostId: input.binding?.hostId,
        profileId: input.binding?.profileId,
        transport: OPENCODE_NATIVE_TRANSPORT,
        ...(input.binding?.id ? { profileBindingId: input.binding.id } : {}),
        ...(input.binding?.orgId ? { profileOrgId: input.binding.orgId } : {}),
        ...(input.binding?.workspaceBindingId ? { workspaceBindingId: input.binding.workspaceBindingId } : {}),
        ...(input.session.sessionParams.workspaceId ? { workspaceId: input.session.sessionParams.workspaceId } : {}),
        ...(input.session.sessionParams.repoUrl ? { repoUrl: input.session.sessionParams.repoUrl } : {}),
        ...(input.session.sessionParams.repoRef ? { repoRef: input.session.sessionParams.repoRef } : {}),
        ...(input.session.sessionParams.workspaceBindingId ? { workspaceBindingId: input.session.sessionParams.workspaceBindingId } : {}),
        ...(nonEmpty(bound.params.capabilityRevision) ? { capabilityRevision: nonEmpty(bound.params.capabilityRevision) } : {}),
        ...(nonEmpty(bound.params.providerVersion) ? { providerVersion: nonEmpty(bound.params.providerVersion) } : {}),
      };
      return {
        session: { sessionId: childId, sessionParams: childParams, sessionDisplayId: childId },
        boundary,
        sourceBoundary: boundary,
        identityMap,
        continuity: "native",
      };
    });
  } finally {
    managed.release();
  }
}

export async function executeOpenCodeNativeChat(input: {
  runId?: string | null;
  verifiedConfigPath?: string | null;
  command: string;
  cwd: string;
  env: Record<string, string>;
  prompt: string;
  model: string;
  variant: string;
  session: Record<string, unknown>;
  binding: OpenCodeBinding;
  workspace?: OpenCodeWorkspaceIdentity | null;
  media?: AgentRuntimeExecutionContext["media"];
  timeoutSec: number;
  idleTimeoutSec?: number;
  maxTurnSec?: number;
  signal?: AbortSignal;
  onNativeTransportProfile?: (profile: Record<string, unknown>) => Promise<void>;
  onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  controlAttempt?: AgentRuntimeControlAttemptLease;
  requestApproval?: OpenCodeRequestApproval;
  waitForApproval?: OpenCodeWaitForApproval;
}): Promise<AgentRuntimeExecutionResult> {
  if (input.binding.workspaceBindingId && input.workspace?.workspaceBindingId
    && input.binding.workspaceBindingId.trim() !== input.workspace.workspaceBindingId.trim()) {
    throw new OpenCodeNativeCapabilityError("unsupported", "OpenCode workspace binding does not match the verified provider profile binding.");
  }
  const persistedSessionId = nonEmpty(input.session.sessionId);
  const persisted = persistedSessionId
    ? await requireBoundSession({
        sessionId: persistedSessionId,
        sessionParams: input.session,
        sessionDisplayId: persistedSessionId,
      }, input.binding, {
        cwd: input.cwd,
        command: input.command,
        serverUrl: nonEmpty(input.session.serverUrl),
        env: input.env,
        runId: input.runId,
        verifiedConfigPath: input.verifiedConfigPath,
        workspace: input.workspace,
      })
    : null;
  const command = persisted?.serverCommand ?? input.command;
  const cwd = persisted?.cwd ?? input.cwd;
  const env = input.env;
  const managed = await ensureManagedOpenCodeServer({
    command,
    cwd,
    env,
    binding: input.binding,
    signal: input.signal,
    onSpawn: input.onSpawn,
  });
  let sessionId = persistedSessionId;
  try {
  await input.onNativeTransportProfile?.({
    runtimeType: "opencode_local",
    command: input.command,
    serverCommand: input.command,
    exportCommand: input.command,
    cwd: input.cwd,
    serverUrl: managed.url,
    providerVersion: managed.providerVersion,
    exportEnv: safeEnv(input.env),
  });
  if (sessionId) {
    await getSession(managed.url, sessionId, cwd, input.signal, managed.authorization);
  }
  if (!sessionId) {
    sessionId = nonEmpty((await createSession(managed.url, cwd, input.model, input.signal, managed.authorization)).id);
  }
  if (!sessionId) throw new OpenCodeNativeCapabilityError("unknown", "OpenCode native chat could not create a session.");
  } catch (error) {
    managed.release();
    throw error;
  }

  const sessionParamsForResult = (): JsonRecord => ({
    sessionId,
    cwd,
    directory: cwd,
    serverUrl: managed.url,
    serverCommand: command,
    exportCommand: command,
    exportEnv: safeEnv(env),
    transport: OPENCODE_NATIVE_TRANSPORT,
    hostId: input.binding.hostId,
    profileId: input.binding.profileId,
    ...(input.binding.id ? { profileBindingId: input.binding.id } : {}),
    ...(input.binding.orgId ? { profileOrgId: input.binding.orgId } : {}),
    ...(input.binding.workspaceBindingId ? { workspaceBindingId: input.binding.workspaceBindingId } : {}),
    ...(input.workspace?.workspaceId ? { workspaceId: input.workspace.workspaceId } : {}),
    ...(input.workspace?.repoUrl ? { repoUrl: input.workspace.repoUrl } : {}),
    ...(input.workspace?.repoRef ? { repoRef: input.workspace.repoRef } : {}),
    ...(input.workspace?.workspaceBindingId ? { workspaceBindingId: input.workspace.workspaceBindingId } : {}),
    ...(input.binding.capabilityRevision ? { capabilityRevision: input.binding.capabilityRevision } : {}),
    ...(managed.providerVersion ? { providerVersion: managed.providerVersion } : {}),
  });

  const userMessageId = `msg${randomBytes(18).toString("base64url")}`;
  const observedAssistantMessageIds = new Set<string>();
  const candidateAssistantMessageIds = new Set<string>();
  const turnController = new AbortController();
  const turnSignal = input.signal ? AbortSignal.any([input.signal, turnController.signal]) : turnController.signal;
  let controlLease: AgentRuntimeControlHandleLease | null = null;
  let promptSent = false;
  let submissionAccepted = false;
  let turnActivityObserved = false;
  let idleObserved = false;
  let terminalResponseObserved = false;
  let eventStreamConnected = false;
  let providerAbortSent = false;
  let providerAbortTask: Promise<void> | null = null;
  let providerAbortAcknowledged: boolean | null = null;
  let turnTimedOut = false;
  let streamFailure: Error | null = null;
  let resolveIdle!: () => void;
  let rejectIdle!: (error: unknown) => void;
  const idle = new Promise<void>((resolve, reject) => {
    resolveIdle = resolve;
    rejectIdle = reject;
  });
  const currentAttemptIsCurrent = () => {
    if (!input.controlAttempt || !controlLease) return !input.controlAttempt || !turnSignal.aborted;
    try {
      return controlLease.isCurrent() && !turnSignal.aborted;
    } catch {
      return false;
    }
  };
  const abortTurn = async (reason: unknown, abortProvider: boolean) => {
    if (!idleObserved) rejectIdle(reason ?? new Error("OpenCode native turn cancelled"));
    if (!turnController.signal.aborted) {
      turnTimedOut = reason instanceof OpenCodeNativeTurnTimeoutError;
      turnController.abort(reason ?? new Error("OpenCode native turn cancelled"));
    }
    if (abortProvider && promptSent) {
      if (!providerAbortSent) {
        providerAbortSent = true;
        providerAbortTask = abortOpenCodeSession(managed.url, sessionId!, cwd, managed.authorization)
          .then((acknowledged) => { providerAbortAcknowledged = acknowledged; });
      }
      if (providerAbortTask) await providerAbortTask;
    }
  };
  const requestedMaxTurnSec = input.maxTurnSec ?? input.timeoutSec;
  const maxTurnSec = Number.isFinite(requestedMaxTurnSec) && requestedMaxTurnSec > 0
    ? Math.min(requestedMaxTurnSec, MAX_NATIVE_TURN_SEC)
    : MAX_NATIVE_TURN_SEC;
  const timeout = setTimeout(() => {
    void abortTurn(new OpenCodeNativeTurnTimeoutError(`OpenCode native turn timed out after ${maxTurnSec}s`), true);
  }, maxTurnSec * 1_000);
  let idleTimeout: NodeJS.Timeout | null = null;
  const resetIdleTimeout = () => {
    if (!input.idleTimeoutSec || input.idleTimeoutSec <= 0 || idleObserved || turnSignal.aborted) return;
    if (idleTimeout) clearTimeout(idleTimeout);
    if (pendingInteractionIds.size > 0) return;
    idleTimeout = setTimeout(() => {
      void abortTurn(new OpenCodeNativeTurnTimeoutError(`OpenCode native turn inactive for ${input.idleTimeoutSec}s`), true);
    }, input.idleTimeoutSec * 1_000);
  };
  const onExternalAbort = () => {
    void abortTurn(input.signal?.reason ?? new Error("OpenCode native turn cancelled"), true);
  };
  input.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const respondedInteractionIds = new Set<string>();
  const pendingInteractionIds = new Set<string>();
  let responseChain: Promise<void> = Promise.resolve();
  const interactionTasks = new Set<Promise<void>>();
  const enqueueInteractionResponse = (requestId: string, response: () => Promise<void>): Promise<void> => {
    if (respondedInteractionIds.has(requestId)) return responseChain;
    respondedInteractionIds.add(requestId);
    pendingInteractionIds.delete(requestId);
    responseChain = responseChain.catch(() => undefined).then(response);
    return responseChain;
  };
  const providerRequest = (pathname: string, init: RequestInit) => fetchJson(
    requestUrl(managed.url, pathname, { directory: cwd }),
    init,
    turnSignal,
    managed.authorization,
  );
  const approvalDecision = async (request: AgentRuntimeApprovalRequest): Promise<OpenCodeApprovalResolution | null> => {
    if (!input.requestApproval || !input.waitForApproval || !currentAttemptIsCurrent()) return null;
    const approval = await raceNativeControlOperation({
      operation: input.requestApproval(request).then((value) => ({ id: value.id, status: value.status })),
      signal: turnSignal,
      isCurrent: currentAttemptIsCurrent,
    });
    if (approval.status === "rejected" || approval.status === "cancelled") return { approvalId: approval.id, decision: null };
    if (approval.status === "approved" && !request.inputRequest) {
      return { approvalId: approval.id, decision: { id: approval.id, status: "approved" } };
    }
    const decision = await raceNativeControlOperation({
      operation: input.waitForApproval(approval.id, CONTROL_APPROVAL_TIMEOUT_MS),
      signal: turnSignal,
      isCurrent: currentAttemptIsCurrent,
    });
    return { approvalId: approval.id, decision };
  };
  const streamLog = async (kind: string, payload: JsonRecord = {}) => {
    await input.onLog(
      "stdout",
      `[rudder] OpenCode native stream ${kind} ${JSON.stringify({ sessionId, ...payload })}\n`,
    );
  };
  const rejectProviderInteraction = async (kind: "permission" | "question", requestId: string, message: string) => {
    if (kind === "permission") {
      await providerRequest(
        `/permission/${encodeURIComponent(requestId)}/reply`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reply: "reject", message }),
        },
      );
    } else {
      await providerRequest(`/question/${encodeURIComponent(requestId)}/reject`, { method: "POST" });
    }
  };
  const handlePermission = async (event: OpenCodeNativeEvent, requestId: string) => {
    if (pendingInteractionIds.has(requestId) || respondedInteractionIds.has(requestId)) return;
    pendingInteractionIds.add(requestId);
    const properties = event.properties;
    let reply: "once" | "reject" = "reject";
    let message = "Rudder approval was not granted.";
    try {
      const decision = await approvalDecision(interactionApprovalRequest({
        sessionId: sessionId!,
        requestId,
        attemptEpoch: input.controlAttempt?.attemptEpoch ?? null,
        kind: "permission",
        payload: {
          ...(input.runId ? { runId: input.runId } : {}),
          permission: nonEmpty(properties.permission) ?? "unknown",
          patterns: Array.isArray(properties.patterns) ? properties.patterns.filter((value): value is string => typeof value === "string") : [],
          ...(asRecord(properties.metadata) ? { metadata: asRecord(properties.metadata)! } : {}),
          ...(Array.isArray(properties.always) ? { always: properties.always.filter((value): value is string => typeof value === "string") } : {}),
          ...(asRecord(properties.tool) ? { tool: asRecord(properties.tool)! } : {}),
        },
      }));
      if (decision?.decision) {
        if (decision.decision.id === decision.approvalId && decision.decision.status === "approved" && currentAttemptIsCurrent()) {
          reply = "once";
          message = "";
        } else if (decision.decision.status === "rejected" || decision.decision.status === "cancelled") {
          message = "Rudder approval was rejected or cancelled.";
        } else if (decision.decision.status === "pending") {
          message = "Rudder approval timed out before it was resolved.";
        } else {
          message = "Rudder approval request is no longer current.";
        }
      } else {
        message = "Rudder approval request is no longer current.";
      }
    } catch {
      message = currentAttemptIsCurrent() ? "Rudder approval could not be resolved." : "Rudder approval request is no longer current.";
    }
    await enqueueInteractionResponse(requestId, async () => {
      if (reply === "once") {
        await providerRequest(`/permission/${encodeURIComponent(requestId)}/reply`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reply: "once" }),
        });
      } else {
        await rejectProviderInteraction("permission", requestId, message);
      }
    });
  };
  const handleQuestion = async (event: OpenCodeNativeEvent, requestId: string) => {
    if (pendingInteractionIds.has(requestId) || respondedInteractionIds.has(requestId)) return;
    pendingInteractionIds.add(requestId);
    const bridge = questionBridgeFromEvent(event);
    let providerAnswers: string[][] | null = null;
    try {
      if (bridge) {
        const decision = await approvalDecision(interactionApprovalRequest({
          sessionId: sessionId!,
          requestId,
          attemptEpoch: input.controlAttempt?.attemptEpoch ?? null,
          kind: "question",
          payload: {
            ...(input.runId ? { runId: input.runId } : {}),
            questionRequestId: requestId,
            providerQuestions: event.properties.questions,
          },
          inputRequest: bridge.inputRequest,
        }));
        if (
          decision?.decision
          && decision.decision.id === decision.approvalId
          && decision.decision.status === "approved"
          && currentAttemptIsCurrent()
        ) {
          providerAnswers = providerQuestionAnswers(decision.decision.inputResponse, bridge);
        }
      }
    } catch {
      providerAnswers = null;
    }
    await enqueueInteractionResponse(requestId, async () => {
      if (providerAnswers) {
        await providerRequest(`/question/${encodeURIComponent(requestId)}/reply`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answers: providerAnswers }),
        });
      } else {
        await rejectProviderInteraction("question", requestId, "Rudder question was rejected, cancelled, stale, or invalid.");
      }
    });
  };
  const failStream = (error: unknown) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (streamFailure) return;
    streamFailure = normalized;
    rejectIdle(normalized);
    void abortTurn(normalized, true);
  };
  let eventStreamTask: Promise<void> | null = null;
  try {
    const eventResponse = await openOpenCodeEventStream(managed.url, cwd, turnSignal, managed.authorization, null);
    eventStreamConnected = true;
    let lastEventId: string | null = null;
    const onEvent = async (event: OpenCodeNativeEvent) => {
      const eventSession = eventSessionId(event);
      if (!eventSession || eventSession !== sessionId || !promptSent) return;
      if (input.controlAttempt && !currentAttemptIsCurrent()) {
        failStream(new OpenCodeNativeCapabilityError("unknown", "OpenCode native control attempt is no longer current."));
        return;
      }
      const observedAssistantMessageId = assistantMessageIdFromEvent(event);
      const updatedMessageInfo = event.type === "message.updated" ? asRecord(event.properties.info) : null;
      const updatedMessageParentId = nonEmpty(updatedMessageInfo?.parentID);
      const updateBelongsToInput = event.type === "message.updated" && (
        updatedMessageParentId === userMessageId
        || Boolean(updatedMessageParentId && observedAssistantMessageIds.has(updatedMessageParentId))
      );
      if (observedAssistantMessageId && observedAssistantMessageId !== userMessageId && updateBelongsToInput) {
        observedAssistantMessageIds.add(observedAssistantMessageId);
      } else if (observedAssistantMessageId && event.type !== "message.updated") {
        candidateAssistantMessageIds.add(observedAssistantMessageId);
      }
      if (event.type === "session.error") {
        const nativeFailure = diagnoseOpenCodeNativeFailure(event.properties.error);
        const provider = nativeFailure.source === "provider";
        failStream(new OpenCodeNativeCapabilityError(
          "unknown",
          `OpenCode ${provider ? "provider" : "session"} error: ${nativeFailureLabel(nativeFailure)}`,
          undefined,
          false,
          provider ? "provider" : "adapter",
          nativeFailure,
        ));
        return;
      }
      if (event.type === "session.idle" || (event.type === "session.status" && event.properties.status === "idle")) {
        if (!turnActivityObserved) return;
        if (!idleObserved) {
          idleObserved = true;
          if (idleTimeout) clearTimeout(idleTimeout);
          resolveIdle();
        }
        return;
      }
      turnActivityObserved = true;
      if (event.type === "session.next.prompted"
        || updateBelongsToInput
        || (observedAssistantMessageId && nonEmpty(event.properties.delta))
        || (event.type === "message.part.updated" && nonEmpty(event.properties.messageID))
        || event.type === "permission.asked" || event.type === "question.asked") resetIdleTimeout();
      if (event.type === "permission.asked") {
        const requestId = requestIdFromEvent(event);
        if (!requestId) {
          failStream(new OpenCodeNativeCapabilityError("unknown", "OpenCode permission event has no request ID."));
          return;
        }
        await streamLog("permission", { requestId });
        const task = handlePermission(event, requestId).catch(failStream).finally(() => {
          interactionTasks.delete(task);
          resetIdleTimeout();
        });
        interactionTasks.add(task);
        resetIdleTimeout();
        return;
      }
      if (event.type === "question.asked") {
        const requestId = requestIdFromEvent(event);
        if (!requestId) {
          failStream(new OpenCodeNativeCapabilityError("unknown", "OpenCode question event has no request ID."));
          return;
        }
        await streamLog("question", { requestId });
        const task = handleQuestion(event, requestId).catch(failStream).finally(() => {
          interactionTasks.delete(task);
          resetIdleTimeout();
        });
        interactionTasks.add(task);
        resetIdleTimeout();
        return;
      }
      const delta = nonEmpty(event.properties.delta);
      if (delta && (
        event.type === "message.part.delta"
        || event.type.endsWith(".text.delta")
        || event.type.endsWith(".reasoning.delta")
        || event.type.endsWith(".tool.input.delta")
      )) {
        await streamLog("delta", {
          eventType: event.type,
          messageId: nonEmpty(event.properties.messageID),
          partId: nonEmpty(event.properties.partID),
          delta: boundedDiagnostic(delta, 4_000),
        });
      }
    };
    eventStreamTask = (async () => {
      let response: Response | null = eventResponse;
      let reconnects = 0;
      while (!idleObserved && !turnSignal.aborted) {
        try {
          if (!response) {
            response = await openOpenCodeEventStream(managed.url, cwd, turnSignal, managed.authorization, lastEventId);
            eventStreamConnected = true;
          }
          await consumeOpenCodeEventStream(response, turnSignal, onEvent, (eventId) => { lastEventId = eventId; });
          response = null;
          eventStreamConnected = false;
          if (idleObserved || turnSignal.aborted) return;
          if (terminalResponseObserved) {
            idleObserved = true;
            resolveIdle();
            return;
          }
        } catch (error) {
          response = null;
          eventStreamConnected = false;
          if (turnSignal.aborted) return;
          if (terminalResponseObserved) {
            idleObserved = true;
            resolveIdle();
            return;
          }
          const retryableConnectionError = error instanceof OpenCodeNativeCapabilityError
            && error.status === "unknown"
            && error.message.includes("event stream connection failed");
          if (error instanceof OpenCodeNativeCapabilityError && !retryableConnectionError) throw error;
        }
        reconnects += 1;
        if (reconnects > MAX_NATIVE_EVENT_RECONNECTS) {
          throw new OpenCodeNativeCapabilityError("unknown", "OpenCode event stream did not recover before the reconnect limit.");
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(NATIVE_EVENT_RECONNECT_DELAY_MS * reconnects, 500)));
      }
    })().catch((error) => {
      if (!turnSignal.aborted) failStream(error);
    });

    const controlHandle: AgentRuntimeControlHandle = {
      runtimeType: "opencode_local",
      providerThreadId: sessionId,
      providerTurnId: null,
      capabilities: { steer: "interrupt_continue", interrupt: "remote" },
      steer: async (_steer: AgentRuntimeControlSteerInput): Promise<AgentRuntimeControlSteerResult> => ({
        disposition: "unsupported",
        reason: "OpenCode native SSE does not support steering without submitting a second prompt.",
      }),
      interrupt: async (_reason: AgentRuntimeControlInterruptReason): Promise<AgentRuntimeControlInterruptResult> => {
        await abortTurn(new Error("OpenCode native turn interrupted"), true);
        return providerAbortAcknowledged === true ? "acknowledged" : "unverified";
      },
      dispose: async () => {
        if (!idleObserved) await abortTurn(new Error("OpenCode native control handle disposed"), true);
      },
    };
    if (input.controlAttempt) {
      controlLease = await input.controlAttempt.register(controlHandle);
      if (!controlLease) {
        await abortTurn(new Error("OpenCode native control attempt lease was not granted"), true);
        throw new OpenCodeNativeCapabilityError("unknown", "OpenCode native control attempt lease was not granted.");
      }
    }

    const body: JsonRecord = {
      messageID: userMessageId,
      parts: [
        { type: "text", text: input.prompt },
        ...(input.media ?? []).map((attachment) => ({
          type: "file",
          mime: attachment.contentType,
          filename: attachment.originalFilename ?? attachment.name,
          url: pathToFileURL(path.resolve(attachment.localPath)).toString(),
        })),
      ],
      ...(modelBody(input.model) ? { model: modelBody(input.model) } : {}),
      ...(input.variant ? { variant: input.variant } : {}),
    };
    promptSent = true;
    resetIdleTimeout();
    const submissionPromise = fetchJson(
      requestUrl(managed.url, `/session/${encodeURIComponent(sessionId)}/prompt_async`, { directory: cwd }),
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      turnSignal,
      managed.authorization,
      204,
    ).then(() => { submissionAccepted = true; });
    await Promise.all([submissionPromise, idle]);
    await Promise.all([...interactionTasks]);
    await responseChain;
    if (!currentAttemptIsCurrent()) {
      throw new OpenCodeNativeCapabilityError("unknown", "OpenCode native control attempt is no longer current.");
    }
    const exported = await exportSession({
      command,
      serverCommand: command,
      sessionId,
      cwd,
      env,
      binding: input.binding,
      managed,
      signal: turnSignal,
    });
    const terminalMessage = terminalAssistantForInput(exported.messages, sessionId, userMessageId);
    const validated = validateNativeChatResponse({
      info: terminalMessage.info,
      parts: messageParts(terminalMessage),
    }, sessionId, userMessageId);
    terminalResponseObserved = true;
    const { info, parts, messageId, summary } = validated;
    await input.onLog(
      "stdout",
      `[rudder] OpenCode native chat completed ${JSON.stringify({
        providerSessionId: sessionId,
        providerMessageId: messageId,
        ...responseMetadata(parts, summary),
      })}\n`,
    );
    const params = sessionParamsForResult();
    const infoTokens = asRecord(info.tokens);
    const usage = infoTokens ? {
      inputTokens: Number(infoTokens.input ?? 0) || 0,
      outputTokens: Number(infoTokens.output ?? 0) || 0,
      cachedInputTokens: Number(asRecord(infoTokens.cache)?.read ?? 0) || 0,
    } : undefined;
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      submissionPhase: "accepted",
      providerThreadId: sessionId,
      providerTurnId: messageId,
      errorMessage: null,
      usage,
      sessionId,
      sessionParams: params,
      sessionDisplayId: sessionId,
      provider: input.model.includes("/") ? input.model.split("/", 1)[0] : null,
      model: input.model || null,
      billingType: "unknown",
      costUsd: Number(infoTokens?.cost ?? 0) || null,
      resultJson: {
        transport: "opencode_server",
        providerSessionId: sessionId,
        providerMessageId: messageId,
        messageId,
        userMessageId,
      terminalMessageIds: [messageId],
        serverUrl: managed.url,
        providerVersion: managed.providerVersion,
        ...responseMetadata(parts, summary),
      },
      summary,
      nativeWriterQuiescence: { status: "confirmed", source: "provider_terminal" },
    };
  } catch (error) {
    if (promptSent && !providerAbortSent && !idleObserved) await abortTurn(error, true);
    await providerAbortTask;
    if (promptSent && candidateAssistantMessageIds.size > 0) {
      try {
        const exported = await exportSession({
          command, serverCommand: command, sessionId: sessionId!, cwd, env,
          binding: input.binding, managed, signal: AbortSignal.timeout(PARTIAL_EXPORT_TIMEOUT_MS),
        });
        for (const message of exported.messages) {
          const id = nonEmpty(message.info.id);
          if (id && candidateAssistantMessageIds.has(id) && message.info.role === "assistant"
            && ancestorUserId(exported.messages, id) === userMessageId) observedAssistantMessageIds.add(id);
        }
      } catch {
        // Unverified deltas cannot establish a partial transcript boundary.
      }
    }
    const context = {
      sessionId,
      sessionParams: sessionParamsForResult(),
      submissionPhase: submissionAccepted ? "accepted" as const : promptSent ? "indeterminate" as const : "pre_submission" as const,
      ...(promptSent ? { userMessageId } : {}),
      ...(promptSent && observedAssistantMessageIds.size > 0
        ? { observedAssistantMessageIds: [...observedAssistantMessageIds] }
        : {}),
      ...(providerAbortAcknowledged !== null ? { providerAbortAcknowledged } : {}),
      terminalObserved: terminalResponseObserved,
    };
    const abortDiagnostic = providerAbortAcknowledged === false ? " Provider abort request was not acknowledged." : "";
    if (error instanceof OpenCodeNativeCapabilityError) {
      throw new OpenCodeNativeCapabilityError(
        error.status,
        `${error.message}${abortDiagnostic}`,
        context,
        turnTimedOut || error.timedOut,
        error.source,
        error.nativeFailure,
      );
    }
    throw new OpenCodeNativeCapabilityError(
      "unknown",
      `${safeErrorMessage(error instanceof Error ? error.message : null) ?? "OpenCode native chat failed after session creation."}${abortDiagnostic}`,
      context,
      turnTimedOut,
    );
  } finally {
    if (timeout) clearTimeout(timeout);
    if (idleTimeout) clearTimeout(idleTimeout);
    input.signal?.removeEventListener("abort", onExternalAbort);
    if (!turnController.signal.aborted) turnController.abort(new Error("OpenCode native turn complete"));
    await eventStreamTask?.catch(() => undefined);
    await ((): Promise<void> | null => providerAbortTask)()?.catch(() => undefined);
    await controlLease?.release().catch(() => undefined);
    managed.release();
  }
}

export async function disposeOpenCodeNativeServersForTests(): Promise<void> {
  for (const [key, managed] of managedServers) {
    managedServers.delete(key);
    if (managed.child.exitCode === null) managed.child.kill("SIGTERM");
    if (managed.configPath) await rm(managed.configPath, { force: true }).catch(() => undefined);
  }
}
