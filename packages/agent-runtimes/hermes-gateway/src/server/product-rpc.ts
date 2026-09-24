import type {
  AgentRuntimeApprovalDecision,
  AgentRuntimeApprovalRequest,
  AgentRuntimeControlAttemptLease,
  AgentRuntimeControlHandleLease,
  AgentRuntimeExecutionResult,
} from "@rudderhq/agent-runtime-utils";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { HermesAcpBinding, HermesAcpProfile, HermesAcpWorkspace } from "./native-protocol.js";
import { createHermesNativeRpcClient, hermesNativeRpcErrorCode } from "./native-protocol.js";
import {
  readHermesProductHistory,
  type HermesProductHistoryProfile,
  type HermesProductHistoryResult,
} from "./product-history.js";

export const HERMES_PRODUCT_RPC_TRANSPORT = "hermes-tui-gateway-stdio";
export const HERMES_PRODUCT_RPC_VERIFIED_VERSIONS = ["0.21.0"] as const;

const MAX_EVENTS = 200;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_EVENT_TOTAL_BYTES = 512 * 1024;
const GATEWAY_READY_TIMEOUT_MS = 10_000;
const STOP_RECONCILIATION_MS = 1_500;
const APPROVAL_OPTION_VALUES = new Set(["once", "session", "always", "deny"]);

type JsonRecord = Record<string, unknown>;
type RpcClient = Awaited<ReturnType<typeof createHermesNativeRpcClient>>;
type HermesProductRpcHistoryTail = {
  availability: HermesProductHistoryResult["availability"];
  tailRowId: number | null;
  relation: HermesProductHistoryResult["metadata"]["lineage"]["relation"];
  successorSessionId: string | null;
};
type HermesProductRpcTranscriptBoundary = {
  status: "exact" | "unknown";
  sessionId: string;
  startExclusive: number | null;
  endInclusive: number | null;
  sourceRangeRef: string | null;
  reason?: string;
};
export type HermesProductRpcProfile = HermesAcpProfile & {
  hermesPythonCommand: string;
  hermesSourcePath: string;
  hermesHome: string;
};
type HermesProductRpcEvent = { type: string; payload: JsonRecord; sessionId: string | null };
type ClientFactory = (input: {
  profile: HermesAcpProfile;
  onNotification: (method: string, params: JsonRecord) => void;
  onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
}) => Promise<RpcClient>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeText(value: unknown, secrets: readonly string[], limit = MAX_EVENT_BYTES): string {
  let output = text(value);
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join("[REDACTED]");
  }
  output = output.replace(/((?:["']?[A-Za-z0-9_-]*(?:api[-_]?key|authorization|bearer|credential|password|private[-_]?key|secret|token|value)[A-Za-z0-9_-]*["']?\s*[:=]\s*)(?:bearer\s+)?)(?:"[^"]*"|'[^']*'|[^\s,;}'"]+)/gi, "$1[REDACTED]");
  return output.slice(0, limit);
}

function safeValue(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return safeText(value, secrets);
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => safeValue(entry, secrets, depth + 1));
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(Object.entries(object).slice(0, 100).map(([key, child]) => [
    key,
    /(?:api.?key|authorization|bearer|credential|password|private.?key|secret|token|value)/i.test(key)
      ? "[REDACTED]"
      : safeValue(child, secrets, depth + 1),
  ]));
}

function identityFields(binding: HermesAcpBinding): JsonRecord {
  return {
    profileHostId: binding.hostId,
    profileId: binding.profileId,
    ...(binding.id ? { profileBindingId: binding.id } : {}),
    ...(binding.orgId ? { profileOrgId: binding.orgId } : {}),
    ...(binding.workspaceBindingId ? { workspaceBindingId: binding.workspaceBindingId } : {}),
    ...(binding.capabilityRevision ? { capabilityRevision: binding.capabilityRevision } : {}),
  };
}

export function isHermesProductRpcProfile(value: Partial<HermesProductRpcProfile>): value is HermesProductRpcProfile {
  return Boolean(
    text(value.hermesPythonCommand)
    && text(value.hermesSourcePath)
    && text(value.hermesHome)
    && text(value.binding?.hostId)
    && text(value.binding?.profileId),
  );
}

export function hermesProductRpcProfileEvidence(profile: Partial<HermesProductRpcProfile>): {
  status: "supported" | "unknown";
  reason: string;
} {
  if (!isHermesProductRpcProfile(profile)) {
    return { status: "unknown", reason: "Hermes Product Gateway requires a host-authorized Python, source, HERMES_HOME, and host/profile binding." };
  }
  if (![profile.hermesPythonCommand, profile.hermesSourcePath, profile.hermesHome].every((value) => path.isAbsolute(value))) {
    return { status: "unknown", reason: "Hermes Product Gateway paths must be absolute host-authorized paths." };
  }
  if (!HERMES_PRODUCT_RPC_VERIFIED_VERSIONS.includes(profile.providerVersion as (typeof HERMES_PRODUCT_RPC_VERIFIED_VERSIONS)[number])) {
    return {
      status: "unknown",
      reason: `Hermes Product Gateway contracts are verified only for ${HERMES_PRODUCT_RPC_VERIFIED_VERSIONS.join(", ")}; profile version ${profile.providerVersion ?? "unknown"} is unverified.`,
    };
  }
  return {
    status: "supported",
    reason: `Hermes ${profile.providerVersion} exposes the installed TUI Gateway stdio RPC used for explicit session create/resume, prompt submission, redirect, interrupt, and human-request responses.`,
  };
}

export function buildHermesProductRpcSessionParams(input: {
  sessionId: string;
  profile: HermesProductRpcProfile;
  workspace?: HermesAcpWorkspace | null;
}): JsonRecord {
  return {
    sessionId: input.sessionId,
    hermesSessionId: input.sessionId,
    transport: HERMES_PRODUCT_RPC_TRANSPORT,
    hermesProviderVersion: input.profile.providerVersion ?? null,
    hermesPythonCommand: path.resolve(input.profile.hermesPythonCommand),
    hermesSourcePath: path.resolve(input.profile.hermesSourcePath),
    hermesHome: path.resolve(input.profile.hermesHome),
    cwd: path.resolve(input.profile.cwd),
    ...identityFields(input.profile.binding),
    ...(input.workspace?.workspaceId ? { workspaceId: input.workspace.workspaceId } : {}),
    ...(input.workspace?.repoUrl ? { repoUrl: input.workspace.repoUrl } : {}),
    ...(input.workspace?.repoRef ? { repoRef: input.workspace.repoRef } : {}),
    ...(input.workspace?.workspaceBindingId ? { workspaceBindingId: input.workspace.workspaceBindingId } : {}),
  };
}

export function validateHermesProductRpcSession(input: {
  sessionId: string;
  sessionParams: JsonRecord;
  profile: HermesProductRpcProfile;
  workspace?: HermesAcpWorkspace | null;
}): string | null {
  const params = input.sessionParams;
  if (text(params.transport) !== HERMES_PRODUCT_RPC_TRANSPORT) return "Hermes persisted session transport is not the Product Gateway.";
  if (text(params.hermesSessionId ?? params.sessionId) !== input.sessionId) return "Hermes Product Gateway session identity does not match the requested session.";
  const identities: Array<[string, unknown, unknown]> = [
    ["host", params.profileHostId, input.profile.binding.hostId],
    ["profile", params.profileId, input.profile.binding.profileId],
    ["profile binding", params.profileBindingId, input.profile.binding.id],
    ["organization", params.profileOrgId, input.profile.binding.orgId],
    ["workspace binding", params.workspaceBindingId, input.profile.binding.workspaceBindingId],
    ["capability revision", params.capabilityRevision, input.profile.binding.capabilityRevision],
    ["provider version", params.hermesProviderVersion, input.profile.providerVersion],
    ["Python interpreter", params.hermesPythonCommand, path.resolve(input.profile.hermesPythonCommand)],
    ["source path", params.hermesSourcePath, path.resolve(input.profile.hermesSourcePath)],
    ["HERMES_HOME", params.hermesHome, path.resolve(input.profile.hermesHome)],
  ];
  for (const [label, stored, expected] of identities) {
    if (expected !== null && expected !== undefined && text(stored) !== String(expected)) return `Hermes Product Gateway session ${label} does not match the authorized provider profile.`;
    if ((expected === null || expected === undefined) && text(stored)) return `Hermes Product Gateway profile is missing the persisted ${label} identity.`;
  }
  if (input.workspace) {
    for (const key of ["workspaceId", "repoUrl", "repoRef", "workspaceBindingId"] as const) {
      const expected = text(input.workspace[key]);
      const stored = text(params[key]);
      if (expected && stored !== expected) return `Hermes Product Gateway session ${key} does not match the current workspace.`;
      if (!expected && stored) return `Hermes Product Gateway current workspace is missing persisted ${key}.`;
    }
  }
  return null;
}

function rpcProfile(profile: HermesProductRpcProfile): HermesAcpProfile {
  return {
    ...profile,
    command: profile.hermesPythonCommand,
    args: ["-m", "tui_gateway.entry"],
    env: {
      ...(profile.env ?? {}),
      HERMES_HOME: path.resolve(profile.hermesHome),
      PYTHONPATH: [path.resolve(profile.hermesSourcePath), profile.env?.PYTHONPATH].filter(Boolean).join(path.delimiter),
    },
  };
}

async function validateLaunchProfile(profile: HermesProductRpcProfile): Promise<void> {
  for (const [label, value] of [
    ["Hermes Python interpreter", profile.hermesPythonCommand],
    ["Hermes source path", profile.hermesSourcePath],
    ["Hermes HERMES_HOME", profile.hermesHome],
    ["Hermes Product Gateway cwd", profile.cwd],
  ] as const) {
    if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute host-authorized path.`);
  }
  const [python, source, entry] = await Promise.all([
    fs.stat(profile.hermesPythonCommand),
    fs.stat(profile.hermesSourcePath),
    fs.stat(path.join(profile.hermesSourcePath, "tui_gateway", "entry.py")),
  ]);
  if (!python.isFile() || !source.isDirectory() || !entry.isFile()) {
    throw new Error("The authorized Hermes installation does not contain the Python interpreter and tui_gateway.entry module.");
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function waitForApprovalOrAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | "aborted"> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve("aborted");
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), Math.max(1, timeoutMs)); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function providerVersionSupported(profile: HermesProductRpcProfile): boolean {
  return HERMES_PRODUCT_RPC_VERIFIED_VERSIONS.includes(profile.providerVersion as (typeof HERMES_PRODUCT_RPC_VERIFIED_VERSIONS)[number]);
}

function historyProfile(profile: HermesProductRpcProfile): HermesProductHistoryProfile | null {
  const pythonCommand = text(profile.hermesPythonCommand);
  const sourcePath = text(profile.hermesSourcePath);
  const hermesHome = text(profile.hermesHome);
  if (![pythonCommand, sourcePath, hermesHome].every((value) => value && path.isAbsolute(value))) return null;
  return {
    pythonCommand,
    sourcePath,
    hermesHome,
    providerVersion: profile.providerVersion ?? null,
    hostId: profile.binding.hostId,
    profileId: profile.binding.profileId,
  };
}

async function readProductRpcHistoryTail(
  profile: HermesProductRpcProfile,
  sessionId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<HermesProductRpcHistoryTail | null> {
  const authorizedProfile = historyProfile(profile);
  if (!authorizedProfile) return null;
  try {
    const result = await readHermesProductHistory({
      runtimeType: "hermes_gateway",
      sessionId,
      profile: authorizedProfile,
      limit: 1,
      timeoutMs: Math.min(timeoutMs, 60_000),
      signal,
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

function unknownTranscriptBoundary(sessionId: string, reason: string): HermesProductRpcTranscriptBoundary {
  return { status: "unknown", sessionId, startExclusive: null, endInclusive: null, sourceRangeRef: null, reason };
}

export function deriveHermesProductRpcTranscriptBoundary(input: {
  sessionId: string;
  historyProfileAvailable: boolean;
  before: HermesProductRpcHistoryTail | null;
  after: HermesProductRpcHistoryTail | null;
}): HermesProductRpcTranscriptBoundary {
  if (!input.historyProfileAvailable) return unknownTranscriptBoundary(input.sessionId, "Hermes host history profile is unavailable.");
  if (!input.before || input.before.availability !== "available") {
    return unknownTranscriptBoundary(input.sessionId, "Hermes persisted history tail could not be read before the Product Gateway prompt.");
  }
  if (!input.after || input.after.availability !== "available") {
    return unknownTranscriptBoundary(input.sessionId, "Hermes persisted history tail could not be read after the Product Gateway prompt.");
  }
  if (input.before.relation !== "none" || input.after.relation !== "none") {
    return unknownTranscriptBoundary(
      input.sessionId,
      `Hermes compression/session successor prevents proving one Run range (${input.after.successorSessionId ?? "unknown successor"}).`,
    );
  }
  const startExclusive = input.before.tailRowId;
  const endInclusive = input.after.tailRowId;
  if (endInclusive === null || (startExclusive !== null && endInclusive <= startExclusive)) {
    return unknownTranscriptBoundary(input.sessionId, "Hermes Product Gateway prompt produced no provable persisted message interval.");
  }
  const sourceRangeRef = JSON.stringify({ version: 1, status: "exact", sessionId: input.sessionId, startExclusive, endInclusive });
  return { status: "exact", sessionId: input.sessionId, startExclusive, endInclusive, sourceRangeRef };
}

function parseGatewayEvent(method: string, params: JsonRecord): HermesProductRpcEvent | null {
  if (method !== "event") return null;
  const type = text(params.type);
  if (!type) return null;
  return {
    type,
    payload: record(params.payload) ?? {},
    sessionId: text(params.session_id ?? params.sessionId) || null,
  };
}

function finiteTokenCount(value: unknown): number | null {
  const count = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function usageFrom(value: unknown): { inputTokens: number; outputTokens: number; cachedInputTokens?: number } | undefined {
  const usage = record(value);
  if (!usage) return undefined;
  const inputTokens = finiteTokenCount(usage.inputTokens ?? usage.input_tokens ?? usage.input);
  const outputTokens = finiteTokenCount(usage.outputTokens ?? usage.output_tokens ?? usage.output);
  if (inputTokens === null && outputTokens === null) return undefined;
  const cachedInputTokens = finiteTokenCount(usage.cachedInputTokens ?? usage.cached_input_tokens ?? usage.cached_read_tokens);
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
  };
}

function selectedAnswer(decision: AgentRuntimeApprovalDecision, questionId: string, options: Map<string, string>): string | null {
  const answer = decision.inputResponse?.answers.find((entry) => entry.questionId === questionId);
  if (!answer) return null;
  if (answer.optionIds.length === 1) return options.get(answer.optionIds[0]) ?? null;
  if (answer.optionIds.length > 1) {
    const values = answer.optionIds.map((id) => options.get(id)).filter((value): value is string => Boolean(value));
    return values.length === answer.optionIds.length ? values.join(", ") : null;
  }
  return text(answer.freeformText) || null;
}

type ExecuteInput = {
  profile: HermesProductRpcProfile;
  sessionId: string | null;
  sessionParams: JsonRecord | null;
  workspace?: HermesAcpWorkspace | null;
  prompt: string;
  model?: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
  controlAttempt?: AgentRuntimeControlAttemptLease;
  requestApproval?: (request: AgentRuntimeApprovalRequest) => Promise<{ id: string; status: string }>;
  waitForApproval?: (id: string, timeoutMs: number) => Promise<AgentRuntimeApprovalDecision>;
  onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  secrets?: readonly string[];
  createClient?: ClientFactory;
  readHistoryTail?: typeof readProductRpcHistoryTail;
};

export async function executeHermesProductRpcChat(input: ExecuteInput): Promise<AgentRuntimeExecutionResult> {
  const profile = input.profile;
  const secrets = input.secrets ?? [];
  let sessionId = input.sessionId;
  let sessionParams = input.sessionParams;
  let historyBefore: HermesProductRpcHistoryTail | null = null;
  let client: RpcClient | null = null;
  let controlLease: AgentRuntimeControlHandleLease | null = null;
  let promptSubmitted = false;
  let promptSubmissionStarted = false;
  let stopRequested = false;
  let interruptAttempted = false;
  let interruptRequest: Promise<JsonRecord | null> | null = null;
  let interactionError: string | null = null;
  let secretRequestObserved = false;
  let approvalError: string | null = null;
  let eventBytes = 0;
  let eventsTruncated = false;
  const events: JsonRecord[] = [];
  const eventSequence: HermesProductRpcEvent[] = [];
  const interactionTasks = new Set<Promise<void>>();
  const gatewayReady = deferred<void>();
  const turnSettled = deferred<{ payload: JsonRecord; status: string }>();
  let selectedSessionId: string | null = null;
  let gatewaySessionId: string | null = null;
  let submittedAtSequence = 0;
  let queuedSubmit = false;
  let promptAccepted = false;
  let turnSettledObserved = false;
  let lastComplete: JsonRecord | null = null;
  let modelFromSession: string | null = null;

  const logEvent = async (kind: string, payload: JsonRecord) => {
    const safe = record(safeValue(payload, secrets)) ?? {};
    const serialized = JSON.stringify({ type: "hermes_product_rpc_event", event: kind, payload: safe });
    if (serialized.length > MAX_EVENT_BYTES || events.length >= MAX_EVENTS || eventBytes + serialized.length > MAX_EVENT_TOTAL_BYTES) {
      eventsTruncated = true;
      return;
    }
    events.push({ event: kind, payload: safe });
    eventBytes += serialized.length;
    await input.onLog("stdout", `${serialized}\n`);
  };

  const request = async (method: string, params: JsonRecord, requestTimeout = input.timeoutMs) => {
    if (!client) throw new Error("Hermes Product Gateway is not connected.");
    return client.request(method, params, Math.max(1, requestTimeout));
  };

  const interruptSession = (): Promise<JsonRecord | null> => {
    interruptAttempted = true;
    if (!interruptRequest) {
      interruptRequest = request("session.interrupt", { session_id: gatewaySessionId }, Math.min(input.timeoutMs, 10_000))
        .then((value) => {
          const response = record(value);
          if (text(response?.status) === "interrupted") stopRequested = true;
          return response;
        })
        .catch(() => null);
    }
    return interruptRequest;
  };

  const sendCancelSensitiveInput = async (event: HermesProductRpcEvent) => {
    secretRequestObserved = true;
    const requestId = text(event.payload.request_id ?? event.payload.requestId);
    const method = event.type === "secret.request" ? "secret.respond" : "sudo.respond";
    if (requestId) {
      const params = event.type === "secret.request"
        ? { request_id: requestId, value: "" }
        : { request_id: requestId, password: "" };
      await request(method, params, Math.min(input.timeoutMs, 5_000));
    }
    await logEvent(event.type, { requestId: requestId || null, status: "cancelled", reason: "ephemeral_secret_input_unavailable" });
  };

  const respondApproval = async (event: HermesProductRpcEvent) => {
    const requestId = text(event.payload.request_id ?? event.payload.requestId);
    if (!requestId) {
      approvalError ??= "Hermes approval event omitted its request ID.";
      return;
    }
    const rawChoices = Array.isArray(event.payload.choices) ? event.payload.choices : ["once", "session", "always", "deny"];
    const choices = rawChoices.map(text).filter((choice) => APPROVAL_OPTION_VALUES.has(choice));
    const choiceOptions = choices.map((choice, index) => ({ id: `hermes_choice_${index + 1}`, label: choice === "once" ? "Allow once" : choice === "session" ? "Allow this session" : choice === "always" ? "Always allow" : "Deny" }));
    const optionValues = new Map(choiceOptions.map((option, index) => [option.id, choices[index]! ]));
    const safeDescription = safeText(event.payload.description ?? "Hermes requests permission.", secrets, 500);
    const safeCommand = safeText(event.payload.command, secrets, 1_000);
    await logEvent(event.type, { requestId, status: "requested", description: safeDescription, command: safeCommand || null, choices });
    let selected = "deny";
    try {
      if (input.requestApproval && input.waitForApproval && choiceOptions.length > 0 && !input.signal?.aborted) {
        const questionId = "hermes_product_approval";
        const approval = await input.requestApproval({
          type: "agent_runtime",
          payload: {
            provider: "hermes",
            runtimeType: "hermes_gateway",
            protocol: "native_product_rpc",
            sessionId: selectedSessionId,
            requestId,
            interactionKind: "permission",
            description: safeDescription,
            command: safeCommand || null,
            choices,
          },
          inputRequest: {
            questions: [{
              id: questionId,
              header: "Hermes",
              question: safeDescription,
              options: choiceOptions,
              selectionMode: "single",
            }],
          },
        });
        const decision = approval.status === "rejected" || approval.status === "cancelled"
          ? null
          : await waitForApprovalOrAbort(input.waitForApproval(approval.id, Math.max(1, input.timeoutMs)), input.signal);
        if (decision && decision !== "aborted" && decision.id === approval.id && decision.status === "approved") {
          selected = selectedAnswer(decision, questionId, optionValues) ?? "deny";
        }
      }
    } catch {
      approvalError ??= "Hermes approval could not be resolved through Rudder.";
    }
    await request("approval.respond", { session_id: selectedSessionId, request_id: requestId, choice: selected }, Math.min(input.timeoutMs, 5_000));
    await logEvent(event.type, { requestId, status: selected === "deny" ? "denied" : "resolved", choice: selected });
  };

  const respondClarify = async (event: HermesProductRpcEvent) => {
    const requestId = text(event.payload.request_id ?? event.payload.requestId);
    if (!requestId) {
      interactionError ??= "Hermes clarification event omitted its request ID.";
      return;
    }
    const questions = Array.isArray(event.payload.questions)
      ? event.payload.questions.map(record).filter((value): value is JsonRecord => Boolean(value))
      : [];
    const rawChoices = (value: unknown): string[] => Array.isArray(value) ? value.map(text).filter(Boolean).slice(0, 12) : [];
    const questionRows = questions.length > 0
      ? questions
      : [{ qid: "hermes_question", question: event.payload.question, choices: event.payload.choices }];
    const choiceMaps = new Map<string, Map<string, string>>();
    const inputQuestions = questionRows.slice(0, 12).map((question, index) => {
      const questionId = `hermes_clarify_${index + 1}`;
      const choices = rawChoices(question.choices);
      const options = choices.map((label, optionIndex) => ({ id: `${questionId}_option_${optionIndex + 1}`, label: safeText(label, secrets, 120) }));
      choiceMaps.set(questionId, new Map(options.map((option, optionIndex) => [option.id, choices[optionIndex]!])));
      return {
        id: questionId,
        providerQuestionId: text(question.qid) || "hermes_question",
        question: safeText(question.question, secrets, 500),
        options,
        multiSelect: question.multi_select === true,
      };
    });
    await logEvent(event.type, {
      requestId,
      status: "requested",
      questions: inputQuestions.map(({ id, question, options }) => ({ id, question, optionCount: options.length })),
    });
    let answers: Array<{ questionId: string; value: string }> = [];
    try {
      if (input.requestApproval && input.waitForApproval && !input.signal?.aborted) {
        const approval = await input.requestApproval({
          type: "agent_runtime",
          payload: {
            provider: "hermes",
            runtimeType: "hermes_gateway",
            protocol: "native_product_rpc",
            sessionId: selectedSessionId,
            requestId,
            interactionKind: "clarify",
          },
          inputRequest: {
            questions: inputQuestions.map(({ id, question, options }) => ({
              id,
              header: "Hermes",
              question,
              options,
              selectionMode: inputQuestions.find((entry) => entry.id === id)?.multiSelect ? "multiple" : "single",
              allowFreeform: true,
            })),
          },
        });
        const decision = approval.status === "rejected" || approval.status === "cancelled"
          ? null
          : await waitForApprovalOrAbort(input.waitForApproval(approval.id, Math.max(1, input.timeoutMs)), input.signal);
        if (decision && decision !== "aborted" && decision.id === approval.id && decision.status === "approved") {
          answers = inputQuestions.flatMap(({ id, providerQuestionId }) => {
            const value = selectedAnswer(decision, id, choiceMaps.get(id) ?? new Map());
            return value === null ? [] : [{ questionId: providerQuestionId, value: safeText(value, secrets, 2_000) }];
          });
        }
      }
    } catch {
      interactionError ??= "Hermes clarification could not be resolved through Rudder.";
    }
    if (answers.length === 0 || (questions.length > 0 && answers.length !== inputQuestions.length)) {
      await request("clarify.respond", { session_id: selectedSessionId, request_id: requestId, answer: "" }, Math.min(input.timeoutMs, 5_000));
      await logEvent(event.type, { requestId, status: "cancelled" });
      return;
    }
    if (questions.length > 0) {
      for (const answer of answers) {
        await request("clarify.respond", {
          session_id: selectedSessionId,
          request_id: requestId,
          question_id: answer.questionId,
          answer: answer.value,
        }, Math.min(input.timeoutMs, 5_000));
      }
    } else {
      await request("clarify.respond", { session_id: selectedSessionId, request_id: requestId, answer: answers[0]!.value }, Math.min(input.timeoutMs, 5_000));
    }
    await logEvent(event.type, { requestId, status: "resolved", answerCount: answers.length });
  };

  const handleEvent = (event: HermesProductRpcEvent) => {
    if (event.type === "gateway.ready") {
      gatewayReady.resolve(undefined);
      return;
    }
    if (!selectedSessionId || event.sessionId !== selectedSessionId) return;
    if (["message.start", "message.complete", "session.info"].includes(event.type) && eventSequence.length < 1_000) eventSequence.push(event);
    if (event.type === "secret.request" || event.type === "sudo.request") {
      const task = sendCancelSensitiveInput(event).catch(() => {
        interactionError ??= "Hermes sensitive input request could not be cancelled.";
      });
      interactionTasks.add(task);
      void task.finally(() => interactionTasks.delete(task));
      return;
    }
    if (event.type === "approval.request") {
      const task = respondApproval(event).catch(() => {
        approvalError ??= "Hermes approval response failed.";
      });
      interactionTasks.add(task);
      void task.finally(() => interactionTasks.delete(task));
      return;
    }
    if (event.type === "clarify.request") {
      const task = respondClarify(event).catch(() => {
        interactionError ??= "Hermes clarification response failed.";
      });
      interactionTasks.add(task);
      void task.finally(() => interactionTasks.delete(task));
      return;
    }
    if (event.type.endsWith(".expire")) {
      void logEvent(event.type, { requestId: text(event.payload.request_id) || null, status: "expired" }).catch(() => {});
      return;
    }
    if (event.type === "message.complete") {
      lastComplete = event.payload;
      maybeSettleTurn();
      void logEvent(event.type, event.payload).catch(() => {});
    } else if (event.type === "session.info" && event.payload.running === false) {
      modelFromSession = text(event.payload.model) || modelFromSession;
      maybeSettleTurn();
      void logEvent(event.type, { running: false, model: safeText(event.payload.model, secrets, 120), provider: safeText(event.payload.provider, secrets, 120) }).catch(() => {});
    } else if (event.type === "error") {
      interactionError ??= safeText(event.payload.message, secrets, 1_000) || "Hermes Product Gateway reported an error.";
      void logEvent(event.type, { message: interactionError }).catch(() => {});
    } else {
      void logEvent(event.type, event.payload).catch(() => {});
    }
  };

  function maybeSettleTurn() {
    if (!promptAccepted || !lastComplete) return;
    const relevant = eventSequence.slice(submittedAtSequence);
    let startAfter = -1;
    if (queuedSubmit) {
      const priorComplete = relevant.findIndex((event) => event.type === "message.complete");
      if (priorComplete < 0) return;
      const nextStart = relevant.findIndex((event, index) => index > priorComplete && event.type === "message.start");
      if (nextStart < 0) return;
      startAfter = nextStart;
    } else {
      startAfter = relevant.findIndex((event) => event.type === "message.start");
      if (startAfter < 0) return;
    }
    const completeIndex = relevant.findIndex((event, index) => index > startAfter && event.type === "message.complete");
    if (completeIndex < 0) return;
    const idleAfter = relevant.slice(completeIndex + 1).some((event) => event.type === "session.info" && event.payload.running === false);
    if (idleAfter) {
      turnSettledObserved = true;
      turnSettled.resolve({ payload: lastComplete, status: text(lastComplete.status) || "unknown" });
    }
  }

  const createClient = input.createClient ?? (async (args) => createHermesNativeRpcClient(
    args.profile,
    args.onNotification,
    async () => ({}),
    args.onSpawn,
  ));
  const readHistoryTail = input.readHistoryTail ?? readProductRpcHistoryTail;
  const readBoundary = async (): Promise<HermesProductRpcTranscriptBoundary> => {
    if (!sessionId) return unknownTranscriptBoundary("", "Hermes Product Gateway did not establish a native session.");
    const after = await readHistoryTail(profile, sessionId, input.timeoutMs, input.signal).catch(() => null);
    return deriveHermesProductRpcTranscriptBoundary({
      sessionId,
      historyProfileAvailable: historyProfile(profile) !== null,
      before: historyBefore,
      after,
    });
  };

  try {
    if (!providerVersionSupported(profile)) {
      throw new Error(hermesProductRpcProfileEvidence(profile).reason);
    }
    await validateLaunchProfile(profile);
    if (sessionId) {
      if (!sessionParams) throw new Error("Hermes Product Gateway resume requires persisted native session identity.");
      const rejection = validateHermesProductRpcSession({ sessionId, sessionParams, profile, workspace: input.workspace });
      if (rejection) throw new Error(rejection);
    }
    if (input.signal?.aborted) throw new Error("Hermes Product Gateway execution was cancelled before session submission.");

    const launchProfile = rpcProfile(profile);
    client = await createClient({
      profile: launchProfile,
      onNotification: (method, params) => {
        const event = parseGatewayEvent(method, params);
        if (event) handleEvent(event);
      },
      onSpawn: input.onSpawn,
    });
    await withTimeout(gatewayReady.promise, Math.min(input.timeoutMs, GATEWAY_READY_TIMEOUT_MS), "Hermes Product Gateway did not emit gateway.ready.");
    const ping = record(await client.request("ping", {}, Math.min(input.timeoutMs, 5_000)));
    if (ping?.pong !== true) throw new Error("Hermes Product Gateway ping did not confirm the installed RPC service.");
    const capabilities = record(await client.request("gateway.capabilities", {}, Math.min(input.timeoutMs, 5_000)));
    if (!capabilities || typeof capabilities.per_session_exclusive_submit !== "boolean") {
      throw new Error("Hermes Product Gateway capabilities did not match the verified installed contract.");
    }

    if (sessionId) {
      const resumed = record(await client.request("session.resume", { session_id: sessionId, lazy: true }, input.timeoutMs));
      gatewaySessionId = text(resumed?.session_id);
      const resumedSessionKey = text(resumed?.session_key ?? resumed?.stored_session_id);
      if (!resumed || !gatewaySessionId || resumedSessionKey !== sessionId || resumed.error) {
        throw new Error("Hermes Product Gateway did not resume the explicitly bound native session.");
      }
      if (resumed.auto_continue) {
        stopRequested = true;
        await client.request("session.interrupt", { session_id: gatewaySessionId }, Math.min(input.timeoutMs, 5_000)).catch(() => {});
        throw new Error("Hermes Product Gateway scheduled an automatic continuation while resuming; the session was interrupted and no new input was submitted.");
      }
      if (typeof resumed.running !== "boolean") {
        throw new Error("Hermes Product Gateway session.resume did not report the session running state.");
      }
      if (resumed.running) throw new Error("Hermes Product Gateway session is already running; refusing to attach a second input owner.");
    } else {
      const created = record(await client.request("session.create", {
        cwd: profile.cwd,
        ...(text(input.model) ? { model: text(input.model) } : {}),
      }, input.timeoutMs));
      gatewaySessionId = text(created?.session_id ?? created?.sessionId);
      const storedSessionId = text(created?.stored_session_id ?? created?.session_key);
      if (!gatewaySessionId) throw new Error("Hermes Product Gateway session.create returned no native session_id.");
      if (!storedSessionId) throw new Error("Hermes Product Gateway session.create returned no persisted stored_session_id.");
      sessionId = storedSessionId;
      sessionParams = buildHermesProductRpcSessionParams({ sessionId, profile, workspace: input.workspace });
    }
    selectedSessionId = gatewaySessionId;
    if (!sessionId) throw new Error("Hermes Product Gateway has no persisted session ID for this turn.");
    const controlSessionId = sessionId;
    sessionParams ??= buildHermesProductRpcSessionParams({ sessionId, profile, workspace: input.workspace });
    historyBefore = await readHistoryTail(profile, sessionId, input.timeoutMs, input.signal).catch(() => null);

    const turnId = randomUUID();
    let controlActive = true;
    if (input.controlAttempt) {
      controlLease = await input.controlAttempt.register({
        runtimeType: "hermes_gateway",
        providerThreadId: controlSessionId,
        providerTurnId: turnId,
        capabilities: { steer: "native", interrupt: "native" },
        async steer(controlInput) {
          if (!controlActive || !client || !gatewaySessionId) return { disposition: "closing", reason: "Hermes Product Gateway turn is closed." };
          if (controlInput.media?.length) return { disposition: "unsupported", reason: "Hermes Product Gateway session.redirect does not accept media attachments." };
          try {
            const response = record(await client.request("session.redirect", { session_id: gatewaySessionId, text: controlInput.text }, Math.min(input.timeoutMs, 10_000)));
            if (response?.status === "redirected") {
              return { disposition: "accepted_current", providerThreadId: controlSessionId, providerTurnId: turnId };
            }
            return { disposition: "unsupported", reason: "Hermes Product Gateway did not confirm session.redirect for the active turn." };
          } catch (error) {
            const rpcCode = hermesNativeRpcErrorCode(error);
            return rpcCode === 4010 || rpcCode === -32601
              ? { disposition: "unsupported", reason: "The installed Hermes Product Gateway does not support active-turn redirect for this model/session." }
              : { disposition: "acceptance_unknown", providerThreadId: controlSessionId, providerTurnId: turnId, reason: "Hermes Product Gateway session.redirect acknowledgement was not received." };
          }
        },
        async interrupt() {
          if (!controlActive || !client || !gatewaySessionId) return "unverified";
          const response = await interruptSession();
          if (text(response?.status) === "interrupted") return "waiting_safe_boundary";
          if (text(response?.status) === "not_interrupted") return "acknowledged";
          return "unverified";
        },
        async dispose() { controlActive = false; },
      });
    }

    const abortHandler = () => {
      if (!client || !gatewaySessionId || !promptSubmissionStarted) return;
      void interruptSession();
    };
    input.signal?.addEventListener("abort", abortHandler, { once: true });
    try {
      submittedAtSequence = eventSequence.length;
      promptSubmissionStarted = true;
      const accepted = record(await client.request("prompt.submit", {
        session_id: gatewaySessionId,
        text: input.prompt,
        queued: true,
      }, input.timeoutMs));
      promptSubmitted = true;
      if (!accepted || !["streaming", "queued"].includes(text(accepted.status))) {
        throw new Error(`Hermes Product Gateway prompt.submit returned unexpected status ${text(accepted?.status) || "unknown"}.`);
      }
      queuedSubmit = accepted.status === "queued";
      promptAccepted = true;
      maybeSettleTurn();
      const terminalResult = await withTimeout(
        waitForApprovalOrAbort(turnSettled.promise, input.signal),
        input.timeoutMs,
        "Hermes Product Gateway turn did not reach a terminal message.complete and settled session.info.",
      );
      let terminal: { payload: JsonRecord; status: string };
      if (terminalResult === "aborted") {
        await interruptSession();
        const settledAfterInterrupt = await Promise.race([
          turnSettled.promise.then((value) => ({ value, settled: true as const })),
          new Promise<{ settled: false }>((resolve) => setTimeout(() => resolve({ settled: false }), STOP_RECONCILIATION_MS)),
        ]);
        if (!settledAfterInterrupt.settled) {
          const transcriptBoundary = unknownTranscriptBoundary(sessionId, "Hermes Product Gateway stop did not reach a settled terminal turn.");
          return {
            exitCode: 1,
            signal: "SIGTERM",
            timedOut: false,
            errorCode: "hermes_product_rpc_cancel_unverified",
            errorMessage: "Hermes stop was requested but terminal state was not verified.",
            ...(sessionId ? { sessionId, sessionDisplayId: sessionId } : {}),
            ...(sessionParams ? { sessionParams } : {}),
            resultJson: {
              nativeSession: true,
              transport: HERMES_PRODUCT_RPC_TRANSPORT,
              sessionId,
              transcriptBoundary,
              backend: "native_product_rpc",
              control: { interruptRequested: interruptAttempted, stopConfirmed: stopRequested },
              eventCount: events.length,
            },
          };
        }
        terminal = settledAfterInterrupt.value;
      } else {
        terminal = terminalResult;
      }
      if (interactionTasks.size > 0) await Promise.allSettled([...interactionTasks]);
      const transcriptBoundary = await readBoundary();
      const output = safeText(terminal.payload.text, secrets, MAX_EVENT_TOTAL_BYTES);
      const providerStatus = text(terminal.payload.status) || terminal.status;
      const terminalError = safeText(terminal.payload.error ?? terminal.payload.failure_reason, secrets, 1_000);
      const providerCompleted = providerStatus === "complete" || providerStatus === "settled";
      const outputPresent = Boolean(output.trim());
      const transcriptBoundaryExact = transcriptBoundary.status === "exact";
      const completed = providerCompleted && outputPresent && transcriptBoundaryExact;
      const cancelled = providerStatus === "interrupted" || interruptAttempted || input.signal?.aborted;
      const resultJson: JsonRecord = {
        nativeSession: true,
        transport: HERMES_PRODUCT_RPC_TRANSPORT,
        sessionId,
        transcriptBoundary,
        backend: "native_product_rpc",
        providerStatus,
        eventCount: events.length,
        events,
        ...(eventsTruncated ? { eventsTruncated: true } : {}),
        control: { interruptRequested: interruptAttempted, stopConfirmed: stopRequested },
        interactions: {
          sensitiveInputCancelled: secretRequestObserved,
          clarificationError: interactionError,
          approvalError,
        },
      };
      await controlLease?.release();
      controlLease = null;
      return {
        exitCode: completed && !cancelled && !interactionError && !approvalError && !secretRequestObserved ? 0 : 1,
        signal: cancelled ? "SIGTERM" : null,
        timedOut: false,
        sessionId,
        sessionParams,
        sessionDisplayId: sessionId,
        provider: "hermes",
        model: text(terminal.payload.model) || modelFromSession || text(input.model) || null,
        ...(usageFrom(terminal.payload.usage) ? { usage: usageFrom(terminal.payload.usage) } : {}),
        ...(output ? { summary: output } : {}),
        resultJson,
        ...(!completed || cancelled || interactionError || approvalError || secretRequestObserved ? {
          errorCode: secretRequestObserved
            ? "hermes_product_rpc_sensitive_input_unavailable"
            : approvalError
              ? "hermes_product_rpc_approval_unresolved"
              : interactionError
                ? "hermes_product_rpc_interaction_unresolved"
                : cancelled
                  ? "hermes_product_rpc_interrupted"
                  : !providerCompleted
                    ? "hermes_product_rpc_turn_failed"
                    : !outputPresent
                      ? "hermes_product_rpc_empty_output"
                      : "hermes_product_rpc_transcript_boundary_unknown",
          errorMessage: secretRequestObserved
            ? "Hermes requested sudo or secret input, but Rudder has no non-persistent secret-response channel; the provider request was cancelled."
            : approvalError ?? interactionError ?? terminalError ?? (cancelled
              ? stopRequested || providerStatus === "interrupted"
                ? "Hermes Product Gateway turn was interrupted."
                : "Hermes Product Gateway stop was requested before the turn completed."
              : !providerCompleted
                ? `Hermes Product Gateway turn ended with ${providerStatus}.`
                : !outputPresent
                  ? "Hermes Product Gateway completed without assistant text."
                  : transcriptBoundary.reason ?? "Hermes Product Gateway transcript boundary could not be verified."),
        } : {}),
      };
    } finally {
      input.signal?.removeEventListener("abort", abortHandler);
      controlLease?.release().catch(() => {});
      controlLease = null;
    }
  } catch (error) {
    const message = safeText(error instanceof Error ? error.message : String(error), secrets, 2_000);
    const timedOut = /timed out|timeout/iu.test(message);
    const observedTurnStart = eventSequence.slice(submittedAtSequence).some((event) => event.type === "message.start");
    if (promptSubmissionStarted && observedTurnStart && sessionId && client && !stopRequested) {
      stopRequested = true;
      await interruptSession();
      await Promise.race([turnSettled.promise, new Promise((resolve) => setTimeout(resolve, STOP_RECONCILIATION_MS))]);
    }
    const cancelUnverified = interruptAttempted && !turnSettledObserved;
    await controlLease?.release().catch(() => {});
    const transcriptBoundary = promptSubmissionStarted && turnSettledObserved
      ? await readBoundary()
      : unknownTranscriptBoundary(sessionId ?? "", "Hermes Product Gateway turn did not produce settled terminal evidence.");
    return {
      exitCode: 1,
      signal: stopRequested ? "SIGTERM" : null,
      timedOut,
      submissionPhase: promptSubmitted ? "accepted" : promptSubmissionStarted ? "indeterminate" : "pre_submission",
      errorMessage: cancelUnverified ? "Hermes stop was requested but terminal state was not verified." : message,
      errorCode: cancelUnverified ? "hermes_product_rpc_cancel_unverified" : timedOut ? "hermes_product_rpc_timeout" : "hermes_product_rpc_failed",
      ...(sessionId ? { sessionId, sessionDisplayId: sessionId } : {}),
      ...(sessionParams ? { sessionParams } : {}),
      resultJson: {
        nativeSession: true,
        transport: HERMES_PRODUCT_RPC_TRANSPORT,
        sessionId,
        transcriptBoundary,
        backend: "native_product_rpc",
        control: { interruptRequested: interruptAttempted, stopConfirmed: stopRequested },
        eventCount: events.length,
      },
    };
  } finally {
    await client?.close().catch(() => {});
  }
}
