import type {
  AgentRuntimeControlHandleLease,
  AgentRuntimeExecutionContext,
  UsageSummary,
} from "@rudderhq/agent-runtime-utils";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import {
  CodexAppServerClient,
  CodexAppServerClosedError,
  createCodexAppServerStdioTransport,
  type CodexAppServerNotification,
  type CodexAppServerServerRequestHandler,
} from "./app-server-client.js";

const APP_SERVER_INTERRUPT_TIMEOUT_MS = 1_000;
const APP_SERVER_PROCESS_HARD_DEADLINE_MS = 2_000;
const APP_SERVER_CAPTURE_LIMIT = 8 * 1024 * 1024;
const APP_SERVER_SUBAGENT_ITEM_LIMIT = 256;
const APP_SERVER_SUBAGENT_READ_TIMEOUT_MS = 1_500;

type PackageJson = { version?: string };

const require = createRequire(import.meta.url);
const packageJson = require("../../package.json") as PackageJson;
const APP_SERVER_CLIENT_VERSION = packageJson.version ?? "0.0.0";

type JsonRecord = Record<string, unknown>;

export interface CodexAppServerChatOptions {
  command: string;
  cwd: string;
  env: Record<string, string>;
  prompt: string;
  model: string;
  modelReasoningEffort: string;
  search: boolean;
  bypassApprovalsAndSandbox: boolean;
  imagePaths: string[];
  sessionId: string | null;
  timeoutSec: number;
  onLog: AgentRuntimeExecutionContext["onLog"];
  onSpawn?: AgentRuntimeExecutionContext["onSpawn"];
  abortSignal?: AbortSignal;
  controlAttempt?: AgentRuntimeExecutionContext["controlAttempt"];
}

export interface CodexAppServerChatResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  errorMessage: string | null;
  stdout: string;
  stderr: string;
  summary: string;
  usage: UsageSummary;
  sessionId: string | null;
  providerTurnId: string | null;
  resumed: boolean;
  clearSession: boolean;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function appendBounded(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= APP_SERVER_CAPTURE_LIMIT
    ? combined
    : combined.slice(combined.length - APP_SERVER_CAPTURE_LIMIT);
}

function normalizeThreadItem(value: unknown): JsonRecord {
  const item = asRecord(value) ?? {};
  const type = asString(item.type);
  if (type === "agentMessage") {
    return { ...item, type: "agent_message", text: asString(item.text) };
  }
  if (type === "reasoning") {
    const summary = Array.isArray(item.summary) ? item.summary.filter((entry): entry is string => typeof entry === "string") : [];
    const content = Array.isArray(item.content) ? item.content.filter((entry): entry is string => typeof entry === "string") : [];
    return { ...item, type: "reasoning", text: [...summary, ...content].join("\n") };
  }
  if (type === "commandExecution") {
    return {
      ...item,
      type: "command_execution",
      aggregated_output: asString(item.aggregatedOutput),
      exit_code: typeof item.exitCode === "number" ? item.exitCode : null,
    };
  }
  if (type === "fileChange") {
    return { ...item, type: "file_change" };
  }
  if (type === "mcpToolCall") {
    return {
      ...item,
      type: "mcp_tool_call",
      content: item.result ?? item.error ?? null,
      is_error: Boolean(item.error),
    };
  }
  if (type === "dynamicToolCall") {
    return {
      ...item,
      type: "tool_use",
      name: asString(item.tool) || "dynamic_tool",
      input: item.arguments ?? {},
    };
  }
  if (type === "collabAgentToolCall") {
    return { ...item, type: "collab_agent_tool_call" };
  }
  if (type === "webSearch") {
    return { ...item, type: "web_search" };
  }
  return { ...item, type: type || "unknown" };
}

function readThreadSnapshot(response: unknown): { status: string; items: JsonRecord[] } | null {
  const thread = asRecord(asRecord(response)?.thread);
  if (!thread) return null;
  const turns = Array.isArray(thread.turns)
    ? thread.turns.map(asRecord).filter((turn): turn is JsonRecord => Boolean(turn))
    : [];
  const items = turns
    .flatMap((turn) => Array.isArray(turn.items) ? turn.items : [])
    .map(normalizeThreadItem)
    .slice(-APP_SERVER_SUBAGENT_ITEM_LIMIT);
  const lastTurn = turns.at(-1);
  const status = asString(lastTurn?.status) || asString(thread.status) || "unknown";
  return { status, items };
}

function collabAgentReceiverThreadIds(item: JsonRecord): string[] {
  return Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
}

function usageFromNotification(params: JsonRecord): UsageSummary | null {
  const tokenUsage = asRecord(params.tokenUsage);
  const last = asRecord(tokenUsage?.last);
  if (!last) return null;
  return {
    inputTokens: Number(last.inputTokens ?? 0),
    cachedInputTokens: Number(last.cachedInputTokens ?? 0),
    outputTokens: Number(last.outputTokens ?? 0),
  };
}

function serverRequestHandlers(
  bypass: boolean,
): Readonly<Record<string, CodexAppServerServerRequestHandler>> {
  return {
    "item/commandExecution/requestApproval": ({ signal }) => ({
      decision: signal.aborted ? "cancel" : bypass ? "accept" : "decline",
    }),
    "item/fileChange/requestApproval": ({ signal }) => ({
      decision: signal.aborted ? "cancel" : bypass ? "accept" : "decline",
    }),
    "item/tool/requestUserInput": () => ({ answers: {} }),
    "mcpServer/elicitation/request": () => ({ action: "cancel", content: null, _meta: null }),
    "item/permissions/requestApproval": async () => {
      throw new Error("Rudder does not grant additional App Server permission profiles during a chat turn");
    },
    "item/tool/call": () => ({
      contentItems: [{ type: "inputText", text: "Dynamic App Server tools are not registered for this Rudder run." }],
      success: false,
    }),
    "account/chatgptAuthTokens/refresh": async () => {
      throw new Error("Codex App Server must use the isolated CODEX_HOME credentials for this run");
    },
    "attestation/generate": async () => {
      throw new Error("Client attestation is not enabled for Rudder App Server chat runs");
    },
    applyPatchApproval: ({ signal }) => ({
      decision: signal.aborted ? "abort" : bypass ? "approved" : "denied",
    }),
    execCommandApproval: ({ signal }) => ({
      decision: signal.aborted ? "abort" : bypass ? "approved" : "denied",
    }),
  };
}

function signalProcessGroup(child: ChildProcess, force: boolean): void {
  const signal = force ? "SIGKILL" : "SIGTERM";
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through when the process group already exited.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process already exited.
  }
}

function isProcessTreeAlive(child: ChildProcess): boolean {
  if (process.platform === "win32") {
    return child.exitCode === null && child.signalCode === null;
  }
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

async function waitForProcessTreeExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessTreeAlive(child) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !isProcessTreeAlive(child);
}

export async function executeCodexAppServerChat(
  options: CodexAppServerChatOptions,
): Promise<CodexAppServerChatResult> {
  const child = spawn(options.command, [
    "app-server",
    "--stdio",
    "--disable",
    "plugins",
  ], {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const startedAt = new Date().toISOString();
  if (child.pid) await options.onSpawn?.({ pid: child.pid, startedAt });

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const text = String(chunk);
    stderr = appendBounded(stderr, text);
    void options.onLog("stderr", text);
  });

  let stdout = "";
  let latestUsage: UsageSummary = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  let finalAgentText = "";
  const agentDeltaItemIds = new Set<string>();
  const reasoningDeltaItemIds = new Set<string>();
  const reasoningStreamByItemId = new Map<string, "summary" | "raw">();
  const reasoningSummaryIndexByItemId = new Map<string, number>();
  let threadId: string | null = null;
  let turnId: string | null = null;
  let turnCompleted = false;
  let turnError: Error | null = null;
  let resolveTurn!: () => void;
  let rejectTurn!: (error: Error) => void;
  const turnDone = new Promise<void>((resolve, reject) => {
    resolveTurn = resolve;
    rejectTurn = reject;
  });
  // Setup can fail after the client starts but before execution awaits this deferred.
  // Observe early transport rejection now while preserving the later await semantics.
  void turnDone.catch(() => undefined);
  let forceKillTimer: NodeJS.Timeout | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;
  let abortCleanup: (() => void) | null = null;
  let controlLease: AgentRuntimeControlHandleLease | null = null;
  let disposed = false;

  const emit = async (event: JsonRecord) => {
    const line = `${JSON.stringify(event)}\n`;
    stdout = appendBounded(stdout, line);
    await options.onLog("stdout", line);
  };

  const emitReasoningDelta = async (itemId: string, text: string) => {
    if (!text) return;
    if (itemId) reasoningDeltaItemIds.add(itemId);
    await emit({
      type: "item.completed",
      item: { id: itemId || undefined, type: "reasoning", text, delta: true },
    });
  };

  const client = new CodexAppServerClient({
    transport: createCodexAppServerStdioTransport(child),
    clientInfo: { name: "rudder", title: "Rudder", version: APP_SERVER_CLIENT_VERSION },
    capabilities: { experimentalApi: true },
    requestTimeoutMs: 30_000,
    serverRequestTimeoutMs: 30_000,
    serverRequestHandlers: serverRequestHandlers(options.bypassApprovalsAndSandbox),
    onNotification: async (notification: CodexAppServerNotification, { signal }) => {
      if (signal.aborted) return;
      const params = asRecord(notification.params) ?? {};
      const notificationThreadId = asString(params.threadId);
      const notificationTurnId = asString(params.turnId) || asString(asRecord(params.turn)?.id);
      if (threadId && notificationThreadId && notificationThreadId !== threadId) return;
      if (turnId && notificationTurnId && notificationTurnId !== turnId) return;
      if (options.abortSignal?.aborted && notification.method !== "turn/completed") return;

      if (notification.method === "thread/tokenUsage/updated") {
        latestUsage = usageFromNotification(params) ?? latestUsage;
        return;
      }
      if (notification.method === "item/agentMessage/delta") {
        const delta = asString(params.delta);
        const itemId = asString(params.itemId);
        if (itemId) agentDeltaItemIds.add(itemId);
        if (delta) {
          await emit({
            type: "item.completed",
            item: { id: itemId || undefined, type: "agent_message", text: delta, delta: true },
          });
        }
        return;
      }
      if (notification.method === "item/reasoning/summaryPartAdded") {
        const itemId = asString(params.itemId);
        const itemKey = itemId || "__anonymous_reasoning_item__";
        const selectedStream = reasoningStreamByItemId.get(itemKey);
        if (selectedStream && selectedStream !== "summary") return;
        reasoningStreamByItemId.set(itemKey, "summary");
        const summaryIndex = typeof params.summaryIndex === "number" ? params.summaryIndex : 0;
        const previousSummaryIndex = reasoningSummaryIndexByItemId.get(itemKey);
        if (previousSummaryIndex !== undefined && previousSummaryIndex !== summaryIndex) {
          await emitReasoningDelta(itemId, "\n");
        }
        reasoningSummaryIndexByItemId.set(itemKey, summaryIndex);
        return;
      }
      if (notification.method === "item/reasoning/summaryTextDelta") {
        const itemId = asString(params.itemId);
        const itemKey = itemId || "__anonymous_reasoning_item__";
        const selectedStream = reasoningStreamByItemId.get(itemKey);
        if (selectedStream && selectedStream !== "summary") return;
        reasoningStreamByItemId.set(itemKey, "summary");
        const summaryIndex = typeof params.summaryIndex === "number" ? params.summaryIndex : 0;
        const previousSummaryIndex = reasoningSummaryIndexByItemId.get(itemKey);
        if (previousSummaryIndex !== undefined && previousSummaryIndex !== summaryIndex) {
          await emitReasoningDelta(itemId, "\n");
        }
        reasoningSummaryIndexByItemId.set(itemKey, summaryIndex);
        await emitReasoningDelta(itemId, asString(params.delta));
        return;
      }
      if (notification.method === "item/reasoning/textDelta") {
        const itemId = asString(params.itemId);
        const itemKey = itemId || "__anonymous_reasoning_item__";
        const selectedStream = reasoningStreamByItemId.get(itemKey);
        if (selectedStream && selectedStream !== "raw") return;
        reasoningStreamByItemId.set(itemKey, "raw");
        await emitReasoningDelta(itemId, asString(params.delta));
        return;
      }
      if (notification.method === "item/started" || notification.method === "item/completed") {
        let item = normalizeThreadItem(params.item);
        if (item.type === "userMessage") return;
        if (notification.method === "item/completed" && item.type === "collab_agent_tool_call") {
          const snapshots = await Promise.all(collabAgentReceiverThreadIds(item).map(async (receiverThreadId) => {
            try {
              const response = await client.request("thread/read", {
                threadId: receiverThreadId,
                includeTurns: true,
              }, APP_SERVER_SUBAGENT_READ_TIMEOUT_MS);
              return [receiverThreadId, readThreadSnapshot(response)] as const;
            } catch {
              return [receiverThreadId, null] as const;
            }
          }));
          const agentTranscripts = Object.fromEntries(
            snapshots.filter((entry): entry is readonly [string, NonNullable<ReturnType<typeof readThreadSnapshot>>] => Boolean(entry[1])),
          );
          if (Object.keys(agentTranscripts).length > 0) {
            item = { ...item, agentTranscripts };
          }
        }
        if (notification.method === "item/completed" && item.type === "agent_message") {
          finalAgentText = asString(item.text) || finalAgentText;
        }
        const itemId = asString(item.id);
        if (
          notification.method === "item/completed"
          && itemId
          && (
            (item.type === "agent_message" && agentDeltaItemIds.has(itemId))
            || (item.type === "reasoning" && reasoningDeltaItemIds.has(itemId))
          )
        ) {
          return;
        }
        await emit({
          type: notification.method === "item/started" ? "item.started" : "item.completed",
          item: item.type === "command_execution"
            ? { ...item, cwd: options.cwd }
            : item,
        });
        return;
      }
      if (notification.method === "turn/started") {
        await emit({ type: "turn.started" });
        return;
      }
      if (notification.method === "turn/completed") {
        const turn = asRecord(params.turn) ?? {};
        const status = asString(turn.status) || "completed";
        const error = asRecord(turn.error);
        turnError = error
          ? new Error(asString(error.message) || `Codex turn ${status}`)
          : status === "failed" || (status === "interrupted" && !options.abortSignal?.aborted)
            ? new Error(`Codex turn ${status}`)
            : null;
        await emit({
          type: turnError ? "turn.failed" : "turn.completed",
          result: finalAgentText,
          subtype: status,
          is_error: Boolean(turnError),
          error: turnError ? { message: turnError.message } : null,
          usage: {
            input_tokens: latestUsage.inputTokens,
            cached_input_tokens: latestUsage.cachedInputTokens ?? 0,
            output_tokens: latestUsage.outputTokens,
          },
        });
        turnCompleted = true;
        resolveTurn();
        return;
      }
      if (notification.method === "error") {
        const message = asString(asRecord(params.error)?.message) || asString(params.message) || "Codex App Server error";
        await emit({ type: "error", message });
      }
    },
    onCapabilityGateClosed: (error) => {
      if (!turnCompleted) rejectTurn(error);
    },
    onError: (error) => {
      if (!turnCompleted) rejectTurn(error);
    },
  });

  let interruptPromise: Promise<"acknowledged" | "unverified"> | null = null;
  const interrupt = () => {
    if (interruptPromise) return interruptPromise;
    interruptPromise = (async () => {
      if (!threadId || !turnId || client.state !== "ready") return "unverified" as const;
      try {
        await client.request("turn/interrupt", { threadId, turnId }, APP_SERVER_INTERRUPT_TIMEOUT_MS);
        return "acknowledged" as const;
      } catch {
        return "unverified" as const;
      }
    })();
    return interruptPromise;
  };
  const terminate = () => {
    if (disposed) return;
    signalProcessGroup(child, false);
    if (!forceKillTimer) {
      forceKillTimer = setTimeout(() => signalProcessGroup(child, true), APP_SERVER_PROCESS_HARD_DEADLINE_MS);
    }
  };

  const terminateAndWait = async () => {
    if (!isProcessTreeAlive(child)) return;
    signalProcessGroup(child, false);
    if (await waitForProcessTreeExit(child, APP_SERVER_PROCESS_HARD_DEADLINE_MS)) return;
    signalProcessGroup(child, true);
    await waitForProcessTreeExit(child, 1_000);
  };
  const scheduleHardKill = () => {
    if (!forceKillTimer) {
      forceKillTimer = setTimeout(() => signalProcessGroup(child, true), APP_SERVER_PROCESS_HARD_DEADLINE_MS);
    }
  };
  const onAbort = () => {
    scheduleHardKill();
    void interrupt().then((result) => {
      if (result === "unverified" && !turnCompleted) terminate();
    });
  };
  if (options.abortSignal) {
    if (options.abortSignal.aborted) onAbort();
    else {
      options.abortSignal.addEventListener("abort", onAbort, { once: true });
      abortCleanup = () => options.abortSignal?.removeEventListener("abort", onAbort);
    }
  }
  if (options.timeoutSec > 0) {
    timeoutTimer = setTimeout(() => {
      scheduleHardKill();
      void interrupt().then((result) => {
        if (result === "unverified" && !turnCompleted) terminate();
      });
      rejectTurn(new Error(`Timed out after ${options.timeoutSec}s`));
    }, options.timeoutSec * 1000);
  }

  let resumed = false;
  let clearSession = false;
  try {
    await client.initialize();
    let threadResponse: JsonRecord;
    const threadParams = {
      model: options.model || null,
      cwd: options.cwd,
      approvalPolicy: options.bypassApprovalsAndSandbox ? "never" : null,
      sandbox: options.bypassApprovalsAndSandbox ? "danger-full-access" : null,
      config: {
        web_search: options.search ? "live" : "disabled",
        skills: { bundled: { enabled: false } },
      },
    };
    if (options.sessionId) {
      try {
        threadResponse = asRecord(await client.request("thread/resume", {
          threadId: options.sessionId,
          ...threadParams,
        })) ?? {};
        resumed = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/unknown|not found|no rollout|missing rollout/i.test(message)) throw error;
        clearSession = true;
        threadResponse = asRecord(await client.request("thread/start", {
          ...threadParams,
          ephemeral: false,
        })) ?? {};
      }
    } else {
      threadResponse = asRecord(await client.request("thread/start", {
        ...threadParams,
        ephemeral: false,
      })) ?? {};
    }
    threadId = asString(asRecord(threadResponse.thread)?.id);
    if (!threadId) throw new Error("Codex App Server did not return a thread id");
    await emit({ type: "thread.started", thread_id: threadId, model: options.model || "codex" });

    const input = [
      { type: "text", text: options.prompt, text_elements: [] },
      ...options.imagePaths.map((imagePath) => ({ type: "localImage", path: imagePath })),
    ];
    const turnResponse = asRecord(await client.request("turn/start", {
      threadId,
      input,
      cwd: options.cwd,
      approvalPolicy: options.bypassApprovalsAndSandbox ? "never" : null,
      sandboxPolicy: options.bypassApprovalsAndSandbox ? { type: "dangerFullAccess" } : null,
      model: options.model || null,
      effort: options.modelReasoningEffort || null,
    })) ?? {};
    turnId = asString(asRecord(turnResponse.turn)?.id);
    if (!turnId) throw new Error("Codex App Server did not return a turn id");
    const activeThreadId = threadId;
    const activeTurnId = turnId;

    if (options.controlAttempt) {
      controlLease = await options.controlAttempt.register({
        runtimeType: "codex_local",
        providerThreadId: activeThreadId,
        providerTurnId: activeTurnId,
        capabilities: { steer: "native", interrupt: "native" },
        async steer(feedback) {
          try {
            const response = asRecord(await client.request("turn/steer", {
              threadId: activeThreadId,
              expectedTurnId: activeTurnId,
              clientUserMessageId: feedback.clientMessageId,
              input: [{ type: "text", text: feedback.text, text_elements: [] }],
            }, 5_000));
            const acknowledgedTurnId = asString(response?.turnId);
            if (acknowledgedTurnId !== activeTurnId) {
              return {
                disposition: "acceptance_unknown" as const,
                providerThreadId: activeThreadId,
                providerTurnId: acknowledgedTurnId || null,
                reason: "Codex acknowledged a different active turn",
              };
            }
            return {
              disposition: "accepted_current" as const,
              providerThreadId: activeThreadId,
              providerTurnId: activeTurnId,
            };
          } catch (error) {
            if (error instanceof CodexAppServerClosedError) {
              return {
                disposition: "acceptance_unknown" as const,
                providerThreadId: activeThreadId,
                providerTurnId: activeTurnId,
                reason: error.message,
              };
            }
            const message = error instanceof Error ? error.message : String(error);
            if (/no active turn|expectedTurnId|turn.*completed|turn.*closed/i.test(message)) {
              return { disposition: "closing" as const, reason: message };
            }
            return {
              disposition: "acceptance_unknown" as const,
              providerThreadId: activeThreadId,
              providerTurnId: activeTurnId,
              reason: message,
            };
          }
        },
        async interrupt() {
          return interrupt();
        },
        async dispose() {
          client.dispose("Codex App Server chat control handle disposed");
        },
      });
      if (!controlLease) {
        await interrupt();
        terminate();
        throw new Error("Codex App Server control handle lost its attempt lease");
      }
    }

    await turnDone;
    const finalTurnError = turnError as Error | null;
    return {
      exitCode: finalTurnError ? 1 : 0,
      signal: options.abortSignal?.aborted ? "SIGTERM" : null,
      timedOut: false,
      errorMessage: finalTurnError?.message ?? null,
      stdout,
      stderr,
      summary: finalAgentText,
      usage: latestUsage,
      sessionId: threadId,
      providerTurnId: turnId,
      resumed,
      clearSession,
    };
  } catch (error) {
    return {
      exitCode: 1,
      signal: options.abortSignal?.aborted ? "SIGTERM" : null,
      timedOut: error instanceof Error && /^Timed out after /.test(error.message),
      errorMessage: error instanceof Error ? error.message : String(error),
      stdout,
      stderr,
      summary: finalAgentText,
      usage: latestUsage,
      sessionId: threadId ?? options.sessionId,
      providerTurnId: turnId,
      resumed,
      clearSession,
    };
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    abortCleanup?.();
    await controlLease?.release().catch(() => undefined);
    disposed = true;
    client.dispose("Codex App Server chat execution complete");
    await terminateAndWait();
    if (forceKillTimer) clearTimeout(forceKillTimer);
  }
}
