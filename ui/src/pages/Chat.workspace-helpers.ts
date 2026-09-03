import { appendTranscriptEntry } from "@/agent-runtimes/transcript";
import { chatsApi, type ChatSteerQueuedMessageRequest } from "@/api/chats";
import type { ChatStreamDraft } from "@/context/ChatGenerationContext";
import { displayChatTitle } from "@/lib/chat-title";
import { queryKeys } from "@/lib/queryKeys";
import { buildChatMentionHref, type ChatConversation, type ChatGenerationStatus, type ChatInlineAnnotationInput, type ChatMessage, type ChatQueuedMessage, type ChatQueuedMessagePayload, type ChatStreamEvent } from "@rudderhq/shared";
import { useQuery, type QueryClient } from "@tanstack/react-query";

export type SendButtonMode = "send" | "continue" | "stop" | "sending" | "stopping" | "queue";
export type PendingChatSteerRetry = {
  key: string;
  orgId: string;
  chatId: string;
  itemId: string;
  request: ChatSteerQueuedMessageRequest;
  retryCount: number;
  timer: ReturnType<typeof setTimeout> | null;
  lastError?: unknown;
};
type ChatStreamProgressEvent = Extract<
  ChatStreamEvent,
  { type: "assistant_delta" | "assistant_state" | "waiting_for_network" | "transcript_entry" }
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

export type ChatQueueDeliveryProjection =
  | { state: "hidden" }
  | { state: "queued"; label: "Queued" }
  | { state: "sending"; label: "Sending…" }
  | { state: "failed"; label: "Couldn't send" };

const DURABLE_QUEUE_DELIVERY_STATUSES = new Set<ChatQueuedMessage["status"]>([
  "accepted_current",
  "reconciled_current",
  "continuation_pending",
  "running_next",
  "delivered",
  "completed",
  "steered",
]);

const DURABLE_QUEUE_DELIVERY_DISPOSITIONS = new Set<NonNullable<ChatQueuedMessage["deliveryDisposition"]>>([
  "accepted_current",
  "reconciled_current",
  "continuation_pending",
  "running_next",
  "delivered",
]);

export function projectChatQueueDelivery(
  item: ChatQueuedMessage,
  isSteering = false,
): ChatQueueDeliveryProjection {
  const hasDurableDeliveryEvidence = Boolean(
    item.sourceMessageId || item.deliveredMessageId || item.continuationMessageId,
  )
    || DURABLE_QUEUE_DELIVERY_STATUSES.has(item.status)
    || (item.deliveryDisposition !== null && DURABLE_QUEUE_DELIVERY_DISPOSITIONS.has(item.deliveryDisposition));
  if (hasDurableDeliveryEvidence || item.status === "cancelled") return { state: "hidden" };
  if (isSteering) return { state: "sending", label: "Sending…" };
  if (item.status === "queued") return { state: "queued", label: "Queued" };
  if (item.status === "failed_actionable") return { state: "failed", label: "Couldn't send" };
  return { state: "sending", label: "Sending…" };
}

const ACTIVE_CHAT_GENERATION_STATUSES = new Set<ChatGenerationStatus>([
  "starting",
  "active",
  "running",
  "tool_busy",
  "closing",
  "waiting_for_network",
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
  if (
    !current
    || current.streamKey !== streamKey
    || !["streaming", "tool_busy", "finalizing", "waiting_for_network"].includes(current.state)
  ) {
    return current;
  }
  const eventGenerationId = "generationId" in event ? event.generationId : undefined;
  const eventAttemptEpoch = "attemptEpoch" in event ? event.attemptEpoch : undefined;
  const eventGenerationSeq = "generationSeq" in event ? event.generationSeq : undefined;
  if (
    current.generationId
    && eventGenerationId
    && current.generationId !== eventGenerationId
  ) {
    return current;
  }
  if (
    current.attemptEpoch !== null
    && current.attemptEpoch !== undefined
    && eventAttemptEpoch !== undefined
    && eventAttemptEpoch < current.attemptEpoch
  ) {
    return current;
  }
  const isStateEvent = event.type === "assistant_state" || event.type === "waiting_for_network";
  if (
    !isStateEvent
    && eventGenerationSeq !== undefined
    && current.lastCommittedRenderSeq !== undefined
    && eventGenerationSeq <= current.lastCommittedRenderSeq
  ) {
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
  if (event.type === "assistant_state") {
    const state = event.state === "tool_busy" ? "tool_busy" : event.state;
    return {
      ...current,
      state,
      generationId: eventGenerationId ?? current.generationId ?? null,
      attemptEpoch: eventAttemptEpoch ?? current.attemptEpoch ?? null,
      lastCommittedRenderSeq: eventGenerationSeq ?? current.lastCommittedRenderSeq ?? 0,
    };
  }
  if (event.type === "waiting_for_network") {
    return {
      ...current,
      state: "waiting_for_network",
      generationId: event.generationId ?? current.generationId ?? null,
      attemptEpoch: event.attemptEpoch ?? current.attemptEpoch ?? null,
      lastCommittedRenderSeq: event.generationSeq ?? current.lastCommittedRenderSeq ?? 0,
      renderedBodyHash: event.bodyHash ?? current.renderedBodyHash ?? EMPTY_CHAT_BODY_SHA256,
    };
  }
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
    let conversationId = "";
    if (url.protocol === "chat:") {
      conversationId = `${url.hostname}${url.pathname}`.replace(/^\/+/, "").trim();
    } else if (url.origin === "http://rudder.local") {
      const routeMatch = url.pathname.match(
        /^\/(?:(?:messenger\/)?chat\/([^/]+)|[^/]+\/messenger\/chat\/([^/]+))\/?$/,
      );
      const encodedConversationId = routeMatch?.[1] ?? routeMatch?.[2] ?? "";
      try {
        conversationId = decodeURIComponent(encodedConversationId).trim();
      } catch {
        conversationId = encodedConversationId.trim();
      }
    }
    const messageId = (url.searchParams.get("messageId") ?? url.searchParams.get("targetMessageId") ?? "").trim();
    return conversationId ? { conversationId, messageId: messageId || null } : null;
  } catch {
    return null;
  }
}

export function sideChatTargetFromMessage(
  conversation: ChatConversation,
  message: ChatMessage,
  annotation?: ChatInlineAnnotationInput,
) {
  const ownedAnnotation = annotation
    ? {
        ...annotation,
        ...(annotation.attachmentIds
          ? { attachmentIds: [...annotation.attachmentIds] }
          : {}),
        ...(annotation.attachmentFileIndexes
          ? { attachmentFileIndexes: [...annotation.attachmentFileIndexes] }
          : {}),
      }
    : null;
  return {
    kind: "side_chat" as const,
    sourceConversationId: conversation.id,
    sourceMessageId: message.id,
    sourcePreview: ownedAnnotation?.selectedText ?? message.body,
    ...(ownedAnnotation ? { inlineAnnotations: [ownedAnnotation] } : {}),
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

function preferredChatScrollBehavior(): ScrollBehavior {
  return typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

function highlightChatElement(target: HTMLElement) {
  target.classList.remove("chat-message-jump-highlight");
  void target.offsetWidth;
  target.classList.add("chat-message-jump-highlight");
  window.setTimeout(() => target.classList.remove("chat-message-jump-highlight"), 1_800);
}

export function revealChatMessageElement(target: HTMLElement) {
  const highlightTarget = findChatMessageHighlightElement(target);
  target.scrollIntoView({ block: "center", behavior: preferredChatScrollBehavior() });
  target.classList.remove("chat-message-jump-highlight");
  highlightChatElement(highlightTarget);
}

export function revealChatAnnotationSourceElement(target: HTMLElement) {
  target.scrollIntoView({ block: "center", behavior: preferredChatScrollBehavior() });
  highlightChatElement(target);
}

export function useChatDraftQueries(input: {
  selectedOrganizationId: string | null | undefined;
  selectedConversation: ChatConversation | null | undefined;
  activeAgentId: string | null;
  modelOverride?: string | null;
  effortOverride?: string | null;
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
    queryKey: ["chats", input.selectedOrganizationId ?? "__none__", "draft-preflight", input.activeAgentId ?? "__none__", input.modelOverride ?? "__agent_default__", input.effortOverride ?? "__agent_default__", input.activeProjectId, input.issueContextId ?? "__none__", input.planMode],
    queryFn: () => chatsApi.preflightDraft(input.selectedOrganizationId!, {
      preferredAgentId: input.activeAgentId!,
      modelOverride: input.modelOverride,
      effortOverride: input.effortOverride,
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

export function chatComposerSubmitAction(input: {
  composerUnavailable: boolean;
  newConversationSendInFlight: boolean;
  modelSelectionPending: boolean;
  selectedConversationHasActiveReply: boolean;
  hasSelectedConversation: boolean;
  controlsDisabled: boolean;
}) {
  if (
    input.composerUnavailable
    || input.newConversationSendInFlight
    || input.modelSelectionPending
  ) {
    return "none" as const;
  }
  if (input.selectedConversationHasActiveReply && input.hasSelectedConversation) {
    return "queue" as const;
  }
  return input.controlsDisabled ? "none" as const : "send" as const;
}

export function chatComposerSendButtonMode(input: {
  newConversationSendInFlight: boolean;
  activeSendInFlight: boolean;
  hasActiveStream: boolean;
  stopRequestPending: boolean;
  streamStopping: boolean;
  canQueueDraft: boolean;
  canContinueInterruptedConversation: boolean;
  hasSubmittableDraft: boolean;
  pendingFileCount: number;
}): SendButtonMode {
  if (input.newConversationSendInFlight || (input.activeSendInFlight && !input.hasActiveStream)) return "sending";
  if (input.stopRequestPending || input.streamStopping) return "stopping";
  if (input.canQueueDraft) return "queue";
  if (input.activeSendInFlight) return "stop";
  if (
    input.canContinueInterruptedConversation
    && !input.hasSubmittableDraft
    && input.pendingFileCount === 0
  ) return "continue";
  return "send";
}

export function chatSendButtonDisabled(input: {
  selectedConversationExternalBound: boolean;
  modelSelectionPending: boolean;
  composerUnavailable: boolean;
  sendButtonMode: SendButtonMode;
  hasDraft: boolean;
}) {
  if (input.selectedConversationExternalBound || input.composerUnavailable) return true;
  if (input.sendButtonMode === "sending" || input.sendButtonMode === "stopping") return true;
  if (input.sendButtonMode === "continue") return input.modelSelectionPending;
  if (input.sendButtonMode === "send" || input.sendButtonMode === "queue") {
    return input.modelSelectionPending || !input.hasDraft;
  }
  return false;
}

export function advanceChatDraftModelScope(
  previousScope: string | null,
  organizationId: string | null | undefined,
  agentId: string | null | undefined,
) {
  const scope = `${organizationId ?? "__none__"}:${agentId ?? "__none__"}`;
  return {
    scope,
    reset: previousScope !== null && previousScope !== scope,
  };
}

export async function createQueuedComposerMessage(input: {
  conversation: ChatConversation;
  body: string;
  inlineAnnotations?: ChatInlineAnnotationInput[];
  files?: File[];
  orgId: string;
  projectId: string | null;
  modelOverride: string | null;
  effortOverride: string | null;
  serverActiveGenerationId: string | null;
  queueSnapshot: Awaited<ReturnType<typeof chatsApi.listQueue>> | undefined;
  queryClient: QueryClient;
}) {
  const queued = await chatsApi.createQueuedMessage(
    input.conversation.id,
    {
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
        model: input.modelOverride,
        effort: input.effortOverride,
        metadata: { source: "chat_composer" },
      },
    },
    { files: input.files },
  );
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

export function canQueueComposerDraft(input: {
  activeReply: boolean;
  body: string;
  annotationCount: number;
  pendingRegularFileCount: number;
  newConversationSendInFlight: boolean;
}) {
  return Boolean(
    input.activeReply
    && !input.newConversationSendInFlight
    && input.pendingRegularFileCount === 0
    && (input.body.trim().length > 0 || input.annotationCount > 0),
  );
}

export function queuedMessagePayloadForBodyEdit(
  payload: ChatQueuedMessagePayload,
  body: string,
) {
  const {
    inlineAnnotations: _preservedInlineAnnotations,
    ...payloadWithoutAnnotations
  } = payload;
  return { ...payloadWithoutAnnotations, body };
}
