import type {
  ChatAttachment,
  ChatContextLink,
  ChatConversation,
  ChatGenerationStatus,
  ChatInlineAnnotationInput,
  ChatIssueCreationMode,
  ChatMessage,
  ChatOperationProposalDecisionAction,
  ChatQueueClaimResponse,
  ChatQueueSnapshot,
  ChatQueuedMessage,
  ChatQueuedMessagePayload,
  ChatQueuedMessagePayloadInput,
  ChatRuntimeDescriptor,
  ChatSteerResponse,
  ChatStreamEvent,
  ChatStreamTranscriptEntry,
  ChatWorkManifestResponse,
  ForkChatConversation,
  HeartbeatRunStatus,
} from "@rudderhq/shared";
import {
  ApiError,
  ApiTimeoutError,
  api,
  createRequestSignal,
} from "./client";

export const CHAT_REQUEST_TIMEOUT_MS = 15_000;
export const CHAT_STREAM_IDLE_TIMEOUT_MS = 45_000;

export type ChatStopMessageStreamRequest = {
  controlActionId: string;
  expectedGenerationId?: string;
  expectedAttemptEpoch?: number;
  expectedControlVersion?: number;
  lastCommittedRenderSeq?: number;
  renderedBodyHash?: string;
};

export type ChatClientCheckpointRequest = {
  generationId: string;
  attemptEpoch: number;
  generationSeq: number;
  renderedBodyHash: string;
};

export type ChatSteerQueuedMessageRequest = {
  expectedActiveGenerationId?: string | null;
  controlActionId: string;
  expectedAttemptEpoch?: number;
  expectedControlVersion?: number;
  lastCommittedRenderSeq?: number;
  renderedBodyHash?: string;
};

export type ChatDraftRequest = {
  preferredAgentId: string;
  modelOverride?: string | null;
  effortOverride?: string | null;
  issueCreationMode: ChatIssueCreationMode;
  planMode: boolean;
  contextLinks: Array<{ entityType: "issue" | "project" | "agent" | "goal"; entityId: string }>;
};

export type ChatFirstMessageStreamOptions = ChatDraftRequest & {
  signal?: AbortSignal;
  files?: File[];
  groupId?: string;
  clientMutationId?: string;
  inlineAnnotations?: ChatInlineAnnotationInput[];
  onEvent: (event: ChatStreamEvent) => Promise<void> | void;
};

export type ChatMessageSendReconciliation =
  | { outcome: "not_found"; clientMutationId: string }
  | {
    outcome: "accepted";
    clientMutationId: string;
    message: ChatMessage;
    generationId: string;
    runId: string;
    attemptEpoch: number;
    generationSeq: 0;
    bodyHash: string;
    generationStatus: ChatGenerationStatus;
    runStatus: HeartbeatRunStatus;
    runtimeTerminal: boolean;
  };

export type NativeChatCapabilities = {
  executionAuthority: "native_rust";
  firstSend: boolean;
  readTurn: boolean;
  nativeControls: boolean;
};

export type NativeChatTurnRead = {
  executionAuthority: "native_rust";
  generationId: string;
  runId: string;
  sourceMessage: ChatMessage;
  assistantMessage: ChatMessage | null;
  generationStatus: ChatGenerationStatus;
  runStatus: HeartbeatRunStatus;
  executionOwnerLive: boolean | null;
  attemptEpoch: number;
  controlVersion: number;
  runtimeTerminal: boolean;
  nativeAdmissionHold: boolean;
  lastSequence: number;
  lastClientCheckpointSeq: number | null;
  lastClientCheckpointHash: string | null;
} | {
  executionAuthority: "legacy_ts";
  generationId: string;
  attemptEpoch: number;
  controlVersion: number;
};

export type NativeChatControlRead = {
  executionAuthority: "native_rust" | "legacy_ts";
  orgId: string;
  conversationId: string;
  generationId: string;
  attemptEpoch: number;
  controlVersion: number;
  lastClientCheckpointSeq: number | null;
  lastClientCheckpointHash: string | null;
  lastSequence: number;
  runtimeTerminal: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isChatMessageProjection(value: unknown): value is ChatMessage {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.orgId === "string"
    && typeof value.conversationId === "string"
    && typeof value.role === "string"
    && typeof value.kind === "string"
    && typeof value.status === "string"
    && typeof value.body === "string";
}

const CHAT_GENERATION_STATUSES = new Set<ChatGenerationStatus>([
  "starting", "active", "running", "waiting_for_network", "tool_busy", "closing",
  "stop_requested", "stopping", "completed", "failed", "stopped", "aborted",
  "interrupted_unverified", "control_lost",
]);
const HEARTBEAT_RUN_STATUSES = new Set<HeartbeatRunStatus>([
  "queued", "running", "succeeded", "failed", "cancelled", "timed_out",
]);

function parseNativeChatTurnRead(
  value: unknown,
  chatId: string,
  orgId: string,
  generationId: string,
): NativeChatTurnRead {
  if (!isRecord(value) || value.generationId !== generationId) {
    throw new Error("Native Chat returned a mismatched turn fence");
  }
  if (value.executionAuthority === "legacy_ts") {
    if (
      !Number.isInteger(value.attemptEpoch)
      || Number(value.attemptEpoch) < 1
      || !Number.isInteger(value.controlVersion)
      || Number(value.controlVersion) < 0
    ) {
      throw new Error("Legacy Chat returned an invalid turn epoch");
    }
    return {
      executionAuthority: "legacy_ts",
      generationId,
      attemptEpoch: Number(value.attemptEpoch),
      controlVersion: Number(value.controlVersion),
    };
  }
  if (
    value.executionAuthority !== "native_rust"
    || typeof value.runId !== "string"
    || !isChatMessageProjection(value.sourceMessage)
    || value.sourceMessage.role !== "user"
    || value.sourceMessage.conversationId !== chatId
    || value.sourceMessage.orgId !== orgId
    || (value.assistantMessage !== null && !isChatMessageProjection(value.assistantMessage))
    || (value.assistantMessage !== null && value.assistantMessage.role !== "assistant")
    || (value.assistantMessage !== null && value.assistantMessage.conversationId !== chatId)
    || (value.assistantMessage !== null && value.assistantMessage.orgId !== orgId)
    || typeof value.generationStatus !== "string"
    || !CHAT_GENERATION_STATUSES.has(value.generationStatus as ChatGenerationStatus)
    || typeof value.runStatus !== "string"
    || !HEARTBEAT_RUN_STATUSES.has(value.runStatus as HeartbeatRunStatus)
    || !(value.executionOwnerLive === null || typeof value.executionOwnerLive === "boolean")
    || !Number.isInteger(value.attemptEpoch)
    || Number(value.attemptEpoch) < 1
    || !Number.isInteger(value.controlVersion)
    || Number(value.controlVersion) < 0
    || typeof value.runtimeTerminal !== "boolean"
    || typeof value.nativeAdmissionHold !== "boolean"
    || !Number.isInteger(value.lastSequence)
    || Number(value.lastSequence) < 0
    || !(value.lastClientCheckpointSeq === null || (
      Number.isInteger(value.lastClientCheckpointSeq)
      && Number(value.lastClientCheckpointSeq) >= 0
      && Number(value.lastClientCheckpointSeq) <= Number(value.lastSequence)
    ))
    || !(value.lastClientCheckpointHash === null || (
      typeof value.lastClientCheckpointHash === "string"
      && /^[0-9a-f]{64}$/u.test(value.lastClientCheckpointHash)
    ))
    || ((value.lastClientCheckpointSeq === null) !== (value.lastClientCheckpointHash === null))
  ) {
    throw new Error("Native Chat returned an invalid turn projection");
  }
  return value as NativeChatTurnRead;
}

function parseNativeChatControlRead(
  value: unknown,
  chatId: string,
  orgId: string,
  generationId: string,
): NativeChatControlRead {
  const keys = [
    "executionAuthority",
    "orgId",
    "conversationId",
    "generationId",
    "attemptEpoch",
    "controlVersion",
    "lastClientCheckpointSeq",
    "lastClientCheckpointHash",
    "lastSequence",
    "runtimeTerminal",
  ];
  if (!isRecord(value) || Object.keys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key))
    || value.orgId !== orgId
    || value.conversationId !== chatId
    || value.generationId !== generationId
    || (value.executionAuthority !== "native_rust" && value.executionAuthority !== "legacy_ts")
    || !Number.isSafeInteger(value.attemptEpoch)
    || Number(value.attemptEpoch) < 1
    || !Number.isSafeInteger(value.controlVersion)
    || Number(value.controlVersion) < 0
    || !Number.isSafeInteger(value.lastSequence)
    || Number(value.lastSequence) < 0
    || typeof value.runtimeTerminal !== "boolean"
    || !(value.lastClientCheckpointSeq === null || (
      Number.isSafeInteger(value.lastClientCheckpointSeq)
      && Number(value.lastClientCheckpointSeq) >= 0
      && Number(value.lastClientCheckpointSeq) <= Number(value.lastSequence)
    ))
    || !(value.lastClientCheckpointHash === null || (
      typeof value.lastClientCheckpointHash === "string"
      && /^[0-9a-f]{64}$/u.test(value.lastClientCheckpointHash)
    ))
    || ((value.lastClientCheckpointSeq === null) !== (value.lastClientCheckpointHash === null))
    || (value.executionAuthority === "legacy_ts"
      && (value.lastClientCheckpointSeq !== null || value.lastClientCheckpointHash !== null))) {
    throw new Error("Native Chat returned an invalid control fence");
  }
  return value as NativeChatControlRead;
}

export type NativeFirstSendInput = {
  clientMutationId: string;
  body: string;
  preferredAgentId: string | null;
  title: string | null;
  issueCreationMode: ChatIssueCreationMode;
  modelOverride: string | null;
  effortOverride: string | null;
};

export type NativeFirstSendReconciliation =
  | { outcome: "not_found"; clientMutationId: string }
  | {
    outcome: "accepted";
    clientMutationId: string;
    conversation: ChatConversation;
    message: ChatMessage;
    generationId: string;
    runId: string;
    attemptEpoch: number;
    generationSeq: 0;
    bodyHash: string;
    generationStatus: ChatGenerationStatus;
    runStatus: HeartbeatRunStatus;
    runtimeTerminal: boolean;
  };

function isNativeChatCapabilities(value: unknown): value is NativeChatCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).sort().join(",") === "executionAuthority,firstSend,nativeControls,readTurn"
    && candidate.executionAuthority === "native_rust"
    && typeof candidate.firstSend === "boolean"
    && typeof candidate.readTurn === "boolean"
    && typeof candidate.nativeControls === "boolean";
}


function isNativeFirstSendConversation(
  value: unknown,
  expectedOrgId: string,
  expectedMutationId: string,
): value is ChatConversation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ChatConversation>;
  const conversationKeys = [
    "id", "orgId", "status", "conversationKind", "messengerVisible", "sideChatState",
    "sideChatExpiresAt", "sideChatCompletedAt", "sideChatKeptAt", "sideChatClientMutationId",
    "initialClientMutationId", "mutability", "title", "summary", "latestReplyPreview",
    "latestUserMessagePreview", "userMessageCount", "preferredAgentId", "modelOverride",
    "effortOverride", "routedAgentId", "primaryIssueId", "forkedFromConversationId",
    "forkedFromMessageId", "forkRootConversationId", "primaryIssue", "issueCreationMode",
    "planMode", "createdByUserId", "lastMessageAt", "lastReadAt", "isPinned", "isUnread",
    "unreadCount", "needsAttention", "resolvedAt", "contextLinks", "sourceMetadata",
    "chatRuntime", "createdAt", "updatedAt",
  ].sort().join(",");
  if (Object.keys(candidate).sort().join(",") !== conversationKeys) return false;
  const runtime = candidate.chatRuntime;
  if (!runtime || typeof runtime !== "object"
    || Object.keys(runtime).sort().join(",") !== "agentRuntimeType,available,effort,error,model,runtimeAgentId,sourceLabel,sourceType") {
    return false;
  }
  const valid = typeof candidate.id === "string"
    && candidate.orgId === expectedOrgId
    && (candidate.status === "active" || candidate.status === "resolved" || candidate.status === "archived")
    && candidate.conversationKind === "chat"
    && candidate.mutability === "native_chat"
    && candidate.initialClientMutationId === expectedMutationId
    && typeof candidate.title === "string"
    && (candidate.preferredAgentId === null || typeof candidate.preferredAgentId === "string")
    && typeof candidate.planMode === "boolean"
    && Array.isArray(candidate.contextLinks)
    && (candidate.summary === null || typeof candidate.summary === "string")
    && (candidate.latestReplyPreview === null || typeof candidate.latestReplyPreview === "string")
    && (candidate.latestUserMessagePreview === null || typeof candidate.latestUserMessagePreview === "string")
    && typeof candidate.userMessageCount === "number"
    && Number.isSafeInteger(candidate.userMessageCount)
    && candidate.userMessageCount >= 0
    && runtime?.sourceType === "agent"
    && typeof runtime.sourceLabel === "string"
    && runtime.runtimeAgentId === candidate.preferredAgentId
    && (runtime.model === null || typeof runtime.model === "string")
    && (runtime.effort == null || typeof runtime.effort === "string")
    && ((runtime.available === true
      && (runtime.agentRuntimeType === "codex_local" || runtime.agentRuntimeType === "hermes_local")
      && typeof runtime.runtimeAgentId === "string"
      && runtime.error === null)
      || (runtime.available === false
        && runtime.agentRuntimeType === null
        && runtime.model === null
        && runtime.effort === null
        && runtime.error === "Refresh this chat to load its current Agent."));
  return valid;
}

async function consumeChatStreamResponse(
  res: Response,
  onEvent: (event: ChatStreamEvent) => Promise<void> | void,
) {
  if (!res.ok) {
    const errorBody = await res.json().catch(() => null);
    throw new ApiError(
      (errorBody as { error?: string } | null)?.error ?? `Request failed: ${res.status}`,
      res.status,
      errorBody,
    );
  }

  if (!res.body) {
    throw new Error("Streaming response body was unavailable");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const emitLine = async (line: string) => {
    if (!line.trim()) return;
    await onEvent(JSON.parse(line) as ChatStreamEvent);
  };

  const readChunk = async () => {
    let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
    let timedOut = false;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = globalThis.setTimeout(() => {
            timedOut = true;
            reject(new ApiTimeoutError(CHAT_STREAM_IDLE_TIMEOUT_MS));
            void reader.cancel();
          }, CHAT_STREAM_IDLE_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      if (timedOut) throw new ApiTimeoutError(CHAT_STREAM_IDLE_TIMEOUT_MS);
      throw error;
    } finally {
      if (timer !== null) globalThis.clearTimeout(timer);
    }
  };

  while (true) {
    const { value, done } = await readChunk();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      await emitLine(line);
    }

    if (done) break;
  }

  if (buffer.trim()) {
    await emitLine(buffer);
  }
}

export const chatsApi = {
  getNativeChatCapabilities: async (): Promise<NativeChatCapabilities | null> => {
    try {
      const value: unknown = await api.get<unknown>("/native-chat/capabilities");
      if (!isNativeChatCapabilities(value)) {
        throw new Error("Native Chat capability response was invalid. Sending is paused.");
      }
      return value;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404
        && error.body !== null && typeof error.body === "object"
        && "error" in error.body
        && (error.body as { error?: unknown }).error === "route_not_found") {
        return null;
      }
      throw error;
    }
  },
  list: (
    orgId: string,
    status: "active" | "resolved" | "archived" | "all" = "active",
    filters?: { q?: string; limit?: number; projectId?: string },
  ) => {
    const params = new URLSearchParams({ status });
    if (filters?.q) params.set("q", filters.q);
    if (filters?.projectId) params.set("projectId", filters.projectId);
    if (typeof filters?.limit === "number" && Number.isFinite(filters.limit)) {
      params.set("limit", String(Math.max(1, Math.floor(filters.limit))));
    }
    return api.get<ChatConversation[]>(`/orgs/${orgId}/chats?${params.toString()}`);
  },
  create: (
    orgId: string,
    data: {
      title?: string;
      summary?: string | null;
      preferredAgentId?: string | null;
      modelOverride?: string | null;
      effortOverride?: string | null;
      issueCreationMode?: ChatIssueCreationMode;
      planMode?: boolean;
      contextLinks?: Array<{ entityType: "issue" | "project" | "agent" | "goal"; entityId: string }>;
    },
  ) => api.post<ChatConversation>(`/orgs/${orgId}/chats`, data),
  preflightDraft: (orgId: string, data: ChatDraftRequest) =>
    api.post<ChatRuntimeDescriptor>(`/orgs/${orgId}/chats/preflight`, data),
  get: (chatId: string) => api.get<ChatConversation>(`/chats/${chatId}`),
  getWorkManifest: (chatId: string) =>
    api.get<ChatWorkManifestResponse>(`/chats/${chatId}/work-manifest`),
  fork: (chatId: string, data: ForkChatConversation = {}) =>
    api.post<ChatConversation>(`/chats/${chatId}/fork`, data),
  createSideChat: (
    chatId: string,
    data: {
      sourceMessageId: string;
      clientMutationId: string;
      preferredAgentId?: string;
    },
  ) => api.post<ChatConversation>(`/chats/${chatId}/side-chats`, data),
  destroySideChat: (chatId: string) =>
    api.delete<{ id: string }>(`/chats/${chatId}/side-chat`),
  keepSideChat: (chatId: string) =>
    api.post<ChatConversation>(`/chats/${chatId}/side-chat/keep`, {}),
  update: (
    chatId: string,
    data: Partial<{
      title: string;
      summary: string | null;
      preferredAgentId: string | null;
      modelOverride: string | null;
      effortOverride: string | null;
      routedAgentId: string | null;
      issueCreationMode: ChatIssueCreationMode;
      planMode: boolean;
      status: "active" | "resolved" | "archived";
      primaryIssueId: string | null;
      resolvedAt: string | null;
    }>,
  ) => api.patch<ChatConversation>(`/chats/${chatId}`, data),
  regenerateTitle: (chatId: string) =>
    api.post<ChatConversation>(`/chats/${chatId}/title/regenerate`, {}),
  remove: (chatId: string, options: { cancelActive?: boolean } = {}) => {
    const query = options.cancelActive ? "?cancelActive=true" : "";
    return api.delete<ChatConversation>(`/chats/${chatId}${query}`);
  },
  listMessages: (
    orgId: string,
    chatId: string,
    options: { includeTranscript?: boolean } = {},
  ) => {
    const params = new URLSearchParams({ orgId });
    if (typeof options.includeTranscript === "boolean") {
      params.set("includeTranscript", String(options.includeTranscript));
    }
    const query = params.toString();
    return api.get<ChatMessage[]>(`/chats/${chatId}/messages${query ? `?${query}` : ""}`);
  },
  getMessageTranscript: async (chatId: string, messageId: string) => {
    const response = await api.get<{
      messageId: string;
      transcript: ChatStreamTranscriptEntry[];
      reader?: {
        availability?: "complete" | "partial" | "incomplete" | "unavailable";
        reason?: string;
      };
    }>(
      `/chats/${chatId}/messages/${messageId}/transcript`,
    );
    if (response.reader?.availability === "incomplete" || response.reader?.availability === "unavailable") {
      const status = response.reader.availability;
      const reason = response.reader.reason?.replaceAll("_", " ");
      throw new Error(`Process details are ${status}${reason ? ` (${reason})` : ""}.`);
    }
    return response;
  },
  sendMessage: (chatId: string, body: string) =>
    api.post<{ messages: ChatMessage[] }>(`/chats/${chatId}/messages`, { body }),
  sendFirstMessageStream: async (
    orgId: string,
    body: string,
    options: ChatFirstMessageStreamOptions,
  ) => {
    const files = options.files ?? [];
    const inlineAnnotations = options.inlineAnnotations ?? [];
    const requestBody = files.length > 0
      ? (() => {
        const form = new FormData();
        form.append("body", body);
        form.append("preferredAgentId", options.preferredAgentId);
        form.append("modelOverride", options.modelOverride ?? "__rudder_agent_default__");
        form.append("effortOverride", options.effortOverride ?? "__rudder_agent_default__");
        form.append("issueCreationMode", options.issueCreationMode);
        form.append("planMode", String(options.planMode));
        form.append("contextLinks", JSON.stringify(options.contextLinks));
        if (options.groupId) form.append("groupId", options.groupId);
        if (options.clientMutationId) form.append("clientMutationId", options.clientMutationId);
        if (inlineAnnotations.length > 0) {
          form.append("inlineAnnotations", JSON.stringify(inlineAnnotations));
        }
        for (const file of files) {
          form.append("files", file, file.name || "attachment");
        }
        return form;
      })()
      : JSON.stringify({
        body,
        preferredAgentId: options.preferredAgentId,
        modelOverride: options.modelOverride,
        effortOverride: options.effortOverride,
        issueCreationMode: options.issueCreationMode,
        planMode: options.planMode,
        contextLinks: options.contextLinks,
        ...(options.groupId ? { groupId: options.groupId } : {}),
        ...(options.clientMutationId ? { clientMutationId: options.clientMutationId } : {}),
        ...(inlineAnnotations.length > 0 ? { inlineAnnotations } : {}),
      });
    const requestSignal = createRequestSignal({
      signal: options.signal,
      timeoutMs: CHAT_REQUEST_TIMEOUT_MS,
    });
    try {
      const res = await fetch(`/api/orgs/${orgId}/chats/messages/stream`, {
        method: "POST",
        credentials: "include",
        headers: files.length > 0 ? undefined : { "Content-Type": "application/json" },
        body: requestBody,
        signal: requestSignal.signal,
      });

      // The connection deadline ends once headers arrive, but the caller's
      // abort signal must remain connected for the lifetime of the stream.
      requestSignal.clearTimeout();
      await consumeChatStreamResponse(res, options.onEvent);
    } catch (error) {
      if (requestSignal.didTimeout()) throw new ApiTimeoutError(CHAT_REQUEST_TIMEOUT_MS);
      throw error;
    } finally {
      requestSignal.dispose();
    }
  },
  sendNativeFirstMessageStream: async (
    orgId: string,
    input: NativeFirstSendInput,
    options: {
      signal?: AbortSignal;
      onEvent: (event: ChatStreamEvent) => Promise<void> | void;
    },
  ) => {
    if (!input.clientMutationId.trim()) {
      throw new Error("A stable first-message identity is required. Sending is paused.");
    }
    const requestSignal = createRequestSignal({
      signal: options.signal,
      timeoutMs: CHAT_REQUEST_TIMEOUT_MS,
    });
    try {
      const res = await fetch(`/api/orgs/${orgId}/chats/messages/stream`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: input.body,
          clientMutationId: input.clientMutationId,
          preferredAgentId: input.preferredAgentId,
          title: input.title,
          issueCreationMode: input.issueCreationMode,
          modelOverride: input.modelOverride,
          effortOverride: input.effortOverride,
          planMode: false,
          contextLinks: [],
        }),
        signal: requestSignal.signal,
      });
      requestSignal.clearTimeout();
      await consumeChatStreamResponse(res, async (event) => {
        if (event.type === "ack" && !isNativeFirstSendConversation(event.conversation, orgId, input.clientMutationId)) {
          throw new Error("Native Chat acknowledged the first message without its safe conversation projection.");
        }
        await options.onEvent(event);
      });
    } catch (error) {
      if (requestSignal.didTimeout()) throw new ApiTimeoutError(CHAT_REQUEST_TIMEOUT_MS);
      throw error;
    } finally {
      requestSignal.dispose();
    }
  },
  listQueue: (chatId: string) =>
    api.get<ChatQueueSnapshot>(`/chats/${chatId}/queue`),
  createQueuedMessage: (
    chatId: string,
    data: {
      clientMutationId: string;
      expectedGenerationId?: string | null;
      payload: ChatQueuedMessagePayloadInput;
    },
    options: { files?: File[] } = {},
  ) => {
    const files = options.files ?? [];
    if (files.length === 0) {
      return api.post<ChatQueuedMessage>(`/chats/${chatId}/queue`, data);
    }
    const form = new FormData();
    form.append("clientMutationId", data.clientMutationId);
    if (data.expectedGenerationId) {
      form.append("expectedGenerationId", data.expectedGenerationId);
    }
    form.append("payload", JSON.stringify(data.payload));
    for (const file of files) {
      form.append("files", file, file.name || "attachment");
    }
    return api.postForm<ChatQueuedMessage>(`/chats/${chatId}/queue`, form);
  },
  claimNextQueuedMessage: (chatId: string) =>
    api.post<ChatQueueClaimResponse>(`/chats/${chatId}/queue/next/claim`, {}),
  updateQueuedMessage: (
    chatId: string,
    itemId: string,
    data: {
      version: number;
      payload: ChatQueuedMessagePayload;
    },
  ) => api.patch<ChatQueuedMessage>(`/chats/${chatId}/queue/${itemId}`, data),
  cancelQueuedMessage: (chatId: string, itemId: string) =>
    api.delete<ChatQueuedMessage>(`/chats/${chatId}/queue/${itemId}`),
  releaseQueuedMessageClaim: (chatId: string, itemId: string) =>
    api.post<{ item: ChatQueuedMessage | null }>(`/chats/${chatId}/queue/${itemId}/release-claim`, {}),
  steerQueuedMessage: (
    chatId: string,
    itemId: string,
    data: ChatSteerQueuedMessageRequest,
  ) => api.post<ChatSteerResponse>(`/chats/${chatId}/queue/${itemId}/steer`, data, {
    timeoutMs: CHAT_REQUEST_TIMEOUT_MS,
  }),
  sendMessageStream: async (
    chatId: string,
    body: string,
    options: {
      signal?: AbortSignal;
      clientMutationId: string;
      editUserMessageId?: string | null;
      queuedMessageId?: string | null;
      modelOverride?: string | null;
      effortOverride?: string | null;
      files?: File[];
      inlineAnnotations?: ChatInlineAnnotationInput[];
      onEvent: (event: ChatStreamEvent) => Promise<void> | void;
    },
  ) => {
    if (!options.clientMutationId?.trim()) {
      throw new Error("A stable chat submission identity is required. Retry from the composer.");
    }
    const files = options.files ?? [];
    const inlineAnnotations = options.inlineAnnotations ?? [];
    const requestBody = files.length > 0
      ? (() => {
        const form = new FormData();
        form.append("body", body);
        form.append("clientMutationId", options.clientMutationId);
        if (options.editUserMessageId) form.append("editUserMessageId", options.editUserMessageId);
        if (options.queuedMessageId) form.append("queuedMessageId", options.queuedMessageId);
        form.append("modelOverride", options.modelOverride ?? "__rudder_agent_default__");
        form.append("effortOverride", options.effortOverride ?? "__rudder_agent_default__");
        if (inlineAnnotations.length > 0) {
          form.append("inlineAnnotations", JSON.stringify(inlineAnnotations));
        }
        for (const file of files) {
          form.append("files", file, file.name || "attachment");
        }
        return form;
      })()
      : JSON.stringify({
        body,
        clientMutationId: options.clientMutationId,
        ...(options.editUserMessageId ? { editUserMessageId: options.editUserMessageId } : {}),
        ...(options.queuedMessageId ? { queuedMessageId: options.queuedMessageId } : {}),
        modelOverride: options.modelOverride ?? null,
        effortOverride: options.effortOverride ?? null,
        ...(inlineAnnotations.length > 0 ? { inlineAnnotations } : {}),
      });
    const requestSignal = createRequestSignal({
      signal: options.signal,
      timeoutMs: CHAT_REQUEST_TIMEOUT_MS,
    });
    try {
      const res = await fetch(`/api/chats/${chatId}/messages/stream`, {
        method: "POST",
        credentials: "include",
        headers: files.length > 0 ? undefined : { "Content-Type": "application/json" },
        body: requestBody,
        signal: requestSignal.signal,
      });

      // The connection deadline ends once headers arrive, but the caller's
      // abort signal must remain connected for the lifetime of the stream.
      requestSignal.clearTimeout();
      await consumeChatStreamResponse(res, options.onEvent);
    } catch (error) {
      if (requestSignal.didTimeout()) throw new ApiTimeoutError(CHAT_REQUEST_TIMEOUT_MS);
      throw error;
    } finally {
      requestSignal.dispose();
    }

  },
  reconcilePendingMessageSend: (
    chatId: string,
    data: { clientMutationId: string; body: string },
    options?: { signal?: AbortSignal },
  ) => api.post<ChatMessageSendReconciliation>(`/chats/${chatId}/messages/stream/reconcile`, data, {
    signal: options?.signal,
    timeoutMs: CHAT_REQUEST_TIMEOUT_MS,
  }),
  reconcileNativeFirstSend: (
    orgId: string,
    input: NativeFirstSendInput,
    options?: { signal?: AbortSignal },
  ): Promise<NativeFirstSendReconciliation> => api.post<unknown>(`/orgs/${orgId}/chats/messages/stream/reconcile`, {
    body: input.body,
    clientMutationId: input.clientMutationId,
    preferredAgentId: input.preferredAgentId,
    title: input.title,
    issueCreationMode: input.issueCreationMode,
    modelOverride: input.modelOverride,
    effortOverride: input.effortOverride,
    planMode: false,
    contextLinks: [],
  }, {
    signal: options?.signal,
    timeoutMs: CHAT_REQUEST_TIMEOUT_MS,
  }).then((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Native Chat returned an invalid first-message recovery receipt.");
    }
    const candidate = value as Record<string, unknown>;
    if (candidate.outcome === "not_found"
      && candidate.clientMutationId === input.clientMutationId
      && Object.keys(candidate).sort().join(",") === "clientMutationId,outcome") {
      return candidate as NativeFirstSendReconciliation;
    }
    if (candidate.outcome !== "accepted"
      || candidate.clientMutationId !== input.clientMutationId
      || !isNativeFirstSendConversation(candidate.conversation, orgId, input.clientMutationId)
      || !candidate.message || typeof candidate.message !== "object"
      || (candidate.message as ChatMessage).orgId !== orgId
      || (candidate.message as ChatMessage).conversationId !== candidate.conversation.id
      || (candidate.message as ChatMessage).role !== "user"
      || (candidate.message as ChatMessage).body !== input.body
      || typeof candidate.generationId !== "string"
      || typeof candidate.runId !== "string"
      || typeof candidate.attemptEpoch !== "number"
      || candidate.generationSeq !== 0
      || typeof candidate.bodyHash !== "string"
      || typeof candidate.generationStatus !== "string"
      || typeof candidate.runStatus !== "string"
      || typeof candidate.runtimeTerminal !== "boolean") {
      throw new Error("Native Chat returned a mismatched first-message recovery receipt.");
    }
    return candidate as unknown as NativeFirstSendReconciliation;
  }),
  checkpointMessageStream: (chatId: string, data: ChatClientCheckpointRequest) =>
    api.post<{
      generationId: string;
      generationSeq: number;
      advanced: boolean;
    }>(`/chats/${chatId}/messages/stream/checkpoint`, data),
  stopMessageStream: (
    chatId: string,
    data: ChatStopMessageStreamRequest = { controlActionId: globalThis.crypto.randomUUID() },
  ) => api.post<{
    stopped: boolean;
    idempotent?: boolean;
    controlActionId: string;
    generationId: string | null;
    disposition?: string;
  }>(`/chats/${chatId}/messages/stream/stop`, data),
  readNativeChatTurn: async (chatId: string, orgId: string, generationId: string) =>
    parseNativeChatTurnRead(
      await api.get<unknown>(
        `/chats/${encodeURIComponent(chatId)}/messages/stream/turn?generationId=${encodeURIComponent(generationId)}`,
      ),
      chatId,
      orgId,
      generationId,
    ),
  readNativeChatControl: async (chatId: string, orgId: string, generationId: string) =>
    parseNativeChatControlRead(
      await api.get<unknown>(
        `/chats/${encodeURIComponent(chatId)}/messages/stream/control?generationId=${encodeURIComponent(generationId)}`,
      ),
      chatId,
      orgId,
      generationId,
    ),
  uploadAttachment: async (orgId: string, chatId: string, messageId: string, file: File) => {
    const buffer = await file.arrayBuffer();
    const safeFile = new File([buffer], file.name || "attachment", {
      type: file.type,
      lastModified: file.lastModified,
    });
    const form = new FormData();
    form.append("file", safeFile);
    form.append("messageId", messageId);
    return api.postForm<ChatAttachment>(`/orgs/${orgId}/chats/${chatId}/attachments`, form);
  },
  addContextLink: (
    chatId: string,
    data: {
      entityType: "issue" | "project" | "agent" | "goal";
      entityId: string;
      metadata?: Record<string, unknown> | null;
    },
  ) => api.post<ChatContextLink>(`/chats/${chatId}/context-links`, data),
  setProjectContext: (chatId: string, projectId: string | null) =>
    api.post<ChatConversation>(`/chats/${chatId}/project-context`, { projectId }),
  convertToIssue: (
    chatId: string,
    data?: {
      messageId?: string | null;
      proposal?: Record<string, unknown>;
    },
  ) => api.post<{ issue: { id: string; identifier: string | null }; systemMessage: ChatMessage }>(`/chats/${chatId}/convert-to-issue`, data ?? {}),
  resolveOperationProposal: (
    chatId: string,
    messageId: string,
    data: {
      action: ChatOperationProposalDecisionAction;
      decisionNote?: string | null;
    },
    ) =>
    api.post<{ message: ChatMessage; systemMessage: ChatMessage | null }>(
      `/chats/${chatId}/messages/${messageId}/operation-proposal/resolve`,
      data,
    ),
  resolve: (chatId: string) => api.post<ChatConversation>(`/chats/${chatId}/resolve`, {}),
  markRead: (chatId: string) =>
    api.post<{ conversationId: string; lastReadAt: Date }>(`/chats/${chatId}/read`, {}),
  updateUserState: (
    chatId: string,
    data: {
      pinned?: boolean;
      unread?: boolean;
    },
  ) => api.post<ChatConversation>(`/chats/${chatId}/user-state`, data),
};
