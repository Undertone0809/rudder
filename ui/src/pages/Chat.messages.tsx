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
import { ApprovalAction, AttachmentPreviewState, ChatImageContextMenuPosition, OPEN_TASK_PRIORITY_PROMPT, EMPTY_STATE_PROMPT_GROUPS, NO_PROJECT_ID, CHAT_LAST_PROJECT_STORAGE_KEY, EmptyStatePromptLabel, EmptyStatePromptGroup, ChatEmptyStatePromptOptions, readRememberedChatProjectId, rememberChatProjectId, projectContextId, resolveDraftIssueContext, draftIssueContextLabel, buildDraftChatContextLinks, issueAssigneeMentionLabel, projectDisplayName, chatEmptyStateHeading, projectContextSwatchStyle, COMPOSER_MENU_VIEWPORT_PADDING, COMPOSER_MENU_OFFSET, COMPOSER_MENU_MIN_HEIGHT, COMPOSER_MENU_MAX_HEIGHT, COMPOSER_MENU_MIN_WIDTH, composerMenuPositionForAnchor, inferAttachmentExtension, materializePendingAttachment, pendingAttachmentKey, attachmentDisplayName, clampChatImageContextMenuPosition, shouldHandlePlainChatLinkClick, ChatImageAttachmentTile, ChatFileAttachmentChip, PendingAttachmentPreview, ChatAttachmentList, ChatAttachmentPreviewDialog, NO_CHAT_AGENT_LABEL, PLAN_MODE_HELP_TEXT, ChatBranchPreview, mergeChatMessages, scrollChatMessagesToBottom, computeDisplayedChatMessages, mergeChatConversationsForStatus, conversationPreview, conversationDisplayTitle, buildMessengerChatThreadSummary, mergeMessengerThreadSummaries, withOptimisticOutgoingMessage, withOptimisticPlanMode, isChatAgentSelectionLocked, isChatProjectSelectionLocked, approvalNeedsAction, issueProposalFromMessage, issueProposalPrincipalLabel, planDocumentFromMessage, operationProposalFromMessage, operationProposalStatusFromMessage, proposalReviewStatus, proposalReviewBannerCopy, askUserRequestFromMessage, isAskUserMessageAnswered, findLatestUnansweredAskUserMessage, askUserQuestionTitle, AskUserAnswerRecord, ASK_USER_ANSWER_PREFIX, formatAskUserAnswerLines, formatAskUserAnswerMessage, parseAskUserAnswerMessage, askUserAnswerFromMessage, formatChatPrimaryIssueBreadcrumb, INTERRUPTED_CHAT_CONTINUATION_PROMPT, canContinueInterruptedChatMessage, canRetryFailedChatMessage, findRetrySourceUserMessage, isUserVisibleIncomingChatMessage, assistantStateLabel, statusChipClassName } from "./Chat.parts";

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

export const chatMessageHoverBarClass =
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

export function ChatMessageItem({
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

