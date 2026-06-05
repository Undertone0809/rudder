import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  Boxes,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Folder,
  ListChecks,
  Loader2,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Settings2,
  Square,
  Sparkles,
  X,
} from "lucide-react";
import {
  type Agent,
  type Approval,
  chatAskUserRequestFromStructuredPayload,
  type ChatAskUserQuestion,
  type ChatAskUserRequest,
  type ChatConversation,
  type ChatMessage,
  type ChatOperationProposalDecisionAction,
  type ChatOperationProposalDecisionStatus,
  type ChatPrimaryIssueSummary,
  type Issue,
  formatMessengerPreview,
  type MessengerThreadSummary,
  type Project,
} from "@rudderhq/shared";
import type { TranscriptEntry } from "@/agent-runtimes";
import { appendTranscriptEntry } from "@/agent-runtimes/transcript";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MarkdownBody, type MarkdownLinkClickHandler } from "@/components/MarkdownBody";
import { ChatRichReferences } from "@/components/chat-renderables/ChatRichReferences";
import { TextDots } from "@/components/TextDots";
import { formatPriorityLabel } from "@/lib/priorities";
import { ImagePreviewDialog } from "@/components/ImagePreviewDialog";
import type { MarkdownSkillReferencePreview } from "@/components/SkillReferenceToken";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "@/components/MarkdownEditor";
import { AgentIcon, getAgentAvatarImageSrc } from "@/components/AgentIconPicker";
import { HoverTimestampLabel } from "@/components/HoverTimestamp";
import { StatusBadge } from "@/components/StatusBadge";
import { RunTranscriptView } from "@/components/transcript/RunTranscriptView";
import { Skeleton } from "@/components/ui/skeleton";
import { useOrganization } from "@/context/OrganizationContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useSidebar } from "@/context/SidebarContext";
import { useToast } from "@/context/ToastContext";
import { useChatGenerations, type ChatStreamDraft, type ChatStreamDraftState } from "@/context/ChatGenerationContext";
import { agentsApi } from "@/api/agents";
import { approvalsApi } from "@/api/approvals";
import { ApiError } from "@/api/client";
import { chatsApi } from "@/api/chats";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { issuesApi } from "@/api/issues";
import { projectsApi } from "@/api/projects";
import { organizationSkillsApi } from "@/api/organizationSkills";
import { prefetchChatConversation } from "@/lib/chat-prefetch";
import { readChatDraft, saveChatDraft } from "@/lib/chat-draft-storage";
import {
  readChatPendingAttachmentsForScope,
  resolveChatPendingAttachmentScopeKey,
  updateChatPendingAttachmentsForScope,
} from "@/lib/chat-pending-attachments";
import {
  NO_CHAT_AGENT_ID,
  isSelectableChatAgentId,
  rememberChatAgentId,
  resolveDefaultChatAgentId,
  selectableChatAgents,
} from "@/lib/chat-agent-selection";
import { resolveRequestedPreferredAgentId } from "@/lib/chat-route-state";
import { buildChatSkillOptions, filterChatSkillOptions } from "@/lib/chat-skill-options";
import { displayChatTitle, promoteDefaultChatTitle } from "@/lib/chat-title";
import { formatChatAgentLabel } from "@/lib/agent-labels";
import { rememberMessengerPath } from "@/lib/messenger-memory";
import { projectColorCssVars } from "@/lib/project-colors";
import { queryKeys } from "@/lib/queryKeys";
import {
  formatChatProcessDuration,
  lastTranscriptAtMs,
  resolvePersistedChatProcessEndedAt,
  resolvePersistedChatProcessStartedAt,
} from "@/lib/chat-process-duration";
import {
  readChatScopedFlag,
  readChatScopedState,
  shouldShowMessageDuringActiveStream,
} from "@/lib/chat-stream-state";
import { toOrganizationRelativePath } from "@/lib/organization-routes";
import {
  appendSkillReferencesToDraft,
} from "@/lib/organization-skill-picker";
import { formatAssigneeUserLabel } from "@/lib/assignees";
import { readDesktopShell } from "@/lib/desktop-shell";
import {
  canShowImageInFolder,
  copyImage as copyImageAction,
  isImageContentType,
  showImageInFolder as showImageInFolderAction,
} from "@/lib/image-actions";
import { resolveLocalFileTarget } from "@/lib/local-file-targets";
import { cn, relativeTime } from "@/lib/utils";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import { useI18n } from "@/context/I18nContext";
export { ChatImageAttachmentTile, ChatFileAttachmentChip, PendingAttachmentPreview, ChatAttachmentList, ChatAttachmentPreviewDialog } from "./Chat.attachments";
export { ChatAssistantAttributionRow, ProposalCard, chatIssueApprovalPayloadWithProposalOverride, chatMessageHoverBarClass, ChatLongMessageBody, readStructuredPayloadString, issueCreatedSystemMessageParts, ChatSystemMessageBody, AskUserHistoryRecord, AskUserAnswerBubble, AskUserPanel, ChatMessageItem, OptimisticUserDraftItem, ChatMessagesLoadingState, LazyStreamTranscriptItem, StreamTranscriptItem, AssistantDraftItem } from "./Chat.messages";

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

export async function materializePendingAttachment(file: File, index: number) {
  const buffer = await file.arrayBuffer();
  const filename = file.name.trim() || `pasted-attachment-${index + 1}.${inferAttachmentExtension(file.type)}`;
  return new File([buffer], filename, {
    type: file.type,
    lastModified: file.lastModified || Date.now(),
  });
}

export function pendingAttachmentKey(file: File) {
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

export function conversationDisplayTitle(conversation: Pick<ChatConversation, "title" | "summary" | "latestReplyPreview">) {
  return displayChatTitle(conversation);
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

export function planDocumentFromMessage(message: ChatMessage) {
  const payload = message.structuredPayload;
  if (!payload) return null;
  const rawDocument =
    payload.planDocument && typeof payload.planDocument === "object" && !Array.isArray(payload.planDocument)
      ? (payload.planDocument as Record<string, unknown>)
      : payload.plan && typeof payload.plan === "object" && !Array.isArray(payload.plan)
        ? (payload.plan as Record<string, unknown>)
        : null;
  const body = typeof rawDocument?.body === "string" ? rawDocument.body.trim() : "";
  if (!body) return null;
  const title = typeof rawDocument?.title === "string" && rawDocument.title.trim().length > 0
    ? rawDocument.title.trim()
    : "Plan";
  return { title, body };
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
