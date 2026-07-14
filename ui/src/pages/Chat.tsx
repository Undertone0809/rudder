import type { TranscriptEntry } from "@/agent-runtimes";
import { appendTranscriptEntry } from "@/agent-runtimes/transcript";
import { agentsApi } from "@/api/agents";
import { approvalsApi } from "@/api/approvals";
import { authApi } from "@/api/auth";
import { chatsApi } from "@/api/chats";
import { ApiError } from "@/api/client";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { issuesApi } from "@/api/issues";
import { messengerApi } from "@/api/messenger";
import { organizationSkillsApi } from "@/api/organizationSkills";
import { organizationsApi } from "@/api/orgs";
import { projectsApi } from "@/api/projects";
import { AgentIcon } from "@/components/AgentIconPicker";
import { MarkdownBody, type MarkdownLinkClickHandler } from "@/components/MarkdownBody";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "@/components/MarkdownEditor";
import { ProjectIcon } from "@/components/ProjectIdentity";
import type { MarkdownSkillReferencePreview } from "@/components/SkillReferenceToken";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useChatGenerations } from "@/context/ChatGenerationContext";
import { useDialog } from "@/context/DialogContext";
import { useI18n } from "@/context/I18nContext";
import { useOrganization } from "@/context/OrganizationContext";
import { useSidebar } from "@/context/SidebarContext";
import { useSidePanel } from "@/context/SidePanelContext";
import { useToast } from "@/context/ToastContext";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import { useViewedOrganization } from "@/hooks/useViewedOrganization";
import { formatChatAgentLabel } from "@/lib/agent-labels";
import {
  NO_CHAT_AGENT_ID,
  isSelectableChatAgentId,
  rememberChatAgentId,
  resolveDefaultChatAgentId,
  selectableChatAgents,
} from "@/lib/chat-agent-selection";
import { clearChatAskUserDraft, readChatDraft, saveChatDraft } from "@/lib/chat-draft-storage";
import {
  readChatPendingAttachmentsForScope,
  resolveChatPendingAttachmentScopeKey,
  updateChatPendingAttachmentsForScope,
} from "@/lib/chat-pending-attachments";
import { prefetchChatConversation } from "@/lib/chat-prefetch";
import {
  resolvePersistedChatProcessEndedAt,
  resolvePersistedChatProcessStartedAt
} from "@/lib/chat-process-duration";
import { resolveRequestedPreferredAgentId } from "@/lib/chat-route-state";
import { buildChatSkillOptions, filterChatSkillOptions } from "@/lib/chat-skill-options";
import {
  readChatScopedFlag,
  readChatScopedState,
  shouldShowMessageDuringActiveStream,
} from "@/lib/chat-stream-state";
import { displayChatTitle } from "@/lib/chat-title";
import { readDesktopShell } from "@/lib/desktop-shell";
import type { AtomicInlineTokenElement } from "@/lib/inline-token-dom";
import { resolveLocalFileTarget } from "@/lib/local-file-targets";
import { buildMarkdownMentionOptions } from "@/lib/markdown-mention-options";
import { mentionChipNavigationPath, parseMentionChipHref } from "@/lib/mention-chips";
import { rememberMessengerPath } from "@/lib/messenger-memory";
import {
  archiveMessengerChatInCache,
  cancelMessengerChatRenameQueries,
  invalidateMessengerThreadSummaryQueries,
  markMessengerChatPinnedInCache,
  markMessengerChatReadInCache,
  renameMessengerChatInCache,
  upsertMessengerThreadSummaryQueries,
} from "@/lib/messenger-query-cache";
import { toOrganizationRelativePath } from "@/lib/organization-routes";
import {
  appendSkillReferencesToDraft,
} from "@/lib/organization-skill-picker";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "@/lib/router";
import { cn } from "@/lib/utils";
import {
  buildChatMentionHref,
  type ChatConversation,
  type ChatMessage,
  type ChatOperationProposalDecisionAction,
  type ChatQueuedMessage,
  type ChatWorkManifestItem
} from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowUp,
  Bot,
  Boxes,
  ChevronDown,
  Copy,
  Folder,
  FolderInput,
  FolderPlus,
  GitFork,
  ListChecks,
  Loader2,
  Mail,
  MailOpen,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Paperclip,
  Pencil,
  PencilLine,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Square,
  Trash2,
  X
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ChatAttachmentPreviewDialog, PendingAttachmentPreview } from "./Chat.attachments";
import { AskUserPanel, AssistantDraftItem, ChatMessageItem, ChatMessagesLoadingState, LazyStreamTranscriptItem, OptimisticUserDraftItem, StreamTranscriptItem, chatIssueApprovalPayloadWithProposalOverride, type ChatTurnBranchControls } from "./Chat.messages";
import { ASK_USER_ANSWER_PREFIX, ApprovalAction, AttachmentPreviewState, ChatBranchPreview, ChatEmptyStatePromptOptions, ChatEmptyStatePromptStarters, ChatEmptyStateRecentConversations, EmptyStatePromptGroup, EmptyStatePromptSuggestion, INTERRUPTED_CHAT_CONTINUATION_PROMPT, NO_CHAT_AGENT_LABEL, NO_PROJECT_ID, PLAN_MODE_HELP_TEXT, applyChatPromptToDraft, approvalNeedsAction, askUserAnswerFromMessage, askUserRequestFromMessage, buildChatProposalRejectFeedbackPrompt, buildChatProposalRevisionPrompt, buildDraftChatContextLinks, buildMessengerChatThreadSummary, canRefreshAssistantChatMessage, canRefreshDisplayedAssistantChatMessage, chatEmptyStateHeading, chatPromptQueryKey, chatPromptSuggestionsForDraft, chatSidePanelTargetFromHref, composerMenuPositionForAnchor, computeDisplayedChatMessages, conversationDisplayTitle, draftIssueContextLabel, findLatestUnansweredAskUserMessage, findRetrySourceUserMessage, formatChatPrimaryIssueBreadcrumb, isAskUserMessageAnswered, isChatAgentSelectionLocked, isChatProjectSelectionLocked, isUserVisibleIncomingChatMessage, issueProposalFromMessage, materializePendingAttachment, mergeChatConversationsForStatus, mergeChatMessages, operationProposalFromMessage, operationProposalStatusFromMessage, parseAskUserAnswerMessage, pendingAttachmentKey, projectContextId, projectDisplayName, rememberChatProjectId, rememberChatProjectIdForAgent, resolveDefaultDraftChatProjectId, resolveDraftIssueContext, scrollChatMessagesToBottom, shouldAttachApprovalFeedbackSystemMessage, shouldAttachIssueCreatedSystemMessage, shouldHandlePlainChatLinkClick, withOptimisticOutgoingMessage, withOptimisticPlanMode } from "./Chat.parts";
import {
  ChatWorkManifest,
  ChatWorkManifestToggle,
  hasChatWorkManifestContent,
} from "./Chat.work-manifest";
export * from "./Chat.attachments";
export * from "./Chat.messages";
export * from "./Chat.parts";
type SendButtonMode = "send" | "stop" | "sending" | "queue";
const EMPTY_STATE_PROMPT_PAGE_TRANSITION_MS = 250;
export function Chat() { const { selectedOrganizationId } = useOrganization();
  if (!selectedOrganizationId) {
    return <div className="text-sm text-muted-foreground">Select a organization first.</div>; }
  return <ChatWorkspace key={selectedOrganizationId} />; }
function clipboardAttachmentPayloadKey(file: File) {
  return `${file.name.trim()}\u0000${file.type.trim().toLowerCase()}\u0000${file.size}`;
}
function isExternalBoundConversation(conversation: ChatConversation | null | undefined) {
  return conversation?.mutability === "external_bound_chat";
}
function escapeMarkdownLinkLabel(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/]/g, "\\]");
}
function chatReferenceMarkdown(conversation: Pick<ChatConversation, "id" | "title" | "summary">) {
  const label = escapeMarkdownLinkLabel(displayChatTitle(conversation).trim() || "Chat");
  return `[${label}](${buildChatMentionHref(conversation.id)})`;
}
function chatMessageJumpTargetFromHref(href: string) {
  try {
    const url = new URL(href, "http://rudder.local");
    if (url.protocol !== "chat:") return null;

    const conversationId = `${url.hostname}${url.pathname}`.replace(/^\/+/, "").trim();
    const messageId = (url.searchParams.get("messageId") ?? url.searchParams.get("targetMessageId") ?? "").trim();
    if (!conversationId || !messageId) return null;
    return { conversationId, messageId };
  } catch {
    return null;
  }
}
function findChatMessageElement(root: HTMLElement, messageId: string) {
  const candidates = root.querySelectorAll<HTMLElement>("[data-message-id]");
  return Array.from(candidates).find((element) => element.dataset.messageId === messageId) ?? null;
}
function findChatMessageHighlightElement(target: HTMLElement) {
  return target.querySelector<HTMLElement>("[data-message-highlight-target='true']") ?? target;
}
function revealChatMessageElement(target: HTMLElement) {
  const highlightTarget = findChatMessageHighlightElement(target);
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  target.classList.remove("chat-message-jump-highlight");
  highlightTarget.classList.remove("chat-message-jump-highlight");
  void highlightTarget.offsetWidth;
  highlightTarget.classList.add("chat-message-jump-highlight");
  window.setTimeout(() => { highlightTarget.classList.remove("chat-message-jump-highlight"); }, 1800);
}
const RECENT_PROJECT_CONVERSATION_INITIAL_LIMIT = 5;
const RECENT_PROJECT_CONVERSATION_LOAD_INCREMENT = 10;
const CHAT_LIST_PREVIEW_LIMIT = 40;
const CHAT_ISSUE_MENTION_LIMIT = 50;
const CHAT_SCROLL_MAP_USER_MESSAGE_THRESHOLD = 5;
const CHAT_SCROLL_MAP_MAX_MARKERS = 64;
const CHAT_SCROLL_MAP_PREVIEW_TITLE_LIMIT = 96;
const CHAT_SCROLL_MAP_PREVIEW_SUMMARY_LIMIT = 180;
const CHAT_SCROLL_MAP_RAIL_WIDTH_PX = 16;
const CHAT_SCROLL_MAP_RAIL_GAP_PX = 8;
const CHAT_SCROLL_MAP_RAIL_LEFT_OFFSET_PX = 12;
const CHAT_SCROLL_MAP_CONTENT_SAFE_GAP_PX = 28;
const CHAT_SCROLL_MAP_PREVIEW_WIDTH_PX = 640;
const CHAT_SCROLL_MAP_PREVIEW_VIEWPORT_MARGIN_PX = 16;

function countScrollMapUserMessages(messages: ChatMessage[]) {
  return messages.filter((message) =>
    message.role === "user"
    && message.kind === "message"
    && !message.supersededAt
    && (message.body.trim().length > 0 || message.attachments.length > 0)
  ).length;
}

function chatScrollMapPreviewText(message: ChatMessage) {
  const body = message.body.replace(/\s+/g, " ").trim();
  if (body) return body.length > 140 ? `${body.slice(0, 137)}...` : body;
  if (message.attachments.length > 0) {
    return `${message.attachments.length} attachment${message.attachments.length === 1 ? "" : "s"}`;
  }
  if (message.kind === "issue_proposal") return "Issue proposal";
  if (message.kind === "operation_proposal") return "Operation proposal";
  if (message.kind === "ask_user") return "Question for the operator";
  return "Empty message";
}

function chatScrollMapTextExcerpt(value: string, limit: number) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function findSafeMarkdownExcerptBoundary(source: string, limit: number) {
  if (source.length <= limit) return source.length;

  let boundary = limit;
  while (boundary > 0 && !/\s/u.test(source[boundary - 1] ?? "")) {
    boundary -= 1;
  }
  if (boundary < Math.floor(limit * 0.6)) boundary = limit;

  const prefix = source.slice(0, boundary);
  const lastLinkOpen = prefix.lastIndexOf("](");
  if (lastLinkOpen >= 0) {
    const linkClose = source.indexOf(")", lastLinkOpen + 2);
    if (linkClose >= boundary && linkClose < limit + 96) return linkClose + 1;
    const labelOpen = source.lastIndexOf("[", lastLinkOpen);
    if (labelOpen >= 0 && labelOpen < boundary) return Math.max(0, labelOpen);
  }

  const backtickCount = (prefix.match(/`/g) ?? []).length;
  if (backtickCount % 2 === 1) {
    const lastBacktick = prefix.lastIndexOf("`");
    if (lastBacktick >= 0) return Math.max(0, lastBacktick);
  }

  return boundary;
}

function chatScrollMapMarkdownExcerpt(value: string, limit: number) {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  const boundary = findSafeMarkdownExcerptBoundary(text, limit - 3);
  const excerpt = text.slice(0, boundary).trim();
  if (!excerpt || excerpt.length < Math.floor(limit * 0.6)) return text;
  return `${excerpt}...`;
}

function nextAssistantReplyPreview(message: ChatMessage, messages: ChatMessage[]) {
  const index = messages.findIndex((candidate) => candidate.id === message.id);
  const nextMessage = index >= 0 ? messages[index + 1] : null;
  if (
    !nextMessage
    || nextMessage.role !== "assistant"
    || nextMessage.kind !== "message"
    || nextMessage.supersededAt
  ) {
    return "";
  }
  return chatScrollMapMarkdownExcerpt(nextMessage.body, CHAT_SCROLL_MAP_PREVIEW_SUMMARY_LIMIT);
}

function chatScrollMapPreviewParts(message: ChatMessage, messages: ChatMessage[]) {
  const body = message.body.replace(/\s+/g, " ").trim();
  const assistantReplyPreview = nextAssistantReplyPreview(message, messages);
  if (body) {
    const summarySource = body.length > CHAT_SCROLL_MAP_PREVIEW_TITLE_LIMIT
      ? body.slice(CHAT_SCROLL_MAP_PREVIEW_TITLE_LIMIT).trim()
      : "";
    return {
      title: chatScrollMapMarkdownExcerpt(body, CHAT_SCROLL_MAP_PREVIEW_TITLE_LIMIT),
      summary: assistantReplyPreview || chatScrollMapMarkdownExcerpt(summarySource, CHAT_SCROLL_MAP_PREVIEW_SUMMARY_LIMIT),
    };
  }
  return { title: chatScrollMapPreviewText(message), summary: assistantReplyPreview };
}

function chatScrollMapRoleLabel(message: ChatMessage) {
  if (message.role === "user") return "You";
  if (message.role === "assistant") return "Assistant";
  return "System";
}

function chatScrollMapVisibleMessages(messages: ChatMessage[]) {
  const visible = messages.filter((message) =>
    message.role === "user"
    && message.kind === "message"
    && !message.supersededAt
    && (message.body.trim().length > 0 || message.attachments.length > 0)
  );
  if (visible.length <= CHAT_SCROLL_MAP_MAX_MARKERS) return visible;
  const sampled: ChatMessage[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < CHAT_SCROLL_MAP_MAX_MARKERS; index += 1) {
    const sourceIndex = Math.round((index / (CHAT_SCROLL_MAP_MAX_MARKERS - 1)) * (visible.length - 1));
    const message = visible[sourceIndex];
    if (message && !seen.has(message.id)) {
      seen.add(message.id);
      sampled.push(message);
    }
  }
  return sampled;
}

function ChatScrollMap({
  messages,
  onJump,
}: {
  messages: ChatMessage[];
  onJump: (messageId: string) => void;
}) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null);
  const [previewPosition, setPreviewPosition] = useState<{ left: number; top: number } | null>(null);
  const [railLeft, setRailLeft] = useState<number | null>(null);
  const [railVisible, setRailVisible] = useState(true);
  const mapMessages = useMemo(() => chatScrollMapVisibleMessages(messages), [messages]);
  const hoveredMessage = hoveredMessageId
    ? mapMessages.find((message) => message.id === hoveredMessageId) ?? null
    : null;
  const hoveredPreview = hoveredMessage ? chatScrollMapPreviewParts(hoveredMessage, messages) : null;
  useEffect(() => {
    const rail = railRef.current;
    const shell = rail?.closest<HTMLElement>("[data-testid='chat-messages-shell']");
    if (!rail || !shell) return;

    let frame = 0;
    const updateRailPlacement = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const scrollRegion = shell.closest<HTMLElement>("[data-testid='chat-messages-scroll-region']");
        const anchorBounds = scrollRegion?.getBoundingClientRect() ?? shell.getBoundingClientRect();
        const visibleContentBlocks = Array.from(shell.querySelectorAll<HTMLElement>(
          [
            "[data-testid='chat-user-message-bubble']",
            "[data-testid='chat-inline-message-editor']",
            "[data-testid='chat-assistant-message'] > div",
          ].join(","),
        ));
        const visibleContentLeft = visibleContentBlocks.reduce((left, element) => {
          const bounds = element.getBoundingClientRect();
          if (bounds.bottom <= 0 || bounds.top >= window.innerHeight || bounds.width <= 0) return left;
          return Math.min(left, bounds.left);
        }, Number.POSITIVE_INFINITY);
        const maxLeft = Math.max(
          CHAT_SCROLL_MAP_PREVIEW_VIEWPORT_MARGIN_PX,
          window.innerWidth - CHAT_SCROLL_MAP_RAIL_WIDTH_PX - CHAT_SCROLL_MAP_PREVIEW_VIEWPORT_MARGIN_PX,
        );
        const minLeft = Math.max(CHAT_SCROLL_MAP_PREVIEW_VIEWPORT_MARGIN_PX, anchorBounds.left);
        const anchorLeft = anchorBounds.left + CHAT_SCROLL_MAP_RAIL_LEFT_OFFSET_PX;
        const nextLeft = Math.round(Math.min(Math.max(anchorLeft, minLeft), maxLeft));
        const hasContentClearance = !Number.isFinite(visibleContentLeft)
          || nextLeft + CHAT_SCROLL_MAP_RAIL_WIDTH_PX + CHAT_SCROLL_MAP_CONTENT_SAFE_GAP_PX <= visibleContentLeft;
        setRailVisible((current) => current === hasContentClearance ? current : hasContentClearance);
        if (!hasContentClearance) {
          setHoveredMessageId(null);
          setPreviewPosition(null);
        }
        setRailLeft((current) => current === nextLeft ? current : nextLeft);
      });
    };

    updateRailPlacement();
    const scrollRegion = shell.closest<HTMLElement>("[data-testid='chat-messages-scroll-region']");
    window.addEventListener("resize", updateRailPlacement);
    scrollRegion?.addEventListener("scroll", updateRailPlacement, { passive: true });
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateRailPlacement);
    resizeObserver?.observe(shell);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", updateRailPlacement);
      scrollRegion?.removeEventListener("scroll", updateRailPlacement);
      resizeObserver?.disconnect();
    };
  }, [mapMessages]);
  const updatePreviewPosition = useCallback((target: HTMLElement) => {
    const bounds = target.getBoundingClientRect();
    setPreviewPosition({
      left: Math.min(
        bounds.right + CHAT_SCROLL_MAP_RAIL_GAP_PX,
        Math.max(
          CHAT_SCROLL_MAP_PREVIEW_VIEWPORT_MARGIN_PX,
          window.innerWidth - CHAT_SCROLL_MAP_PREVIEW_WIDTH_PX - CHAT_SCROLL_MAP_PREVIEW_VIEWPORT_MARGIN_PX,
        ),
      ),
      top: Math.min(Math.max(bounds.top + bounds.height / 2, 80), window.innerHeight - 80),
    });
  }, []);
  const showPreview = Boolean(railVisible && hoveredMessage && hoveredPreview && previewPosition);
  if (mapMessages.length === 0) return null;
  return (
    <>
      <div
        ref={railRef}
        data-testid="chat-scroll-map"
        aria-label="Conversation message map"
        className={cn(
          "pointer-events-none fixed top-1/2 z-20 hidden w-4 -translate-y-1/2 flex-col items-start gap-0.5 md:flex",
          (railLeft === null || !railVisible) && "invisible",
        )}
        style={{ left: railLeft ?? 0 }}
      >
          {mapMessages.map((message) => (
            <button
              key={message.id}
              type="button"
              data-testid={`chat-scroll-map-marker-${message.id}`}
              aria-label={`Jump to ${chatScrollMapRoleLabel(message)} message: ${chatScrollMapPreviewText(message)}`}
              className={cn(
                "pointer-events-auto relative z-10 h-2.5 w-4 rounded-[var(--radius-xs)] border border-transparent bg-transparent px-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                "before:absolute before:right-0 before:top-1/2 before:h-0.5 before:w-2.5 before:-translate-y-1/2 before:rounded-full before:bg-[color:color-mix(in_oklab,var(--muted-foreground)_36%,transparent)] before:transition-all",
                "hover:before:w-4 hover:before:bg-[color:var(--foreground)]",
              )}
              onMouseEnter={(event) => {
                setHoveredMessageId(message.id);
                updatePreviewPosition(event.currentTarget);
              }}
              onFocus={(event) => {
                setHoveredMessageId(message.id);
                updatePreviewPosition(event.currentTarget);
              }}
              onMouseLeave={() => {
                setHoveredMessageId((current) => current === message.id ? null : current);
                setPreviewPosition(null);
              }}
              onBlur={() => {
                setHoveredMessageId((current) => current === message.id ? null : current);
                setPreviewPosition(null);
              }}
              onClick={() => onJump(message.id)}
            />
          ))}
      </div>
      {showPreview ? createPortal(
        <div
          data-testid="chat-scroll-map-preview"
          className="pointer-events-none fixed z-50 w-[40rem] max-w-[calc(100vw-2rem)] -translate-y-1/2 rounded-[18px] border border-white/10 bg-[rgba(42,42,42,0.94)] px-4 py-3.5 text-left shadow-[0_24px_70px_-34px_rgb(0_0_0/0.88)] backdrop-blur-xl"
          style={{ left: previewPosition!.left, top: previewPosition!.top }}
        >
          <MarkdownBody className="line-clamp-1 text-[15px] font-semibold leading-6 text-white [&_*]:text-current [&_a]:pointer-events-none [&_a]:align-baseline [&_code]:bg-white/10 [&_code]:text-white/92 [&_p]:inline">
            {hoveredPreview?.title ?? ""}
          </MarkdownBody>
          {hoveredPreview?.summary ? (
            <MarkdownBody className="mt-1.5 line-clamp-3 text-[15px] leading-6 text-white/48 [&_*]:text-current [&_a]:pointer-events-none [&_a]:align-baseline [&_code]:bg-white/10 [&_code]:text-white/70 [&_p]:inline">
              {hoveredPreview.summary}
            </MarkdownBody>
          ) : null}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
function ChatWorkspace() { const { conversationId } = useParams<{ conversationId?: string }>(); const location = useLocation(); const navigate = useNavigate(); const [searchParams] = useSearchParams(); const queryClient = useQueryClient(); const { selectedOrganization, selectedOrganizationId } = useOrganization(); const { viewedOrganizationId } = useViewedOrganization(); const { t } = useI18n(); const { setBreadcrumbs } = useBreadcrumbs(); const { pushToast } = useToast(); const { confirm } = useDialog();
  const {
    abortChatStream,
    sendInFlightByChatId,
    setChatSendInFlight,
    setStreamAbortController,
    setStreamDraftForChat,
    streamDrafts, } = useChatGenerations(); const draftStorageOrgId = selectedOrganizationId!; const draftStorageConversationId = conversationId ?? null; const draftStorageScopeKey = resolveChatPendingAttachmentScopeKey(draftStorageOrgId, draftStorageConversationId); const activeDraftScopeRef = useRef(draftStorageScopeKey);
  const [draftState, setDraftState] = useState(() => ({
    scopeKey: draftStorageScopeKey,
    value: readChatDraft(draftStorageOrgId, draftStorageConversationId), })); const draft = draftState.scopeKey === draftStorageScopeKey ? draftState.value : ""; const setDraft = useCallback((nextDraft: string) => { setDraftState((current) => ({ ...current, value: nextDraft })); }, []); const [, refreshPendingFiles] = useState(0); const pendingFiles = readChatPendingAttachmentsForScope(draftStorageScopeKey);
  const setPendingFilesForCurrentScope = useCallback((updater: (current: File[]) => File[]) => { updateChatPendingAttachmentsForScope(draftStorageScopeKey, updater); refreshPendingFiles((version) => version + 1); }, [draftStorageScopeKey]); const clearPendingFilesForCurrentScope = useCallback(() => { setPendingFilesForCurrentScope(() => []); }, [setPendingFilesForCurrentScope]); const [newConversationSendInFlight, setNewConversationSendInFlight] = useState(false); const [openProcessMessageIds, setOpenProcessMessageIds] = useState<Record<string, true>>({}); const [loadingTranscriptMessageIds, setLoadingTranscriptMessageIds] = useState<Record<string, true>>({}); const [loadedTranscriptsByMessageId, setLoadedTranscriptsByMessageId] = useState<Record<string, TranscriptEntry[]>>({}); const [draftPreferredAgentId, setDraftPreferredAgentId] = useState<string>(NO_CHAT_AGENT_ID); const [draftProjectId, setDraftProjectId] = useState<string>(NO_PROJECT_ID);
  const [pendingProjectContextOverride, setPendingProjectContextOverride] = useState<{ chatId: string; projectId: string | null; } | null>(null); const [draftPlanMode, setDraftPlanMode] = useState(false); const [pendingPlanModeOverride, setPendingPlanModeOverride] = useState<boolean | null>(null); const [decisionNotesByMessageId, setDecisionNotesByMessageId] = useState<Record<string, string>>({}); const [issueProposalOverridesByMessageId, setIssueProposalOverridesByMessageId] = useState<Record<string, Record<string, unknown>>>({}); const [plusMenuOpen, setPlusMenuOpen] = useState(false); const [agentMenuOpen, setAgentMenuOpen] = useState(false); const [projectMenuOpen, setProjectMenuOpen] = useState(false); const [skillMenuOpen, setSkillMenuOpen] = useState(false); const [skillSearchQuery, setSkillSearchQuery] = useState(""); const [libraryFileMentionQuery, setLibraryFileMentionQuery] = useState<string | null>(null); const [composerMenuPosition, setComposerMenuPosition] = useState<CSSProperties | null>(null); const [inlineEditUserMessageId, setInlineEditUserMessageId] = useState<string | null>(null); const [inlineEditDraft, setInlineEditDraft] = useState(""); const [editingQueuedItem, setEditingQueuedItem] = useState<{ itemId: string; value: string; version: number } | null>(null); const [branchPreview, setBranchPreview] = useState<ChatBranchPreview | null>(null); const [emptyStateActiveTab, setEmptyStateActiveTab] = useState<"recent" | "use-cases">("use-cases"); const [emptyStateActiveSuggestionIndex, setEmptyStateActiveSuggestionIndex] = useState(0); const [dismissedEmptyStatePromptQuery, setDismissedEmptyStatePromptQuery] = useState<string | null>(null); const [retainedEmptyStatePromptSuggestions, setRetainedEmptyStatePromptSuggestions] = useState<readonly EmptyStatePromptSuggestion[]>([]); const [recentProjectConversationLimit, setRecentProjectConversationLimit] = useState(RECENT_PROJECT_CONVERSATION_INITIAL_LIMIT); const [attachmentPreview, setAttachmentPreview] = useState<AttachmentPreviewState | null>(null); const [recentAskUserAnswerMessageId, setRecentAskUserAnswerMessageId] = useState<string | null>(null); const [renamingConversationId, setRenamingConversationId] = useState<string | null>(null); const [renameDraft, setRenameDraft] = useState(""); const [generatingChatTitleIds, setGeneratingChatTitleIds] = useState<Set<string>>(() => new Set()); const [workManifestWideOpen, setWorkManifestWideOpen] = useState(true); const fileInputRef = useRef<HTMLInputElement>(null); const composerSurfaceRef = useRef<HTMLDivElement>(null); const composerEditorRef = useRef<MarkdownEditorRef>(null); const inlineEditSurfaceRef = useRef<HTMLDivElement>(null); const inlineEditEditorRef = useRef<MarkdownEditorRef>(null); const composerContextMenuRef = useRef<HTMLDivElement>(null); const composerEditorScrollRef = useScrollbarActivityRef(); const skillSearchInputRef = useRef<HTMLInputElement>(null); const stopRequestedChatIdsRef = useRef<Set<string>>(new Set()); const autoDequeuingChatIdsRef = useRef<Set<string>>(new Set()); const manuallyMarkedUnreadKeyRef = useRef<string | null>(null); const newConversationSendLockRef = useRef(false); const chatSendLocksRef = useRef<Record<string, true>>({}); const lastAppliedPrefillRef = useRef<string | null>(null); const lastAppliedAgentPrefillRef = useRef<string | null>(null); const lastAppliedProjectPrefillRef = useRef<string | null>(null); const draftProjectScopeKeyRef = useRef<string | null>(null); const draftProjectDefaultKeyRef = useRef<string | null>(null); const draftProjectManuallySelectedRef = useRef(false); const chatMessagesScrollElementRef = useRef<HTMLDivElement | null>(null); const initialScrolledConversationRef = useRef<string | null>(null); const { isMobile, setSidebarOpen, sidebarOpen } = useSidebar(); const { open: sidePanelOpen, openTarget: openSidePanelTarget, openTargetForContext: openSidePanelTargetForContext, showPanelForContext: showSidePanelForContext } = useSidePanel(); const chatMessagesActivityRef = useScrollbarActivityRef(); const chatMessagesScrollRef = useCallback((element: HTMLDivElement | null) => { chatMessagesScrollElementRef.current = element; chatMessagesActivityRef(element); }, [chatMessagesActivityRef]); const pendingPrefill = searchParams.get("prefill") ?? ""; const pendingAgentPrefill = searchParams.get("agentId")?.trim() ?? ""; const pendingProjectPrefill = searchParams.get("projectId")?.trim() ?? ""; const pendingIssueId = searchParams.get("issueId")?.trim() ?? ""; const pendingTargetMessageId = (searchParams.get("messageId") ?? searchParams.get("targetMessageId") ?? "").trim(); const isMessengerChatRoute = /^\/(?:[^/]+\/)?messenger\/chat(?:\/|$)/.test(location.pathname); const relativePath = toOrganizationRelativePath(location.pathname); const chatRouteBase = relativePath.startsWith("/messenger/chat") ? "/messenger/chat" : "/chat"; const chatRootPath = chatRouteBase; const chatConversationPath = useCallback((id: string) => `${chatRouteBase}/${id}`, [chatRouteBase]); const resolveCurrentSidePanelChatContextKey = useCallback(() => { const activePath = typeof window === "undefined" ? relativePath : toOrganizationRelativePath(window.location.pathname); const match = activePath.match(/^\/(?:messenger\/)?chat\/([^/?#]+)/); const chatId = match?.[1] ?? conversationId ?? null; return chatId ? `chat:${chatId}` : null; }, [conversationId, relativePath]); const openLocalFile = useCallback((targetPath: string) => { const desktopShell = readDesktopShell();
    if (!desktopShell) {
      pushToast({
        title: "Open from Desktop",
        body: "Local chat file links can only be opened from the Rudder Desktop app.", tone: "warn", });
      return; }
    void desktopShell.openPath(targetPath).catch((error) => {
      pushToast({
        title: "Failed to open file",
        body: error instanceof Error ? error.message : `Could not open ${targetPath}.`, tone: "error", }); }); }, [pushToast]);
  const organizationRouteMatchesSelection = Boolean(
    viewedOrganizationId && viewedOrganizationId === selectedOrganizationId,
  );
  const handleChatMarkdownLinkClick = useCallback<MarkdownLinkClickHandler>(({ event, href, label }) => { if (!shouldHandlePlainChatLinkClick(event)) return; const sidePanelTarget = chatSidePanelTargetFromHref(href, label); if (sidePanelTarget) { event.preventDefault(); event.stopPropagation(); openSidePanelTargetForContext(resolveCurrentSidePanelChatContextKey(), sidePanelTarget); return true; } const chatMessageTarget = chatMessageJumpTargetFromHref(href); if (chatMessageTarget) { event.preventDefault(); event.stopPropagation(); navigate({
        pathname: chatConversationPath(chatMessageTarget.conversationId),
        search: `?messageId=${encodeURIComponent(chatMessageTarget.messageId)}`,
      }); return true; } const targetPath = resolveLocalFileTarget(href); if (!targetPath) return; event.preventDefault(); event.stopPropagation(); openLocalFile(targetPath); return true; }, [chatConversationPath, navigate, openLocalFile, openSidePanelTargetForContext, resolveCurrentSidePanelChatContextKey]); const composerContextMenuOpen = projectMenuOpen || agentMenuOpen || skillMenuOpen;
  useEffect(() => { activeDraftScopeRef.current = draftStorageScopeKey; }, [draftStorageScopeKey]); const closeComposerContextMenus = useCallback(() => { setProjectMenuOpen(false); setAgentMenuOpen(false); setSkillMenuOpen(false); setSkillSearchQuery(""); }, []); const openComposerContextMenu = useCallback((kind: "project" | "agent" | "skill") => { const anchor = composerSurfaceRef.current;
    if (anchor) {
      setComposerMenuPosition(composerMenuPositionForAnchor(anchor)); } setProjectMenuOpen(kind === "project"); setAgentMenuOpen(kind === "agent"); setSkillMenuOpen(kind === "skill");
    if (kind !== "skill") {
      setSkillSearchQuery(""); } }, []); const appendPendingFiles = useCallback(
    async (incomingFiles: Iterable<File>) => { const files = Array.from(incomingFiles).filter((file) => file.size > 0); if (files.length === 0) return;
      try { const safeFiles = await Promise.all( files.map((file, index) => materializePendingAttachment(file, index)), ); setPendingFilesForCurrentScope((current) => [...current, ...safeFiles]);
      } catch (error) {
        pushToast({
          title: "Failed to stage attachment",
          body: error instanceof Error ? error.message : undefined,
          tone: "error",
        }); } }, [pushToast, setPendingFilesForCurrentScope], ); const removePendingFile = useCallback((targetKey: string) => { setPendingFilesForCurrentScope((current) => current.filter((file) => pendingAttachmentKey(file) !== targetKey)); }, [setPendingFilesForCurrentScope]);
  const handlePendingAttachmentPasteCapture = useCallback((event: ReactClipboardEvent<HTMLElement>) => { const clipboardData = event.clipboardData; const filesFromItems = Array.from(clipboardData?.items ?? []) .filter((item) => item.kind === "file") .map((item) => item.getAsFile()) .filter((file): file is File => file instanceof File); const seenItemPayloads = new Map<string, number>(); for (const file of filesFromItems) { const key = clipboardAttachmentPayloadKey(file); seenItemPayloads.set(key, (seenItemPayloads.get(key) ?? 0) + 1); } const filesFromList = Array.from(clipboardData?.files ?? []) .filter((file) => { const key = clipboardAttachmentPayloadKey(file); const remaining = seenItemPayloads.get(key) ?? 0; if (remaining <= 0) return true; if (remaining === 1) { seenItemPayloads.delete(key); } else { seenItemPayloads.set(key, remaining - 1); } return false; }); const files = [...filesFromItems, ...filesFromList]; if (files.length === 0) return; event.preventDefault(); event.stopPropagation(); void appendPendingFiles(files); }, [appendPendingFiles]);
  useEffect(() => { if (draftState.scopeKey === draftStorageScopeKey) return;
    setDraftState({
      scopeKey: draftStorageScopeKey, value: readChatDraft(draftStorageOrgId, draftStorageConversationId), }); }, [draftState.scopeKey, draftStorageConversationId, draftStorageOrgId, draftStorageScopeKey]);
  useEffect(() => { if (draftState.scopeKey !== draftStorageScopeKey) return; saveChatDraft(draftStorageOrgId, draftStorageConversationId, draftState.value); }, [draftState.scopeKey, draftState.value, draftStorageConversationId, draftStorageOrgId, draftStorageScopeKey]);
  useEffect(() => { if (!pendingPrefill) return; if (pendingPrefill === lastAppliedPrefillRef.current) return; if (draft.trim().length > 0) return; lastAppliedPrefillRef.current = pendingPrefill; setDraft(pendingPrefill);
    requestAnimationFrame(() => { composerEditorRef.current?.focus(); }); const nextSearch = new URLSearchParams(searchParams); nextSearch.delete("prefill");
    navigate( {
        pathname: conversationId ? chatConversationPath(conversationId) : chatRootPath,
        search: nextSearch.toString() ? `?${nextSearch.toString()}` : "", }, { replace: true }, ); }, [chatConversationPath, chatRootPath, conversationId, draft, navigate, pendingPrefill, searchParams]); const conversationsQuery = useQuery({
    queryKey: queryKeys.chats.listPreview(selectedOrganizationId ?? "__none__", "active", CHAT_LIST_PREVIEW_LIMIT),
    queryFn: () => chatsApi.list(selectedOrganizationId!, "active", { limit: CHAT_LIST_PREVIEW_LIMIT }), enabled: !!selectedOrganizationId && isMobile, }); const mentionConversationsQuery = useQuery({
    queryKey: queryKeys.chats.listPreview(selectedOrganizationId ?? "__none__", "active", CHAT_LIST_PREVIEW_LIMIT),
    queryFn: () => chatsApi.list(selectedOrganizationId!, "active", { limit: CHAT_LIST_PREVIEW_LIMIT }), enabled: !!selectedOrganizationId, }); const conversationQuery = useQuery({
    queryKey: queryKeys.chats.detail(selectedOrganizationId ?? "__none__", conversationId ?? "__none__"),
    queryFn: () => chatsApi.get(conversationId!), enabled: !!selectedOrganizationId && !!conversationId && organizationRouteMatchesSelection, }); const activeConversationFromList = conversationsQuery.data?.find((conversation) => conversation.id === conversationId) ?? null; const activeConversationBelongsToSelectedOrganization = organizationRouteMatchesSelection && (
    conversationQuery.data
      ? conversationQuery.data.orgId === selectedOrganizationId
      : activeConversationFromList?.orgId === selectedOrganizationId); const messagesQuery = useQuery({
    queryKey: queryKeys.chats.messages(selectedOrganizationId ?? "__none__", conversationId ?? "__none__"),
    queryFn: () => chatsApi.listMessages(conversationId!, { includeTranscript: false }), enabled: !!conversationId && activeConversationBelongsToSelectedOrganization, });
  const workManifestQuery = useQuery({
    queryKey: queryKeys.chats.workManifest(selectedOrganizationId ?? "__none__", conversationId ?? "__none__"),
    queryFn: () => chatsApi.getWorkManifest(conversationId!),
    enabled: !!conversationId && activeConversationBelongsToSelectedOrganization,
    retry: false,
  });
  const workManifest = workManifestQuery.data ?? null;
  const workManifestAvailable = !workManifestQuery.isPending
    && (Boolean(workManifestQuery.error) || hasChatWorkManifestContent(workManifest));
  const workManifestRailOpen = workManifestAvailable && workManifestWideOpen && !sidePanelOpen;
  useEffect(() => {
    if (workManifestQuery.error) setWorkManifestWideOpen(true);
  }, [conversationId, workManifestQuery.error]);
  const queueQuery = useQuery({
    queryKey: queryKeys.chats.queue(selectedOrganizationId ?? "__none__", conversationId ?? "__none__"),
    queryFn: () => chatsApi.listQueue(conversationId!),
    enabled: !!conversationId && activeConversationBelongsToSelectedOrganization,
    refetchInterval: conversationId ? 2_000 : false,
  });
  const { data: agents, error: agentsError } = useQuery({
    queryKey: queryKeys.agents.list(selectedOrganizationId ?? "__none__"),
    queryFn: () => agentsApi.list(selectedOrganizationId!), enabled: !!selectedOrganizationId, }); const liveAgents = useMemo(() => selectableChatAgents(agents), [agents]);
  const { data: projects, error: projectsError } = useQuery({
    queryKey: queryKeys.projects.list(selectedOrganizationId ?? "__none__"),
    queryFn: () => projectsApi.list(selectedOrganizationId!), enabled: !!selectedOrganizationId, }); const visibleProjects = useMemo(
    () => (projects ?? []).filter((project) => !project.archivedAt), [projects], );
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const intelligenceProfilesQuery = useQuery({
    queryKey: queryKeys.organizations.intelligenceProfiles(selectedOrganizationId ?? "__none__"),
    queryFn: () => organizationsApi.listIntelligenceProfiles(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });
  const canRegenerateChatTitles = useMemo(() => {
    const profiles = intelligenceProfilesQuery.data ?? [];
    return profiles.some((profile) => profile?.purpose === "lightweight" && profile.status === "configured");
  }, [intelligenceProfilesQuery.data]);
  const { data: issues, error: issuesError } = useQuery({
    queryKey: queryKeys.issues.listPreview(selectedOrganizationId ?? "__none__", CHAT_ISSUE_MENTION_LIMIT),
    queryFn: () => issuesApi.list(selectedOrganizationId!, { limit: CHAT_ISSUE_MENTION_LIMIT }), enabled: !!selectedOrganizationId, }); const { data: libraryDocuments } = useQuery({
    queryKey: queryKeys.organizations.libraryDocuments(selectedOrganizationId ?? "__none__"),
    queryFn: () => organizationsApi.listLibraryDocuments(selectedOrganizationId!), enabled: !!selectedOrganizationId, });
  const normalizedLibraryFileMentionQuery = libraryFileMentionQuery?.trim() ?? "";
  const { data: libraryMentionFiles } = useQuery({
    queryKey: queryKeys.organizations.workspaceMentionFiles(selectedOrganizationId ?? "__none__", normalizedLibraryFileMentionQuery),
    queryFn: () => organizationsApi.listWorkspaceMentionFiles(selectedOrganizationId!, {
      query: normalizedLibraryFileMentionQuery,
      limit: normalizedLibraryFileMentionQuery ? 50 : 200,
    }), enabled: !!selectedOrganizationId, }); const profileQuery = useQuery({
    queryKey: queryKeys.instance.profileSettings, queryFn: () => instanceSettingsApi.getProfile(), }); const generalSettingsQuery = useQuery({
    queryKey: queryKeys.instance.generalSettings, queryFn: () => instanceSettingsApi.getGeneral(), }); const showDeveloperDiagnostics = generalSettingsQuery.data?.showDeveloperDiagnostics === true;
  useEffect(() => { if (pendingPrefill) return; const hasAgentPrefill = pendingAgentPrefill.length > 0; const hasProjectPrefill = pendingProjectPrefill.length > 0; if (!hasAgentPrefill && !hasProjectPrefill) return;
    const agentAlreadyApplied = !hasAgentPrefill || pendingAgentPrefill === lastAppliedAgentPrefillRef.current;
    const projectAlreadyApplied = !hasProjectPrefill || pendingProjectPrefill === lastAppliedProjectPrefillRef.current; if (agentAlreadyApplied && projectAlreadyApplied) return;
    if (!conversationId) { if (hasAgentPrefill && !agentAlreadyApplied && !agents) return; if (hasProjectPrefill && !projectAlreadyApplied && !projects) return;
      if (hasAgentPrefill && !agentAlreadyApplied && agents) { const requestedAgentId = resolveRequestedPreferredAgentId(pendingAgentPrefill, agents);
        if (requestedAgentId) { setDraftPreferredAgentId(requestedAgentId);
          if (selectedOrganizationId) {
            rememberChatAgentId(selectedOrganizationId, requestedAgentId); } } }
      if (hasProjectPrefill && !projectAlreadyApplied && projects) { const requestedProject = visibleProjects.find((project) => project.id === pendingProjectPrefill);
        if (requestedProject) { setDraftProjectId(requestedProject.id); draftProjectDefaultKeyRef.current = null;
          if (selectedOrganizationId) {
            rememberChatProjectId(selectedOrganizationId, requestedProject.id);
            const requestedAgentId = hasAgentPrefill && agents ? resolveRequestedPreferredAgentId(pendingAgentPrefill, agents) : draftPreferredAgentId === NO_CHAT_AGENT_ID ? null : draftPreferredAgentId;
            rememberChatProjectIdForAgent(selectedOrganizationId, requestedAgentId, requestedProject.id); } } } } const nextSearch = new URLSearchParams(searchParams);
    if (hasAgentPrefill && !agentAlreadyApplied) { lastAppliedAgentPrefillRef.current = pendingAgentPrefill;
      nextSearch.delete("agentId"); }
    if (hasProjectPrefill && !projectAlreadyApplied) { lastAppliedProjectPrefillRef.current = pendingProjectPrefill;
      nextSearch.delete("projectId"); }
    navigate( {
        pathname: conversationId ? chatConversationPath(conversationId) : chatRootPath,
        search: nextSearch.toString() ? `?${nextSearch.toString()}` : "", }, { replace: true }, );
  }, [
    agents,
    chatConversationPath,
    chatRootPath,
    conversationId,
    navigate,
    pendingPrefill,
    pendingAgentPrefill,
    pendingProjectPrefill,
    projects,
    searchParams,
    selectedOrganizationId, visibleProjects, draftPreferredAgentId, ]); const selectedConversation = activeConversationBelongsToSelectedOrganization
    ? conversationQuery.data ?? activeConversationFromList
    : null; const customGroupsQuery = useQuery({
    queryKey: queryKeys.messenger.customGroups(selectedOrganizationId ?? "__none__"),
    queryFn: () => messengerApi.listCustomGroups(selectedOrganizationId!),
    enabled: !!selectedOrganizationId && !!selectedConversation,
  }); const customGroups = customGroupsQuery.data?.groups ?? []; const selectedConversationThreadKey = selectedConversation ? `chat:${selectedConversation.id}` : null; const selectedConversationCustomGroupId = selectedConversationThreadKey
    ? customGroups.find((group) => group.entries.some((entry) => entry.threadKey === selectedConversationThreadKey))?.id ?? null
    : null; const selectedConversationGenerating = Boolean(selectedConversation && (streamDrafts[selectedConversation.id] || sendInFlightByChatId[selectedConversation.id])); const selectedConversationTitleGenerating = Boolean(selectedConversation && generatingChatTitleIds.has(selectedConversation.id)); const draftIssueContext = !selectedConversation ? resolveDraftIssueContext(issues, pendingIssueId) : null; const draftIssueContextId = !selectedConversation && pendingIssueId ? draftIssueContext?.id ?? pendingIssueId : null; const activeAgentId = selectedConversation?.preferredAgentId ?? draftPreferredAgentId; const selectedConversationProjectId = projectContextId(selectedConversation);
  const pendingSelectedConversationProjectId = selectedConversation && pendingProjectContextOverride?.chatId === selectedConversation.id ? pendingProjectContextOverride.projectId : undefined; const activeProjectId = selectedConversation ? (pendingSelectedConversationProjectId ?? selectedConversationProjectId ?? NO_PROJECT_ID) : draftProjectId; const activePlanMode = pendingPlanModeOverride ?? selectedConversation?.planMode ?? draftPlanMode; const activeSkillAgentId = activeAgentId === NO_CHAT_AGENT_ID ? null : activeAgentId; const activeSkillAgent = activeSkillAgentId ? (agents ?? []).find((agent) => agent.id === activeSkillAgentId) ?? null : null; const draftProjectScopeKey = `${selectedOrganizationId ?? "__none__"}:${conversationId ?? "new"}:${pendingIssueId || "__no_issue__"}`; const draftIssueProjectKey = draftIssueContext?.projectId ?? "__no_issue_project__"; const draftProjectDefaultKey = selectedConversation ? null : `${draftProjectScopeKey}:${activeSkillAgentId ?? "__no_agent__"}:${draftIssueProjectKey}`;
  const {
    data: organizationSkills,
    error: organizationSkillsError,
    isPending: organizationSkillsPending,
  } = useQuery({
    queryKey: queryKeys.organizationSkills.list(selectedOrganizationId ?? "__none__"),
    queryFn: () => organizationSkillsApi.list(selectedOrganizationId!), enabled: !!selectedOrganizationId, });
  const {
    data: activeAgentSkillSnapshot,
    error: activeAgentSkillsError,
    isPending: activeAgentSkillsPending,
  } = useQuery({
    queryKey: queryKeys.agents.skills(activeSkillAgentId ?? "__none__"),
    queryFn: () => agentsApi.skills(activeSkillAgentId!, selectedOrganizationId!), enabled: Boolean(selectedOrganizationId) && Boolean(activeSkillAgentId), });
  useEffect(() => { setInlineEditUserMessageId(null); setInlineEditDraft(""); setBranchPreview(null); setAttachmentPreview(null); setRecentAskUserAnswerMessageId(null); setIssueProposalOverridesByMessageId({}); }, [conversationId]);
  useEffect(() => { setSkillMenuOpen(false); setSkillSearchQuery(""); }, [activeSkillAgentId]);
  useEffect(() => {
    if (!composerContextMenuOpen) { setComposerMenuPosition(null);
      return; } const updatePosition = () => { const anchor = composerSurfaceRef.current; if (!anchor) return; setComposerMenuPosition(composerMenuPositionForAnchor(anchor)); }; updatePosition(); window.addEventListener("resize", updatePosition); window.addEventListener("scroll", updatePosition, true);
    return () => { window.removeEventListener("resize", updatePosition); window.removeEventListener("scroll", updatePosition, true); }; }, [composerContextMenuOpen]);
  useEffect(() => { if (!composerContextMenuOpen) return; const handlePointerDown = (event: PointerEvent) => { const target = event.target; if (!(target instanceof Node)) return; if (composerContextMenuRef.current?.contains(target)) return; if (composerSurfaceRef.current?.contains(target)) return; closeComposerContextMenus(); }; const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { closeComposerContextMenus(); } }; document.addEventListener("pointerdown", handlePointerDown, true); document.addEventListener("keydown", handleKeyDown, true);
    return () => { document.removeEventListener("pointerdown", handlePointerDown, true); document.removeEventListener("keydown", handleKeyDown, true); }; }, [closeComposerContextMenus, composerContextMenuOpen]);
  useEffect(() => { if (!skillMenuOpen) return;
    requestAnimationFrame(() => { skillSearchInputRef.current?.focus(); }); }, [skillMenuOpen]);
  useEffect(() => { if (!selectedOrganizationId) return;
    if (!conversationId) { setBreadcrumbs([{ label: chatRouteBase.startsWith("/messenger") ? "Messenger" : "Chat" }]);
      return; }
    if (selectedConversation) { const primary = selectedConversation.primaryIssue;
      if (primary) {
        setBreadcrumbs([ {
            label: selectedConversation.title,
            sublabel: formatChatPrimaryIssueBreadcrumb(primary), subhref: `/issues/${primary.identifier ?? primary.id}`, }, ]);
      } else {
        setBreadcrumbs([{ label: selectedConversation.title }]); }
      return; } setBreadcrumbs([{ label: chatRouteBase.startsWith("/messenger") ? "Messenger" : "Chat" }]); }, [chatRouteBase, selectedOrganizationId, conversationId, selectedConversation, setBreadcrumbs]);
  useEffect(() => { if (!selectedConversation) return; setDraftPlanMode(selectedConversation.planMode); setPendingPlanModeOverride((pending) => pending === selectedConversation.planMode ? null : pending);
  }, [
    selectedConversation?.id, selectedConversation?.planMode, ]);
  useEffect(() => { if (!selectedOrganizationId || !agents) return;
    if (selectedConversation?.preferredAgentId) { setDraftPreferredAgentId(selectedConversation.preferredAgentId);
      if (isSelectableChatAgentId(selectedConversation.preferredAgentId, agents)) {
        rememberChatAgentId(selectedOrganizationId, selectedConversation.preferredAgentId); }
      return; } const defaultAgentId = resolveDefaultChatAgentId(selectedOrganizationId, agents);
    setDraftPreferredAgentId((current) => ( isSelectableChatAgentId(current, agents) ? current : defaultAgentId ));
  }, [
    agents,
    selectedConversation?.id,
    selectedConversation?.preferredAgentId, selectedOrganizationId, ]);
  useEffect(() => { if (!selectedOrganizationId || !selectedConversation) return; const projectId = projectContextId(selectedConversation); setDraftProjectId(projectId ?? NO_PROJECT_ID); rememberChatProjectId(selectedOrganizationId, projectId);
    if (selectedConversation.preferredAgentId) {
      rememberChatProjectIdForAgent(selectedOrganizationId, selectedConversation.preferredAgentId, projectId); }
    draftProjectScopeKeyRef.current = null; draftProjectDefaultKeyRef.current = null; draftProjectManuallySelectedRef.current = false;
  }, [
    selectedOrganizationId,
    selectedConversation?.id, selectedConversation?.contextLinks, selectedConversation?.preferredAgentId, ]);
  useEffect(() => { if (draftProjectScopeKeyRef.current === draftProjectScopeKey) return; draftProjectScopeKeyRef.current = draftProjectScopeKey; draftProjectDefaultKeyRef.current = null; draftProjectManuallySelectedRef.current = false; }, [draftProjectScopeKey]);
  useEffect(() => { if (!selectedOrganizationId || selectedConversation || !projects || pendingProjectPrefill || !draftProjectDefaultKey) return;
    if (pendingIssueId && !issues) return;
    if (draftProjectManuallySelectedRef.current || draftProjectDefaultKeyRef.current === draftProjectDefaultKey) return;
    draftProjectDefaultKeyRef.current = draftProjectDefaultKey; setDraftProjectId(resolveDefaultDraftChatProjectId({
      orgId: selectedOrganizationId,
      projects: visibleProjects,
      issue: draftIssueContext,
      agentId: activeSkillAgentId,
    })); }, [activeSkillAgentId, draftIssueContext, draftProjectDefaultKey, issues, pendingIssueId, pendingProjectPrefill, projects, selectedConversation, selectedOrganizationId, visibleProjects]);
  useEffect(() => {
    if (!organizationRouteMatchesSelection || !conversationId || !conversationQuery.data || activeConversationBelongsToSelectedOrganization) return;
    navigate(chatRootPath, { replace: true });
  }, [activeConversationBelongsToSelectedOrganization, chatRootPath, conversationId, conversationQuery.data, navigate, organizationRouteMatchesSelection]);
  const showConversationLoading = Boolean(
    conversationId && (!organizationRouteMatchesSelection || (!selectedConversation && conversationQuery.isPending && conversationQuery.data === undefined)),
  );
  useEffect(() => { if (!selectedOrganizationId || !organizationRouteMatchesSelection) return; if (!relativePath.startsWith("/messenger/chat")) return; rememberMessengerPath(selectedOrganizationId, relativePath); }, [organizationRouteMatchesSelection, relativePath, selectedOrganizationId]); const refreshChat = async (chatId?: string | null) => { if (!selectedOrganizationId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(selectedOrganizationId, "active") }),
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(selectedOrganizationId, "all") }), invalidateMessengerThreadSummaryQueries(queryClient, selectedOrganizationId), ]);
    if (chatId) { await queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(selectedOrganizationId, chatId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.chats.messages(selectedOrganizationId, chatId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.chats.workManifest(selectedOrganizationId, chatId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.chats.queue(selectedOrganizationId, chatId) }); } await queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedOrganizationId) }); }; const upsertConversation = (conversation: ChatConversation) => { queryClient.setQueryData(queryKeys.chats.detail(conversation.orgId, conversation.id), conversation);
    for (const status of ["active", "all"] as const) {
      queryClient.setQueryData<ChatConversation[]>(
        queryKeys.chats.list(selectedOrganizationId ?? "__none__", status), (current) => mergeChatConversationsForStatus(current ?? [], conversation, status), ); } }; const upsertMessengerThreadSummary = useCallback((
    conversation: ChatConversation,
    options?: { latestActivityAt?: Date;
      preview?: string | null; },
  ) => { if (!selectedOrganizationId) return;
    const nextSummary = buildMessengerChatThreadSummary(conversation, options);
    upsertMessengerThreadSummaryQueries(queryClient, selectedOrganizationId, nextSummary); }, [queryClient, selectedOrganizationId]); const upsertOptimisticConversation = (
    conversation: ChatConversation,
    body: string,
    sentAt: Date,
  ) => { const optimisticConversation = withOptimisticOutgoingMessage(conversation, body, sentAt); upsertConversation(optimisticConversation);
    upsertMessengerThreadSummary(optimisticConversation, {
      latestActivityAt: sentAt, preview: body, }); return optimisticConversation; }; const upsertMessages = (chatId: string, incoming: ChatMessage[]) => {
    queryClient.setQueryData<ChatMessage[]>(
      queryKeys.chats.messages(selectedOrganizationId ?? "__none__", chatId), (current) => mergeChatMessages(current ?? [], incoming), ); }; const acquireNewConversationSendLock = useCallback(() => { if (newConversationSendLockRef.current) return false; newConversationSendLockRef.current = true; setNewConversationSendInFlight(true); return true; }, []); const releaseNewConversationSendLock = useCallback(() => { if (!newConversationSendLockRef.current) return; newConversationSendLockRef.current = false; setNewConversationSendInFlight(false); }, []); const acquireChatSendLock = useCallback((chatId: string) => { if (chatSendLocksRef.current[chatId]) return false;
    chatSendLocksRef.current = { ...chatSendLocksRef.current, [chatId]: true, }; return true; }, []); const releaseChatSendLock = useCallback((chatId: string) => { if (!(chatId in chatSendLocksRef.current)) return; const { [chatId]: _removed, ...rest } = chatSendLocksRef.current; chatSendLocksRef.current = rest; }, []); const setProcessOpenForMessage = useCallback((messageId: string, open: boolean) => {
    setOpenProcessMessageIds((current) => {
      if (open) { if (current[messageId]) return current;
        return { ...current, [messageId]: true }; } if (!(messageId in current)) return current; const { [messageId]: _removed, ...rest } = current; return rest; }); }, []); const loadMessageTranscript = useCallback(async (chatId: string, messageId: string) => {
    if (loadingTranscriptMessageIds[messageId]) return;
    setLoadingTranscriptMessageIds((current) => ({ ...current, [messageId]: true }));
    try {
      const response = await chatsApi.getMessageTranscript(chatId, messageId);
      const transcript = response.transcript as TranscriptEntry[];
      setLoadedTranscriptsByMessageId((current) => ({ ...current, [messageId]: transcript }));
      queryClient.setQueryData<ChatMessage[]>(
        queryKeys.chats.messages(selectedOrganizationId ?? "__none__", chatId),
        (current) => (current ?? []).map((message) =>
          message.id === messageId
            ? { ...message, transcript }
            : message,
        ),
      );
      setProcessOpenForMessage(messageId, true);
    } catch (error) {
      pushToast({
        title: "Failed to load process details",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      });
    } finally {
      setLoadingTranscriptMessageIds((current) => {
        if (!(messageId in current)) return current;
        const { [messageId]: _removed, ...rest } = current;
        return rest;
      });
    }
  }, [loadingTranscriptMessageIds, pushToast, queryClient, selectedOrganizationId, setProcessOpenForMessage]); const keepProcessOpenForMessages = useCallback((messages: ChatMessage[]) => { const messageIds = messages .filter((message) => { const transcript = (message.transcript ?? []) as TranscriptEntry[];
        return transcript.length > 0 && (
            message.role === "assistant"
            || message.kind === "issue_proposal" || message.kind === "operation_proposal" ); }) .map((message) => message.id); if (messageIds.length === 0) return;
    setOpenProcessMessageIds((current) => { let changed = false; const next = { ...current };
      for (const messageId of messageIds) { if (next[messageId]) continue; next[messageId] = true;
        changed = true; } return changed ? next : current; }); }, []); const setDecisionNoteForMessage = useCallback((messageId: string, value: string) => {
    setDecisionNotesByMessageId((current) => {
      if (!value.trim()) { if (!(messageId in current)) return current; const { [messageId]: _removed, ...rest } = current;
        return rest; } return { ...current, [messageId]: value }; }); }, []); const clearDecisionNoteForMessage = useCallback((messageId: string) => {
    setDecisionNotesByMessageId((current) => { if (!(messageId in current)) return current; const { [messageId]: _removed, ...rest } = current; return rest; }); }, []); const setIssueProposalOverrideForMessage = useCallback((messageId: string, nextProposal: Record<string, unknown>) => {
    setIssueProposalOverridesByMessageId((current) => ({ ...current, [messageId]: nextProposal }));
  }, []); const refreshActiveChatActions = useCallback(async (chatId?: string) => {
    if (!selectedOrganizationId) return;
    await Promise.all([
      invalidateMessengerThreadSummaryQueries(queryClient, selectedOrganizationId),
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(selectedOrganizationId, "all") }),
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(selectedOrganizationId, "active") }),
    ]);
    if (chatId) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(selectedOrganizationId, chatId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.chats.messages(selectedOrganizationId, chatId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.chats.workManifest(selectedOrganizationId, chatId) }),
      ]);
    }
  }, [queryClient, selectedOrganizationId]); const updateConversationMutation = useMutation({
    mutationFn: ({ chatId, data }: { chatId: string; data: Parameters<typeof chatsApi.update>[1] }) =>
      chatsApi.update(chatId, data),
    onSuccess: async (conversation) => {
      if (conversation.status === "archived" && conversation.id === selectedConversation?.id) {
        navigate(chatRootPath); }
      if (conversation.status === "archived" && selectedOrganizationId) {
        archiveMessengerChatInCache(queryClient, selectedOrganizationId, conversation.id);
      } else {
        upsertConversation(conversation); upsertMessengerThreadSummary(conversation);
      }
      await refreshActiveChatActions(conversation.id); },
    onError: (error) => {
      pushToast({
        title: "Failed to update conversation",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error", }); }, }); const renameConversationMutation = useMutation({
    mutationFn: ({ chatId, title }: { chatId: string; title: string }) =>
      chatsApi.update(chatId, { title }),
    onMutate: async ({ chatId, title }) => {
      if (!selectedOrganizationId) return;
      await cancelMessengerChatRenameQueries(queryClient, selectedOrganizationId);
      renameMessengerChatInCache(queryClient, selectedOrganizationId, chatId, title);
    },
    onSuccess: async (conversation) => {
      if (selectedOrganizationId) {
        renameMessengerChatInCache(queryClient, selectedOrganizationId, conversation.id, conversation.title);
      }
      setRenamingConversationId((current) => (current === conversation.id ? null : current));
      await refreshActiveChatActions(conversation.id); },
    onError: async (error, variables) => {
      setRenamingConversationId(null);
      await refreshActiveChatActions(variables.chatId);
      pushToast({
        title: "Failed to rename conversation",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error", }); }, }); const updateConversationUserStateMutation = useMutation({
    mutationFn: ({ chatId, pinned, unread }: { chatId: string; pinned?: boolean; unread?: boolean }) =>
      chatsApi.updateUserState(chatId, { pinned, unread }),
    onSuccess: async (conversation) => {
      upsertConversation(conversation); upsertMessengerThreadSummary(conversation);
      await refreshActiveChatActions(conversation.id); },
    onMutate: ({ chatId, pinned }) => {
      if (typeof pinned === "boolean" && selectedOrganizationId) {
        markMessengerChatPinnedInCache(queryClient, selectedOrganizationId, chatId, pinned);
      }
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update conversation",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error", }); }, }); const deleteConversationMutation = useMutation({
    mutationFn: async ({ chatId, cancelActive }: { chatId: string; cancelActive?: boolean }) => {
      if (cancelActive) {
        abortChatStream(chatId);
        await chatsApi.stopMessageStream(chatId).catch(() => undefined);
        setStreamDraftForChat(chatId, null);
        setChatSendInFlight(chatId, false);
      }
      return chatsApi.remove(chatId, cancelActive ? { cancelActive: true } : {});
    },
    onSuccess: async (conversation) => {
      if (conversation.id === selectedConversation?.id) {
        navigate(chatRootPath); }
      await refreshActiveChatActions(conversation.id); },
    onError: (error) => {
      pushToast({
        title: "Failed to delete conversation",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error", }); }, }); const forkConversationMutation = useMutation({
    mutationFn: ({ chatId, sourceMessageId }: { chatId: string; sourceMessageId?: string | null }) =>
      chatsApi.fork(chatId, { sourceMessageId: sourceMessageId ?? null }),
    onSuccess: async (conversation) => {
      upsertConversation(conversation);
      upsertMessengerThreadSummary(conversation);
      await Promise.all([
        refreshActiveChatActions(conversation.id),
        queryClient.invalidateQueries({ queryKey: queryKeys.messenger.customGroups(conversation.orgId) }),
      ]);
      navigate(chatConversationPath(conversation.id));
    },
    onError: (error) => {
      pushToast({
        title: "Could not fork chat",
        body: error instanceof Error ? error.message : "Try again after the current reply finishes.",
        tone: "error",
      });
    },
  }); const regenerateTitleMutation = useMutation({
    mutationFn: (chatId: string) => chatsApi.regenerateTitle(chatId),
    onMutate: (chatId) => {
      setGeneratingChatTitleIds((current) => {
        const next = new Set(current);
        next.add(chatId);
        return next;
      });
    },
    onSuccess: async (conversation) => {
      if (selectedOrganizationId) {
        renameMessengerChatInCache(queryClient, selectedOrganizationId, conversation.id, conversation.title);
      }
      upsertConversation(conversation);
      upsertMessengerThreadSummary(conversation);
      await refreshActiveChatActions(conversation.id);
    },
    onError: (error) => {
      pushToast({
        title: "Could not regenerate title",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      });
    },
    onSettled: (_data, _error, chatId) => {
      setGeneratingChatTitleIds((current) => {
        const next = new Set(current);
        next.delete(chatId);
        return next;
      });
    },
  }); const assignCustomGroupEntryMutation = useMutation({
    mutationFn: ({ groupId, threadKey }: { groupId: string; threadKey: string }) => {
      if (!selectedOrganizationId) throw new Error("Organization is required to move chat");
      return messengerApi.assignCustomGroupEntry(selectedOrganizationId, groupId, threadKey);
    },
    onSuccess: async () => {
      if (selectedOrganizationId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.messenger.customGroups(selectedOrganizationId) });
      }
    },
  }); const removeCustomGroupEntryMutation = useMutation({
    mutationFn: (threadKey: string) => {
      if (!selectedOrganizationId) throw new Error("Organization is required to move chat");
      return messengerApi.removeCustomGroupEntry(selectedOrganizationId, threadKey);
    },
    onSuccess: async () => {
      if (selectedOrganizationId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.messenger.customGroups(selectedOrganizationId) });
      }
    },
  }); const createCustomGroupForChatMutation = useMutation({
    mutationFn: ({ conversation, threadKey }: { conversation: ChatConversation; threadKey: string }) => {
      if (!selectedOrganizationId) throw new Error("Organization is required to create a group");
      return messengerApi.createCustomGroupWithEntries(selectedOrganizationId, {
        name: conversationDisplayTitle(conversation),
        icon: "folder",
        threadKeys: [threadKey],
      });
    },
    onSuccess: async () => {
      if (selectedOrganizationId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.messenger.customGroups(selectedOrganizationId) });
      }
    },
  }); const updateProjectContextMutation = useMutation({
    mutationFn: ({ chatId, projectId }: { chatId: string; projectId: string | null; previousProjectId?: string | null;
    }) =>
      chatsApi.setProjectContext(chatId, projectId),
    onSuccess: async (conversation, variables) => { const nextProjectId = projectContextId(conversation);
      setPendingProjectContextOverride((current) => ( current?.chatId === variables.chatId ? null : current )); setDraftProjectId(nextProjectId ?? NO_PROJECT_ID);
      if (selectedOrganizationId) {
        rememberChatProjectId(selectedOrganizationId, nextProjectId); rememberChatProjectIdForAgent(selectedOrganizationId, conversation.preferredAgentId, nextProjectId); } upsertConversation(conversation); upsertMessengerThreadSummary(conversation);
      await refreshChat(conversation.id); },
    onError: (error, variables) => {
      setPendingProjectContextOverride((current) => ( current?.chatId === variables.chatId ? null : current ));
      if (selectedConversation?.id === variables.chatId) {
        setDraftProjectId(variables.previousProjectId ?? NO_PROJECT_ID); }
      pushToast({
        title: "Failed to update project context",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error", }); }, }); const markConversationReadMutation = useMutation({
    mutationFn: (chatId: string) => chatsApi.markRead(chatId),
    onSuccess: async (_result, chatId) => {
      await refreshChat(chatId);
      if (selectedOrganizationId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedOrganizationId) });
      }
    },
    onError: async () => {
      if (!selectedOrganizationId) return;
      await Promise.all([
        invalidateMessengerThreadSummaryQueries(queryClient, selectedOrganizationId),
        queryClient.invalidateQueries({ queryKey: queryKeys.messenger.threadPreview(selectedOrganizationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedOrganizationId) }),
      ]);
    }, }); const convertToIssueMutation = useMutation({
    mutationFn: ({ chatId, message, proposalOverride }: { chatId: string; message: ChatMessage; proposalOverride?: Record<string, unknown> }) =>
      chatsApi.convertToIssue(chatId, {
        messageId: message.id,
        proposal: proposalOverride ?? issueProposalFromMessage(message) ?? undefined, }),
    onSuccess: async ({ issue }, variables) => { setIssueProposalOverridesByMessageId((current) => { if (!(variables.message.id in current)) return current; const { [variables.message.id]: _removed, ...rest } = current; return rest; }); await refreshChat(variables.chatId); const issueRef = issue.identifier ?? issue.id;
      pushToast({
        title: `Created issue ${issueRef}`,
        tone: "success",
        action: {
          label: `Open ${issueRef}`,
          href: `/issues/${issueRef}`, },
      }); },
    onError: (error) => {
      pushToast({
        title: "Failed to convert chat to issue",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error", }); }, }); const approvalMutation = useMutation({
    mutationFn: async ({
      approvalId,
      action,
      messageId,
      payloadOverride,
    }: { approvalId: string; action: ApprovalAction; messageId: string; payloadOverride?: Record<string, unknown>;
    }) => { const note = decisionNotesByMessageId[messageId]?.trim() || undefined; if (action === "approve") return approvalsApi.approve(approvalId, note, payloadOverride); if (action === "reject") return approvalsApi.reject(approvalId, note);
      return approvalsApi.requestRevision(approvalId, note); },
    onSuccess: async (_result, variables) => { clearDecisionNoteForMessage(variables.messageId);
      if (variables.action === "approve") {
        setIssueProposalOverridesByMessageId((current) => { if (!(variables.messageId in current)) return current; const { [variables.messageId]: _removed, ...rest } = current; return rest; });
      }
      await refreshChat(conversationId ?? null); },
    onError: (error) => {
      pushToast({
        title: "Failed to apply approval action",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error", }); }, }); const operationProposalMutation = useMutation({
    mutationFn: ({
      chatId,
      messageId,
      action,
      decisionNote,
    }: { chatId: string; messageId: string; action: ChatOperationProposalDecisionAction; decisionNote: string;
    }) => chatsApi.resolveOperationProposal(chatId, messageId, {
      action,
      decisionNote: decisionNote.trim() || undefined, }),
    onSuccess: async (_result, variables) => { clearDecisionNoteForMessage(variables.messageId);
      await refreshChat(variables.chatId); },
    onError: (error) => {
      pushToast({
        title: "Failed to resolve lightweight change",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error", }); }, }); const stopStreaming = useCallback((chatId: string) => { stopRequestedChatIdsRef.current.add(chatId);
    void chatsApi.stopMessageStream(chatId).then(() => {
      if (selectedOrganizationId) {
        queryClient.setQueryData(
          queryKeys.chats.queue(selectedOrganizationId, chatId),
          (current: Awaited<ReturnType<typeof chatsApi.listQueue>> | undefined) => ({
            activeGenerationId: null,
            items: current?.items ?? [],
          }),
        );
        void queryClient.invalidateQueries({ queryKey: queryKeys.chats.queue(selectedOrganizationId, chatId) });
      }
      pushToast({
        title: "Response stopped",
        body: "Rudder interrupted the current reply.",
        tone: "info",
      });
    }).catch((error) => {
      pushToast({
        title: "Failed to stop streaming",
        body: error instanceof Error ? error.message : "Try again.", tone: "error", }); }); abortChatStream(chatId); setStreamDraftForChat(chatId, (current) => (current ? { ...current, state: "stopped" } : current)); }, [abortChatStream, pushToast, queryClient, selectedOrganizationId, setStreamDraftForChat]); const readComposerDraft = useCallback(
    () => composerEditorRef.current?.getMarkdown?.() ?? draft,
    [draft],
  );
  const queueComposerFollowUp = async (
    conversation: ChatConversation,
    bodyOverride?: string,
    options?: { files?: File[]; clearComposerOnSuccess?: boolean },
  ) => {
    if (isExternalBoundConversation(conversation)) {
      pushToast({ title: "Fork this Feishu chat to continue in Rudder", tone: "error" });
      return false;
    }
    if (!selectedOrganizationId) { pushToast({ title: "Select a organization first", tone: "error" });
      return false; } const body = (bodyOverride ?? readComposerDraft()).trim();
    if (!body) { pushToast({ title: "Message cannot be empty", tone: "error" });
      return false; } const filesToUpload = [...(options?.files ?? pendingFiles)];
    if (filesToUpload.length > 0) {
      pushToast({ title: "Queued follow-ups do not support new files yet", tone: "error" });
      return false;
    }
    const serverActiveGenerationId = queueQuery.data?.activeGenerationId ?? null;
    const queued = await chatsApi.createQueuedMessage(conversation.id, {
      clientMutationId: `ui:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      expectedGenerationId: serverActiveGenerationId,
      payload: {
        body,
        attachmentIds: [],
        skillRefs: [],
        projectId: activeProjectId === NO_PROJECT_ID ? null : activeProjectId,
        accessMode: null,
        model: null,
        effort: null,
        metadata: { source: "chat_composer" },
      },
    });
    queryClient.setQueryData(
      queryKeys.chats.queue(selectedOrganizationId, conversation.id),
      (current: Awaited<ReturnType<typeof chatsApi.listQueue>> | undefined) => ({
        activeGenerationId: current?.activeGenerationId ?? serverActiveGenerationId,
        items: [...(current?.items ?? []), queued],
      }),
    );
    if (options?.clearComposerOnSuccess ?? true) {
      setBranchPreview(null); setDraft(""); clearPendingFilesForCurrentScope();
    }
    await queryClient.invalidateQueries({ queryKey: queryKeys.chats.queue(selectedOrganizationId, conversation.id) });
    pushToast({ title: "Queued follow-up", body: "It will run after the current reply finishes.", tone: "info" });
    return true;
  };
  const sendMessage = async (
    options?: { bodyOverride?: string; filesOverride?: File[]; conversationOverride?: ChatConversation;
      editUserMessageIdOverride?: string | null; clearPendingFilesOnSuccess?: boolean; onUserMessageAcknowledged?: () => void; queuedMessageId?: string | null; },
  ) => {
    if (!selectedOrganizationId) { pushToast({ title: "Select a organization first", tone: "error" });
      return; } const usesComposerState = options?.bodyOverride === undefined && options?.filesOverride === undefined; const body = (options?.bodyOverride ?? readComposerDraft()).trim();
    if (!body) { pushToast({ title: "Message cannot be empty", tone: "error" });
      return; } const filesToUpload = [...(options?.filesOverride ?? pendingFiles)]; let pendingFilesClearedAfterAck = false; const submittedComposerDraft = usesComposerState ? {
          body,
          files: filesToUpload,
          orgId: draftStorageOrgId, conversationId: draftStorageConversationId, } : null; const editUserMessageId = options?.editUserMessageIdOverride ?? null; const editTargetMessage = editUserMessageId ? rawMessages.find((message) => message.id === editUserMessageId) ?? null : null; let conversation = options?.conversationOverride ?? selectedConversation; let activeChatId: string | null = null; let newConversationLockAcquired = false; let chatSendLockAcquired = false; let userMessageAcknowledged = false;
    try {
      if (!conversation && conversationId) { conversation = await chatsApi.get(conversationId); upsertConversation(conversation);
        upsertMessengerThreadSummary(conversation); }
      if (isExternalBoundConversation(conversation)) {
        pushToast({ title: "Fork this Feishu chat to continue in Rudder", tone: "error" });
        return;
      }
      if (!conversation) { if (!acquireNewConversationSendLock()) return; newConversationLockAcquired = true; const selectedDraftAgentId = draftPreferredAgentId === NO_CHAT_AGENT_ID ? null : draftPreferredAgentId;
        if (!selectedDraftAgentId) {
          pushToast({
            title: "No chat agent available",
            body: "Create or activate an agent before sending.", tone: "error", }); releaseNewConversationSendLock(); newConversationLockAcquired = false;
          return; } const createdConversation = await chatsApi.create(selectedOrganizationId, {
          preferredAgentId: selectedDraftAgentId,
          issueCreationMode: "manual_approval",
          planMode: draftPlanMode,
        contextLinks: buildDraftChatContextLinks(
            draftProjectId === NO_PROJECT_ID ? null : draftProjectId, draftIssueContextId, ), }); const startedAt = new Date(); conversation = upsertOptimisticConversation(createdConversation, body, startedAt); rememberChatAgentId(selectedOrganizationId, selectedDraftAgentId); rememberChatProjectIdForAgent(selectedOrganizationId, selectedDraftAgentId, draftProjectId === NO_PROJECT_ID ? null : draftProjectId);
        if (usesComposerState) { setDraft(""); clearPendingFilesForCurrentScope();
          setBranchPreview(null); }
        navigate(chatConversationPath(conversation.id)); } const chatId = conversation.id; const activeDraftForChat = readChatScopedState(streamDrafts, chatId);
      const serverActiveGenerationId = queueQuery.data?.activeGenerationId ?? null;
      if (!options?.queuedMessageId && (activeDraftForChat || serverActiveGenerationId)) {
        await queueComposerFollowUp(conversation, body, { files: filesToUpload, clearComposerOnSuccess: usesComposerState });
        return;
      } if (!acquireChatSendLock(chatId)) return; chatSendLockAcquired = true; activeChatId = chatId; const selectedAgentId = activeAgentId === NO_CHAT_AGENT_ID ? null : activeAgentId;
      if (!conversation.preferredAgentId && selectedAgentId) { conversation = await chatsApi.update(conversation.id, { preferredAgentId: selectedAgentId }); setDraftPreferredAgentId(selectedAgentId); rememberChatAgentId(selectedOrganizationId, selectedAgentId); upsertConversation(conversation);
        upsertMessengerThreadSummary(conversation); }
      if (newConversationLockAcquired || newConversationSendLockRef.current) { releaseNewConversationSendLock();
        newConversationLockAcquired = false; }
      if (usesComposerState) { setBranchPreview(null); setDraft("");
        clearPendingFilesForCurrentScope(); } setChatSendInFlight(chatId, true); stopRequestedChatIdsRef.current.delete(chatId); const abortController = new AbortController(); setStreamAbortController(chatId, abortController); const startedAt = new Date(); conversation = upsertOptimisticConversation(conversation, body, startedAt);
      setStreamDraftForChat(chatId, {
        chatId,
        userBody: body,
        userCreatedAt: startedAt,
        userMessageId: null,
        chatTurnId: null,
        turnVariant: editTargetMessage ? editTargetMessage.turnVariant + 1 : 0,
        editedFromCreatedAt: editTargetMessage ? new Date(editTargetMessage.createdAt) : null,
        body: "",
        state: "streaming",
        createdAt: startedAt,
        transcript: [], replyingAgentId: conversation.chatRuntime.runtimeAgentId ?? conversation.preferredAgentId ?? null, });
      await chatsApi.sendMessageStream(chatId, body, {
        signal: abortController.signal,
        editUserMessageId,
        files: filesToUpload,
        queuedMessageId: options?.queuedMessageId ?? null,
        onEvent: async (event) => {
          if (event.type === "queued") {
            queryClient.setQueryData(
              queryKeys.chats.queue(selectedOrganizationId, chatId),
              (current: Awaited<ReturnType<typeof chatsApi.listQueue>> | undefined) => ({
                activeGenerationId: current?.activeGenerationId ?? queueQuery.data?.activeGenerationId ?? null,
                items: [...(current?.items ?? []), event.item],
              }),
            );
            if (usesComposerState) { setDraft(""); clearPendingFilesForCurrentScope(); }
            setStreamDraftForChat(chatId, null);
            return;
          }
          if (event.type === "ack") { userMessageAcknowledged = true; upsertMessages(chatId, [event.userMessage]);
            if (body.startsWith(ASK_USER_ANSWER_PREFIX)) {
              setRecentAskUserAnswerMessageId(event.userMessage.id);
              window.setTimeout(() => {
                setRecentAskUserAnswerMessageId((current) => current === event.userMessage.id ? null : current);
              }, 1600);
            }
            options?.onUserMessageAcknowledged?.();
            if (options?.clearPendingFilesOnSuccess && !pendingFilesClearedAfterAck) { clearPendingFilesForCurrentScope(); pendingFilesClearedAfterAck = true; }
            setStreamDraftForChat(
              chatId,
              (current) => (current ? { ...current,
                userMessageId: event.userMessage.id,
              chatTurnId: event.userMessage.chatTurnId ?? null,
              turnVariant: event.userMessage.turnVariant ?? 0, } : current), );
            return; }
          if (event.type === "assistant_delta") {
            setStreamDraftForChat(
              chatId, (current) => (current ? { ...current, body: `${current.body}${event.delta}` } : current), );
            return; }
          if (event.type === "assistant_state") {
            setStreamDraftForChat(
              chatId, (current) => (current ? { ...current, state: event.state } : current), );
            return; }
          if (event.type === "transcript_entry") {
            setStreamDraftForChat(chatId, (current) => { if (!current) return current; const transcript = [...current.transcript]; appendTranscriptEntry(transcript, event.entry); return { ...current, transcript }; });
            return; }
          if (event.type === "final") { keepProcessOpenForMessages(event.messages); upsertMessages(chatId, event.messages); setStreamDraftForChat(chatId, null); } }, });
      if (options?.clearPendingFilesOnSuccess) { clearPendingFilesForCurrentScope(); }
      await refreshChat(chatId);
      await queryClient.invalidateQueries({ queryKey: queryKeys.chats.queue(selectedOrganizationId, chatId) }); setStreamDraftForChat(chatId, null);
    } catch (error) {
      const isAbort = error instanceof DOMException ? error.name === "AbortError" : error instanceof Error && error.name === "AbortError";
      if (options?.queuedMessageId && conversation && !userMessageAcknowledged) {
        await chatsApi.releaseQueuedMessageClaim(conversation.id, options.queuedMessageId).catch(() => null);
      }
      if (conversation && (isAbort || stopRequestedChatIdsRef.current.has(conversation.id))) {
        setStreamDraftForChat(
          conversation.id, (current) => (current ? { ...current, state: "stopped" } : current), );
        window.setTimeout(() => {
          void refreshChat(conversation!.id).finally(() => { setStreamDraftForChat(conversation!.id, null); }); }, 400);
        return; }
      if (conversation) {
        setStreamDraftForChat(
          conversation.id, (current) => (current ? { ...current, state: "failed" } : current), ); await refreshChat(conversation.id);
        setStreamDraftForChat(conversation.id, null); }
      if (submittedComposerDraft && !userMessageAcknowledged) { const restoreConversationId = conversation?.id ?? submittedComposerDraft.conversationId; const restoreScopeKey = resolveChatPendingAttachmentScopeKey(
          submittedComposerDraft.orgId, restoreConversationId, ); saveChatDraft(submittedComposerDraft.orgId, restoreConversationId, submittedComposerDraft.body); updateChatPendingAttachmentsForScope(restoreScopeKey, () => submittedComposerDraft.files); refreshPendingFiles((version) => version + 1);
        if (activeDraftScopeRef.current === restoreScopeKey) {
          setDraftState({
            scopeKey: restoreScopeKey,
            value: submittedComposerDraft.body,
          }); } } else if (editUserMessageId && !userMessageAcknowledged) {
        setInlineEditUserMessageId(editUserMessageId);
        setInlineEditDraft(body);
        requestAnimationFrame(() => { inlineEditEditorRef.current?.focus(); });
      }
      if (error instanceof ApiError) {
        pushToast({
          title: "Failed to send message",
          body: error.message, tone: "error", });
        return; }
      pushToast({
        title: error instanceof Error ? error.message : "Failed to send message", tone: "error", });
    } finally {
      if (activeChatId) { setStreamAbortController(activeChatId, null); stopRequestedChatIdsRef.current.delete(activeChatId);
        if (chatSendLockAcquired) {
          releaseChatSendLock(activeChatId); }
        setChatSendInFlight(activeChatId, false); }
      if (newConversationLockAcquired) { releaseNewConversationSendLock(); } } }; const conversations = useMemo(() => { const items = conversationsQuery.data ?? [];
    return [...items].sort((a, b) => { if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1; return new Date(b.lastMessageAt ?? b.updatedAt).getTime() - new Date(a.lastMessageAt ?? a.updatedAt).getTime(); }); }, [conversationsQuery.data]); const rawMessages = messagesQuery.data ?? []; const latestIncomingMessageId = useMemo(() => { const messages = [...rawMessages] .filter(isUserVisibleIncomingChatMessage) .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()); return messages[0]?.id ?? null; }, [rawMessages]); const displayedMessages = useMemo(
    () => computeDisplayedChatMessages(rawMessages, branchPreview), [rawMessages, branchPreview], ); const showMessagesLoading = Boolean(selectedConversation && conversationId && messagesQuery.isPending && messagesQuery.data === undefined); const activeStream = readChatScopedState(streamDrafts, selectedConversation?.id); const activeSendInFlight = readChatScopedFlag(sendInFlightByChatId, selectedConversation?.id); const activeQueueItems = queueQuery.data?.items ?? []; const visibleQueueItems = activeQueueItems.filter((item) => !item.deliveredMessageId && !item.sourceMessageId); const agentSelectionLocked = isChatAgentSelectionLocked({
    hasConversation: Boolean(selectedConversation),
    preferredAgentId: selectedConversation?.preferredAgentId,
    hasLastMessageAt: Boolean(selectedConversation?.lastMessageAt),
    hasMessages: rawMessages.length > 0,
    hasActiveStream: Boolean(activeStream), hasActiveSendInFlight: activeSendInFlight, }); const projectSelectionLocked = isChatProjectSelectionLocked({
    hasConversation: Boolean(selectedConversation),
    hasLastMessageAt: Boolean(selectedConversation?.lastMessageAt),
    hasMessages: rawMessages.length > 0,
    hasActiveStream: Boolean(activeStream), hasActiveSendInFlight: activeSendInFlight, }); const activeEditCutoffMs = activeStream?.editedFromCreatedAt ? activeStream.editedFromCreatedAt.getTime() : null; const activeStreamFilteredMessages = activeEditCutoffMs === null ? displayedMessages : displayedMessages.filter((message) => new Date(message.createdAt).getTime() < activeEditCutoffMs); const activeStreamPreviewHidden = Boolean(activeStream?.chatTurnId && branchPreview?.chatTurnId === activeStream.chatTurnId && branchPreview.turnVariant !== activeStream.turnVariant); const visibleMessages = activeStream && !activeStreamPreviewHidden ? activeStreamFilteredMessages.filter((message) => shouldShowMessageDuringActiveStream(message, activeStream)) : activeStreamFilteredMessages; const scrollMapUserMessageCount = useMemo(
    () => countScrollMapUserMessages(visibleMessages), [visibleMessages],
  ); const showChatScrollMap = scrollMapUserMessageCount > CHAT_SCROLL_MAP_USER_MESSAGE_THRESHOLD; const jumpToChatMessage = useCallback((messageId: string) => {
    const scrollElement = chatMessagesScrollElementRef.current;
    if (!scrollElement) return;
    const target = findChatMessageElement(scrollElement, messageId);
    if (!target) return;
    revealChatMessageElement(target);
  }, []); const openWorkManifestItem = useCallback((item: ChatWorkManifestItem) => {
    const metadata = item.metadata ?? {};
    if (item.targetType === "library_entry") {
      const entryId = typeof metadata.entryId === "string" ? metadata.entryId : null;
      if (!entryId) return;
      openSidePanelTargetForContext(resolveCurrentSidePanelChatContextKey(), {
        kind: "library_entry",
        entryId,
        path: typeof metadata.filePath === "string" ? metadata.filePath : null,
        label: item.title,
      });
      return;
    }
    if (item.targetType === "library_file") {
      const filePath = typeof metadata.filePath === "string" ? metadata.filePath : null;
      if (!filePath) return;
      openSidePanelTargetForContext(resolveCurrentSidePanelChatContextKey(), {
        kind: "library_file",
        filePath,
        label: item.title,
      });
      return;
    }
    const assetId = item.targetType === "attachment" && typeof metadata.assetId === "string"
      ? metadata.assetId
      : null;
    const href = item.url ?? (assetId ? `/api/assets/${encodeURIComponent(assetId)}/content` : null);
    if (!href) return;
    const opened = window.open(href, "_blank", "noopener,noreferrer");
    if (opened) opened.opener = null;
  }, [openSidePanelTargetForContext, resolveCurrentSidePanelChatContextKey]); const pendingAskUserMessage = useMemo(
    () => findLatestUnansweredAskUserMessage(visibleMessages), [visibleMessages], ); const pendingAskUserRequest = pendingAskUserMessage ? askUserRequestFromMessage(pendingAskUserMessage) : null; const lastMarkedReadKeyRef = useRef<string | null>(null); const optimisticReadBadgeMarkerRef = useRef<string | null>(null);
  useEffect(() => { if (!pendingAskUserRequest) return; closeComposerContextMenus(); }, [closeComposerContextMenus, pendingAskUserRequest]);
  useEffect(() => { const chatId = selectedConversation?.id ?? null; if (!chatId || showMessagesLoading) return; if (initialScrolledConversationRef.current === chatId) return; initialScrolledConversationRef.current = chatId; const frame = requestAnimationFrame(() => { const scrollElement = chatMessagesScrollElementRef.current; if (!scrollElement) return; scrollChatMessagesToBottom(scrollElement); }); return () => cancelAnimationFrame(frame); }, [selectedConversation?.id, showMessagesLoading, visibleMessages.length]);
  useEffect(() => { if (!conversationId || !pendingTargetMessageId || showMessagesLoading) return; const frame = requestAnimationFrame(() => { const scrollElement = chatMessagesScrollElementRef.current; if (!scrollElement) return; const target = findChatMessageElement(scrollElement, pendingTargetMessageId); if (!target) return; revealChatMessageElement(target); const nextSearch = new URLSearchParams(searchParams); nextSearch.delete("messageId"); nextSearch.delete("targetMessageId"); navigate({
        pathname: chatConversationPath(conversationId),
        search: nextSearch.toString() ? `?${nextSearch.toString()}` : "",
      }, { replace: true }); }); return () => cancelAnimationFrame(frame); }, [chatConversationPath, conversationId, navigate, pendingTargetMessageId, searchParams, showMessagesLoading, visibleMessages.length]);
  useEffect(() => { if (!selectedConversation?.id || !latestIncomingMessageId) return; if (typeof document !== "undefined" && document.visibilityState !== "visible") return; const shouldMarkRead = selectedConversation.isUnread || latestIncomingMessageId !== lastMarkedReadKeyRef.current?.split(":")[1]; if (!shouldMarkRead) return; const nextKey = `${selectedConversation.id}:${latestIncomingMessageId}`; if (manuallyMarkedUnreadKeyRef.current === nextKey) return; if (manuallyMarkedUnreadKeyRef.current?.startsWith(`${selectedConversation.id}:`)) {
      manuallyMarkedUnreadKeyRef.current = null;
    } const shouldDecrementSidebarBadge = selectedConversation.isUnread && optimisticReadBadgeMarkerRef.current !== nextKey; if (selectedOrganizationId) {
      markMessengerChatReadInCache(queryClient, selectedOrganizationId, selectedConversation, {
        decrementSidebarBadge: shouldDecrementSidebarBadge,
      });
      if (shouldDecrementSidebarBadge) {
        optimisticReadBadgeMarkerRef.current = nextKey;
      }
    }
    if (lastMarkedReadKeyRef.current === nextKey) return; lastMarkedReadKeyRef.current = nextKey; markConversationReadMutation.mutate(selectedConversation.id);
  }, [
    latestIncomingMessageId,
    markConversationReadMutation,
    queryClient,
    selectedConversation,
    selectedOrganizationId,
  ]); const showActiveStreamDraft = Boolean(activeStream && !activeStreamPreviewHidden); const showOptimisticUserMessage = Boolean(
    activeStream && (
      activeEditCutoffMs !== null
      || !activeStream.userMessageId || !rawMessages.some((message) => message.id === activeStream.userMessageId) ), );
  useEffect(() => {
    if (agentSelectionLocked) {
      setAgentMenuOpen(false); } }, [agentSelectionLocked]);
  const loadError = conversationsQuery.error ?? conversationQuery.error ?? messagesQuery.error ?? agentsError ?? organizationSkillsError ?? activeAgentSkillsError ?? projectsError ?? issuesError;
  const loadErrorMessage = loadError instanceof Error ? loadError.message : loadError ? "Failed to load chat data." : null; const workManifestError = workManifestQuery.error instanceof Error ? workManifestQuery.error.message : workManifestQuery.error ? "Failed to load work." : null; const startActiveConversationRename = () => { if (!selectedConversation) return; setRenamingConversationId(selectedConversation.id); setRenameDraft(selectedConversation.title); }; const submitActiveConversationRename = () => { if (!selectedConversation || renamingConversationId !== selectedConversation.id) return; const trimmed = renameDraft.trim(); setRenamingConversationId(null); if (!trimmed || trimmed === selectedConversation.title) return; renameConversationMutation.mutate({ chatId: selectedConversation.id, title: trimmed }); }; const copyActiveConversationLink = async () => { if (!selectedConversation) return;
    try {
      await navigator.clipboard.writeText(chatReferenceMarkdown(selectedConversation));
      pushToast({ title: "Copied chat link", tone: "success" });
    } catch {
      pushToast({ title: "Could not copy chat link", tone: "error" });
    }
  }; const createGroupForActiveConversation = () => { if (!selectedConversation || !selectedConversationThreadKey) return; createCustomGroupForChatMutation.mutate({ conversation: selectedConversation, threadKey: selectedConversationThreadKey }); }; const moveActiveConversationToGroup = (groupId: string) => { if (!selectedConversationThreadKey) return; assignCustomGroupEntryMutation.mutate({ groupId, threadKey: selectedConversationThreadKey }); }; const removeActiveConversationFromGroup = () => { if (!selectedConversationThreadKey) return; removeCustomGroupEntryMutation.mutate(selectedConversationThreadKey); }; const controlsDisabled = activeSendInFlight || newConversationSendInFlight; const activeSelectedAgentId = activeAgentId === NO_CHAT_AGENT_ID ? null : activeAgentId; const canPersistSelectedAgentForConversation = Boolean( selectedConversation && !selectedConversation.preferredAgentId && activeSelectedAgentId, );
  const composerUnavailable = selectedConversation ? !selectedConversation.chatRuntime.available && !canPersistSelectedAgentForConversation : !activeSelectedAgentId; const composerUnavailableMessage = activeSelectedAgentId ? selectedConversation?.chatRuntime.error ?? "Selected chat agent is unavailable." : "Create or activate an agent before sending messages."; const hasPendingLightweightProposal = rawMessages.some(
    (message) => !message.supersededAt && message.kind === "operation_proposal" && !message.approval && operationProposalStatusFromMessage(message) === "pending", ); const hasActionableApprovals = rawMessages .filter((m) => !m.supersededAt) .some((message) => approvalNeedsAction(message.approval));
  const agentPillLabel =
    activeAgentId === NO_CHAT_AGENT_ID ? (agents ? NO_CHAT_AGENT_LABEL : "Loading agents") : (() => { const activeAgent = (agents ?? []).find((agent) => agent.id === activeAgentId); return activeAgent ? formatChatAgentLabel(activeAgent) : "Unknown agent"; })(); const activeProjectContextLink = selectedConversation?.contextLinks.find((link) => link.entityType === "project") ?? null; const activeProject = activeProjectId === NO_PROJECT_ID ? null : visibleProjects.find((project) => project.id === activeProjectId) ?? null; const projectPillLabel = activeProject ? projectDisplayName(activeProject) : activeProjectId === NO_PROJECT_ID ? "No project" : activeProjectContextLink?.entity?.label ?? "Unknown project"; const showProjectSelector = !selectedConversation || activeProjectId !== NO_PROJECT_ID || !projectSelectionLocked; const allRecentProjectConversations = useMemo(() => {
    if (!activeProject) return [];
    return [...(mentionConversationsQuery.data ?? [])]
      .filter((conversation) => projectContextId(conversation) === activeProject.id)
      .sort((a, b) => new Date(b.lastMessageAt ?? b.updatedAt).getTime() - new Date(a.lastMessageAt ?? a.updatedAt).getTime());
  }, [activeProject, mentionConversationsQuery.data]); const recentProjectConversations = useMemo(
    () => allRecentProjectConversations.slice(0, recentProjectConversationLimit),
    [allRecentProjectConversations, recentProjectConversationLimit],
  ); const hasMoreRecentProjectConversations = recentProjectConversationLimit < allRecentProjectConversations.length; const loadMoreRecentProjectConversations = useCallback(() => {
    setRecentProjectConversationLimit((current) => Math.min(allRecentProjectConversations.length, current + RECENT_PROJECT_CONVERSATION_LOAD_INCREMENT));
  }, [allRecentProjectConversations.length]); useEffect(() => {
    setRecentProjectConversationLimit(RECENT_PROJECT_CONVERSATION_INITIAL_LIMIT);
  }, [activeProject?.id]); const availableChatSkills = useMemo(
    () => buildChatSkillOptions({
      agent: activeSkillAgent,
      orgUrlKey: selectedOrganization?.urlKey ?? "organization",
      organizationSkills,
      skillSnapshot: activeAgentSkillSnapshot, }), [activeAgentSkillSnapshot, activeSkillAgent, organizationSkills, selectedOrganization?.urlKey], ); const chatSkillReferences = useMemo<MarkdownSkillReferencePreview[]>(
    () => availableChatSkills.map((skill) => ({
      href: skill.skillMarkdownTarget,
      label: skill.skillRefLabel,
      displayName: skill.skillDisplayName,
      description: skill.skillDescription,
      categoryLabel: skill.skillCategoryLabel,
      locationLabel: skill.skillLocationLabel,
      detailsHref: skill.skillDetailsHref,
    })), [availableChatSkills], ); const chatSkillDetailsHrefByTarget = useMemo(
    () => new Map(
      availableChatSkills
        .filter((skill) => skill.skillMarkdownTarget && skill.skillDetailsHref)
        .map((skill) => [skill.skillMarkdownTarget, skill.skillDetailsHref!] as const),
    ), [availableChatSkills], ); const handleComposerInlineTokenClick = useCallback((token: AtomicInlineTokenElement, event: { ctrlKey?: boolean; metaKey?: boolean }) => {
    if (!event.ctrlKey && !event.metaKey) return;
    if (token.kind === "mention") {
      const parsed = parseMentionChipHref(token.href);
      if (!parsed) return;
      const target = mentionChipNavigationPath(parsed);
      navigate(target);
      return;
    }
    const detailsHref = chatSkillDetailsHrefByTarget.get(token.href);
    if (detailsHref) {
      navigate(detailsHref);
      return;
    }
    pushToast({
      title: "Skill details are not available in this organization",
      tone: "info",
    });
  }, [chatSkillDetailsHrefByTarget, navigate, pushToast]); const filteredChatSkills = useMemo(
    () => filterChatSkillOptions(availableChatSkills, skillSearchQuery), [availableChatSkills, skillSearchQuery], ); const chatSkillsPending = Boolean(activeSkillAgentId) && (organizationSkillsPending || activeAgentSkillsPending); const showChatSkillsPicker = Boolean(activeSkillAgentId); const mentionOptions = useMemo<MentionOption[]>(
    () => buildMarkdownMentionOptions({
      agents,
      projects: visibleProjects,
      issues,
      chats: mentionConversationsQuery.data,
      libraryDocuments,
      libraryFiles: Array.isArray(libraryMentionFiles?.entries) ? libraryMentionFiles.entries : undefined,
      skillMentionOptions: availableChatSkills,
      currentUserId,
    }),
    [
      agents,
      availableChatSkills,
      currentUserId,
      issues,
      libraryDocuments,
      libraryMentionFiles?.entries,
      mentionConversationsQuery.data,
      visibleProjects,
    ],
  );
  const insertSkillReference = useCallback((entry: (typeof availableChatSkills)[number]) => {
    if (!entry.skillRefLabel || !entry.skillMarkdownTarget) { setSkillMenuOpen(false);
      return; } const currentDraft = readComposerDraft(); const nextDraft = appendSkillReferencesToDraft(
      currentDraft, [`[${entry.skillRefLabel}](${entry.skillMarkdownTarget})`], ); setDraft(nextDraft); setSkillMenuOpen(false); setSkillSearchQuery("");
    requestAnimationFrame(() => { composerEditorRef.current?.focus(); });
    if (nextDraft === currentDraft) {
      pushToast({
        title: "Selected skills already in message",
        tone: "success",
      }); } }, [pushToast, readComposerDraft]); const applyPreferredAgent = (value: string) => {
    if (agentSelectionLocked) { setAgentMenuOpen(false);
      return; }
    if (!isSelectableChatAgentId(value, agents)) { setAgentMenuOpen(false);
      return; } setDraftPreferredAgentId(value); setAgentMenuOpen(false);
    if (selectedOrganizationId) {
      rememberChatAgentId(selectedOrganizationId, value); }
    if (selectedConversation) {
      updateConversationMutation.mutate({
        chatId: selectedConversation.id,
        data: { preferredAgentId: value }, }); } }; const applyProjectContext = (value: string) => {
    if (projectSelectionLocked) { setProjectMenuOpen(false);
      return; } const projectId = value === NO_PROJECT_ID ? null : value; const previousProjectId = selectedConversation ? selectedConversationProjectId : draftProjectId === NO_PROJECT_ID ? null : draftProjectId; setDraftProjectId(value); draftProjectManuallySelectedRef.current = true; draftProjectDefaultKeyRef.current = draftProjectDefaultKey; setProjectMenuOpen(false);
    if (selectedOrganizationId) {
      rememberChatProjectId(selectedOrganizationId, projectId); rememberChatProjectIdForAgent(selectedOrganizationId, activeSkillAgentId, projectId); }
    if (selectedConversation) {
      setPendingProjectContextOverride({
        chatId: selectedConversation.id, projectId, });
      updateProjectContextMutation.mutate({
        chatId: selectedConversation.id,
        projectId,
        previousProjectId, }); } }; const applyPlanMode = (value: boolean) => { const chatId = selectedConversation?.id ?? conversationId; const previousConversation = selectedConversation; const previousDraftPlanMode = draftPlanMode; setDraftPlanMode(value); setPendingPlanModeOverride(value); if (!chatId) return;
    if (previousConversation) { const optimisticConversation = withOptimisticPlanMode(previousConversation, value); upsertConversation(optimisticConversation);
      upsertMessengerThreadSummary(optimisticConversation); }
    updateConversationMutation.mutate( {
        chatId,
        data: { planMode: value }, }, {
        onSuccess: (conversation) => { setDraftPlanMode(conversation.planMode);
          setPendingPlanModeOverride(null); },
        onError: () => { setDraftPlanMode(previousConversation?.planMode ?? previousDraftPlanMode); setPendingPlanModeOverride(null);
          if (previousConversation) { upsertConversation(previousConversation); upsertMessengerThreadSummary(previousConversation); } }, }, ); }; const copyChatMessageText = useCallback(
    async (text: string) => {
      try { await navigator.clipboard.writeText(text); pushToast({ title: "Copied to clipboard", tone: "success" });
      } catch {
        pushToast({ title: "Could not copy", tone: "error" }); } }, [pushToast], ); const beginEditUserMessage = useCallback((message: ChatMessage) => { setInlineEditUserMessageId(message.id); setInlineEditDraft(message.body); closeComposerContextMenus();
    requestAnimationFrame(() => { inlineEditEditorRef.current?.focus(); }); }, [closeComposerContextMenus]); const cancelInlineEditUserMessage = useCallback(() => { setInlineEditUserMessageId(null); setInlineEditDraft(""); }, []); const submitInlineEditUserMessage = useCallback((message: ChatMessage) => { if (!selectedConversation) return; const body = inlineEditDraft.trim();
    if (!body) { pushToast({ title: "Message cannot be empty", tone: "error" });
      return; } setInlineEditUserMessageId(null); setInlineEditDraft(""); setBranchPreview(null);
    void sendMessage({
      bodyOverride: body,
      filesOverride: [],
      conversationOverride: selectedConversation,
      editUserMessageIdOverride: message.id,
    }); }, [inlineEditDraft, pushToast, selectedConversation, sendMessage]); const handleProposalApprovalAction = (
    approvalId: string,
    action: ApprovalAction,
    messageId: string,
  ) => {
    const feedback = decisionNotesByMessageId[messageId]?.trim() ?? "";
    if (action === "requestRevision" && !feedback) {
      pushToast({
        title: "Feedback is required",
        body: "Tell the agent what must change before requesting a new proposal.",
        tone: "error",
      });
      return;
    }
    const sourceMessage = rawMessages.find((message) => message.id === messageId) ?? null;
    const issueProposal = sourceMessage ? issueProposalFromMessage(sourceMessage) : null;
    const operationProposal = sourceMessage ? operationProposalFromMessage(sourceMessage) : null;
    const proposalOverride = issueProposalOverridesByMessageId[messageId];
    const payloadOverride =
      action === "approve" && proposalOverride && sourceMessage?.approval?.payload
        ? chatIssueApprovalPayloadWithProposalOverride(sourceMessage.approval.payload as Record<string, unknown>, proposalOverride)
        : undefined;
    const proposalTitle =
      typeof issueProposal?.title === "string"
        ? issueProposal.title
        : typeof operationProposal?.summary === "string"
          ? operationProposal.summary
          : null;
    approvalMutation.mutate(
      { approvalId, action, messageId, payloadOverride },
      {
        onSuccess: () => {
          if (!selectedConversation) return;
          if (action === "requestRevision") {
            void sendMessage({
              bodyOverride: buildChatProposalRevisionPrompt({
                proposalTitle,
                feedback,
              }),
              filesOverride: [],
              conversationOverride: selectedConversation,
            });
            return;
          }
          if (action === "reject" && feedback) {
            void sendMessage({
              bodyOverride: buildChatProposalRejectFeedbackPrompt({
                proposalTitle,
                feedback,
              }),
              filesOverride: [],
              conversationOverride: selectedConversation,
            });
          }
        },
      },
    );
  }; const handleOperationProposalDecision = (
    messageId: string,
    action: ChatOperationProposalDecisionAction,
    decisionNote: string,
  ) => {
    const feedback = decisionNote.trim();
    if (action === "requestRevision" && !feedback) {
      pushToast({
        title: "Feedback is required",
        body: "Tell the agent what must change before requesting a new proposal.",
        tone: "error",
      });
      return;
    }
    const sourceMessage = rawMessages.find((message) => message.id === messageId) ?? null;
    const operationProposal = sourceMessage ? operationProposalFromMessage(sourceMessage) : null;
    operationProposalMutation.mutate(
      {
        chatId: selectedConversation!.id,
        messageId,
        action,
        decisionNote,
      },
      {
        onSuccess: () => {
          if (action !== "requestRevision" || !selectedConversation) return;
          void sendMessage({
            bodyOverride: buildChatProposalRevisionPrompt({
              proposalTitle: typeof operationProposal?.summary === "string" ? operationProposal.summary : null,
              feedback,
            }),
            filesOverride: [],
            conversationOverride: selectedConversation,
          });
        },
      },
    );
  }; const selectedConversationHasActiveReply = Boolean(selectedConversation && (activeStream || activeSendInFlight || queueQuery.data?.activeGenerationId)); const retryFailedMessage = useCallback(
    (message: ChatMessage) => { if (!selectedConversation) return; const sourceUserMessage = findRetrySourceUserMessage(rawMessages, message);
      if (!sourceUserMessage) {
        pushToast({
          title: "Retry unavailable",
          body: "The original user message for this failed reply could not be found.", tone: "error", });
        return; }
      void sendMessage({
        bodyOverride: sourceUserMessage.body,
        filesOverride: [],
        conversationOverride: selectedConversation,
        editUserMessageIdOverride: sourceUserMessage.id,
      }); }, [pushToast, rawMessages, selectedConversation, sendMessage], ); const refreshAssistantMessage = useCallback(
    (message: ChatMessage) => { if (!selectedConversation) return; if (!canRefreshAssistantChatMessage(message)) return; const sourceUserMessage = findRetrySourceUserMessage(rawMessages, message);
      if (selectedConversationHasActiveReply) {
        pushToast({
          title: "Refresh unavailable",
          body: "Wait for the current reply to finish before refreshing this answer.", tone: "error", });
        return; }
      if (!sourceUserMessage || sourceUserMessage.supersededAt) {
        pushToast({
          title: "Refresh unavailable",
          body: "The original user message for this answer could not be found.", tone: "error", });
        return; }
      void sendMessage({
        bodyOverride: sourceUserMessage.body,
        filesOverride: [],
        conversationOverride: selectedConversation,
        editUserMessageIdOverride: sourceUserMessage.id,
      }); }, [pushToast, rawMessages, selectedConversation, selectedConversationHasActiveReply, sendMessage], );
  const [emptyStatePromptSuggestionsLocked, setEmptyStatePromptSuggestionsLocked] = useState(false);
  const emptyStatePromptUnlockTimerRef = useRef<number | null>(null);
  const editDraftOnly = useCallback((text: string) => { setInlineEditUserMessageId(null); setInlineEditDraft(""); setDraft(text);
    requestAnimationFrame(() => { composerEditorRef.current?.focus(); }); }, []);
  const lockEmptyStatePromptSuggestions = useCallback(() => {
    if (emptyStatePromptUnlockTimerRef.current !== null) {
      window.clearTimeout(emptyStatePromptUnlockTimerRef.current);
      emptyStatePromptUnlockTimerRef.current = null;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setEmptyStatePromptSuggestionsLocked(false);
      return;
    }
    setEmptyStatePromptSuggestionsLocked(true);
    emptyStatePromptUnlockTimerRef.current = window.setTimeout(() => {
      emptyStatePromptUnlockTimerRef.current = null;
      setEmptyStatePromptSuggestionsLocked(false);
      const activeElement = document.activeElement;
      if (
        activeElement === document.body
        || activeElement?.id === "main-content"
        || activeElement?.closest("[data-testid='chat-empty-state-prompt-flow']")
      ) {
        composerEditorRef.current?.focus();
      }
    }, EMPTY_STATE_PROMPT_PAGE_TRANSITION_MS);
  }, []);
  useEffect(() => () => {
    if (emptyStatePromptUnlockTimerRef.current !== null) {
      window.clearTimeout(emptyStatePromptUnlockTimerRef.current);
    }
  }, []);
  const openEmptyStatePromptGroup = useCallback((group: EmptyStatePromptGroup) => { lockEmptyStatePromptSuggestions(); const nextDraft = applyChatPromptToDraft(readComposerDraft(), group.trigger); setDraft(nextDraft); setEmptyStateActiveSuggestionIndex(0); setDismissedEmptyStatePromptQuery(null);
    requestAnimationFrame(() => { composerEditorRef.current?.focus(); }); }, [lockEmptyStatePromptSuggestions, readComposerDraft]); const applyEmptyStatePrompt = useCallback((prompt: string) => { const nextDraft = applyChatPromptToDraft(readComposerDraft(), prompt); setDraft(nextDraft); setEmptyStateActiveSuggestionIndex(0); setDismissedEmptyStatePromptQuery(chatPromptQueryKey(nextDraft));
    requestAnimationFrame(() => { composerEditorRef.current?.focus(); }); }, [readComposerDraft]); const selectEmptyStatePromptSuggestion = useCallback((suggestion: EmptyStatePromptSuggestion) => { if (emptyStatePromptSuggestionsLocked) return; applyEmptyStatePrompt(suggestion.prompt); }, [applyEmptyStatePrompt, emptyStatePromptSuggestionsLocked]); const handleComposerDraftChange = useCallback((nextDraft: string) => { setDraft(nextDraft); setEmptyStateActiveSuggestionIndex(0); const nextQuery = chatPromptQueryKey(nextDraft); setDismissedEmptyStatePromptQuery((current) => current === nextQuery ? current : null); }, []); const turnBranchControlsForTurn = useCallback(
    (chatTurnId: string | null, activeTurnVariant?: number | null): ChatTurnBranchControls | null => { if (!chatTurnId) return null; const userRows = rawMessages.filter( (m) => m.role === "user" && m.kind === "message" && m.chatTurnId === chatTurnId, ); const variants = [...new Set([...userRows.map((m) => m.turnVariant), ...(activeTurnVariant === null || activeTurnVariant === undefined ? [] : [activeTurnVariant])])].sort((a, b) => a - b); if (variants.length < 2) return null; const activeRows = userRows.filter((m) => !m.supersededAt);
      const activeVariant = activeTurnVariant ?? (activeRows.length > 0 ? Math.max(...activeRows.map((m) => m.turnVariant)) : variants[variants.length - 1]!);
      const selected = branchPreview?.chatTurnId === chatTurnId ? branchPreview.turnVariant : activeVariant; let idx = variants.indexOf(selected); if (idx < 0) idx = variants.length - 1;
      return {
        current: idx + 1,
        total: variants.length,
        canPrev: idx > 0,
        canNext: idx < variants.length - 1,
        onPrev: () => setBranchPreview({ chatTurnId, turnVariant: variants[idx - 1]! }),
        onNext: () => setBranchPreview({ chatTurnId, turnVariant: variants[idx + 1]! }),
      }; }, [rawMessages, branchPreview], ); const turnBranchControlsFor = useCallback(
    (message: ChatMessage) => { const tid = message.chatTurnId; if (!tid || message.role !== "user" || message.kind !== "message") return null;
      return turnBranchControlsForTurn(tid); }, [turnBranchControlsForTurn], ); const userNickname = profileQuery.data?.nickname.trim() ?? ""; const emptyStateProjectName = activeProject ? projectDisplayName(activeProject) : null; const emptyStateHeading = chatEmptyStateHeading({
    activeProjectName: emptyStateProjectName, userNickname, t, }); const emptyStateHeadingKey = emptyStateProjectName ? `project:${activeProject?.id}:${emptyStateProjectName}` : "no-project"; const composerPlaceholder = activePlanMode ? t("chat.composer.planModePlaceholder") : draftIssueContext ? t("chat.composer.issuePlaceholder", { issue: draftIssueContextLabel(draftIssueContext) }) : t("chat.composer.placeholder"); const emptyStatePromptOptionsId = "chat-empty-state-prompt-options"; const emptyStatePromptSuggestions = useMemo(() => chatPromptSuggestionsForDraft(draft), [draft]); const displayedEmptyStatePromptSuggestions = emptyStatePromptSuggestions.length > 0 ? emptyStatePromptSuggestions : retainedEmptyStatePromptSuggestions; const emptyStatePromptQuery = chatPromptQueryKey(draft); const showEmptyStatePromptSuggestions = !selectedConversation && emptyStatePromptSuggestions.length > 0 && dismissedEmptyStatePromptQuery !== emptyStatePromptQuery; const boundedEmptyStateActiveSuggestionIndex = emptyStatePromptSuggestions.length > 0 ? Math.min(emptyStateActiveSuggestionIndex, emptyStatePromptSuggestions.length - 1) : 0; const activeEmptyStatePromptOptionId = showEmptyStatePromptSuggestions ? `${emptyStatePromptOptionsId}-${emptyStatePromptSuggestions[boundedEmptyStateActiveSuggestionIndex]?.id ?? ""}` : null;
  useEffect(() => {
    if (emptyStatePromptSuggestions.length > 0) {
      setRetainedEmptyStatePromptSuggestions(emptyStatePromptSuggestions);
    }
  }, [emptyStatePromptSuggestions]);
  const showEmptyStateSupplementalContent = emptyStatePromptQuery.length === 0 && pendingFiles.length === 0;
  const emptyStatePromptFlowState = showEmptyStateSupplementalContent ? "starters" : showEmptyStatePromptSuggestions ? "suggestions" : "hidden";
  const hasRecentProjectConversations = allRecentProjectConversations.length > 0;
  const canQueueDraft = Boolean(selectedConversationHasActiveReply && draft.trim().length > 0 && !newConversationSendInFlight);
  const sendButtonMode: SendButtonMode = newConversationSendInFlight || (activeSendInFlight && !activeStream) ? "sending" : canQueueDraft ? "queue" : activeSendInFlight ? "stop" : "send";
  const selectedConversationExternalBound = isExternalBoundConversation(selectedConversation);
  const sendButtonDisabled = selectedConversationExternalBound || composerUnavailable || sendButtonMode === "sending" || ((sendButtonMode === "send" || sendButtonMode === "queue") && draft.trim().length === 0);
  const canSteerQueuedFollowUps = Boolean(queueQuery.data?.activeGenerationId);
  const canStopSelectedConversationReply = Boolean(selectedConversation && (activeSendInFlight || queueQuery.data?.activeGenerationId));
  const composerStreaming = Boolean(activeStream) || activeSendInFlight || newConversationSendInFlight;
  useEffect(() => {
    const editable = composerSurfaceRef.current?.querySelector<HTMLElement>('[contenteditable="true"]');
    if (!editable || selectedConversation) return;

    const controlledAttributes = [
      "role",
      "aria-autocomplete",
      "aria-expanded",
      "aria-haspopup",
      "aria-controls",
      "aria-activedescendant",
    ] as const;
    const previousAttributes = new Map(controlledAttributes.map((attribute) => (
      [attribute, editable.getAttribute(attribute)] as const
    )));

    editable.setAttribute("role", "combobox");
    editable.setAttribute("aria-autocomplete", "list");
    editable.setAttribute("aria-expanded", showEmptyStatePromptSuggestions ? "true" : "false");
    editable.setAttribute("aria-haspopup", "listbox");
    if (showEmptyStatePromptSuggestions) {
      editable.setAttribute("aria-controls", emptyStatePromptOptionsId);
    } else {
      editable.removeAttribute("aria-controls");
    }
    if (activeEmptyStatePromptOptionId) {
      editable.setAttribute("aria-activedescendant", activeEmptyStatePromptOptionId);
    } else {
      editable.removeAttribute("aria-activedescendant");
    }

    return () => {
      for (const [attribute, previousValue] of previousAttributes) {
        if (previousValue === null) editable.removeAttribute(attribute);
        else editable.setAttribute(attribute, previousValue);
      }
    };
  }, [activeEmptyStatePromptOptionId, emptyStatePromptOptionsId, selectedConversation, showEmptyStatePromptSuggestions]);
  const handleEmptyStatePromptKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!showEmptyStatePromptSuggestions || event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setEmptyStateActiveSuggestionIndex((current) => (
        (current + direction + emptyStatePromptSuggestions.length) % emptyStatePromptSuggestions.length
      ));
      return;
    }
    if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const suggestion = emptyStatePromptSuggestions[boundedEmptyStateActiveSuggestionIndex];
      if (!suggestion) return;
      event.preventDefault();
      event.stopPropagation();
      selectEmptyStatePromptSuggestion(suggestion);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDismissedEmptyStatePromptQuery(emptyStatePromptQuery);
    }
  }, [boundedEmptyStateActiveSuggestionIndex, emptyStatePromptQuery, emptyStatePromptSuggestions, selectEmptyStatePromptSuggestion, showEmptyStatePromptSuggestions]); useEffect(() => {
    if (!showEmptyStateSupplementalContent) {
      setRecentProjectConversationLimit(RECENT_PROJECT_CONVERSATION_INITIAL_LIMIT);
    }
  }, [showEmptyStateSupplementalContent]); const renderComposerContextMenu = () => { if (!composerContextMenuOpen || !composerMenuPosition || typeof document === "undefined") return null; const activeMenu = projectMenuOpen ? "project" : agentMenuOpen ? "agent" : "skill";
    return createPortal(
      <div ref={composerContextMenuRef} data-testid={`chat-${activeMenu}-menu`} role="menu" className="chat-composer-context-menu motion-chat-composer-menu-pop surface-overlay fixed z-50 overflow-y-auto rounded-[var(--radius-lg)] border p-1.5 text-foreground" style={composerMenuPosition} >
        {projectMenuOpen && !projectSelectionLocked ? ( <>
            <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">Project context</div>
            <button type="button" role="menuitemradio" aria-checked={activeProjectId === NO_PROJECT_ID}
              data-chat-composer-menu-item className="chat-composer-menu-row project-context-menu-item" onClick={() => applyProjectContext(NO_PROJECT_ID)} >
              <span className="project-context-empty-swatch h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">No project</span> </button>
            {visibleProjects.length > 0 ? (
              <div className="my-1 border-t border-[color:var(--border-soft)] pt-1">
                {visibleProjects.map((project) => (
                  <button key={project.id} type="button" role="menuitemradio" aria-checked={activeProjectId === project.id}
                    data-chat-composer-menu-item className="chat-composer-menu-row project-context-menu-item" onClick={() => applyProjectContext(project.id)} >
                    <ProjectIcon color={project.color} icon={project.icon} size="xs" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{projectDisplayName(project)}</span>
                    </span> </button>
                ))} </div> ) : null} </> ) : null}
        {agentMenuOpen && !agentSelectionLocked ? ( <>
            <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">Agents</div>
            {liveAgents.length === 0 ? (
              <div className="flex items-center gap-2 rounded-[var(--radius-md)] px-3 py-2 text-sm text-muted-foreground">
                <Bot className="h-4 w-4 shrink-0" />
                <span>Create or activate an agent before sending messages.</span> </div> ) : liveAgents.map((agent) => (
              <button key={agent.id} type="button" role="menuitemradio" aria-checked={activeAgentId === agent.id}
                data-chat-composer-menu-item className="chat-composer-menu-row" onClick={() => applyPreferredAgent(agent.id)} >
                <AgentIcon icon={agent.icon} role={agent.role} className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-medium">{formatChatAgentLabel(agent)}</span> </button>
            ))} </> ) : null}
        {skillMenuOpen ? ( <>
            <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">Skills</div>
            {chatSkillsPending ? (
              <div className="flex items-center gap-2 rounded-[var(--radius-md)] px-3 py-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Loading skills...</span> </div> ) : availableChatSkills.length === 0 ? (
              <div className="rounded-[var(--radius-md)] px-3 py-2 text-sm leading-6 text-muted-foreground">
                This agent has no enabled skills. </div> ) : ( <>
                <div className="px-2 pb-2">
                  <input ref={skillSearchInputRef} className="w-full rounded-[var(--radius-md)] border border-border bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-ring" placeholder="Search skills..." value={skillSearchQuery} onChange={(event) => { setSkillSearchQuery(event.target.value);
                    }} onKeyDown={(event) => { event.stopPropagation();
                    }} /> </div>
                <div>
                  {filteredChatSkills.length === 0 ? (
                    <div className="rounded-[var(--radius-md)] px-3 py-2 text-sm leading-6 text-muted-foreground">
                      No skills match search. </div> ) : filteredChatSkills.map((entry) => (
                    <button key={entry.id} type="button" role="menuitem"
                      data-chat-composer-menu-item className="chat-composer-menu-row" onClick={() => insertSkillReference(entry)} >
                      <Boxes className="h-4 w-4 shrink-0 text-[#2f80ed]" />
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="min-w-0 shrink truncate font-medium text-foreground">
                          {entry.skillDisplayName} </span>
                        {entry.skillCategoryLabel ? (
                          <span className="inline-flex shrink-0 items-center rounded-[var(--radius-sm)] border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground">
                            {entry.skillCategoryLabel} </span> ) : null}
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">
                          {entry.skillDescription ?? entry.skillLocationLabel ?? entry.skillRefLabel} </span> </span> </button>
                  ))} </div> </> )} </> ) : null} </div>, document.body, ); }; const refreshQueue = (chatId: string) => {
    if (!selectedOrganizationId) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.chats.queue(selectedOrganizationId, chatId) });
  };
  useEffect(() => {
    if (!selectedConversation) return;
    if (activeStream || activeSendInFlight || activeQueueItems.length === 0) return;
    const chatId = selectedConversation.id;
    if (autoDequeuingChatIdsRef.current.has(chatId)) return;
    const timer = window.setTimeout(() => {
      if (autoDequeuingChatIdsRef.current.has(chatId)) return;
      autoDequeuingChatIdsRef.current.add(chatId);
      void chatsApi.claimNextQueuedMessage(chatId)
        .then(async (result) => {
          if (!result.item) return;
          refreshQueue(chatId);
          await sendMessage({
            bodyOverride: result.item.payload.body,
            filesOverride: [],
            conversationOverride: selectedConversation,
            queuedMessageId: result.item.id,
          });
        })
        .catch((error) => {
          if (!(error instanceof ApiError) || error.status !== 409) {
            pushToast({
              title: "Failed to run queued follow-up",
              body: error instanceof Error ? error.message : "Try again.",
              tone: "error",
            });
          }
        })
        .finally(() => {
          autoDequeuingChatIdsRef.current.delete(chatId);
          refreshQueue(chatId);
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [activeQueueItems.length, activeSendInFlight, activeStream, selectedConversation]);
  const steerQueuedMessage = (itemId: string) => {
    if (!selectedConversation) return;
    const chatId = selectedConversation.id;
    void chatsApi.steerQueuedMessage(chatId, itemId, queueQuery.data?.activeGenerationId ?? null)
      .then((result) => {
        refreshQueue(chatId);
        pushToast({
          title: result.result === "accepted" ? "Steered current reply" : "Still queued",
          body: result.result === "accepted" ? "The running agent received the follow-up." : "This runtime cannot accept mid-run steering yet.",
          tone: result.result === "accepted" ? "success" : "warn",
        });
      })
      .catch((error) => {
        pushToast({ title: "Failed to steer queued message", body: error instanceof Error ? error.message : "Try again.", tone: "error" });
      });
  };
  const editQueuedMessage = (itemId: string, body: string) => {
    const item = activeQueueItems.find((candidate) => candidate.id === itemId);
    if (!item) return;
    setEditingQueuedItem({ itemId, value: body, version: item.version });
  };
  const saveQueuedMessage = (item: ChatQueuedMessage) => {
    if (!selectedConversation || editingQueuedItem?.itemId !== item.id || !selectedOrganizationId) return;
    const body = editingQueuedItem.value.trim();
    if (!body) { pushToast({ title: "Queued message cannot be empty", tone: "error" }); return; }
    const chatId = selectedConversation.id;
    void chatsApi.updateQueuedMessage(chatId, item.id, {
      version: editingQueuedItem.version,
      payload: { ...item.payload, body },
    }).then((updated) => {
      queryClient.setQueryData(
        queryKeys.chats.queue(selectedOrganizationId, chatId),
        (current: Awaited<ReturnType<typeof chatsApi.listQueue>> | undefined) => ({
          activeGenerationId: current?.activeGenerationId ?? queueQuery.data?.activeGenerationId ?? null,
          items: (current?.items ?? []).map((candidate) => candidate.id === updated.id ? updated : candidate),
        }),
      );
      setEditingQueuedItem(null);
      refreshQueue(chatId);
    }).catch((error) => {
      pushToast({ title: "Failed to edit queued message", body: error instanceof Error ? error.message : "Try again.", tone: "error" });
    });
  };
  const deleteQueuedMessage = (itemId: string) => {
    if (!selectedConversation) return;
    const chatId = selectedConversation.id;
    void chatsApi.cancelQueuedMessage(chatId, itemId)
      .then(() => refreshQueue(chatId))
      .catch((error) => {
        pushToast({ title: "Failed to delete queued message", body: error instanceof Error ? error.message : "Try again.", tone: "error" });
      });
  }; const renderComposer = (centered: boolean) => {
    if (selectedConversationExternalBound && selectedConversation) {
      return (
        <div ref={composerSurfaceRef} data-testid="chat-external-bound-readonly" className={cn(
          "chat-composer rounded-[var(--radius-lg)] p-3 transition-all duration-300",
          centered ? "mx-auto w-full max-w-3xl" : "w-full",
        )} >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">Feishu chat is read-only in Rudder</div>
              <div className="mt-0.5 text-xs text-muted-foreground">Fork it to continue in a normal Rudder chat.</div>
            </div>
            <Button
              type="button"
              size="sm"
              data-testid="chat-fork-to-continue"
              disabled={forkConversationMutation.isPending}
              onClick={() => forkConversationMutation.mutate({ chatId: selectedConversation.id })}
            >
              <GitFork className="mr-2 h-4 w-4" />
              Fork to continue in Rudder
            </Button>
          </div>
        </div>
      );
    }
    return (
    <div ref={composerSurfaceRef} className={cn(
        "chat-composer rounded-[var(--radius-lg)] p-3 transition-all duration-300",
        composerStreaming && "chat-composer--streaming",
        centered ? "mx-auto w-full max-w-3xl" : "w-full",
      )} >
      {selectedConversation && visibleQueueItems.length > 0 ? (
        <div data-testid="chat-running-queue" className="mb-2.5 rounded-[var(--radius-md)] border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_88%,transparent)] p-2">
          <div className="mb-1.5 flex items-center justify-between gap-2 px-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            <span>{activeStream ? "Queued follow-ups" : "Queued follow-ups retained"}</span>
            <span>{visibleQueueItems.length} queued</span>
          </div>
          <div className="space-y-1.5">
            {visibleQueueItems.map((item, index) => {
              const itemEditable = item.status === "queued" || item.status === "steer_pending";
              const itemRunning = item.status === "dequeue_claimed" || item.status === "running";
              return (
                <div key={item.id} data-testid="chat-running-queue-item" className="flex min-w-0 items-center gap-2 rounded-[var(--radius-md)] border border-border/60 bg-background/70 px-2.5 py-2 text-sm">
                  <span className="shrink-0 text-xs font-semibold text-muted-foreground">{index === 0 ? (itemRunning ? "Running" : "Up next") : `#${index + 1}`}</span>
                  {editingQueuedItem?.itemId === item.id && itemEditable ? (
                    <>
                      <Textarea aria-label="Edit queued message text" data-testid="chat-running-queue-edit" className="min-h-9 flex-1 resize-none rounded-[var(--radius-sm)] border-border/70 bg-background px-2 py-1.5 text-sm" value={editingQueuedItem.value} onChange={(event) => setEditingQueuedItem((current) => current?.itemId === item.id ? { ...current, value: event.target.value } : current)} />
                      <button type="button" className="shrink-0 rounded-full px-2 py-1 text-xs font-semibold text-foreground transition-colors hover:bg-muted" onClick={() => saveQueuedMessage(item)}>Save</button>
                      <button type="button" className="shrink-0 rounded-full px-2 py-1 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted" onClick={() => setEditingQueuedItem(null)}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate text-foreground">{item.payload.body}</span>
                      {itemRunning ? (
                        <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">Running</span>
                      ) : item.lastDeliveryReason ? (
                        <span className="shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">Still queued</span>
                      ) : null}
                      {itemEditable ? (
                        <>
                          {canSteerQueuedFollowUps ? (
                            <button type="button" className="shrink-0 rounded-full px-2 py-1 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-500/10 dark:text-emerald-300" onClick={() => steerQueuedMessage(item.id)}>Steer</button>
                          ) : null}
                          <button type="button" aria-label="Edit queued message" className="shrink-0 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" onClick={() => editQueuedMessage(item.id, item.payload.body)}><Pencil className="h-3.5 w-3.5" /></button>
                          <button type="button" aria-label="Delete queued message" className="shrink-0 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" onClick={() => deleteQueuedMessage(item.id)}><Trash2 className="h-3.5 w-3.5" /></button>
                        </>
                      ) : null}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
      <div ref={composerEditorScrollRef} data-testid="chat-composer-editor-scroll" className="chat-composer-editor-scroll scrollbar-auto-hide overflow-y-auto overscroll-contain" onKeyDownCapture={handleEmptyStatePromptKeyDown} onPasteCapture={handlePendingAttachmentPasteCapture} >
        <MarkdownEditor ref={composerEditorRef} value={draft} onChange={handleComposerDraftChange}
          mentions={mentionOptions}
          onMentionQueryChange={setLibraryFileMentionQuery}
          mentionMenuAnchorRef={composerSurfaceRef}
          mentionMenuPlacement="container"
          submitShortcut="enter"
          onInlineTokenClick={handleComposerInlineTokenClick}
          plainText className="rounded-[var(--radius-md)] bg-transparent"
          contentClassName="min-h-[88px] bg-transparent text-[15px] leading-7 text-foreground"
          bordered={false} placeholder={composerPlaceholder} onSubmit={() => {
            if (composerUnavailable || newConversationSendInFlight) return;
            if (selectedConversationHasActiveReply && selectedConversation) {
              void queueComposerFollowUp(selectedConversation);
              return;
            }
            if (!controlsDisabled) {
              void sendMessage(); }
          }} /> </div>
      {composerUnavailable ? (
        <div className="chat-warning mt-2.5 rounded-[var(--radius-md)] px-3 py-2.5 text-sm">
          {composerUnavailableMessage}{" "}
          <Link to="/agents" className="underline underline-offset-4 hover:text-foreground">
            Open agents </Link> </div> ) : null}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2.5" data-testid="chat-composer-toolbar">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <DropdownMenu open={plusMenuOpen} onOpenChange={setPlusMenuOpen}>
            <DropdownMenuTrigger type="button" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-active)_52%,transparent)] text-sm font-medium text-foreground transition-colors hover:bg-[color:var(--surface-active)] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40" aria-label="Add files and options" >
              <Plus className="h-4 w-4" /> </DropdownMenuTrigger>
            <DropdownMenuContent align="start"
              sideOffset={8} className="surface-overlay w-80 max-w-[calc(100vw-2rem)] rounded-[var(--radius-lg)] border p-1.5 text-foreground" >
              <DropdownMenuItem className="rounded-[var(--radius-md)] px-3 py-2.5" onSelect={(e) => { e.preventDefault(); setPlusMenuOpen(false); window.setTimeout(() => fileInputRef.current?.click(), 0);
                }} >
                <Paperclip className="mr-2 h-4 w-4" />
                Add files </DropdownMenuItem>
              <button type="button" role="switch" aria-checked={activePlanMode} aria-label="Plan mode" data-testid="chat-plan-mode-toggle" title={PLAN_MODE_HELP_TEXT} className={cn(
                  "flex w-full cursor-pointer items-center justify-between gap-2 rounded-[var(--radius-md)] px-3 py-2.5 text-left text-sm outline-hidden transition-colors focus:bg-accent focus:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
                  activePlanMode && "bg-[color:color-mix(in_oklab,var(--accent-soft)_72%,transparent)] text-foreground focus:bg-[color:color-mix(in_oklab,var(--accent-soft)_88%,transparent)]",
                )} onClick={(event) => { event.preventDefault(); applyPlanMode(!activePlanMode);
                }} >
                <div className="flex min-w-0 items-center">
                  <ListChecks className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="font-medium text-foreground">Plan mode</div> </div>
                <span aria-hidden="true" data-testid="chat-plan-mode-track" className={cn(
                    "relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-[background-color,border-color,box-shadow,opacity]",
                    activePlanMode ? "border-[color:color-mix(in_oklab,var(--accent-base)_72%,white)] bg-[color:var(--accent-base)] text-primary-foreground shadow-[0_0_0_1px_color-mix(in_oklab,var(--accent-base)_22%,transparent),0_8px_22px_color-mix(in_oklab,var(--accent-base)_20%,transparent)]" : "border-[color:color-mix(in_oklab,var(--border-soft)_82%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-inset)_92%,transparent)] text-muted-foreground",
                  )} >
                  <span data-testid="chat-plan-mode-thumb" className={cn(
                      "inline-block h-5 w-5 rounded-full border border-[color:color-mix(in_oklab,var(--border-soft)_80%,transparent)] bg-[color:var(--surface-elevated)] shadow-[0_4px_12px_rgb(0_0_0/0.18)] transition-transform",
                      activePlanMode ? "translate-x-5" : "translate-x-0.5",
                    )} /> </span> </button>
              </DropdownMenuContent> </DropdownMenu>
          {activePlanMode ? (
            <button type="button" className="inline-flex max-w-[10rem] min-w-0 items-center gap-1.5 rounded-[var(--radius-md)] bg-[color:color-mix(in_oklab,var(--accent-soft)_78%,var(--surface-elevated))] px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-[color:color-mix(in_oklab,var(--accent-soft)_92%,var(--surface-elevated))] hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40" aria-label="Turn off plan mode" title={PLAN_MODE_HELP_TEXT} onClick={() => applyPlanMode(false)} >
              <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[color:color-mix(in_oklab,var(--ink-muted)_78%,transparent)] text-[color:var(--surface-elevated)]">
                <X className="h-3 w-3" strokeWidth={2.6} /> </span>
              <span className="min-w-0 truncate">Plan</span> </button> ) : null}
          {showProjectSelector ? (
          <button type="button" data-testid="chat-project-selector" aria-label={`Project context: ${projectPillLabel}`} aria-expanded={projectSelectionLocked ? false : projectMenuOpen} disabled={projectSelectionLocked} title={projectSelectionLocked ? "Project context is locked after conversation starts." : undefined} className={cn(
              "chat-chip inline-flex max-w-[min(100%,15rem)] min-w-0 items-center gap-1.5 rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium",
              projectSelectionLocked ? "cursor-default" : "transition-colors hover:bg-[color:var(--surface-active)]",
              projectMenuOpen && "bg-[color:var(--surface-active)]",
            )} onClick={() => { if (projectSelectionLocked) return;
              if (projectMenuOpen) { closeComposerContextMenus();
                return; } openComposerContextMenu("project");
            }} >
            {activeProject ? (
              <ProjectIcon color={activeProject.color} icon={activeProject.icon} size="xs" />
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="min-w-0 truncate">{projectPillLabel}</span>
            {projectSelectionLocked ? null : (
              <ChevronDown data-testid="chat-project-selector-chevron" className="h-3 w-3 shrink-0 opacity-70" />
            )} </button>
          ) : null}
          <button type="button" data-testid="chat-agent-selector" aria-expanded={agentMenuOpen} disabled={agentSelectionLocked} className={cn(
              "chat-chip inline-flex max-w-[min(100%,16rem)] min-w-0 items-center gap-1.5 rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium",
              agentSelectionLocked ? "cursor-default" : "transition-colors hover:bg-[color:var(--surface-active)]",
              agentMenuOpen && "bg-[color:var(--surface-active)]",
            )} onClick={() => { if (agentSelectionLocked) return;
              if (agentMenuOpen) { closeComposerContextMenus();
                return; } openComposerContextMenu("agent");
            }} >
            {activeSkillAgent ? (
              <span data-testid="chat-agent-selector-icon" className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted-foreground" aria-hidden="true" >
                <AgentIcon icon={activeSkillAgent.icon} role={activeSkillAgent.role} className="h-3.5 w-3.5" /> </span> ) : null}
            <span className="min-w-0 truncate">{agentPillLabel}</span>
            {agentSelectionLocked ? null : (
              <ChevronDown data-testid="chat-agent-selector-chevron" className="h-3 w-3 shrink-0 opacity-70" />
            )} </button>
          {showChatSkillsPicker ? (
            <button type="button" className={cn(
                "chat-chip inline-flex max-w-[min(100%,16rem)] min-w-0 items-center gap-1.5 rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[color:var(--surface-active)]",
                skillMenuOpen && "bg-[color:var(--surface-active)]",
              )} aria-label="Skills" aria-expanded={skillMenuOpen} onClick={() => {
                if (skillMenuOpen) { closeComposerContextMenus();
                  return; } openComposerContextMenu("skill");
              }} >
              <span className="min-w-0 truncate">Skills</span>
              <ChevronDown className="h-3 w-3 shrink-0 opacity-70" /> </button> ) : null} </div>
        {canStopSelectedConversationReply && selectedConversation && sendButtonMode !== "stop" && sendButtonMode !== "sending" ? (
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Stop streaming" onClick={() => stopStreaming(selectedConversation.id)} className={cn(
            "shrink-0 rounded-full border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-active)_52%,transparent)] text-foreground",
            "hover:bg-[color:var(--surface-active)]",
            "focus-visible:ring-2 focus-visible:ring-ring/40",
          )} >
            <Square className="h-3.5 w-3.5 fill-current" /> </Button>
        ) : null}
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => {
            if (sendButtonMode === "stop" && selectedConversation) { stopStreaming(selectedConversation.id);
              return; }
            if (sendButtonMode === "queue" && selectedConversation) {
              void queueComposerFollowUp(selectedConversation);
              return; }
            if (sendButtonMode === "send") {
              void sendMessage(); }
          }} disabled={sendButtonDisabled} aria-busy={sendButtonMode === "sending" ? true : undefined} aria-label={
            sendButtonMode === "sending" ? "Sending" : sendButtonMode === "stop" ? "Stop streaming" : sendButtonMode === "queue" ? "Queue follow-up" : "Send"
          } className={cn(
            "shrink-0 rounded-full border-0 bg-white text-black shadow-sm",
            "hover:bg-zinc-100 dark:bg-white dark:text-black dark:hover:bg-zinc-100",
            "disabled:pointer-events-none disabled:opacity-35",
            "focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--surface-page)]",
            sendButtonMode === "sending" && "disabled:opacity-100",
          )} >
          {sendButtonMode === "sending" ? (
            <Loader2 className="h-[18px] w-[18px] animate-spin" strokeWidth={2.25} /> ) : sendButtonMode === "stop" ? (
            <Square className="h-3.5 w-3.5 fill-current" /> ) : (
            <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.25} /> )} </Button> </div>
      {pendingFiles.length > 0 ? (
        <div data-testid="chat-pending-attachments" className="mt-2.5 flex flex-wrap gap-2">
          {pendingFiles.map((file) => { const fileKey = pendingAttachmentKey(file);
            return (
              <div key={fileKey} data-testid="chat-pending-attachment" className="max-w-full" >
                <PendingAttachmentPreview file={file} onOpenImage={setAttachmentPreview} onRemove={() => removePendingFile(fileKey)} /> </div> );
          })} </div> ) : null} {renderComposerContextMenu()} </div> );
  };
  const renderEmptyStatePromptFlow = () => {
    const starterActive = emptyStatePromptFlowState === "starters";
    const suggestionsActive = emptyStatePromptFlowState === "suggestions";
    return (
      <div
        data-testid="chat-empty-state-prompt-flow"
        data-state={emptyStatePromptFlowState}
        className="motion-chat-prompt-flow w-full max-w-3xl"
      >
        <div className="motion-chat-prompt-flow-clip">
          <div
            className="t-page-slide motion-chat-prompt-flow-pages"
            data-page={starterActive ? "1" : suggestionsActive ? "2" : "0"}
          >
            <section className="t-page" data-page-id="1" aria-hidden={starterActive ? undefined : true}>
              <ChatEmptyStatePromptStarters
                active={starterActive}
                onGroupSelect={openEmptyStatePromptGroup}
              />
            </section>
            <section className="t-page" data-page-id="2" aria-hidden={suggestionsActive ? undefined : true}>
              <ChatEmptyStatePromptOptions
                suggestions={displayedEmptyStatePromptSuggestions}
                optionsId={emptyStatePromptOptionsId}
                activeIndex={boundedEmptyStateActiveSuggestionIndex}
                active={suggestionsActive}
                interactive={!emptyStatePromptSuggestionsLocked}
                onActiveIndexChange={setEmptyStateActiveSuggestionIndex}
                onSuggestionSelect={selectEmptyStatePromptSuggestion}
              />
            </section>
          </div>
        </div>
      </div>
    );
  };
  return (
    <div className="chat-shell relative flex min-h-[calc(100dvh-8rem)] flex-col overflow-hidden text-foreground md:h-full md:min-h-0">
      {isMessengerChatRoute && !isMobile && !sidebarOpen ? (
        <button
          type="button"
          aria-label="Open Messenger sidebar"
          title="Open Messenger sidebar"
          className="absolute left-3 top-3 z-30 inline-flex h-8 w-8 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] text-muted-foreground transition-[background-color,color] hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          onClick={() => setSidebarOpen(true)}
        >
          <PanelLeft className="h-4 w-4" aria-hidden />
        </button>
      ) : null}
      <ChatAttachmentPreviewDialog
        preview={attachmentPreview} onOpenChange={(open) => { if (!open) setAttachmentPreview(null);
        }} />
      <input ref={fileInputRef} type="file" className="hidden"
        multiple onChange={(event) => { const files = Array.from(event.target.files ?? []); void appendPendingFiles(files); event.currentTarget.value = "";
        }} />
      {loadErrorMessage ? (
        <div className="mx-6 mt-6 rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {loadErrorMessage} </div> ) : null}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row md:gap-1.5">
        <main className="workspace-main-card relative flex min-h-0 flex-1 flex-col overflow-hidden md:rounded-[var(--desktop-workspace-radius)]">
          {!selectedOrganizationId ? (
            <div className="flex flex-1 items-center justify-center px-6 py-12 text-sm text-muted-foreground">
              Select a organization first. </div> ) : showConversationLoading ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-4 md:px-5" data-testid="chat-conversation-loading-state">
              <div ref={chatMessagesScrollRef} data-testid="chat-messages-scroll-region" className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto">
                <div data-testid="chat-messages-content" className="mx-auto flex w-full max-w-4xl flex-col gap-5 pr-1">
                  <ChatMessagesLoadingState />
                </div>
              </div>
            </div> ) : selectedConversation ? ( <>
              <div className="pointer-events-none absolute right-3 top-12 z-20 flex justify-end gap-1.5 md:right-3 md:top-2">
                {workManifestAvailable && !sidePanelOpen ? (
                  <ChatWorkManifestToggle
                    open={workManifestWideOpen}
                    count={workManifest?.totalCount ?? 0}
                    onToggle={() => setWorkManifestWideOpen((open) => !open)}
                  />
                ) : null}
                {!sidePanelOpen ? (
                  <button
                    type="button"
                    data-testid="chat-side-panel-trigger"
                    aria-label="Open Side Panel"
                    aria-pressed={false}
                    title="Open Side Panel"
                    className="pointer-events-auto inline-flex h-7 w-7 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] text-muted-foreground transition-[background-color,color] hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                    onClick={() => showSidePanelForContext(resolveCurrentSidePanelChatContextKey())}
                  >
                    <PanelRight className="h-4 w-4" aria-hidden />
                  </button>
                ) : null}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      data-testid="chat-actions-trigger"
                      aria-label="Chat actions"
                      className="pointer-events-auto inline-flex h-7 w-7 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] text-muted-foreground transition-[background-color,color] hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="surface-overlay text-foreground">
                    <DropdownMenuItem onClick={startActiveConversationRename}>
                      <PencilLine className="h-4 w-4" />
                      Rename
                    </DropdownMenuItem>
                    {canRegenerateChatTitles ? (
                      <DropdownMenuItem
                        disabled={selectedConversationTitleGenerating || regenerateTitleMutation.isPending}
                        onClick={() => regenerateTitleMutation.mutate(selectedConversation.id)}
                      >
                        {selectedConversationTitleGenerating ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <RefreshCw className="h-4 w-4" />
                        )}
                        Regenerate title
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem
                      onClick={() => updateConversationUserStateMutation.mutate({
                        chatId: selectedConversation.id,
                        pinned: !selectedConversation.isPinned,
                      })}
                    >
                      {selectedConversation.isPinned ? (
                        <>
                          <PinOff className="h-4 w-4" />
                          Unpin
                        </>
                      ) : (
                        <>
                          <Pin className="h-4 w-4" />
                          Pin
                        </>
                      )}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        const nextUnread = !selectedConversation.isUnread;
                        manuallyMarkedUnreadKeyRef.current = nextUnread && latestIncomingMessageId ? `${selectedConversation.id}:${latestIncomingMessageId}` : null;
                        updateConversationUserStateMutation.mutate({
                          chatId: selectedConversation.id,
                          unread: nextUnread,
                        });
                      }}
                    >
                      {selectedConversation.isUnread ? (
                        <>
                          <MailOpen className="h-4 w-4" />
                          Mark as Read
                        </>
                      ) : (
                        <>
                          <Mail className="h-4 w-4" />
                          Mark as Unread
                        </>
                      )}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void copyActiveConversationLink()}>
                      <Copy className="h-4 w-4" />
                      Copy Chat Link
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={selectedConversationGenerating || forkConversationMutation.isPending}
                      onClick={() => forkConversationMutation.mutate({ chatId: selectedConversation.id })}
                    >
                      <GitFork className="h-4 w-4" />
                      Fork
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={createGroupForActiveConversation}>
                      <FolderPlus className="h-4 w-4" />
                      New group
                    </DropdownMenuItem>
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        <FolderInput className="h-4 w-4" />
                        Move to group
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="surface-overlay text-foreground">
                        {selectedConversationCustomGroupId ? (
                          <DropdownMenuItem onClick={removeActiveConversationFromGroup}>
                            <Folder className="h-4 w-4" />
                            Move out of group
                          </DropdownMenuItem>
                        ) : null}
                        {customGroups.length > 0 ? (
                          customGroups.map((group) => (
                            <DropdownMenuItem
                              key={group.id}
                              disabled={group.id === selectedConversationCustomGroupId}
                              onClick={() => moveActiveConversationToGroup(group.id)}
                            >
                              <Folder className="h-4 w-4" />
                              {group.name}
                            </DropdownMenuItem>
                          ))
                        ) : (
                          <DropdownMenuItem disabled>No groups</DropdownMenuItem>
                        )}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    {!selectedConversationExternalBound ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => updateConversationMutation.mutate({
                            chatId: selectedConversation.id,
                            data: { status: "archived" },
                          })}
                        >
                          <Archive className="h-4 w-4" />
                          Archive
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={async () => {
                            const confirmed = await confirm({
                              title: "Delete chat",
                              description: `Delete "${conversationDisplayTitle(selectedConversation)}"? This cannot be undone.`,
                              confirmLabel: "Delete",
                              tone: "destructive",
                            });
                            if (!confirmed) return;
                            deleteConversationMutation.mutate({
                              chatId: selectedConversation.id,
                              cancelActive: selectedConversationGenerating,
                            });
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                          Delete
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <div className="pointer-events-none absolute right-4 top-12 z-20 md:right-5">
                <ChatWorkManifest
                  manifest={workManifest}
                  loading={workManifestQuery.isPending}
                  error={workManifestError}
                  sidePanelOpen={sidePanelOpen}
                  wideOpen={workManifestWideOpen}
                  onOpenItem={openWorkManifestItem}
                  onJumpToMessage={jumpToChatMessage}
                  onAddSource={() => fileInputRef.current?.click()}
                />
              </div>
              {isMobile && conversations.length > 0 ? (
                <div className="shrink-0 border-b panel-divider px-4 py-2 md:hidden">
                  <div className="mx-auto w-full max-w-4xl">
                    <DropdownMenu>
                      <DropdownMenuTrigger type="button" className="inline-flex h-9 w-full items-center justify-between gap-2 rounded-full border border-[color:var(--border-base)] bg-[color:var(--surface-elevated)] px-3 text-sm font-normal text-foreground shadow-none transition-colors hover:bg-[color:var(--surface-active)] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40" >
                        <span className="truncate text-left text-foreground">{conversationDisplayTitle(selectedConversation)}</span>
                        <ChevronDown className="h-4 w-4 shrink-0 opacity-60" /> </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="surface-overlay max-h-[min(60vh,320px)] w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto text-foreground" >
                        {conversations.map((c) => (
                          <DropdownMenuItem key={c.id} className={cn(c.id === selectedConversation.id && "bg-[color:var(--surface-active)]")} onClick={() => { void prefetchChatConversation(queryClient, selectedOrganizationId, c.id); navigate(chatConversationPath(c.id));
                            }} onPointerDown={() => {
                              if (c.id !== selectedConversation.id) {
                                void prefetchChatConversation(queryClient, selectedOrganizationId, c.id); }
                            }} onMouseEnter={() => {
                              if (c.id !== selectedConversation.id) {
                                void prefetchChatConversation(queryClient, selectedOrganizationId, c.id); }
                            }} >
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="truncate">{conversationDisplayTitle(c)}</span>
                              {c.isUnread ? (
                                <span className="inline-flex h-2 w-2 shrink-0 rounded-full bg-red-500" aria-label="Unread chat" /> ) : null} </span> </DropdownMenuItem> ))}
                        <DropdownMenuSeparator className="panel-divider" />
                        <DropdownMenuItem onClick={() => { setDraft(""); clearPendingFilesForCurrentScope(); navigate(chatRootPath);
                          }} >
                          <Plus className="mr-2 h-4 w-4" />
                          New chat </DropdownMenuItem> </DropdownMenuContent> </DropdownMenu> </div> </div> ) : null}
              <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
                <div ref={chatMessagesScrollRef} data-testid="chat-messages-scroll-region" className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto" >
                  <div className={cn(
                    "min-h-full px-4 pt-4 transition-[padding] duration-[var(--motion-duration-standard)] ease-[var(--motion-ease-enter)] motion-reduce:transition-none md:px-5",
                    workManifestRailOpen && "xl:pr-[19rem]",
                  )}>
                  <div data-testid="chat-messages-shell" className="relative mx-auto w-full max-w-4xl">
                    {showChatScrollMap && !showMessagesLoading ? (
                      <ChatScrollMap messages={visibleMessages} onJump={jumpToChatMessage} />
                    ) : null}
                    <div data-testid="chat-messages-content" className="mx-auto flex w-full max-w-4xl flex-col gap-5 pb-4 pr-1" >
                      {renamingConversationId === selectedConversation.id ? (
                        <form
                          data-testid="chat-title-rename-form"
                          className="surface-overlay pointer-events-auto mt-1 flex items-center gap-2 rounded-[var(--radius-md)] border px-2.5 py-2 text-foreground"
                          onSubmit={(event) => {
                            event.preventDefault();
                            submitActiveConversationRename();
                          }}
                        >
                          <PencilLine className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                          <input
                            autoFocus
                            aria-label="Chat title"
                            value={renameDraft}
                            onChange={(event) => setRenameDraft(event.currentTarget.value)}
                            onBlur={submitActiveConversationRename}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                event.preventDefault();
                                setRenamingConversationId(null);
                                setRenameDraft("");
                              }
                            }}
                            className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none placeholder:text-muted-foreground"
                          />
                        </form>
                      ) : null}
                      {showMessagesLoading ? (
                        <ChatMessagesLoadingState /> ) : visibleMessages.length === 0 && !activeStream ? (
                        <div className="surface-inset rounded-[var(--radius-xl)] border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
                          No messages yet. Start by describing the work and Rudder will clarify it first. </div> ) : ( <>
                          {visibleMessages.map((message, messageIndex) => { const previousMessage = visibleMessages[messageIndex - 1] ?? null; const previousPreviousMessage = visibleMessages[messageIndex - 2] ?? null; if (shouldAttachIssueCreatedSystemMessage(previousMessage, message) || shouldAttachApprovalFeedbackSystemMessage(previousPreviousMessage, previousMessage, message)) return null; const nextMessage = visibleMessages[messageIndex + 1] ?? null; const issueCreatedMessage = shouldAttachIssueCreatedSystemMessage(message, nextMessage) ? nextMessage : null; const persistedTranscript = (loadedTranscriptsByMessageId[message.id] ?? message.transcript ?? []) as TranscriptEntry[];
                            const messageCanShowProcess = message.role === "assistant"
                              || message.kind === "issue_proposal" || message.kind === "operation_proposal";
                            const shouldRenderPersistedTranscript =
                              persistedTranscript.length > 0 && messageCanShowProcess; const shouldRenderLazyTranscript = persistedTranscript.length === 0 && messageCanShowProcess && Boolean(message.transcriptSummary?.entryCount); const persistedProcessStartedAt = shouldRenderPersistedTranscript ? resolvePersistedChatProcessStartedAt(visibleMessages, message, persistedTranscript) : null; const persistedProcessEndedAt = shouldRenderPersistedTranscript ? resolvePersistedChatProcessEndedAt(message, persistedTranscript) : null;
                            const messageTurnBranchControls = turnBranchControlsFor(message);
                            const refreshTurnBranchControls = message.chatTurnId ? turnBranchControlsForTurn(message.chatTurnId) : null;
                            return (
                              <Fragment key={message.id}>
                                {shouldRenderPersistedTranscript ? (
                                  <StreamTranscriptItem
                                    entries={persistedTranscript}
                                    state={message.status}
                                    streamStartedAt={persistedProcessStartedAt!}
                                    streamEndedAt={persistedProcessEndedAt}
                                    assistantMessageBody={message.body}
                                    showDeveloperDiagnostics={showDeveloperDiagnostics}
                                    defaultOpen={Boolean(openProcessMessageIds[message.id])} onOpenChange={(open) => setProcessOpenForMessage(message.id, open)} /> ) : shouldRenderLazyTranscript && message.transcriptSummary ? (
                                  <LazyStreamTranscriptItem
                                    summary={message.transcriptSummary}
                                    state={message.status}
                                    loading={Boolean(loadingTranscriptMessageIds[message.id])}
                                    onLoad={() => void loadMessageTranscript(message.conversationId, message.id)}
                                  /> ) : null}
                                <ChatMessageItem
                                  conversation={selectedConversation}
                                  message={message}
                                  agents={agents}
                                  currentUserId={currentUserId}
                                  issueProposalOverride={issueProposalOverridesByMessageId[message.id]}
                                  onIssueProposalChange={setIssueProposalOverrideForMessage}
                                  actionPending={
                                    approvalMutation.isPending
                                    || convertToIssueMutation.isPending
                                    || operationProposalMutation.isPending
                                    || selectedConversationExternalBound }
                                  decisionNote={decisionNotesByMessageId[message.id] ?? ""} onDecisionNoteChange={(value) => setDecisionNoteForMessage(message.id, value)}
                                  decisionNoteMentions={mentionOptions}
                                  onDecisionNoteMentionQueryChange={setLibraryFileMentionQuery}
                                  onDecisionNoteInlineTokenClick={handleComposerInlineTokenClick}
                                  onApprovalAction={handleProposalApprovalAction} onResolveOperationProposal={handleOperationProposalDecision} onConvertToIssue={(messageToConvert) =>
                                    convertToIssueMutation.mutate({
                                      chatId: selectedConversation.id,
                                      message: messageToConvert,
                                      proposalOverride: issueProposalOverridesByMessageId[messageToConvert.id], })
                                  } onCopyMessageText={copyChatMessageText} onEditUserMessage={selectedConversationExternalBound ? undefined : beginEditUserMessage} onContinueInterruptedMessage={selectedConversationExternalBound ? undefined : () => {
                                    void sendMessage({
                                      bodyOverride: INTERRUPTED_CHAT_CONTINUATION_PROMPT,
                                      filesOverride: [], conversationOverride: selectedConversation, });
                                  }} onRetryFailedMessage={selectedConversationExternalBound ? undefined : retryFailedMessage} canRefreshAssistantMessage={canRefreshDisplayedAssistantChatMessage({
                                    message,
                                    branchControls: refreshTurnBranchControls,
                                    hasActiveReply: selectedConversationHasActiveReply,
                                  })} onRefreshAssistantMessage={selectedConversationExternalBound ? undefined : refreshAssistantMessage} onForkMessage={(messageToFork) => forkConversationMutation.mutate({
                                    chatId: selectedConversation.id,
                                    sourceMessageId: messageToFork.id,
                                  })} onOpenImage={setAttachmentPreview} onOpenFile={openLocalFile} onMarkdownLinkClick={handleChatMarkdownLinkClick}
                                  turnBranchControls={messageTurnBranchControls}
                                  skillReferences={chatSkillReferences}
                                  issueCreatedMessage={issueCreatedMessage}
                                  inlineEdit={inlineEditUserMessageId === message.id ? {
                                    draft: inlineEditDraft,
                                    disabled: controlsDisabled || composerUnavailable || selectedConversationExternalBound,
                                    mentions: mentionOptions,
                                    surfaceRef: inlineEditSurfaceRef,
                                    editorRef: inlineEditEditorRef,
                                    onChange: setInlineEditDraft,
                                    onSubmit: () => submitInlineEditUserMessage(message),
                                    onCancel: cancelInlineEditUserMessage,
                                    onMentionQueryChange: setLibraryFileMentionQuery,
                                    onInlineTokenClick: handleComposerInlineTokenClick,
                                  } : null}
                                  answered={isAskUserMessageAnswered(message, visibleMessages)}
                                  askUserAnswer={askUserAnswerFromMessage(message, visibleMessages)}
                                  animateAskUserAnswer={message.id === recentAskUserAnswerMessageId} /> </Fragment> ); })}
                          {showActiveStreamDraft && activeStream ? ( <>
                              {showOptimisticUserMessage ? (
                                <OptimisticUserDraftItem
                                  body={activeStream.userBody}
                                  createdAt={activeStream.userCreatedAt} onCopyMessageText={copyChatMessageText} onEditDraftOnly={editDraftOnly}
                                  skillReferences={chatSkillReferences} onMarkdownLinkClick={handleChatMarkdownLinkClick}
                                  askUserAnswer={
                                    pendingAskUserRequest ? parseAskUserAnswerMessage(pendingAskUserRequest, activeStream.userBody) : null
                                  }
                                  animateAskUserAnswer={activeStream.userBody.startsWith(ASK_USER_ANSWER_PREFIX)}
                                  turnBranchControls={turnBranchControlsForTurn(activeStream.chatTurnId, activeStream.turnVariant)} /> ) : null}
                              <StreamTranscriptItem key={`${activeStream.chatId}-${activeStream.createdAt.getTime()}`}
                                entries={activeStream.transcript}
                                state={activeStream.state}
                                streamStartedAt={activeStream.createdAt}
                                assistantMessageBody={activeStream.body}
                                showDeveloperDiagnostics={showDeveloperDiagnostics} />
                              <AssistantDraftItem
                                body={activeStream.body}
                                createdAt={activeStream.createdAt}
                                state={activeStream.state}
                                replyingAgentId={activeStream.replyingAgentId}
                                conversation={selectedConversation}
                                agents={agents} onCopyMessageText={copyChatMessageText}
                                skillReferences={chatSkillReferences} onMarkdownLinkClick={handleChatMarkdownLinkClick} /> </> ) : null} </>
                      )} </div> </div> </div> </div>
                {hasActionableApprovals || hasPendingLightweightProposal ? null : (
                  <div
                    data-testid="chat-composer-layout"
                    className={cn(
                    "w-full shrink-0 px-4 pb-4 transition-[padding] duration-[var(--motion-duration-standard)] ease-[var(--motion-ease-enter)] motion-reduce:transition-none md:px-5",
                    workManifestRailOpen && "xl:pr-[19rem]",
                  )}>
                  <div data-testid="chat-composer-content" className="mx-auto w-full max-w-4xl space-y-4">
                    {selectedConversationExternalBound ? (
                      renderComposer(false)
                    ) : pendingAskUserMessage && pendingAskUserRequest ? (
                      <AskUserPanel
                        message={pendingAskUserMessage}
                        request={pendingAskUserRequest} disabled={controlsDisabled || composerUnavailable}
                        pendingFiles={pendingFiles}
                        onAddAttachment={() => fileInputRef.current?.click()}
                        onRemovePendingFile={removePendingFile}
                        onOpenAttachmentPreview={setAttachmentPreview}
                        onPasteAttachment={handlePendingAttachmentPasteCapture}
                        onSubmit={(body) => { if (!selectedConversation) return;
                          void sendMessage({
                            bodyOverride: body,
                            filesOverride: [...pendingFiles], conversationOverride: selectedConversation,
                            clearPendingFilesOnSuccess: true,
                            onUserMessageAcknowledged: () => clearChatAskUserDraft(pendingAskUserMessage.orgId, pendingAskUserMessage.id), });
                        }} /> ) : (
                      renderComposer(false)
                    )} </div> </div>
                )} </div> </> ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-8">
              <div className="mx-auto flex w-full max-w-4xl flex-col items-center justify-center">
                <div className="mb-5 w-full max-w-3xl px-1 text-center">
                  <h1 key={emptyStateHeadingKey} className="motion-chat-empty-heading max-w-full text-[2rem] leading-[1.1] tracking-normal text-foreground [overflow-wrap:anywhere] md:text-[2.3rem]" >
                    {emptyStateHeading} </h1> </div>
                {showEmptyStateSupplementalContent ? (
                  hasRecentProjectConversations ? (
                    <Tabs value={emptyStateActiveTab} onValueChange={(value) => setEmptyStateActiveTab(value as "recent" | "use-cases")} className="mb-4 w-full max-w-3xl gap-2" data-testid="chat-empty-state-tabs">
                      <TabsList variant="line" aria-label="New chat empty state" className="mb-2 h-auto gap-1 border-transparent bg-transparent px-0">
                        <TabsTrigger value="use-cases" id="chat-empty-state-tab-use-cases" data-testid="chat-empty-state-tab-use-cases" className="h-8 flex-none rounded-[var(--radius-md)] border border-transparent px-3 text-sm data-[state=active]:!border-[color:var(--border-soft)] data-[state=active]:!bg-[color:var(--surface-active)] data-[state=active]:shadow-none after:hidden">
                          <span>Use cases</span>
                        </TabsTrigger>
                        <TabsTrigger value="recent" id="chat-empty-state-tab-recent" data-testid="chat-empty-state-tab-recent" className="h-8 flex-none rounded-[var(--radius-md)] border border-transparent px-3 text-sm data-[state=active]:!border-[color:var(--border-soft)] data-[state=active]:!bg-[color:var(--surface-active)] data-[state=active]:shadow-none after:hidden">
                          <span>Chats</span>
                        </TabsTrigger>
                      </TabsList>
                      <TabsContent value="use-cases" id="chat-empty-state-use-cases-panel" aria-labelledby="chat-empty-state-tab-use-cases" className="mt-0 flex flex-col items-center">
                        {renderEmptyStatePromptFlow()}
                      </TabsContent>
                      <TabsContent value="recent" id="chat-empty-state-recent-panel" aria-labelledby="chat-empty-state-tab-recent" className="mt-0">
                        <ChatEmptyStateRecentConversations
                          key={activeProject ? `project:${activeProject.id}` : "no-project"}
                          className="!mt-0"
                          conversations={recentProjectConversations}
                          projectName={activeProject ? projectDisplayName(activeProject) : null}
                          visible={emptyStateActiveTab === "recent"}
                          conversationPath={chatConversationPath}
                          onPrefetchConversation={(conversationId) => void prefetchChatConversation(queryClient, selectedOrganizationId, conversationId)}
                          hasMoreConversations={hasMoreRecentProjectConversations}
                          onLoadMoreConversations={loadMoreRecentProjectConversations}
                        />
                      </TabsContent>
                    </Tabs>
                  ) : renderEmptyStatePromptFlow()
                ) : renderEmptyStatePromptFlow()}
                <div className="w-full max-w-3xl">
                  {renderComposer(true)} </div> </div> </div> )} </main>
              </div> </div> ); }
