import { type MarkdownLinkClickHandler } from "@/components/MarkdownBody";
import { type ChatStreamDraftState } from "@/context/ChatGenerationContext";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import { formatAssigneeUserLabel } from "@/lib/assignees";
import { displayChatTitle, isDefaultChatTitle, promoteDefaultChatTitle } from "@/lib/chat-title";
import { projectColorCssVars } from "@/lib/project-colors";
import { Link } from "@/lib/router";
import { cn, relativeTime } from "@/lib/utils";
import {
  chatAskUserRequestFromStructuredPayload,
  formatMessengerPreview,
  type Agent,
  type Approval,
  type ChatAskUserQuestion,
  type ChatAskUserRequest,
  type ChatConversation,
  type ChatMessage,
  type ChatOperationProposalDecisionStatus,
  type ChatPrimaryIssueSummary,
  type Issue,
  type MessengerThreadSummary,
  type Project
} from "@rudderhq/shared";
import {
  Loader2
} from "lucide-react";
import { useCallback, useEffect, useRef, type CSSProperties } from "react";
export { ChatAttachmentList, ChatAttachmentPreviewDialog, ChatFileAttachmentChip, ChatImageAttachmentTile, PendingAttachmentPreview } from "./Chat.attachments";
export { AskUserAnswerBubble, AskUserHistoryRecord, AskUserPanel, AssistantDraftItem, ChatAssistantAttributionRow, chatIssueApprovalPayloadWithProposalOverride, ChatLongMessageBody, chatMessageHoverBarClass, ChatMessageItem, ChatMessagesLoadingState, ChatSystemMessageBody, issueCreatedSystemMessageParts, LazyStreamTranscriptItem, OptimisticUserDraftItem, ProposalCard, readStructuredPayloadString, StreamTranscriptItem } from "./Chat.messages";

export type ApprovalAction = "approve" | "reject" | "requestRevision";
export type AttachmentPreviewState = {
  src: string;
  name: string;
};

export type ChatImageContextMenuPosition = {
  left: number;
  top: number;
};

export const OPEN_TASK_PRIORITY_PROMPT = "List my open tasks by priority";

export const EMPTY_STATE_PROMPT_GROUPS = [
  {
    label: "Scope a new feature",
    examples: [
      "Plan an approval queue for budget overrides",
      "Scope a weekly CEO status digest",
      "Design an organization plugin install flow",
    ],
  },
  {
    label: "Clarify a vague request",
    examples: [
      "Turn rough notes into an implementation plan",
      "Figure out what 'make Messenger less noisy' should mean",
      "Translate a founder ask into acceptance criteria",
    ],
  },
  {
    label: "Turn a chat into an issue",
    examples: [
      OPEN_TASK_PRIORITY_PROMPT,
      "Extract the next shippable task from this discussion",
      "Split this conversation into scope, owner, and done criteria",
      "Draft an issue from a decision we already made",
    ],
  },
  {
    label: "Review a blocker",
    examples: [
      "Diagnose why a packaged desktop build is failing",
      "Review a confusing approval flow before more coding",
      "Decide whether to patch the design or write a standard first",
    ],
  },
] as const;

export const NO_PROJECT_ID = "__none__";
export const CHAT_LAST_PROJECT_STORAGE_KEY = "rudder.chatLastProjectByOrg";
export const CHAT_PROJECT_BY_AGENT_STORAGE_KEY = "rudder.chatProjectByAgentByOrg";

export type EmptyStatePromptLabel = (typeof EMPTY_STATE_PROMPT_GROUPS)[number]["label"];
export type EmptyStatePromptGroup = (typeof EMPTY_STATE_PROMPT_GROUPS)[number];

export function ChatEmptyStatePromptOptions({
  group,
  optionsId,
  entered,
  originX,
  onExampleSelect,
}: {
  group: EmptyStatePromptGroup;
  optionsId: string;
  entered: boolean;
  originX: string;
  onExampleSelect: (example: string) => void;
}) {
  return (
    <div
      key={group.label}
      id={optionsId}
      data-testid="chat-empty-state-prompt-options"
      data-entered={entered ? "true" : "false"}
      role="region"
      aria-label={`${group.label} examples`}
      style={{ "--chat-options-origin-x": originX } as CSSProperties}
      className="motion-chat-options-pop mt-3 w-full max-w-3xl rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-panel)_86%,transparent)] px-3 py-3 shadow-[var(--shadow-sm)]"
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-muted-foreground">
          Example use cases
        </p>
        <p className="text-sm text-foreground">{group.label}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {group.examples.map((example) => (
          <button
            key={example}
            type="button"
            data-chat-option
            onClick={() => onExampleSelect(example)}
            className="rounded-[calc(var(--radius-sm)+2px)] border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_72%,transparent)] px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:border-[color:var(--border-strong)] hover:bg-[color:var(--surface-active)] hover:text-foreground"
          >
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}

export function readRememberedChatProjectId(orgId: string): string | null | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(CHAT_LAST_PROJECT_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const value = (parsed as Record<string, unknown>)[orgId];
    return typeof value === "string" ? value : value === null ? null : undefined;
  } catch {
    return undefined;
  }
}

export function rememberChatProjectId(orgId: string, projectId: string | null) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(CHAT_LAST_PROJECT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const next = parsed && typeof parsed === "object" ? parsed as Record<string, string | null> : {};
    next[orgId] = projectId;
    window.localStorage.setItem(CHAT_LAST_PROJECT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage failures; project context still persists on saved conversations.
  }
}

export function readRememberedChatProjectIdForAgent(orgId: string, agentId: string): string | null | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(CHAT_PROJECT_BY_AGENT_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const orgMap = (parsed as Record<string, unknown>)[orgId];
    if (!orgMap || typeof orgMap !== "object") return undefined;
    const value = (orgMap as Record<string, unknown>)[agentId];
    return typeof value === "string" ? value : value === null ? null : undefined;
  } catch {
    return undefined;
  }
}

export function rememberChatProjectIdForAgent(orgId: string, agentId: string | null | undefined, projectId: string | null) {
  if (typeof window === "undefined" || !agentId) return;
  try {
    const raw = window.localStorage.getItem(CHAT_PROJECT_BY_AGENT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const next = parsed && typeof parsed === "object"
      ? parsed as Record<string, Record<string, string | null>>
      : {};
    const orgMap = next[orgId] && typeof next[orgId] === "object" ? next[orgId] : {};
    orgMap[agentId] = projectId;
    next[orgId] = orgMap;
    window.localStorage.setItem(CHAT_PROJECT_BY_AGENT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage failures; the organization-level default still applies.
  }
}

function isVisibleProjectId(projectId: string | null | undefined, projects: readonly Pick<Project, "id">[]) {
  return Boolean(projectId && projects.some((project) => project.id === projectId));
}

export function resolveDefaultDraftChatProjectId({
  orgId,
  projects,
  issue,
  agentId,
}: {
  orgId: string;
  projects: readonly Pick<Project, "id">[];
  issue?: Pick<Issue, "projectId"> | null;
  agentId?: string | null;
}) {
  if (isVisibleProjectId(issue?.projectId, projects)) return issue!.projectId!;

  if (agentId) {
    const agentRememberedProjectId = readRememberedChatProjectIdForAgent(orgId, agentId);
    if (agentRememberedProjectId === null) return NO_PROJECT_ID;
    if (isVisibleProjectId(agentRememberedProjectId, projects)) return agentRememberedProjectId!;
  }

  const rememberedProjectId = readRememberedChatProjectId(orgId);
  if (rememberedProjectId === null) return NO_PROJECT_ID;
  if (isVisibleProjectId(rememberedProjectId, projects)) return rememberedProjectId!;

  return NO_PROJECT_ID;
}

export function projectContextId(conversation: ChatConversation | null | undefined) {
  return conversation?.contextLinks.find((link) => link.entityType === "project")?.entityId ?? null;
}

export function resolveDraftIssueContext(issues: Issue[] | undefined, requestedIssueId: string | null | undefined) {
  const normalizedIssueId = requestedIssueId?.trim();
  if (!normalizedIssueId) return null;
  return (issues ?? []).find((issue) => issue.id === normalizedIssueId || issue.identifier === normalizedIssueId) ?? null;
}

export function draftIssueContextLabel(issue: Pick<Issue, "identifier" | "title"> | null | undefined) {
  if (!issue) return "this issue";
  return issue.identifier?.trim() || issue.title.trim() || "this issue";
}

export function buildDraftChatContextLinks(projectId: string | null, issueId: string | null) {
  const contextLinks: Array<{ entityType: "issue" | "project"; entityId: string }> = [];
  if (issueId) {
    contextLinks.push({ entityType: "issue", entityId: issueId });
  }
  if (projectId) {
    contextLinks.push({ entityType: "project", entityId: projectId });
  }
  return contextLinks;
}

export function issueAssigneeMentionLabel(
  issue: Pick<Issue, "assigneeAgentId" | "assigneeUserId">,
  agentById: Map<string, Agent>,
) {
  if (issue.assigneeAgentId) {
    return agentById.get(issue.assigneeAgentId)?.name ?? issue.assigneeAgentId.slice(0, 8);
  }
  if (issue.assigneeUserId) {
    return formatAssigneeUserLabel(issue.assigneeUserId, null) ?? issue.assigneeUserId.slice(0, 8);
  }
  return null;
}

export function projectDisplayName(project: Project | null | undefined) {
  return project?.name?.trim() || "Unknown project";
}

export function chatEmptyStateHeading({
  activeProjectName,
  userNickname,
  t,
}: {
  activeProjectName?: string | null;
  userNickname?: string | null;
  t: (
    key: "chat.emptyState.heading" | "chat.emptyState.headingNamed" | "chat.emptyState.headingProject",
    params?: Record<string, string>,
  ) => string;
}) {
  const projectName = activeProjectName?.trim() ?? "";
  if (projectName) {
    return t("chat.emptyState.headingProject", { project: projectName });
  }

  const nickname = userNickname?.trim() ?? "";
  return nickname
    ? t("chat.emptyState.headingNamed", { name: nickname })
    : t("chat.emptyState.heading");
}

export function projectContextSwatchStyle(color: string | null | undefined): CSSProperties {
  return projectColorCssVars(color);
}

export const COMPOSER_MENU_VIEWPORT_PADDING = 12;
export const COMPOSER_MENU_OFFSET = 10;
export const COMPOSER_MENU_MIN_HEIGHT = 128;
export const COMPOSER_MENU_MAX_HEIGHT = 360;
export const COMPOSER_MENU_MIN_WIDTH = 320;

export function composerMenuPositionForAnchor(anchor: HTMLElement): CSSProperties {
  const rect = anchor.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const availableWidth = Math.max(
    COMPOSER_MENU_MIN_WIDTH,
    viewportWidth - COMPOSER_MENU_VIEWPORT_PADDING * 2,
  );
  const width = Math.min(Math.max(rect.width, COMPOSER_MENU_MIN_WIDTH), availableWidth);
  const left = Math.min(
    Math.max(rect.left, COMPOSER_MENU_VIEWPORT_PADDING),
    viewportWidth - COMPOSER_MENU_VIEWPORT_PADDING - width,
  );
  const availableAbove = Math.max(
    0,
    rect.top - COMPOSER_MENU_VIEWPORT_PADDING - COMPOSER_MENU_OFFSET,
  );
  const availableBelow = Math.max(
    0,
    viewportHeight - rect.bottom - COMPOSER_MENU_VIEWPORT_PADDING - COMPOSER_MENU_OFFSET,
  );
  const openUpward = availableAbove >= COMPOSER_MENU_MIN_HEIGHT || availableAbove >= availableBelow;
  const maxHeight = Math.max(
    COMPOSER_MENU_MIN_HEIGHT,
    Math.min(
      COMPOSER_MENU_MAX_HEIGHT,
      openUpward ? availableAbove : availableBelow,
    ),
  );

  if (openUpward) {
    return {
      left,
      width,
      bottom: viewportHeight - rect.top + COMPOSER_MENU_OFFSET,
      maxHeight,
    };
  }

  return {
    left,
    width,
    top: rect.bottom + COMPOSER_MENU_OFFSET,
    maxHeight,
  };
}

export function inferAttachmentExtension(contentType: string) {
  const normalized = contentType.trim().toLowerCase();
  if (!normalized) return "bin";
  if (normalized === "text/plain") return "txt";
  if (normalized === "text/markdown") return "md";
  if (normalized === "application/json") return "json";
  if (normalized === "text/csv") return "csv";
  if (normalized === "text/html") return "html";
  if (normalized === "application/pdf") return "pdf";
  const subtype = normalized.split("/")[1]?.split(";")[0]?.trim();
  return subtype && subtype.length > 0 ? subtype : "bin";
}

const stagedPendingAttachmentKeys = new WeakMap<File, string>();
let stagedPendingAttachmentKeySequence = 0;

export async function materializePendingAttachment(file: File, index: number) {
  const buffer = await file.arrayBuffer();
  const filename = file.name.trim() || `pasted-attachment-${index + 1}.${inferAttachmentExtension(file.type)}`;
  const materializedFile = new File([buffer], filename, {
    type: file.type,
    lastModified: file.lastModified || Date.now(),
  });
  stagedPendingAttachmentKeys.set(materializedFile, `staged-${++stagedPendingAttachmentKeySequence}`);
  return materializedFile;
}

export function pendingAttachmentKey(file: File) {
  const stagedKey = stagedPendingAttachmentKeys.get(file);
  if (stagedKey) return stagedKey;
  return `${file.name}-${file.size}-${file.lastModified}`;
}

export function attachmentDisplayName(input: { originalFilename?: string | null; assetId?: string; name?: string }) {
  return input.originalFilename ?? input.name ?? input.assetId ?? "attachment";
}

export function clampChatImageContextMenuPosition(left: number, top: number): ChatImageContextMenuPosition {
  if (typeof window === "undefined") return { left, top };
  return {
    left: Math.min(left, Math.max(8, window.innerWidth - 190)),
    top: Math.min(top, Math.max(8, window.innerHeight - 96)),
  };
}

export function shouldHandlePlainChatLinkClick(event: Parameters<MarkdownLinkClickHandler>[0]["event"]) {
  return event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

export const NO_CHAT_AGENT_LABEL = "No agents available";
export const PLAN_MODE_HELP_TEXT =
  "Read-only planning. The agent should investigate, produce a plan, and create an issue with that plan attached.";

export type ChatBranchPreview = { chatTurnId: string; turnVariant: number };

export function mergeChatMessages(current: ChatMessage[], incoming: ChatMessage[]) {
  const merged = new Map<string, ChatMessage>();
  for (const message of current) {
    merged.set(message.id, message);
  }
  for (const message of incoming) {
    const prev = merged.get(message.id);
    merged.set(message.id, {
      ...(prev ?? message),
      ...message,
      replyingAgentId: message.replyingAgentId ?? prev?.replyingAgentId ?? null,
      chatTurnId: message.chatTurnId ?? prev?.chatTurnId ?? null,
      turnVariant: message.turnVariant ?? prev?.turnVariant ?? 0,
      supersededAt: message.supersededAt ?? prev?.supersededAt ?? null,
    });
  }
  return Array.from(merged.values())
    .map((message) => ({
      ...message,
      replyingAgentId: message.replyingAgentId ?? null,
      chatTurnId: message.chatTurnId ?? null,
      turnVariant: message.turnVariant ?? 0,
      supersededAt: message.supersededAt ?? null,
    }))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

export function scrollChatMessagesToBottom(element: Pick<HTMLElement, "scrollHeight" | "scrollTo">) {
  element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
}

export function computeDisplayedChatMessages(
  all: ChatMessage[],
  branchPreview: ChatBranchPreview | null,
): ChatMessage[] {
  const sorted = [...all].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  if (!branchPreview) {
    return sorted.filter((m) => !m.supersededAt);
  }
  const { chatTurnId: tid, turnVariant: v } = branchPreview;
  const turnSlice = sorted.filter((m) => m.chatTurnId === tid && m.turnVariant === v);
  if (turnSlice.length === 0) {
    return sorted.filter((m) => !m.supersededAt);
  }
  const outsideTurn = sorted.filter((m) => !m.supersededAt && m.chatTurnId !== tid);
  const mid = [...turnSlice].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  return [...outsideTurn, ...mid].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

export function mergeChatConversationsForStatus(
  current: ChatConversation[],
  incoming: ChatConversation,
  status: "active" | "resolved" | "archived" | "all",
) {
  const withoutCurrent = current.filter((conversation) => conversation.id !== incoming.id);
  if (status !== "all" && incoming.status !== status) {
    return withoutCurrent;
  }
  return [incoming, ...withoutCurrent];
}

export function conversationPreview(conversation: ChatConversation, fallbackPreview?: string | null) {
  return formatMessengerPreview(fallbackPreview)
    || formatMessengerPreview(conversation.latestReplyPreview)
    || formatMessengerPreview(conversation.summary)
    || "Start the conversation";
}

export function conversationDisplayTitle(conversation: Pick<ChatConversation, "title" | "summary" | "latestUserMessagePreview" | "latestReplyPreview">) {
  return displayChatTitle(conversation);
}

function recentConversationDisplayTitle(conversation: Pick<ChatConversation, "title" | "summary" | "latestUserMessagePreview">) {
  if (isDefaultChatTitle(conversation.title)) {
    return formatMessengerPreview(conversation.summary, { max: 80 })
      || formatMessengerPreview(conversation.latestUserMessagePreview, { max: 80 })
      || conversation.title;
  }

  return formatMessengerPreview(conversation.title, { max: 80 }) || conversation.title;
}

export function recentConversationPreview(
  conversation: Pick<ChatConversation, "summary" | "latestReplyPreview" | "latestUserMessagePreview" | "userMessageCount">,
) {
  if (conversation.userMessageCount > 1) {
    return formatMessengerPreview(conversation.latestUserMessagePreview)
      || formatMessengerPreview(conversation.summary)
      || "Start the conversation";
  }

  return formatMessengerPreview(conversation.latestReplyPreview)
    || formatMessengerPreview(conversation.summary)
    || "Start the conversation";
}

type ChatEmptyStateRecentConversationsProps = {
  conversations: ChatConversation[];
  projectName: string | null;
  visible: boolean;
  conversationPath: (id: string) => string;
  onPrefetchConversation: (id: string) => void;
  hasMoreConversations?: boolean;
  loadingMoreConversations?: boolean;
  onLoadMoreConversations?: () => void;
  className?: string;
};

export function ChatEmptyStateRecentConversations({
  conversations,
  projectName,
  visible,
  conversationPath,
  onPrefetchConversation,
  hasMoreConversations = false,
  loadingMoreConversations = false,
  onLoadMoreConversations,
  className,
}: ChatEmptyStateRecentConversationsProps) {
  const scrollbarActivityRef = useScrollbarActivityRef("rudder:chat-empty-state-recent-conversations");
  const scrollElementRef = useRef<HTMLDivElement | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const setScrollRef = useCallback((element: HTMLDivElement | null) => {
    scrollElementRef.current = element;
    scrollbarActivityRef(element);
  }, [scrollbarActivityRef]);

  useEffect(() => {
    if (!visible || !hasMoreConversations || loadingMoreConversations || !onLoadMoreConversations) return;
    const root = scrollElementRef.current;
    const sentinel = loadMoreSentinelRef.current;
    if (!root || !sentinel) return;
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      onLoadMoreConversations();
    }, { root, rootMargin: "96px 0px" });

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [conversations.length, hasMoreConversations, loadingMoreConversations, onLoadMoreConversations, visible]);

  if (conversations.length === 0) return null;

  return (
    <section
      data-testid="chat-empty-state-recent-project-conversations"
      data-state={visible ? "open" : "closed"}
      className={cn("motion-chat-empty-recent-conversations w-full max-w-3xl px-1 text-left", className)}
      aria-label="Recent project conversations"
      aria-hidden={!visible}
    >
      <div className="flex h-4 items-center justify-end gap-3">
        {projectName ? (
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{projectName}</span>
        ) : null}
      </div>
      <div
        ref={setScrollRef}
        className="scrollbar-auto-hide max-h-[min(34vh,360px)] overflow-y-auto border-y border-[color:var(--border-soft)]"
      >
        <div className="divide-y divide-[color:var(--border-soft)]">
          {conversations.map((conversation) => (
            <Link
              key={conversation.id}
              to={conversationPath(conversation.id)}
              data-testid={`chat-empty-state-recent-conversation-${conversation.id}`}
              tabIndex={visible ? undefined : -1}
              className="group flex min-w-0 items-center gap-3 px-1 py-2.5 text-sm transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-active)_58%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
              onPointerDown={() => {
                if (visible) onPrefetchConversation(conversation.id);
              }}
              onMouseEnter={() => {
                if (visible) onPrefetchConversation(conversation.id);
              }}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-foreground">{recentConversationDisplayTitle(conversation)}</span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">{recentConversationPreview(conversation)}</span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(conversation.lastMessageAt ?? conversation.updatedAt)}</span>
            </Link>
          ))}
        </div>
        {hasMoreConversations || loadingMoreConversations ? (
          <div
            ref={loadMoreSentinelRef}
            data-testid="chat-empty-state-recent-conversations-load-more"
            className="flex min-h-9 items-center justify-center px-2 py-2 text-[11px] text-muted-foreground"
          >
            {loadingMoreConversations ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                Loading
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function buildMessengerChatThreadSummary(
  conversation: ChatConversation,
  options?: {
    latestActivityAt?: Date;
    preview?: string | null;
  },
): MessengerThreadSummary {
  const preview = conversationPreview(conversation, options?.preview);
  return {
    threadKey: `chat:${conversation.id}`,
    kind: "chat",
    title: conversationDisplayTitle(conversation),
    subtitle: preview,
    preview,
    latestActivityAt: options?.latestActivityAt ?? conversation.lastMessageAt ?? conversation.updatedAt,
    lastReadAt: conversation.lastReadAt,
    unreadCount: conversation.unreadCount,
    needsAttention: conversation.needsAttention,
    isPinned: conversation.isPinned,
    href: `/messenger/chat/${conversation.id}`,
    metadata: {
      preferredAgentId: conversation.preferredAgentId,
      routedAgentId: conversation.routedAgentId,
      runtimeAgentId: conversation.chatRuntime.runtimeAgentId,
    },
  };
}

export function mergeMessengerThreadSummaries(current: MessengerThreadSummary[], incoming: MessengerThreadSummary) {
  const withoutCurrent = current.filter((thread) => thread.threadKey !== incoming.threadKey);
  return [incoming, ...withoutCurrent].sort((a, b) => {
    const aPinned = Boolean(a.isPinned);
    const bPinned = Boolean(b.isPinned);
    if (aPinned !== bPinned) return aPinned ? -1 : 1;
    const aTime = a.latestActivityAt ? new Date(a.latestActivityAt).getTime() : Number.NEGATIVE_INFINITY;
    const bTime = b.latestActivityAt ? new Date(b.latestActivityAt).getTime() : Number.NEGATIVE_INFINITY;
    if (aTime !== bTime) return bTime - aTime;
    return a.title.localeCompare(b.title);
  });
}

export function withOptimisticOutgoingMessage(
  conversation: ChatConversation,
  body: string,
  sentAt: Date,
): ChatConversation {
  const preview = body.trim();
  if (!preview) return conversation;
  return {
    ...conversation,
    title: promoteDefaultChatTitle(conversation.title, preview),
    summary: conversation.summary ?? preview,
    lastMessageAt: sentAt,
    updatedAt: sentAt,
  };
}

export function withOptimisticPlanMode(conversation: ChatConversation, planMode: boolean): ChatConversation {
  if (conversation.planMode === planMode) return conversation;
  return {
    ...conversation,
    planMode,
    updatedAt: new Date(),
  };
}

export function isChatAgentSelectionLocked({
  hasConversation,
  preferredAgentId,
  hasLastMessageAt,
  hasMessages,
  hasActiveStream,
  hasActiveSendInFlight,
}: {
  hasConversation: boolean;
  preferredAgentId: string | null | undefined;
  hasLastMessageAt: boolean;
  hasMessages: boolean;
  hasActiveStream: boolean;
  hasActiveSendInFlight: boolean;
}) {
  return Boolean(
    hasConversation
    && (
      hasActiveStream
      || hasActiveSendInFlight
      || (preferredAgentId && (hasLastMessageAt || hasMessages))
    ),
  );
}

export function isChatProjectSelectionLocked({
  hasConversation,
  hasLastMessageAt,
  hasMessages,
  hasActiveStream,
  hasActiveSendInFlight,
}: {
  hasConversation: boolean;
  hasLastMessageAt: boolean;
  hasMessages: boolean;
  hasActiveStream: boolean;
  hasActiveSendInFlight: boolean;
}) {
  return Boolean(
    hasConversation
    && (
      hasActiveStream
      || hasActiveSendInFlight
      || hasLastMessageAt
      || hasMessages
    ),
  );
}

export function approvalNeedsAction(approval: Approval | null | undefined) {
  return approval?.status === "pending";
}

export function buildChatProposalRevisionPrompt(input: {
  proposalTitle?: string | null;
  feedback: string;
}) {
  const title = input.proposalTitle?.trim();
  return [
    title
      ? `Please revise the proposal "${title}" based on the feedback below.`
      : "Please revise the current proposal based on the feedback below.",
    "",
    "Return a new proposal for review. Do not create the issue or apply the change yet.",
    "",
    "Requested changes:",
    input.feedback.trim(),
  ].join("\n");
}

export function buildChatProposalRejectFeedbackPrompt(input: {
  proposalTitle?: string | null;
  feedback: string;
}) {
  const title = input.proposalTitle?.trim();
  return [
    title
      ? `I rejected the proposal "${title}".`
      : "I rejected the current proposal.",
    "",
    "Feedback:",
    input.feedback.trim(),
    "",
    "Continue from this feedback. Do not create the issue or apply the change unless I approve a new proposal.",
  ].join("\n");
}

export function issueProposalFromMessage(message: ChatMessage) {
  const payload = message.structuredPayload;
  if (!payload) return null;
  const proposal =
    payload.issueProposal && typeof payload.issueProposal === "object" && !Array.isArray(payload.issueProposal)
      ? (payload.issueProposal as Record<string, unknown>)
      : payload;
  if (typeof proposal.title !== "string" || typeof proposal.description !== "string") {
    return null;
  }
  return proposal;
}

export function issueProposalPrincipalLabel(
  proposal: Record<string, unknown>,
  role: "assignee" | "reviewer",
  agents: Agent[] | undefined,
) {
  const agentIdKey = role === "assignee" ? "assigneeAgentId" : "reviewerAgentId";
  const userIdKey = role === "assignee" ? "assigneeUserId" : "reviewerUserId";
  const agentId = typeof proposal[agentIdKey] === "string" ? proposal[agentIdKey].trim() : "";
  if (agentId) {
    return agents?.find((agent) => agent.id === agentId)?.name ?? (role === "assignee" ? "Unknown agent" : "Unknown reviewer");
  }
  const userId = typeof proposal[userIdKey] === "string" ? proposal[userIdKey].trim() : "";
  if (userId) {
    return formatAssigneeUserLabel(userId, null) ?? (role === "assignee" ? "Human assignee" : "Human reviewer");
  }
  return null;
}

export function operationProposalFromMessage(message: ChatMessage) {
  const payload = message.structuredPayload;
  if (!payload) return null;
  const proposal =
    payload.operationProposal && typeof payload.operationProposal === "object" && !Array.isArray(payload.operationProposal)
      ? (payload.operationProposal as Record<string, unknown>)
      : payload;
  if (
    typeof proposal.targetType !== "string" ||
    typeof proposal.targetId !== "string" ||
    typeof proposal.summary !== "string"
  ) {
    return null;
  }
  return proposal;
}

export function operationProposalStatusFromMessage(message: ChatMessage): ChatOperationProposalDecisionStatus {
  const rawState =
    message.structuredPayload?.operationProposalState
    && typeof message.structuredPayload.operationProposalState === "object"
    && !Array.isArray(message.structuredPayload.operationProposalState)
      ? (message.structuredPayload.operationProposalState as Record<string, unknown>)
      : null;

  const status = typeof rawState?.status === "string"
    ? rawState.status
    : "pending";

  if (
    status === "approved"
    || status === "rejected"
    || status === "revision_requested"
    || status === "pending"
  ) {
    return status;
  }
  return "pending";
}

export function operationProposalDecisionNoteFromMessage(message: ChatMessage) {
  const rawState =
    message.structuredPayload?.operationProposalState
    && typeof message.structuredPayload.operationProposalState === "object"
    && !Array.isArray(message.structuredPayload.operationProposalState)
      ? (message.structuredPayload.operationProposalState as Record<string, unknown>)
      : null;
  const note = typeof rawState?.decisionNote === "string" ? rawState.decisionNote.trim() : "";
  return note || null;
}

export function proposalReviewStatus(message: ChatMessage): "pending" | "approved" | "rejected" | "revision_requested" | null {
  if (message.approval) {
    const { status } = message.approval;
    if (
      status === "pending"
      || status === "approved"
      || status === "rejected"
      || status === "revision_requested"
    ) {
      return status;
    }
  }
  if (message.kind === "operation_proposal") {
    return operationProposalStatusFromMessage(message);
  }
  return null;
}


export function proposalReviewBannerCopy(status: "pending" | "approved" | "rejected" | "revision_requested" | null) {
  if (status === "approved") {
    return "Approved. This proposal has been accepted.";
  }
  if (status === "rejected") {
    return "Rejected. This proposal will not move forward.";
  }
  if (status === "revision_requested") {
    return "Changes requested. Keep review context here until the proposal is updated.";
  }
  if (status === "pending") {
    return "Review this proposal here before continuing the conversation.";
  }
  return null;
}

export function askUserRequestFromMessage(message: Pick<ChatMessage, "kind" | "structuredPayload">): ChatAskUserRequest | null {
  if (message.kind !== "ask_user") return null;
  return chatAskUserRequestFromStructuredPayload(message.structuredPayload);
}

export function isAskUserMessageAnswered(
  target: Pick<ChatMessage, "id" | "kind">,
  messages: Array<Pick<ChatMessage, "id" | "role" | "supersededAt">>,
) {
  if (target.kind !== "ask_user") return false;
  const targetIndex = messages.findIndex((message) => message.id === target.id);
  if (targetIndex < 0) return false;
  return messages.slice(targetIndex + 1).some((message) =>
    message.role === "user" && !message.supersededAt
  );
}

export function findLatestUnansweredAskUserMessage(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.kind !== "ask_user" || message.supersededAt) continue;
    if (!askUserRequestFromMessage(message)) continue;
    if (!messages.slice(index + 1).some((candidate) =>
      candidate.role === "user"
      && !candidate.supersededAt
    )) return message;
  }
  return null;
}

export function askUserQuestionTitle(question: ChatAskUserQuestion) {
  return question.header?.trim() || question.question;
}

export type AskUserAnswerRecord = Array<{
  questionId: string;
  title: string;
  answer: string;
}>;

export type AskUserAnswerValue =
  | { kind: "option"; label: string }
  | { kind: "options"; labels: string[] }
  | { kind: "freeform"; text: string };

export const ASK_USER_ANSWER_PREFIX = "Answering the requested input:";

export function formatAskUserAnswerLines(answer: string) {
  const [firstLine = "", ...continuationLines] = answer.replace(/\r\n/g, "\n").split("\n");
  return [
    `  Answer: ${firstLine}`,
    ...continuationLines.map((line) => `    ${line}`),
  ];
}

export function formatAskUserAnswerMessage(
  request: ChatAskUserRequest,
  answers: Record<string, AskUserAnswerValue>,
) {
  const lines = [ASK_USER_ANSWER_PREFIX];
  for (const question of request.questions) {
    const answer = answers[question.id];
    if (!answer) continue;
    const title = askUserQuestionTitle(question);
    const answerText = answer.kind === "freeform"
      ? answer.text
      : answer.kind === "options"
        ? answer.labels.join(", ")
        : answer.label;
    lines.push("");
    lines.push(`- ${title}`);
    lines.push(...formatAskUserAnswerLines(answerText));
  }
  return lines.join("\n");
}

export function parseAskUserAnswerMessage(
  request: ChatAskUserRequest,
  body: string,
): AskUserAnswerRecord | null {
  const lines = body.replace(/\r\n/g, "\n").trim().split("\n");
  if (lines[0]?.trim() !== ASK_USER_ANSWER_PREFIX) return null;

  const answers: AskUserAnswerRecord = [];
  const usedQuestionIds = new Set<string>();
  let currentTitle: string | null = null;
  let currentAnswerLines: string[] = [];

  const questionForTitle = (title: string) =>
    request.questions.find((candidate) =>
      !usedQuestionIds.has(candidate.id)
      && askUserQuestionTitle(candidate) === title
    );

  const flush = () => {
    if (!currentTitle) return;
    const answer = currentAnswerLines.join("\n").trim();
    if (!answer) {
      currentTitle = null;
      currentAnswerLines = [];
      return;
    }
    const question = questionForTitle(currentTitle);
    if (question) {
      usedQuestionIds.add(question.id);
      answers.push({
        questionId: question.id,
        title: askUserQuestionTitle(question),
        answer,
      });
    }
    currentTitle = null;
    currentAnswerLines = [];
  };

  for (const line of lines.slice(1)) {
    const titleMatch = /^-\s+(.+?)\s*$/.exec(line);
    if (titleMatch) {
      const nextTitle = titleMatch[1] ?? "";
      if (currentTitle && currentAnswerLines.length > 0 && !questionForTitle(nextTitle)) {
        currentAnswerLines.push(line);
        continue;
      }
      flush();
      currentTitle = nextTitle;
      currentAnswerLines = [];
      continue;
    }

    if (!currentTitle && line.trim().length === 0) continue;

    const answerMatch = /^\s+Answer:\s?(.*)$/.exec(line);
    if (answerMatch && currentTitle) {
      currentAnswerLines.push(answerMatch[1] ?? "");
      continue;
    }

    if (currentTitle && currentAnswerLines.length > 0) {
      currentAnswerLines.push(line.trimStart());
    }
  }
  flush();

  return answers.length > 0 ? answers : null;
}

export function askUserAnswerFromMessage(message: ChatMessage, messages: ChatMessage[]) {
  if (message.role !== "user" || message.kind !== "message" || message.supersededAt) return null;
  const targetIndex = messages.findIndex((candidate) => candidate.id === message.id);
  if (targetIndex < 0) return null;

  for (let index = targetIndex - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (!candidate || candidate.supersededAt) continue;
    if (candidate.role === "user") return null;
    const request = askUserRequestFromMessage(candidate);
    if (request) return parseAskUserAnswerMessage(request, message.body);
  }

  return null;
}


export function formatChatPrimaryIssueBreadcrumb(issue: ChatPrimaryIssueSummary): string {
  const idPart = issue.identifier?.trim() || null;
  const titlePart = issue.title?.trim() || null;
  if (idPart && titlePart) return `${idPart} · ${titlePart}`;
  return idPart ?? titlePart ?? issue.id;
}

export const INTERRUPTED_CHAT_CONTINUATION_PROMPT = "Continue from the interrupted chat run.";

export function canContinueInterruptedChatMessage(message: Pick<ChatMessage, "role" | "status">) {
  return message.role === "assistant" && message.status === "interrupted";
}

export function canRetryFailedChatMessage(message: Pick<ChatMessage, "role" | "kind" | "status" | "chatTurnId">) {
  return message.role === "assistant"
    && message.kind === "message"
    && message.status === "failed"
    && Boolean(message.chatTurnId);
}

export function recoverableFailureFromMessage(
  message: Pick<ChatMessage, "structuredPayload" | "runId">,
) {
  const payload = message.structuredPayload;
  const failure = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload.recoverableFailure
    : null;
  if (!failure || typeof failure !== "object" || Array.isArray(failure)) return null;
  const candidate = failure as Record<string, unknown>;
  const code = typeof candidate.code === "string" && candidate.code.trim()
    ? candidate.code.trim()
    : "chat_runtime_exception";
  const detailMessage = typeof candidate.message === "string" && candidate.message.trim()
    ? candidate.message.trim()
    : "The assistant reply could not be completed. Rudder saved this attempt for diagnostics; retry when ready.";
  const runId = typeof candidate.runId === "string" && candidate.runId.trim()
    ? candidate.runId.trim()
    : message.runId ?? null;
  return { code, message: detailMessage, runId };
}

export function findRetrySourceUserMessage(
  messages: ChatMessage[],
  failedMessage: Pick<ChatMessage, "chatTurnId" | "turnVariant">,
) {
  if (!failedMessage.chatTurnId) return null;
  return messages.find((message) =>
    message.role === "user"
    && message.kind === "message"
    && message.chatTurnId === failedMessage.chatTurnId
    && message.turnVariant === failedMessage.turnVariant
  ) ?? null;
}

export function isUserVisibleIncomingChatMessage(
  message: Pick<ChatMessage, "role" | "kind" | "body" | "approvalId" | "supersededAt">,
) {
  if (message.supersededAt) return false;
  if (message.role === "user") return false;
  return message.body.trim().length > 0 || message.kind !== "message" || Boolean(message.approvalId);
}

export function assistantStateLabel(state: ChatStreamDraftState | ChatMessage["status"]) {
  if (state === "streaming") return "Streaming";
  if (state === "finalizing") return "Finalizing";
  if (state === "stopped") return "Stopped";
  if (state === "failed") return "Failed";
  if (state === "interrupted") return "Interrupted";
  return null;
}

export function statusChipClassName(state: ChatStreamDraftState | ChatMessage["status"]) {
  if (state === "failed") return "border-destructive/30 bg-destructive/10 text-destructive";
  if (state === "interrupted") return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "chat-chip";
}
