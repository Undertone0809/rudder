import { appendTranscriptEntry } from "@/agent-runtimes/transcript";
import { chatsApi, type ChatSteerQueuedMessageRequest } from "@/api/chats";
import type { ChatStreamDraft } from "@/context/ChatGenerationContext";
import { displayChatTitle } from "@/lib/chat-title";
import { queryKeys } from "@/lib/queryKeys";
import { buildChatMentionHref, type ChatConversation, type ChatGenerationStatus, type ChatInlineAnnotation, type ChatMessage, type ChatStreamEvent } from "@rudderhq/shared";
import { useQuery, type QueryClient } from "@tanstack/react-query";

export type SendButtonMode = "send" | "stop" | "sending" | "stopping" | "queue";
export type PendingChatSteerRetry = {
  key: string;
  orgId: string;
  chatId: string;
  itemId: string;
  request: ChatSteerQueuedMessageRequest;
  retryCount: number;
  timer: ReturnType<typeof setTimeout> | null;
  lastFeedbackResult: string | null;
  transportToastShown: boolean;
};
type ChatStreamProgressEvent = Extract<
  ChatStreamEvent,
  { type: "assistant_delta" | "assistant_state" | "transcript_entry" }
>;

export const EMPTY_STATE_PROMPT_PAGE_TRANSITION_MS = 250;
export const EMPTY_CHAT_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export const CHAT_STEER_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;
export const RECENT_PROJECT_CONVERSATION_INITIAL_LIMIT = 5;
export const RECENT_PROJECT_CONVERSATION_LOAD_INCREMENT = 10;
export const CHAT_LIST_PREVIEW_LIMIT = 40;
export const CHAT_ISSUE_MENTION_LIMIT = 50;
export const CHAT_SCROLL_MAP_USER_MESSAGE_THRESHOLD = 5;
export const CHAT_DRAFT_PREFLIGHT_STALE_TIME_MS = 5 * 60_000;
export const CHAT_DRAFT_PREFLIGHT_GC_TIME_MS = 30 * 60_000;

const ACTIVE_CHAT_GENERATION_STATUSES = new Set<ChatGenerationStatus>([
  "starting",
  "active",
  "running",
  "tool_busy",
  "closing",
  "stop_requested",
  "stopping",
]);

export function activeGenerationIdFromSnapshot(snapshot: {
  activeGenerationId: string | null;
  activeGenerationStatus: ChatGenerationStatus | null;
} | null | undefined) {
  if (!snapshot?.activeGenerationId) return null;
  if (snapshot.activeGenerationStatus === null) return snapshot.activeGenerationId;
  return ACTIVE_CHAT_GENERATION_STATUSES.has(snapshot.activeGenerationStatus) ? snapshot.activeGenerationId : null;
}

export function clipboardAttachmentPayloadKey(file: File) {
  return `${file.name.trim()}\u0000${file.type.trim().toLowerCase()}\u0000${file.size}`;
}

export function isExternalBoundConversation(conversation: ChatConversation | null | undefined) {
  return conversation?.mutability === "external_bound_chat";
}

export function applyChatStreamProgressEvent(
  current: ChatStreamDraft | null,
  streamKey: string,
  event: ChatStreamProgressEvent,
): ChatStreamDraft | null {
  if (!current || current.streamKey !== streamKey || (current.state !== "streaming" && current.state !== "finalizing")) {
    return current;
  }
  if (event.type === "assistant_delta") {
    return {
      ...current,
      body: `${current.body}${event.delta}`,
      generationId: event.generationId ?? current.generationId ?? null,
      attemptEpoch: event.attemptEpoch ?? current.attemptEpoch ?? null,
      lastCommittedRenderSeq: event.generationSeq ?? current.lastCommittedRenderSeq ?? 0,
      renderedBodyHash: event.bodyHash ?? current.renderedBodyHash ?? EMPTY_CHAT_BODY_SHA256,
    };
  }
  if (event.type === "assistant_state") return { ...current, state: event.state };
  const transcript = [...current.transcript];
  appendTranscriptEntry(transcript, event.entry);
  return {
    ...current,
    transcript,
    generationId: event.generationId ?? current.generationId ?? null,
    attemptEpoch: event.attemptEpoch ?? current.attemptEpoch ?? null,
    lastCommittedRenderSeq: event.generationSeq ?? current.lastCommittedRenderSeq ?? 0,
    renderedBodyHash: event.bodyHash ?? current.renderedBodyHash ?? EMPTY_CHAT_BODY_SHA256,
  };
}

function escapeMarkdownLinkLabel(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/]/g, "\\]");
}

export function chatReferenceMarkdown(conversation: Pick<ChatConversation, "id" | "title" | "summary">) {
  const label = escapeMarkdownLinkLabel(displayChatTitle(conversation).trim() || "Chat");
  return `[${label}](${buildChatMentionHref(conversation.id)})`;
}

export function chatMessageJumpTargetFromHref(href: string) {
  try {
    const url = new URL(href, "http://rudder.local");
    if (url.protocol !== "chat:") return null;
    const conversationId = `${url.hostname}${url.pathname}`.replace(/^\/+/, "").trim();
    const messageId = (url.searchParams.get("messageId") ?? url.searchParams.get("targetMessageId") ?? "").trim();
    return conversationId && messageId ? { conversationId, messageId } : null;
  } catch {
    return null;
  }
}

export function sideChatTargetFromMessage(conversation: ChatConversation, message: ChatMessage) {
  return {
    kind: "side_chat" as const,
    sourceConversationId: conversation.id,
    sourceMessageId: message.id,
    sourcePreview: message.body,
    conversationId: null,
    clientMutationId: crypto.randomUUID(),
    label: "Side Chat",
  };
}

export function findChatMessageElement(root: HTMLElement, messageId: string) {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-message-id]"))
    .find((element) => element.dataset.messageId === messageId) ?? null;
}

function findChatMessageHighlightElement(target: HTMLElement) {
  return target.querySelector<HTMLElement>("[data-message-highlight-target='true']") ?? target;
}

export function revealChatMessageElement(target: HTMLElement) {
  const highlightTarget = findChatMessageHighlightElement(target);
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  target.classList.remove("chat-message-jump-highlight");
  highlightTarget.classList.remove("chat-message-jump-highlight");
  void highlightTarget.offsetWidth;
  highlightTarget.classList.add("chat-message-jump-highlight");
  window.setTimeout(() => highlightTarget.classList.remove("chat-message-jump-highlight"), 1800);
}

export function useChatDraftQueries(input: {
  selectedOrganizationId: string | null | undefined;
  selectedConversation: ChatConversation | null | undefined;
  activeAgentId: string | null;
  activeProjectId: string;
  issueContextId: string | null;
  planMode: boolean;
  noProjectId: string;
  contextLinks: Array<{ entityType: "issue" | "project" | "agent"; entityId: string; metadata?: Record<string, unknown> | null }>;
}) {
  const projectConversationsQuery = useQuery({
    queryKey: queryKeys.chats.listPreview(input.selectedOrganizationId ?? "__none__", "active", CHAT_LIST_PREVIEW_LIMIT, input.activeProjectId),
    queryFn: () => chatsApi.list(input.selectedOrganizationId!, "active", {
      limit: CHAT_LIST_PREVIEW_LIMIT,
      projectId: input.activeProjectId === input.noProjectId ? undefined : input.activeProjectId,
    }),
    enabled: Boolean(input.selectedOrganizationId) && input.activeProjectId !== input.noProjectId,
  });
  const draftPreflightQuery = useQuery({
    queryKey: ["chats", input.selectedOrganizationId ?? "__none__", "draft-preflight", input.activeAgentId ?? "__none__", input.activeProjectId, input.issueContextId ?? "__none__", input.planMode],
    queryFn: () => chatsApi.preflightDraft(input.selectedOrganizationId!, {
      preferredAgentId: input.activeAgentId!,
      issueCreationMode: "manual_approval",
      planMode: input.planMode,
      contextLinks: input.contextLinks,
    }),
    enabled: !input.selectedConversation && Boolean(input.selectedOrganizationId) && Boolean(input.activeAgentId),
    retry: false,
    staleTime: (query) => query.state.data?.available
      ? CHAT_DRAFT_PREFLIGHT_STALE_TIME_MS
      : 0,
    gcTime: CHAT_DRAFT_PREFLIGHT_GC_TIME_MS,
  });
  return { draftPreflightQuery, projectConversationsQuery };
}

export async function createQueuedComposerMessage(input: {
  conversation: ChatConversation;
  body: string;
  inlineAnnotations?: ChatInlineAnnotation[];
  orgId: string;
  projectId: string | null;
  serverActiveGenerationId: string | null;
  queueSnapshot: Awaited<ReturnType<typeof chatsApi.listQueue>> | undefined;
  queryClient: QueryClient;
}) {
  const queued = await chatsApi.createQueuedMessage(input.conversation.id, {
    clientMutationId: `ui:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    expectedGenerationId: input.serverActiveGenerationId,
    payload: {
      body: input.body,
      ...(input.inlineAnnotations?.length
        ? { inlineAnnotations: input.inlineAnnotations }
        : {}),
      attachmentIds: [],
      skillRefs: [],
      projectId: input.projectId,
      accessMode: null,
      model: null,
      effort: null,
      metadata: { source: "chat_composer" },
    },
  });
  input.queryClient.setQueryData(
    queryKeys.chats.queue(input.orgId, input.conversation.id),
    (current: Awaited<ReturnType<typeof chatsApi.listQueue>> | undefined) => ({
      activeGenerationId: current?.activeGenerationId ?? input.serverActiveGenerationId,
      activeAttemptEpoch: current?.activeAttemptEpoch ?? input.queueSnapshot?.activeAttemptEpoch ?? null,
      activeControlVersion: current?.activeControlVersion ?? input.queueSnapshot?.activeControlVersion ?? null,
      activeGenerationStatus: current?.activeGenerationStatus ?? input.queueSnapshot?.activeGenerationStatus ?? null,
      items: [...(current?.items ?? []), queued],
    }),
  );
  return queued;
}
