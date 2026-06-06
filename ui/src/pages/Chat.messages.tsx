import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  Boxes,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Folder,
  Loader2,
  Paperclip,
  Pencil,
  Plus,
  Repeat,
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
import { ImagePreviewDialog } from "@/components/ImagePreviewDialog";
import type { MarkdownSkillReferencePreview } from "@/components/SkillReferenceToken";
import { MarkdownEditor, type MarkdownEditorProps, type MarkdownEditorRef, type MentionOption } from "@/components/MarkdownEditor";
import { AgentIcon } from "@/components/AgentIconPicker";
import { AgentMenuLabel, AssigneeLabel } from "@/components/AssigneeLabel";
import { InlineEntitySelector, type InlineEntityOption } from "@/components/InlineEntitySelector";
import { HoverTimestampLabel } from "@/components/HoverTimestamp";
import { PriorityIcon } from "@/components/PriorityIcon";
import { StatusBadge } from "@/components/StatusBadge";
import { RunTranscriptView } from "@/components/transcript/RunTranscriptView";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
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
import { agentTitleBadgeLabel, formatChatAgentLabel } from "@/lib/agent-labels";
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
import {
  assigneeValueFromSelection,
  currentUserAssigneeOption,
  formatAssigneeUserLabel,
  parseAssigneeValue,
} from "@/lib/assignees";
import { readDesktopShell } from "@/lib/desktop-shell";
import {
  canShowImageInFolder,
  copyImage as copyImageAction,
  isImageContentType,
  showImageInFolder as showImageInFolderAction,
} from "@/lib/image-actions";
import { resolveLocalFileTarget } from "@/lib/local-file-targets";
import { agentUrl, cn, relativeTime } from "@/lib/utils";
import { statusBadge, statusBadgeDefault } from "@/lib/status-colors";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import { useI18n } from "@/context/I18nContext";
import { ApprovalAction, AttachmentPreviewState, ChatImageContextMenuPosition, OPEN_TASK_PRIORITY_PROMPT, EMPTY_STATE_PROMPT_GROUPS, NO_PROJECT_ID, CHAT_LAST_PROJECT_STORAGE_KEY, EmptyStatePromptLabel, EmptyStatePromptGroup, ChatEmptyStatePromptOptions, readRememberedChatProjectId, rememberChatProjectId, projectContextId, resolveDraftIssueContext, draftIssueContextLabel, buildDraftChatContextLinks, issueAssigneeMentionLabel, projectDisplayName, chatEmptyStateHeading, projectContextSwatchStyle, COMPOSER_MENU_VIEWPORT_PADDING, COMPOSER_MENU_OFFSET, COMPOSER_MENU_MIN_HEIGHT, COMPOSER_MENU_MAX_HEIGHT, COMPOSER_MENU_MIN_WIDTH, composerMenuPositionForAnchor, inferAttachmentExtension, materializePendingAttachment, pendingAttachmentKey, attachmentDisplayName, clampChatImageContextMenuPosition, shouldHandlePlainChatLinkClick, ChatImageAttachmentTile, ChatFileAttachmentChip, PendingAttachmentPreview, ChatAttachmentList, ChatAttachmentPreviewDialog, NO_CHAT_AGENT_LABEL, PLAN_MODE_HELP_TEXT, ChatBranchPreview, mergeChatMessages, scrollChatMessagesToBottom, computeDisplayedChatMessages, mergeChatConversationsForStatus, conversationPreview, conversationDisplayTitle, buildMessengerChatThreadSummary, mergeMessengerThreadSummaries, withOptimisticOutgoingMessage, withOptimisticPlanMode, isChatAgentSelectionLocked, isChatProjectSelectionLocked, approvalNeedsAction, issueProposalFromMessage, issueProposalPrincipalLabel, planDocumentFromMessage, operationProposalDecisionNoteFromMessage, operationProposalFromMessage, operationProposalStatusFromMessage, proposalReviewStatus, proposalReviewBannerCopy, askUserRequestFromMessage, isAskUserMessageAnswered, findLatestUnansweredAskUserMessage, askUserQuestionTitle, AskUserAnswerRecord, AskUserAnswerValue, ASK_USER_ANSWER_PREFIX, formatAskUserAnswerLines, formatAskUserAnswerMessage, parseAskUserAnswerMessage, askUserAnswerFromMessage, formatChatPrimaryIssueBreadcrumb, INTERRUPTED_CHAT_CONTINUATION_PROMPT, canContinueInterruptedChatMessage, canRetryFailedChatMessage, findRetrySourceUserMessage, isUserVisibleIncomingChatMessage, assistantStateLabel, statusChipClassName } from "./Chat.parts";

export function ChatAssistantAttributionRow({
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
  const content = (
    <>
      {agent || replyingAgentId ? (
        <AgentIcon
          icon={agent?.icon}
          role={agent?.role}
          fallbackSeed={agent?.id ?? replyingAgentId}
          className="h-8 w-8 shrink-0"
        />
      ) : (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted/90 text-foreground shadow-sm">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
        </span>
      )}
      <span className="text-sm font-semibold tracking-tight text-foreground">{label}</span>
    </>
  );

  return (
    <div className="mb-2 flex items-center gap-2.5">
      {agent ? (
        <Link
          to={agentUrl(agent)}
          className="inline-flex items-center gap-2.5 rounded-[calc(var(--radius-sm)-1px)] pr-1 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/45"
          aria-label={`Open ${label} agent detail`}
        >
          {content}
        </Link>
      ) : (
        content
      )}
    </div>
  );
}

type ProposalPrincipalDisplay =
  | { kind: "agent"; label: string; agent?: Agent | null }
  | { kind: "user"; label: string }
  | null;

type ProposalPrincipalRole = "assignee" | "reviewer";

const proposalPrincipalFieldKeys = {
  assignee: {
    agent: "assigneeAgentId",
    user: "assigneeUserId",
  },
  reviewer: {
    agent: "reviewerAgentId",
    user: "reviewerUserId",
  },
} as const;

export function issueProposalPrincipalSelectionValue(
  proposal: Record<string, unknown>,
  role: ProposalPrincipalRole,
) {
  const keys = proposalPrincipalFieldKeys[role];
  const rawAgentId = proposal[keys.agent];
  const agentId = typeof rawAgentId === "string" ? rawAgentId.trim() : "";
  if (agentId) return assigneeValueFromSelection({ assigneeAgentId: agentId });
  const rawUserId = proposal[keys.user];
  const userId = typeof rawUserId === "string" ? rawUserId.trim() : "";
  if (userId) return assigneeValueFromSelection({ assigneeUserId: userId });
  return "";
}

export function issueProposalWithPrincipalSelection(
  proposal: Record<string, unknown>,
  role: ProposalPrincipalRole,
  value: string,
) {
  const keys = proposalPrincipalFieldKeys[role];
  const selection = parseAssigneeValue(value);
  const next = {
    ...proposal,
    [keys.agent]: selection.assigneeAgentId,
    [keys.user]: selection.assigneeUserId,
  };
  if (role !== "assignee") return next;
  return {
    ...next,
    assigneeUnassignedReason:
      selection.assigneeAgentId || selection.assigneeUserId
        ? null
        : "Operator explicitly left this proposal unassigned.",
  };
}

export function chatIssueApprovalPayloadWithProposalOverride(
  payload: Record<string, unknown>,
  proposalOverride: Record<string, unknown>,
) {
  const proposedIssue =
    payload.proposedIssue && typeof payload.proposedIssue === "object" && !Array.isArray(payload.proposedIssue)
      ? (payload.proposedIssue as Record<string, unknown>)
      : {};
  return {
    ...payload,
    proposedIssue: {
      ...proposedIssue,
      ...proposalOverride,
    },
  };
}

function issueProposalPrincipalDisplay(
  proposal: Record<string, unknown>,
  role: ProposalPrincipalRole,
  agents: Agent[] | undefined,
  currentUserId?: string | null,
): ProposalPrincipalDisplay {
  const keys = proposalPrincipalFieldKeys[role];
  const rawAgentId = proposal[keys.agent];
  const agentId = typeof rawAgentId === "string" ? rawAgentId.trim() : "";
  if (agentId) {
    const agent = agents?.find((candidate) => candidate.id === agentId) ?? null;
    return {
      kind: "agent",
      label: agent?.name ?? (role === "assignee" ? "Unknown agent" : "Unknown reviewer"),
      agent,
    };
  }

  const rawUserId = proposal[keys.user];
  const userId = typeof rawUserId === "string" ? rawUserId.trim() : "";
  if (userId) {
    return {
      kind: "user",
      label: formatAssigneeUserLabel(userId, currentUserId) ?? (role === "assignee" ? "Human assignee" : "Human reviewer"),
    };
  }

  return null;
}

function proposalPrincipalOptionDisplay(
  option: InlineEntityOption,
  role: ProposalPrincipalRole,
  agents: Agent[] | undefined,
  currentUserId?: string | null,
): ProposalPrincipalDisplay {
  const selection = parseAssigneeValue(option.id);
  if (selection.assigneeAgentId) {
    const agent = agents?.find((candidate) => candidate.id === selection.assigneeAgentId) ?? null;
    return {
      kind: "agent",
      label: agent?.name ?? option.label,
      agent,
    };
  }
  if (selection.assigneeUserId) {
    return {
      kind: "user",
      label: formatAssigneeUserLabel(selection.assigneeUserId, currentUserId) ?? option.label,
    };
  }
  return role === "assignee"
    ? { kind: "user", label: "No owner" }
    : { kind: "user", label: "No reviewer" };
}

function ProposalFactRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-h-9 grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-3 border-b border-[color:var(--border-soft)] py-2 last:border-b-0">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="flex min-w-0 justify-end text-sm font-medium text-foreground">{children}</div>
    </div>
  );
}

function ProposalPrincipalLabel({ principal }: { principal: ProposalPrincipalDisplay }) {
  if (!principal) return <span className="text-muted-foreground">None</span>;
  if (principal.kind === "agent") {
    return (
      <AssigneeLabel
        kind="agent"
        label={principal.label}
        badgeLabel={principal.agent ? agentTitleBadgeLabel(principal.agent) : null}
        agentIcon={principal.agent?.icon ?? null}
        agentRole={principal.agent?.role ?? null}
      />
    );
  }
  return <AssigneeLabel kind="user" label={principal.label} />;
}

function ProposalPrincipalSelector({
  proposal,
  role,
  agents,
  currentUserId,
  onChange,
}: {
  proposal: Record<string, unknown>;
  role: ProposalPrincipalRole;
  agents: Agent[] | undefined;
  currentUserId?: string | null;
  onChange: (nextProposal: Record<string, unknown>) => void;
}) {
  const value = issueProposalPrincipalSelectionValue(proposal, role);
  const currentUserOptions = useMemo(() => currentUserAssigneeOption(currentUserId), [currentUserId]);
  const options = useMemo<InlineEntityOption[]>(() => {
    const agentOptions = (agents ?? [])
      .filter((agent) => agent.status !== "terminated")
      .map((agent) => ({
        id: assigneeValueFromSelection({ assigneeAgentId: agent.id }),
        label: agent.name,
        searchText: `${agent.name} ${agent.role} ${agent.title ?? ""}`,
      }));
    const combined = [...currentUserOptions, ...agentOptions];
    if (value && !combined.some((option) => option.id === value)) {
      const currentDisplay = proposalPrincipalOptionDisplay(
        { id: value, label: role === "assignee" ? "Current owner" : "Current reviewer" },
        role,
        agents,
        currentUserId,
      );
      combined.unshift({
        id: value,
        label: currentDisplay?.label ?? (role === "assignee" ? "Current owner" : "Current reviewer"),
      });
    }
    return combined;
  }, [agents, currentUserId, currentUserOptions, role, value]);
  const noneLabel = role === "assignee" ? "No owner" : "No reviewer";

  return (
    <InlineEntitySelector
      value={value}
      options={options}
      placeholder={noneLabel}
      noneLabel={noneLabel}
      searchPlaceholder={role === "assignee" ? "Search owners..." : "Search reviewers..."}
      emptyMessage={role === "assignee" ? "No owners found." : "No reviewers found."}
      ariaLabel={role === "assignee" ? "Edit owner" : "Edit reviewer"}
      className="w-full max-w-full justify-end rounded-[var(--radius-sm)] border-transparent bg-transparent px-1.5 py-1 hover:border-border hover:bg-accent/50"
      contentClassName="min-w-64"
      onChange={(nextValue) => onChange(issueProposalWithPrincipalSelection(proposal, role, nextValue))}
      renderTriggerValue={(option) =>
        option ? (
          <ProposalPrincipalLabel principal={proposalPrincipalOptionDisplay(option, role, agents, currentUserId)} />
        ) : (
          <AssigneeLabel kind="unassigned" label={noneLabel} muted />
        )
      }
      renderOption={(option) => {
        if (!option.id) return <AssigneeLabel kind="unassigned" label={option.label} muted />;
        const selection = parseAssigneeValue(option.id);
        const agent = selection.assigneeAgentId
          ? (agents ?? []).find((candidate) => candidate.id === selection.assigneeAgentId) ?? null
          : null;
        if (agent) return <AgentMenuLabel agent={agent} />;
        return <ProposalPrincipalLabel principal={proposalPrincipalOptionDisplay(option, role, agents, currentUserId)} />;
      }}
    />
  );
}

export function ProposalCard({
  conversation,
  message,
  agents,
  currentUserId,
  issueProposalOverride,
  onIssueProposalChange,
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
  currentUserId?: string | null;
  issueProposalOverride?: Record<string, unknown>;
  onIssueProposalChange?: (messageId: string, nextProposal: Record<string, unknown>) => void;
  decisionNote: string;
  onDecisionNoteChange: (value: string) => void;
  onApprovalAction: (approvalId: string, action: ApprovalAction, messageId: string) => void;
  onResolveOperationProposal: (messageId: string, action: ChatOperationProposalDecisionAction, decisionNote: string) => void;
  onConvertToIssue: (message: ChatMessage) => void;
  actionPending: boolean;
  skillReferences: MarkdownSkillReferencePreview[];
  onMarkdownLinkClick?: MarkdownLinkClickHandler;
}) {
  const baseIssueProposal = message.kind === "issue_proposal" ? issueProposalFromMessage(message) : null;
  const issueProposal = baseIssueProposal ? (issueProposalOverride ?? baseIssueProposal) : null;
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
  const proposalDetailsId = `proposal-details-${message.id}`;
  const resolvedDecisionNote = message.approval?.decisionNote ?? operationProposalDecisionNoteFromMessage(message);
  const showReviewControls = showDecisionNote || canConvertDirectly || Boolean(resolvedDecisionNote);
  const resolvedDecisionNoteLabel = reviewStatus === "revision_requested" ? "Requested changes" : "Decision note";
  const proposalAssigneeLabel = issueProposal ? issueProposalPrincipalLabel(issueProposal, "assignee", agents) : null;
  const proposalReviewerLabel = issueProposal ? issueProposalPrincipalLabel(issueProposal, "reviewer", agents) : null;
  const proposalAssigneeDisplay = issueProposal ? issueProposalPrincipalDisplay(issueProposal, "assignee", agents, currentUserId) : null;
  const proposalReviewerDisplay = issueProposal ? issueProposalPrincipalDisplay(issueProposal, "reviewer", agents, currentUserId) : null;
  const proposalIssueStatus =
    issueProposal && typeof issueProposal.status === "string" && issueProposal.status.trim()
      ? issueProposal.status.trim()
      : "todo";
  const proposalAssigneeUnassignedReason =
    issueProposal && typeof issueProposal.assigneeUnassignedReason === "string"
      ? issueProposal.assigneeUnassignedReason.trim() || null
      : null;
  const proposalDescription = issueProposal ? String(issueProposal.description) : "";
  const canEditIssueProposalPrincipals = Boolean(issueProposal && (showApprovalActions || canConvertDirectly) && onIssueProposalChange);
  const [proposalDetailsExpanded, setProposalDetailsExpanded] = useState(false);
  const [proposalDetailsCanExpand, setProposalDetailsCanExpand] = useState(false);
  const proposalDetailsRef = useRef<HTMLDivElement | null>(null);
  const proposalKind = issueProposal ? "issue" : operationProposal ? "operation" : planDocument ? "plan" : "default";
  const proposalKindLabel = issueProposal
    ? "Issue proposal"
    : operationProposal
      ? "Operation proposal"
      : planDocument
        ? "Plan proposal"
        : "Proposal";

  useEffect(() => {
    setProposalDetailsExpanded(false);
  }, [message.id, proposalDescription]);

  useEffect(() => {
    const details = proposalDetailsRef.current;
    if (!details || !issueProposal) {
      setProposalDetailsCanExpand(false);
      return;
    }

    const updateCanExpand = () => {
      const computedStyle = window.getComputedStyle(details);
      const lineHeight = Number.parseFloat(computedStyle.lineHeight);
      const collapsedTenLineHeight = Number.isFinite(lineHeight) ? lineHeight * 10 : 240;
      setProposalDetailsCanExpand(details.scrollHeight > collapsedTenLineHeight + 1);
    };

    updateCanExpand();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateCanExpand);
    observer.observe(details);
    return () => observer.disconnect();
  }, [issueProposal, proposalDescription, proposalDetailsExpanded]);

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
        data-kind={proposalKind}
        className="chat-review-block mt-4 max-w-[860px] rounded-[var(--radius-lg)] text-foreground transition-all duration-200"
      >
        <div
          className={cn(
            "chat-review-docket-header grid border-b border-[color:var(--border-soft)]",
            reviewStatus ? "grid-cols-1 sm:grid-cols-[1fr_minmax(9rem,13rem)]" : "grid-cols-1",
          )}
        >
          <div className="flex min-w-0 items-center gap-3 px-5 py-4">
            <span className="h-6 w-1 rounded-full bg-[color:var(--accent-strong)]" aria-hidden="true" />
            <span className="truncate text-sm font-semibold leading-5 text-foreground">{proposalKindLabel}</span>
          </div>
          {reviewStatus ? (
            <div
              data-testid="proposal-review-status"
              className="relative z-[6] flex min-w-0 items-center justify-start border-t border-[color:var(--border-soft)] px-5 py-4 sm:justify-end sm:border-t-0 sm:pr-10"
            >
              <StatusBadge status={reviewStatus} />
            </div>
          ) : null}
        </div>

        <div className="px-5 py-5">
          <div className="min-w-0">
            {issueProposal ? (
              <>
                <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(15rem,22rem)]">
                  <div className="flex min-w-0 items-center border-b border-[color:var(--border-soft)] pb-5 md:border-b-0 md:pb-0">
                    <div className="text-[26px] font-semibold leading-tight text-foreground">{String(issueProposal.title)}</div>
                  </div>
                  <div className="chat-review-fact-ledger">
                    <ProposalFactRow label="Priority">
                      <PriorityIcon priority={String(issueProposal.priority ?? "medium")} showLabel />
                    </ProposalFactRow>
                    <ProposalFactRow label="Status">
                      <span
                        className={cn(
                          "inline-flex shrink-0 items-center rounded-[calc(var(--radius-sm)-1px)] border px-2.5 py-1 text-xs font-medium whitespace-nowrap",
                          statusBadge[proposalIssueStatus] ?? statusBadgeDefault,
                        )}
                      >
                        {proposalIssueStatus.replace("_", " ")}
                      </span>
                    </ProposalFactRow>
                    <ProposalFactRow label="Owner">
                      <div className="flex min-w-0 flex-col items-end gap-1 text-right">
                        {canEditIssueProposalPrincipals ? (
                          <ProposalPrincipalSelector
                            proposal={issueProposal}
                            role="assignee"
                            agents={agents}
                            currentUserId={currentUserId}
                            onChange={(nextProposal) => onIssueProposalChange?.(message.id, nextProposal)}
                          />
                        ) : (
                          <ProposalPrincipalLabel principal={proposalAssigneeDisplay} />
                        )}
                        {!proposalAssigneeDisplay && proposalAssigneeUnassignedReason ? (
                          <span className="max-w-full text-xs font-normal leading-5 text-muted-foreground">
                            Reason: {proposalAssigneeUnassignedReason}
                          </span>
                        ) : null}
                        {!proposalAssigneeDisplay && !proposalAssigneeUnassignedReason ? (
                          <span className="max-w-full text-xs font-normal leading-5 text-amber-700 dark:text-amber-300">
                            Owner decision missing
                          </span>
                        ) : null}
                      </div>
                    </ProposalFactRow>
                    <ProposalFactRow label="Reviewer">
                      {canEditIssueProposalPrincipals ? (
                        <ProposalPrincipalSelector
                          proposal={issueProposal}
                          role="reviewer"
                          agents={agents}
                          currentUserId={currentUserId}
                          onChange={(nextProposal) => onIssueProposalChange?.(message.id, nextProposal)}
                        />
                      ) : (
                        <ProposalPrincipalLabel principal={proposalReviewerDisplay} />
                      )}
                    </ProposalFactRow>
                  </div>
                </div>
                {proposalAssigneeLabel || proposalReviewerLabel ? (
                  <div className="sr-only">
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
            {reviewBanner && (!issueProposal || reviewStatus !== "pending") ? (
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                {reviewBanner}
              </p>
            ) : null}
          </div>
        </div>

        {issueProposal ? (
          <section className="border-t border-[color:var(--border-soft)] px-5 py-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="text-sm font-semibold text-foreground">Proposal details</div>
              {proposalDetailsCanExpand ? (
                <button
                  type="button"
                  aria-controls={proposalDetailsId}
                  aria-expanded={proposalDetailsExpanded}
                  className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-1.5 py-1 text-xs font-medium text-[color:var(--accent-strong)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-proposal)_55%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]"
                  onClick={() => setProposalDetailsExpanded((current) => !current)}
                >
                  {proposalDetailsExpanded ? "Show less" : "Show full proposal"}
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 transition-transform duration-200",
                      proposalDetailsExpanded && "rotate-180",
                    )}
                    aria-hidden="true"
                  />
                </button>
              ) : null}
            </div>
            <div
              id={proposalDetailsId}
              ref={proposalDetailsRef}
              className={cn(
                "chat-review-details-body text-sm leading-6 text-muted-foreground",
                !proposalDetailsExpanded && "chat-review-details-body--collapsed",
                proposalDetailsCanExpand && !proposalDetailsExpanded && "chat-review-details-body--can-expand",
              )}
            >
              <MarkdownBody skillReferences={skillReferences} onLinkClick={onMarkdownLinkClick} enableCodeBlockCopy>
                {proposalDescription}
              </MarkdownBody>
            </div>
          </section>
        ) : null}

        {planDocument ? (
          <div className="border-t border-[color:var(--border-soft)] px-5 py-4">
            {issueProposal ? (
              <div className="text-[11px] font-medium text-muted-foreground">{planDocument.title}</div>
            ) : null}
            <div className="mt-3 text-sm leading-6 text-foreground">
              <MarkdownBody skillReferences={skillReferences} onLinkClick={onMarkdownLinkClick} enableCodeBlockCopy>
                {planDocument.body}
              </MarkdownBody>
            </div>
          </div>
        ) : null}

        {operationProposal?.patch && typeof operationProposal.patch === "object" ? (
          <div className="border-t border-[color:var(--border-soft)] px-5 py-4">
            <pre className="overflow-x-auto rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-shell)_88%,transparent)] p-3 text-xs text-muted-foreground">
              {JSON.stringify(operationProposal.patch, null, 2)}
            </pre>
          </div>
        ) : null}

        {showReviewControls ? (
          <div className="border-t border-[color:var(--border-soft)] px-5 py-5">
            {showDecisionNote ? (
              <label className="block space-y-2">
                <span className="text-xs font-medium text-muted-foreground">
                  {showRevisionAction || showOperationActions ? "Feedback for agent" : "Decision note"}
                </span>
                <Textarea
                  id={decisionNoteId}
                  data-testid="proposal-review-note"
                  value={decisionNote}
                  onChange={(event) => onDecisionNoteChange(event.target.value)}
                  placeholder={
                    showRevisionAction || showOperationActions
                      ? "Tell the agent what must change before approval."
                      : "Optional note for approval or rejection."
                  }
                  className="chat-field min-h-[88px] rounded-[var(--radius-lg)]"
                />
              </label>
            ) : null}

            {!showDecisionNote && resolvedDecisionNote ? (
              <div className="chat-review-note mt-1 rounded-[var(--radius-lg)] px-4 py-3">
                <div className="chat-review-note-header text-[11px] font-medium text-muted-foreground">
                  {resolvedDecisionNoteLabel}
                </div>
                <p className="chat-review-note-body mt-2 text-sm leading-6 text-foreground/90">{resolvedDecisionNote}</p>
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
                      Request changes
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

export const chatMessageHoverBarClass =
  "opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100";

function CopyMessageButton({ onClick }: { onClick: () => void }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-[color:var(--surface-active)] hover:text-foreground"
            aria-label="Copy message"
            onClick={onClick}
          >
            <Copy className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8}>
          Copy message
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

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
        <MarkdownBody skillReferences={skillReferences} onLinkClick={onMarkdownLinkClick} enableCodeBlockCopy>
          {body}
        </MarkdownBody>
      </div>
    </div>
  );
}

export function readStructuredPayloadString(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function issueCreatedSystemMessageParts(message: ChatMessage) {
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

function automationSourceSystemMessageParts(message: ChatMessage) {
  const payload = message.structuredPayload;
  if (!payload || (payload.eventType !== "automation_source" && payload.eventType !== "automation_created")) return null;

  const automationId = readStructuredPayloadString(payload, "automationId");
  const automationTitle = readStructuredPayloadString(payload, "automationTitle") ?? "automation";
  if (!automationId) return null;

  return {
    automationId,
    automationTitle,
  };
}

function isAutomationSystemMessage(message: ChatMessage) {
  const eventType = message.structuredPayload?.eventType;
  return eventType === "automation_source" || eventType === "automation_created";
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
  const automationSourceParts = automationSourceSystemMessageParts(message);

  if (automationSourceParts) {
    if (message.structuredPayload?.eventType === "automation_created") {
      return (
        <span className="min-w-0 flex-1 leading-5">
          Created automation{" "}
          <Link
            to={`/automations/${automationSourceParts.automationId}`}
            className="chat-system-issue-link"
            aria-label={`Open automation ${automationSourceParts.automationTitle}`}
          >
            {automationSourceParts.automationTitle}
          </Link>
          {" "}from this chat conversation.
        </span>
      );
    }
    return (
      <span className="min-w-0 flex-1 leading-5">
        From automation{" "}
        <Link
          to={`/automations/${automationSourceParts.automationId}`}
          className="chat-system-issue-link"
          aria-label={`Open automation ${automationSourceParts.automationTitle}`}
        >
          {automationSourceParts.automationTitle}
        </Link>
        .
      </span>
    );
  }

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
    <MarkdownBody skillReferences={skillReferences} onLinkClick={onMarkdownLinkClick} enableCodeBlockCopy>
      {message.body}
    </MarkdownBody>
  );
}

export function AskUserHistoryRecord({
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

export function AskUserAnswerBubble({
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

export function AskUserPanel({
  message,
  request,
  disabled,
  pendingFiles,
  onAddAttachment,
  onRemovePendingFile,
  onOpenAttachmentPreview,
  onPasteAttachment,
  onSubmit,
}: {
  message: ChatMessage;
  request: ChatAskUserRequest;
  disabled: boolean;
  pendingFiles: File[];
  onAddAttachment: () => void;
  onRemovePendingFile: (fileKey: string) => void;
  onOpenAttachmentPreview: (preview: AttachmentPreviewState) => void;
  onPasteAttachment: (event: ReactClipboardEvent<HTMLDivElement>) => void;
  onSubmit: (body: string) => void;
}) {
  const [selectedByQuestionId, setSelectedByQuestionId] = useState<Record<string, string[]>>({});
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
    const next: Record<string, AskUserAnswerValue> = {};
    for (const question of request.questions) {
      const selected = selectedByQuestionId[question.id] ?? [];
      const isMultiple = question.selectionMode === "multiple";
      if (!isMultiple && selected[0] === "__other") {
        const text = freeformByQuestionId[question.id]?.trim() ?? "";
        if (text) next[question.id] = { kind: "freeform", text };
        continue;
      }
      const labels = selected
        .filter((optionId) => optionId !== "__other")
        .map((optionId) => question.options.find((entry) => entry.id === optionId)?.label)
        .filter((label): label is string => Boolean(label));
      if (selected.includes("__other")) {
        const text = freeformByQuestionId[question.id]?.trim() ?? "";
        if (text) labels.push(`Other: ${text}`);
      }
      if (labels.length > 0) {
        next[question.id] = isMultiple ? { kind: "options", labels } : { kind: "option", label: labels[0] ?? "" };
      }
    }
    return next;
  }, [freeformByQuestionId, request.questions, selectedByQuestionId]);

  const questionCount = request.questions.length;
  const hasMultipleQuestions = questionCount > 1;
  const boundedQuestionIndex = Math.min(currentQuestionIndex, Math.max(questionCount - 1, 0));
  const currentQuestion = request.questions[boundedQuestionIndex] ?? null;
  const hasPendingAttachments = pendingFiles.length > 0;
  const answerAttachmentsText = pendingFiles.length === 1 ? "See attached file." : "See attached files.";
  const answersWithAttachmentFallback = useMemo(() => {
    if (!hasPendingAttachments) return answers;
    const next = { ...answers };
    for (const question of request.questions) {
      if (next[question.id]) continue;
      const selected = selectedByQuestionId[question.id] ?? [];
      if (selected.includes("__other")) {
        next[question.id] = question.selectionMode === "multiple"
          ? { kind: "options", labels: [`Other: ${answerAttachmentsText}`] }
          : { kind: "freeform", text: answerAttachmentsText };
      }
    }
    return next;
  }, [answerAttachmentsText, answers, hasPendingAttachments, request.questions, selectedByQuestionId]);
  const currentAnswer = currentQuestion ? answersWithAttachmentFallback[currentQuestion.id] : null;
  const canSubmit = request.questions.every((question) => Boolean(answersWithAttachmentFallback[question.id]));

  const moveToNextQuestion = (fromIndex: number) => {
    if (!hasMultipleQuestions) return;
    if (fromIndex < questionCount - 1) {
      setCurrentQuestionIndex(fromIndex + 1);
      setReviewingAnswers(false);
      return;
    }
    setReviewingAnswers(true);
  };

  const answerText = (answer: AskUserAnswerValue | undefined) =>
    answer?.kind === "freeform" ? answer.text : answer?.kind === "options" ? answer.labels.join(", ") : answer?.label ?? "Not answered";

  const selectOption = (question: ChatAskUserQuestion, index: number, optionId: string) => {
    const isMultiple = question.selectionMode === "multiple";
    setSelectedByQuestionId((current) => {
      const existing = current[question.id] ?? [];
      if (!isMultiple) return { ...current, [question.id]: [optionId] };
      const nextSelection = existing.includes(optionId)
        ? existing.filter((entry) => entry !== optionId)
        : [...existing, optionId];
      return { ...current, [question.id]: nextSelection };
    });
    if (!isMultiple && optionId !== "__other") {
      moveToNextQuestion(index);
    }
  };

  return (
    <div
      data-testid="chat-ask-user-panel"
      onPasteCapture={onPasteAttachment}
      className="rounded-[var(--radius-lg)] border border-[color:color-mix(in_oklab,var(--accent-base)_35%,var(--border))] bg-[color:color-mix(in_oklab,var(--accent-soft)_28%,var(--surface-elevated))] p-3 shadow-[var(--shadow-sm)]"
    >
      {hasMultipleQuestions ? (
        <div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>{reviewingAnswers ? "Review answers" : `Question ${boundedQuestionIndex + 1} of ${questionCount}`}</span>
          <span>{Object.keys(answersWithAttachmentFallback).length}/{questionCount} answered</span>
        </div>
      ) : null}

      {reviewingAnswers ? (
        <section className="rounded-[var(--radius-md)] border border-border bg-card/85 p-3">
          <div className="text-sm font-medium text-foreground">Review answers</div>
          <div className="mt-2 space-y-2">
            {request.questions.map((question, index) => {
              const answer = answersWithAttachmentFallback[question.id];
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
                      {answerText(answer)}
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
              const selected = selectedByQuestionId[currentQuestion.id] ?? [];
              const isMultiple = currentQuestion.selectionMode === "multiple";
              const active = selected.includes(option.id);
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
                      "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border",
                      isMultiple ? "rounded-[4px]" : "rounded-full",
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
                  (selectedByQuestionId[currentQuestion.id] ?? []).includes("__other")
                    ? "border-[color:var(--accent-base)] bg-[color:color-mix(in_oklab,var(--accent-soft)_62%,transparent)]"
                    : "border-border bg-background/70 hover:bg-[color:var(--surface-active)]",
                )}
                aria-pressed={(selectedByQuestionId[currentQuestion.id] ?? []).includes("__other")}
                onClick={() => selectOption(currentQuestion, boundedQuestionIndex, "__other")}
              >
                <span
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center border",
                    currentQuestion.selectionMode === "multiple" ? "rounded-[4px]" : "rounded-full",
                    (selectedByQuestionId[currentQuestion.id] ?? []).includes("__other") ? "border-[color:var(--accent-base)] bg-[color:var(--accent-base)] text-primary-foreground" : "border-border",
                  )}
                  aria-hidden
                >
                  {(selectedByQuestionId[currentQuestion.id] ?? []).includes("__other") ? <CheckCircle2 className="h-3 w-3" /> : null}
                </span>
                <span className="font-medium text-foreground">Other</span>
              </button>
            ) : null}
          </div>
          {(selectedByQuestionId[currentQuestion.id] ?? []).includes("__other") ? (
            <div className="mt-2 space-y-2">
              <Textarea
                value={freeformByQuestionId[currentQuestion.id] ?? ""}
                onChange={(event) => setFreeformByQuestionId((current) => ({
                  ...current,
                  [currentQuestion.id]: event.target.value,
                }))}
                placeholder="Type your answer..."
                className="min-h-20 resize-y rounded-[var(--radius-md)] bg-background text-sm"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  onClick={onAddAttachment}
                  className="h-8 gap-1.5 px-2.5 text-xs"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                  Attach
                </Button>
                {hasPendingAttachments ? (
                  <div data-testid="chat-ask-user-pending-attachments" className="flex min-w-0 flex-wrap gap-2">
                    {pendingFiles.map((file) => {
                      const fileKey = pendingAttachmentKey(file);
                      return (
                        <div key={fileKey} data-testid="chat-ask-user-pending-attachment" className="max-w-full">
                          <PendingAttachmentPreview
                            file={file}
                            onOpenImage={onOpenAttachmentPreview}
                            onRemove={() => onRemovePendingFile(fileKey)}
                          />
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {!(selectedByQuestionId[currentQuestion?.id ?? ""] ?? []).includes("__other") && hasPendingAttachments ? (
        <div data-testid="chat-ask-user-pending-attachments" className="mt-3 flex min-w-0 flex-wrap gap-2">
          {pendingFiles.map((file) => {
            const fileKey = pendingAttachmentKey(file);
            return (
              <div key={fileKey} data-testid="chat-ask-user-pending-attachment" className="max-w-full">
                <PendingAttachmentPreview
                  file={file}
                  onOpenImage={onOpenAttachmentPreview}
                  onRemove={() => onRemovePendingFile(fileKey)}
                />
              </div>
            );
          })}
        </div>
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
            onClick={() => onSubmit(formatAskUserAnswerMessage(request, answersWithAttachmentFallback))}
          >
            Submit answer
          </Button>
        )}
      </div>
    </div>
  );
}

export function ChatMessageItem({
  conversation,
  message,
  agents,
  currentUserId,
  issueProposalOverride,
  decisionNote,
  onDecisionNoteChange,
  onApprovalAction,
  onIssueProposalChange,
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
  inlineEdit,
  answered,
  askUserAnswer,
}: {
  conversation: ChatConversation;
  message: ChatMessage;
  agents: Agent[] | undefined;
  currentUserId?: string | null;
  issueProposalOverride?: Record<string, unknown>;
  decisionNote: string;
  onDecisionNoteChange: (value: string) => void;
  onApprovalAction: (approvalId: string, action: ApprovalAction, messageId: string) => void;
  onIssueProposalChange?: (messageId: string, nextProposal: Record<string, unknown>) => void;
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
  inlineEdit?: {
    draft: string;
    disabled: boolean;
    mentions: MentionOption[];
    surfaceRef: RefObject<HTMLDivElement | null>;
    editorRef: RefObject<MarkdownEditorRef | null>;
    onChange: (value: string) => void;
    onSubmit: () => void;
    onCancel: () => void;
    onMentionQueryChange: (query: string | null) => void;
    onInlineTokenClick: MarkdownEditorProps["onInlineTokenClick"];
  } | null;
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
        currentUserId={currentUserId}
        issueProposalOverride={issueProposalOverride}
        onIssueProposalChange={onIssueProposalChange}
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
    const SystemMessageIcon = isAutomationSystemMessage(message) ? Repeat : CheckCircle2;

    return (
      <div className="chat-system-pill rounded-[calc(var(--radius-sm)+2px)] px-4 py-2 text-sm transition-all duration-200">
        <div className="flex items-center gap-2">
          <SystemMessageIcon className="h-4 w-4 text-[color:var(--accent-strong)]" aria-hidden />
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
  const isEmptyStreamingAssistant = !isUser && message.status === "streaming" && message.body.trim().length === 0;
  const isInlineEditing = isUser && Boolean(inlineEdit);

  if (!isUser) {
    return (
      <div data-testid="chat-assistant-message" className="flex justify-start transition-all duration-200">
        <div className="group w-full max-w-3xl px-1 py-1">
          <ChatAssistantAttributionRow
            replyingAgentId={message.replyingAgentId ?? null}
            conversation={conversation}
            agents={agents}
          />
          {statusLabel && !isEmptyStreamingAssistant ? (
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
          {isEmptyStreamingAssistant ? (
            <div className="max-w-[72ch] text-[15px] leading-7 text-foreground">
              <TextDots text="Thinking" className="text-muted-foreground" />
            </div>
          ) : (
            <ChatLongMessageBody
              body={message.body}
              skillReferences={skillReferences}
              onMarkdownLinkClick={onMarkdownLinkClick}
              className="max-w-[72ch] text-[15px] leading-7 text-foreground"
            />
          )}
          <ChatRichReferences message={message} />
          <ChatAttachmentList
            attachments={message.attachments}
            onOpenImage={onOpenImage}
            onOpenFile={onOpenFile}
          />
          {!isEmptyStreamingAssistant ? (
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
              <CopyMessageButton onClick={() => void onCopyMessageText(message.body)} />
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-end transition-all duration-200">
      <div className={cn("group flex flex-col items-end text-left", isInlineEditing ? "w-full max-w-[82%]" : "max-w-[82%]")}>
        {isInlineEditing && inlineEdit ? (
          <div
            ref={inlineEdit.surfaceRef}
            data-testid="chat-inline-message-editor"
            className="chat-message-user w-full max-w-[min(100%,72ch)] rounded-[var(--radius-xl)] px-4 py-3 shadow-[var(--shadow-sm)]"
          >
            <MarkdownEditor
              ref={inlineEdit.editorRef}
              value={inlineEdit.draft}
              onChange={inlineEdit.onChange}
              mentions={inlineEdit.mentions}
              onMentionQueryChange={inlineEdit.onMentionQueryChange}
              mentionMenuSize="compact"
              submitShortcut="enter"
              onInlineTokenClick={inlineEdit.onInlineTokenClick}
              plainText
              bordered={false}
              placeholder="Edit message"
              className="rounded-[var(--radius-md)] bg-transparent"
              contentClassName="min-h-[72px] bg-transparent text-[15px] leading-7 text-foreground"
              onSubmit={() => {
                if (!inlineEdit.disabled) {
                  inlineEdit.onSubmit();
                }
              }}
            />
            {message.attachments.length > 0 ? (
              <div className="mt-2">
                <ChatAttachmentList
                  attachments={message.attachments}
                  onOpenImage={onOpenImage}
                  onOpenFile={onOpenFile}
                />
              </div>
            ) : null}
            <div className="mt-3 flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={inlineEdit.onCancel}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={inlineEdit.disabled || inlineEdit.draft.trim().length === 0}
                onClick={inlineEdit.onSubmit}
              >
                Send
              </Button>
            </div>
          </div>
        ) : askUserAnswer ? (
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
            isInlineEditing ? "invisible pointer-events-none" : chatMessageHoverBarClass,
          )}
        >
          <CopyMessageButton onClick={() => void onCopyMessageText(message.body)} />
          <button
            type="button"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-[color:var(--surface-active)] hover:text-foreground"
            aria-label="Edit message"
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

export function OptimisticUserDraftItem({
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
          <CopyMessageButton onClick={() => void onCopyMessageText(body)} />
          <button
            type="button"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-[color:var(--surface-active)] hover:text-foreground"
            aria-label="Edit draft"
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

export function ChatMessagesLoadingState() {
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

function transcriptSummaryDurationMs(summary: NonNullable<ChatMessage["transcriptSummary"]>) {
  if (!summary.startedAt) return null;
  const start = Date.parse(summary.startedAt);
  const end = summary.endedAt ? Date.parse(summary.endedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

export function LazyStreamTranscriptItem({
  summary,
  state,
  loading,
  onLoad,
}: {
  summary: NonNullable<ChatMessage["transcriptSummary"]>;
  state: ChatStreamDraftState | ChatMessage["status"];
  loading?: boolean;
  onLoad: () => void;
}) {
  const durationMs = transcriptSummaryDurationMs(summary);
  const statusHint =
    state === "failed"
      ? "Stopped with errors"
      : state === "stopped"
        ? "Stopped"
        : "";

  return (
    <div data-testid="chat-transcript-item" className="flex justify-start transition-all duration-200">
      <div className="w-full max-w-3xl px-1 py-1">
        <div className="flex items-center gap-3">
          <div className="h-px min-w-[1rem] flex-1 bg-border/45" aria-hidden />
          <button
            type="button"
            className="flex max-w-[min(100%,90%)] shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground disabled:cursor-wait disabled:opacity-70"
            disabled={loading}
            onClick={onLoad}
            aria-expanded={false}
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden /> : null}
            <span className="whitespace-nowrap">
              {durationMs === null ? "Process details" : `Worked for ${formatChatProcessDuration(durationMs)}`}
            </span>
            {statusHint ? (
              <span className="truncate text-amber-700/90 dark:text-amber-400/85">· {statusHint}</span>
            ) : null}
            <span className="truncate text-muted-foreground/75">
              · {summary.entryCount} event{summary.entryCount === 1 ? "" : "s"}
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 opacity-60" aria-hidden />
          </button>
          <div className="h-px min-w-[1rem] flex-1 bg-border/45" aria-hidden />
        </div>
      </div>
    </div>
  );
}

export function StreamTranscriptItem({
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

export function AssistantDraftItem({
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
            <CopyMessageButton onClick={() => void onCopyMessageText(body)} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
