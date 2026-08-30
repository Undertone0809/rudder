import type {
  AgentRuntimeControlAttempt,
  AgentRuntimeControlAttemptLease,
  AgentRuntimeControlCoordinator,
  AgentRuntimeControlHandle,
  AgentRuntimeControlHandleLease,
  AgentRuntimeControlInterruptReason,
  AgentRuntimeControlInterruptResult,
  AgentRuntimeControlSteerInput,
  AgentRuntimeControlSteerResult,
} from "@rudderhq/agent-runtime-utils";
import { createOperatorInterruptAbortReason } from "@rudderhq/agent-runtime-utils/server-utils";
import { randomUUID } from "node:crypto";

const CHAT_OPERATOR_INTERRUPT_HARD_DEADLINE_MS = 2_000;
const CHAT_CONTROL_REGISTRATION_WAIT_MS = 2_000;
const CHAT_CONTROL_LEASE_RENEW_INTERVAL_MS = 10_000;

type ActiveChatGeneration = {
  generationId: string | null;
  clientMutationId: string | null;
  token: symbol;
  abortController: AbortController | null;
  lifecycle: "starting" | "running" | "closing" | "stopping";
  attemptEpoch: number;
  attemptOwnerToken: string | null;
  control: {
    handle: AgentRuntimeControlHandle;
    attemptEpoch: number;
    ownerToken: string;
  } | null;
  interruptPromise: Promise<AgentRuntimeControlInterruptResult> | null;
  leaseRenewTimer: ReturnType<typeof setInterval> | null;
  controlWaiters: Set<() => void>;
};

const activeChatGenerations = new Map<string, ActiveChatGeneration>();

export interface ChatRuntimeControlPersistenceHooks {
  onAttemptStarted?(input: {
    generationId: string;
    attemptEpoch: number;
    ownerToken: string;
    attempt: AgentRuntimeControlAttempt;
  }): Promise<void>;
  onHandleRegistered?(input: {
    generationId: string;
    attemptEpoch: number;
    ownerToken: string;
    handle: AgentRuntimeControlHandle;
  }): Promise<void>;
  onAttemptCompleted?(input: {
    generationId: string;
    attemptEpoch: number;
    ownerToken: string;
  }): Promise<void>;
  onAttemptLeaseRenewed?(input: {
    generationId: string;
    attemptEpoch: number;
    ownerToken: string;
  }): Promise<void>;
}

function clearLeaseRenewal(active: ActiveChatGeneration) {
  if (!active.leaseRenewTimer) return;
  clearInterval(active.leaseRenewTimer);
  active.leaseRenewTimer = null;
}

function notifyControlStateChanged(active: ActiveChatGeneration) {
  const waiters = [...active.controlWaiters];
  active.controlWaiters.clear();
  for (const resolve of waiters) resolve();
}

export function claimChatGeneration(
  conversationId: string,
  abortController: AbortController | null = null,
  generationId: string | null = null,
  clientMutationId: string | null = null,
): (() => void) | null {
  if (activeChatGenerations.has(conversationId)) return null;

  const token = Symbol(conversationId);
  activeChatGenerations.set(conversationId, {
    token,
    abortController,
    generationId,
    clientMutationId,
    lifecycle: "starting",
    attemptEpoch: 0,
    attemptOwnerToken: null,
    control: null,
    interruptPromise: null,
    leaseRenewTimer: null,
    controlWaiters: new Set(),
  });

  return () => {
    const active = activeChatGenerations.get(conversationId);
    if (active?.token === token) {
      notifyControlStateChanged(active);
      activeChatGenerations.delete(conversationId);
      clearLeaseRenewal(active);
      if (active.control) void active.control.handle.dispose().catch(() => undefined);
    }
  };
}

export function hasActiveChatGeneration(conversationId: string): boolean {
  return activeChatGenerations.has(conversationId);
}

export function getActiveChatGeneration(conversationId: string): {
  generationId: string | null;
  clientMutationId: string | null;
  attemptEpoch: number;
  lifecycle: ActiveChatGeneration["lifecycle"];
  runtimeType: string | null;
} | null {
  const active = activeChatGenerations.get(conversationId);
  if (!active) return null;
  return {
    generationId: active.generationId,
    clientMutationId: active.clientMutationId,
    attemptEpoch: active.attemptEpoch,
    lifecycle: active.lifecycle,
    runtimeType: active.control?.handle.runtimeType ?? null,
  };
}

export function setActiveChatGenerationId(conversationId: string, generationId: string): boolean {
  const active = activeChatGenerations.get(conversationId);
  if (!active) return false;
  active.generationId = generationId;
  return true;
}

async function disposeControl(
  active: ActiveChatGeneration,
  expected?: { attemptEpoch: number; ownerToken: string },
): Promise<void> {
  const control = active.control;
  if (!control) return;
  if (
    expected
    && (control.attemptEpoch !== expected.attemptEpoch || control.ownerToken !== expected.ownerToken)
  ) {
    return;
  }
  active.control = null;
  await control.handle.dispose().catch(() => undefined);
}

function activeAttemptMatches(
  active: ActiveChatGeneration | undefined,
  generationId: string,
  attemptEpoch: number,
  ownerToken: string,
): active is ActiveChatGeneration {
  return Boolean(
    active
    && active.generationId === generationId
    && active.attemptEpoch === attemptEpoch
    && active.attemptOwnerToken === ownerToken,
  );
}

export function createChatRuntimeControlCoordinator(
  conversationId: string,
  generationId: string,
  hooks: ChatRuntimeControlPersistenceHooks = {},
): AgentRuntimeControlCoordinator {
  return {
    async beginAttempt(attempt: AgentRuntimeControlAttempt): Promise<AgentRuntimeControlAttemptLease> {
      const active = activeChatGenerations.get(conversationId);
      if (!active || active.generationId !== generationId) {
        throw new Error("Chat runtime control owner is no longer active");
      }

      await disposeControl(active);
      clearLeaseRenewal(active);
      const attemptEpoch = active.attemptEpoch + 1;
      const ownerToken = randomUUID();
      active.attemptEpoch = attemptEpoch;
      active.attemptOwnerToken = ownerToken;
      active.lifecycle = active.abortController?.signal.aborted ? "stopping" : "starting";
      active.interruptPromise = null;
      let completed = false;
      await hooks.onAttemptStarted?.({ generationId, attemptEpoch, ownerToken, attempt });
      if (!activeAttemptMatches(activeChatGenerations.get(conversationId), generationId, attemptEpoch, ownerToken)) {
        throw new Error("Chat runtime control attempt lost ownership during registration");
      }
      if (hooks.onAttemptLeaseRenewed) {
        active.leaseRenewTimer = setInterval(() => {
          const latest = activeChatGenerations.get(conversationId);
          if (
            !activeAttemptMatches(latest, generationId, attemptEpoch, ownerToken)
            || latest.lifecycle === "closing"
            || latest.lifecycle === "stopping"
          ) {
            if (latest) clearLeaseRenewal(latest);
            return;
          }
          void hooks.onAttemptLeaseRenewed?.({ generationId, attemptEpoch, ownerToken })
            .catch(() => {
              const current = activeChatGenerations.get(conversationId);
              if (activeAttemptMatches(current, generationId, attemptEpoch, ownerToken)) {
                clearLeaseRenewal(current);
                void requestInterrupt(current, "operator_stop");
              }
            });
        }, CHAT_CONTROL_LEASE_RENEW_INTERVAL_MS);
        active.leaseRenewTimer.unref?.();
      }

      return {
        attemptEpoch,
        ownerToken,
        async register(handle: AgentRuntimeControlHandle): Promise<AgentRuntimeControlHandleLease | null> {
          const current = activeChatGenerations.get(conversationId);
          if (
            !activeAttemptMatches(current, generationId, attemptEpoch, ownerToken)
            || current.lifecycle === "stopping"
            || current.abortController?.signal.aborted
            || handle.runtimeType !== attempt.runtimeType
          ) {
            void handle.dispose().catch(() => undefined);
            return null;
          }

          if (current.control) {
            void current.control.handle.dispose().catch(() => undefined);
          }
          current.control = { handle, attemptEpoch, ownerToken };
          current.lifecycle = "running";
          try {
            await hooks.onHandleRegistered?.({
              generationId,
              attemptEpoch,
              ownerToken,
              handle,
            });
          } catch (error) {
            await disposeControl(current, { attemptEpoch, ownerToken });
            throw error;
          }
          if (
            !activeAttemptMatches(
              activeChatGenerations.get(conversationId),
              generationId,
              attemptEpoch,
              ownerToken,
            )
            || activeChatGenerations.get(conversationId)?.lifecycle === "stopping"
          ) {
            await disposeControl(current, { attemptEpoch, ownerToken });
            return null;
          }
          notifyControlStateChanged(current);
          let released = false;
          return {
            isCurrent() {
              const latest = activeChatGenerations.get(conversationId);
              return Boolean(
                !released
                && activeAttemptMatches(latest, generationId, attemptEpoch, ownerToken)
                && latest.control?.handle === handle,
              );
            },
            async release() {
              if (released) return;
              released = true;
              const latest = activeChatGenerations.get(conversationId);
              if (activeAttemptMatches(latest, generationId, attemptEpoch, ownerToken)) {
                await disposeControl(latest, { attemptEpoch, ownerToken });
              } else {
                await handle.dispose().catch(() => undefined);
              }
            },
          };
        },
        async complete() {
          if (completed) return;
          completed = true;
          const current = activeChatGenerations.get(conversationId);
          if (!activeAttemptMatches(current, generationId, attemptEpoch, ownerToken)) return;
          clearLeaseRenewal(current);
          await disposeControl(current, { attemptEpoch, ownerToken });
          if (current.lifecycle !== "stopping") current.lifecycle = "closing";
          notifyControlStateChanged(current);
          await hooks.onAttemptCompleted?.({ generationId, attemptEpoch, ownerToken });
        },
      };
    },
  };
}

export type ActiveChatGenerationSteerResult =
  | ({ status: "delivered_current"; attemptEpoch: number; ownerChangedAfterSend?: true } & Extract<
      AgentRuntimeControlSteerResult,
      { disposition: "accepted_current" }
    >)
  | { status: "acceptance_unknown"; attemptEpoch: number; reason: string; ownerChangedAfterSend?: true }
  | { status: "provider_send_in_flight"; attemptEpoch: number }
  | {
      status: "continuation_required";
      attemptEpoch: number;
      reason: "closing" | "unsupported" | "registration_timeout" | "owner_changed_before_send" | "generation_fence_changed";
    }
  | { status: "stale_generation"; activeGenerationId: string | null };

type ChatSteerProviderSendClaim = {
  clientMessageId: string;
  release(): Promise<void>;
};

type ChatSteerProviderSendDecision = ChatSteerProviderSendClaim | {
  sendDenied: true;
  reason: "generation_fence_changed";
};

async function waitForControlStateChange(
  conversationId: string,
  expectedActive: ActiveChatGeneration,
  timeoutMs: number,
): Promise<"changed" | "timed_out"> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: "changed" | "timed_out") => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      expectedActive.controlWaiters.delete(onChanged);
      resolve(result);
    };
    const onChanged = () => finish("changed");
    const timeout = setTimeout(() => finish("timed_out"), timeoutMs);
    timeout.unref?.();
    expectedActive.controlWaiters.add(onChanged);

    const latest = activeChatGenerations.get(conversationId);
    if (
      latest !== expectedActive
      || latest.control
      || latest.lifecycle === "closing"
      || latest.lifecycle === "stopping"
    ) {
      finish("changed");
    }
  });
}

export async function steerActiveChatGeneration(input: {
  conversationId: string;
  expectedGenerationId: string;
  expectedAttemptEpoch?: number;
  feedback: AgentRuntimeControlSteerInput;
  claimProviderSend?: () => Promise<ChatSteerProviderSendDecision | null>;
  registrationWaitMs?: number;
}): Promise<ActiveChatGenerationSteerResult> {
  const registrationDeadline = Date.now() + (input.registrationWaitMs ?? CHAT_CONTROL_REGISTRATION_WAIT_MS);
  let active = activeChatGenerations.get(input.conversationId);
  if (!active || active.generationId !== input.expectedGenerationId) {
    return {
      status: "stale_generation",
      activeGenerationId: active?.generationId ?? null,
    };
  }
  if (active.lifecycle === "stopping" || active.lifecycle === "closing") {
    return {
      status: "continuation_required",
      attemptEpoch: active.attemptEpoch,
      reason: "closing",
    };
  }
  while (!active.control) {
    const remainingMs = registrationDeadline - Date.now();
    if (remainingMs <= 0) {
      return {
        status: "continuation_required",
        attemptEpoch: active.attemptEpoch,
        reason: "registration_timeout",
      };
    }
    const waitResult = await waitForControlStateChange(input.conversationId, active, remainingMs);
    const latest = activeChatGenerations.get(input.conversationId);
    if (!latest || latest.generationId !== input.expectedGenerationId) {
      return {
        status: "stale_generation",
        activeGenerationId: latest?.generationId ?? null,
      };
    }
    active = latest;
    if (active.lifecycle === "stopping" || active.lifecycle === "closing") {
      return {
        status: "continuation_required",
        attemptEpoch: active.attemptEpoch,
        reason: "closing",
      };
    }
    if (waitResult === "timed_out" && !active.control) {
      return {
        status: "continuation_required",
        attemptEpoch: active.attemptEpoch,
        reason: "registration_timeout",
      };
    }
  }
  const control = active.control;
  if (
    input.expectedAttemptEpoch !== undefined
    && control.attemptEpoch !== input.expectedAttemptEpoch
  ) {
    return {
      status: "continuation_required",
      attemptEpoch: control.attemptEpoch,
      reason: "owner_changed_before_send",
    };
  }
  if (control.handle.capabilities.steer !== "native") {
    return {
      status: "continuation_required",
      attemptEpoch: control.attemptEpoch,
      reason: "unsupported",
    };
  }

  const sendClaim = input.claimProviderSend
    ? await input.claimProviderSend()
    : {
        clientMessageId: input.feedback.clientMessageId,
        release: async () => undefined,
      };
  if (!sendClaim) {
    return { status: "provider_send_in_flight", attemptEpoch: control.attemptEpoch };
  }
  if ("sendDenied" in sendClaim) {
    return {
      status: "continuation_required",
      attemptEpoch: control.attemptEpoch,
      reason: sendClaim.reason,
    };
  }
  const ownerBeforeSend = activeChatGenerations.get(input.conversationId);
  if (
    !activeAttemptMatches(
      ownerBeforeSend,
      input.expectedGenerationId,
      control.attemptEpoch,
      control.ownerToken,
    )
    || ownerBeforeSend.control?.handle !== control.handle
    || ownerBeforeSend.lifecycle !== "running"
  ) {
    try {
      await sendClaim.release();
    } catch (error) {
      return {
        status: "acceptance_unknown",
        attemptEpoch: control.attemptEpoch,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      status: "continuation_required",
      attemptEpoch: control.attemptEpoch,
      reason: "owner_changed_before_send",
    };
  }

  try {
    const result = await control.handle.steer({
      ...input.feedback,
      clientMessageId: sendClaim.clientMessageId,
    });
    const latest = activeChatGenerations.get(input.conversationId);
    const ownerChangedAfterSend = !activeAttemptMatches(
      latest,
      input.expectedGenerationId,
      control.attemptEpoch,
      control.ownerToken,
    ) || latest.control?.handle !== control.handle || latest.lifecycle !== "running";
    if (result.disposition === "accepted_current") {
      return {
        ...result,
        status: "delivered_current",
        attemptEpoch: control.attemptEpoch,
        ...(ownerChangedAfterSend ? { ownerChangedAfterSend: true as const } : {}),
      };
    }
    if (result.disposition === "acceptance_unknown") {
      return {
        status: "acceptance_unknown",
        attemptEpoch: control.attemptEpoch,
        reason: result.reason,
        ...(ownerChangedAfterSend ? { ownerChangedAfterSend: true as const } : {}),
      };
    }
    return {
      status: "continuation_required",
      attemptEpoch: control.attemptEpoch,
      reason: result.disposition,
    };
  } catch (error) {
    const latest = activeChatGenerations.get(input.conversationId);
    const ownerChangedAfterSend = !activeAttemptMatches(
      latest,
      input.expectedGenerationId,
      control.attemptEpoch,
      control.ownerToken,
    ) || latest.control?.handle !== control.handle || latest.lifecycle !== "running";
    return {
      status: "acceptance_unknown",
      attemptEpoch: control.attemptEpoch,
      reason: error instanceof Error ? error.message : String(error),
      ...(ownerChangedAfterSend ? { ownerChangedAfterSend: true as const } : {}),
    };
  }
}

function requestInterrupt(
  active: ActiveChatGeneration,
  reason: AgentRuntimeControlInterruptReason,
): Promise<AgentRuntimeControlInterruptResult> {
  if (active.interruptPromise) return active.interruptPromise;
  const handle = active.control?.handle ?? null;
  active.lifecycle = "stopping";
  notifyControlStateChanged(active);
  if (active.abortController && !active.abortController.signal.aborted) {
    active.abortController.abort(
      createOperatorInterruptAbortReason(CHAT_OPERATOR_INTERRUPT_HARD_DEADLINE_MS),
    );
  }
  active.interruptPromise = handle
    ? handle.interrupt(reason).catch(() => "unverified" as const)
    : Promise.resolve(active.abortController ? "acknowledged" as const : "unverified" as const);
  return active.interruptPromise;
}

export function interruptActiveChatGeneration(
  conversationId: string,
  reason: AgentRuntimeControlInterruptReason,
): Promise<AgentRuntimeControlInterruptResult> | null {
  const active = activeChatGenerations.get(conversationId);
  if (!active) return null;
  return requestInterrupt(active, reason);
}

export function cancelActiveChatGeneration(conversationId: string): boolean {
  const active = activeChatGenerations.get(conversationId);
  if (!active?.abortController) return false;
  void requestInterrupt(active, "operator_stop");
  return true;
}

export function cancelAndReleaseActiveChatGeneration(conversationId: string): boolean {
  const active = activeChatGenerations.get(conversationId);
  if (!active) return false;
  void requestInterrupt(active, "operator_stop");
  notifyControlStateChanged(active);
  activeChatGenerations.delete(conversationId);
  clearLeaseRenewal(active);
  if (active.control) void active.control.handle.dispose().catch(() => undefined);
  return true;
}

export function clearActiveChatGenerationsForTest() {
  if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") return;
  for (const active of activeChatGenerations.values()) {
    notifyControlStateChanged(active);
    clearLeaseRenewal(active);
    if (active.control) void active.control.handle.dispose().catch(() => undefined);
  }
  activeChatGenerations.clear();
}
