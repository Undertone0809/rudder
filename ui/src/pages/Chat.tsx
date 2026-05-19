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

type ApprovalAction = "approve" | "reject" | "requestRevision";
type AttachmentPreviewState = {
  src: string;
  name: string;
};

type ChatImageContextMenuPosition = {
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

const NO_PROJECT_ID = "__none__";
const CHAT_LAST_PROJECT_STORAGE_KEY = "rudder.chatLastProjectByOrg";

type EmptyStatePromptLabel = (typeof EMPTY_STATE_PROMPT_GROUPS)[number]["label"];
type EmptyStatePromptGroup = (typeof EMPTY_STATE_PROMPT_GROUPS)[number];

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

function readRememberedChatProjectId(orgId: string): string | null | undefined {
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

function rememberChatProjectId(orgId: string, projectId: string | null) {
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

function projectContextId(conversation: ChatConversation | null | undefined) {
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

function issueAssigneeMentionLabel(
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

function projectDisplayName(project: Project | null | undefined) {
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

function projectContextSwatchStyle(color: string | null | undefined): CSSProperties {
  return projectColorCssVars(color);
}

const COMPOSER_MENU_VIEWPORT_PADDING = 12;
const COMPOSER_MENU_OFFSET = 10;
const COMPOSER_MENU_MIN_HEIGHT = 128;
const COMPOSER_MENU_MAX_HEIGHT = 360;
const COMPOSER_MENU_MIN_WIDTH = 320;

function composerMenuPositionForAnchor(anchor: HTMLElement): CSSProperties {
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

function inferAttachmentExtension(contentType: string) {
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

async function materializePendingAttachment(file: File, index: number) {
  const buffer = await file.arrayBuffer();
  const filename = file.name.trim() || `pasted-attachment-${index + 1}.${inferAttachmentExtension(file.type)}`;
  return new File([buffer], filename, {
    type: file.type,
    lastModified: file.lastModified || Date.now(),
  });
}

function pendingAttachmentKey(file: File) {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

function attachmentDisplayName(input: { originalFilename?: string | null; assetId?: string; name?: string }) {
  return input.originalFilename ?? input.name ?? input.assetId ?? "attachment";
}

function clampChatImageContextMenuPosition(left: number, top: number): ChatImageContextMenuPosition {
  if (typeof window === "undefined") return { left, top };
  return {
    left: Math.min(left, Math.max(8, window.innerWidth - 190)),
    top: Math.min(top, Math.max(8, window.innerHeight - 96)),
  };
}

function shouldHandlePlainChatLinkClick(event: Parameters<MarkdownLinkClickHandler>[0]["event"]) {
  return event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

function ChatImageAttachmentTile({
  src,
  name,
  onOpen,
  onRemove,
  testId,
}: {
  src: string;
  name: string;
  onOpen: () => void;
  onRemove?: () => void;
  testId?: string;
}) {
  const { pushToast } = useToast();
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState<ChatImageContextMenuPosition | null>(null);
  const canShowInFinder = canShowImageInFolder();

  useEffect(() => {
    if (!contextMenuPosition) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (contextMenuRef.current?.contains(event.target as Node)) return;
      setContextMenuPosition(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenuPosition(null);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenuPosition]);

  const openImageContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenuPosition(clampChatImageContextMenuPosition(event.clientX, event.clientY));
  };

  const copyImage = async () => {
    setContextMenuPosition(null);
    try {
      await copyImageAction(src, name);
      pushToast({ title: "Image copied", tone: "success" });
    } catch (error) {
      pushToast({
        title: "Copy Image failed",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    }
  };

  const showImageInFolder = async () => {
    setContextMenuPosition(null);
    if (!canShowInFinder) {
      pushToast({
        title: "Open in Finder unavailable",
        body: "Open in Finder is available in the desktop app.",
        tone: "error",
      });
      return;
    }

    try {
      await showImageInFolderAction(src, name);
    } catch (error) {
      pushToast({
        title: "Open in Finder failed",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    }
  };

  return (
    <div
      data-testid={testId}
      className="relative inline-flex max-w-full"
    >
      <button
        type="button"
        aria-label={`Open image preview: ${name}`}
        className="flex h-12 w-12 min-w-0 items-center justify-center overflow-hidden rounded-[calc(var(--radius-sm)+4px)] border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-active)_42%,transparent)] text-left transition-[border-color,box-shadow] hover:border-[color:var(--border-strong)] focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        onClick={onOpen}
        onContextMenu={openImageContextMenu}
      >
        <img
          src={src}
          alt={name}
          className="h-full w-full shrink-0 object-cover"
          onContextMenu={openImageContextMenu}
        />
      </button>
      {onRemove ? (
        <button
          type="button"
          className="absolute -right-1.5 -top-1.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] text-muted-foreground shadow-[var(--shadow-sm)] transition-colors hover:text-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
      {contextMenuPosition && typeof document !== "undefined" ? createPortal(
        <div
          ref={contextMenuRef}
          data-testid="chat-image-context-menu"
          role="menu"
          className="motion-chat-composer-menu-pop surface-overlay fixed z-50 min-w-[172px] rounded-[var(--radius-lg)] border p-1.5 text-foreground shadow-[var(--shadow-lg)]"
          style={contextMenuPosition}
        >
          <button
            type="button"
            role="menuitem"
            className="chat-composer-menu-row w-full disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canShowInFinder}
            onClick={showImageInFolder}
          >
            <Folder className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Open in Finder</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="chat-composer-menu-row w-full"
            onClick={copyImage}
          >
            <Copy className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Copy Image</span>
          </button>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

function ChatFileAttachmentChip({
  name,
  href,
  onRemove,
  onOpenFile,
}: {
  name: string;
  href?: string;
  onRemove?: () => void;
  onOpenFile?: (targetPath: string) => void;
}) {
  const content = (
    <>
      <Paperclip className="h-3 w-3 shrink-0" />
      <span className="truncate">{name}</span>
    </>
  );

  if (href) {
    const localTargetPath = resolveLocalFileTarget(href);
    if (localTargetPath && onOpenFile) {
      return (
        <button
          type="button"
          className="chat-chip inline-flex max-w-full items-center gap-2 rounded-[calc(var(--radius-sm)+2px)] px-3 py-1.5 text-xs transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground"
          onClick={() => onOpenFile(localTargetPath)}
        >
          {content}
        </button>
      );
    }

    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="chat-chip inline-flex max-w-full items-center gap-2 rounded-[calc(var(--radius-sm)+2px)] px-3 py-1.5 text-xs transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground"
      >
        {content}
      </a>
    );
  }

  return (
    <span className="chat-chip inline-flex max-w-full items-center gap-2 rounded-[calc(var(--radius-sm)+2px)] px-3 py-1.5 text-xs">
      {content}
      {onRemove ? (
        <button
          type="button"
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </span>
  );
}

function PendingAttachmentPreview({
  file,
  onOpenImage,
  onRemove,
}: {
  file: File;
  onOpenImage: (preview: AttachmentPreviewState) => void;
  onRemove: () => void;
}) {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const isImage = isImageContentType(file.type);
  const name = attachmentDisplayName(file);

  useEffect(() => {
    if (!isImage) {
      setPreviewSrc(null);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setPreviewSrc(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file, isImage]);

  if (isImage && previewSrc) {
    return (
      <ChatImageAttachmentTile
        src={previewSrc}
        name={name}
        onOpen={() => onOpenImage({ src: previewSrc, name })}
        onRemove={onRemove}
        testId="chat-pending-image-attachment"
      />
    );
  }

  return <ChatFileAttachmentChip name={name} onRemove={onRemove} />;
}

function ChatAttachmentList({
  attachments,
  onOpenImage,
  onOpenFile,
}: {
  attachments: ChatMessage["attachments"];
  onOpenImage: (preview: AttachmentPreviewState) => void;
  onOpenFile: (targetPath: string) => void;
}) {
  if (attachments.length === 0) return null;

  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {attachments.map((attachment) => {
        const name = attachmentDisplayName(attachment);
        if (isImageContentType(attachment.contentType)) {
          return (
            <ChatImageAttachmentTile
              key={attachment.id}
              src={attachment.contentPath}
              name={name}
              onOpen={() => onOpenImage({ src: attachment.contentPath, name })}
              testId="chat-image-attachment"
            />
          );
        }
        return (
          <ChatFileAttachmentChip
            key={attachment.id}
            name={name}
            href={attachment.contentPath}
            onOpenFile={onOpenFile}
          />
        );
      })}
    </div>
  );
}

function ChatAttachmentPreviewDialog({
  preview,
  onOpenChange,
}: {
  preview: AttachmentPreviewState | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <ImagePreviewDialog
      preview={preview ? { src: preview.src, name: preview.name, alt: preview.name } : null}
      onOpenChange={onOpenChange}
      testId="chat-image-preview-dialog"
      titleFallback="Attachment preview"
    />
  );
}

const NO_CHAT_AGENT_LABEL = "No agents available";
const PLAN_MODE_HELP_TEXT =
  "Read-only planning. The agent should investigate, produce a plan, and create an issue with that plan attached.";

type ChatBranchPreview = { chatTurnId: string; turnVariant: number };

function mergeChatMessages(current: ChatMessage[], incoming: ChatMessage[]) {
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

function mergeChatConversationsForStatus(
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

function conversationPreview(conversation: ChatConversation, fallbackPreview?: string | null) {
  return formatMessengerPreview(fallbackPreview)
    || formatMessengerPreview(conversation.latestReplyPreview)
    || formatMessengerPreview(conversation.summary)
    || "Start the conversation";
}

function conversationDisplayTitle(conversation: Pick<ChatConversation, "title" | "summary" | "latestReplyPreview">) {
  return displayChatTitle(conversation);
}

function buildMessengerChatThreadSummary(
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
  };
}

function mergeMessengerThreadSummaries(current: MessengerThreadSummary[], incoming: MessengerThreadSummary) {
  const withoutCurrent = current.filter((thread) => thread.threadKey !== incoming.threadKey);
  return [incoming, ...withoutCurrent].sort((a, b) => {
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

function approvalNeedsAction(approval: Approval | null | undefined) {
  return approval?.status === "pending" || approval?.status === "revision_requested";
}

function issueProposalFromMessage(message: ChatMessage) {
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

function issueProposalPrincipalLabel(
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

function planDocumentFromMessage(message: ChatMessage) {
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

function operationProposalFromMessage(message: ChatMessage) {
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

function operationProposalStatusFromMessage(message: ChatMessage): ChatOperationProposalDecisionStatus {
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

function proposalReviewStatus(message: ChatMessage): "pending" | "approved" | "rejected" | "revision_requested" | null {
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


function proposalReviewBannerCopy(status: "pending" | "approved" | "rejected" | "revision_requested" | null) {
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

function askUserQuestionTitle(question: ChatAskUserQuestion) {
  return question.header?.trim() || question.question;
}

type AskUserAnswerRecord = Array<{
  questionId: string;
  title: string;
  answer: string;
}>;

const ASK_USER_ANSWER_PREFIX = "Answering the requested input:";

function formatAskUserAnswerLines(answer: string) {
  const [firstLine = "", ...continuationLines] = answer.replace(/\r\n/g, "\n").split("\n");
  return [
    `  Answer: ${firstLine}`,
    ...continuationLines.map((line) => `    ${line}`),
  ];
}

export function formatAskUserAnswerMessage(
  request: ChatAskUserRequest,
  answers: Record<string, { kind: "option"; label: string } | { kind: "freeform"; text: string }>,
) {
  const lines = [ASK_USER_ANSWER_PREFIX];
  for (const question of request.questions) {
    const answer = answers[question.id];
    if (!answer) continue;
    const title = askUserQuestionTitle(question);
    lines.push("");
    lines.push(`- ${title}`);
    lines.push(...formatAskUserAnswerLines(answer.kind === "freeform" ? answer.text : answer.label));
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


function formatChatPrimaryIssueBreadcrumb(issue: ChatPrimaryIssueSummary): string {
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

function ChatAssistantAttributionRow({
  replyingAgentId,
  conversation,
  agents,
}: {
  replyingAgentId: string | null;
  conversation: ChatConversation;
  agents: Agent[] | undefined;
}) {
  const agent = replyingAgentId ? agents?.find((a) => a.id === replyingAgentId) : null;
  const fallbackLabel = replyingAgentId ? conversation.chatRuntime?.sourceLabel ?? "Unknown agent" : "Assistant";
  const label = agent?.name ?? fallbackLabel;
  const agentImageSrc = agent ? getAgentAvatarImageSrc(agent.icon) : null;

  return (
    <div className="mb-2 flex items-center gap-2.5">
      {agent && agentImageSrc ? (
        <AgentIcon icon={agent.icon} role={agent.role} className="h-8 w-8 shrink-0" />
      ) : (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted/90 text-foreground shadow-sm">
          {agent ? (
            <AgentIcon icon={agent.icon} role={agent.role} className="h-4 w-4" />
          ) : replyingAgentId ? (
            <Bot className="h-4 w-4 text-muted-foreground" />
          ) : (
            <Sparkles className="h-4 w-4 text-muted-foreground" />
          )}
        </span>
      )}
      <span className="text-sm font-semibold tracking-tight text-foreground">{label}</span>
    </div>
  );
}

export function ProposalCard({
  conversation,
  message,
  agents,
  decisionNote,
  onDecisionNoteChange,
  onApprovalAction,
  onResolveOperationProposal,
  onConvertToIssue,
  actionPending,
  skillReferences,
  onMarkdownLinkClick,
}: {
  conversation: ChatConversation;
  message: ChatMessage;
  agents: Agent[] | undefined;
  decisionNote: string;
  onDecisionNoteChange: (value: string) => void;
  onApprovalAction: (approvalId: string, action: ApprovalAction, messageId: string) => void;
  onResolveOperationProposal: (messageId: string, action: ChatOperationProposalDecisionAction, decisionNote: string) => void;
  onConvertToIssue: (message: ChatMessage) => void;
  actionPending: boolean;
  skillReferences: MarkdownSkillReferencePreview[];
  onMarkdownLinkClick?: MarkdownLinkClickHandler;
}) {
  const issueProposal = message.kind === "issue_proposal" ? issueProposalFromMessage(message) : null;
  const planDocument = message.kind === "issue_proposal" ? planDocumentFromMessage(message) : null;
  const operationProposal = message.kind === "operation_proposal" ? operationProposalFromMessage(message) : null;
  const operationProposalStatus = message.kind === "operation_proposal"
    ? operationProposalStatusFromMessage(message)
    : null;
  const showApprovalActions = approvalNeedsAction(message.approval);
  const showOperationActions =
    message.kind === "operation_proposal" && !message.approval && operationProposalStatus === "pending";
  const canConvertDirectly = message.kind === "issue_proposal" && !message.approval && !conversation.primaryIssue;
  const reviewStatus = proposalReviewStatus(message);
  const reviewBanner = proposalReviewBannerCopy(reviewStatus);
  const showDecisionNote = showApprovalActions || showOperationActions;
  const showRevisionAction = message.approval?.status === "pending";
  const decisionNoteId = `proposal-review-note-${message.id}`;
  const showReviewControls = showDecisionNote || canConvertDirectly || Boolean(message.approval?.decisionNote);
  const proposalAssigneeLabel = issueProposal ? issueProposalPrincipalLabel(issueProposal, "assignee", agents) : null;
  const proposalReviewerLabel = issueProposal ? issueProposalPrincipalLabel(issueProposal, "reviewer", agents) : null;

  return (
    <div className="text-foreground">
      <ChatAssistantAttributionRow
        replyingAgentId={message.replyingAgentId ?? null}
        conversation={conversation}
        agents={agents}
      />

      {message.body.trim().length > 0 ? (
        <ChatLongMessageBody
          body={message.body}
          skillReferences={skillReferences}
          onMarkdownLinkClick={onMarkdownLinkClick}
          className="mt-4 max-w-[72ch] text-[15px] leading-7 text-foreground"
        />
      ) : null}

      <div
        data-testid="proposal-review-block"
        data-status={reviewStatus ?? "default"}
        className="chat-review-block mt-4 rounded-[var(--radius-xl)] p-5 text-foreground transition-all duration-200"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {issueProposal ? (
              <>
                <div className="text-base font-medium text-foreground">{String(issueProposal.title)}</div>
                <div className="mt-1 text-xs font-medium text-muted-foreground">
                  Priority · {formatPriorityLabel(String(issueProposal.priority ?? "medium"))}
                </div>
                {proposalAssigneeLabel || proposalReviewerLabel ? (
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {proposalAssigneeLabel ? <span>Assignee · {proposalAssigneeLabel}</span> : null}
                    {proposalReviewerLabel ? <span>Reviewer · {proposalReviewerLabel}</span> : null}
                  </div>
                ) : null}
              </>
            ) : operationProposal ? (
              <>
                <div className="text-base font-medium text-foreground">{String(operationProposal.summary)}</div>
                <div className="mt-1 text-xs font-medium text-muted-foreground">
                  Target · {String(operationProposal.targetType)}:{String(operationProposal.targetId)}
                </div>
              </>
            ) : planDocument ? (
              <div className="text-base font-medium text-foreground">{planDocument.title}</div>
            ) : null}
            {reviewBanner ? (
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                {reviewBanner}
              </p>
            ) : null}
          </div>
          {reviewStatus ? (
            <div data-testid="proposal-review-status">
              <StatusBadge status={reviewStatus} />
            </div>
          ) : null}
        </div>

        {issueProposal ? (
          <div className="mt-4 border-t border-[color:var(--border-soft)] pt-4 text-sm leading-6 text-muted-foreground">
            <MarkdownBody skillReferences={skillReferences} onLinkClick={onMarkdownLinkClick}>
              {String(issueProposal.description)}
            </MarkdownBody>
          </div>
        ) : null}

        {planDocument ? (
          <div className="mt-4 border-t border-[color:var(--border-soft)] pt-4">
            {issueProposal ? (
              <div className="text-[11px] font-medium text-muted-foreground">{planDocument.title}</div>
            ) : null}
            <div className="mt-3 text-sm leading-6 text-foreground">
              <MarkdownBody skillReferences={skillReferences} onLinkClick={onMarkdownLinkClick}>
                {planDocument.body}
              </MarkdownBody>
            </div>
          </div>
        ) : null}

        {operationProposal?.patch && typeof operationProposal.patch === "object" ? (
          <pre className="mt-4 overflow-x-auto rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-shell)_88%,transparent)] p-3 text-xs text-muted-foreground">
            {JSON.stringify(operationProposal.patch, null, 2)}
          </pre>
        ) : null}

        {showReviewControls ? (
          <div className="mt-5 border-t border-[color:var(--border-soft)] pt-4">
            {showDecisionNote ? (
              <label className="block space-y-2">
                <span className="text-xs font-medium text-muted-foreground">Decision note</span>
                <Textarea
                  id={decisionNoteId}
                  data-testid="proposal-review-note"
                  value={decisionNote}
                  onChange={(event) => onDecisionNoteChange(event.target.value)}
                  placeholder={
                    reviewStatus === "revision_requested"
                      ? "Add context for what still needs to change."
                      : "Optional note for approval, rejection, or requested changes."
                  }
                  className="chat-field min-h-[88px] rounded-[var(--radius-lg)]"
                />
              </label>
            ) : null}

            {!showDecisionNote && message.approval?.decisionNote ? (
              <div className="chat-review-note mt-1 rounded-[var(--radius-lg)] px-4 py-3">
                <div className="text-[11px] font-medium text-muted-foreground">Decision note</div>
                <p className="mt-2 text-sm leading-6 text-foreground/90">{message.approval.decisionNote}</p>
              </div>
            ) : null}

            <div className="mt-4 flex flex-wrap gap-2">
              {showApprovalActions && message.approval ? (
                <>
                  <Button
                    size="sm"
                    className="bg-green-700 text-white hover:bg-green-600 dark:bg-green-600 dark:hover:bg-green-500"
                    disabled={actionPending}
                    onClick={() => onApprovalAction(message.approval!.id, "approve", message.id)}
                  >
                    Approve
                  </Button>
                  {showRevisionAction ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-foreground"
                      disabled={actionPending}
                      onClick={() => onApprovalAction(message.approval!.id, "requestRevision", message.id)}
                    >
                      Request revision
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-destructive/30 text-destructive hover:bg-destructive/10"
                    disabled={actionPending}
                    onClick={() => onApprovalAction(message.approval!.id, "reject", message.id)}
                  >
                    Reject
                  </Button>
                </>
              ) : null}
              {showOperationActions ? (
                <>
                  <Button
                    size="sm"
                    className="bg-green-700 text-white hover:bg-green-600 dark:bg-green-600 dark:hover:bg-green-500"
                    disabled={actionPending}
                    onClick={() => onResolveOperationProposal(message.id, "approve", decisionNote)}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-foreground"
                    disabled={actionPending}
                    onClick={() => onResolveOperationProposal(message.id, "requestRevision", decisionNote)}
                  >
                    Request changes
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-destructive/30 text-destructive hover:bg-destructive/10"
                    disabled={actionPending}
                    onClick={() => onResolveOperationProposal(message.id, "reject", decisionNote)}
                  >
                    Reject
                  </Button>
                </>
              ) : null}
              {canConvertDirectly ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-foreground"
                  disabled={actionPending}
                  onClick={() => onConvertToIssue(message)}
                >
                  Create issue
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const chatMessageHoverBarClass =
  "opacity-0 pointer-events-none transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100";
export function ChatLongMessageBody({
  body,
  skillReferences,
  onMarkdownLinkClick,
  className,
}: {
  body: string;
  skillReferences: MarkdownSkillReferencePreview[];
  onMarkdownLinkClick?: MarkdownLinkClickHandler;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <div data-testid="chat-long-message-body" className="min-w-0">
        <MarkdownBody skillReferences={skillReferences} onLinkClick={onMarkdownLinkClick}>
          {body}
        </MarkdownBody>
      </div>
    </div>
  );
}

function readStructuredPayloadString(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function issueCreatedSystemMessageParts(message: ChatMessage) {
  const payload = message.structuredPayload;
  if (!payload || payload.eventType !== "issue_created") return null;

  const issueId = readStructuredPayloadString(payload, "issueId");
  const issueIdentifier = readStructuredPayloadString(payload, "issueIdentifier");
  const issueRef = issueIdentifier ?? issueId;
  if (!issueRef) return null;

  const issueRefIndex = message.body.indexOf(issueRef);
  if (issueRefIndex < 0) return null;

  return {
    issueRef,
    prefix: message.body.slice(0, issueRefIndex),
    suffix: message.body.slice(issueRefIndex + issueRef.length),
  };
}

export function ChatSystemMessageBody({
  message,
  skillReferences,
  onMarkdownLinkClick,
}: {
  message: ChatMessage;
  skillReferences: MarkdownSkillReferencePreview[];
  onMarkdownLinkClick?: MarkdownLinkClickHandler;
}) {
  const issueCreatedParts = issueCreatedSystemMessageParts(message);

  if (issueCreatedParts) {
    return (
      <span className="min-w-0 flex-1 leading-5">
        {issueCreatedParts.prefix}
        <Link
          to={`/issues/${issueCreatedParts.issueRef}`}
          className="chat-system-issue-link"
          aria-label={`Open issue ${issueCreatedParts.issueRef}`}
        >
          {issueCreatedParts.issueRef}
        </Link>
        {issueCreatedParts.suffix}
      </span>
    );
  }

  return (
    <MarkdownBody skillReferences={skillReferences} onLinkClick={onMarkdownLinkClick}>
      {message.body}
    </MarkdownBody>
  );
}

function AskUserHistoryRecord({
  message,
  request,
  answered,
  conversation,
  agents,
  skillReferences,
  onMarkdownLinkClick,
}: {
  message: ChatMessage;
  request: ChatAskUserRequest;
  answered: boolean;
  conversation: ChatConversation;
  agents: Agent[] | undefined;
  skillReferences: MarkdownSkillReferencePreview[];
  onMarkdownLinkClick?: MarkdownLinkClickHandler;
}) {
  return (
    <div data-testid="chat-ask-user-history" className="flex justify-start transition-all duration-200">
      <div className="group w-full max-w-3xl px-1 py-1">
        <ChatAssistantAttributionRow
          replyingAgentId={message.replyingAgentId ?? null}
          conversation={conversation}
          agents={agents}
        />
        {message.body.trim().length > 0 ? (
          <ChatLongMessageBody
            body={message.body}
            skillReferences={skillReferences}
            onMarkdownLinkClick={onMarkdownLinkClick}
            className="max-w-[72ch] text-[15px] leading-7 text-foreground"
          />
        ) : null}
        <div className="mt-3 max-w-[72ch] rounded-lg border border-border bg-card px-3 py-2.5 text-sm shadow-[var(--shadow-sm)]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">
              {answered ? "Input requested" : "Input needed"}
            </span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
              {answered ? "Answered" : "Waiting"}
            </span>
          </div>
          <div className="mt-1.5 space-y-1 text-muted-foreground">
            {request.questions.map((question) => (
              <div key={question.id} className="truncate">
                {askUserQuestionTitle(question)}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function AskUserAnswerBubble({
  answer,
}: {
  answer: AskUserAnswerRecord;
}) {
  return (
    <div
      data-testid="chat-ask-user-answer"
      className="chat-message-user w-fit max-w-[min(100%,72ch)] rounded-[var(--radius-xl)] px-4 py-3 shadow-[var(--shadow-sm)]"
      aria-label="Answered requested input"
    >
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <CheckCircle2 className="h-4 w-4 text-[color:var(--accent-strong)]" aria-hidden />
        <span>Answered</span>
      </div>
      <div className="mt-2 space-y-2">
        {answer.map((entry) => (
          <div key={entry.questionId} className="min-w-0">
            <div className="text-xs font-medium text-muted-foreground">{entry.title}</div>
            <div className="mt-0.5 whitespace-pre-wrap text-[15px] leading-6 text-foreground">
              {entry.answer}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AskUserPanel({
  message,
  request,
  disabled,
  onSubmit,
}: {
  message: ChatMessage;
  request: ChatAskUserRequest;
  disabled: boolean;
  onSubmit: (body: string) => void;
}) {
  const [selectedByQuestionId, setSelectedByQuestionId] = useState<Record<string, string>>({});
  const [freeformByQuestionId, setFreeformByQuestionId] = useState<Record<string, string>>({});
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [reviewingAnswers, setReviewingAnswers] = useState(false);

  useEffect(() => {
    setSelectedByQuestionId({});
    setFreeformByQuestionId({});
    setCurrentQuestionIndex(0);
    setReviewingAnswers(false);
  }, [message.id]);

  const answers = useMemo(() => {
    const next: Record<string, { kind: "option"; label: string } | { kind: "freeform"; text: string }> = {};
    for (const question of request.questions) {
      const selected = selectedByQuestionId[question.id] ?? "";
      if (selected === "__other") {
        const text = freeformByQuestionId[question.id]?.trim() ?? "";
        if (text) next[question.id] = { kind: "freeform", text };
        continue;
      }
      const option = question.options.find((entry) => entry.id === selected);
      if (option) {
        next[question.id] = { kind: "option", label: option.label };
      }
    }
    return next;
  }, [freeformByQuestionId, request.questions, selectedByQuestionId]);

  const questionCount = request.questions.length;
  const hasMultipleQuestions = questionCount > 1;
  const boundedQuestionIndex = Math.min(currentQuestionIndex, Math.max(questionCount - 1, 0));
  const currentQuestion = request.questions[boundedQuestionIndex] ?? null;
  const currentAnswer = currentQuestion ? answers[currentQuestion.id] : null;
  const canSubmit = request.questions.every((question) => Boolean(answers[question.id]));

  const moveToNextQuestion = (fromIndex: number) => {
    if (!hasMultipleQuestions) return;
    if (fromIndex < questionCount - 1) {
      setCurrentQuestionIndex(fromIndex + 1);
      setReviewingAnswers(false);
      return;
    }
    setReviewingAnswers(true);
  };

  const selectOption = (question: ChatAskUserQuestion, index: number, optionId: string) => {
    setSelectedByQuestionId((current) => ({ ...current, [question.id]: optionId }));
    if (optionId !== "__other") {
      moveToNextQuestion(index);
    }
  };

  return (
    <div
      data-testid="chat-ask-user-panel"
      className="rounded-[var(--radius-lg)] border border-[color:color-mix(in_oklab,var(--accent-base)_35%,var(--border))] bg-[color:color-mix(in_oklab,var(--accent-soft)_28%,var(--surface-elevated))] p-3 shadow-[var(--shadow-sm)]"
    >
      {hasMultipleQuestions ? (
        <div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>{reviewingAnswers ? "Review answers" : `Question ${boundedQuestionIndex + 1} of ${questionCount}`}</span>
          <span>{Object.keys(answers).length}/{questionCount} answered</span>
        </div>
      ) : null}

      {reviewingAnswers ? (
        <section className="rounded-[var(--radius-md)] border border-border bg-card/85 p-3">
          <div className="text-sm font-medium text-foreground">Review answers</div>
          <div className="mt-2 space-y-2">
            {request.questions.map((question, index) => {
              const answer = answers[question.id];
              return (
                <button
                  key={question.id}
                  type="button"
                  className="flex w-full min-w-0 items-start justify-between gap-3 rounded-[var(--radius-md)] px-2 py-1.5 text-left text-sm hover:bg-[color:var(--surface-active)]"
                  onClick={() => {
                    setCurrentQuestionIndex(index);
                    setReviewingAnswers(false);
                  }}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-foreground">{askUserQuestionTitle(question)}</span>
                    <span className="mt-0.5 block whitespace-pre-wrap break-words text-muted-foreground">
                      {answer?.kind === "freeform" ? answer.text : answer?.label ?? "Not answered"}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">Edit</span>
                </button>
              );
            })}
          </div>
        </section>
      ) : currentQuestion ? (
        <section
          key={currentQuestion.id}
          className="rounded-[var(--radius-md)] border border-border bg-card/85 p-3"
        >
          <div className="text-sm font-medium text-foreground">
            {askUserQuestionTitle(currentQuestion)}
          </div>
          {currentQuestion.header && currentQuestion.header !== currentQuestion.question ? (
            <div className="mt-1 text-xs text-muted-foreground">{currentQuestion.question}</div>
          ) : null}
          <div className="mt-2 grid gap-1.5">
            {currentQuestion.options.map((option) => {
              const selected = selectedByQuestionId[currentQuestion.id] ?? "";
              const active = selected === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  className={cn(
                    "flex w-full items-start gap-2 rounded-[var(--radius-md)] border px-3 py-2 text-left text-sm transition-colors",
                    active
                      ? "border-[color:var(--accent-base)] bg-[color:color-mix(in_oklab,var(--accent-soft)_62%,transparent)] text-foreground"
                      : "border-border bg-background/70 text-foreground hover:bg-[color:var(--surface-active)]",
                  )}
                  aria-pressed={active}
                  onClick={() => selectOption(currentQuestion, boundedQuestionIndex, option.id)}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                      active ? "border-[color:var(--accent-base)] bg-[color:var(--accent-base)] text-primary-foreground" : "border-border",
                    )}
                    aria-hidden
                  >
                    {active ? <CheckCircle2 className="h-3 w-3" /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="font-medium">{option.label}</span>
                      {option.recommended ? (
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          Recommended
                        </span>
                      ) : null}
                    </span>
                    {option.description ? (
                      <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
            {currentQuestion.allowFreeform !== false ? (
              <button
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 rounded-[var(--radius-md)] border px-3 py-2 text-left text-sm transition-colors",
                  selectedByQuestionId[currentQuestion.id] === "__other"
                    ? "border-[color:var(--accent-base)] bg-[color:color-mix(in_oklab,var(--accent-soft)_62%,transparent)]"
                    : "border-border bg-background/70 hover:bg-[color:var(--surface-active)]",
                )}
                aria-pressed={selectedByQuestionId[currentQuestion.id] === "__other"}
                onClick={() => selectOption(currentQuestion, boundedQuestionIndex, "__other")}
              >
                <span
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                    selectedByQuestionId[currentQuestion.id] === "__other" ? "border-[color:var(--accent-base)] bg-[color:var(--accent-base)] text-primary-foreground" : "border-border",
                  )}
                  aria-hidden
                >
                  {selectedByQuestionId[currentQuestion.id] === "__other" ? <CheckCircle2 className="h-3 w-3" /> : null}
                </span>
                <span className="font-medium text-foreground">Other</span>
              </button>
            ) : null}
          </div>
          {selectedByQuestionId[currentQuestion.id] === "__other" ? (
            <Textarea
              value={freeformByQuestionId[currentQuestion.id] ?? ""}
              onChange={(event) => setFreeformByQuestionId((current) => ({
                ...current,
                [currentQuestion.id]: event.target.value,
              }))}
              placeholder="Type your answer..."
              className="mt-2 min-h-20 resize-y rounded-[var(--radius-md)] bg-background text-sm"
            />
          ) : null}
        </section>
      ) : null}

      <div className="mt-3 flex items-center justify-between gap-2">
        {hasMultipleQuestions ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || (!reviewingAnswers && boundedQuestionIndex === 0)}
            onClick={() => {
              if (reviewingAnswers) {
                setCurrentQuestionIndex(questionCount - 1);
                setReviewingAnswers(false);
                return;
              }
              setCurrentQuestionIndex((index) => Math.max(index - 1, 0));
            }}
          >
            Back
          </Button>
        ) : (
          <span aria-hidden />
        )}
        {hasMultipleQuestions && !reviewingAnswers ? (
          <Button
            type="button"
            size="sm"
            disabled={disabled || !currentAnswer}
            onClick={() => moveToNextQuestion(boundedQuestionIndex)}
          >
            {boundedQuestionIndex === questionCount - 1 ? "Review answers" : "Next"}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            disabled={disabled || !canSubmit}
            onClick={() => onSubmit(formatAskUserAnswerMessage(request, answers))}
          >
            Submit answer
          </Button>
        )}
      </div>
    </div>
  );
}

function ChatMessageItem({
  conversation,
  message,
  agents,
  decisionNote,
  onDecisionNoteChange,
  onApprovalAction,
  onResolveOperationProposal,
  onConvertToIssue,
  actionPending,
  onCopyMessageText,
  onEditUserMessage,
  onContinueInterruptedMessage,
  onRetryFailedMessage,
  onOpenImage,
  onOpenFile,
  onMarkdownLinkClick,
  turnBranchControls,
  skillReferences,
  answered,
  askUserAnswer,
}: {
  conversation: ChatConversation;
  message: ChatMessage;
  agents: Agent[] | undefined;
  decisionNote: string;
  onDecisionNoteChange: (value: string) => void;
  onApprovalAction: (approvalId: string, action: ApprovalAction, messageId: string) => void;
  onResolveOperationProposal: (messageId: string, action: ChatOperationProposalDecisionAction, decisionNote: string) => void;
  onConvertToIssue: (message: ChatMessage) => void;
  actionPending: boolean;
  onCopyMessageText: (text: string) => void | Promise<void>;
  onEditUserMessage: (message: ChatMessage) => void;
  onContinueInterruptedMessage: (message: ChatMessage) => void;
  onRetryFailedMessage: (message: ChatMessage) => void;
  onOpenImage: (preview: AttachmentPreviewState) => void;
  onOpenFile: (targetPath: string) => void;
  onMarkdownLinkClick?: MarkdownLinkClickHandler;
  skillReferences: MarkdownSkillReferencePreview[];
  answered?: boolean;
  askUserAnswer?: AskUserAnswerRecord | null;
  turnBranchControls?: {
    current: number;
    total: number;
    canPrev: boolean;
    canNext: boolean;
    onPrev: () => void;
    onNext: () => void;
  } | null;
}) {
  if (message.kind === "issue_proposal" || message.kind === "operation_proposal") {
    return (
      <ProposalCard
        conversation={conversation}
        message={message}
        agents={agents}
        decisionNote={decisionNote}
        onDecisionNoteChange={onDecisionNoteChange}
        onApprovalAction={onApprovalAction}
        onResolveOperationProposal={onResolveOperationProposal}
        onConvertToIssue={onConvertToIssue}
        actionPending={actionPending}
        skillReferences={skillReferences}
        onMarkdownLinkClick={onMarkdownLinkClick}
      />
    );
  }

  const askUserRequest = askUserRequestFromMessage(message);
  if (askUserRequest) {
    return (
      <AskUserHistoryRecord
        message={message}
        request={askUserRequest}
        answered={answered ?? false}
        conversation={conversation}
        agents={agents}
        skillReferences={skillReferences}
        onMarkdownLinkClick={onMarkdownLinkClick}
      />
    );
  }

  if (message.role === "system") {
    return (
      <div className="chat-system-pill rounded-[calc(var(--radius-sm)+2px)] px-4 py-2 text-sm transition-all duration-200">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-[color:var(--accent-strong)]" />
          <ChatSystemMessageBody
            message={message}
            skillReferences={skillReferences}
            onMarkdownLinkClick={onMarkdownLinkClick}
          />
        </div>
      </div>
    );
  }

  const isUser = message.role === "user";
  const statusLabel = !isUser ? assistantStateLabel(message.status) : null;
  const canContinueInterrupted = canContinueInterruptedChatMessage(message);
  const canRetryFailed = canRetryFailedChatMessage(message);

  if (!isUser) {
    return (
      <div data-testid="chat-assistant-message" className="flex justify-start transition-all duration-200">
        <div className="group w-full max-w-3xl px-1 py-1">
          <ChatAssistantAttributionRow
            replyingAgentId={message.replyingAgentId ?? null}
            conversation={conversation}
            agents={agents}
          />
          {statusLabel ? (
            <div className="mb-2 flex items-center gap-2">
              <span className={cn("rounded-full px-2 py-0.5 text-[10px]", statusChipClassName(message.status))}>
                {statusLabel}
              </span>
              {canContinueInterrupted ? (
                <button
                  type="button"
                  className="inline-flex h-7 items-center rounded-md border border-amber-500/30 bg-amber-500/10 px-2 text-xs font-medium text-amber-700 transition-[background-color,border-color,color,box-shadow] hover:border-amber-500/70 hover:bg-amber-500/25 hover:text-amber-950 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/35 dark:text-amber-300 dark:hover:text-amber-100"
                  onClick={() => onContinueInterruptedMessage(message)}
                >
                  Continue
                </button>
              ) : null}
              {canRetryFailed ? (
                <button
                  type="button"
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-2 text-xs font-medium text-destructive transition-colors hover:bg-destructive/15"
                  onClick={() => onRetryFailedMessage(message)}
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}
          <ChatLongMessageBody
            body={message.body}
            skillReferences={skillReferences}
            onMarkdownLinkClick={onMarkdownLinkClick}
            className="max-w-[72ch] text-[15px] leading-7 text-foreground"
          />
          <ChatRichReferences message={message} />
          <ChatAttachmentList
            attachments={message.attachments}
            onOpenImage={onOpenImage}
            onOpenFile={onOpenFile}
          />
          <div
            className={cn(
              "mt-2 flex h-7 items-center gap-1 text-muted-foreground",
              chatMessageHoverBarClass,
            )}
          >
            <HoverTimestampLabel
              date={message.createdAt}
              label={relativeTime(message.createdAt)}
              className="text-[11px] tracking-normal"
            />
            <button
              type="button"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-[color:var(--surface-active)] hover:text-foreground"
              aria-label="Copy message"
              onClick={() => void onCopyMessageText(message.body)}
            >
              <Copy className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-end transition-all duration-200">
      <div className="group flex max-w-[82%] flex-col items-end text-left">
        {askUserAnswer ? (
          <AskUserAnswerBubble answer={askUserAnswer} />
        ) : (
          <div
            data-testid="chat-user-message-bubble"
            className="chat-message-user w-fit max-w-[min(100%,72ch)] rounded-[var(--radius-xl)] px-4 py-3 shadow-[var(--shadow-sm)]"
          >
            <ChatLongMessageBody
              body={message.body}
              skillReferences={skillReferences}
              onMarkdownLinkClick={onMarkdownLinkClick}
              className="text-[15px] leading-7"
            />
            <ChatAttachmentList
              attachments={message.attachments}
              onOpenImage={onOpenImage}
              onOpenFile={onOpenFile}
            />
          </div>
        )}
        {askUserAnswer && message.attachments.length > 0 ? (
          <ChatAttachmentList
            attachments={message.attachments}
            onOpenImage={onOpenImage}
            onOpenFile={onOpenFile}
          />
        ) : null}
        <div
          data-testid="chat-user-message-toolbar"
          className={cn(
            "mt-1 flex h-7 items-center justify-end gap-1 text-muted-foreground",
            chatMessageHoverBarClass,
          )}
        >
          <button
            type="button"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-[color:var(--surface-active)] hover:text-foreground"
            aria-label="Copy message"
            onClick={() => void onCopyMessageText(message.body)}
          >
            <Copy className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-[color:var(--surface-active)] hover:text-foreground"
            aria-label="Edit message in composer"
            onClick={() => onEditUserMessage(message)}
          >
            <Pencil className="h-4 w-4" />
          </button>
          {turnBranchControls ? (
            <span className="inline-flex items-center gap-0.5 rounded-md px-0.5 text-[11px] tabular-nums text-muted-foreground">
            <button
              type="button"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-[color:var(--surface-active)] hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
              aria-label="Previous branch"
                disabled={!turnBranchControls.canPrev}
                onClick={turnBranchControls.onPrev}
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="min-w-[2.25rem] text-center">
                {turnBranchControls.current}/{turnBranchControls.total}
              </span>
              <button
                type="button"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-[color:var(--surface-active)] hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                aria-label="Next branch"
                disabled={!turnBranchControls.canNext}
                onClick={turnBranchControls.onNext}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </span>
          ) : null}
          <HoverTimestampLabel
            date={message.createdAt}
            label={relativeTime(message.createdAt)}
            className="px-1 text-[11px] tracking-normal"
          />
        </div>
      </div>
    </div>
  );
}

function OptimisticUserDraftItem({
  body,
  createdAt,
  onCopyMessageText,
  onEditDraftOnly,
  skillReferences,
  onMarkdownLinkClick,
  askUserAnswer,
}: {
  body: string;
  createdAt: Date;
  onCopyMessageText: (text: string) => void | Promise<void>;
  onEditDraftOnly: (text: string) => void;
  skillReferences: MarkdownSkillReferencePreview[];
  onMarkdownLinkClick?: MarkdownLinkClickHandler;
  askUserAnswer?: AskUserAnswerRecord | null;
}) {
  return (
    <div className="flex justify-end transition-all duration-200">
      <div className="group flex max-w-[82%] flex-col items-end text-left">
        {askUserAnswer ? (
          <AskUserAnswerBubble answer={askUserAnswer} />
        ) : (
          <div className="chat-message-user w-fit max-w-[min(100%,72ch)] rounded-[var(--radius-xl)] px-4 py-3 shadow-[var(--shadow-sm)]">
            <ChatLongMessageBody
              body={body}
              skillReferences={skillReferences}
              onMarkdownLinkClick={onMarkdownLinkClick}
              className="text-[15px] leading-7"
            />
          </div>
        )}
        <div
          className={cn(
            "mt-1 flex h-7 items-center justify-end gap-1 text-muted-foreground",
            chatMessageHoverBarClass,
          )}
        >
          <button
            type="button"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-[color:var(--surface-active)] hover:text-foreground"
            aria-label="Copy message"
            onClick={() => void onCopyMessageText(body)}
          >
            <Copy className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-[color:var(--surface-active)] hover:text-foreground"
            aria-label="Edit message in composer"
            onClick={() => onEditDraftOnly(body)}
          >
            <Pencil className="h-4 w-4" />
          </button>
          <HoverTimestampLabel
            date={createdAt}
            label={relativeTime(createdAt)}
            className="px-1 text-[11px] tracking-normal"
          />
        </div>
      </div>
    </div>
  );
}

function ChatMessagesLoadingState() {
  return (
    <div className="flex flex-col gap-5 pb-2">
      <div className="flex justify-end">
        <div className="chat-message-user w-fit max-w-[min(100%,72ch)] rounded-[var(--radius-xl)] px-4 py-3 shadow-[var(--shadow-sm)]">
          <div className="space-y-2">
            <Skeleton className="ml-auto h-4 w-[18rem]" />
            <Skeleton className="ml-auto h-4 w-[13rem]" />
          </div>
        </div>
      </div>
      <div className="flex justify-start">
        <div className="w-full max-w-3xl rounded-[var(--radius-xl)] px-1 py-4">
          <div className="space-y-2">
            <Skeleton className="h-4 w-[92%]" />
            <Skeleton className="h-4 w-[84%]" />
            <Skeleton className="h-4 w-[76%]" />
          </div>
        </div>
      </div>
    </div>
  );
}

function StreamTranscriptItem({
  entries,
  state,
  streamStartedAt,
  streamEndedAt,
  assistantMessageBody,
  showDeveloperDiagnostics,
  defaultOpen = false,
  onOpenChange,
}: {
  entries: TranscriptEntry[];
  state: ChatStreamDraftState | ChatMessage["status"];
  streamStartedAt: Date;
  streamEndedAt?: Date | null;
  assistantMessageBody?: string | null;
  showDeveloperDiagnostics?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const streamingActive = state === "streaming" || state === "finalizing";
  const [processOpen, setProcessOpen] = useState(() => streamingActive || defaultOpen);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!streamingActive) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [streamingActive]);

  useEffect(() => {
    if (defaultOpen) setProcessOpen(true);
  }, [defaultOpen]);

  const durationMs = useMemo(() => {
    const start = streamStartedAt.getTime();
    const explicitEnd = streamEndedAt?.getTime() ?? 0;
    const end = streamingActive ? Date.now() : Math.max(lastTranscriptAtMs(entries), explicitEnd);
    return Math.max(0, end - start);
  }, [streamStartedAt, streamEndedAt, streamingActive, entries, tick]);

  if (entries.length === 0) return null;

  const statusHint =
    state === "failed"
      ? "Stopped with errors"
      : state === "stopped"
        ? "Stopped"
        : "";

  const showBody = processOpen || streamingActive;

  return (
    <div data-testid="chat-transcript-item" className="flex justify-start transition-all duration-200">
      <div className="w-full max-w-3xl px-1 py-1">
        <div className="flex items-center gap-3">
          <div className="h-px min-w-[1rem] flex-1 bg-border/45" aria-hidden />
          <button
            type="button"
            className={cn(
              "flex max-w-[min(100%,90%)] shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground transition-colors",
              streamingActive ? "cursor-default" : "hover:text-foreground",
            )}
            disabled={streamingActive}
            onClick={() => {
              if (!streamingActive) {
                setProcessOpen((open) => {
                  const next = !open;
                  onOpenChange?.(next);
                  return next;
                });
              }
            }}
            aria-expanded={showBody}
          >
            {streamingActive ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
            ) : null}
            <span className="whitespace-nowrap">
              {streamingActive ? "Working" : "Worked"} for {formatChatProcessDuration(durationMs)}
            </span>
            {statusHint ? (
              <span className="truncate text-amber-700/90 dark:text-amber-400/85">· {statusHint}</span>
            ) : null}
            {streamingActive ? (
              <ChevronDown className="h-4 w-4 shrink-0 opacity-60" aria-hidden />
            ) : showBody ? (
              <ChevronDown className="h-4 w-4 shrink-0 opacity-60" aria-hidden />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0 opacity-60" aria-hidden />
            )}
          </button>
          <div className="h-px min-w-[1rem] flex-1 bg-border/45" aria-hidden />
        </div>
        {showBody ? (
          <div className="mt-3">
            <RunTranscriptView
              entries={entries}
              mode="nice"
              density="compact"
              streaming={streamingActive}
              collapseStdout
              presentation="chat"
              showDeveloperDiagnostics={showDeveloperDiagnostics}
              hiddenAssistantMessageText={assistantMessageBody}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AssistantDraftItem({
  body,
  createdAt,
  state,
  replyingAgentId,
  conversation,
  agents,
  onCopyMessageText,
  skillReferences,
  onMarkdownLinkClick,
}: {
  body: string;
  createdAt: Date;
  state: ChatStreamDraftState;
  replyingAgentId: string | null;
  conversation: ChatConversation;
  agents: Agent[] | undefined;
  onCopyMessageText: (text: string) => void | Promise<void>;
  skillReferences: MarkdownSkillReferencePreview[];
  onMarkdownLinkClick?: MarkdownLinkClickHandler;
}) {
  const streamingActive = state === "streaming" || state === "finalizing";
  const statusLabel = streamingActive ? null : assistantStateLabel(state);

  if (!body.trim() && !streamingActive) {
    return null;
  }

  return (
    <div className="flex justify-start transition-all duration-200">
      <div className="group w-full max-w-3xl px-1 py-1">
        <ChatAssistantAttributionRow
          replyingAgentId={replyingAgentId}
          conversation={conversation}
          agents={agents}
        />
        {statusLabel ? (
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span className={cn("rounded-full px-2 py-0.5 text-[10px]", statusChipClassName(state))}>
              {statusLabel}
            </span>
          </div>
        ) : null}
        <div className="max-w-[72ch] text-[15px] leading-7 text-foreground">
          {body.trim() ? (
            <ChatLongMessageBody
              body={body}
              skillReferences={skillReferences}
              onMarkdownLinkClick={onMarkdownLinkClick}
            />
          ) : (
            <TextDots text="Thinking" className="text-muted-foreground" />
          )}
        </div>
        {body.trim() ? (
          <div
            className={cn(
              "mt-2 flex h-7 items-center gap-1 text-muted-foreground",
              chatMessageHoverBarClass,
            )}
          >
            <HoverTimestampLabel
              date={createdAt}
              label={relativeTime(createdAt)}
              className="text-[11px] tracking-normal"
            />
            <button
              type="button"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-[color:var(--surface-active)] hover:text-foreground"
              aria-label="Copy message"
              onClick={() => void onCopyMessageText(body)}
            >
              <Copy className="h-4 w-4" />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function Chat() {
  const { selectedOrganizationId } = useOrganization();

  if (!selectedOrganizationId) {
    return <div className="text-sm text-muted-foreground">Select a organization first.</div>;
  }

  return <ChatWorkspace key={selectedOrganizationId} />;
}

function ChatWorkspace() {
  const { conversationId } = useParams<{ conversationId?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { selectedOrganization, selectedOrganizationId } = useOrganization();
  const { t } = useI18n();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const {
    abortChatStream,
    sendInFlightByChatId,
    setChatSendInFlight,
    setStreamAbortController,
    setStreamDraftForChat,
    streamDrafts,
  } = useChatGenerations();
  const draftStorageOrgId = selectedOrganizationId!;
  const draftStorageConversationId = conversationId ?? null;
  const draftStorageScopeKey = resolveChatPendingAttachmentScopeKey(draftStorageOrgId, draftStorageConversationId);
  const activeDraftScopeRef = useRef(draftStorageScopeKey);
  const [draftState, setDraftState] = useState(() => ({
    scopeKey: draftStorageScopeKey,
    value: readChatDraft(draftStorageOrgId, draftStorageConversationId),
  }));
  const draft = draftState.scopeKey === draftStorageScopeKey ? draftState.value : "";
  const setDraft = useCallback((nextDraft: string) => {
    setDraftState((current) => ({ ...current, value: nextDraft }));
  }, []);
  const [, refreshPendingFiles] = useState(0);
  const pendingFiles = readChatPendingAttachmentsForScope(draftStorageScopeKey);
  const setPendingFilesForCurrentScope = useCallback((updater: (current: File[]) => File[]) => {
    updateChatPendingAttachmentsForScope(draftStorageScopeKey, updater);
    refreshPendingFiles((version) => version + 1);
  }, [draftStorageScopeKey]);
  const clearPendingFilesForCurrentScope = useCallback(() => {
    setPendingFilesForCurrentScope(() => []);
  }, [setPendingFilesForCurrentScope]);
  const [newConversationSendInFlight, setNewConversationSendInFlight] = useState(false);
  const [openProcessMessageIds, setOpenProcessMessageIds] = useState<Record<string, true>>({});
  const [draftPreferredAgentId, setDraftPreferredAgentId] = useState<string>(NO_CHAT_AGENT_ID);
  const [draftProjectId, setDraftProjectId] = useState<string>(NO_PROJECT_ID);
  const [pendingProjectContextOverride, setPendingProjectContextOverride] = useState<{
    chatId: string;
    projectId: string | null;
  } | null>(null);
  const [draftPlanMode, setDraftPlanMode] = useState(false);
  const [pendingPlanModeOverride, setPendingPlanModeOverride] = useState<boolean | null>(null);
  const [decisionNotesByMessageId, setDecisionNotesByMessageId] = useState<Record<string, string>>({});
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [skillSearchQuery, setSkillSearchQuery] = useState("");
  const [composerMenuPosition, setComposerMenuPosition] = useState<CSSProperties | null>(null);
  const [editForkUserMessageId, setEditForkUserMessageId] = useState<string | null>(null);
  const [branchPreview, setBranchPreview] = useState<ChatBranchPreview | null>(null);
  const [expandedEmptyStatePrompt, setExpandedEmptyStatePrompt] = useState<EmptyStatePromptLabel | null>(null);
  const [emptyStatePromptPanelEntered, setEmptyStatePromptPanelEntered] = useState(false);
  const [attachmentPreview, setAttachmentPreview] = useState<AttachmentPreviewState | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerSurfaceRef = useRef<HTMLDivElement>(null);
  const composerEditorRef = useRef<MarkdownEditorRef>(null);
  const composerContextMenuRef = useRef<HTMLDivElement>(null);
  const composerEditorScrollRef = useScrollbarActivityRef();
  const skillSearchInputRef = useRef<HTMLInputElement>(null);
  const stopRequestedChatIdsRef = useRef<Set<string>>(new Set());
  const newConversationSendLockRef = useRef(false);
  const chatSendLocksRef = useRef<Record<string, true>>({});
  const lastAppliedPrefillRef = useRef<string | null>(null);
  const lastAppliedAgentPrefillRef = useRef<string | null>(null);
  const lastAppliedProjectPrefillRef = useRef<string | null>(null);
  const projectDefaultInitializedRef = useRef(false);
  const chatMessagesScrollElementRef = useRef<HTMLDivElement | null>(null);
  const initialScrolledConversationRef = useRef<string | null>(null);
  const { isMobile } = useSidebar();
  const chatMessagesActivityRef = useScrollbarActivityRef();
  const chatMessagesScrollRef = useCallback((element: HTMLDivElement | null) => {
    chatMessagesScrollElementRef.current = element;
    chatMessagesActivityRef(element);
  }, [chatMessagesActivityRef]);
  const pendingPrefill = searchParams.get("prefill") ?? "";
  const pendingAgentPrefill = searchParams.get("agentId")?.trim() ?? "";
  const pendingProjectPrefill = searchParams.get("projectId")?.trim() ?? "";
  const pendingIssueId = searchParams.get("issueId")?.trim() ?? "";
  const relativePath = toOrganizationRelativePath(location.pathname);
  const chatRouteBase = relativePath.startsWith("/messenger/chat") ? "/messenger/chat" : "/chat";
  const openLocalFile = useCallback((targetPath: string) => {
    const desktopShell = readDesktopShell();
    if (!desktopShell) {
      pushToast({
        title: "Open from Desktop",
        body: "Local chat file links can only be opened from the Rudder Desktop app.",
        tone: "warn",
      });
      return;
    }

    void desktopShell.openPath(targetPath).catch((error) => {
      pushToast({
        title: "Failed to open file",
        body: error instanceof Error ? error.message : `Could not open ${targetPath}.`,
        tone: "error",
      });
    });
  }, [pushToast]);
  const handleChatMarkdownLinkClick = useCallback<MarkdownLinkClickHandler>(({ event, href }) => {
    if (!shouldHandlePlainChatLinkClick(event)) return;

    const targetPath = resolveLocalFileTarget(href);
    if (!targetPath) return;

    event.preventDefault();
    event.stopPropagation();
    openLocalFile(targetPath);
    return true;
  }, [openLocalFile]);
  const chatRootPath = chatRouteBase;
  const chatConversationPath = useCallback((id: string) => `${chatRouteBase}/${id}`, [chatRouteBase]);
  const composerContextMenuOpen = projectMenuOpen || agentMenuOpen || skillMenuOpen;

  useEffect(() => {
    activeDraftScopeRef.current = draftStorageScopeKey;
  }, [draftStorageScopeKey]);

  const closeComposerContextMenus = useCallback(() => {
    setProjectMenuOpen(false);
    setAgentMenuOpen(false);
    setSkillMenuOpen(false);
    setSkillSearchQuery("");
  }, []);

  const openComposerContextMenu = useCallback((kind: "project" | "agent" | "skill") => {
    const anchor = composerSurfaceRef.current;
    if (anchor) {
      setComposerMenuPosition(composerMenuPositionForAnchor(anchor));
    }
    setProjectMenuOpen(kind === "project");
    setAgentMenuOpen(kind === "agent");
    setSkillMenuOpen(kind === "skill");
    if (kind !== "skill") {
      setSkillSearchQuery("");
    }
  }, []);

  const appendPendingFiles = useCallback(
    async (incomingFiles: Iterable<File>) => {
      const files = Array.from(incomingFiles).filter((file) => file.size > 0);
      if (files.length === 0) return;

      try {
        const safeFiles = await Promise.all(
          files.map((file, index) => materializePendingAttachment(file, index)),
        );
        setPendingFilesForCurrentScope((current) => [...current, ...safeFiles]);
      } catch (error) {
        pushToast({
          title: "Failed to stage attachment",
          body: error instanceof Error ? error.message : undefined,
          tone: "error",
        });
      }
    },
    [pushToast, setPendingFilesForCurrentScope],
  );

  const removePendingFile = useCallback((targetKey: string) => {
    setPendingFilesForCurrentScope((current) => current.filter((file) => pendingAttachmentKey(file) !== targetKey));
  }, [setPendingFilesForCurrentScope]);

  const handleComposerPasteCapture = useCallback((event: ReactClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file instanceof File);
    if (files.length === 0) return;

    event.preventDefault();
    event.stopPropagation();
    void appendPendingFiles(files);
  }, [appendPendingFiles]);

  useEffect(() => {
    if (draftState.scopeKey === draftStorageScopeKey) return;
    setDraftState({
      scopeKey: draftStorageScopeKey,
      value: readChatDraft(draftStorageOrgId, draftStorageConversationId),
    });
  }, [draftState.scopeKey, draftStorageConversationId, draftStorageOrgId, draftStorageScopeKey]);

  useEffect(() => {
    if (draftState.scopeKey !== draftStorageScopeKey) return;
    saveChatDraft(draftStorageOrgId, draftStorageConversationId, draftState.value);
  }, [draftState.scopeKey, draftState.value, draftStorageConversationId, draftStorageOrgId, draftStorageScopeKey]);

  useEffect(() => {
    if (!pendingPrefill) return;
    if (pendingPrefill === lastAppliedPrefillRef.current) return;
    if (draft.trim().length > 0) return;

    lastAppliedPrefillRef.current = pendingPrefill;
    setDraft(pendingPrefill);
    requestAnimationFrame(() => {
      composerEditorRef.current?.focus();
    });

    const nextSearch = new URLSearchParams(searchParams);
    nextSearch.delete("prefill");
    navigate(
      {
        pathname: conversationId ? chatConversationPath(conversationId) : chatRootPath,
        search: nextSearch.toString() ? `?${nextSearch.toString()}` : "",
      },
      { replace: true },
    );
  }, [chatConversationPath, chatRootPath, conversationId, draft, navigate, pendingPrefill, searchParams]);

  const conversationsQuery = useQuery({
    queryKey: queryKeys.chats.list(selectedOrganizationId ?? "__none__", "active"),
    queryFn: () => chatsApi.list(selectedOrganizationId!, "active"),
    enabled: !!selectedOrganizationId,
  });

  const conversationQuery = useQuery({
    queryKey: queryKeys.chats.detail(conversationId ?? "__none__"),
    queryFn: () => chatsApi.get(conversationId!),
    enabled: !!conversationId,
  });

  const messagesQuery = useQuery({
    queryKey: queryKeys.chats.messages(conversationId ?? "__none__"),
    queryFn: () => chatsApi.listMessages(conversationId!),
    enabled: !!conversationId,
  });

  const { data: agents, error: agentsError } = useQuery({
    queryKey: queryKeys.agents.list(selectedOrganizationId ?? "__none__"),
    queryFn: () => agentsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });
  const liveAgents = useMemo(() => selectableChatAgents(agents), [agents]);

  const { data: projects, error: projectsError } = useQuery({
    queryKey: queryKeys.projects.list(selectedOrganizationId ?? "__none__"),
    queryFn: () => projectsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });
  const visibleProjects = useMemo(
    () => (projects ?? []).filter((project) => !project.archivedAt),
    [projects],
  );

  const { data: issues, error: issuesError } = useQuery({
    queryKey: queryKeys.issues.list(selectedOrganizationId ?? "__none__"),
    queryFn: () => issuesApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });

  const profileQuery = useQuery({
    queryKey: queryKeys.instance.profileSettings,
    queryFn: () => instanceSettingsApi.getProfile(),
  });
  const generalSettingsQuery = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  });
  const showDeveloperDiagnostics = generalSettingsQuery.data?.showDeveloperDiagnostics === true;

  useEffect(() => {
    if (pendingPrefill) return;

    const hasAgentPrefill = pendingAgentPrefill.length > 0;
    const hasProjectPrefill = pendingProjectPrefill.length > 0;
    if (!hasAgentPrefill && !hasProjectPrefill) return;

    const agentAlreadyApplied =
      !hasAgentPrefill || pendingAgentPrefill === lastAppliedAgentPrefillRef.current;
    const projectAlreadyApplied =
      !hasProjectPrefill || pendingProjectPrefill === lastAppliedProjectPrefillRef.current;
    if (agentAlreadyApplied && projectAlreadyApplied) return;

    if (!conversationId) {
      if (hasAgentPrefill && !agentAlreadyApplied && !agents) return;
      if (hasProjectPrefill && !projectAlreadyApplied && !projects) return;

      if (hasAgentPrefill && !agentAlreadyApplied && agents) {
        const requestedAgentId = resolveRequestedPreferredAgentId(pendingAgentPrefill, agents);
        if (requestedAgentId) {
          setDraftPreferredAgentId(requestedAgentId);
          if (selectedOrganizationId) {
            rememberChatAgentId(selectedOrganizationId, requestedAgentId);
          }
        }
      }

      if (hasProjectPrefill && !projectAlreadyApplied && projects) {
        const requestedProject = visibleProjects.find((project) => project.id === pendingProjectPrefill);
        if (requestedProject) {
          setDraftProjectId(requestedProject.id);
          if (selectedOrganizationId) {
            rememberChatProjectId(selectedOrganizationId, requestedProject.id);
          }
        }
      }
    }

    const nextSearch = new URLSearchParams(searchParams);
    if (hasAgentPrefill && !agentAlreadyApplied) {
      lastAppliedAgentPrefillRef.current = pendingAgentPrefill;
      nextSearch.delete("agentId");
    }
    if (hasProjectPrefill && !projectAlreadyApplied) {
      lastAppliedProjectPrefillRef.current = pendingProjectPrefill;
      nextSearch.delete("projectId");
    }
    navigate(
      {
        pathname: conversationId ? chatConversationPath(conversationId) : chatRootPath,
        search: nextSearch.toString() ? `?${nextSearch.toString()}` : "",
      },
      { replace: true },
    );
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
    selectedOrganizationId,
    visibleProjects,
  ]);

  const selectedConversation = conversationQuery.data
    ?? conversationsQuery.data?.find((conversation) => conversation.id === conversationId)
    ?? null;
  const draftIssueContext = !selectedConversation
    ? resolveDraftIssueContext(issues, pendingIssueId)
    : null;
  const draftIssueContextId = !selectedConversation && pendingIssueId
    ? draftIssueContext?.id ?? pendingIssueId
    : null;
  const activeAgentId = selectedConversation?.preferredAgentId ?? draftPreferredAgentId;
  const selectedConversationProjectId = projectContextId(selectedConversation);
  const pendingSelectedConversationProjectId =
    selectedConversation && pendingProjectContextOverride?.chatId === selectedConversation.id
      ? pendingProjectContextOverride.projectId
      : undefined;
  const activeProjectId = selectedConversation
    ? (pendingSelectedConversationProjectId ?? selectedConversationProjectId ?? NO_PROJECT_ID)
    : draftProjectId;
  const activePlanMode = pendingPlanModeOverride ?? selectedConversation?.planMode ?? draftPlanMode;
  const activeSkillAgentId = activeAgentId === NO_CHAT_AGENT_ID ? null : activeAgentId;
  const activeSkillAgent = activeSkillAgentId
    ? (agents ?? []).find((agent) => agent.id === activeSkillAgentId) ?? null
    : null;

  const {
    data: organizationSkills,
    error: organizationSkillsError,
    isPending: organizationSkillsPending,
  } = useQuery({
    queryKey: queryKeys.organizationSkills.list(selectedOrganizationId ?? "__none__"),
    queryFn: () => organizationSkillsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });

  const {
    data: activeAgentSkillSnapshot,
    error: activeAgentSkillsError,
    isPending: activeAgentSkillsPending,
  } = useQuery({
    queryKey: queryKeys.agents.skills(activeSkillAgentId ?? "__none__"),
    queryFn: () => agentsApi.skills(activeSkillAgentId!, selectedOrganizationId!),
    enabled: Boolean(selectedOrganizationId) && Boolean(activeSkillAgentId),
  });

  useEffect(() => {
    setEditForkUserMessageId(null);
    setBranchPreview(null);
    setAttachmentPreview(null);
  }, [conversationId]);

  useEffect(() => {
    setSkillMenuOpen(false);
    setSkillSearchQuery("");
  }, [activeSkillAgentId]);

  useEffect(() => {
    if (!composerContextMenuOpen) {
      setComposerMenuPosition(null);
      return;
    }

    const updatePosition = () => {
      const anchor = composerSurfaceRef.current;
      if (!anchor) return;
      setComposerMenuPosition(composerMenuPositionForAnchor(anchor));
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [composerContextMenuOpen]);

  useEffect(() => {
    if (!composerContextMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (composerContextMenuRef.current?.contains(target)) return;
      if (composerSurfaceRef.current?.contains(target)) return;
      closeComposerContextMenus();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeComposerContextMenus();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [closeComposerContextMenus, composerContextMenuOpen]);

  useEffect(() => {
    if (!skillMenuOpen) return;
    requestAnimationFrame(() => {
      skillSearchInputRef.current?.focus();
    });
  }, [skillMenuOpen]);

  useEffect(() => {
    if (!selectedOrganizationId) return;
    if (!conversationId) {
      setBreadcrumbs([{ label: chatRouteBase.startsWith("/messenger") ? "Messenger" : "Chat" }]);
      return;
    }
    if (selectedConversation) {
      const primary = selectedConversation.primaryIssue;
      if (primary) {
        setBreadcrumbs([
          {
            label: selectedConversation.title,
            sublabel: formatChatPrimaryIssueBreadcrumb(primary),
            subhref: `/issues/${primary.identifier ?? primary.id}`,
          },
        ]);
      } else {
        setBreadcrumbs([{ label: selectedConversation.title }]);
      }
      return;
    }
    setBreadcrumbs([{ label: chatRouteBase.startsWith("/messenger") ? "Messenger" : "Chat" }]);
  }, [chatRouteBase, selectedOrganizationId, conversationId, selectedConversation, setBreadcrumbs]);

  useEffect(() => {
    if (!selectedConversation) return;
    setDraftPlanMode(selectedConversation.planMode);
    setPendingPlanModeOverride((pending) => pending === selectedConversation.planMode ? null : pending);
  }, [
    selectedConversation?.id,
    selectedConversation?.planMode,
  ]);

  useEffect(() => {
    if (!selectedOrganizationId || !agents) return;

    if (selectedConversation?.preferredAgentId) {
      setDraftPreferredAgentId(selectedConversation.preferredAgentId);
      if (isSelectableChatAgentId(selectedConversation.preferredAgentId, agents)) {
        rememberChatAgentId(selectedOrganizationId, selectedConversation.preferredAgentId);
      }
      return;
    }

    const defaultAgentId = resolveDefaultChatAgentId(selectedOrganizationId, agents);
    setDraftPreferredAgentId((current) => (
      isSelectableChatAgentId(current, agents) ? current : defaultAgentId
    ));
  }, [
    agents,
    selectedConversation?.id,
    selectedConversation?.preferredAgentId,
    selectedOrganizationId,
  ]);

  useEffect(() => {
    if (!selectedOrganizationId || !selectedConversation) return;
    const projectId = projectContextId(selectedConversation);
    setDraftProjectId(projectId ?? NO_PROJECT_ID);
    rememberChatProjectId(selectedOrganizationId, projectId);
  }, [
    selectedOrganizationId,
    selectedConversation?.id,
    selectedConversation?.contextLinks,
  ]);

  useEffect(() => {
    if (!selectedOrganizationId || selectedConversation || projectDefaultInitializedRef.current) return;
    if (!projects) return;
    projectDefaultInitializedRef.current = true;

    const rememberedProjectId = readRememberedChatProjectId(selectedOrganizationId);
    if (
      rememberedProjectId
      && visibleProjects.some((project) => project.id === rememberedProjectId)
    ) {
      setDraftProjectId(rememberedProjectId);
      return;
    }
    setDraftProjectId(NO_PROJECT_ID);
  }, [projects, selectedConversation, selectedOrganizationId, visibleProjects]);

  useEffect(() => {
    if (!selectedOrganizationId) return;
    if (!relativePath.startsWith("/messenger/chat")) return;
    rememberMessengerPath(selectedOrganizationId, relativePath);
  }, [relativePath, selectedOrganizationId]);

  const refreshChat = async (chatId?: string | null) => {
    if (!selectedOrganizationId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(selectedOrganizationId, "active") }),
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(selectedOrganizationId, "all") }),
      queryClient.invalidateQueries({ queryKey: queryKeys.messenger.threads(selectedOrganizationId) }),
    ]);
    if (chatId) {
      await queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(chatId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.chats.messages(chatId) });
    }
    await queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedOrganizationId) });
  };

  const upsertConversation = (conversation: ChatConversation) => {
    queryClient.setQueryData(queryKeys.chats.detail(conversation.id), conversation);
    for (const status of ["active", "all"] as const) {
      queryClient.setQueryData<ChatConversation[]>(
        queryKeys.chats.list(selectedOrganizationId ?? "__none__", status),
        (current) => mergeChatConversationsForStatus(current ?? [], conversation, status),
      );
    }
  };

  const upsertMessengerThreadSummary = useCallback((
    conversation: ChatConversation,
    options?: {
      latestActivityAt?: Date;
      preview?: string | null;
    },
  ) => {
    if (!selectedOrganizationId) return;
    queryClient.setQueryData<MessengerThreadSummary[]>(
      queryKeys.messenger.threads(selectedOrganizationId),
      (current) => mergeMessengerThreadSummaries(
        current ?? [],
        buildMessengerChatThreadSummary(conversation, options),
      ),
    );
  }, [queryClient, selectedOrganizationId]);

  const upsertOptimisticConversation = (
    conversation: ChatConversation,
    body: string,
    sentAt: Date,
  ) => {
    const optimisticConversation = withOptimisticOutgoingMessage(conversation, body, sentAt);
    upsertConversation(optimisticConversation);
    upsertMessengerThreadSummary(optimisticConversation, {
      latestActivityAt: sentAt,
      preview: body,
    });
    return optimisticConversation;
  };

  const upsertMessages = (chatId: string, incoming: ChatMessage[]) => {
    queryClient.setQueryData<ChatMessage[]>(
      queryKeys.chats.messages(chatId),
      (current) => mergeChatMessages(current ?? [], incoming),
    );
  };

  const acquireNewConversationSendLock = useCallback(() => {
    if (newConversationSendLockRef.current) return false;
    newConversationSendLockRef.current = true;
    setNewConversationSendInFlight(true);
    return true;
  }, []);

  const releaseNewConversationSendLock = useCallback(() => {
    if (!newConversationSendLockRef.current) return;
    newConversationSendLockRef.current = false;
    setNewConversationSendInFlight(false);
  }, []);

  const acquireChatSendLock = useCallback((chatId: string) => {
    if (chatSendLocksRef.current[chatId]) return false;
    chatSendLocksRef.current = {
      ...chatSendLocksRef.current,
      [chatId]: true,
    };
    return true;
  }, []);

  const releaseChatSendLock = useCallback((chatId: string) => {
    if (!(chatId in chatSendLocksRef.current)) return;
    const { [chatId]: _removed, ...rest } = chatSendLocksRef.current;
    chatSendLocksRef.current = rest;
  }, []);

  const setProcessOpenForMessage = useCallback((messageId: string, open: boolean) => {
    setOpenProcessMessageIds((current) => {
      if (open) {
        if (current[messageId]) return current;
        return { ...current, [messageId]: true };
      }
      if (!(messageId in current)) return current;
      const { [messageId]: _removed, ...rest } = current;
      return rest;
    });
  }, []);

  const keepProcessOpenForMessages = useCallback((messages: ChatMessage[]) => {
    const messageIds = messages
      .filter((message) => {
        const transcript = (message.transcript ?? []) as TranscriptEntry[];
        return transcript.length > 0
          && (
            message.role === "assistant"
            || message.kind === "issue_proposal"
            || message.kind === "operation_proposal"
          );
      })
      .map((message) => message.id);
    if (messageIds.length === 0) return;
    setOpenProcessMessageIds((current) => {
      let changed = false;
      const next = { ...current };
      for (const messageId of messageIds) {
        if (next[messageId]) continue;
        next[messageId] = true;
        changed = true;
      }
      return changed ? next : current;
    });
  }, []);

  const setDecisionNoteForMessage = useCallback((messageId: string, value: string) => {
    setDecisionNotesByMessageId((current) => {
      if (!value.trim()) {
        if (!(messageId in current)) return current;
        const { [messageId]: _removed, ...rest } = current;
        return rest;
      }
      return { ...current, [messageId]: value };
    });
  }, []);

  const clearDecisionNoteForMessage = useCallback((messageId: string) => {
    setDecisionNotesByMessageId((current) => {
      if (!(messageId in current)) return current;
      const { [messageId]: _removed, ...rest } = current;
      return rest;
    });
  }, []);

  const updateConversationMutation = useMutation({
    mutationFn: ({ chatId, data }: { chatId: string; data: Parameters<typeof chatsApi.update>[1] }) =>
      chatsApi.update(chatId, data),
    onSuccess: async (conversation) => {
      if (conversation.status === "archived" && conversation.id === selectedConversation?.id) {
        navigate(chatRootPath);
      }
      upsertConversation(conversation);
      upsertMessengerThreadSummary(conversation);
      await refreshChat(conversation.id);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update conversation",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      });
    },
  });

  const updateProjectContextMutation = useMutation({
    mutationFn: ({ chatId, projectId }: {
      chatId: string;
      projectId: string | null;
      previousProjectId?: string | null;
    }) =>
      chatsApi.setProjectContext(chatId, projectId),
    onSuccess: async (conversation, variables) => {
      const nextProjectId = projectContextId(conversation);
      setPendingProjectContextOverride((current) => (
        current?.chatId === variables.chatId ? null : current
      ));
      setDraftProjectId(nextProjectId ?? NO_PROJECT_ID);
      if (selectedOrganizationId) {
        rememberChatProjectId(selectedOrganizationId, nextProjectId);
      }
      upsertConversation(conversation);
      upsertMessengerThreadSummary(conversation);
      await refreshChat(conversation.id);
    },
    onError: (error, variables) => {
      setPendingProjectContextOverride((current) => (
        current?.chatId === variables.chatId ? null : current
      ));
      if (selectedConversation?.id === variables.chatId) {
        setDraftProjectId(variables.previousProjectId ?? NO_PROJECT_ID);
      }
      pushToast({
        title: "Failed to update project context",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      });
    },
  });

  const markConversationReadMutation = useMutation({
    mutationFn: (chatId: string) => chatsApi.markRead(chatId),
    onSuccess: async (_result, chatId) => {
      await refreshChat(chatId);
    },
  });

  const convertToIssueMutation = useMutation({
    mutationFn: ({ chatId, message }: { chatId: string; message: ChatMessage }) =>
      chatsApi.convertToIssue(chatId, {
        messageId: message.id,
        proposal: issueProposalFromMessage(message) ?? undefined,
      }),
    onSuccess: async ({ issue }, variables) => {
      await refreshChat(variables.chatId);
      const issueRef = issue.identifier ?? issue.id;
      pushToast({
        title: `Created issue ${issueRef}`,
        tone: "success",
        action: {
          label: `Open ${issueRef}`,
          href: `/issues/${issueRef}`,
        },
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to convert chat to issue",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      });
    },
  });

  const approvalMutation = useMutation({
    mutationFn: async ({
      approvalId,
      action,
      messageId,
    }: {
      approvalId: string;
      action: ApprovalAction;
      messageId: string;
    }) => {
      const note = decisionNotesByMessageId[messageId]?.trim() || undefined;
      if (action === "approve") return approvalsApi.approve(approvalId, note);
      if (action === "reject") return approvalsApi.reject(approvalId, note);
      return approvalsApi.requestRevision(approvalId, note);
    },
    onSuccess: async (_result, variables) => {
      clearDecisionNoteForMessage(variables.messageId);
      await refreshChat(conversationId ?? null);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to apply approval action",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      });
    },
  });

  const operationProposalMutation = useMutation({
    mutationFn: ({
      chatId,
      messageId,
      action,
      decisionNote,
    }: {
      chatId: string;
      messageId: string;
      action: ChatOperationProposalDecisionAction;
      decisionNote: string;
    }) => chatsApi.resolveOperationProposal(chatId, messageId, {
      action,
      decisionNote: decisionNote.trim() || undefined,
    }),
    onSuccess: async (_result, variables) => {
      clearDecisionNoteForMessage(variables.messageId);
      await refreshChat(variables.chatId);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to resolve lightweight change",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      });
    },
  });

  const stopStreaming = useCallback((chatId: string) => {
    stopRequestedChatIdsRef.current.add(chatId);
    void chatsApi.stopMessageStream(chatId).catch((error) => {
      pushToast({
        title: "Failed to stop streaming",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      });
    });
    abortChatStream(chatId);
    setStreamDraftForChat(chatId, (current) => (current ? { ...current, state: "stopped" } : current));
  }, [abortChatStream, pushToast, setStreamDraftForChat]);

  const sendMessage = async (
    options?: {
      bodyOverride?: string;
      filesOverride?: File[];
      conversationOverride?: ChatConversation;
      editUserMessageIdOverride?: string | null;
    },
  ) => {
    if (!selectedOrganizationId) {
      pushToast({ title: "Select a organization first", tone: "error" });
      return;
    }

    const usesComposerState = options?.bodyOverride === undefined && options?.filesOverride === undefined;
    const body = (options?.bodyOverride ?? draft).trim();
    if (!body) {
      pushToast({ title: "Message cannot be empty", tone: "error" });
      return;
    }

    const filesToUpload = [...(options?.filesOverride ?? pendingFiles)];
    const submittedComposerDraft = usesComposerState
      ? {
          body,
          files: filesToUpload,
          orgId: draftStorageOrgId,
          conversationId: draftStorageConversationId,
        }
      : null;
    const editUserMessageId = options?.editUserMessageIdOverride ?? (usesComposerState ? editForkUserMessageId : null);
    const editTargetMessage = editUserMessageId
      ? rawMessages.find((message) => message.id === editUserMessageId) ?? null
      : null;

    let conversation = options?.conversationOverride ?? selectedConversation;
    let activeChatId: string | null = null;
    let newConversationLockAcquired = false;
    let chatSendLockAcquired = false;
    let userMessageAcknowledged = false;
    try {
      if (!conversation && conversationId) {
        conversation = await chatsApi.get(conversationId);
        upsertConversation(conversation);
        upsertMessengerThreadSummary(conversation);
      }

      if (!conversation) {
        if (!acquireNewConversationSendLock()) return;
        newConversationLockAcquired = true;
        const selectedDraftAgentId = draftPreferredAgentId === NO_CHAT_AGENT_ID ? null : draftPreferredAgentId;
        if (!selectedDraftAgentId) {
          pushToast({
            title: "No chat agent available",
            body: "Create or activate an agent before sending.",
            tone: "error",
          });
          releaseNewConversationSendLock();
          newConversationLockAcquired = false;
          return;
        }
        const createdConversation = await chatsApi.create(selectedOrganizationId, {
          preferredAgentId: selectedDraftAgentId,
          issueCreationMode: "manual_approval",
          planMode: draftPlanMode,
          contextLinks: buildDraftChatContextLinks(
            draftProjectId === NO_PROJECT_ID ? null : draftProjectId,
            draftIssueContextId,
          ),
        });
        const startedAt = new Date();
        conversation = upsertOptimisticConversation(createdConversation, body, startedAt);
        rememberChatAgentId(selectedOrganizationId, selectedDraftAgentId);
        if (usesComposerState) {
          setDraft("");
          clearPendingFilesForCurrentScope();
          setEditForkUserMessageId(null);
          setBranchPreview(null);
        }
        navigate(chatConversationPath(conversation.id));
      }

      const chatId = conversation.id;
      if (!acquireChatSendLock(chatId)) return;
      chatSendLockAcquired = true;
      activeChatId = chatId;
      const selectedAgentId = activeAgentId === NO_CHAT_AGENT_ID ? null : activeAgentId;
      if (!conversation.preferredAgentId && selectedAgentId) {
        conversation = await chatsApi.update(conversation.id, { preferredAgentId: selectedAgentId });
        setDraftPreferredAgentId(selectedAgentId);
        rememberChatAgentId(selectedOrganizationId, selectedAgentId);
        upsertConversation(conversation);
        upsertMessengerThreadSummary(conversation);
      }
      if (newConversationLockAcquired || newConversationSendLockRef.current) {
        releaseNewConversationSendLock();
        newConversationLockAcquired = false;
      }

      if (usesComposerState) {
        setEditForkUserMessageId(null);
        setBranchPreview(null);
        setDraft("");
        clearPendingFilesForCurrentScope();
      }
      setChatSendInFlight(chatId, true);
      stopRequestedChatIdsRef.current.delete(chatId);
      const abortController = new AbortController();
      setStreamAbortController(chatId, abortController);
      const startedAt = new Date();
      conversation = upsertOptimisticConversation(conversation, body, startedAt);
      setStreamDraftForChat(chatId, {
        chatId,
        userBody: body,
        userCreatedAt: startedAt,
        userMessageId: null,
        chatTurnId: null,
        editedFromCreatedAt: editTargetMessage ? new Date(editTargetMessage.createdAt) : null,
        body: "",
        state: "streaming",
        createdAt: startedAt,
        transcript: [],
        replyingAgentId: conversation.chatRuntime.runtimeAgentId ?? conversation.preferredAgentId ?? null,
      });

      await chatsApi.sendMessageStream(chatId, body, {
        signal: abortController.signal,
        editUserMessageId,
        files: filesToUpload,
        onEvent: async (event) => {
          if (event.type === "ack") {
            userMessageAcknowledged = true;
            upsertMessages(chatId, [event.userMessage]);
            setStreamDraftForChat(
              chatId,
              (current) => (current ? {
                ...current,
                userMessageId: event.userMessage.id,
                chatTurnId: event.userMessage.chatTurnId ?? null,
              } : current),
            );
            return;
          }

          if (event.type === "assistant_delta") {
            setStreamDraftForChat(
              chatId,
              (current) => (current ? { ...current, body: `${current.body}${event.delta}` } : current),
            );
            return;
          }

          if (event.type === "assistant_state") {
            setStreamDraftForChat(
              chatId,
              (current) => (current ? { ...current, state: event.state } : current),
            );
            return;
          }

          if (event.type === "transcript_entry") {
            setStreamDraftForChat(chatId, (current) => {
              if (!current) return current;
              const transcript = [...current.transcript];
              appendTranscriptEntry(transcript, event.entry);
              return { ...current, transcript };
            });
            return;
          }

          if (event.type === "final") {
            keepProcessOpenForMessages(event.messages);
            upsertMessages(chatId, event.messages);
            setStreamDraftForChat(chatId, null);
          }
        },
      });

      await refreshChat(chatId);
      setStreamDraftForChat(chatId, null);
    } catch (error) {
      const isAbort =
        error instanceof DOMException
          ? error.name === "AbortError"
          : error instanceof Error && error.name === "AbortError";

      if (conversation && (isAbort || stopRequestedChatIdsRef.current.has(conversation.id))) {
        setStreamDraftForChat(
          conversation.id,
          (current) => (current ? { ...current, state: "stopped" } : current),
        );
        window.setTimeout(() => {
          void refreshChat(conversation!.id).finally(() => {
            setStreamDraftForChat(conversation!.id, null);
          });
        }, 400);
        return;
      }

      if (conversation) {
        setStreamDraftForChat(
          conversation.id,
          (current) => (current ? { ...current, state: "failed" } : current),
        );
        await refreshChat(conversation.id);
        setStreamDraftForChat(conversation.id, null);
      }

      if (submittedComposerDraft && !userMessageAcknowledged) {
        const restoreConversationId = conversation?.id ?? submittedComposerDraft.conversationId;
        const restoreScopeKey = resolveChatPendingAttachmentScopeKey(
          submittedComposerDraft.orgId,
          restoreConversationId,
        );

        saveChatDraft(submittedComposerDraft.orgId, restoreConversationId, submittedComposerDraft.body);
        updateChatPendingAttachmentsForScope(restoreScopeKey, () => submittedComposerDraft.files);
        refreshPendingFiles((version) => version + 1);
        if (activeDraftScopeRef.current === restoreScopeKey) {
          setDraftState({
            scopeKey: restoreScopeKey,
            value: submittedComposerDraft.body,
          });
        }
      }

      if (error instanceof ApiError) {
        pushToast({
          title: "Failed to send message",
          body: error.message,
          tone: "error",
        });
        return;
      }

      pushToast({
        title: error instanceof Error ? error.message : "Failed to send message",
        tone: "error",
      });
    } finally {
      if (activeChatId) {
        setStreamAbortController(activeChatId, null);
        stopRequestedChatIdsRef.current.delete(activeChatId);
        if (chatSendLockAcquired) {
          releaseChatSendLock(activeChatId);
        }
        setChatSendInFlight(activeChatId, false);
      }
      if (newConversationLockAcquired) {
        releaseNewConversationSendLock();
      }
    }
  };

  const conversations = useMemo(() => {
    const items = conversationsQuery.data ?? [];
    return [...items].sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      return new Date(b.lastMessageAt ?? b.updatedAt).getTime() - new Date(a.lastMessageAt ?? a.updatedAt).getTime();
    });
  }, [conversationsQuery.data]);
  const rawMessages = messagesQuery.data ?? [];
  const latestIncomingMessageId = useMemo(() => {
    const messages = [...rawMessages]
      .filter(isUserVisibleIncomingChatMessage)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return messages[0]?.id ?? null;
  }, [rawMessages]);
  const displayedMessages = useMemo(
    () => computeDisplayedChatMessages(rawMessages, branchPreview),
    [rawMessages, branchPreview],
  );
  const showMessagesLoading = Boolean(selectedConversation && conversationId && messagesQuery.isPending && messagesQuery.data === undefined);
  const activeStream = readChatScopedState(streamDrafts, selectedConversation?.id);
  const activeSendInFlight = readChatScopedFlag(sendInFlightByChatId, selectedConversation?.id);
  const agentSelectionLocked = isChatAgentSelectionLocked({
    hasConversation: Boolean(selectedConversation),
    preferredAgentId: selectedConversation?.preferredAgentId,
    hasLastMessageAt: Boolean(selectedConversation?.lastMessageAt),
    hasMessages: rawMessages.length > 0,
    hasActiveStream: Boolean(activeStream),
    hasActiveSendInFlight: activeSendInFlight,
  });
  const projectSelectionLocked = isChatProjectSelectionLocked({
    hasConversation: Boolean(selectedConversation),
    hasLastMessageAt: Boolean(selectedConversation?.lastMessageAt),
    hasMessages: rawMessages.length > 0,
    hasActiveStream: Boolean(activeStream),
    hasActiveSendInFlight: activeSendInFlight,
  });
  const activeEditCutoffMs = activeStream?.editedFromCreatedAt
    ? activeStream.editedFromCreatedAt.getTime()
    : null;
  const activeStreamFilteredMessages = activeEditCutoffMs === null
    ? displayedMessages
    : displayedMessages.filter((message) => new Date(message.createdAt).getTime() < activeEditCutoffMs);
  const visibleMessages = activeStream
    ? activeStreamFilteredMessages.filter((message) => shouldShowMessageDuringActiveStream(message, activeStream))
    : activeStreamFilteredMessages;
  const pendingAskUserMessage = useMemo(
    () => findLatestUnansweredAskUserMessage(visibleMessages),
    [visibleMessages],
  );
  const pendingAskUserRequest = pendingAskUserMessage
    ? askUserRequestFromMessage(pendingAskUserMessage)
    : null;
  const lastMarkedReadKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!pendingAskUserRequest) return;
    closeComposerContextMenus();
  }, [closeComposerContextMenus, pendingAskUserRequest]);

  useEffect(() => {
    const chatId = selectedConversation?.id ?? null;
    if (!chatId || showMessagesLoading) return;
    if (initialScrolledConversationRef.current === chatId) return;

    initialScrolledConversationRef.current = chatId;
    const frame = requestAnimationFrame(() => {
      const scrollElement = chatMessagesScrollElementRef.current;
      if (!scrollElement) return;
      scrollChatMessagesToBottom(scrollElement);
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedConversation?.id, showMessagesLoading, visibleMessages.length]);

  useEffect(() => {
    if (!selectedConversation?.id || !latestIncomingMessageId) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    const shouldMarkRead = selectedConversation.isUnread || latestIncomingMessageId !== lastMarkedReadKeyRef.current?.split(":")[1];
    if (!shouldMarkRead) return;
    const nextKey = `${selectedConversation.id}:${latestIncomingMessageId}`;
    if (lastMarkedReadKeyRef.current === nextKey) return;
    lastMarkedReadKeyRef.current = nextKey;
    markConversationReadMutation.mutate(selectedConversation.id);
  }, [
    latestIncomingMessageId,
    markConversationReadMutation,
    selectedConversation?.id,
    selectedConversation?.isUnread,
  ]);
  const showOptimisticUserMessage = Boolean(
    activeStream
    && (
      activeEditCutoffMs !== null
      || !activeStream.userMessageId
      || !rawMessages.some((message) => message.id === activeStream.userMessageId)
    ),
  );

  useEffect(() => {
    if (agentSelectionLocked) {
      setAgentMenuOpen(false);
    }
  }, [agentSelectionLocked]);

  const loadError =
    conversationsQuery.error
    ?? conversationQuery.error
    ?? messagesQuery.error
    ?? agentsError
    ?? organizationSkillsError
    ?? activeAgentSkillsError
    ?? projectsError
    ?? issuesError;
  const loadErrorMessage =
    loadError instanceof Error
      ? loadError.message
      : loadError
        ? "Failed to load chat data."
        : null;
  const controlsDisabled = activeSendInFlight || newConversationSendInFlight;
  const activeSelectedAgentId = activeAgentId === NO_CHAT_AGENT_ID ? null : activeAgentId;
  const canPersistSelectedAgentForConversation = Boolean(
    selectedConversation
    && !selectedConversation.preferredAgentId
    && activeSelectedAgentId,
  );
  const composerUnavailable =
    selectedConversation
      ? !selectedConversation.chatRuntime.available && !canPersistSelectedAgentForConversation
      : !activeSelectedAgentId;
  const composerUnavailableMessage = activeSelectedAgentId
    ? selectedConversation?.chatRuntime.error ?? "Selected chat agent is unavailable."
    : "Create or activate an agent before sending messages.";
  const hasPendingLightweightProposal = rawMessages.some(
    (message) =>
      !message.supersededAt
      && message.kind === "operation_proposal"
      && !message.approval
      && operationProposalStatusFromMessage(message) === "pending",
  );
  const hasActionableApprovals = rawMessages
    .filter((m) => !m.supersededAt)
    .some((message) => approvalNeedsAction(message.approval));

  const agentPillLabel =
    activeAgentId === NO_CHAT_AGENT_ID
      ? (agents ? NO_CHAT_AGENT_LABEL : "Loading agents")
      : (() => {
          const activeAgent = (agents ?? []).find((agent) => agent.id === activeAgentId);
          return activeAgent ? formatChatAgentLabel(activeAgent) : "Unknown agent";
        })();
  const activeProjectContextLink = selectedConversation?.contextLinks.find((link) => link.entityType === "project") ?? null;
  const activeProject = activeProjectId === NO_PROJECT_ID
    ? null
    : visibleProjects.find((project) => project.id === activeProjectId) ?? null;
  const projectPillLabel = activeProject
    ? projectDisplayName(activeProject)
    : activeProjectId === NO_PROJECT_ID
      ? "No project"
      : activeProjectContextLink?.entity?.label ?? "Unknown project";

  const availableChatSkills = useMemo(
    () => buildChatSkillOptions({
      agent: activeSkillAgent,
      orgUrlKey: selectedOrganization?.urlKey ?? "organization",
      organizationSkills,
      skillSnapshot: activeAgentSkillSnapshot,
    }),
    [activeAgentSkillSnapshot, activeSkillAgent, organizationSkills, selectedOrganization?.urlKey],
  );
  const chatSkillReferences = useMemo<MarkdownSkillReferencePreview[]>(
    () => availableChatSkills.map((skill) => ({
      href: skill.skillMarkdownTarget,
      label: skill.skillRefLabel,
      displayName: skill.skillDisplayName,
      description: skill.skillDescription,
      categoryLabel: skill.skillCategoryLabel,
      locationLabel: skill.skillLocationLabel,
      detailsHref: skill.skillDetailsHref,
    })),
    [availableChatSkills],
  );
  const filteredChatSkills = useMemo(
    () => filterChatSkillOptions(availableChatSkills, skillSearchQuery),
    [availableChatSkills, skillSearchQuery],
  );
  const chatSkillsPending = Boolean(activeSkillAgentId) && (organizationSkillsPending || activeAgentSkillsPending);
  const showChatSkillsPicker = Boolean(activeSkillAgentId);
  const projectById = useMemo(
    () => new Map((projects ?? []).map((project) => [project.id, project])),
    [projects],
  );
  const agentById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent])),
    [agents],
  );

  const mentionOptions = useMemo<MentionOption[]>(() => {
    const options: MentionOption[] = [];
    for (const agent of (agents ?? []).filter((agent) => agent.status !== "terminated")) {
      options.push({
        id: `agent:${agent.id}`,
        name: formatChatAgentLabel(agent),
        kind: "agent",
        agentId: agent.id,
        agentIcon: agent.icon,
        agentRole: agent.role,
      });
    }
    for (const project of projects ?? []) {
      options.push({
        id: `project:${project.id}`,
        name: project.name,
        kind: "project",
        projectId: project.id,
        projectColor: project.color,
      });
    }
    for (const issue of issues ?? []) {
      const issueProject = issue.projectId ? projectById.get(issue.projectId) ?? issue.project ?? null : null;
      const assigneeAgent = issue.assigneeAgentId ? agentById.get(issue.assigneeAgentId) ?? null : null;
      const issueAssigneeName = issueAssigneeMentionLabel(issue, agentById);
      options.push({
        id: `issue:${issue.id}`,
        name: issue.identifier ? `${issue.identifier} ${issue.title}` : issue.title,
        kind: "issue",
        searchText: [
          issue.identifier,
          issue.title,
          issue.status,
          issueProject?.name,
          issueAssigneeName,
        ].filter(Boolean).join(" "),
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        issueStatus: issue.status,
        issueProjectName: issueProject?.name ?? null,
        issueProjectColor: issueProject?.color ?? null,
        issueAssigneeName,
        issueAssigneeIcon: assigneeAgent?.icon ?? null,
        issueAssigneeRole: assigneeAgent?.role ?? null,
      });
    }
    for (const skill of availableChatSkills) {
      options.push({
        id: skill.id,
        name: skill.name,
        kind: "skill",
        searchText: skill.searchText,
        skillRefLabel: skill.skillRefLabel,
        skillMarkdownTarget: skill.skillMarkdownTarget,
        skillDisplayName: skill.skillDisplayName,
        skillDescription: skill.skillDescription,
        skillCategoryLabel: skill.skillCategoryLabel,
        skillLocationLabel: skill.skillLocationLabel,
        skillDetailsHref: skill.skillDetailsHref,
      });
    }
    return options;
  }, [agentById, agents, availableChatSkills, issues, projectById, projects]);

  const insertSkillReference = useCallback((entry: (typeof availableChatSkills)[number]) => {
    if (!entry.skillRefLabel || !entry.skillMarkdownTarget) {
      setSkillMenuOpen(false);
      return;
    }

    const nextDraft = appendSkillReferencesToDraft(
      draft,
      [`[${entry.skillRefLabel}](${entry.skillMarkdownTarget})`],
    );
    setDraft(nextDraft);
    setSkillMenuOpen(false);
    setSkillSearchQuery("");
    requestAnimationFrame(() => {
      composerEditorRef.current?.focus();
    });

    if (nextDraft === draft) {
      pushToast({
        title: "Selected skills already in message",
        tone: "success",
      });
    }
  }, [draft, pushToast]);

  const applyPreferredAgent = (value: string) => {
    if (agentSelectionLocked) {
      setAgentMenuOpen(false);
      return;
    }
    if (!isSelectableChatAgentId(value, agents)) {
      setAgentMenuOpen(false);
      return;
    }

    setDraftPreferredAgentId(value);
    setAgentMenuOpen(false);
    if (selectedOrganizationId) {
      rememberChatAgentId(selectedOrganizationId, value);
    }
    if (selectedConversation) {
      updateConversationMutation.mutate({
        chatId: selectedConversation.id,
        data: { preferredAgentId: value },
      });
    }
  };

  const applyProjectContext = (value: string) => {
    if (projectSelectionLocked) {
      setProjectMenuOpen(false);
      return;
    }
    const projectId = value === NO_PROJECT_ID ? null : value;
    const previousProjectId = selectedConversation
      ? selectedConversationProjectId
      : draftProjectId === NO_PROJECT_ID
        ? null
        : draftProjectId;
    setDraftProjectId(value);
    setProjectMenuOpen(false);
    if (selectedOrganizationId) {
      rememberChatProjectId(selectedOrganizationId, projectId);
    }
    if (selectedConversation) {
      setPendingProjectContextOverride({
        chatId: selectedConversation.id,
        projectId,
      });
      updateProjectContextMutation.mutate({
        chatId: selectedConversation.id,
        projectId,
        previousProjectId,
      });
    }
  };

  const applyPlanMode = (value: boolean) => {
    const chatId = selectedConversation?.id ?? conversationId;
    const previousConversation = selectedConversation;
    const previousDraftPlanMode = draftPlanMode;
    setDraftPlanMode(value);
    setPendingPlanModeOverride(value);
    if (!chatId) return;

    if (previousConversation) {
      const optimisticConversation = withOptimisticPlanMode(previousConversation, value);
      upsertConversation(optimisticConversation);
      upsertMessengerThreadSummary(optimisticConversation);
    }

    updateConversationMutation.mutate(
      {
        chatId,
        data: { planMode: value },
      },
      {
        onSuccess: (conversation) => {
          setDraftPlanMode(conversation.planMode);
          setPendingPlanModeOverride(null);
        },
        onError: () => {
          setDraftPlanMode(previousConversation?.planMode ?? previousDraftPlanMode);
          setPendingPlanModeOverride(null);
          if (previousConversation) {
            upsertConversation(previousConversation);
            upsertMessengerThreadSummary(previousConversation);
          }
        },
      },
    );
  };

  const copyChatMessageText = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        pushToast({ title: "Copied to clipboard", tone: "success" });
      } catch {
        pushToast({ title: "Could not copy", tone: "error" });
      }
    },
    [pushToast],
  );

  const beginEditUserMessage = useCallback((message: ChatMessage) => {
    setEditForkUserMessageId(message.id);
    setDraft(message.body);
    clearPendingFilesForCurrentScope();
    requestAnimationFrame(() => {
      composerEditorRef.current?.focus();
    });
  }, [clearPendingFilesForCurrentScope]);

  const retryFailedMessage = useCallback(
    (message: ChatMessage) => {
      if (!selectedConversation) return;
      const sourceUserMessage = findRetrySourceUserMessage(rawMessages, message);
      if (!sourceUserMessage) {
        pushToast({
          title: "Retry unavailable",
          body: "The original user message for this failed reply could not be found.",
          tone: "error",
        });
        return;
      }

      void sendMessage({
        bodyOverride: sourceUserMessage.body,
        filesOverride: [],
        conversationOverride: selectedConversation,
        editUserMessageIdOverride: sourceUserMessage.id,
      });
    },
    [pushToast, rawMessages, selectedConversation, sendMessage],
  );

  const editDraftOnly = useCallback((text: string) => {
    setEditForkUserMessageId(null);
    setDraft(text);
    requestAnimationFrame(() => {
      composerEditorRef.current?.focus();
    });
  }, []);

  const toggleEmptyStatePrompt = useCallback((label: EmptyStatePromptLabel) => {
    setExpandedEmptyStatePrompt((current) => (current === label ? null : label));
  }, []);

  const applyEmptyStateExample = useCallback((example: string) => {
    setDraft(example);
    setExpandedEmptyStatePrompt(null);
    requestAnimationFrame(() => {
      composerEditorRef.current?.focus();
    });
  }, []);

  const turnBranchControlsFor = useCallback(
    (message: ChatMessage) => {
      const tid = message.chatTurnId;
      if (!tid || message.role !== "user" || message.kind !== "message") return null;
      const userRows = rawMessages.filter(
        (m) => m.role === "user" && m.kind === "message" && m.chatTurnId === tid,
      );
      const variants = [...new Set(userRows.map((m) => m.turnVariant))].sort((a, b) => a - b);
      if (variants.length < 2) return null;
      const activeRows = userRows.filter((m) => !m.supersededAt);
      const activeVariant =
        activeRows.length > 0
          ? Math.max(...activeRows.map((m) => m.turnVariant))
          : variants[variants.length - 1]!;
      const selected =
        branchPreview?.chatTurnId === tid ? branchPreview.turnVariant : activeVariant;
      let idx = variants.indexOf(selected);
      if (idx < 0) idx = variants.length - 1;
      return {
        current: idx + 1,
        total: variants.length,
        canPrev: idx > 0,
        canNext: idx < variants.length - 1,
        onPrev: () => setBranchPreview({ chatTurnId: tid, turnVariant: variants[idx - 1]! }),
        onNext: () => setBranchPreview({ chatTurnId: tid, turnVariant: variants[idx + 1]! }),
      };
    },
    [rawMessages, branchPreview],
  );

  const userNickname = profileQuery.data?.nickname.trim() ?? "";
  const emptyStateProjectName = activeProject ? projectDisplayName(activeProject) : null;
  const emptyStateHeading = chatEmptyStateHeading({
    activeProjectName: emptyStateProjectName,
    userNickname,
    t,
  });
  const emptyStateHeadingKey = emptyStateProjectName ? `project:${activeProject?.id}:${emptyStateProjectName}` : "no-project";
  const composerPlaceholder = activePlanMode
    ? t("chat.composer.planModePlaceholder")
    : draftIssueContext
      ? t("chat.composer.issuePlaceholder", { issue: draftIssueContextLabel(draftIssueContext) })
    : t("chat.composer.placeholder");
  const expandedPromptGroup = EMPTY_STATE_PROMPT_GROUPS.find((group) => group.label === expandedEmptyStatePrompt) ?? null;
  const emptyStatePromptOptionsId = "chat-empty-state-prompt-options";
  const emptyStatePromptOriginX = expandedEmptyStatePrompt === "Scope a new feature"
    ? "22%"
    : expandedEmptyStatePrompt === "Clarify a vague request"
      ? "50%"
      : expandedEmptyStatePrompt === "Turn a chat into an issue"
        ? "78%"
        : "50%";
  const sendButtonMode =
    newConversationSendInFlight || (activeSendInFlight && (!activeStream || !activeStream.userMessageId))
      ? "sending"
      : activeSendInFlight
        ? "stop"
        : "send";
  const sendButtonDisabled =
    composerUnavailable || sendButtonMode === "sending" || (sendButtonMode === "send" && draft.trim().length === 0);

  useEffect(() => {
    if (!expandedEmptyStatePrompt) {
      setEmptyStatePromptPanelEntered(false);
      return;
    }

    setEmptyStatePromptPanelEntered(false);
    const frame = requestAnimationFrame(() => {
      setEmptyStatePromptPanelEntered(true);
    });

    return () => cancelAnimationFrame(frame);
  }, [expandedEmptyStatePrompt]);

  const renderComposerContextMenu = () => {
    if (!composerContextMenuOpen || !composerMenuPosition || typeof document === "undefined") return null;

    const activeMenu = projectMenuOpen ? "project" : agentMenuOpen ? "agent" : "skill";

    return createPortal(
      <div
        ref={composerContextMenuRef}
        data-testid={`chat-${activeMenu}-menu`}
        role="menu"
        className="chat-composer-context-menu motion-chat-composer-menu-pop surface-overlay fixed z-50 overflow-y-auto rounded-[var(--radius-lg)] border p-1.5 text-foreground"
        style={composerMenuPosition}
      >
        {projectMenuOpen && !projectSelectionLocked ? (
          <>
            <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">Project context</div>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={activeProjectId === NO_PROJECT_ID}
              data-chat-composer-menu-item
              className="chat-composer-menu-row project-context-menu-item"
              onClick={() => applyProjectContext(NO_PROJECT_ID)}
            >
              <span className="project-context-empty-swatch h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">No project</span>
            </button>
            {visibleProjects.length > 0 ? (
              <div className="my-1 border-t border-[color:var(--border-soft)] pt-1">
                {visibleProjects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={activeProjectId === project.id}
                    data-chat-composer-menu-item
                    className="chat-composer-menu-row project-context-menu-item"
                    onClick={() => applyProjectContext(project.id)}
                  >
                    <span
                      className="project-context-swatch h-3 w-3 shrink-0"
                      style={projectContextSwatchStyle(project.color)}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{projectDisplayName(project)}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {project.resources.length} context item{project.resources.length === 1 ? "" : "s"}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </>
        ) : null}

        {agentMenuOpen && !agentSelectionLocked ? (
          <>
            <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">Agents</div>
            {liveAgents.length === 0 ? (
              <div className="flex items-center gap-2 rounded-[var(--radius-md)] px-3 py-2 text-sm text-muted-foreground">
                <Bot className="h-4 w-4 shrink-0" />
                <span>Create or activate an agent before sending messages.</span>
              </div>
            ) : liveAgents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                role="menuitemradio"
                aria-checked={activeAgentId === agent.id}
                data-chat-composer-menu-item
                className="chat-composer-menu-row"
                onClick={() => applyPreferredAgent(agent.id)}
              >
                <AgentIcon icon={agent.icon} role={agent.role} className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-medium">{formatChatAgentLabel(agent)}</span>
              </button>
            ))}
          </>
        ) : null}

        {skillMenuOpen ? (
          <>
            <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">Skills</div>
            {chatSkillsPending ? (
              <div className="flex items-center gap-2 rounded-[var(--radius-md)] px-3 py-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Loading skills...</span>
              </div>
            ) : availableChatSkills.length === 0 ? (
              <div className="rounded-[var(--radius-md)] px-3 py-2 text-sm leading-6 text-muted-foreground">
                This agent has no enabled skills.
              </div>
            ) : (
              <>
                <div className="px-2 pb-2">
                  <input
                    ref={skillSearchInputRef}
                    className="w-full rounded-[var(--radius-md)] border border-border bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-ring"
                    placeholder="Search skills..."
                    value={skillSearchQuery}
                    onChange={(event) => {
                      setSkillSearchQuery(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                    }}
                  />
                </div>
                <div>
                  {filteredChatSkills.length === 0 ? (
                    <div className="rounded-[var(--radius-md)] px-3 py-2 text-sm leading-6 text-muted-foreground">
                      No skills match search.
                    </div>
                  ) : filteredChatSkills.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      role="menuitem"
                      data-chat-composer-menu-item
                      className="chat-composer-menu-row"
                      onClick={() => insertSkillReference(entry)}
                    >
                      <Boxes className="h-4 w-4 shrink-0 text-[#2f80ed]" />
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="min-w-0 shrink truncate font-medium text-foreground">
                          {entry.skillDisplayName}
                        </span>
                        {entry.skillCategoryLabel ? (
                          <span className="inline-flex shrink-0 items-center rounded-[var(--radius-sm)] border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground">
                            {entry.skillCategoryLabel}
                          </span>
                        ) : null}
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">
                          {entry.skillDescription ?? entry.skillLocationLabel ?? entry.skillRefLabel}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        ) : null}
      </div>,
      document.body,
    );
  };

  const renderComposer = (centered: boolean) => (
    <div
      ref={composerSurfaceRef}
      className={cn(
        "chat-composer rounded-[var(--radius-lg)] p-3 transition-all duration-300",
        centered ? "mx-auto w-full max-w-3xl" : "w-full",
      )}
    >
      <div
        ref={composerEditorScrollRef}
        data-testid="chat-composer-editor-scroll"
        className="chat-composer-editor-scroll scrollbar-auto-hide overflow-y-auto overscroll-contain pr-1"
        onPasteCapture={handleComposerPasteCapture}
      >
        <MarkdownEditor
          ref={composerEditorRef}
          value={draft}
          onChange={setDraft}
          mentions={mentionOptions}
          mentionMenuAnchorRef={composerSurfaceRef}
          mentionMenuPlacement="container"
          submitShortcut="enter"
          plainText
          className="rounded-[var(--radius-md)] bg-transparent"
          contentClassName="min-h-[88px] bg-transparent text-[15px] leading-7 text-foreground"
          bordered={false}
          placeholder={composerPlaceholder}
          onSubmit={() => {
            if (!controlsDisabled && !composerUnavailable) {
              void sendMessage();
            }
          }}
        />
      </div>

      {composerUnavailable ? (
        <div className="chat-warning mt-2.5 rounded-[var(--radius-md)] px-3 py-2.5 text-sm">
          {composerUnavailableMessage}{" "}
          <Link to="/agents" className="underline underline-offset-4 hover:text-foreground">
            Open agents
          </Link>
        </div>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        multiple
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          void appendPendingFiles(files);
          event.currentTarget.value = "";
        }}
      />

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2.5" data-testid="chat-composer-toolbar">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <DropdownMenu open={plusMenuOpen} onOpenChange={setPlusMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-9 w-9 shrink-0 rounded-full border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-active)_52%,transparent)]"
                aria-label="Add files and options"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              sideOffset={8}
              className="surface-overlay w-80 max-w-[calc(100vw-2rem)] rounded-[var(--radius-lg)] border p-1.5 text-foreground"
            >
              <DropdownMenuItem
                className="rounded-[var(--radius-md)] px-3 py-2.5"
                onSelect={(e) => {
                  e.preventDefault();
                  setPlusMenuOpen(false);
                  window.setTimeout(() => fileInputRef.current?.click(), 0);
                }}
              >
                <Paperclip className="mr-2 h-4 w-4" />
                Add files
              </DropdownMenuItem>

              <button
                type="button"
                role="switch"
                aria-checked={activePlanMode}
                aria-label="Plan mode"
                data-testid="chat-plan-mode-toggle"
                title={PLAN_MODE_HELP_TEXT}
                className={cn(
                  "flex w-full cursor-pointer items-center justify-between gap-2 rounded-[var(--radius-md)] px-3 py-2.5 text-left text-sm outline-hidden transition-colors focus:bg-accent focus:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
                  activePlanMode
                    && "bg-[color:color-mix(in_oklab,var(--accent-soft)_72%,transparent)] text-foreground focus:bg-[color:color-mix(in_oklab,var(--accent-soft)_88%,transparent)]",
                )}
                onClick={(event) => {
                  event.preventDefault();
                  applyPlanMode(!activePlanMode);
                }}
              >
                <div className="flex min-w-0 items-center">
                  <ListChecks className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="font-medium text-foreground">Plan mode</div>
                </div>
                <span
                  aria-hidden="true"
                  data-testid="chat-plan-mode-track"
                  className={cn(
                    "relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-[background-color,border-color,box-shadow,opacity]",
                    activePlanMode
                      ? "border-[color:color-mix(in_oklab,var(--accent-base)_72%,white)] bg-[color:var(--accent-base)] text-primary-foreground shadow-[0_0_0_1px_color-mix(in_oklab,var(--accent-base)_22%,transparent),0_8px_22px_color-mix(in_oklab,var(--accent-base)_20%,transparent)]"
                      : "border-[color:color-mix(in_oklab,var(--border-soft)_82%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-inset)_92%,transparent)] text-muted-foreground",
                  )}
                >
                  <span
                    data-testid="chat-plan-mode-thumb"
                    className={cn(
                      "inline-block h-5 w-5 rounded-full border border-[color:color-mix(in_oklab,var(--border-soft)_80%,transparent)] bg-[color:var(--surface-elevated)] shadow-[0_4px_12px_rgb(0_0_0/0.18)] transition-transform",
                      activePlanMode ? "translate-x-5" : "translate-x-0.5",
                    )}
                  />
                </span>
              </button>

              <DropdownMenuSeparator className="panel-divider" />
              <DropdownMenuItem
                asChild
                className="rounded-[var(--radius-md)] px-3 py-2.5 text-muted-foreground focus:text-foreground"
              >
                <Link to="/organization/settings">Open chat settings</Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {activePlanMode ? (
            <button
              type="button"
              className="inline-flex max-w-[10rem] min-w-0 items-center gap-1.5 rounded-[var(--radius-md)] bg-[color:color-mix(in_oklab,var(--accent-soft)_78%,var(--surface-elevated))] px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-[color:color-mix(in_oklab,var(--accent-soft)_92%,var(--surface-elevated))] hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40"
              aria-label="Turn off plan mode"
              title={PLAN_MODE_HELP_TEXT}
              onClick={() => applyPlanMode(false)}
            >
              <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[color:color-mix(in_oklab,var(--ink-muted)_78%,transparent)] text-[color:var(--surface-elevated)]">
                <X className="h-3 w-3" strokeWidth={2.6} />
              </span>
              <span className="min-w-0 truncate">Plan</span>
            </button>
          ) : null}

          <button
            type="button"
            data-testid="chat-project-selector"
            aria-label={`Project context: ${projectPillLabel}`}
            aria-expanded={projectSelectionLocked ? false : projectMenuOpen}
            disabled={projectSelectionLocked}
            title={projectSelectionLocked ? "Project context is locked after conversation starts." : undefined}
            className={cn(
              "chat-chip inline-flex max-w-[min(100%,15rem)] min-w-0 items-center gap-1.5 rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium",
              projectSelectionLocked
                ? "cursor-default"
                : "transition-colors hover:bg-[color:var(--surface-active)]",
              projectMenuOpen && "bg-[color:var(--surface-active)]",
            )}
            onClick={() => {
              if (projectSelectionLocked) return;
              if (projectMenuOpen) {
                closeComposerContextMenus();
                return;
              }
              openComposerContextMenu("project");
            }}
          >
            <Folder className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate">{projectPillLabel}</span>
            {projectSelectionLocked ? null : (
              <ChevronDown data-testid="chat-project-selector-chevron" className="h-3 w-3 shrink-0 opacity-70" />
            )}
          </button>

          <button
            type="button"
            data-testid="chat-agent-selector"
            aria-expanded={agentMenuOpen}
            disabled={agentSelectionLocked}
            className={cn(
              "chat-chip inline-flex max-w-[min(100%,16rem)] min-w-0 items-center gap-1.5 rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium",
              agentSelectionLocked
                ? "cursor-default"
                : "transition-colors hover:bg-[color:var(--surface-active)]",
              agentMenuOpen && "bg-[color:var(--surface-active)]",
            )}
            onClick={() => {
              if (agentSelectionLocked) return;
              if (agentMenuOpen) {
                closeComposerContextMenus();
                return;
              }
              openComposerContextMenu("agent");
            }}
          >
            {activeSkillAgent ? (
              <span
                data-testid="chat-agent-selector-icon"
                className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted-foreground"
                aria-hidden="true"
              >
                <AgentIcon icon={activeSkillAgent.icon} role={activeSkillAgent.role} className="h-3.5 w-3.5" />
              </span>
            ) : null}
            <span className="min-w-0 truncate">{agentPillLabel}</span>
            {agentSelectionLocked ? null : (
              <ChevronDown data-testid="chat-agent-selector-chevron" className="h-3 w-3 shrink-0 opacity-70" />
            )}
          </button>

          {showChatSkillsPicker ? (
            <button
              type="button"
              className={cn(
                "chat-chip inline-flex max-w-[min(100%,16rem)] min-w-0 items-center gap-1.5 rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[color:var(--surface-active)]",
                skillMenuOpen && "bg-[color:var(--surface-active)]",
              )}
              aria-label="Skills"
              aria-expanded={skillMenuOpen}
              onClick={() => {
                if (skillMenuOpen) {
                  closeComposerContextMenus();
                  return;
                }
                openComposerContextMenu("skill");
              }}
            >
              <span className="min-w-0 truncate">Skills</span>
              <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
            </button>
          ) : null}
        </div>

        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            if (sendButtonMode === "stop" && selectedConversation) {
              stopStreaming(selectedConversation.id);
              return;
            }
            if (sendButtonMode === "send") {
              void sendMessage();
            }
          }}
          disabled={sendButtonDisabled}
          aria-busy={sendButtonMode === "sending" ? true : undefined}
          aria-label={
            sendButtonMode === "sending"
              ? "Sending"
              : sendButtonMode === "stop"
                ? "Stop streaming"
                : "Send"
          }
          className={cn(
            "shrink-0 rounded-full border-0 bg-white text-black shadow-sm",
            "hover:bg-zinc-100 dark:bg-white dark:text-black dark:hover:bg-zinc-100",
            "disabled:pointer-events-none disabled:opacity-35",
            "focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--surface-page)]",
            sendButtonMode === "sending" && "disabled:opacity-100",
          )}
        >
          {sendButtonMode === "sending" ? (
            <Loader2 className="h-[18px] w-[18px] animate-spin" strokeWidth={2.25} />
          ) : sendButtonMode === "stop" ? (
            <Square className="h-3.5 w-3.5 fill-current" />
          ) : (
            <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.25} />
          )}
        </Button>
      </div>

      {pendingFiles.length > 0 ? (
        <div data-testid="chat-pending-attachments" className="mt-2.5 flex flex-wrap gap-2">
          {pendingFiles.map((file) => {
            const fileKey = pendingAttachmentKey(file);
            return (
              <div
                key={fileKey}
                data-testid="chat-pending-attachment"
                className="max-w-full"
              >
                <PendingAttachmentPreview
                  file={file}
                  onOpenImage={setAttachmentPreview}
                  onRemove={() => removePendingFile(fileKey)}
                />
              </div>
            );
          })}
        </div>
      ) : null}

      {renderComposerContextMenu()}
    </div>
  );

  return (
    <div className="chat-shell flex min-h-[calc(100dvh-8rem)] flex-col overflow-hidden text-foreground md:-mx-3.5 md:h-full md:min-h-0 md:px-0 lg:-mx-5">
      <ChatAttachmentPreviewDialog
        preview={attachmentPreview}
        onOpenChange={(open) => {
          if (!open) setAttachmentPreview(null);
        }}
      />
      {loadErrorMessage ? (
        <div className="mx-6 mt-6 rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {loadErrorMessage}
        </div>
      ) : null}
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {!selectedOrganizationId ? (
            <div className="flex flex-1 items-center justify-center px-6 py-12 text-sm text-muted-foreground">
              Select a organization first.
            </div>
          ) : selectedConversation ? (
            <>
              {isMobile && conversations.length > 0 ? (
                <div className="shrink-0 border-b panel-divider px-4 py-2 md:hidden">
                  <div className="mx-auto w-full max-w-4xl">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-9 w-full justify-between gap-2 rounded-full px-3 font-normal"
                        >
                          <span className="truncate text-left text-foreground">{conversationDisplayTitle(selectedConversation)}</span>
                          <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="start"
                        className="surface-overlay max-h-[min(60vh,320px)] w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto text-foreground"
                      >
                        {conversations.map((c) => (
                          <DropdownMenuItem
                            key={c.id}
                            className={cn(c.id === selectedConversation.id && "bg-[color:var(--surface-active)]")}
                            onClick={() => {
                              void prefetchChatConversation(queryClient, c.id);
                              navigate(chatConversationPath(c.id));
                            }}
                            onPointerDown={() => {
                              if (c.id !== selectedConversation.id) {
                                void prefetchChatConversation(queryClient, c.id);
                              }
                            }}
                            onMouseEnter={() => {
                              if (c.id !== selectedConversation.id) {
                                void prefetchChatConversation(queryClient, c.id);
                              }
                            }}
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="truncate">{conversationDisplayTitle(c)}</span>
                              {c.isUnread ? (
                                <span className="inline-flex h-2 w-2 shrink-0 rounded-full bg-red-500" aria-label="Unread chat" />
                              ) : null}
                            </span>
                          </DropdownMenuItem>
                        ))}
                        <DropdownMenuSeparator className="panel-divider" />
                        <DropdownMenuItem
                          onClick={() => {
                            setDraft("");
                            clearPendingFilesForCurrentScope();
                            navigate(chatRootPath);
                          }}
                        >
                          <Plus className="mr-2 h-4 w-4" />
                          New chat
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              ) : null}

              <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-hidden px-4 py-4 md:px-5">
                <div
                  ref={chatMessagesScrollRef}
                  data-testid="chat-messages-scroll-region"
                  className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto"
                >
                  <div
                    data-testid="chat-messages-content"
                    className="mx-auto flex w-full max-w-4xl flex-col gap-5 pb-2 pr-1"
                  >
                      {showMessagesLoading ? (
                        <ChatMessagesLoadingState />
                      ) : visibleMessages.length === 0 && !activeStream ? (
                        <div className="surface-inset rounded-[var(--radius-xl)] border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
                          No messages yet. Start by describing the work and Rudder will clarify it first.
                        </div>
                      ) : (
                        <>
                          {visibleMessages.map((message) => {
                            const persistedTranscript = (message.transcript ?? []) as TranscriptEntry[];
                            const shouldRenderPersistedTranscript =
                              persistedTranscript.length > 0
                              && (message.role === "assistant"
                                || message.kind === "issue_proposal"
                                || message.kind === "operation_proposal");
                            const persistedProcessStartedAt = shouldRenderPersistedTranscript
                              ? resolvePersistedChatProcessStartedAt(visibleMessages, message, persistedTranscript)
                              : null;
                            const persistedProcessEndedAt = shouldRenderPersistedTranscript
                              ? resolvePersistedChatProcessEndedAt(message, persistedTranscript)
                              : null;

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
                                    defaultOpen={Boolean(openProcessMessageIds[message.id])}
                                    onOpenChange={(open) => setProcessOpenForMessage(message.id, open)}
                                  />
                                ) : null}
                                <ChatMessageItem
                                  conversation={selectedConversation}
                                  message={message}
                                  agents={agents}
                                  actionPending={
                                    approvalMutation.isPending
                                    || convertToIssueMutation.isPending
                                    || operationProposalMutation.isPending
                                  }
                                  decisionNote={decisionNotesByMessageId[message.id] ?? ""}
                                  onDecisionNoteChange={(value) => setDecisionNoteForMessage(message.id, value)}
                                  onApprovalAction={(approvalId, action, messageId) =>
                                    approvalMutation.mutate({ approvalId, action, messageId })}
                                  onResolveOperationProposal={(messageId, action, decisionNote) =>
                                    operationProposalMutation.mutate({
                                      chatId: selectedConversation.id,
                                      messageId,
                                      action,
                                      decisionNote,
                                    })
                                  }
                                  onConvertToIssue={(messageToConvert) =>
                                    convertToIssueMutation.mutate({
                                      chatId: selectedConversation.id,
                                      message: messageToConvert,
                                    })
                                  }
                                  onCopyMessageText={copyChatMessageText}
                                  onEditUserMessage={beginEditUserMessage}
                                  onContinueInterruptedMessage={() => {
                                    void sendMessage({
                                      bodyOverride: INTERRUPTED_CHAT_CONTINUATION_PROMPT,
                                      filesOverride: [],
                                      conversationOverride: selectedConversation,
                                    });
                                  }}
                                  onRetryFailedMessage={retryFailedMessage}
                                  onOpenImage={setAttachmentPreview}
                                  onOpenFile={openLocalFile}
                                  onMarkdownLinkClick={handleChatMarkdownLinkClick}
                                  turnBranchControls={turnBranchControlsFor(message)}
                                  skillReferences={chatSkillReferences}
                                  answered={isAskUserMessageAnswered(message, visibleMessages)}
                                  askUserAnswer={askUserAnswerFromMessage(message, visibleMessages)}
                                />
                              </Fragment>
                            );
                          })}
                          {activeStream ? (
                            <>
                              {showOptimisticUserMessage ? (
                                <OptimisticUserDraftItem
                                  body={activeStream.userBody}
                                  createdAt={activeStream.userCreatedAt}
                                  onCopyMessageText={copyChatMessageText}
                                  onEditDraftOnly={editDraftOnly}
                                  skillReferences={chatSkillReferences}
                                  onMarkdownLinkClick={handleChatMarkdownLinkClick}
                                  askUserAnswer={
                                    pendingAskUserRequest
                                      ? parseAskUserAnswerMessage(pendingAskUserRequest, activeStream.userBody)
                                      : null
                                  }
                                />
                              ) : null}
                              <StreamTranscriptItem
                                key={`${activeStream.chatId}-${activeStream.createdAt.getTime()}`}
                                entries={activeStream.transcript}
                                state={activeStream.state}
                                streamStartedAt={activeStream.createdAt}
                                assistantMessageBody={activeStream.body}
                                showDeveloperDiagnostics={showDeveloperDiagnostics}
                              />
                              <AssistantDraftItem
                                body={activeStream.body}
                                createdAt={activeStream.createdAt}
                                state={activeStream.state}
                                replyingAgentId={activeStream.replyingAgentId}
                                conversation={selectedConversation}
                                agents={agents}
                                onCopyMessageText={copyChatMessageText}
                                skillReferences={chatSkillReferences}
                                onMarkdownLinkClick={handleChatMarkdownLinkClick}
                              />
                            </>
                          ) : null}
                        </>
                      )}
                  </div>
                </div>

                {hasActionableApprovals || hasPendingLightweightProposal ? null : (
                  <div className="mx-auto w-full max-w-4xl shrink-0 space-y-4">
                    {pendingAskUserMessage && pendingAskUserRequest ? (
                      <AskUserPanel
                        message={pendingAskUserMessage}
                        request={pendingAskUserRequest}
                        disabled={controlsDisabled || composerUnavailable}
                        onSubmit={(body) => {
                          if (!selectedConversation) return;
                          void sendMessage({
                            bodyOverride: body,
                            filesOverride: [],
                            conversationOverride: selectedConversation,
                          });
                        }}
                      />
                    ) : (
                      renderComposer(false)
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-8">
              <div className="mx-auto flex w-full max-w-4xl flex-col items-center justify-center">
                <div className="mb-5 w-full max-w-3xl px-1 text-center">
                  <h1
                    key={emptyStateHeadingKey}
                    className="motion-chat-empty-heading max-w-full text-[2rem] leading-[1.1] tracking-normal text-foreground [overflow-wrap:anywhere] md:text-[2.3rem]"
                  >
                    {emptyStateHeading}
                  </h1>
                </div>

                <div className="w-full max-w-3xl">
                  {renderComposer(true)}
                </div>

                <div className="mt-4 flex max-w-3xl flex-wrap justify-center gap-2">
                  {EMPTY_STATE_PROMPT_GROUPS.map((group) => {
                    const expanded = expandedEmptyStatePrompt === group.label;
                    return (
                      <button
                        key={group.label}
                        type="button"
                        aria-expanded={expanded}
                        aria-controls={expanded ? emptyStatePromptOptionsId : undefined}
                        onClick={() => toggleEmptyStatePrompt(group.label)}
                        className={cn(
                          "chat-chip inline-flex items-center gap-2 rounded-[calc(var(--radius-sm)+2px)] px-4 py-2 text-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-[color:var(--surface-active)] hover:text-foreground",
                          expanded && "bg-[color:var(--surface-active)] text-foreground",
                        )}
                      >
                        <span>{group.label}</span>
                        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-200", expanded && "rotate-180")} />
                      </button>
                    );
                  })}
                </div>

                {expandedPromptGroup ? (
                  <ChatEmptyStatePromptOptions
                    group={expandedPromptGroup}
                    optionsId={emptyStatePromptOptionsId}
                    entered={emptyStatePromptPanelEntered}
                    originX={emptyStatePromptOriginX}
                    onExampleSelect={applyEmptyStateExample}
                  />
                ) : null}
              </div>
            </div>
          )}
      </main>
    </div>
  );
}
