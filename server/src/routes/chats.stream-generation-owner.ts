import { logger } from "../middleware/logger.js";
import { getActiveChatGeneration } from "../services/chat-generation-locks.js";
import type { chatGenerationProtocolService } from "../services/chat-generation-protocol.js";

export type ChatStreamAttemptFence = {
  attemptEpoch: number;
  ownerToken: string | null;
};

export function isChatGenerationFenceRejected(error: unknown) {
  if (!error || typeof error !== "object" || !("status" in error) || Number(error.status) !== 409) {
    return false;
  }
  return "message" in error && (
    error.message === "Chat generation runtime attempt changed"
    || error.message === "Chat generation control owner changed"
  );
}

export function createChatStreamGenerationOwner(input: {
  conversationId: string;
  generation: {
    id: string;
    attemptEpoch?: number | null;
    controlOwnerToken?: string | null;
  } | null;
}) {
  let currentFence: ChatStreamAttemptFence = {
    attemptEpoch: input.generation?.attemptEpoch ?? 1,
    ownerToken: input.generation?.controlOwnerToken ?? null,
  };
  let terminalFence: ChatStreamAttemptFence | null = null;
  let stale = false;

  return {
    get fence() {
      return currentFence;
    },
    get stale() {
      return stale;
    },
    get terminalFence() {
      return terminalFence ?? currentFence;
    },
    capture() {
      return currentFence;
    },
    update(fence: ChatStreamAttemptFence) {
      currentFence = fence;
    },
    captureTerminal(fence: ChatStreamAttemptFence) {
      terminalFence = fence;
    },
    markStale() {
      stale = true;
    },
    rejectFenceError(error: unknown) {
      if (!isChatGenerationFenceRejected(error)) return false;
      stale = true;
      return true;
    },
    isCurrent(fence: ChatStreamAttemptFence) {
      if (stale) return false;
      const active = getActiveChatGeneration(input.conversationId);
      if (!input.generation?.id || !active || active.generationId !== input.generation.id) {
        stale = true;
        return false;
      }
      const current = (active.attemptEpoch === fence.attemptEpoch
        && active.attemptOwnerToken === fence.ownerToken)
        || (active.attemptEpoch === 0 && fence.attemptEpoch === 1 && fence.ownerToken === null);
      if (!current) stale = true;
      return current;
    },
  };
}

type ProjectionScope = {
  protocol: Pick<ReturnType<typeof chatGenerationProtocolService>, "withGenerationProjectionFence">;
  orgId: string;
  conversationId: string;
  generationId: string;
  fence: ChatStreamAttemptFence;
};

export async function persistOwnedChatStreamProjection<T>(input: {
  scope: ProjectionScope | null;
  projection: "completed" | "stopped" | "failed";
  persist: () => Promise<T>;
  link: (value: T) => Promise<unknown>;
  log: (value: T) => Promise<unknown>;
}): Promise<T> {
  const project = async () => {
    const value = await input.persist();
    await input.link(value);
    await input.log(value);
    return value;
  };
  if (!input.scope) return project();
  const { protocol, fence, ...scope } = input.scope;
  return protocol.withGenerationProjectionFence({
    ...scope,
    expectedAttemptEpoch: fence.attemptEpoch,
    expectedOwnerToken: fence.ownerToken,
    projection: input.projection,
    project,
  });
}

export async function retryStoppedChatStreamProjection<T>(input: Omit<
  Parameters<typeof persistOwnedChatStreamProjection<T>>[0], "projection"
> & {
  onStale: () => void;
  onRetryError: (error: unknown, attempt: number) => void;
}): Promise<T | null> {
  const persist = async () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await input.persist();
      } catch (error) {
        input.onRetryError(error, attempt);
        if (attempt === 3) throw error;
        await Promise.resolve();
      }
    }
    throw new Error("Stopped Chat projection retry exhausted");
  };
  try {
    return await persistOwnedChatStreamProjection({ ...input, persist, projection: "stopped" });
  } catch (error) {
    if (isChatGenerationFenceRejected(error)) {
      input.onStale();
      return null;
    }
    throw error;
  }
}

export async function persistChatStreamGenerationTerminal(input: {
  svc: any;
  orgId: string;
  conversationId: string;
  generation: { id: string } | null;
  generationWaitingForNetwork: boolean;
  generationOwner: ReturnType<typeof createChatStreamGenerationOwner>;
  generationTerminalStatus: "completed" | "failed" | "stopped" | "aborted";
  assistantMessageId: string | null;
  runId: string | null;
  queuedMessageId: string | null;
  wakeTerminalProjector: () => void;
}) {
  const terminalFence = input.generationOwner.terminalFence;
  const canFinalize = !input.generationWaitingForNetwork
    && input.generationOwner.isCurrent(terminalFence);
  if (input.generation && canFinalize) {
    await input.svc.generationProtocol.recordRuntimeTerminal({
      orgId: input.orgId,
      conversationId: input.conversationId,
      generationId: input.generation.id,
      expectedAttemptEpoch: terminalFence.attemptEpoch,
      expectedOwnerToken: terminalFence.ownerToken,
      finalStatus: input.generationTerminalStatus,
      terminalReason: input.generationTerminalStatus === "stopped"
        ? "operator_stop"
        : input.generationTerminalStatus,
      payload: {
        assistantMessageId: input.assistantMessageId,
        runId: input.runId,
      },
    }).then(() => input.wakeTerminalProjector()).catch((error: unknown) => {
      if (input.generationOwner.rejectFenceError(error)) return;
      logger.warn(
        { err: error, generationId: input.generation?.id },
        "failed to record chat generation terminal evidence",
      );
    });
  }
  if (input.queuedMessageId && canFinalize && input.generationOwner.isCurrent(terminalFence)) {
    await input.svc.markQueuedMessageDeliveryTerminal({
      conversationId: input.conversationId,
      itemId: input.queuedMessageId,
      status: input.generationTerminalStatus,
    }).catch((error: unknown) => {
      logger.warn(
        { err: error, queuedMessageId: input.queuedMessageId },
        "failed to mark queued chat message terminal",
      );
    });
  }
}
