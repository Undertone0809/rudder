import type {
  AgentRuntimeTransientInputKind,
  AgentRuntimeTransientInputResult,
} from "@rudderhq/agent-runtime-utils";
import { randomUUID } from "node:crypto";

const DEFAULT_MAX_PENDING_REQUESTS = 32;
const HARD_MAX_PENDING_REQUESTS = 128;
const DEFAULT_MAX_COMPLETED_REQUESTS = 256;
const HARD_MAX_COMPLETED_REQUESTS = 2_048;
const DEFAULT_TIMEOUT_MS = 120_000;
const HARD_MAX_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_COMPLETED_RETENTION_MS = 10 * 60_000;
const HARD_MAX_COMPLETED_RETENTION_MS = 60 * 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const HARD_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_ID_LENGTH = 256;

export type ChatRuntimeSensitiveInputRunBinding = Readonly<{
  orgId: string;
  chatId: string;
  runId: string;
  attemptId: string;
}>;

export type ChatRuntimeSensitiveInputBinding = ChatRuntimeSensitiveInputRunBinding & Readonly<{
  principalId: string;
}>;

export type ChatRuntimeSensitiveInputKind = AgentRuntimeTransientInputKind;

export type ChatRuntimeSensitiveInputMetadata = Readonly<{
  requestId: string;
  binding: ChatRuntimeSensitiveInputBinding;
  kind: ChatRuntimeSensitiveInputKind;
}>;

export type ChatRuntimeSensitiveInputResult = AgentRuntimeTransientInputResult;

export type ChatRuntimeSensitiveInputRequest = Readonly<{
  binding: ChatRuntimeSensitiveInputRunBinding;
  kind: ChatRuntimeSensitiveInputKind;
  signal?: AbortSignal;
}>;

export type ChatRuntimeSensitiveInputRequestHandler = (
  input: ChatRuntimeSensitiveInputRequest,
) => Promise<ChatRuntimeSensitiveInputResult>;

export type ChatRuntimeSensitiveInputBrokerErrorCode =
  | "chat_runtime_sensitive_input_invalid_request"
  | "chat_runtime_sensitive_input_capacity"
  | "chat_runtime_sensitive_input_not_pending"
  | "chat_runtime_sensitive_input_binding_mismatch"
  | "chat_runtime_sensitive_input_invalid_value"
  | "chat_runtime_sensitive_input_publish_failed";

const ERROR_MESSAGES: Record<ChatRuntimeSensitiveInputBrokerErrorCode, string> = {
  chat_runtime_sensitive_input_invalid_request: "Sensitive input request is invalid.",
  chat_runtime_sensitive_input_capacity: "Sensitive input broker is at capacity.",
  chat_runtime_sensitive_input_not_pending: "Sensitive input request is no longer pending.",
  chat_runtime_sensitive_input_binding_mismatch: "Sensitive input request binding does not match.",
  chat_runtime_sensitive_input_invalid_value: "Sensitive input response is invalid.",
  chat_runtime_sensitive_input_publish_failed: "Sensitive input request could not be published.",
};

export class ChatRuntimeSensitiveInputBrokerError extends Error {
  constructor(readonly code: ChatRuntimeSensitiveInputBrokerErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ChatRuntimeSensitiveInputBrokerError";
  }

  toJSON() {
    return { code: this.code, message: this.message };
  }
}

type PendingRequest = {
  metadata: ChatRuntimeSensitiveInputMetadata;
  resolve: (result: ChatRuntimeSensitiveInputResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
  signal?: AbortSignal;
  onAbort?: () => void;
};

type CompletedRequest = {
  binding: ChatRuntimeSensitiveInputBinding;
  status: ChatRuntimeSensitiveInputResult["status"];
  expiresAt: number;
};

export type CreateChatRuntimeSensitiveInputBrokerOptions = {
  publishRequest?: (metadata: ChatRuntimeSensitiveInputMetadata) => void;
  maxPendingRequests?: number;
  maxCompletedRequests?: number;
  completedRetentionMs?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

function isValidIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_ID_LENGTH
    && value.trim() === value;
}

function readBinding(value: unknown): ChatRuntimeSensitiveInputBinding | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const principalId = candidate.principalId;
  const orgId = candidate.orgId;
  const chatId = candidate.chatId;
  const runId = candidate.runId;
  const attemptId = candidate.attemptId;
  if (!isValidIdentifier(principalId)
    || !isValidIdentifier(orgId)
    || !isValidIdentifier(chatId)
    || !isValidIdentifier(runId)
    || !isValidIdentifier(attemptId)) {
    return null;
  }
  return Object.freeze({
    principalId,
    orgId,
    chatId,
    runId,
    attemptId,
  });
}

function sameBinding(left: ChatRuntimeSensitiveInputBinding, right: ChatRuntimeSensitiveInputBinding): boolean {
  return left.principalId === right.principalId
    && left.orgId === right.orgId
    && left.chatId === right.chatId
    && left.runId === right.runId
    && left.attemptId === right.attemptId;
}

function boundedOption(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw new ChatRuntimeSensitiveInputBrokerError("chat_runtime_sensitive_input_invalid_request");
  }
  return selected;
}

export function createChatRuntimeSensitiveInputBroker(
  options: CreateChatRuntimeSensitiveInputBrokerOptions,
) {
  const maxPendingRequests = boundedOption(
    options.maxPendingRequests,
    DEFAULT_MAX_PENDING_REQUESTS,
    HARD_MAX_PENDING_REQUESTS,
  );
  const maxCompletedRequests = boundedOption(
    options.maxCompletedRequests,
    DEFAULT_MAX_COMPLETED_REQUESTS,
    HARD_MAX_COMPLETED_REQUESTS,
  );
  const completedRetentionMs = boundedOption(
    options.completedRetentionMs,
    DEFAULT_COMPLETED_RETENTION_MS,
    HARD_MAX_COMPLETED_RETENTION_MS,
  );
  const timeoutMs = boundedOption(options.timeoutMs, DEFAULT_TIMEOUT_MS, HARD_MAX_TIMEOUT_MS);
  const maxResponseBytes = boundedOption(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    HARD_MAX_RESPONSE_BYTES,
  );
  const pending = new Map<string, PendingRequest>();
  const completed = new Map<string, CompletedRequest>();

  function pruneCompleted(now = Date.now()) {
    for (const [requestId, request] of completed) {
      if (request.expiresAt > now) continue;
      completed.delete(requestId);
    }
  }

  function rememberCompleted(request: PendingRequest, status: CompletedRequest["status"]) {
    pruneCompleted();
    completed.set(request.metadata.requestId, {
      binding: request.metadata.binding,
      status,
      expiresAt: Date.now() + completedRetentionMs,
    });
    while (completed.size > maxCompletedRequests) {
      const oldestRequestId = completed.keys().next().value;
      if (oldestRequestId === undefined) break;
      completed.delete(oldestRequestId);
    }
  }

  function getCompleted(requestId: string) {
    pruneCompleted();
    return completed.get(requestId);
  }

  function finish(request: PendingRequest, result: ChatRuntimeSensitiveInputResult): boolean {
    if (pending.get(request.metadata.requestId) !== request) return false;
    pending.delete(request.metadata.requestId);
    if (request.timer) clearTimeout(request.timer);
    if (request.signal && request.onAbort) {
      request.signal.removeEventListener("abort", request.onAbort);
    }
    rememberCompleted(request, result.status);
    request.resolve(result);
    return true;
  }

  return {
    request(input: {
      binding: ChatRuntimeSensitiveInputBinding;
      kind: ChatRuntimeSensitiveInputKind;
      signal?: AbortSignal;
      onRequest?: (metadata: ChatRuntimeSensitiveInputMetadata) => void;
    }): { requestId: string; result: Promise<ChatRuntimeSensitiveInputResult> } {
      const binding = readBinding(input?.binding);
      if (!binding || (input.kind !== "secret" && input.kind !== "sudo")) {
        throw new ChatRuntimeSensitiveInputBrokerError("chat_runtime_sensitive_input_invalid_request");
      }
      if (pending.size >= maxPendingRequests) {
        throw new ChatRuntimeSensitiveInputBrokerError("chat_runtime_sensitive_input_capacity");
      }

      let requestId = randomUUID();
      pruneCompleted();
      while (pending.has(requestId) || completed.has(requestId)) requestId = randomUUID();

      let resolve!: (result: ChatRuntimeSensitiveInputResult) => void;
      const result = new Promise<ChatRuntimeSensitiveInputResult>((resolveResult) => {
        resolve = resolveResult;
      });
      const metadata: ChatRuntimeSensitiveInputMetadata = Object.freeze({
        requestId,
        binding,
        kind: input.kind,
      });
      const request: PendingRequest = {
        metadata,
        resolve,
        timer: null,
        ...(input.signal ? { signal: input.signal } : {}),
      };
      request.timer = setTimeout(() => {
        finish(request, { status: "timed_out" });
      }, timeoutMs);
      pending.set(requestId, request);

      if (input.signal) {
        request.onAbort = () => finish(request, { status: "aborted" });
        if (input.signal.aborted) {
          request.onAbort();
        } else {
          input.signal.addEventListener("abort", request.onAbort, { once: true });
          if (input.signal.aborted) request.onAbort();
        }
      }

      if (pending.has(requestId)) {
        const publishRequest = input.onRequest ?? options.publishRequest;
        if (!publishRequest) {
          finish(request, { status: "cancelled" });
          throw new ChatRuntimeSensitiveInputBrokerError("chat_runtime_sensitive_input_publish_failed");
        }
        try {
          publishRequest(metadata);
        } catch {
          if (finish(request, { status: "cancelled" })) {
            throw new ChatRuntimeSensitiveInputBrokerError("chat_runtime_sensitive_input_publish_failed");
          }
        }
      }

      return { requestId, result };
    },

    respond(input: {
      requestId: string;
      binding: ChatRuntimeSensitiveInputBinding;
      value: unknown;
    }): "accepted" | "already_accepted" {
      try {
        const requestId = typeof input?.requestId === "string" && input.requestId.length <= 128
          ? input.requestId
          : "";
        const binding = readBinding(input.binding);
        const request = pending.get(requestId);
        if (!request) {
          const previous = getCompleted(requestId);
          if (previous && (!binding || !sameBinding(previous.binding, binding))) {
            throw new ChatRuntimeSensitiveInputBrokerError("chat_runtime_sensitive_input_binding_mismatch");
          }
          if (previous?.status === "provided") return "already_accepted";
          throw new ChatRuntimeSensitiveInputBrokerError("chat_runtime_sensitive_input_not_pending");
        }
        if (!binding || !sameBinding(request.metadata.binding, binding)) {
          throw new ChatRuntimeSensitiveInputBrokerError("chat_runtime_sensitive_input_binding_mismatch");
        }
        acceptResponse(request, input.value);
        return "accepted";
      } catch (error) {
        if (error instanceof ChatRuntimeSensitiveInputBrokerError) throw error;
        throw new ChatRuntimeSensitiveInputBrokerError("chat_runtime_sensitive_input_invalid_value");
      }
    },

    respondFromPrincipal(input: {
      requestId: string;
      orgId: string;
      chatId: string;
      principalId: string;
      value: unknown;
    }): "accepted" | "already_accepted" {
      const requestId = typeof input?.requestId === "string" && input.requestId.length <= 128
        ? input.requestId
        : "";
      const request = pending.get(requestId);
      const matchesPrincipalChat = (binding: ChatRuntimeSensitiveInputBinding) => (
        binding.orgId === input.orgId
        && binding.chatId === input.chatId
        && binding.principalId === input.principalId
      );
      if (!request) {
        const previous = getCompleted(requestId);
        if (previous && !matchesPrincipalChat(previous.binding)) {
          throw new ChatRuntimeSensitiveInputBrokerError("chat_runtime_sensitive_input_binding_mismatch");
        }
        if (previous?.status === "provided") return "already_accepted";
        throw new ChatRuntimeSensitiveInputBrokerError("chat_runtime_sensitive_input_not_pending");
      }
      if (!matchesPrincipalChat(request.metadata.binding)) {
        throw new ChatRuntimeSensitiveInputBrokerError("chat_runtime_sensitive_input_binding_mismatch");
      }
      acceptResponse(request, input.value);
      return "accepted";
    },

    cancel(input: { requestId: string; binding: ChatRuntimeSensitiveInputBinding }): boolean {
      const request = pending.get(input.requestId);
      const binding = readBinding(input.binding);
      if (!binding) return false;
      if (!request) {
        const previous = getCompleted(input.requestId);
        return Boolean(previous?.status === "cancelled" && sameBinding(previous.binding, binding));
      }
      if (!sameBinding(request.metadata.binding, binding)) return false;
      return finish(request, { status: "cancelled" });
    },

    cancelFromPrincipal(input: {
      requestId: string;
      orgId: string;
      chatId: string;
      principalId: string;
    }): boolean {
      const request = pending.get(input.requestId);
      const matchesPrincipalChat = (binding: ChatRuntimeSensitiveInputBinding) => (
        binding.orgId === input.orgId
        && binding.chatId === input.chatId
        && binding.principalId === input.principalId
      );
      if (!request) {
        const previous = getCompleted(input.requestId);
        return Boolean(previous?.status === "cancelled" && matchesPrincipalChat(previous.binding));
      }
      if (!matchesPrincipalChat(request.metadata.binding)) return false;
      return finish(request, { status: "cancelled" });
    },

    pendingForPrincipal(input: { orgId: string; chatId: string; principalId: string }) {
      if (!isValidIdentifier(input.orgId)
        || !isValidIdentifier(input.chatId)
        || !isValidIdentifier(input.principalId)) return [];
      return [...pending.values()]
        .filter(({ metadata }) => metadata.binding.orgId === input.orgId
          && metadata.binding.chatId === input.chatId
          && metadata.binding.principalId === input.principalId)
        .map(({ metadata }) => metadata);
    },

    get pendingCount(): number {
      return pending.size;
    },
  };

  function acceptResponse(request: PendingRequest, value: unknown) {
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxResponseBytes) {
      throw new ChatRuntimeSensitiveInputBrokerError("chat_runtime_sensitive_input_invalid_value");
    }
    if (!finish(request, { status: "provided", value })) {
      throw new ChatRuntimeSensitiveInputBrokerError("chat_runtime_sensitive_input_not_pending");
    }
  }
}

export const chatRuntimeSensitiveInputBroker = createChatRuntimeSensitiveInputBroker({
  publishRequest: () => undefined,
});
