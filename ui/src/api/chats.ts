import type {
  ChatAttachment,
  ChatContextLink,
  ChatConversation,
  ChatMessage,
  ChatIssueCreationMode,
  ChatOperationProposalDecisionAction,
  ChatStreamEvent,
} from "@rudder/shared";
import { ApiError, api } from "./client";

export const chatsApi = {
  list: (orgId: string, status: "active" | "resolved" | "archived" | "all" = "active") =>
    api.get<ChatConversation[]>(`/orgs/${orgId}/chats?status=${status}`),
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
  listMessages: (chatId: string) => api.get<ChatMessage[]>(`/chats/${chatId}/messages`),
  sendMessage: (chatId: string, body: string) =>
    api.post<{ messages: ChatMessage[] }>(`/chats/${chatId}/messages`, { body }),
  sendMessageStream: async (
    chatId: string,
    body: string,
    options: {
      signal?: AbortSignal;
      editUserMessageId?: string | null;
      onEvent: (event: ChatStreamEvent) => Promise<void> | void;
    },
  ) => {
    const res = await fetch(`/api/chats/${chatId}/messages/stream`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        body,
        ...(options.editUserMessageId ? { editUserMessageId: options.editUserMessageId } : {}),
      }),
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
    let streamError: ApiError | null = null;

    const emitLine = async (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line) as ChatStreamEvent;
      await options.onEvent(event);
      if (event.type === "error") {
        streamError = new ApiError(event.error, 502, event);
      }
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

    if (streamError) {
      throw streamError;
    }
  },
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
    },
  ) => api.post<ChatConversation>(`/chats/${chatId}/user-state`, data),
};
