import type {
  AgentRuntimeControlHandle,
  AgentRuntimeControlInterruptReason,
  AgentRuntimeControlInterruptResult,
  AgentRuntimeControlSteerInput,
  AgentRuntimeControlSteerResult,
  AgentRuntimeExecutionContext,
  ChatAskUserRequest,
  ChatAskUserResponse,
} from "@rudderhq/agent-runtime-utils";
import {
  chatAskUserRequestSchema,
  chatAskUserResponseSchema,
} from "@rudderhq/agent-runtime-utils";
import {
  appendWithCap,
  ensurePathInEnv,
  killChildProcessTree,
  MAX_CAPTURE_BYTES,
  runningProcesses,
  type ChildProcessWithEvents,
  type RunProcessResult,
} from "@rudderhq/agent-runtime-utils/server-utils";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const CONTROL_REPLAY_TIMEOUT_MS = 5_000;
const CONTROL_APPROVAL_TIMEOUT_MS = 30 * 60_000;
const CONTROL_ATTEMPT_POLL_MS = 100;
const REPLAY_CACHE_LIMIT = 128;

type ClaudeStreamJsonEvent = Record<string, unknown>;
type ClaudeRequestApproval = NonNullable<AgentRuntimeExecutionContext["requestApproval"]>;
type AgentRuntimeApprovalRequest = Parameters<ClaudeRequestApproval>[0];
type AgentRuntimeApprovalHandle = Awaited<ReturnType<ClaudeRequestApproval>>;
type ClaudeWaitForApproval = NonNullable<AgentRuntimeExecutionContext["waitForApproval"]>;
type AgentRuntimeApprovalDecision = Awaited<ReturnType<ClaudeWaitForApproval>>;

export type ClaudeStreamJsonProcessOptions = {
  runId: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
  abortSignal?: AbortSignal;
  onEvent?: (event: ClaudeStreamJsonEvent) => void;
  requestApproval?: (request: AgentRuntimeApprovalRequest) => Promise<AgentRuntimeApprovalHandle>;
  waitForApproval?: (approvalId: string, timeoutMs: number) => Promise<AgentRuntimeApprovalDecision>;
  isCurrentAttempt?: () => boolean;
  attemptEpoch?: number | null;
};

export type ClaudeStreamJsonProcess = {
  sendUserMessage(text: string, uuid?: string): Promise<string>;
  waitForReplay(uuid: string, timeoutMs?: number): Promise<void>;
  waitForProviderTurn(timeoutMs?: number): Promise<boolean>;
  waitForTurn(): Promise<void>;
  close(): Promise<RunProcessResult>;
  interrupt(): Promise<AgentRuntimeControlInterruptResult>;
  getSessionId(): string | null;
  getLastUuid(): string | null;
  getProviderTurnId(): string | null;
  isTurnComplete(): boolean;
};

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function eventSessionId(event: ClaudeStreamJsonEvent): string | null {
  return nonEmpty(event.session_id);
}

function eventUuid(event: ClaudeStreamJsonEvent): string | null {
  return nonEmpty(event.uuid);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type ClaudeControlRequest = {
  requestId: string;
  subtype: string;
  toolName: string;
  toolUseId: string | null;
  inputKeys: string[];
  askUser: ClaudeAskUserBridge | null;
};

type ClaudeAskUserBridge = {
  request: ChatAskUserRequest;
  providerQuestions: Array<{
    question: string;
    optionLabelsById: Map<string, string>;
  }>;
};

type PendingControlRequest = {
  cancel: () => void;
  cancelled: Promise<void>;
};

type ControlOperationResult<T> =
  | { kind: "value"; value: T }
  | { kind: "cancelled" }
  | { kind: "stale" }
  | { kind: "failed" };

function rememberControlRequest(cache: Set<string>, value: string): void {
  cache.add(value);
}

function controlRequestFromEvent(event: ClaudeStreamJsonEvent): ClaudeControlRequest | null {
  if (nonEmpty(event.type) !== "control_request") return null;
  const requestId = nonEmpty(event.request_id);
  const request = isRecord(event.request) ? event.request : null;
  const subtype = nonEmpty(request?.subtype);
  if (!requestId || !request || !subtype || subtype.toLowerCase() !== "can_use_tool") return null;

  const input = isRecord(request.input) ? request.input : null;
  return {
    requestId,
    subtype,
    toolName: nonEmpty(request.tool_name) ?? "unknown",
    toolUseId: nonEmpty(request.tool_use_id),
    inputKeys: input ? Object.keys(input).slice(0, 32) : [],
    askUser: isAskUserQuestion(nonEmpty(request.tool_name) ?? "") ? askUserBridgeFromRequest(request) : null,
  };
}

function isAskUserQuestion(toolName: string): boolean {
  return toolName.replace(/[^a-z0-9]/gi, "").toLowerCase() === "askuserquestion";
}

function askUserBridgeFromRequest(request: Record<string, unknown>): ClaudeAskUserBridge | null {
  const rawQuestions = Array.isArray(request.input)
    ? request.input
    : isRecord(request.input) && Array.isArray(request.input.questions)
      ? request.input.questions
      : null;
  if (!rawQuestions) return null;

  const questions = rawQuestions.map((rawQuestion, questionIndex) => {
    if (!isRecord(rawQuestion)) return null;
    const question = nonEmpty(rawQuestion.question);
    const header = nonEmpty(rawQuestion.header);
    const rawOptions = Array.isArray(rawQuestion.options) ? rawQuestion.options : null;
    if (!question || !header || !rawOptions) return null;
    const options = rawOptions.map((rawOption, optionIndex) => {
      if (!isRecord(rawOption)) return null;
      const label = nonEmpty(rawOption.label);
      if (!label) return null;
      const description = nonEmpty(rawOption.description);
      const optionId = `q${questionIndex + 1}-option${optionIndex + 1}`;
      return {
        id: optionId,
        label,
        ...(description ? { description } : {}),
      };
    });
    if (options.some((option) => option === null)) return null;
    const normalizedOptions = options.filter((option): option is NonNullable<typeof option> => option !== null);
    return {
      id: `q${questionIndex + 1}`,
      header,
      question,
      options: normalizedOptions,
      ...(rawQuestion.multiSelect === true ? { selectionMode: "multiple" as const } : {}),
      // Claude's installed AskUserQuestion UI always offers a freeform answer.
      allowFreeform: true,
    };
  });
  if (questions.some((question) => question === null)) return null;
  const normalizedQuestions = questions.filter(
    (question): question is NonNullable<typeof question> => question !== null,
  );
  const parsedRequest = chatAskUserRequestSchema.safeParse({ questions: normalizedQuestions });
  if (!parsedRequest.success) return null;

  return {
    request: parsedRequest.data,
    providerQuestions: normalizedQuestions.map((question) => ({
      question: question.question,
      optionLabelsById: new Map(question.options.map((option) => [option.id, option.label])),
    })),
  };
}

function validatedAskUserResponse(
  request: ChatAskUserRequest,
  response: ChatAskUserResponse | undefined,
): ChatAskUserResponse | null {
  const parsed = chatAskUserResponseSchema.safeParse(response);
  if (!parsed.success || parsed.data.answers.length !== request.questions.length) return null;

  const answersByQuestionId = new Map(parsed.data.answers.map((answer) => [answer.questionId, answer]));
  if (answersByQuestionId.size !== request.questions.length) return null;
  for (const question of request.questions) {
    const answer = answersByQuestionId.get(question.id);
    if (!answer) return null;
    const optionIds = new Set(question.options.map((option) => option.id));
    if (answer.optionIds.some((optionId) => !optionIds.has(optionId))) return null;
    if (question.selectionMode !== "multiple" && answer.optionIds.length > 1) return null;
    if (answer.freeformText && question.allowFreeform !== true) return null;
    if (answer.optionIds.length === 0 && !answer.freeformText) return null;
  }
  return parsed.data;
}

function updatedInputFromAskUserResponse(
  bridge: ClaudeAskUserBridge,
  response: ChatAskUserResponse,
): Record<string, unknown> | null {
  const answers: Record<string, string> = {};
  for (const answer of response.answers) {
    const questionIndex = bridge.request.questions.findIndex((question) => question.id === answer.questionId);
    const providerQuestion = bridge.providerQuestions[questionIndex];
    if (!providerQuestion) return null;
    const labels = answer.optionIds.map((optionId) => providerQuestion.optionLabelsById.get(optionId));
    if (labels.some((label) => !label)) return null;
    const values = labels.filter((label): label is string => Boolean(label));
    if (answer.freeformText) values.push(answer.freeformText);
    answers[providerQuestion.question] = values.join(", ");
  }
  return { answers };
}

function safeControlRequestEvent(event: ClaudeStreamJsonEvent): ClaudeStreamJsonEvent {
  if (nonEmpty(event.type) !== "control_request") return event;
  const request = isRecord(event.request) ? event.request : null;
  const safe: ClaudeStreamJsonEvent = { type: "control_request" };
  const requestId = nonEmpty(event.request_id);
  const sessionId = eventSessionId(event);
  if (requestId) safe.request_id = requestId;
  if (sessionId) safe.session_id = sessionId;
  safe.request = {
    ...(nonEmpty(request?.subtype) ? { subtype: nonEmpty(request?.subtype) } : {}),
    ...(nonEmpty(request?.tool_name) ? { tool_name: nonEmpty(request?.tool_name) } : {}),
    ...(nonEmpty(request?.tool_use_id) ? { tool_use_id: nonEmpty(request?.tool_use_id) } : {}),
    ...(isRecord(request?.input) ? { inputKeys: Object.keys(request.input).slice(0, 32) } : {}),
  };
  return safe;
}

function writeStdin(
  child: ChildProcessWithEvents,
  payload: string,
): Promise<void> {
  if (!child.stdin?.writable) {
    return Promise.reject(new Error("Claude stream-json stdin is closed."));
  }
  return new Promise<void>((resolve, reject) => {
    child.stdin!.write(payload, (error?: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function startClaudeStreamJsonProcess(
  options: ClaudeStreamJsonProcessOptions,
): ClaudeStreamJsonProcess {
  const mergedEnv = ensurePathInEnv({ ...process.env, ...options.env });
  delete mergedEnv.RUDDER_DESKTOP_CLI_ENTRY;
  for (const key of [
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SESSION",
    "CLAUDE_CODE_PARENT_SESSION",
  ]) {
    delete mergedEnv[key];
  }

  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: mergedEnv,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithEvents;
  const startedAt = new Date().toISOString();
  if (typeof child.pid === "number" && child.pid > 0 && options.onSpawn) {
    void options.onSpawn({ pid: child.pid, startedAt }).catch(() => undefined);
  }
  runningProcesses.set(options.runId, { child, graceSec: options.graceSec });

  let sessionId: string | null = null;
  let lastUuid: string | null = null;
  let providerTurnId: string | null = null;
  let turnComplete = false;
  let timedOut = false;
  let aborted = false;
  let inputClosed = false;
  let disposed = false;
  let forceKillTimer: NodeJS.Timeout | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;
  let abortCleanup: (() => void) | null = null;
  let forceKillAt = Number.POSITIVE_INFINITY;
  let stdout = "";
  let stderr = "";
  let lineBuffer = "";
  let logChain: Promise<void> = Promise.resolve();
  let resolveTurn!: () => void;
  const turnDone = new Promise<void>((resolve) => {
    resolveTurn = resolve;
  });
  let resolveProviderTurn!: () => void;
  const providerTurnDone = new Promise<void>((resolve) => {
    resolveProviderTurn = resolve;
  });
  let resolveExit!: (result: RunProcessResult) => void;
  let rejectExit!: (error: Error) => void;
  const exitDone = new Promise<RunProcessResult>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  const replayWaiters = new Map<string, Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>>();
  const replayedUuids = new Set<string>();
  const pendingControlRequests = new Map<string, PendingControlRequest>();
  // Keep opaque request IDs for this connection so a late duplicate can never
  // receive a second provider response after the bounded replay cache rotates.
  const completedControlRequestIds = new Set<string>();
  let controlResponseChain: Promise<void> = Promise.resolve();

  function currentAttemptIsCurrent(): boolean {
    if (!options.isCurrentAttempt) return true;
    try {
      return options.isCurrentAttempt();
    } catch {
      return false;
    }
  }

  function cancelPendingControlRequests(): void {
    for (const [requestId, pending] of pendingControlRequests) {
      rememberControlRequest(completedControlRequestIds, requestId);
      pending.cancel();
    }
    pendingControlRequests.clear();
  }

  function enqueueControlResponse(
    request: ClaudeControlRequest,
    behavior: "allow" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
  ): Promise<void> {
    const response: Record<string, unknown> = {
      behavior,
      ...(request.toolUseId ? { toolUseID: request.toolUseId } : {}),
      ...(behavior === "allow" && updatedInput ? { updatedInput } : {}),
      ...(behavior === "deny"
        ? {
            message: message ?? "Rudder approval was not granted.",
            decisionClassification: "user_reject",
          }
        : {}),
    };
    const payload = `${JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: request.requestId,
        response,
      },
    })}\n`;
    controlResponseChain = controlResponseChain
      .catch(() => undefined)
      .then(async () => {
        if (disposed || inputClosed) return;
        try {
          await writeStdin(child, payload);
        } catch {
          await options.onLog(
            "stderr",
            `[rudder] Claude control response could not be delivered requestId=${request.requestId}\n`,
          ).catch(() => undefined);
        }
      });
    return controlResponseChain;
  }

  async function sendControlResponseOnce(
    request: ClaudeControlRequest,
    behavior: "allow" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
  ): Promise<void> {
    if (completedControlRequestIds.has(request.requestId)) return;
    rememberControlRequest(completedControlRequestIds, request.requestId);
    pendingControlRequests.delete(request.requestId);
    await enqueueControlResponse(request, behavior, message, updatedInput);
  }

  async function raceControlOperation<T>(
    operation: Promise<T>,
    pending: PendingControlRequest,
  ): Promise<ControlOperationResult<T>> {
    const operationResult: Promise<ControlOperationResult<T>> = operation.then(
      (value) => ({ kind: "value", value }),
      () => ({ kind: "failed" }),
    );
    const lifetimeResults: Array<Promise<ControlOperationResult<T>>> = [
      operationResult,
      pending.cancelled.then(() => ({ kind: "cancelled" })),
    ];
    let pollTimer: NodeJS.Timeout | null = null;
    if (options.isCurrentAttempt) {
      const staleResult = new Promise<ControlOperationResult<T>>((resolve) => {
        const check = () => {
          if (!currentAttemptIsCurrent()) {
            if (pollTimer) clearInterval(pollTimer);
            pollTimer = null;
            resolve({ kind: "stale" });
          }
        };
        check();
        if (currentAttemptIsCurrent()) {
          pollTimer = setInterval(check, CONTROL_ATTEMPT_POLL_MS);
        }
      });
      lifetimeResults.push(staleResult);
    }
    try {
      return await Promise.race(lifetimeResults);
    } finally {
      if (pollTimer) clearInterval(pollTimer);
    }
  }

  async function handleControlRequest(request: ClaudeControlRequest): Promise<void> {
    if (completedControlRequestIds.has(request.requestId) || pendingControlRequests.has(request.requestId)) return;

    let resolveCancelled!: () => void;
    const pending: PendingControlRequest = {
      cancel: () => resolveCancelled(),
      cancelled: new Promise<void>((resolve) => {
        resolveCancelled = resolve;
      }),
    };
    pendingControlRequests.set(request.requestId, pending);

    if (!currentAttemptIsCurrent()) {
      await sendControlResponseOnce(request, "deny", "Rudder approval request is no longer current.");
      return;
    }

    const askUser = isAskUserQuestion(request.toolName) ? request.askUser : null;
    if (isAskUserQuestion(request.toolName) && !askUser) {
      await sendControlResponseOnce(
        request,
        "deny",
        "Claude AskUserQuestion contained an unsupported structured request.",
      );
      return;
    }

    if (!options.requestApproval || !options.waitForApproval) {
      await sendControlResponseOnce(request, "deny", "Rudder approval bridge is unavailable.");
      return;
    }

    let behavior: "allow" | "deny" = "deny";
    let denialMessage = "Rudder approval was not granted.";
    let updatedInput: Record<string, unknown> | undefined;
    try {
      const approvalResult = await raceControlOperation(
        options.requestApproval({
          type: "agent_runtime",
          payload: {
            provider: "claude",
            runtimeType: "claude_local",
            protocol: "stream-json",
            ...(sessionId ? { sessionId } : {}),
            requestId: request.requestId,
            subtype: request.subtype,
            toolName: request.toolName,
            ...(request.toolUseId ? { toolUseId: request.toolUseId } : {}),
            inputKeys: request.inputKeys,
            ...(options.attemptEpoch !== undefined && options.attemptEpoch !== null
              ? { attemptEpoch: options.attemptEpoch }
              : {}),
            ...(askUser ? { inputRequest: askUser.request } : {}),
            choices: ["allow", "deny"],
          },
          ...(askUser ? { inputRequest: askUser.request } : {}),
        }),
        pending,
      );
      if (approvalResult.kind !== "value") {
        denialMessage = approvalResult.kind === "stale"
          ? "Rudder approval request is no longer current."
          : "Rudder approval request was cancelled before it could be resolved.";
      } else {
        const approval = approvalResult.value;
        const decisionResult = await raceControlOperation(
          options.waitForApproval(approval.id, CONTROL_APPROVAL_TIMEOUT_MS),
          pending,
        );
        if (
          decisionResult.kind === "value"
          && decisionResult.value.id === approval.id
          && decisionResult.value.status === "approved"
          && currentAttemptIsCurrent()
        ) {
          if (askUser) {
            const response = validatedAskUserResponse(askUser.request, decisionResult.value.inputResponse);
            updatedInput = response ? updatedInputFromAskUserResponse(askUser, response) ?? undefined : undefined;
            if (response && updatedInput) {
              behavior = "allow";
            } else {
              denialMessage = "Rudder structured answer could not be validated.";
            }
          } else {
            behavior = "allow";
          }
        } else if (decisionResult.kind === "stale" || !currentAttemptIsCurrent()) {
          denialMessage = "Rudder approval request is no longer current.";
        } else if (decisionResult.kind === "cancelled") {
          denialMessage = "Rudder approval request was cancelled before it could be resolved.";
        } else if (decisionResult.kind === "value" && decisionResult.value.status === "pending") {
          denialMessage = "Rudder approval request expired.";
        }
      }
    } catch {
      denialMessage = "Rudder approval request could not be resolved.";
    }

    await sendControlResponseOnce(request, behavior, denialMessage, updatedInput);
  }

  const clearForceKillTimer = () => {
    if (forceKillTimer) clearTimeout(forceKillTimer);
    forceKillTimer = null;
    forceKillAt = Number.POSITIVE_INFINITY;
  };

  const scheduleForceKill = (delayMs: number) => {
    const boundedDelayMs = Math.max(1, delayMs);
    const killAt = Date.now() + boundedDelayMs;
    if (forceKillTimer && forceKillAt <= killAt) return;
    clearForceKillTimer();
    forceKillAt = killAt;
    forceKillTimer = setTimeout(() => {
      forceKillTimer = null;
      forceKillAt = Number.POSITIVE_INFINITY;
      killChildProcessTree(child, true);
    }, boundedDelayMs);
  };

  const terminate = (force = false) => {
    cancelPendingControlRequests();
    killChildProcessTree(child, force);
    if (!force) scheduleForceKill(Math.max(1, options.graceSec) * 1000);
  };

  const resolveReplay = (uuid: string) => {
    replayedUuids.add(uuid);
    while (replayedUuids.size > REPLAY_CACHE_LIMIT) {
      const oldest = replayedUuids.values().next().value;
      if (typeof oldest !== "string") break;
      replayedUuids.delete(oldest);
    }
    const waiters = replayWaiters.get(uuid);
    if (!waiters) return;
    replayWaiters.delete(uuid);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  };

  const rejectReplayWaiters = (error: Error) => {
    for (const waiters of replayWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    replayWaiters.clear();
  };

  const handleEvent = (event: ClaudeStreamJsonEvent) => {
    const type = nonEmpty(event.type);
    const nextSessionId = eventSessionId(event);
    if (nextSessionId) sessionId = nextSessionId;
    const nextUuid = eventUuid(event);
    if (nextUuid) lastUuid = nextUuid;
    if (type === "assistant" && nextUuid) {
      providerTurnId = nextUuid;
      resolveProviderTurn();
    }
    if (type === "user" && event.isReplay === true) {
      const replayUuid = eventUuid(event);
      if (replayUuid) resolveReplay(replayUuid);
    }
    if (type === "result") {
      turnComplete = true;
      resolveTurn();
    }
    const safeEvent = safeControlRequestEvent(event);
    const controlRequest = controlRequestFromEvent(event);
    if (controlRequest) void handleControlRequest(controlRequest);
    options.onEvent?.(safeEvent);
  };

  const consumeLines = (chunk: string): string => {
    lineBuffer += chunk;
    let safeChunk = "";
    let newlineIndex = lineBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const rawLine = lineBuffer.slice(0, newlineIndex).trim();
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      if (rawLine) {
        try {
          const parsed: unknown = JSON.parse(rawLine);
          if (isRecord(parsed)) {
            handleEvent(parsed);
            safeChunk += `${JSON.stringify(safeControlRequestEvent(parsed))}\n`;
          } else {
            safeChunk += `${rawLine}\n`;
          }
        } catch {
          // Do not retain a malformed line that may be a partial control request.
          safeChunk += rawLine.includes("control_request")
            ? "[rudder] redacted malformed Claude control request\n"
            : `${rawLine}\n`;
        }
      }
      newlineIndex = lineBuffer.indexOf("\n");
    }
    return safeChunk;
  };

  child.stdin?.on("error", () => undefined);
  child.stdout?.on("data", (chunk: unknown) => {
    const text = String(chunk);
    const safeText = consumeLines(text);
    stdout = appendWithCap(stdout, safeText, MAX_CAPTURE_BYTES);
    logChain = logChain.then(() => options.onLog("stdout", safeText)).catch(() => undefined);
  });
  child.stderr?.on("data", (chunk: unknown) => {
    const text = String(chunk);
    stderr = appendWithCap(stderr, text, MAX_CAPTURE_BYTES);
    logChain = logChain.then(() => options.onLog("stderr", text)).catch(() => undefined);
  });

  const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
    if (disposed) return;
    disposed = true;
    cancelPendingControlRequests();
    if (timeoutTimer) clearTimeout(timeoutTimer);
    timeoutTimer = null;
    abortCleanup?.();
    abortCleanup = null;
    clearForceKillTimer();
    runningProcesses.delete(options.runId);
    if (!turnComplete) {
      turnComplete = true;
      resolveTurn();
    }
    resolveProviderTurn();
    rejectReplayWaiters(new Error("Claude stream-json process closed before replay acknowledgement."));
    const completion = logChain.then(() => {
      resolveExit({
        exitCode,
        signal: aborted ? "SIGTERM" : signal,
        timedOut,
        stdout,
        stderr,
        pid: child.pid ?? null,
        startedAt,
      });
    });
    void completion.catch((error) => rejectExit(error instanceof Error ? error : new Error(String(error))));
  };

  child.once("error", (error: Error) => {
    if (!disposed) {
      disposed = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timeoutTimer = null;
      abortCleanup?.();
      abortCleanup = null;
      clearForceKillTimer();
      cancelPendingControlRequests();
      runningProcesses.delete(options.runId);
      rejectReplayWaiters(error);
      resolveTurn();
      resolveProviderTurn();
      rejectExit(error);
    }
  });
  child.once("close", finish);

  if (options.timeoutSec > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutSec * 1000);
  }
  if (options.abortSignal) {
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    if (options.abortSignal.aborted) onAbort();
    else {
      options.abortSignal.addEventListener("abort", onAbort, { once: true });
      abortCleanup = () => options.abortSignal?.removeEventListener("abort", onAbort);
    }
  }

  return {
    async sendUserMessage(text, uuid = randomUUID()) {
      if (disposed || inputClosed || turnComplete) {
        throw new Error("Claude stream-json turn is no longer accepting user input.");
      }
      const payload = `${JSON.stringify({
        type: "user",
        uuid,
        message: { role: "user", content: [{ type: "text", text }] },
      })}\n`;
      await writeStdin(child, payload);
      return uuid;
    },
    waitForReplay(uuid, timeoutMs = CONTROL_REPLAY_TIMEOUT_MS) {
      if (disposed) return Promise.reject(new Error("Claude stream-json process is closed."));
      if (replayedUuids.has(uuid)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const waiters = replayWaiters.get(uuid) ?? [];
          const remaining = waiters.filter((waiter) => waiter.resolve !== resolve);
          if (remaining.length > 0) replayWaiters.set(uuid, remaining);
          else replayWaiters.delete(uuid);
          reject(new Error(`Claude did not replay stream-json request ${uuid} within ${timeoutMs}ms.`));
        }, timeoutMs);
        const waiters = replayWaiters.get(uuid) ?? [];
        waiters.push({ resolve, reject, timer });
        replayWaiters.set(uuid, waiters);
      });
    },
    waitForProviderTurn(timeoutMs = CONTROL_REPLAY_TIMEOUT_MS) {
      if (providerTurnId) return Promise.resolve(true);
      if (disposed) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        let settled = false;
        let timer: NodeJS.Timeout;
        const finish = (ready: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(ready && Boolean(providerTurnId));
        };
        timer = setTimeout(() => finish(false), timeoutMs);
        void providerTurnDone.then(() => finish(Boolean(providerTurnId)));
      });
    },
    waitForTurn() {
      return turnDone;
    },
    async close() {
      if (!inputClosed && !disposed) {
        cancelPendingControlRequests();
        inputClosed = true;
        child.stdin?.end();
        scheduleForceKill(Math.max(1, options.graceSec) * 1000);
      }
      return exitDone;
    },
    async interrupt() {
      if (disposed) return "unverified";
      aborted = true;
      cancelPendingControlRequests();
      terminate();
      return "waiting_safe_boundary";
    },
    getSessionId: () => sessionId,
    getLastUuid: () => lastUuid,
    getProviderTurnId: () => providerTurnId,
    isTurnComplete: () => turnComplete,
  };
}

export function createClaudeStreamControlHandle(
  stream: ClaudeStreamJsonProcess,
): AgentRuntimeControlHandle {
  return {
    runtimeType: "claude_local",
    get providerThreadId() {
      return stream.getSessionId();
    },
    get providerTurnId() {
      return stream.getProviderTurnId();
    },
    capabilities: { steer: "interrupt_continue", interrupt: "process" },
    async steer(_input: AgentRuntimeControlSteerInput): Promise<AgentRuntimeControlSteerResult> {
      return {
        disposition: "unsupported",
        reason: "Claude Code stream-json replay confirms message receipt only; it does not confirm application to the in-flight turn.",
      };
    },
    async interrupt(_reason: AgentRuntimeControlInterruptReason) {
      return stream.interrupt();
    },
    async dispose() {
      await stream.close().catch(() => undefined);
    },
  };
}
