import type {
  ChatAttachment,
  ChatContextLink,
  ChatConversation,
  ChatIssueCreationMode,
  ChatMessage,
  ChatOperationProposalDecisionAction,
  ChatQueueClaimResponse,
  ChatQueueSnapshot,
  ChatQueuedMessage,
  ChatQueuedMessagePayload,
  ChatSteerResponse,
  ChatStreamEvent,
  ChatStreamTranscriptEntry,
  ChatWorkManifestResponse,
  ForkChatConversation,
} from "@rudderhq/shared";
import { ApiError, api } from "./client";

export const chatsApi = {
  list: (
    orgId: string,
    status: "active" | "resolved" | "archived" | "all" = "active",
    filters?: { q?: string; limit?: number },
  ) => {
    const params = new URLSearchParams({ status });
    if (filters?.q) params.set("q", filters.q);
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
      issueCreationMode?: ChatIssueCreationMode;
      planMode?: boolean;
      contextLinks?: Array<{ entityType: "issue" | "project" | "agent"; entityId: string }>;
    },
  ) => api.post<ChatConversation>(`/orgs/${orgId}/chats`, data),
  get: (chatId: string) => api.get<ChatConversation>(`/chats/${chatId}`),
  getWorkManifest: (chatId: string) =>
    api.get<ChatWorkManifestResponse>(`/chats/${chatId}/work-manifest`),
  fork: (chatId: string, data: ForkChatConversation = {}) =>
    api.post<ChatConversation>(`/chats/${chatId}/fork`, data),
  update: (
    chatId: string,
    data: Partial<{
      title: string;
      summary: string | null;
      preferredAgentId: string | null;
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
  listMessages: (chatId: string, options: { includeTranscript?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (typeof options.includeTranscript === "boolean") {
      params.set("includeTranscript", String(options.includeTranscript));
    }
    const query = params.toString();
    return api.get<ChatMessage[]>(`/chats/${chatId}/messages${query ? `?${query}` : ""}`);
  },
  getMessageTranscript: (chatId: string, messageId: string) =>
    api.get<{ messageId: string; transcript: ChatStreamTranscriptEntry[] }>(
      `/chats/${chatId}/messages/${messageId}/transcript`,
    ),
  sendMessage: (chatId: string, body: string) =>
    api.post<{ messages: ChatMessage[] }>(`/chats/${chatId}/messages`, { body }),
  listQueue: (chatId: string) =>
    api.get<ChatQueueSnapshot>(`/chats/${chatId}/queue`),
  createQueuedMessage: (
    chatId: string,
    data: {
      clientMutationId: string;
      expectedGenerationId?: string | null;
      payload: ChatQueuedMessagePayload;
    },
  ) => api.post<ChatQueuedMessage>(`/chats/${chatId}/queue`, data),
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
    expectedActiveGenerationId?: string | null,
  ) => api.post<ChatSteerResponse>(`/chats/${chatId}/queue/${itemId}/steer`, { expectedActiveGenerationId }),
  sendMessageStream: async (
    chatId: string,
    body: string,
    options: {
      signal?: AbortSignal;
      editUserMessageId?: string | null;
      queuedMessageId?: string | null;
      files?: File[];
      onEvent: (event: ChatStreamEvent) => Promise<void> | void;
    },
  ) => {
    const files = options.files ?? [];
    const requestBody = files.length > 0
      ? (() => {
        const form = new FormData();
        form.append("body", body);
        if (options.editUserMessageId) form.append("editUserMessageId", options.editUserMessageId);
        if (options.queuedMessageId) form.append("queuedMessageId", options.queuedMessageId);
        for (const file of files) {
          form.append("files", file, file.name || "attachment");
        }
        return form;
      })()
      : JSON.stringify({
        body,
        ...(options.editUserMessageId ? { editUserMessageId: options.editUserMessageId } : {}),
        ...(options.queuedMessageId ? { queuedMessageId: options.queuedMessageId } : {}),
      });
    const res = await fetch(`/api/chats/${chatId}/messages/stream`, {
      method: "POST",
      credentials: "include",
      headers: files.length > 0 ? undefined : { "Content-Type": "application/json" },
      body: requestBody,
      signal: options.signal,
    });

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
      const event = JSON.parse(line) as ChatStreamEvent;
      await options.onEvent(event);
    };

    while (true) {
      const { value, done } = await reader.read();
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

  },
  stopMessageStream: (chatId: string) =>
    api.post<{ stopped: boolean }>(`/chats/${chatId}/messages/stream/stop`, {}),
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
      entityType: "issue" | "project" | "agent";
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
