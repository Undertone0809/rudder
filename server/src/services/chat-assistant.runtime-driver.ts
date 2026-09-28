import type {
  AgentRuntimeApprovalDecision,
  AgentRuntimeApprovalRequest,
  AgentRuntimeExecutionContext,
  AgentRuntimeExecutionResult,
  AgentRuntimeNetworkSubmissionPhase,
  ModelAttemptSpec,
  ServerAgentRuntimeModule,
} from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import { randomUUID } from "node:crypto";
import {
  createProfileBoundRuntimeProviderCapabilityResolverFromConfig,
  getRuntimeDriver,
} from "../agent-runtimes/index.js";
import { chatProviderResultIds } from "./chat-assistant.runtime-result.js";
import type { ChatRuntimeSensitiveInputRequestHandler } from "./chat-runtime-sensitive-input.js";
import type { RuntimeBindingInput } from "./runtime-kernel/native-session.js";
import { currentNativeSession, ensureRuntimeBinding } from "./runtime-kernel/native-session.js";
import type { RuntimeProviderBindingRef } from "./runtime-kernel/provider-capabilities.js";
import type {
  RuntimeDriver,
  RuntimeDriverApprovalBridge,
  RuntimeDriverFactoryOptions,
  RuntimeDriverSessionBindingOwner,
} from "./runtime-kernel/runtime-driver.js";
import { NATIVE_CHAT_RUNTIME_TYPES } from "./runtime-kernel/runtime-driver.js";
import type {
  UnifiedAcceptanceReconciliationInput,
} from "./runtime-kernel/unified-agent-run.contracts.js";
import {
  createHeartbeatUnifiedAgentRunAdapter,
  createUnifiedAgentRunExecutionService,
  createUnifiedAgentRunService,
  type UnifiedAgentRunExecutionService,
  type UnifiedAgentRunService,
} from "./runtime-kernel/unified-agent-run.integration.js";
import type { UnifiedAttemptFinishInput } from "./runtime-kernel/unified-agent-run.js";

type ChatDriverPortsDependencies = {
  ensureBinding?: RuntimeDriverSessionBindingOwner["ensureBinding"];
  currentSession?: RuntimeDriverSessionBindingOwner["currentSession"];
  unifiedRunReader?: Pick<UnifiedAgentRunService, "get">;
  unifiedRunReconciler?: Pick<UnifiedAgentRunExecutionService, "reconcileAcceptance">;
};

type ChatDriverOptionsInput = Pick<
  RuntimeDriverFactoryOptions,
  "adapter" | "providerCapabilityResolver" | "providerBinding" | "approvalBridge"
>;

type ApprovalCallbacks = Pick<RuntimeDriverApprovalBridge, "requestApproval" | "waitForApproval">;
type ChatAttemptDriverResolverInput = {
  primaryRuntimeType: string;
  providerBinding: RuntimeProviderBindingRef;
  cwd: string;
  continuationTransport: Record<string, unknown>;
  approvalBridge: RuntimeDriverApprovalBridge;
};
type ChatAttemptPortsInput = ChatAttemptDriverResolverInput & {
  runId: string;
  orgId: string;
  chatId: string;
  initialDriver: RuntimeDriver | null;
  nativeDriverRequired: boolean;
  getAttemptId: () => string | null | undefined;
  abortSignal?: AbortSignal;
  requestRuntimeSensitiveInput?: ChatRuntimeSensitiveInputRequestHandler;
  finishAttempt: (
    failure: AgentRuntimeExecutionResult | Error,
    phase: AgentRuntimeNetworkSubmissionPhase | null,
  ) => Promise<unknown>;
};
type SubmissionReconciliationInput = {
  driver: RuntimeDriver | null;
  runId: string;
  attemptId: string | null | undefined;
  phase: AgentRuntimeNetworkSubmissionPhase | null | undefined;
  providerThreadId: string | null;
  providerTurnId: string | null;
  reason?: string | null;
};

export function chatAttemptFailureFinishInput(
  failure: AgentRuntimeExecutionResult | Error,
  phase: AgentRuntimeNetworkSubmissionPhase | null,
  session: { sessionDisplayId: string | null; sessionParams: Record<string, unknown> | null },
): UnifiedAttemptFinishInput & { status: "failed" } {
  const result = failure instanceof Error ? null : failure;
  const ids = result ? chatProviderResultIds(result) : { providerThreadId: null, providerTurnId: null };
  return {
    status: "failed",
    ...(phase && phase !== "indeterminate" ? { submissionPhase: phase } : {}),
    providerThreadId: ids.providerThreadId,
    providerTurnId: ids.providerTurnId,
    sessionDisplayId: result?.sessionDisplayId ?? session.sessionDisplayId,
    sessionParamsJson: result?.sessionParams ?? session.sessionParams,
    errorCode: result?.errorCode ?? (failure instanceof Error ? "runtime_attempt_failed" : null),
    error: failure instanceof Error ? failure.message : failure.errorMessage ?? "Runtime attempt failed",
    usageDeltaJson: (result?.usage as Record<string, unknown> | null | undefined) ?? null,
    costUsd: result?.costUsd ?? null,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function runtimeRequestId(values: unknown[]) {
  for (const value of values) {
    const candidate = typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : nonEmptyString(value);
    if (candidate) return candidate;
  }
  return randomUUID();
}

export function createChatAssistantRuntimeDriverPorts(
  db: Db,
  dependencies: ChatDriverPortsDependencies = {},
) {
  // These facades delegate to the existing heartbeat persistence owner; they add no queue or scheduler.
  const adapter = createHeartbeatUnifiedAgentRunAdapter(db);
  const unifiedRunReader = dependencies.unifiedRunReader ?? createUnifiedAgentRunService(adapter);
  const unifiedRunReconciler = dependencies.unifiedRunReconciler ?? createUnifiedAgentRunExecutionService(adapter);
  const bindings = new Map<string, Awaited<ReturnType<typeof ensureRuntimeBinding>>>();
  const sessions = new Map<string, Awaited<ReturnType<typeof currentNativeSession>>>();
  const sessionBindingOwner: RuntimeDriverSessionBindingOwner = {
    ensureBinding: async (intent) => {
      const binding = await (dependencies.ensureBinding ?? ((value) => ensureRuntimeBinding(db, value)))(intent);
      bindings.set(binding.id, binding);
      return binding;
    },
    currentSession: async (binding) => {
      const session = await (dependencies.currentSession ?? ((value) => currentNativeSession(db, value)))(binding);
      sessions.set(binding.id, session);
      return session;
    },
  };
  const factoryOptions = (input: ChatDriverOptionsInput): RuntimeDriverFactoryOptions => ({
    ...input,
    sessionBindingOwner,
    unifiedRunReader,
    unifiedRunReconciler,
  });
  const createAttemptDriverResolver = (input: ChatAttemptDriverResolverInput) =>
    (runtimeType: string, adapter: ServerAgentRuntimeModule, context: AgentRuntimeExecutionContext) =>
      getRuntimeDriver(runtimeType, factoryOptions({
        adapter,
        providerCapabilityResolver: createProfileBoundRuntimeProviderCapabilityResolverFromConfig({
          runtimeType,
          runtimeConfig: {
            ...context.config,
            ...(runtimeType === input.primaryRuntimeType ? input.continuationTransport : {}),
          },
          cwd: input.cwd,
        }),
        providerBinding: input.providerBinding,
        approvalBridge: input.approvalBridge,
      }));
  const ensureSession = async (driver: RuntimeDriver | null, intent: RuntimeBindingInput) => {
    if (!driver) return null;
    const operation = await driver.ensureSession(intent);
    if (operation.status !== "supported") {
      throw new Error(`Runtime Driver cannot bind Chat session (${operation.status}): ${operation.reason}`);
    }
    const bindingId = nonEmptyString(operation.value.binding.id);
    if (!bindingId) throw new Error("Runtime Driver session binding returned no durable binding id");
    const binding = bindings.get(bindingId);
    const nativeSession = sessions.get(bindingId);
    if (!binding || !nativeSession || nativeSession.segment.id !== operation.value.segmentId) {
      throw new Error("Runtime Driver session binding could not be read back from its authoritative owner");
    }
    return { binding, nativeSession };
  };
  const ensureChatSession = async (
    driver: RuntimeDriver | null,
    intent: RuntimeBindingInput,
    nativeDriverRequired: boolean,
  ) => {
    const session = await ensureSession(driver, intent);
    if (session) return session;
    if (nativeDriverRequired) throw new Error(`Native Chat Runtime Driver is unavailable for ${intent.runtimeType} session binding`);
    const binding = await sessionBindingOwner.ensureBinding(intent);
    return { binding, nativeSession: await sessionBindingOwner.currentSession(binding) };
  };
  const reconcileSubmission = async (input: SubmissionReconciliationInput) => {
    if (!input.driver || !input.attemptId || !input.phase || input.phase === "indeterminate") return false;
    const entry = await unifiedRunReader.get(input.runId);
    if (!entry) return false;
    if (entry.attempt.ref.id !== input.attemptId) {
      throw new Error("Runtime Driver submission reconciliation no longer matches the active Chat attempt");
    }
    const outcome: UnifiedAcceptanceReconciliationInput = {
      state: input.phase === "pre_submission" ? "rejected" : "accepted",
      providerThreadId: input.providerThreadId,
      providerTurnId: input.providerTurnId,
      reason: input.reason ?? undefined,
    };
    const result = await input.driver.reconcileExecution({
      runId: input.runId,
      attemptId: input.attemptId,
      fence: entry.ownerFence,
      outcome,
    });
    if (result.status !== "supported") {
      throw new Error(`Runtime Driver submission reconciliation failed (${result.status}): ${result.reason}`);
    }
    if (!result.value.ok) throw new Error(`Runtime Driver submission reconciliation failed: ${result.value.reason}`);
    return true;
  };
  const approvalCallbacks = (driver: () => RuntimeDriver | null, bridge: ApprovalCallbacks) => {
    const requests = new Map<string, AgentRuntimeApprovalRequest>();
    return {
      requestApproval: async (request: AgentRuntimeApprovalRequest) => {
        const event = record(request.payload.event);
        const requestId = runtimeRequestId([
          request.payload.requestId,
          request.payload.providerRequestId,
          request.payload.controlRequestId,
          request.payload.request_id,
          request.payload.nativeRequestId,
          event?.requestId,
          event?.request_id,
        ]);
        const bridgedRequest = { ...request, payload: { ...request.payload, requestId } };
        const handle = await bridge.requestApproval(bridgedRequest);
        requests.set(handle.id, bridgedRequest);
        return handle;
      },
      waitForApproval: async (approvalId: string, timeoutMs: number): Promise<AgentRuntimeApprovalDecision> => {
        const request = requests.get(approvalId);
        const runtimeDriver = driver();
        if (!request || !runtimeDriver) return bridge.waitForApproval(approvalId, timeoutMs);
        const operation = await runtimeDriver.respondToRequest(request, timeoutMs);
        if (operation.status !== "supported") {
          throw new Error(`Runtime Driver cannot respond to Chat approval (${operation.status}): ${operation.reason}`);
        }
        if (operation.value.handle.id !== approvalId) {
          throw new Error("Runtime Driver returned a different Chat approval request");
        }
        if (operation.value.decision.status !== "pending") requests.delete(approvalId);
        return operation.value.decision;
      },
    };
  };
  const createAttemptPorts = (input: ChatAttemptPortsInput) => {
    const resolveAttemptDriver = createAttemptDriverResolver(input);
    let activeDriver = input.initialDriver;
    let reconciliationError: unknown;
    let submissionPhase: AgentRuntimeNetworkSubmissionPhase | null = null;
    const callbacks = approvalCallbacks(() => activeDriver, input.approvalBridge);
    return {
      resolveDriver: (runtimeType: string, adapter: ServerAgentRuntimeModule, context: AgentRuntimeExecutionContext) => {
        submissionPhase = null;
        activeDriver = resolveAttemptDriver(runtimeType, adapter, context);
        return activeDriver;
      },
      requestApproval: callbacks.requestApproval,
      waitForApproval: callbacks.waitForApproval,
      requestTransientInput: async ({ kind }: { kind: "secret" | "sudo" }) => {
        const attemptId = input.getAttemptId()?.trim();
        if (!attemptId || !input.requestRuntimeSensitiveInput) return { status: "aborted" as const };
        return input.requestRuntimeSensitiveInput({
          binding: { orgId: input.orgId, chatId: input.chatId, runId: input.runId, attemptId },
          kind,
          ...(input.abortSignal ? { signal: input.abortSignal } : {}),
        });
      },
      onAttemptResult: async (_attempt: ModelAttemptSpec, result: AgentRuntimeExecutionResult, phase: AgentRuntimeNetworkSubmissionPhase) => {
        submissionPhase = phase;
        try {
          await reconcileSubmission({
            driver: activeDriver,
            runId: input.runId,
            attemptId: input.getAttemptId?.(),
            phase,
            providerThreadId: typeof result.providerThreadId === "string" ? result.providerThreadId : null,
            providerTurnId: typeof result.providerTurnId === "string" ? result.providerTurnId : null,
            reason: result.errorMessage,
          });
        } catch (error) {
          reconciliationError = error;
          throw error;
        }
      },
      onAttemptFailure: async (_attempt: ModelAttemptSpec, failure: AgentRuntimeExecutionResult | Error) => {
        if (reconciliationError) throw reconciliationError;
        if (input.nativeDriverRequired && failure instanceof Error) throw failure;
        if (input.nativeDriverRequired && submissionPhase !== "pre_submission") return;
        await input.finishAttempt(failure, submissionPhase);
      },
    };
  };

  return {
    factoryOptions,
    isNativeRuntime: (runtimeType: string) => (NATIVE_CHAT_RUNTIME_TYPES as readonly string[]).includes(runtimeType),
    ensureSession: ensureChatSession,
    createAttemptDriverResolver,
    createAttemptPorts,
  };
}
