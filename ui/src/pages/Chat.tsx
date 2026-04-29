import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Copy,
  Folder,
  Loader2,
  Paperclip,
  Pencil,
  Plus,
  Settings2,
  Square,
  Sparkles,
  X,
} from "lucide-react";
import {
  type Agent,
  type Approval,
  type ChatConversation,
  type ChatMessage,
  type ChatOperationProposalDecisionAction,
  type ChatOperationProposalDecisionStatus,
  type ChatPrimaryIssueSummary,
  type ChatUserInputOption,
  type ChatUserInputQuestion,
  type ChatUserInputRequest,
  type Issue,
  type MessengerThreadSummary,
  type Project,
} from "@rudderhq/shared";
import type { TranscriptEntry } from "@/agent-runtimes";
import { appendTranscriptEntry } from "@/agent-runtimes/transcript";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MarkdownBody } from "@/components/MarkdownBody";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "@/components/MarkdownEditor";
import { AgentIcon } from "@/components/AgentIconPicker";
import { HoverTimestampLabel } from "@/components/HoverTimestamp";
import { StatusBadge } from "@/components/StatusBadge";
import { RunTranscriptView } from "@/components/transcript/RunTranscriptView";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useOrganization } from "@/context/OrganizationContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useSidebar } from "@/context/SidebarContext";
import { useToast } from "@/context/ToastContext";
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
import { resolveRequestedPreferredAgentId } from "@/lib/chat-route-state";
import { buildChatSkillOptions, filterChatSkillOptions } from "@/lib/chat-skill-options";
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
  setChatFlagState,
  setChatScopedState,
} from "@/lib/chat-stream-state";
import { toOrganizationRelativePath } from "@/lib/organization-routes";
import {
  appendSkillReferencesToDraft,
} from "@/lib/organization-skill-picker";
import { formatAssigneeUserLabel } from "@/lib/assignees";
import { cn, relativeTime } from "@/lib/utils";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import { useI18n } from "@/context/I18nContext";

type ApprovalAction = "approve" | "reject" | "requestRevision";
type StreamDraftState = "streaming" | "finalizing" | "stopped" | "failed";
type PendingInitialSend = {
  chatId: string;
  body: string;
  files: File[];
};

type AttachmentPreviewState = {
  src: string;
  name: string;
};

type StreamDraft = {
  chatId: string;
  userBody: string;
  userCreatedAt: Date;
  userMessageId: string | null;
  editedFromCreatedAt: Date | null;
  body: string;
  state: StreamDraftState;
  createdAt: Date;
  transcript: TranscriptEntry[];
  replyingAgentId: string | null;
};

const EMPTY_STATE_PROMPT_GROUPS = [
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

function isImageAttachmentContentType(contentType: string | null | undefined) {
  return Boolean(contentType?.toLowerCase().startsWith("image/"));
}

function attachmentDisplayName(input: { originalFilename?: string | null; assetId?: string; name?: string }) {
  return input.originalFilename ?? input.name ?? input.assetId ?? "attachment";
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
  return (
    <div
      data-testid={testId}
      className="relative inline-flex max-w-full items-center gap-2 rounded-[calc(var(--radius-sm)+4px)] border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-active)_42%,transparent)] p-1.5"
    >
      <button
        type="button"
        aria-label={`Open image preview: ${name}`}
        className="flex min-w-0 items-center rounded-[calc(var(--radius-sm)+2px)] text-left transition-colors hover:bg-[color:var(--surface-active)]"
        onClick={onOpen}
      >
        <img
          src={src}
          alt={name}
          className="h-10 w-10 shrink-0 rounded-[calc(var(--radius-sm)+1px)] border border-black/5 object-cover"
        />
      </button>
      {onRemove ? (
        <button
          type="button"
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function ChatFileAttachmentChip({
  name,
  href,
  onRemove,
}: {
  name: string;
  href?: string;
  onRemove?: () => void;
}) {
  const content = (
    <>
      <Paperclip className="h-3 w-3 shrink-0" />
      <span className="truncate">{name}</span>
    </>
  );

  if (href) {
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
  const isImage = isImageAttachmentContentType(file.type);
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
}: {
  attachments: ChatMessage["attachments"];
  onOpenImage: (preview: AttachmentPreviewState) => void;
}) {
  if (attachments.length === 0) return null;

  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {attachments.map((attachment) => {
        const name = attachmentDisplayName(attachment);
        if (isImageAttachmentContentType(attachment.contentType)) {
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
        return <ChatFileAttachmentChip key={attachment.id} name={name} href={attachment.contentPath} />;
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
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    if (!preview?.src) {
      setNaturalSize(null);
      return;
    }
    const image = new window.Image();
    image.onload = () => {
      setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      setNaturalSize(null);
    };
    image.src = preview.src;
    return () => {
      image.onload = null;
      image.onerror = null;
    };
  }, [preview?.src]);

  const dialogWidth = naturalSize
    ? `min(calc(100vw - 1.5rem), ${naturalSize.width}px, 1440px)`
    : "min(calc(100vw - 1.5rem), 1440px)";

  return (
    <Dialog open={preview !== null} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="rudder-markdown-editor-image-preview-panel top-[50%] w-fit translate-y-[-50%] border-0 bg-transparent p-0 shadow-none"
        style={{ maxWidth: dialogWidth }}
      >
        <DialogTitle className="sr-only">{preview?.name ?? "Attachment preview"}</DialogTitle>
        {preview ? (
          <div
            data-testid="chat-image-preview-dialog"
            className="rudder-markdown-editor-image-preview-media relative flex w-fit max-w-full items-center justify-center overflow-hidden"
          >
            <DialogClose className="absolute right-2 top-2 z-10 flex size-8 items-center justify-center rounded-sm bg-black/55 text-white shadow-[0_6px_18px_rgb(0_0_0/0.28)] transition-colors hover:bg-black/70 focus:outline-none focus:ring-2 focus:ring-white/80">
              <X className="size-4" aria-hidden="true" />
              <span className="sr-only">Close image preview</span>
            </DialogClose>
            <img
              src={preview.src}
              alt={preview.name}
              className="chat-attachment-preview-image"
            />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const RUDDER_COPILOT_LABEL = "Rudder Copilot";
const PLAN_MODE_HELP_TEXT =
  "Read-only planning. The agent can ask structured blocking questions, then produce a plan and create an issue with that plan attached.";

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

function computeDisplayedChatMessages(
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
  const times = turnSlice.map((m) => new Date(m.createdAt).getTime());
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const prefix = sorted.filter(
    (m) => !m.supersededAt && new Date(m.createdAt).getTime() < tMin,
  );
  const suffix = sorted.filter(
    (m) =>
      !m.supersededAt
      && new Date(m.createdAt).getTime() > tMax
      && m.chatTurnId !== tid,
  );
  const mid = [...turnSlice].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  return [...prefix, ...mid, ...suffix];
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
  const preview = fallbackPreview?.trim();
  return preview
    || conversation.latestReplyPreview
    || conversation.summary
    || "Start the conversation";
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
    title: conversation.title,
    subtitle: preview,
    preview,
    latestActivityAt: options?.latestActivityAt ?? conversation.lastMessageAt ?? conversation.updatedAt,
    lastReadAt: conversation.lastReadAt,
    unreadCount: conversation.unreadCount,
    needsAttention: conversation.needsAttention,
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

function withOptimisticOutgoingMessage(
  conversation: ChatConversation,
  body: string,
  sentAt: Date,
): ChatConversation {
  const preview = body.trim();
  if (!preview) return conversation;
  return {
    ...conversation,
    summary: conversation.summary ?? preview,
    lastMessageAt: sentAt,
    updatedAt: sentAt,
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function userInputRequestFromMessage(message: ChatMessage): ChatUserInputRequest | null {
  const payload = message.structuredPayload;
  if (!payload || !isRecord(payload.requestUserInput)) return null;
  const rawQuestions = Array.isArray(payload.requestUserInput.questions)
    ? payload.requestUserInput.questions
    : [];
  const questions = rawQuestions
    .map((questionRaw, questionIndex): ChatUserInputQuestion | null => {
      if (!isRecord(questionRaw)) return null;
      const question = typeof questionRaw.question === "string" ? questionRaw.question.trim() : "";
      if (!question) return null;
      const rawOptions = Array.isArray(questionRaw.options) ? questionRaw.options : [];
      const options = rawOptions
        .map((optionRaw, optionIndex): ChatUserInputOption | null => {
          if (!isRecord(optionRaw)) return null;
          const label = typeof optionRaw.label === "string" ? optionRaw.label.trim() : "";
          if (!label) return null;
          const id = typeof optionRaw.id === "string" && optionRaw.id.trim()
            ? optionRaw.id.trim()
            : `option_${optionIndex + 1}`;
          const description = typeof optionRaw.description === "string" && optionRaw.description.trim()
            ? optionRaw.description.trim()
            : null;
          return { id, label, description };
        })
        .filter((option): option is ChatUserInputOption => Boolean(option));
      if (options.length < 2) return null;
      const id = typeof questionRaw.id === "string" && questionRaw.id.trim()
        ? questionRaw.id.trim()
        : `question_${questionIndex + 1}`;
      const header = typeof questionRaw.header === "string" && questionRaw.header.trim()
        ? questionRaw.header.trim()
        : `Question ${questionIndex + 1}`;
      return { id, header, question, options };
    })
    .filter((question): question is ChatUserInputQuestion => Boolean(question));
  return questions.length > 0 ? { questions } : null;
}

function formatUserInputAnswer(
  request: ChatUserInputRequest,
  selections: Record<string, string>,
) {
  const answers = request.questions
    .map((question) => {
      const option = question.options.find((candidate) => candidate.id === selections[question.id]);
      if (!option) return null;
      return `- ${question.header}: ${option.label}`;
    })
    .filter((line): line is string => Boolean(line));
  return [
    "Selected answers for request_user_input:",
    ...answers,
  ].join("\n");
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

function proposalReviewTitle(message: ChatMessage) {
  return message.kind === "issue_proposal" ? "Review proposed issue" : "Review lightweight change";
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


function formatChatPrimaryIssueBreadcrumb(issue: ChatPrimaryIssueSummary): string {
  const idPart = issue.identifier?.trim() || null;
  const titlePart = issue.title?.trim() || null;
  if (idPart && titlePart) return `${idPart} · ${titlePart}`;
  return idPart ?? titlePart ?? issue.id;
}

function assistantStateLabel(state: StreamDraftState | ChatMessage["status"]) {
  if (state === "streaming") return "Streaming";
  if (state === "finalizing") return "Finalizing";
  if (state === "stopped") return "Stopped";
  if (state === "failed") return "Failed";
  return null;
}

function statusChipClassName(state: StreamDraftState | ChatMessage["status"]) {
  return state === "failed"
    ? "border-destructive/30 bg-destructive/10 text-destructive"
    : "chat-chip";
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
  const sourceType = conversation.chatRuntime?.sourceType;
  const fallbackLabel =
    conversation.chatRuntime?.sourceLabel ?? (sourceType === "copilot" ? RUDDER_COPILOT_LABEL : "Rudder");
  const label = agent?.name ?? fallbackLabel;

  return (
    <div className="mb-2 flex items-center gap-2.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted/90 text-foreground shadow-sm">
        {agent ? (
          <AgentIcon icon={agent.icon} className="h-4 w-4" />
        ) : sourceType === "copilot" ? (
          <Sparkles className="h-4 w-4 text-muted-foreground" />
        ) : replyingAgentId ? (
          <Bot className="h-4 w-4 text-muted-foreground" />
        ) : (
          <Sparkles className="h-4 w-4 text-muted-foreground" />
        )}
      </span>
      <span className="text-sm font-semibold tracking-tight text-foreground">{label}</span>
    </div>
  );
}

function RequestUserInputCard({
  request,
  onSubmit,
  disabled,
}: {
  request: ChatUserInputRequest;
  onSubmit: (answer: string) => void;
  disabled?: boolean;
}) {
  const [selections, setSelections] = useState<Record<string, string>>({});
  const allSelected = request.questions.every((question) => Boolean(selections[question.id]));

  return (
    <div
      data-testid="chat-user-input-request"
      className="mt-4 max-w-[72ch] rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] bg-[color:var(--surface-panel)] p-4"
    >
      <div className="mb-3 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <CircleHelp className="h-4 w-4" />
        <span>request_user_input</span>
      </div>
      <div className="space-y-4">
        {request.questions.map((question) => (
          <div key={question.id} className="space-y-2">
            <div className="text-[11px] font-medium uppercase text-muted-foreground">{question.header}</div>
            <div className="text-sm font-medium leading-6 text-foreground">{question.question}</div>
            <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label={question.question}>
              {question.options.map((option) => {
                const selected = selections[question.id] === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={selected}
                    disabled={disabled}
                    className={cn(
                      "min-h-16 rounded-[var(--radius-md)] border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      selected
                        ? "border-[color:var(--accent-strong)] bg-[color:var(--accent-soft)] text-foreground"
                        : "border-[color:var(--border-soft)] bg-[color:var(--surface-base)] text-foreground hover:bg-[color:var(--surface-active)]",
                    )}
                    onClick={() => setSelections((current) => ({ ...current, [question.id]: option.id }))}
                  >
                    <span className="block text-sm font-medium leading-5">{option.label}</span>
                    {option.description ? (
                      <span className="mt-1 block text-xs leading-5 text-muted-foreground">{option.description}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 flex justify-end">
        <Button
          size="sm"
          disabled={!allSelected || disabled}
          data-testid="chat-user-input-submit"
          onClick={() => {
            if (!allSelected) return;
            onSubmit(formatUserInputAnswer(request, selections));
          }}
        >
          <ArrowUp className="mr-1.5 h-3.5 w-3.5" />
          Send answer
        </Button>
      </div>
    </div>
  );
}

function ProposalCard({
  conversation,
  message,
  agents,
  decisionNote,
  onDecisionNoteChange,
  onApprovalAction,
  onResolveOperationProposal,
  onConvertToIssue,
  actionPending,
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

  return (
    <div
      data-testid="proposal-review-block"
      data-status={reviewStatus ?? "default"}
      className="chat-review-block rounded-[var(--radius-xl)] p-5 text-foreground transition-all duration-200"
    >
      <ChatAssistantAttributionRow
        replyingAgentId={message.replyingAgentId ?? null}
        conversation={conversation}
        agents={agents}
      />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium text-muted-foreground">
            {message.kind === "issue_proposal" ? <Sparkles className="h-3.5 w-3.5" /> : <Settings2 className="h-3.5 w-3.5" />}
            <span>{proposalReviewTitle(message)}</span>
          </div>
          {reviewBanner ? (
            <p className="mt-3 text-sm leading-6 text-foreground/90">
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

      {message.body.trim().length > 0 ? (
        <div className="chat-review-summary mt-4 rounded-[var(--radius-lg)] px-4 py-3">
          <div className="text-[11px] font-medium text-muted-foreground">Proposal context</div>
          <div className="mt-2 text-sm leading-6 text-muted-foreground">
            <MarkdownBody>{message.body}</MarkdownBody>
          </div>
        </div>
      ) : null}

      {issueProposal ? (
        <div className="chat-proposal-inset mt-4 rounded-[var(--radius-lg)] p-4">
          <div className="text-base font-medium text-foreground">{String(issueProposal.title)}</div>
          <div className="mt-1 text-xs font-medium text-muted-foreground">
            Priority · {String(issueProposal.priority ?? "medium")}
          </div>
          <div className="mt-3 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
            {String(issueProposal.description)}
          </div>
        </div>
      ) : null}

      {planDocument ? (
        <div className="chat-proposal-inset mt-4 rounded-[var(--radius-lg)] p-4">
          <div className="text-[11px] font-medium text-muted-foreground">{planDocument.title}</div>
          <div className="mt-3 text-sm leading-6 text-foreground">
            <MarkdownBody>{planDocument.body}</MarkdownBody>
          </div>
        </div>
      ) : null}

      {operationProposal ? (
        <div className="chat-proposal-inset mt-4 rounded-[var(--radius-lg)] p-4">
          <div className="text-base font-medium text-foreground">{String(operationProposal.summary)}</div>
          <div className="mt-1 text-xs font-medium text-muted-foreground">
            Target · {String(operationProposal.targetType)}:{String(operationProposal.targetId)}
          </div>
          {operationProposal.patch && typeof operationProposal.patch === "object" ? (
            <pre className="chat-proposal-inset mt-3 overflow-x-auto rounded-2xl p-3 text-xs text-muted-foreground">
              {JSON.stringify(operationProposal.patch, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}

      {(showDecisionNote || showApprovalActions || showOperationActions || canConvertDirectly || message.approval?.decisionNote) ? (
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
  );
}

const chatMessageHoverBarClass =
  "opacity-0 pointer-events-none transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100";

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
  onOpenImage,
  onSubmitUserInput,
  userInputRequestDisabled,
  turnBranchControls,
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
  onOpenImage: (preview: AttachmentPreviewState) => void;
  onSubmitUserInput: (answer: string) => void;
  userInputRequestDisabled?: boolean;
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
      />
    );
  }

  if (message.role === "system") {
    return (
      <div className="chat-system-pill rounded-[calc(var(--radius-sm)+2px)] px-4 py-2 text-sm transition-all duration-200">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-[color:var(--accent-strong)]" />
          <MarkdownBody>{message.body}</MarkdownBody>
        </div>
      </div>
    );
  }

  const isUser = message.role === "user";
  const statusLabel = !isUser ? assistantStateLabel(message.status) : null;
  const userInputRequest = message.kind === "user_input_request"
    ? userInputRequestFromMessage(message)
    : null;

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
            </div>
          ) : null}
          <div className="max-w-[72ch] text-[15px] leading-7 text-foreground">
            <MarkdownBody>{message.body}</MarkdownBody>
          </div>
          {userInputRequest ? (
            <RequestUserInputCard
              request={userInputRequest}
              onSubmit={onSubmitUserInput}
              disabled={userInputRequestDisabled}
            />
          ) : null}
          <ChatAttachmentList attachments={message.attachments} onOpenImage={onOpenImage} />
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
        <div
          data-testid="chat-user-message-bubble"
          className="chat-message-user w-fit max-w-[min(100%,72ch)] rounded-[var(--radius-xl)] px-4 py-3 shadow-[var(--shadow-sm)]"
        >
          <div className="text-[15px] leading-7">
            <MarkdownBody>{message.body}</MarkdownBody>
          </div>
          <ChatAttachmentList attachments={message.attachments} onOpenImage={onOpenImage} />
        </div>
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
}: {
  body: string;
  createdAt: Date;
  onCopyMessageText: (text: string) => void | Promise<void>;
  onEditDraftOnly: (text: string) => void;
}) {
  return (
    <div className="flex justify-end transition-all duration-200">
      <div className="group flex max-w-[82%] flex-col items-end text-left">
        <div className="chat-message-user w-fit max-w-[min(100%,72ch)] rounded-[var(--radius-xl)] px-4 py-3 shadow-[var(--shadow-sm)]">
          <div className="text-[15px] leading-7">
            <MarkdownBody>{body}</MarkdownBody>
          </div>
        </div>
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
}: {
  entries: TranscriptEntry[];
  state: StreamDraftState | ChatMessage["status"];
  streamStartedAt: Date;
  streamEndedAt?: Date | null;
}) {
  const streamingActive = state === "streaming" || state === "finalizing";
  const [processOpen, setProcessOpen] = useState(() => streamingActive);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!streamingActive) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [streamingActive]);

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
              if (!streamingActive) setProcessOpen((open) => !open);
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
          <div className="mt-3 border-l border-border/35 pl-3">
            <RunTranscriptView
              entries={entries}
              mode="nice"
              density="compact"
              streaming={streamingActive}
              collapseStdout
              presentation="chat"
              className="space-y-2"
              thinkingClassName="rounded-md border border-border/30 bg-muted/10 px-2 py-2 [&>*:first-child]:mt-0"
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
}: {
  body: string;
  createdAt: Date;
  state: StreamDraftState;
  replyingAgentId: string | null;
  conversation: ChatConversation;
  agents: Agent[] | undefined;
  onCopyMessageText: (text: string) => void | Promise<void>;
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
          {body.trim() ? <MarkdownBody>{body}</MarkdownBody> : <span className="text-muted-foreground">Thinking...</span>}
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
  const draftStorageOrgId = selectedOrganizationId!;
  const draftStorageConversationId = conversationId ?? null;
  const draftStorageScopeKey = `${draftStorageOrgId}:${draftStorageConversationId ?? "__new__"}`;
  const [draftState, setDraftState] = useState(() => ({
    scopeKey: draftStorageScopeKey,
    value: readChatDraft(draftStorageOrgId, draftStorageConversationId),
  }));
  const draft = draftState.scopeKey === draftStorageScopeKey ? draftState.value : "";
  const setDraft = useCallback((nextDraft: string) => {
    setDraftState((current) => ({ ...current, value: nextDraft }));
  }, []);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [sendInFlightByChatId, setSendInFlightByChatId] = useState<Record<string, true>>({});
  const [newConversationSendInFlight, setNewConversationSendInFlight] = useState(false);
  const [streamDrafts, setStreamDrafts] = useState<Record<string, StreamDraft>>({});
  const [draftPreferredAgentId, setDraftPreferredAgentId] = useState<string>("__none__");
  const [draftProjectId, setDraftProjectId] = useState<string>(NO_PROJECT_ID);
  const [draftPlanMode, setDraftPlanMode] = useState(false);
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
  const skillSearchInputRef = useRef<HTMLInputElement>(null);
  const streamAbortControllersRef = useRef<Record<string, AbortController>>({});
  const stopRequestedChatIdsRef = useRef<Set<string>>(new Set());
  const pendingInitialSendRef = useRef<PendingInitialSend | null>(null);
  const newConversationSendLockRef = useRef(false);
  const chatSendLocksRef = useRef<Record<string, true>>({});
  const lastAppliedPrefillRef = useRef<string | null>(null);
  const lastAppliedAgentPrefillRef = useRef<string | null>(null);
  const projectDefaultInitializedRef = useRef(false);
  const { isMobile } = useSidebar();
  const chatMessagesScrollRef = useScrollbarActivityRef();
  const pendingPrefill = searchParams.get("prefill")?.trim() ?? "";
  const pendingAgentPrefill = searchParams.get("agentId")?.trim() ?? "";
  const relativePath = toOrganizationRelativePath(location.pathname);
  const chatRouteBase = relativePath.startsWith("/messenger/chat") ? "/messenger/chat" : "/chat";
  const chatRootPath = chatRouteBase;
  const chatConversationPath = useCallback((id: string) => `${chatRouteBase}/${id}`, [chatRouteBase]);
  const composerContextMenuOpen = projectMenuOpen || agentMenuOpen || skillMenuOpen;

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
        setPendingFiles((current) => [...current, ...safeFiles]);
      } catch (error) {
        pushToast({
          title: "Failed to stage attachment",
          body: error instanceof Error ? error.message : undefined,
          tone: "error",
        });
      }
    },
    [pushToast],
  );

  const removePendingFile = useCallback((targetKey: string) => {
    setPendingFiles((current) => current.filter((file) => pendingAttachmentKey(file) !== targetKey));
  }, []);

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

  useEffect(() => {
    if (pendingPrefill) return;
    if (!pendingAgentPrefill) return;
    if (pendingAgentPrefill === lastAppliedAgentPrefillRef.current) return;

    const consumePendingAgentPrefill = () => {
      lastAppliedAgentPrefillRef.current = pendingAgentPrefill;
      const nextSearch = new URLSearchParams(searchParams);
      nextSearch.delete("agentId");
      navigate(
        {
          pathname: conversationId ? chatConversationPath(conversationId) : chatRootPath,
          search: nextSearch.toString() ? `?${nextSearch.toString()}` : "",
        },
        { replace: true },
      );
    };

    if (conversationId) {
      consumePendingAgentPrefill();
      return;
    }

    if (!agents) return;

    const requestedAgentId = resolveRequestedPreferredAgentId(pendingAgentPrefill, agents);
    if (requestedAgentId) {
      setDraftPreferredAgentId(requestedAgentId);
    }
    consumePendingAgentPrefill();
  }, [
    agents,
    chatConversationPath,
    chatRootPath,
    conversationId,
    navigate,
    pendingPrefill,
    pendingAgentPrefill,
    searchParams,
  ]);

  const selectedConversation = conversationQuery.data
    ?? conversationsQuery.data?.find((conversation) => conversation.id === conversationId)
    ?? null;
  const activeAgentId = selectedConversation?.preferredAgentId ?? draftPreferredAgentId;
  const selectedConversationProjectId = projectContextId(selectedConversation);
  const activeProjectId = selectedConversation ? (selectedConversationProjectId ?? NO_PROJECT_ID) : draftProjectId;
  const activePlanMode = selectedConversation?.planMode ?? draftPlanMode;
  const activeSkillAgentId = activeAgentId === "__none__" ? null : activeAgentId;
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
    setDraftPreferredAgentId(selectedConversation.preferredAgentId ?? "__none__");
    setDraftPlanMode(selectedConversation.planMode);
  }, [
    selectedConversation?.id,
    selectedConversation?.preferredAgentId,
    selectedConversation?.planMode,
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

  const setChatSendInFlight = useCallback((chatId: string, inFlight: boolean) => {
    setSendInFlightByChatId((current) => setChatFlagState(current, chatId, inFlight));
  }, []);

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

  const setStreamDraftForChat = useCallback((
    chatId: string,
    nextDraft:
      | StreamDraft
      | null
      | ((current: StreamDraft | null) => StreamDraft | null),
  ) => {
    setStreamDrafts((current) => {
      const existing = current[chatId] ?? null;
      const resolved =
        typeof nextDraft === "function"
          ? nextDraft(existing)
          : nextDraft;
      return setChatScopedState(current, chatId, resolved);
    });
  }, []);

  const clearAbortControllerForChat = useCallback((chatId: string) => {
    if (!(chatId in streamAbortControllersRef.current)) return;
    const { [chatId]: _removed, ...rest } = streamAbortControllersRef.current;
    streamAbortControllersRef.current = rest;
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
    mutationFn: ({ chatId, projectId }: { chatId: string; projectId: string | null }) =>
      chatsApi.setProjectContext(chatId, projectId),
    onSuccess: async (conversation) => {
      if (selectedOrganizationId) {
        rememberChatProjectId(selectedOrganizationId, projectContextId(conversation));
      }
      upsertConversation(conversation);
      upsertMessengerThreadSummary(conversation);
      await refreshChat(conversation.id);
    },
    onError: (error) => {
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
    streamAbortControllersRef.current[chatId]?.abort();
    setStreamDraftForChat(chatId, (current) => (current ? { ...current, state: "stopped" } : current));
  }, [pushToast, setStreamDraftForChat]);

  const sendMessage = async (
    options?: {
      bodyOverride?: string;
      filesOverride?: File[];
      conversationOverride?: ChatConversation;
    },
  ) => {
    if (!selectedOrganizationId) {
      pushToast({ title: "Select a organization first", tone: "error" });
      return;
    }

    const body = (options?.bodyOverride ?? draft).trim();
    if (!body) {
      pushToast({ title: "Message cannot be empty", tone: "error" });
      return;
    }

    const filesToUpload = [...(options?.filesOverride ?? pendingFiles)];
    const editUserMessageId = editForkUserMessageId;
    const editTargetMessage = editUserMessageId
      ? rawMessages.find((message) => message.id === editUserMessageId) ?? null
      : null;

    let conversation = options?.conversationOverride ?? selectedConversation;
    let activeChatId: string | null = null;
    let newConversationLockAcquired = false;
    let chatSendLockAcquired = false;
    try {
      if (!conversation) {
        if (!acquireNewConversationSendLock()) return;
        newConversationLockAcquired = true;
        const createdConversation = await chatsApi.create(selectedOrganizationId, {
          preferredAgentId: draftPreferredAgentId === "__none__" ? null : draftPreferredAgentId,
          issueCreationMode: "manual_approval",
          planMode: draftPlanMode,
          contextLinks: draftProjectId === NO_PROJECT_ID
            ? []
            : [{ entityType: "project", entityId: draftProjectId }],
        });
        const startedAt = new Date();
        conversation = upsertOptimisticConversation(createdConversation, body, startedAt);
        pendingInitialSendRef.current = {
          chatId: conversation.id,
          body,
          files: filesToUpload,
        };
        setDraft("");
        setPendingFiles([]);
        setEditForkUserMessageId(null);
        setBranchPreview(null);
        navigate(chatConversationPath(conversation.id));
        return;
      }

      const chatId = conversation.id;
      if (!acquireChatSendLock(chatId)) return;
      chatSendLockAcquired = true;
      activeChatId = chatId;
      if (newConversationLockAcquired || newConversationSendLockRef.current) {
        releaseNewConversationSendLock();
        newConversationLockAcquired = false;
      }

      setEditForkUserMessageId(null);
      setBranchPreview(null);
      setDraft("");
      setPendingFiles([]);
      setChatSendInFlight(chatId, true);
      stopRequestedChatIdsRef.current.delete(chatId);
      const abortController = new AbortController();
      streamAbortControllersRef.current = {
        ...streamAbortControllersRef.current,
        [chatId]: abortController,
      };
      const startedAt = new Date();
      conversation = upsertOptimisticConversation(conversation, body, startedAt);
      setStreamDraftForChat(chatId, {
        chatId,
        userBody: body,
        userCreatedAt: startedAt,
        userMessageId: null,
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
            upsertMessages(chatId, [event.userMessage]);
            setStreamDraftForChat(
              chatId,
              (current) => (current ? { ...current, userMessageId: event.userMessage.id } : current),
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
            upsertMessages(chatId, event.messages);
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
        clearAbortControllerForChat(activeChatId);
        stopRequestedChatIdsRef.current.delete(activeChatId);
        if (chatSendLockAcquired) {
          releaseChatSendLock(activeChatId);
        }
        setChatSendInFlight(activeChatId, false);
      }
      if (newConversationLockAcquired && !pendingInitialSendRef.current) {
        releaseNewConversationSendLock();
      }
    }
  };

  useEffect(() => {
    if (!selectedConversation || sendInFlightByChatId[selectedConversation.id]) return;
    if (!pendingInitialSendRef.current || pendingInitialSendRef.current.chatId !== selectedConversation.id) return;

    const nextSend = pendingInitialSendRef.current;
    pendingInitialSendRef.current = null;
    void sendMessage({
      conversationOverride: selectedConversation,
      bodyOverride: nextSend.body,
      filesOverride: nextSend.files,
    });
  }, [selectedConversation, sendInFlightByChatId]);

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
      .filter((message) => !message.supersededAt && message.role !== "user")
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
  const agentSelectionLocked = Boolean(
    selectedConversation
    && (
      selectedConversation.lastMessageAt
      || rawMessages.length > 0
      || activeStream
      || activeSendInFlight
    ),
  );
  const activeEditCutoffMs = activeStream?.editedFromCreatedAt
    ? activeStream.editedFromCreatedAt.getTime()
    : null;
  const visibleMessages = activeEditCutoffMs === null
    ? displayedMessages
    : displayedMessages.filter((message) => new Date(message.createdAt).getTime() < activeEditCutoffMs);
  const messageHasFollowingUserReply = useCallback(
    (message: ChatMessage) => {
      const messageCreatedAt = new Date(message.createdAt).getTime();
      return visibleMessages.some(
        (candidate) =>
          candidate.role === "user"
          && candidate.kind === "message"
          && new Date(candidate.createdAt).getTime() > messageCreatedAt,
      );
    },
    [visibleMessages],
  );
  const lastMarkedReadKeyRef = useRef<string | null>(null);

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
  const organizationDefaultConfigured = Boolean(selectedOrganization?.defaultChatAgentRuntimeType);
  const composerUnavailable =
    selectedConversation
      ? !selectedConversation.chatRuntime.available
      : activeAgentId === "__none__" && !organizationDefaultConfigured;
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
    activeAgentId === "__none__"
      ? RUDDER_COPILOT_LABEL
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

    setDraftPreferredAgentId(value);
    setAgentMenuOpen(false);
    if (selectedConversation) {
      updateConversationMutation.mutate({
        chatId: selectedConversation.id,
        data: { preferredAgentId: value === "__none__" ? null : value },
      });
    }
  };

  const applyProjectContext = (value: string) => {
    const projectId = value === NO_PROJECT_ID ? null : value;
    setDraftProjectId(value);
    setProjectMenuOpen(false);
    if (selectedOrganizationId) {
      rememberChatProjectId(selectedOrganizationId, projectId);
    }
    if (selectedConversation) {
      updateProjectContextMutation.mutate({
        chatId: selectedConversation.id,
        projectId,
      });
    }
  };

  const applyPlanMode = (value: boolean) => {
    setDraftPlanMode(value);
    if (selectedConversation) {
      updateConversationMutation.mutate({
        chatId: selectedConversation.id,
        data: { planMode: value },
      });
    }
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
    setPendingFiles([]);
    requestAnimationFrame(() => {
      composerEditorRef.current?.focus();
    });
  }, []);

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
  const emptyStateHeading = userNickname
    ? t("chat.emptyState.headingNamed", { name: userNickname })
    : t("chat.emptyState.heading");
  const composerPlaceholder = t("chat.composer.placeholder");
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
    const liveAgents = (agents ?? []).filter((agent) => agent.status !== "terminated");

    return createPortal(
      <div
        ref={composerContextMenuRef}
        data-testid={`chat-${activeMenu}-menu`}
        role="menu"
        className="chat-composer-context-menu surface-overlay fixed z-50 overflow-y-auto rounded-[var(--radius-lg)] border p-1.5 text-foreground"
        style={composerMenuPosition}
      >
        {projectMenuOpen ? (
          <>
            <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">Project context</div>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={activeProjectId === NO_PROJECT_ID}
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
                        {project.resources.length} resources
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
            <button
              type="button"
              role="menuitemradio"
              aria-checked={activeAgentId === "__none__"}
              className="chat-composer-menu-row"
              onClick={() => applyPreferredAgent("__none__")}
            >
              <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{RUDDER_COPILOT_LABEL}</span>
                <span className="block truncate text-xs text-muted-foreground">Default chat runtime</span>
              </span>
            </button>
            {liveAgents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                role="menuitemradio"
                aria-checked={activeAgentId === agent.id}
                className="chat-composer-menu-row"
                onClick={() => applyPreferredAgent(agent.id)}
              >
                <AgentIcon icon={agent.icon} className="h-4 w-4 shrink-0 text-muted-foreground" />
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
                      className="chat-composer-menu-row"
                      onClick={() => insertSkillReference(entry)}
                    >
                      <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="flex min-w-0 flex-1 items-baseline gap-3">
                        <span className="shrink-0 truncate font-medium text-foreground">
                          {entry.skillDisplayName}
                        </span>
                        <span className="min-w-0 truncate text-muted-foreground">
                          {entry.skillDescription ?? entry.skillRefLabel}
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
      <div onPasteCapture={handleComposerPasteCapture}>
        <MarkdownEditor
          ref={composerEditorRef}
          value={draft}
          onChange={setDraft}
          mentions={mentionOptions}
          mentionMenuAnchorRef={composerSurfaceRef}
          mentionMenuPlacement="container"
          submitShortcut="enter"
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
          {selectedConversation?.chatRuntime.error ??
            `Choose ${RUDDER_COPILOT_LABEL} or a specific agent, or configure Copilot in Company Settings before sending messages.`}{" "}
          <Link to="/organization/settings" className="underline underline-offset-4 hover:text-foreground">
            Open settings
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

              <DropdownMenuItem
                className="justify-between rounded-[var(--radius-md)] px-3 py-2.5"
                onSelect={(event) => event.preventDefault()}
              >
                <div className="flex min-w-0 items-center">
                  <Pencil className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="flex min-w-0 items-center gap-1.5">
                    <div className="font-medium text-foreground">Plan mode</div>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label="About plan mode"
                          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                        >
                          <CircleHelp className="h-3.5 w-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="right" sideOffset={8} className="max-w-[280px] px-3 py-2 text-xs leading-5">
                        {PLAN_MODE_HELP_TEXT}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </div>
                <ToggleSwitch
                  checked={activePlanMode}
                  size="md"
                  tone="accent"
                  aria-label="Plan mode"
                  data-testid="chat-plan-mode-toggle"
                  className="mt-0.5"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    applyPlanMode(!activePlanMode);
                  }}
                />
              </DropdownMenuItem>

              <DropdownMenuSeparator className="panel-divider" />
              <DropdownMenuItem
                asChild
                className="rounded-[var(--radius-md)] px-3 py-2.5 text-muted-foreground focus:text-foreground"
              >
                <Link to="/organization/settings">Open chat settings</Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <button
            type="button"
            data-testid="chat-project-selector"
            aria-label={`Project context: ${projectPillLabel}`}
            aria-expanded={projectMenuOpen}
            className={cn(
              "chat-chip inline-flex max-w-[min(100%,15rem)] min-w-0 items-center gap-1.5 rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[color:var(--surface-active)]",
              projectMenuOpen && "bg-[color:var(--surface-active)]",
            )}
            onClick={() => {
              if (projectMenuOpen) {
                closeComposerContextMenus();
                return;
              }
              openComposerContextMenu("project");
            }}
          >
            <Folder className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate">{projectPillLabel}</span>
            <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
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
            <span className="min-w-0 truncate">{agentPillLabel}</span>
            {agentSelectionLocked ? null : <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />}
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

      <ChatAttachmentPreviewDialog
        preview={attachmentPreview}
        onOpenChange={(open) => {
          if (!open) setAttachmentPreview(null);
        }}
      />

      {renderComposerContextMenu()}
    </div>
  );

  return (
    <div className="chat-shell flex min-h-[calc(100dvh-8rem)] flex-col overflow-hidden text-foreground md:-mx-6 md:h-full md:min-h-0 md:px-0 lg:-mx-7">
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
                          <span className="truncate text-left text-foreground">{selectedConversation.title}</span>
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
                              <span className="truncate">{c.title}</span>
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
                            setPendingFiles([]);
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
                                  onOpenImage={setAttachmentPreview}
                                  onSubmitUserInput={(answer) => {
                                    void sendMessage({ bodyOverride: answer });
                                  }}
                                  userInputRequestDisabled={
                                    activeSendInFlight
                                    || (
                                      message.kind === "user_input_request"
                                      && messageHasFollowingUserReply(message)
                                    )
                                  }
                                  turnBranchControls={turnBranchControlsFor(message)}
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
                                />
                              ) : null}
                              <StreamTranscriptItem
                                key={`${activeStream.chatId}-${activeStream.createdAt.getTime()}`}
                                entries={activeStream.transcript}
                                state={activeStream.state}
                                streamStartedAt={activeStream.createdAt}
                              />
                              <AssistantDraftItem
                                body={activeStream.body}
                                createdAt={activeStream.createdAt}
                                state={activeStream.state}
                                replyingAgentId={activeStream.replyingAgentId}
                                conversation={selectedConversation}
                                agents={agents}
                                onCopyMessageText={copyChatMessageText}
                              />
                            </>
                          ) : null}
                        </>
                      )}
                  </div>
                </div>

                {hasActionableApprovals || hasPendingLightweightProposal ? null : (
                  <div className="mx-auto w-full max-w-4xl shrink-0 space-y-4">
                    {renderComposer(false)}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-8">
              <div className="mx-auto flex w-full max-w-4xl flex-col items-center justify-center">
                <div className="mb-5 w-full max-w-3xl px-1 text-center">
                  <h1 className="text-[clamp(1.6rem,2.0vw,2.3rem)] leading-[1.1] tracking-[-0.035em] text-foreground">
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
                  <div
                    key={expandedPromptGroup.label}
                    id={emptyStatePromptOptionsId}
                    data-testid="chat-empty-state-prompt-options"
                    data-entered={emptyStatePromptPanelEntered ? "true" : "false"}
                    role="region"
                    aria-label={`${expandedPromptGroup.label} examples`}
                    style={{ "--chat-options-origin-x": emptyStatePromptOriginX } as React.CSSProperties}
                    className="motion-chat-options-pop mt-3 w-full max-w-3xl rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-panel)_86%,transparent)] px-3 py-3 shadow-[var(--shadow-sm)]"
                  >
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <p className="text-xs font-medium text-muted-foreground">
                        Example use cases
                      </p>
                      <p className="text-sm text-foreground">{expandedPromptGroup.label}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {expandedPromptGroup.examples.map((example) => (
                        <button
                          key={example}
                          type="button"
                          data-chat-option
                          onClick={() => applyEmptyStateExample(example)}
                          className="rounded-[calc(var(--radius-sm)+2px)] border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_72%,transparent)] px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:border-[color:var(--border-strong)] hover:bg-[color:var(--surface-active)] hover:text-foreground"
                        >
                          {example}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          )}
      </main>
    </div>
  );
}
