import type { TranscriptEntry } from "@/agent-runtimes";
import { agentsApi } from "@/api/agents";
import { approvalsApi } from "@/api/approvals";
import { authApi } from "@/api/auth";
import { chatsApi, type ChatSteerQueuedMessageRequest } from "@/api/chats";
import { ApiError } from "@/api/client";
import type { HealthStatus } from "@/api/health";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { issuesApi } from "@/api/issues";
import { messengerApi } from "@/api/messenger";
import { organizationSkillsApi } from "@/api/organizationSkills";
import { organizationsApi } from "@/api/orgs";
import { projectsApi } from "@/api/projects";
import {
  ChatComposerAddMenu,
  ChatComposerContextMenu,
  ChatComposerEditor,
  ChatComposerSendButton,
  ChatComposerSkillsButton,
  ChatComposerSkillsMenuContent,
  ChatComposerSurface,
  ChatComposerToolbar,
} from "@/components/chat/ChatComposer";
import { ChatConversationHeader } from "@/components/chat/ChatConversationHeader";
import {
  DraftResponseAnnotationsPopover,
  ResponseAnnotationEditor,
  useResponseAnnotationEditorController,
} from "@/components/chat/ResponseAnnotations";
import { SelectionAnnotationToolbar } from "@/components/chat/SelectionAnnotationToolbar";
import { type MarkdownLinkClickHandler } from "@/components/MarkdownBody";
import { type MarkdownEditorRef, type MentionOption } from "@/components/MarkdownEditor";
import { ProjectIcon } from "@/components/ProjectIdentity";
import type { MarkdownSkillReferencePreview } from "@/components/SkillReferenceToken";
import type { TranscriptAgentInspection, TranscriptSkillTarget } from "@/components/transcript/RunTranscriptView";
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
import { VirtualizedActivityTimeline } from "@/components/VirtualizedActivityTimeline";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useChatGenerations } from "@/context/ChatGenerationContext";
import { useDialog } from "@/context/DialogContext";
import { useI18n } from "@/context/I18nContext";
import { useImagePreview } from "@/context/ImagePreviewContext";
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
import {
  blockStaleAnnotationSubmission,
  resolveAnnotationDraftPersistence,
  type AnnotationDraftPersistence,
} from "@/lib/chat-annotation-runtime";
import {
  chatClientCheckpointKey,
  createChatClientCheckpointDispatcher,
} from "@/lib/chat-client-checkpoints";
import {
  CHAT_COMPOSER_DRAFT_VERSION,
  clearChatAskUserDraft,
  clearChatDraft,
  readChatComposerDraft,
  saveChatComposerDraft,
} from "@/lib/chat-draft-storage";
import {
  CHAT_FILE_ANNOTATION_REQUEST_EVENT,
  requestChatFileAnnotationLocation,
  type ChatFileAnnotationRequestDetail,
} from "@/lib/chat-file-annotation-events";
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
import {
  clearChatResponseAnnotationNavigationState,
  createChatResponseAnnotationNavigationState,
  readChatResponseAnnotationNavigationState,
} from "@/lib/chat-response-annotation-navigation";
import {
  hashChatAnnotationSource,
  restoreLiveChatAnnotationRange,
} from "@/lib/chat-response-annotation-selection";
import {
  canSubmitChatResponseAnnotations,
  chatResponseAnnotationRangeKey,
  chatResponseAnnotationsForDraft,
  createChatResponseAnnotationState,
  responseAnnotationReducer,
  serializeChatResponseAnnotations,
  validateChatResponseAnnotationAdd,
  validateChatResponseAnnotationReplacement,
  type ChatResponseAnnotationDraft,
  type ChatResponseAnnotationState,
} from "@/lib/chat-response-annotations";
import { resolveRequestedPreferredAgentId } from "@/lib/chat-route-state";
import {
  buildChatSkillOptions,
  buildChatSkillReferenceOptions,
  filterChatSkillOptions,
} from "@/lib/chat-skill-options";
import {
  chatStopRecoveryActionKey,
  clearPendingChatStopRecovery,
  createChatStopRecoveryRetrier,
  createPendingChatStopRecovery,
  readPendingChatStopRecovery,
  savePendingChatStopRecovery,
  type PendingChatStopRecovery,
} from "@/lib/chat-stop-recovery";
import {
  nativeSteerTranscriptAnchor,
  readChatScopedFlag,
  readChatScopedState,
  shouldShowMessageDuringActiveEdit,
  shouldShowMessageDuringActiveStream,
} from "@/lib/chat-stream-state";
import { resolveChatTranscriptLoadState } from "@/lib/chat-transcript-loading";
import { readDesktopShell } from "@/lib/desktop-shell";
import { isPreviewableImage } from "@/lib/image-actions";
import type { AtomicInlineTokenElement } from "@/lib/inline-token-dom";
import { resolveLocalFileDisplayTarget, resolveLocalFileTarget } from "@/lib/local-file-targets";
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
import { usePluginMentionCatalog } from "@/lib/plugin-mentions";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "@/lib/router";
import { latestSideChatAnchor } from "@/lib/side-chat";
import { chatGenerationScopeKey, type SidePanelTarget } from "@/lib/side-panel-targets";
import { resolveTranscriptSkillSidePanelTarget } from "@/lib/transcript-skill-targets";
import { cn } from "@/lib/utils";
import {
  chatInlineAnnotationsFromStructuredPayload,
  type ChatConversation,
  type ChatInlineAnnotation,
  type ChatInlineAnnotationInput,
  type ChatMessage,
  type ChatOperationProposalDecisionAction,
  type ChatQueuedMessage,
  type ChatWorkManifestItem
} from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ChevronDown,
  CirclePlus,
  Copy,
  Folder,
  FolderInput,
  FolderPlus,
  GitFork,
  Loader2,
  Mail,
  MailOpen,
  MoreHorizontal,
  PanelRight,
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
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { PendingAttachmentPreview } from "./Chat.attachments";
import {
  ChatComposerFileDropOverlay,
  useChatComposerFileDrop,
  useChatComposerPasteAttachments,
} from "./Chat.file-drop";
import { AskUserPanel, AssistantDraftItem, ChatMessageItem, ChatMessagesLoadingState, LazyStreamTranscriptItem, OptimisticUserDraftItem, StreamTranscriptItem, chatIssueApprovalPayloadWithProposalOverride, type ChatTurnBranchControls } from "./Chat.messages";
import {
  ChatAgentMenuContent,
  ChatAgentSelectorButton,
  chatRuntimeSelectionLabel,
  handleChatAgentMenuKeyDown,
  useChatRuntimeMutation,
  useChatRuntimeSelection,
} from "./Chat.model-selector";
import { ASK_USER_ANSWER_PREFIX, ApprovalAction, ChatAgentRunMenuItem, ChatBranchPreview, ChatEmptyStatePromptOptions, ChatEmptyStatePromptStarters, ChatEmptyStateRecentConversations, EmptyStatePromptGroup, EmptyStatePromptSuggestion, INTERRUPTED_CHAT_CONTINUATION_PROMPT, NO_CHAT_AGENT_LABEL, NO_PROJECT_ID, applyChatPromptToDraft, approvalNeedsAction, askUserAnswerFromMessage, askUserRequestFromMessage, buildChatProposalRejectFeedbackPrompt, buildChatProposalRevisionPrompt, buildDraftChatContextLinks, buildMessengerChatThreadSummary, canRefreshAssistantChatMessage, canRefreshDisplayedAssistantChatMessage, chatEmptyStateHeading, chatPromptGroupForExactTrigger, chatPromptQueryKey, chatPromptSuggestionsForDisplay, chatPromptSuggestionsForDraft, chatSidePanelTargetFromHref, composerMenuPositionForAnchor, computeDisplayedChatMessages, conversationDisplayTitle, draftIssueContextLabel, findLatestUnansweredAskUserMessage, findRetrySourceUserMessage, formatChatPrimaryIssueBreadcrumb, isAskUserMessageAnswered, isChatAgentSelectionLocked, isChatProjectSelectionLocked, isUserVisibleIncomingChatMessage, issueProposalFromMessage, materializePendingAttachment, mergeChatConversationsForStatus, mergeChatMessages, operationProposalFromMessage, operationProposalStatusFromMessage, parseAskUserAnswerMessage, pendingAttachmentKey, projectContextId, projectDisplayName, rememberChatProjectId, rememberChatProjectIdForAgent, resolveDefaultDraftChatProjectId, resolveDraftIssueContext, scrollChatMessagesToBottom, shouldAttachApprovalFeedbackSystemMessage, shouldAttachIssueCreatedSystemMessage, shouldHandlePlainChatLinkClick, withOptimisticOutgoingMessage, withOptimisticPlanMode } from "./Chat.parts";
import { ChatPlanModeChip, ChatPlanModeMenuToggle } from "./Chat.plan-mode-controls";
import { usePendingChatResponseAnnotationSelection } from "./Chat.response-annotation-selection";
import { ChatScrollMap, countScrollMapUserMessages } from "./Chat.scroll-map";
import { buildChatTimelineRows } from "./Chat.timeline";
import { ChatWorkManifest, ChatWorkManifestToggle, hasChatWorkManifestContent } from "./Chat.work-manifest";
import { CHAT_ISSUE_MENTION_LIMIT, CHAT_LIST_PREVIEW_LIMIT, CHAT_SCROLL_MAP_USER_MESSAGE_THRESHOLD, CHAT_STEER_RETRY_DELAYS_MS, EMPTY_CHAT_BODY_SHA256, EMPTY_STATE_PROMPT_PAGE_TRANSITION_MS, RECENT_PROJECT_CONVERSATION_INITIAL_LIMIT, RECENT_PROJECT_CONVERSATION_LOAD_INCREMENT, activeGenerationIdFromSnapshot, applyChatStreamProgressEvent, canQueueComposerDraft, chatMessageJumpTargetFromHref, chatReferenceMarkdown, chatSendButtonDisabled, createQueuedComposerMessage, findChatMessageElement, isExternalBoundConversation, projectChatQueueDelivery, queuedMessagePayloadForBodyEdit, revealChatAnnotationSourceElement, revealChatMessageElement, sideChatTargetFromMessage, useChatDraftQueries, type PendingChatSteerRetry, type SendButtonMode } from "./Chat.workspace-helpers";
export * from "./Chat.attachments";
export * from "./Chat.messages";
export * from "./Chat.parts";
export { applyChatStreamProgressEvent } from "./Chat.workspace-helpers";

export function Chat() { const { selectedOrganizationId } = useOrganization(); return selectedOrganizationId ? <ChatWorkspace key={selectedOrganizationId} /> : <div className="text-sm text-muted-foreground">Select a organization first.</div>; }
function localAppRecoveryDraftStorageScope(value: string | null): string | null {
  const id = value?.trim() ?? "";
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)
    ? `local-app-recovery:${id}`
    : null;
}
function ChatWorkspace() { const { conversationId } = useParams<{ conversationId?: string }>(); const location = useLocation(); const navigate = useNavigate(); const [searchParams] = useSearchParams(); const queryClient = useQueryClient(); const { selectedOrganization, selectedOrganizationId } = useOrganization(); const { viewedOrganizationId } = useViewedOrganization(); const { t } = useI18n(); const { setBreadcrumbs } = useBreadcrumbs(); const { pushToast } = useToast(); const { confirm } = useDialog();
  const macDesktopShell = typeof document !== "undefined"
    && document.documentElement.classList.contains("desktop-shell-macos");
  const { openImagePreview } = useImagePreview(); const {
    abortChatStream,
    sendInFlightByChatId,
    setChatSendInFlight,
    setStreamAbortController,
    setStreamDraftForChat,
    streamDrafts, } = useChatGenerations(); const draftStorageOrgId = selectedOrganizationId!; const draftStorageConversationId = conversationId ?? localAppRecoveryDraftStorageScope(searchParams.get("localAppRecoveryDraft")) ?? null; const draftStorageScopeKey = resolveChatPendingAttachmentScopeKey(draftStorageOrgId, draftStorageConversationId); const activeDraftScopeRef = useRef(draftStorageScopeKey);
  const stopRecoveryImmediateRetryKeysRef = useRef(new Set<string>());
  const stopRecoveryStreamKeysRef = useRef<Record<string, string>>({});
  const streamOwnershipRef = useRef<Record<string, { streamKey: string; controller: AbortController }>>({});
  const streamDraftsRef = useRef(streamDrafts);
  const transcriptLoadPromisesRef = useRef<Record<string, Promise<TranscriptEntry[] | null>>>({});
  streamDraftsRef.current = streamDrafts;
  const submitStopRecoveryRef = useRef<(recovery: PendingChatStopRecovery) => void>(() => {});
  const stopRecoveryRetrierRef = useRef<ReturnType<typeof createChatStopRecoveryRetrier> | null>(null);
  if (!stopRecoveryRetrierRef.current) {
    stopRecoveryRetrierRef.current = createChatStopRecoveryRetrier((recovery) => {
      submitStopRecoveryRef.current(recovery);
    });
  }
  const stopRecoveryRetrier = stopRecoveryRetrierRef.current;
  const steerRetryStatesRef = useRef(new Map<string, PendingChatSteerRetry>());
  const submitSteerRetryRef = useRef<(pending: PendingChatSteerRetry) => void>(() => {});
  const initialComposerDraftRef = useRef<ReturnType<typeof readChatComposerDraft> | null>(null);
  if (!initialComposerDraftRef.current) {
    initialComposerDraftRef.current = readChatComposerDraft(
      draftStorageOrgId,
      draftStorageConversationId,
    );
  }
  const [draftState, setDraftState] = useState(() => ({
    scopeKey: draftStorageScopeKey,
    value: initialComposerDraftRef.current?.body ?? "",
  }));
  const [responseAnnotationState, dispatchResponseAnnotation] = useReducer(
    responseAnnotationReducer,
    initialComposerDraftRef.current?.inlineAnnotations ?? [],
    createChatResponseAnnotationState,
  );
  const responseAnnotationStateByScopeRef = useRef<Record<string, ChatResponseAnnotationState>>({});
  const [responseAnnotationsExpanded, setResponseAnnotationsExpanded] = useState(false);
  const draftResponseAnnotationsChipRef = useRef<HTMLButtonElement | null>(null);
  const responseAnnotationEditor = useResponseAnnotationEditorController(
    draftResponseAnnotationsChipRef,
  );
  const [historicalResponseAnnotations, setHistoricalResponseAnnotations] = useState<ChatResponseAnnotationDraft[]>([]);
  const [unlocatableResponseAnnotationId, setUnlocatableResponseAnnotationId] = useState<string | null>(null);
  const [responseAnnotationAnnouncement, setResponseAnnotationAnnouncement] = useState("");
  const draft = draftState.scopeKey === draftStorageScopeKey ? draftState.value : "";
  const setDraft = useCallback((nextDraft: string) => {
    setDraftState((current) => ({ ...current, value: nextDraft }));
  }, []);
  const [, refreshPendingFiles] = useState(0);
  const pendingFiles = readChatPendingAttachmentsForScope(draftStorageScopeKey);
  const setPendingFilesForCurrentScope = useCallback((updater: (current: File[]) => File[]) => { updateChatPendingAttachmentsForScope(draftStorageScopeKey, updater); refreshPendingFiles((version) => version + 1); }, [draftStorageScopeKey]); const clearPendingFilesForCurrentScope = useCallback(() => { setPendingFilesForCurrentScope(() => []); }, [setPendingFilesForCurrentScope]); const [newConversationSendInFlight, setNewConversationSendInFlight] = useState(false); const [openProcessMessageIds, setOpenProcessMessageIds] = useState<Record<string, boolean>>({}); const [loadingTranscriptMessageIds, setLoadingTranscriptMessageIds] = useState<Record<string, true>>({}); const [loadedTranscriptsByMessageId, setLoadedTranscriptsByMessageId] = useState<Record<string, TranscriptEntry[]>>({}); const [draftPreferredAgentId, setDraftPreferredAgentId] = useState<string>(NO_CHAT_AGENT_ID); const [draftProjectId, setDraftProjectId] = useState<string>(NO_PROJECT_ID);
  const [pendingProjectContextOverride, setPendingProjectContextOverride] = useState<{ chatId: string; projectId: string | null; } | null>(null); const [draftPlanMode, setDraftPlanMode] = useState(false); const [pendingPlanModeOverride, setPendingPlanModeOverride] = useState<boolean | null>(null); const [decisionNotesByMessageId, setDecisionNotesByMessageId] = useState<Record<string, string>>({}); const [issueProposalOverridesByMessageId, setIssueProposalOverridesByMessageId] = useState<Record<string, Record<string, unknown>>>({}); const [plusMenuOpen, setPlusMenuOpen] = useState(false); const [agentMenuOpen, setAgentMenuOpen] = useState(false); const [projectMenuOpen, setProjectMenuOpen] = useState(false); const [skillMenuOpen, setSkillMenuOpen] = useState(false); const [skillSearchQuery, setSkillSearchQuery] = useState(""); const [libraryFileMentionQuery, setLibraryFileMentionQuery] = useState<string | null>(null); const [composerMenuPosition, setComposerMenuPosition] = useState<CSSProperties | null>(null); const [sideChatSlashMenuPosition, setSideChatSlashMenuPosition] = useState<CSSProperties | null>(null); const [inlineEditUserMessageId, setInlineEditUserMessageId] = useState<string | null>(null); const [inlineEditDraft, setInlineEditDraft] = useState(""); const [editingQueuedItem, setEditingQueuedItem] = useState<{ itemId: string; value: string; version: number } | null>(null); const [stoppingChatIds, setStoppingChatIds] = useState<Set<string>>(() => new Set()); const [steeringQueuedItemIds, setSteeringQueuedItemIds] = useState<Set<string>>(() => new Set()); const [branchPreview, setBranchPreview] = useState<ChatBranchPreview | null>(null); const [emptyStateActiveTab, setEmptyStateActiveTab] = useState<"recent" | "use-cases">("use-cases"); const [emptyStateActiveSuggestionIndex, setEmptyStateActiveSuggestionIndex] = useState(0); const [dismissedEmptyStatePromptQuery, setDismissedEmptyStatePromptQuery] = useState<string | null>(null); const [retainedEmptyStatePromptSuggestions, setRetainedEmptyStatePromptSuggestions] = useState<readonly EmptyStatePromptSuggestion[]>([]); const [recentProjectConversationLimit, setRecentProjectConversationLimit] = useState(RECENT_PROJECT_CONVERSATION_INITIAL_LIMIT); const [recentAskUserAnswerMessageId, setRecentAskUserAnswerMessageId] = useState<string | null>(null); const [renamingConversationId, setRenamingConversationId] = useState<string | null>(null); const [renameDraft, setRenameDraft] = useState(""); const [generatingChatTitleIds, setGeneratingChatTitleIds] = useState<Set<string>>(() => new Set()); const [workManifestWideOpen, setWorkManifestWideOpen] = useState(true); const fileInputRef = useRef<HTMLInputElement>(null); const composerSurfaceRef = useRef<HTMLDivElement>(null); const composerEditorRef = useRef<MarkdownEditorRef>(null); const inlineEditSurfaceRef = useRef<HTMLDivElement>(null); const inlineEditEditorRef = useRef<MarkdownEditorRef>(null); const composerContextMenuRef = useRef<HTMLDivElement>(null); const composerEditorScrollRef = useScrollbarActivityRef(); const skillSearchInputRef = useRef<HTMLInputElement>(null); const manuallyMarkedUnreadKeyRef = useRef<string | null>(null); const newConversationSendLockRef = useRef(false); const chatSendLocksRef = useRef<Record<string, true>>({}); const stoppingChatIdsRef = useRef(new Set<string>()); const steeringQueuedItemIdsRef = useRef(new Set<string>()); const lastAppliedPrefillRef = useRef<string | null>(null); const lastAppliedAgentPrefillRef = useRef<string | null>(null); const lastAppliedProjectPrefillRef = useRef<string | null>(null); const draftProjectScopeKeyRef = useRef<string | null>(null); const draftProjectDefaultKeyRef = useRef<string | null>(null); const draftProjectManuallySelectedRef = useRef(false); const chatMessagesScrollElementRef = useRef<HTMLDivElement | null>(null); const chatMainWorkspaceRef = useRef<HTMLElement | null>(null); const initialScrolledConversationRef = useRef<string | null>(null); const { isMobile } = useSidebar(); const { open: sidePanelOpen, openTarget: openSidePanelTarget, openTargetForContext: openSidePanelTargetForContext, showPanelForContext: showSidePanelForContext } = useSidePanel(); const chatMessagesActivityRef = useScrollbarActivityRef(); const chatMessagesScrollRef = useCallback((element: HTMLDivElement | null) => { chatMessagesScrollElementRef.current = element; chatMessagesActivityRef(element); }, [chatMessagesActivityRef]); const pendingPrefill = searchParams.get("prefill") ?? ""; const pendingAgentPrefill = searchParams.get("agentId")?.trim() ?? ""; const pendingProjectPrefill = searchParams.get("projectId")?.trim() ?? ""; const pendingIssueId = searchParams.get("issueId")?.trim() ?? ""; const pendingTargetMessageId = (searchParams.get("messageId") ?? searchParams.get("targetMessageId") ?? "").trim(); const isMessengerChatRoute = /^\/(?:[^/]+\/)?messenger\/chat(?:\/|$)/.test(location.pathname); const relativePath = toOrganizationRelativePath(location.pathname); const chatRouteBase = relativePath.startsWith("/messenger/chat") ? "/messenger/chat" : "/chat"; const chatRootPath = chatRouteBase; const chatConversationPath = useCallback((id: string) => `${chatRouteBase}/${id}`, [chatRouteBase]); const resolveCurrentSidePanelChatContextKey = useCallback(() => { const activePath = typeof window === "undefined" ? relativePath : toOrganizationRelativePath(window.location.pathname); const match = activePath.match(/^\/(?:messenger\/)?chat\/([^/?#]+)/); const chatId = match?.[1] ?? conversationId ?? null; return chatId ? `chat:${chatId}` : null; }, [conversationId, relativePath]); const openLocalFile = useCallback((targetPath: string) => { const desktopShell = readDesktopShell();
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
  const checkpointDispatcherRef = useRef<ReturnType<typeof createChatClientCheckpointDispatcher> | null>(null);
  if (!checkpointDispatcherRef.current) {
    checkpointDispatcherRef.current = createChatClientCheckpointDispatcher((checkpoint) => {
      const { chatId, ...request } = checkpoint;
      return chatsApi.checkpointMessageStream(chatId, request);
    });
  }
  const checkpointDispatcher = checkpointDispatcherRef.current;
  useLayoutEffect(() => {
    const activeCheckpointKeys = new Set<string>();
    for (const streamDraft of Object.values(streamDrafts)) {
      const chatId = streamDraft.chatId;
      if (streamDraft.state !== "streaming" && streamDraft.state !== "tool_busy" && streamDraft.state !== "finalizing") continue;
      if (!chatId) continue;
      if (!streamDraft.generationId || !streamDraft.attemptEpoch) continue;
      if (streamDraft.lastCommittedRenderSeq === undefined || !streamDraft.renderedBodyHash) continue;
      const checkpoint = {
        chatId,
        generationId: streamDraft.generationId,
        attemptEpoch: streamDraft.attemptEpoch,
        generationSeq: streamDraft.lastCommittedRenderSeq,
        renderedBodyHash: streamDraft.renderedBodyHash,
      };
      activeCheckpointKeys.add(chatClientCheckpointKey(checkpoint));
      checkpointDispatcher.enqueue(checkpoint);
    }
    checkpointDispatcher.retain(activeCheckpointKeys);
  }, [checkpointDispatcher, streamDrafts]);
  useEffect(() => () => checkpointDispatcher.dispose(), [checkpointDispatcher]);
  const {
    data: organizationSkills,
    error: organizationSkillsError,
    isPending: organizationSkillsPending,
  } = useQuery({
    queryKey: queryKeys.organizationSkills.list(selectedOrganizationId ?? "__none__"),
    queryFn: () => organizationSkillsApi.list(selectedOrganizationId!), enabled: !!selectedOrganizationId, });
  const handleChatMarkdownLinkClick = useCallback<MarkdownLinkClickHandler>(({ event, href, label, sourceHref }) => { if (!shouldHandlePlainChatLinkClick(event)) return; const skillReferenceTarget = sourceHref ? chatSidePanelTargetFromHref(sourceHref, label, organizationSkills) : null; if (skillReferenceTarget) { event.preventDefault(); event.stopPropagation(); openSidePanelTargetForContext(resolveCurrentSidePanelChatContextKey(), skillReferenceTarget); return true; } const chatMessageTarget = chatMessageJumpTargetFromHref(href); if (chatMessageTarget) { event.preventDefault(); event.stopPropagation(); const pathname = chatConversationPath(chatMessageTarget.conversationId); navigate(chatMessageTarget.messageId ? {
        pathname,
        search: `?messageId=${encodeURIComponent(chatMessageTarget.messageId)}`,
      } : pathname); return true; } const sidePanelTarget = chatSidePanelTargetFromHref(href, label, organizationSkills); if (sidePanelTarget) { if (sidePanelTarget.kind === "library_file" && selectedOrganizationId && isPreviewableImage(null, sidePanelTarget.filePath)) { const previewContextKey = resolveCurrentSidePanelChatContextKey(); event.preventDefault(); event.stopPropagation(); void organizationsApi.readWorkspaceFile(selectedOrganizationId, sidePanelTarget.filePath).then((file) => { if (resolveCurrentSidePanelChatContextKey() !== previewContextKey) return; if (file.previewKind !== "image" || !file.contentPath || !isPreviewableImage(file.contentType, file.filePath)) throw new Error("This Library file is not a previewable image."); const name = label.trim() || file.filePath.split("/").at(-1) || file.filePath; openImagePreview({ alt: name, name, src: file.contentPath, testId: "chat-library-image-preview-dialog", titleFallback: "Image preview" }); }).catch(() => { if (resolveCurrentSidePanelChatContextKey() === previewContextKey) openSidePanelTargetForContext(previewContextKey, sidePanelTarget); }); return true; } event.preventDefault(); event.stopPropagation(); openSidePanelTargetForContext(resolveCurrentSidePanelChatContextKey(), sidePanelTarget); return true; } const targetPath = resolveLocalFileTarget(href, label); if (!targetPath) { if (!sourceHref) return; event.preventDefault(); event.stopPropagation(); pushToast({ title: "Skill file is not available", body: `Could not resolve ${label.trim() || "this skill"} in the current organization.`, tone: "info" }); return true; } const displayTargetPath = resolveLocalFileDisplayTarget(href, label); const localImageLink = displayTargetPath !== null && isPreviewableImage(null, displayTargetPath); const desktopShell = localImageLink ? readDesktopShell() : null; if (desktopShell) { const previewContextKey = resolveCurrentSidePanelChatContextKey(); event.preventDefault(); event.stopPropagation(); void desktopShell.previewLocalFile(targetPath).then((preview) => { if (resolveCurrentSidePanelChatContextKey() !== previewContextKey) return; if (preview.previewKind !== "image" || !preview.base64 || !isPreviewableImage(preview.contentType, preview.fileName)) throw new Error("This local file is not a previewable image."); const contentType = preview.contentType.split(";", 1)[0]?.trim() || "image/png"; const name = label.trim() || preview.fileName; openImagePreview({ alt: name, name, src: `data:${contentType};base64,${preview.base64}`, testId: "chat-local-image-preview-dialog", titleFallback: "Image preview" }); }).catch(() => { if (resolveCurrentSidePanelChatContextKey() === previewContextKey) openSidePanelTargetForContext(previewContextKey, { kind: "local_file", filePath: targetPath, label: label.trim() || targetPath.split(/[\\/]/u).at(-1) || targetPath }); }); return true; } event.preventDefault(); event.stopPropagation(); openSidePanelTargetForContext(resolveCurrentSidePanelChatContextKey(), {
        kind: "local_file",
        filePath: targetPath,
        label: label.trim() || targetPath.split(/[\\/]/u).at(-1) || targetPath,
      }); return true; }, [chatConversationPath, navigate, openImagePreview, openSidePanelTargetForContext, organizationSkills, pushToast, resolveCurrentSidePanelChatContextKey, selectedOrganizationId]); const composerContextMenuOpen = projectMenuOpen || agentMenuOpen || skillMenuOpen;
  const openTranscriptFile = useCallback((targetPath: string, label: string) => {
    openSidePanelTargetForContext(resolveCurrentSidePanelChatContextKey(), {
      kind: "local_file",
      filePath: targetPath,
      label,
    });
  }, [openSidePanelTargetForContext, resolveCurrentSidePanelChatContextKey]);
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
  const handlePendingAttachmentPasteCapture = useChatComposerPasteAttachments(appendPendingFiles);
  const { active: composerFileDragActive, targetProps: composerFileDropTargetProps } = useChatComposerFileDrop(appendPendingFiles);
  useEffect(() => {
    if (draftState.scopeKey === draftStorageScopeKey) return;
    responseAnnotationStateByScopeRef.current[draftState.scopeKey] = responseAnnotationState;
    const storedDraft = readChatComposerDraft(
      draftStorageOrgId,
      draftStorageConversationId,
    );
    const inMemoryAnnotations = responseAnnotationStateByScopeRef.current[draftStorageScopeKey];
    setDraftState({
      scopeKey: draftStorageScopeKey,
      value: storedDraft.body,
    });
    dispatchResponseAnnotation({
      type: "reset",
      annotations: inMemoryAnnotations
        ? chatResponseAnnotationsForDraft(inMemoryAnnotations)
        : storedDraft.inlineAnnotations,
      pendingFilesByAnnotationId: inMemoryAnnotations?.pendingFilesByAnnotationId,
    });
    setResponseAnnotationsExpanded(false);
    responseAnnotationEditor.close();
    setPendingResponseAnnotationSelection(null);
    setHistoricalResponseAnnotations([]);
    setUnlocatableResponseAnnotationId(null);
  }, [
    draftState.scopeKey,
    draftStorageConversationId,
    draftStorageOrgId,
    draftStorageScopeKey,
    responseAnnotationState,
  ]);
  useEffect(() => {
    if (draftState.scopeKey !== draftStorageScopeKey) return;
    responseAnnotationStateByScopeRef.current[draftStorageScopeKey] = responseAnnotationState;
    saveChatComposerDraft(
      draftStorageOrgId,
      draftStorageConversationId,
      {
        version: CHAT_COMPOSER_DRAFT_VERSION,
        body: draftState.value,
        inlineAnnotations: chatResponseAnnotationsForDraft(responseAnnotationState),
      },
    );
  }, [
    draftState.scopeKey,
    draftState.value,
    draftStorageConversationId,
    draftStorageOrgId,
    draftStorageScopeKey,
    responseAnnotationState,
  ]);
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
    queryFn: () => chatsApi.get(conversationId!), enabled: !!selectedOrganizationId && !!conversationId && organizationRouteMatchesSelection, }); const activeConversationFromList = conversationsQuery.data?.find((conversation) => conversation.id === conversationId) ?? null; const conversationSnapshot = conversationQuery.data ?? activeConversationFromList; const activeConversationBelongsToSelectedOrganization = organizationRouteMatchesSelection && conversationSnapshot?.orgId === selectedOrganizationId; const canQueryMessages = resolveChatTranscriptLoadState({
    selectedOrganizationId,
    conversationId: conversationId ?? null,
    organizationRouteMatchesSelection,
    conversationSnapshotOrganizationId: conversationSnapshot?.orgId ?? null,
    hasConversationSnapshot: activeConversationBelongsToSelectedOrganization,
    conversationDetailPending: conversationQuery.isPending,
    hasMessages: false,
    messagesPending: true,
  }).canQueryMessages; const messagesQuery = useQuery({
    queryKey: queryKeys.chats.messages(selectedOrganizationId ?? "__none__", conversationId ?? "__none__"),
    queryFn: () => chatsApi.listMessages(selectedOrganizationId!, conversationId!, { includeTranscript: false }), enabled: canQueryMessages, });
  const workManifestQuery = useQuery({
    queryKey: queryKeys.chats.workManifest(selectedOrganizationId ?? "__none__", conversationId ?? "__none__"),
    queryFn: () => chatsApi.getWorkManifest(conversationId!),
    enabled: !!conversationId && activeConversationBelongsToSelectedOrganization,
    refetchInterval: (query) => (
      (query.state.data?.subagents.active.length ?? 0) > 0 ? 2_000 : false
    ),
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
  const serverActiveGenerationId = activeGenerationIdFromSnapshot(queueQuery.data);
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
  }); const customGroups = customGroupsQuery.data?.groups ?? []; const selectedConversationStreamScopeKey = selectedConversation && selectedOrganizationId
    ? chatGenerationScopeKey(selectedOrganizationId, selectedConversation)
    : null; const streamScopeKeyForChatId = useCallback((chatId: string) => (
      selectedConversation?.id === chatId && selectedConversationStreamScopeKey
        ? selectedConversationStreamScopeKey
        : chatId
    ), [selectedConversation?.id, selectedConversationStreamScopeKey]); const selectedConversationThreadKey = selectedConversation ? `chat:${selectedConversation.id}` : null; const selectedConversationCustomGroupId = selectedConversationThreadKey
    ? customGroups.find((group) => group.entries.some((entry) => entry.threadKey === selectedConversationThreadKey))?.id ?? null
    : null; const selectedConversationGenerating = Boolean(selectedConversation && selectedConversationStreamScopeKey && (streamDrafts[selectedConversationStreamScopeKey] || sendInFlightByChatId[selectedConversationStreamScopeKey])); const selectedConversationTitleGenerating = Boolean(selectedConversation && generatingChatTitleIds.has(selectedConversation.id)); const draftIssueContext = !selectedConversation ? resolveDraftIssueContext(issues, pendingIssueId) : null; const draftIssueContextId = !selectedConversation && pendingIssueId ? draftIssueContext?.id ?? pendingIssueId : null; const activeAgentId = selectedConversation?.preferredAgentId ?? draftPreferredAgentId; const selectedConversationProjectId = projectContextId(selectedConversation);
  const pendingSelectedConversationProjectId = selectedConversation && pendingProjectContextOverride?.chatId === selectedConversation.id ? pendingProjectContextOverride.projectId : undefined; const activeProjectId = selectedConversation ? (pendingSelectedConversationProjectId ?? selectedConversationProjectId ?? NO_PROJECT_ID) : draftProjectId; const activePlanMode = pendingPlanModeOverride ?? selectedConversation?.planMode ?? draftPlanMode; const activeSkillAgentId = activeAgentId === NO_CHAT_AGENT_ID ? null : activeAgentId; const activeSkillAgent = activeSkillAgentId ? (agents ?? []).find((agent) => agent.id === activeSkillAgentId) ?? null : null;
  const conversationHeaderAgentId = selectedConversation?.preferredAgentId
    ?? selectedConversation?.chatRuntime.runtimeAgentId
    ?? null;
  const conversationHeaderAgent = conversationHeaderAgentId
    ? (agents ?? []).find((agent) => agent.id === conversationHeaderAgentId) ?? null
    : null;
  const { activeRuntimeOverrides, adapterModelsQuery, draftRuntimeOverrides, runtimeModelSelectRef, runtimeSelectorRef, setDraftRuntimeOverrides, setPendingConversationRuntimeOverrides } = useChatRuntimeSelection({ selectedOrganizationId, selectedConversation, activeAgentId: activeSkillAgentId, activeAgent: activeSkillAgent }); const draftProjectScopeKey = `${selectedOrganizationId ?? "__none__"}:${conversationId ?? "new"}:${pendingIssueId || "__no_issue_project__"}`; const draftIssueProjectKey = draftIssueContext?.projectId ?? "__no_issue_project__"; const draftProjectDefaultKey = selectedConversation ? null : `${draftProjectScopeKey}:${activeSkillAgentId ?? "__no_agent__"}:${draftIssueProjectKey}`;
  const openSubagentInspection = useCallback((inspection: TranscriptAgentInspection) => {
    if (!selectedConversation) return;
    const senderAgentId = selectedConversation.chatRuntime.runtimeAgentId ?? selectedConversation.preferredAgentId;
    const senderLabel = (agents ?? []).find((agent) => agent.id === senderAgentId)?.name
      ?? selectedConversation.chatRuntime.sourceLabel
      ?? "Main agent";
    const promptLabel = inspection.prompt.replace(/\s+/g, " ").trim();
    const shortPrompt = promptLabel.length > 42 ? `${promptLabel.slice(0, 41)}…` : promptLabel;
    const threadIdentity = inspection.threadId.startsWith("thread-")
      ? inspection.threadId.slice("thread-".length)
      : inspection.threadId;
    const threadLabel = threadIdentity.length > 8 ? threadIdentity.slice(-8) : threadIdentity;
    openSidePanelTargetForContext(resolveCurrentSidePanelChatContextKey(), {
      kind: "subagent",
      ...inspection,
      label: shortPrompt ? `Sub-agent ${threadLabel} · ${shortPrompt}` : `Sub-agent ${threadLabel}`,
      senderLabel,
    });
  }, [agents, openSidePanelTargetForContext, resolveCurrentSidePanelChatContextKey, selectedConversation]);
  const draftContextLinks = useMemo(
    () => buildDraftChatContextLinks(
      activeProjectId === NO_PROJECT_ID ? null : activeProjectId,
      draftIssueContextId,
    ),
    [activeProjectId, draftIssueContextId],
  );
  const { draftPreflightQuery, projectConversationsQuery } = useChatDraftQueries({
    selectedOrganizationId,
    selectedConversation,
    activeAgentId: activeSkillAgentId,
    modelOverride: activeRuntimeOverrides.modelOverride,
    effortOverride: activeRuntimeOverrides.effortOverride,
    activeProjectId,
    issueContextId: draftIssueContextId,
    planMode: activePlanMode,
    noProjectId: NO_PROJECT_ID,
    contextLinks: draftContextLinks,
  });
  const resolveTranscriptSkillTarget = useCallback(
    (target: TranscriptSkillTarget) => (
      resolveTranscriptSkillSidePanelTarget(target, organizationSkills)
    ),
    [organizationSkills],
  );
  const canOpenTranscriptSkill = useCallback(
    (target: TranscriptSkillTarget) => Boolean(resolveTranscriptSkillTarget(target)),
    [resolveTranscriptSkillTarget],
  );
  const openTranscriptSkill = useCallback(
    (target: TranscriptSkillTarget) => {
      const sidePanelTarget = resolveTranscriptSkillTarget(target);
      if (!sidePanelTarget) return;
      openSidePanelTargetForContext(
        resolveCurrentSidePanelChatContextKey(),
        sidePanelTarget,
      );
    },
    [
      openSidePanelTargetForContext,
      resolveCurrentSidePanelChatContextKey,
      resolveTranscriptSkillTarget,
    ],
  );
  const {
    data: activeAgentSkillSnapshot,
    error: activeAgentSkillsError,
    isPending: activeAgentSkillsPending,
  } = useQuery({
    queryKey: queryKeys.agents.skills(activeSkillAgentId ?? "__none__"),
    queryFn: () => agentsApi.skills(activeSkillAgentId!, selectedOrganizationId!), enabled: Boolean(selectedOrganizationId) && Boolean(activeSkillAgentId), });
  useEffect(() => { setInlineEditUserMessageId(null); setInlineEditDraft(""); setBranchPreview(null); setRecentAskUserAnswerMessageId(null); setIssueProposalOverridesByMessageId({}); }, [conversationId]);
  useEffect(() => { setSkillMenuOpen(false); setSkillSearchQuery(""); }, [activeSkillAgentId]);
  useEffect(() => {
    if (!composerContextMenuOpen) { setComposerMenuPosition(null);
      return; } const updatePosition = () => { const anchor = agentMenuOpen ? runtimeSelectorRef.current ?? composerSurfaceRef.current : composerSurfaceRef.current; if (!anchor) return; setComposerMenuPosition(composerMenuPositionForAnchor(anchor)); }; updatePosition(); window.addEventListener("resize", updatePosition); window.addEventListener("scroll", updatePosition, true);
    return () => { window.removeEventListener("resize", updatePosition); window.removeEventListener("scroll", updatePosition, true); }; }, [agentMenuOpen, composerContextMenuOpen, runtimeSelectorRef]);
  useEffect(() => { if (!composerContextMenuOpen) return; const handlePointerDown = (event: PointerEvent) => { const target = event.target; if (!(target instanceof Node)) return; if (target instanceof Element && target.closest("[data-chat-runtime-submenu]")) return; if (composerContextMenuRef.current?.contains(target)) return; if (runtimeSelectorRef.current?.contains(target)) return; closeComposerContextMenus(); }; const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        const restoreRuntimeFocus = agentMenuOpen;
        closeComposerContextMenus();
        if (restoreRuntimeFocus) {
          requestAnimationFrame(() => runtimeSelectorRef.current?.focus());
        }
      } }; document.addEventListener("pointerdown", handlePointerDown, true); document.addEventListener("keydown", handleKeyDown);
    return () => { document.removeEventListener("pointerdown", handlePointerDown, true); document.removeEventListener("keydown", handleKeyDown); }; }, [agentMenuOpen, closeComposerContextMenus, composerContextMenuOpen, runtimeSelectorRef]);
  useEffect(() => { if (!agentMenuOpen) return; requestAnimationFrame(() => { composerContextMenuRef.current?.querySelector<HTMLButtonElement>("[data-chat-composer-menu-item]")?.focus(); }); }, [agentMenuOpen]);
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
  const transcriptLoadState = resolveChatTranscriptLoadState({
    selectedOrganizationId,
    conversationId: conversationId ?? null,
    organizationRouteMatchesSelection,
    conversationSnapshotOrganizationId: conversationSnapshot?.orgId ?? null,
    hasConversationSnapshot: Boolean(selectedConversation),
    conversationDetailPending: conversationQuery.isPending && conversationQuery.data === undefined,
    hasMessages: messagesQuery.data !== undefined,
    messagesPending: messagesQuery.isPending,
  });
  const showConversationLoading = transcriptLoadState.showConversationLoading;
  useEffect(() => { if (!selectedOrganizationId || !organizationRouteMatchesSelection) return; if (!relativePath.startsWith("/messenger/chat")) return; rememberMessengerPath(selectedOrganizationId, relativePath); }, [organizationRouteMatchesSelection, relativePath, selectedOrganizationId]); const refreshChat = async (chatId?: string | null) => { if (!selectedOrganizationId) return; const workManifestRefresh = chatId ? queryClient.invalidateQueries({ queryKey: queryKeys.chats.workManifest(selectedOrganizationId, chatId) }) : Promise.resolve();
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(selectedOrganizationId, "active") }),
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(selectedOrganizationId, "all") }), invalidateMessengerThreadSummaryQueries(queryClient, selectedOrganizationId), ]);
    if (chatId) { await queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(selectedOrganizationId, chatId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.chats.messages(selectedOrganizationId, chatId) });
      await workManifestRefresh;
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
      if (messageId in current && current[messageId] === open) return current;
      return { ...current, [messageId]: open };
    }); }, []); const loadMessageTranscript = useCallback((chatId: string, messageId: string) => {
    const pending = transcriptLoadPromisesRef.current[messageId];
    if (pending) return pending;
    const request = (async () => {
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
        return transcript;
      } catch (error) {
        pushToast({
          title: "Failed to load process details",
          body: error instanceof Error ? error.message : "Try again.",
          tone: "error",
        });
        return null;
      } finally {
        const { [messageId]: _removed, ...rest } = transcriptLoadPromisesRef.current;
        transcriptLoadPromisesRef.current = rest;
        setLoadingTranscriptMessageIds((current) => {
          if (!(messageId in current)) return current;
          const { [messageId]: _removed, ...rest } = current;
          return rest;
        });
      }
    })();
    transcriptLoadPromisesRef.current[messageId] = request;
    return request;
  }, [pushToast, queryClient, selectedOrganizationId, setProcessOpenForMessage]); const keepProcessOpenForMessages = useCallback((messages: ChatMessage[]) => { const messageIds = messages .filter((message) => { const transcript = (message.transcript ?? []) as TranscriptEntry[];
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
        tone: "error", }); }, });
  const { applyRuntimeOverrides, runtimeSelectionPending } = useChatRuntimeMutation({
    activeAgent: activeSkillAgent, selectedConversation, setDraftRuntimeOverrides, setPendingConversationRuntimeOverrides,
    upsertConversation, upsertMessengerThreadSummary, refreshActiveChatActions,
    reportError: (title, body) => pushToast({ title, body, tone: "error" }),
  }); const renameConversationMutation = useMutation({
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
        const streamScopeKey = streamScopeKeyForChatId(chatId);
        abortChatStream(streamScopeKey);
        await chatsApi.stopMessageStream(chatId).catch(() => undefined);
        setStreamDraftForChat(streamScopeKey, null);
        setChatSendInFlight(streamScopeKey, false);
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
        tone: "error", }); }, }); const stopRecoveryMatchesCurrentStream = useCallback((
    recovery: PendingChatStopRecovery,
  ) => {
    const streamKey = recovery.frozenDraft?.streamKey;
    if (!streamKey) return false;
    const ownedStream = streamOwnershipRef.current[recovery.chatId];
    if (ownedStream) return ownedStream.streamKey === streamKey;
    const currentDraft = streamDraftsRef.current[streamScopeKeyForChatId(recovery.chatId)];
    if (currentDraft) return currentDraft.streamKey === streamKey;
    return stopRecoveryStreamKeysRef.current[recovery.chatId] === streamKey;
  }, [streamScopeKeyForChatId]); const submitStopRecovery = useCallback((
    recovery: PendingChatStopRecovery,
  ) => {
    const { chatId, frozenDraft, orgId, request } = recovery;
    const actionKey = chatStopRecoveryActionKey(recovery);
    if (stoppingChatIdsRef.current.has(chatId)) {
      stopRecoveryImmediateRetryKeysRef.current.add(actionKey);
      return;
    }
    const persistedRecovery = readPendingChatStopRecovery(orgId, chatId);
    if (
      persistedRecovery
      && persistedRecovery.request.controlActionId !== request.controlActionId
    ) {
      stopRecoveryRetrier.resolve(recovery);
      return;
    }
    stoppingChatIdsRef.current.add(chatId);
    setStoppingChatIds((current) => new Set(current).add(chatId));
    const streamScopeKey = streamScopeKeyForChatId(chatId);
    const streamKey = frozenDraft?.streamKey ?? null;
    if (frozenDraft) {
      const ownedStream = streamOwnershipRef.current[chatId];
      const currentDraft = streamDraftsRef.current[streamScopeKey];
      if (
        (!ownedStream || ownedStream.streamKey === streamKey)
        && (!currentDraft || currentDraft.streamKey === streamKey)
      ) {
        stopRecoveryStreamKeysRef.current[chatId] = streamKey!;
      }
      setStreamDraftForChat(streamScopeKey, (current) => {
        if (current && current.streamKey !== frozenDraft.streamKey) return current;
        return { ...frozenDraft, state: "stopping" };
      });
    }
    let stopActionSettled = false;
    void (async () => {
      try {
        const result = await chatsApi.stopMessageStream(chatId, request);
        const acknowledgedActionId = result.controlActionId ?? request.controlActionId;
        if (acknowledgedActionId !== request.controlActionId) {
          stopRecoveryRetrier.schedule(recovery);
          pushToast({
            title: "Stop confirmation pending",
            body: "Rudder returned a different Stop action; the original action will be retried.",
            tone: "warn",
          });
          return;
        }
        stopRecoveryRetrier.resolve(recovery);
        stopActionSettled = true;
        const cutoffAccepted = result.stopped || [
          "stopping",
          "stop_requested",
          "stopped",
          "interrupted_unverified",
        ].includes(result.disposition ?? "");
        const completionCommitted = !result.stopped && result.disposition === "completion_committed";
        if (cutoffAccepted && stopRecoveryMatchesCurrentStream(recovery)) {
          abortChatStream(streamScopeKey);
        } else if (streamKey && stopRecoveryStreamKeysRef.current[chatId] === streamKey) {
          delete stopRecoveryStreamKeysRef.current[chatId];
        }
        await Promise.allSettled([
          Promise.resolve().then(() => queryClient.invalidateQueries({
            queryKey: queryKeys.chats.messages(orgId, chatId),
          })),
          Promise.resolve().then(() => queryClient.invalidateQueries({
            queryKey: queryKeys.chats.queue(orgId, chatId),
          })),
        ]);
        if (streamKey && stopRecoveryMatchesCurrentStream(recovery)) {
          setStreamDraftForChat(streamScopeKey, (current) => current?.streamKey === streamKey ? null : current);
          setChatSendInFlight(streamScopeKey, false);
        }
        clearPendingChatStopRecovery(orgId, chatId, request.controlActionId);

        pushToast({
          title: completionCommitted
            ? "Response completed"
            : result.stopped
            ? "Response stopped"
            : cutoffAccepted
              ? "Response frozen"
              : "No active response",
          body: completionCommitted
            ? "The final response committed before Stop reached the cutoff."
            : result.stopped
            ? "Rudder interrupted the current reply."
            : cutoffAccepted
              ? "Visible output is frozen; runtime termination could not be independently confirmed."
              : "The response had already reached a terminal state.",
          tone: result.stopped || completionCommitted ? "info" : "warn",
        });
      } catch (error) {
        const definitivelyRejected = error instanceof ApiError
          && error.status >= 400
          && error.status < 500;
        if (definitivelyRejected) {
          stopRecoveryRetrier.resolve(recovery);
          stopActionSettled = true;
          if (streamKey && stopRecoveryMatchesCurrentStream(recovery)) {
            setStreamDraftForChat(streamScopeKey, (current) => current?.streamKey === streamKey
              ? { ...frozenDraft!, state: recovery.previousStreamState ?? "streaming" }
              : current);
          }
          if (streamKey && stopRecoveryStreamKeysRef.current[chatId] === streamKey) {
            delete stopRecoveryStreamKeysRef.current[chatId];
          }
          clearPendingChatStopRecovery(orgId, chatId, request.controlActionId);
        } else {
          stopRecoveryRetrier.schedule(recovery);
        }
        pushToast({
          title: definitivelyRejected ? "Stop was rejected" : "Stop confirmation pending",
          body: error instanceof Error ? error.message : "Rudder will retry automatically.",
          tone: definitivelyRejected ? "error" : "warn",
        });
      } finally {
        setStoppingChatIds((current) => {
          if (!current.has(chatId)) return current;
          const next = new Set(current);
          next.delete(chatId);
          return next;
        });
        stoppingChatIdsRef.current.delete(chatId);
        const retryImmediately = stopRecoveryImmediateRetryKeysRef.current.delete(actionKey)
          && !stopActionSettled;
        const pendingRecovery = retryImmediately
          ? readPendingChatStopRecovery(orgId, chatId) ?? recovery
          : null;
        if (pendingRecovery?.request.controlActionId === request.controlActionId) {
          stopRecoveryRetrier.retryNow(pendingRecovery);
        }
      }
    })();
  }, [abortChatStream, pushToast, queryClient, setChatSendInFlight, setStreamDraftForChat, stopRecoveryMatchesCurrentStream, stopRecoveryRetrier, streamScopeKeyForChatId]); submitStopRecoveryRef.current = submitStopRecovery; const stopStreaming = useCallback((chatId: string) => {
    if (!selectedOrganizationId || stoppingChatIdsRef.current.has(chatId)) return;
    const existingRecovery = readPendingChatStopRecovery(selectedOrganizationId, chatId);
    if (existingRecovery) {
      stopRecoveryRetrier.retryNow(existingRecovery);
      return;
    }
    const streamDraft = streamDrafts[streamScopeKeyForChatId(chatId)] ?? null;
    const serverGenerationFence = serverActiveGenerationId
      && queueQuery.data?.activeAttemptEpoch !== null
      && queueQuery.data?.activeAttemptEpoch !== undefined
      && queueQuery.data?.activeControlVersion !== null
      && queueQuery.data?.activeControlVersion !== undefined
      ? {
          generationId: serverActiveGenerationId,
          attemptEpoch: queueQuery.data.activeAttemptEpoch,
          controlVersion: queueQuery.data.activeControlVersion,
        }
      : null;
    const recovery = createPendingChatStopRecovery({
      orgId: selectedOrganizationId,
      chatId,
      request: {
        controlActionId: globalThis.crypto.randomUUID(),
        ...(serverGenerationFence ? {
          expectedGenerationId: serverGenerationFence.generationId,
          expectedAttemptEpoch: serverGenerationFence.attemptEpoch,
          expectedControlVersion: serverGenerationFence.controlVersion,
        } : {}),
        ...(streamDraft ? {
          lastCommittedRenderSeq: streamDraft.lastCommittedRenderSeq ?? 0,
          renderedBodyHash: streamDraft.renderedBodyHash ?? EMPTY_CHAT_BODY_SHA256,
        } : {}),
      },
      frozenDraft: streamDraft,
    });
    savePendingChatStopRecovery(recovery);
    submitStopRecovery(recovery);
  }, [queueQuery.data, selectedOrganizationId, stopRecoveryRetrier, streamDrafts, streamScopeKeyForChatId, submitStopRecovery]);
  useEffect(() => () => {
    stopRecoveryRetrierRef.current?.dispose();
    for (const pending of steerRetryStatesRef.current.values()) {
      if (pending.timer) clearTimeout(pending.timer);
    }
    steerRetryStatesRef.current.clear();
  }, []);
  useLayoutEffect(() => {
    if (!selectedOrganizationId || !conversationId) return;
    const replayPendingStop = () => {
      const recovery = readPendingChatStopRecovery(selectedOrganizationId, conversationId);
      if (recovery) stopRecoveryRetrierRef.current?.retryNow(recovery);
    };
    replayPendingStop();
    window.addEventListener("online", replayPendingStop);
    return () => window.removeEventListener("online", replayPendingStop);
  }, [conversationId, selectedOrganizationId]); const readComposerDraft = useCallback(() => composerEditorRef.current?.getMarkdown?.() ?? draft, [draft]);
  const queueComposerMessage = async (
    conversation: ChatConversation,
    bodyOverride?: string,
    options?: {
      files?: File[];
      inlineAnnotations?: ChatInlineAnnotationInput[];
      annotationFiles?: File[];
      clearComposerOnSuccess?: boolean;
    },
  ) => {
    if (isExternalBoundConversation(conversation)) {
      pushToast({ title: "Fork this Feishu chat to continue in Rudder", tone: "error" });
      return false;
    }
    if (!selectedOrganizationId) { pushToast({ title: "Select a organization first", tone: "error" });
      return false; } const body = (bodyOverride ?? readComposerDraft()).trim();
    const regularFiles = options?.files ?? pendingFiles;
    const composerAnnotationSubmission = options?.inlineAnnotations
      ? {
        inlineAnnotations: options.inlineAnnotations,
        files: options.annotationFiles ?? [],
      }
      : serializeChatResponseAnnotations(responseAnnotationState);
    if (!body && composerAnnotationSubmission.inlineAnnotations.length === 0) { pushToast({ title: "Message cannot be empty", tone: "error" });
      return false; }
    if (regularFiles.length > 0) {
      pushToast({ title: "Queue does not support new files yet", tone: "error" });
      return false;
    }
    if (blockStaleAnnotationSubmission({
      annotations: composerAnnotationSubmission.inlineAnnotations,
      devServer: queryClient.getQueryData<HealthStatus>(queryKeys.health)?.devServer,
      draftPersistence: resolveAnnotationDraftPersistence({
        pendingFileCount: composerAnnotationSubmission.files.length,
      }),
      pushToast,
    })) return false;
    await createQueuedComposerMessage({
      conversation,
      body,
      inlineAnnotations: composerAnnotationSubmission.inlineAnnotations,
      files: composerAnnotationSubmission.files,
      orgId: selectedOrganizationId,
      projectId: activeProjectId === NO_PROJECT_ID ? null : activeProjectId,
      serverActiveGenerationId,
      queueSnapshot: queueQuery.data,
      queryClient,
    });
    if (options?.clearComposerOnSuccess ?? true) {
      setBranchPreview(null); setDraft(""); clearPendingFilesForCurrentScope();
      dispatchResponseAnnotation({ type: "clear" });
      setResponseAnnotationsExpanded(false);
      responseAnnotationEditor.close();
    }
    await queryClient.invalidateQueries({ queryKey: queryKeys.chats.queue(selectedOrganizationId, conversation.id) });
    return true;
  };
  const sendMessage = async (
    options?: { bodyOverride?: string; filesOverride?: File[]; conversationOverride?: ChatConversation;
      inlineAnnotationsOverride?: ChatInlineAnnotationInput[];
      annotationDraftPersistence?: AnnotationDraftPersistence;
      editUserMessageIdOverride?: string | null; editIntent?: "edit" | "retry"; clearPendingFilesOnSuccess?: boolean; onUserMessageAcknowledged?: () => void; queuedMessageId?: string | null; },
  ) => {
    if (!selectedOrganizationId) { pushToast({ title: "Select a organization first", tone: "error" });
      return; } const usesComposerState = options?.bodyOverride === undefined && options?.filesOverride === undefined && options?.inlineAnnotationsOverride === undefined; const body = (options?.bodyOverride ?? readComposerDraft()).trim();
    const editUserMessageId = options?.editUserMessageIdOverride ?? null;
    const editTargetMessage = editUserMessageId
      ? rawMessages.find((message) => message.id === editUserMessageId) ?? null
      : null;
    const persistedEditAnnotations = editTargetMessage
      ? chatInlineAnnotationsFromStructuredPayload(editTargetMessage.structuredPayload)
      : [];
    const regularFilesToUpload = [...(options?.filesOverride ?? pendingFiles)];
    const serializedAnnotations = usesComposerState
      ? serializeChatResponseAnnotations(responseAnnotationState, {
        fileIndexOffset: regularFilesToUpload.length,
      })
      : {
        inlineAnnotations: options?.inlineAnnotationsOverride ?? persistedEditAnnotations,
        files: [] as File[],
      };
    if (!canSubmitChatResponseAnnotations(
      body,
      createChatResponseAnnotationState(serializedAnnotations.inlineAnnotations),
    )) { pushToast({ title: "Message cannot be empty", tone: "error" });
      return; }
    if (blockStaleAnnotationSubmission({
      annotations: serializedAnnotations.inlineAnnotations,
      devServer: queryClient.getQueryData<HealthStatus>(queryKeys.health)?.devServer,
      draftPersistence: resolveAnnotationDraftPersistence({
        explicit: options?.annotationDraftPersistence,
        pendingFileCount: regularFilesToUpload.length + serializedAnnotations.files.length,
      }),
      pushToast,
    })) return;
    const filesToUpload = [...regularFilesToUpload, ...serializedAnnotations.files]; let pendingFilesClearedAfterAck = false; const submittedComposerDraft = usesComposerState ? {
          body,
          files: regularFilesToUpload,
          inlineAnnotations: chatResponseAnnotationsForDraft(responseAnnotationState),
          orgId: draftStorageOrgId, conversationId: draftStorageConversationId, } : null; let conversation = options?.conversationOverride ?? selectedConversation; let activeChatId: string | null = null; let activeStreamScopeKey: string | null = null; let activeStreamKey: string | null = null; let newConversationLockAcquired = false; let chatSendLockAcquired = false; let userMessageAcknowledged = false;
    try {
      if (!conversation && conversationId) { conversation = await chatsApi.get(conversationId); upsertConversation(conversation);
        upsertMessengerThreadSummary(conversation); }
      if (isExternalBoundConversation(conversation)) {
        pushToast({ title: "Fork this Feishu chat to continue in Rudder", tone: "error" });
        return;
      }
      if (!conversation) {
        if (!acquireNewConversationSendLock()) return;
        newConversationLockAcquired = true;
        const selectedDraftAgentId = draftPreferredAgentId === NO_CHAT_AGENT_ID ? null : draftPreferredAgentId;
        if (!selectedDraftAgentId) {
          pushToast({
            title: "No chat agent available",
            body: "Create or activate an agent before sending.", tone: "error",
          });
          releaseNewConversationSendLock();
          newConversationLockAcquired = false;
          return;
        }
        if (!draftPreflightQuery.data?.available) {
          pushToast({
            title: "Chat is not ready",
            body: draftPreflightQuery.data?.error ?? "Check the selected agent configuration and try again.",
            tone: "error",
          });
          releaseNewConversationSendLock();
          newConversationLockAcquired = false;
          return;
        }

        const abortController = new AbortController();
        const startedAt = new Date();
        const streamKey = `new:${startedAt.getTime()}:${Math.random().toString(36).slice(2)}`;
        const acceptedConversation = { current: null as ChatConversation | null };
        activeStreamKey = streamKey;
        await chatsApi.sendFirstMessageStream(selectedOrganizationId, body, {
          preferredAgentId: selectedDraftAgentId,
          modelOverride: draftRuntimeOverrides.modelOverride,
          effortOverride: draftRuntimeOverrides.effortOverride,
          issueCreationMode: "manual_approval",
          planMode: draftPlanMode,
          contextLinks: buildDraftChatContextLinks(
            draftProjectId === NO_PROJECT_ID ? null : draftProjectId,
            draftIssueContextId,
          ),
          signal: abortController.signal,
          files: filesToUpload,
          inlineAnnotations: serializedAnnotations.inlineAnnotations,
          onEvent: async (event) => {
            if (event.type === "ack") {
              if (!event.conversation) {
                throw new Error("First chat acknowledgement did not include the accepted conversation");
              }
              userMessageAcknowledged = true;
              conversation = event.conversation;
              acceptedConversation.current = event.conversation;
              activeChatId = conversation.id;
              const streamScopeKey = chatGenerationScopeKey(selectedOrganizationId, conversation);
              activeStreamScopeKey = streamScopeKey;
              if (!acquireChatSendLock(conversation.id)) {
                throw new Error("The accepted chat is already sending another message");
              }
              chatSendLockAcquired = true;
              streamOwnershipRef.current[conversation.id] = { streamKey, controller: abortController };
              setStreamAbortController(streamScopeKey, abortController);
              setChatSendInFlight(streamScopeKey, true);
              upsertConversation(conversation);
              upsertMessengerThreadSummary(conversation, {
                latestActivityAt: new Date(event.userMessage.createdAt),
                preview: event.userMessage.body,
              });
              upsertMessages(conversation.id, [event.userMessage]);
              rememberChatAgentId(selectedOrganizationId, selectedDraftAgentId);
              rememberChatProjectIdForAgent(
                selectedOrganizationId,
                selectedDraftAgentId,
                draftProjectId === NO_PROJECT_ID ? null : draftProjectId,
              );
              if (usesComposerState) {
                setBranchPreview(null);
                setDraft("");
                if (draftStorageConversationId?.startsWith("local-app-recovery:")) {
                  clearChatDraft(draftStorageOrgId, draftStorageConversationId);
                }
                clearPendingFilesForCurrentScope();
                dispatchResponseAnnotation({ type: "clear" });
                setResponseAnnotationsExpanded(false);
                responseAnnotationEditor.close();
              }
              options?.onUserMessageAcknowledged?.();
              if (options?.clearPendingFilesOnSuccess && !pendingFilesClearedAfterAck) {
                clearPendingFilesForCurrentScope();
                pendingFilesClearedAfterAck = true;
              }
              setStreamDraftForChat(streamScopeKey, {
                chatId: conversation.id,
                streamKey,
                userBody: body,
                userCreatedAt: new Date(event.userMessage.createdAt),
                userMessageId: event.userMessage.id,
                chatTurnId: event.userMessage.chatTurnId ?? null,
                turnVariant: event.userMessage.turnVariant ?? 0,
                editedFromCreatedAt: null,
                body: "",
                generationId: event.generationId ?? null,
                attemptEpoch: event.attemptEpoch ?? null,
                lastCommittedRenderSeq: event.generationSeq ?? 0,
                renderedBodyHash: event.bodyHash ?? EMPTY_CHAT_BODY_SHA256,
                state: "streaming",
                createdAt: startedAt,
                transcript: [],
                replyingAgentId: conversation.chatRuntime.runtimeAgentId ?? conversation.preferredAgentId ?? null,
              });
              navigate(chatConversationPath(conversation.id));
              releaseNewConversationSendLock();
              newConversationLockAcquired = false;
              return;
            }
            if (!conversation) {
              throw new Error("Chat stream emitted output before accepting the first message");
            }
            const streamScopeKey = activeStreamScopeKey ?? chatGenerationScopeKey(selectedOrganizationId, conversation);
            if (event.type === "assistant_delta" || event.type === "assistant_state" || event.type === "transcript_entry") {
              setStreamDraftForChat(streamScopeKey, (current) => applyChatStreamProgressEvent(current, streamKey, event));
              return;
            }
            if (event.type === "final") {
              const pendingStop = readPendingChatStopRecovery(selectedOrganizationId, conversation.id);
              if (stopRecoveryStreamKeysRef.current[conversation.id] === streamKey) {
                if (pendingStop?.frozenDraft?.streamKey === streamKey) {
                  stopRecoveryRetrier.retryNow(pendingStop);
                }
                return;
              }
              keepProcessOpenForMessages(event.messages);
              upsertMessages(conversation.id, event.messages);
              if (!pendingStop) {
                setStreamDraftForChat(streamScopeKey, (current) => current?.streamKey === streamKey ? null : current);
                setChatSendInFlight(streamScopeKey, false);
              }
            }
          },
        });
        const createdConversation = acceptedConversation.current;
        if (!createdConversation) {
          throw new Error("Chat stream ended before accepting the first message");
        }
        if (options?.clearPendingFilesOnSuccess) clearPendingFilesForCurrentScope();
        await refreshChat(createdConversation.id);
        await queryClient.invalidateQueries({ queryKey: queryKeys.chats.queue(selectedOrganizationId, createdConversation.id) });
        setStreamDraftForChat(activeStreamScopeKey ?? chatGenerationScopeKey(selectedOrganizationId, createdConversation), (current) => current?.streamKey === streamKey ? null : current);
        return;
      }
      const chatId = conversation.id; const streamScopeKey = chatGenerationScopeKey(selectedOrganizationId, conversation); const activeDraftForChat = readChatScopedState(streamDrafts, streamScopeKey);
      if (!options?.queuedMessageId && (activeDraftForChat || serverActiveGenerationId)) {
        if (editUserMessageId) {
          const isRetry = options?.editIntent === "retry";
          pushToast({
            title: isRetry ? "Retry unavailable" : "Edit unavailable",
            body: isRetry
              ? "Stop the current response before retrying this message."
              : "Stop the current response before editing this message.",
            tone: "error",
          });
          return;
        }
        await queueComposerMessage(conversation, body, {
          files: regularFilesToUpload,
          inlineAnnotations: serializedAnnotations.inlineAnnotations,
          annotationFiles: serializedAnnotations.files,
          clearComposerOnSuccess: usesComposerState,
        });
        return;
      } if (!acquireChatSendLock(chatId)) return; chatSendLockAcquired = true; activeChatId = chatId; activeStreamScopeKey = streamScopeKey; const selectedAgentId = activeAgentId === NO_CHAT_AGENT_ID ? null : activeAgentId;
      if (!conversation.preferredAgentId && selectedAgentId) { conversation = await chatsApi.update(conversation.id, { preferredAgentId: selectedAgentId }); setDraftPreferredAgentId(selectedAgentId); rememberChatAgentId(selectedOrganizationId, selectedAgentId); upsertConversation(conversation);
        upsertMessengerThreadSummary(conversation); }
      if (newConversationLockAcquired || newConversationSendLockRef.current) { releaseNewConversationSendLock();
        newConversationLockAcquired = false; }
      if (usesComposerState) { setBranchPreview(null); setDraft("");
        clearPendingFilesForCurrentScope(); } setChatSendInFlight(streamScopeKey, true); const abortController = new AbortController(); const startedAt = new Date(); const streamKey = `${chatId}:${startedAt.getTime()}:${Math.random().toString(36).slice(2)}`; activeStreamKey = streamKey; streamOwnershipRef.current[chatId] = { streamKey, controller: abortController }; setStreamAbortController(streamScopeKey, abortController); conversation = upsertOptimisticConversation(conversation, body, startedAt);
      setStreamDraftForChat(streamScopeKey, {
        chatId,
        streamKey,
        userBody: body,
        userCreatedAt: startedAt,
        userMessageId: null,
        chatTurnId: null,
        turnVariant: editTargetMessage ? editTargetMessage.turnVariant + 1 : 0,
        editedFromCreatedAt: editTargetMessage ? new Date(editTargetMessage.createdAt) : null,
        body: "",
        generationId: null,
        attemptEpoch: null,
        lastCommittedRenderSeq: 0,
        renderedBodyHash: EMPTY_CHAT_BODY_SHA256,
        state: "streaming",
        createdAt: startedAt,
        transcript: [], replyingAgentId: conversation.chatRuntime.runtimeAgentId ?? conversation.preferredAgentId ?? null, });
      await chatsApi.sendMessageStream(chatId, body, {
        signal: abortController.signal,
        editUserMessageId,
        files: filesToUpload,
        inlineAnnotations: serializedAnnotations.inlineAnnotations,
        queuedMessageId: options?.queuedMessageId ?? null,
        onEvent: async (event) => {
          if (event.type === "queued") {
            queryClient.setQueryData(
              queryKeys.chats.queue(selectedOrganizationId, chatId),
              (current: Awaited<ReturnType<typeof chatsApi.listQueue>> | undefined) => ({
                activeGenerationId: current?.activeGenerationId ?? queueQuery.data?.activeGenerationId ?? null,
                activeAttemptEpoch: current?.activeAttemptEpoch ?? queueQuery.data?.activeAttemptEpoch ?? null,
                activeControlVersion: current?.activeControlVersion ?? queueQuery.data?.activeControlVersion ?? null,
                activeGenerationStatus: current?.activeGenerationStatus ?? queueQuery.data?.activeGenerationStatus ?? null,
                items: [...(current?.items ?? []), event.item],
              }),
            );
            if (usesComposerState) {
              setDraft("");
              clearPendingFilesForCurrentScope();
              dispatchResponseAnnotation({ type: "clear" });
              setResponseAnnotationsExpanded(false);
              responseAnnotationEditor.close();
            }
            setStreamDraftForChat(streamScopeKey, (current) => current?.streamKey === streamKey ? null : current);
            return;
          }
          if (event.type === "ack") { userMessageAcknowledged = true; upsertMessages(chatId, [event.userMessage]);
            if (usesComposerState) {
              dispatchResponseAnnotation({ type: "clear" });
              setResponseAnnotationsExpanded(false);
              responseAnnotationEditor.close();
            }
            if (body.startsWith(ASK_USER_ANSWER_PREFIX)) {
              setRecentAskUserAnswerMessageId(event.userMessage.id);
              window.setTimeout(() => {
                setRecentAskUserAnswerMessageId((current) => current === event.userMessage.id ? null : current);
              }, 1600);
            }
            options?.onUserMessageAcknowledged?.();
            if (options?.clearPendingFilesOnSuccess && !pendingFilesClearedAfterAck) { clearPendingFilesForCurrentScope(); pendingFilesClearedAfterAck = true; }
            setStreamDraftForChat(
              streamScopeKey,
              (current) => (current?.streamKey === streamKey ? { ...current,
                userCreatedAt: new Date(event.userMessage.createdAt),
                userMessageId: event.userMessage.id,
                chatTurnId: event.userMessage.chatTurnId ?? null,
                turnVariant: event.userMessage.turnVariant ?? 0,
                generationId: event.generationId ?? current.generationId ?? null,
                attemptEpoch: event.attemptEpoch ?? current.attemptEpoch ?? null,
                lastCommittedRenderSeq: event.generationSeq ?? current.lastCommittedRenderSeq ?? 0,
                renderedBodyHash: event.bodyHash ?? current.renderedBodyHash ?? EMPTY_CHAT_BODY_SHA256,
              } : current), );
            return; }
          if (event.type === "error") {
            if (!userMessageAcknowledged && event.messageId) {
              userMessageAcknowledged = true;
              if (usesComposerState) {
                dispatchResponseAnnotation({ type: "clear" });
                setResponseAnnotationsExpanded(false);
                responseAnnotationEditor.close();
              }
              options?.onUserMessageAcknowledged?.();
              if (options?.clearPendingFilesOnSuccess && !pendingFilesClearedAfterAck) {
                clearPendingFilesForCurrentScope();
                pendingFilesClearedAfterAck = true;
              }
              setStreamDraftForChat(
                streamScopeKey,
                (current) => current?.streamKey === streamKey
                  ? { ...current, userMessageId: event.messageId ?? null }
                  : current,
              );
            }
            throw new Error(event.error);
          }
          if (event.type === "assistant_delta" || event.type === "assistant_state" || event.type === "transcript_entry") {
            setStreamDraftForChat(streamScopeKey, (current) => applyChatStreamProgressEvent(current, streamKey, event));
            return; }
          if (event.type === "final") {
            const pendingStop = readPendingChatStopRecovery(selectedOrganizationId, chatId);
            if (stopRecoveryStreamKeysRef.current[chatId] === streamKey) {
              if (pendingStop?.frozenDraft?.streamKey === streamKey) {
                stopRecoveryRetrier.retryNow(pendingStop);
              }
              return;
            }
            keepProcessOpenForMessages(event.messages);
            upsertMessages(chatId, event.messages);
            if (!pendingStop) {
              setStreamDraftForChat(streamScopeKey, (current) => current?.streamKey === streamKey ? null : current);
              setChatSendInFlight(streamScopeKey, false);
            }
          } }, });
      if (options?.clearPendingFilesOnSuccess) { clearPendingFilesForCurrentScope(); }
      await refreshChat(chatId);
      await queryClient.invalidateQueries({ queryKey: queryKeys.chats.queue(selectedOrganizationId, chatId) });
      if (!readPendingChatStopRecovery(selectedOrganizationId, chatId)) {
        setStreamDraftForChat(streamScopeKey, (current) => current?.streamKey === streamKey ? null : current);
      }
    } catch (error) {
      const pendingStop = conversation
        ? readPendingChatStopRecovery(selectedOrganizationId, conversation.id)
        : null;
      const streamScopeKey = activeStreamScopeKey
        ?? (conversation ? chatGenerationScopeKey(selectedOrganizationId, conversation) : null);
      if (conversation && pendingStop) {
        if (!streamScopeKey) return;
        setStreamDraftForChat(streamScopeKey, (current) => {
          if (current && pendingStop.frozenDraft && current.streamKey !== pendingStop.frozenDraft.streamKey) {
            return current;
          }
          return pendingStop.frozenDraft
            ? { ...pendingStop.frozenDraft, state: "stopping" }
            : current;
        });
        return;
      }
      const isAbort = error instanceof DOMException ? error.name === "AbortError" : error instanceof Error && error.name === "AbortError";
      if (options?.queuedMessageId && conversation && !userMessageAcknowledged) {
        await chatsApi.releaseQueuedMessageClaim(conversation.id, options.queuedMessageId).catch(() => null);
      }
      if (conversation && isAbort) {
        if (!streamScopeKey) return;
        setStreamDraftForChat(
          streamScopeKey, (current) => (current?.streamKey === activeStreamKey ? { ...current, state: "stopped" } : current), );
        await refreshChat(conversation.id);
        setStreamDraftForChat(streamScopeKey, (current) => current?.streamKey === activeStreamKey ? null : current);
        return; }
      if (conversation) {
        if (!streamScopeKey) return;
        setStreamDraftForChat(
          streamScopeKey, (current) => (current?.streamKey === activeStreamKey ? null : current), ); }
      if (submittedComposerDraft && !userMessageAcknowledged) { const restoreConversationId = conversation?.id ?? submittedComposerDraft.conversationId; const restoreScopeKey = resolveChatPendingAttachmentScopeKey(
          submittedComposerDraft.orgId, restoreConversationId, ); saveChatComposerDraft(
          submittedComposerDraft.orgId,
          restoreConversationId,
          {
            version: CHAT_COMPOSER_DRAFT_VERSION,
            body: submittedComposerDraft.body,
            inlineAnnotations: submittedComposerDraft.inlineAnnotations,
          },
        ); updateChatPendingAttachmentsForScope(restoreScopeKey, () => submittedComposerDraft.files); refreshPendingFiles((version) => version + 1);
        if (activeDraftScopeRef.current === restoreScopeKey) {
          setDraftState({
            scopeKey: restoreScopeKey,
            value: submittedComposerDraft.body,
          });
          dispatchResponseAnnotation({
            type: "reset",
            annotations: submittedComposerDraft.inlineAnnotations,
            pendingFilesByAnnotationId: responseAnnotationState.pendingFilesByAnnotationId,
          });
        } } else if (editUserMessageId && !userMessageAcknowledged) {
        setInlineEditUserMessageId(editUserMessageId);
        setInlineEditDraft(body);
        requestAnimationFrame(() => { inlineEditEditorRef.current?.focus(); });
      }
      if (error instanceof ApiError) {
        pushToast({
          title: "Failed to send message",
          body: error.message, tone: "error", });
      } else {
        pushToast({
          title: error instanceof Error ? error.message : "Failed to send message", tone: "error", });
      }
      if (conversation) {
        void refreshChat(conversation.id).catch(() => null);
      }
      return;
    } finally {
      if (activeChatId) { const ownedStream = streamOwnershipRef.current[activeChatId];
        if (!ownedStream || ownedStream.streamKey === activeStreamKey) {
          delete streamOwnershipRef.current[activeChatId];
          const streamScopeKey = activeStreamScopeKey ?? activeChatId;
          setStreamAbortController(streamScopeKey, null);
          setChatSendInFlight(streamScopeKey, false);
        }
        const pendingStop = readPendingChatStopRecovery(selectedOrganizationId, activeChatId);
        if (!pendingStop && stopRecoveryStreamKeysRef.current[activeChatId] === activeStreamKey) {
          delete stopRecoveryStreamKeysRef.current[activeChatId];
        }
        if (chatSendLockAcquired) {
          releaseChatSendLock(activeChatId); } }
      if (newConversationLockAcquired) { releaseNewConversationSendLock(); } } }; const conversations = useMemo(() => { const items = conversationsQuery.data ?? [];
    return [...items].sort((a, b) => { if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1; return new Date(b.lastMessageAt ?? b.updatedAt).getTime() - new Date(a.lastMessageAt ?? a.updatedAt).getTime(); }); }, [conversationsQuery.data]);
  const rawMessages = messagesQuery.data ?? [];
  const {
    pendingSelection: pendingResponseAnnotationSelection,
    setPendingSelection: setPendingResponseAnnotationSelection,
  } = usePendingChatResponseAnnotationSelection({
    activeDraftScopeRef,
    chatMainWorkspaceRef,
    draftStorageScopeKey,
    loadedTranscriptsByMessageId,
    rawMessages,
    selectedConversationId: selectedConversation?.id ?? null,
  });
  const addPendingResponseAnnotation = useCallback(async (
    options: { focusComposer?: boolean } = {},
  ) => {
    const pending = pendingResponseAnnotationSelection;
    if (!pending) return null;
    const annotation: ChatInlineAnnotationInput = {
      ...pending.anchor,
      id: globalThis.crypto.randomUUID(),
      comment: null,
      attachmentIds: [],
    };
    const validationError = validateChatResponseAnnotationAdd(
      responseAnnotationState,
      annotation,
    );
    if (validationError) {
      pushToast({
        title: t("chat.annotations.couldNotAdd"),
        body: validationError,
        tone: "error",
      });
      return null;
    }
    const existing = responseAnnotationState.annotations.find((candidate) => (
      candidate.sourceConversationId === annotation.sourceConversationId
      && candidate.sourceMessageId === annotation.sourceMessageId
      && candidate.surface === annotation.surface
      && candidate.sourceHash === annotation.sourceHash
      && candidate.start === annotation.start
      && candidate.end === annotation.end
    ));
    if (!existing) {
      dispatchResponseAnnotation({ type: "add", annotation });
      setResponseAnnotationAnnouncement(t("chat.annotations.added"));
    }
    setPendingResponseAnnotationSelection(null);
    window.getSelection()?.removeAllRanges();
    if (options.focusComposer !== false) {
      requestAnimationFrame(() => composerEditorRef.current?.focus());
    }
    return existing ?? annotation;
  }, [
    pendingResponseAnnotationSelection,
    pushToast,
    responseAnnotationState,
    t,
  ]);
  const handleAddSelectionToChat = useCallback(async () => {
    const pending = pendingResponseAnnotationSelection;
    if (!pending) return;
    const annotation = await addPendingResponseAnnotation({ focusComposer: false });
    if (!annotation) return;
    setResponseAnnotationsExpanded(false);
    const liveSelection = restoreLiveChatAnnotationRange({
      anchor: pending.anchor,
      source: pending.source,
      searchRoot: chatMainWorkspaceRef.current ?? document,
    });
    responseAnnotationEditor.openFromSelection(annotation.id, {
      anchorRect: pending.anchorRect,
      boundaryRect: liveSelection?.sourceRoot
        .closest<HTMLElement>('[data-testid="chat-main-workspace-card"]')
        ?.getBoundingClientRect() ?? null,
    });
  }, [addPendingResponseAnnotation, pendingResponseAnnotationSelection, responseAnnotationEditor]);
  const handleAskSelectionInSideChat = useCallback(async () => {
    const pending = pendingResponseAnnotationSelection;
    if (!pending || !pending.sideChatEligible || !selectedConversation) return;
    const sourceMessage = rawMessages.find((message) => message.id === pending.sourceMessageId);
    if (!sourceMessage) return;
    openSidePanelTargetForContext(
      resolveCurrentSidePanelChatContextKey(),
      sideChatTargetFromMessage(
        selectedConversation,
        sourceMessage,
        {
          ...pending.anchor,
          id: globalThis.crypto.randomUUID(),
          comment: null,
          attachmentIds: [],
        },
      ),
    );
    setPendingResponseAnnotationSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [
    openSidePanelTargetForContext,
    pendingResponseAnnotationSelection,
    rawMessages,
    resolveCurrentSidePanelChatContextKey,
    selectedConversation,
  ]);
  useEffect(() => {
    const handleFileAnnotationRequest = (event: Event) => {
      const detail = (event as CustomEvent<ChatFileAnnotationRequestDetail>).detail;
      if (
        !detail
        || !selectedConversation
        || detail.annotation.sourceConversationId !== selectedConversation.id
      ) return;
      const existingAnnotation = responseAnnotationState.annotations.find((annotation) => (
        chatResponseAnnotationRangeKey(annotation)
        === chatResponseAnnotationRangeKey(detail.annotation)
      ));
      if (existingAnnotation && detail.action === "add_to_chat") {
        setResponseAnnotationsExpanded(false);
        responseAnnotationEditor.openFromSelection(existingAnnotation.id, {
          anchorRect: detail.anchorRect,
          boundaryRect: detail.boundaryRect,
        });
        window.getSelection()?.removeAllRanges();
        return;
      }
      const validationError = validateChatResponseAnnotationAdd(
        responseAnnotationState,
        detail.annotation,
      );
      if (validationError) {
        pushToast({
          title: t("chat.annotations.couldNotAdd"),
          body: validationError,
          tone: "error",
        });
        return;
      }
      if (detail.action === "ask_in_side_chat") {
        const sourceMessage = [...rawMessages].reverse().find((message) => (
          message.role === "assistant"
          && message.kind === "message"
          && message.status === "completed"
          && !message.supersededAt
        ));
        if (!sourceMessage) {
          pushToast({
            title: "Side Chat is not available",
            body: "This chat needs a completed assistant response before a file excerpt can open in Side Chat.",
            tone: "info",
          });
          return;
        }
        openSidePanelTargetForContext(
          resolveCurrentSidePanelChatContextKey(),
          sideChatTargetFromMessage(selectedConversation, sourceMessage, detail.annotation),
        );
        window.getSelection()?.removeAllRanges();
        return;
      }
      dispatchResponseAnnotation({ type: "add", annotation: detail.annotation });
      setResponseAnnotationsExpanded(false);
      responseAnnotationEditor.openFromSelection(detail.annotation.id, {
        anchorRect: detail.anchorRect,
        boundaryRect: detail.boundaryRect,
      });
      setResponseAnnotationAnnouncement(t("chat.annotations.added"));
      window.getSelection()?.removeAllRanges();
    };
    window.addEventListener(CHAT_FILE_ANNOTATION_REQUEST_EVENT, handleFileAnnotationRequest);
    return () => {
      window.removeEventListener(CHAT_FILE_ANNOTATION_REQUEST_EVENT, handleFileAnnotationRequest);
    };
  }, [
    openSidePanelTargetForContext,
    pushToast,
    rawMessages,
    resolveCurrentSidePanelChatContextKey,
    responseAnnotationEditor,
    responseAnnotationState,
    selectedConversation,
    t,
  ]);
  const handleSelectSentResponseAnnotation = useCallback((
    annotation: ChatInlineAnnotation,
    ordinal: number,
  ) => {
    if (annotation.surface === "agent_run_transcript") {
      navigate(`/agents/${encodeURIComponent(annotation.sourceAgentId)}/runs/${encodeURIComponent(annotation.sourceRunId)}`);
      return;
    }
    if (annotation.surface === "workspace_file" || annotation.surface === "local_file") {
      setUnlocatableResponseAnnotationId(null);
      void (async () => {
        try {
          let resolvedPath = annotation.sourceFilePath;
          let source: string | null = null;
          if (annotation.surface === "workspace_file") {
            if (!selectedOrganizationId) throw new Error("No organization selected");
            if (annotation.sourceLibraryEntryId) {
              const entry = await organizationsApi.getLibraryEntry(
                selectedOrganizationId,
                annotation.sourceLibraryEntryId,
              );
              if (entry.status !== "active" || !entry.currentPath) {
                throw new Error("Library source is unavailable");
              }
              resolvedPath = entry.currentPath;
            }
            source = (
              await organizationsApi.readWorkspaceFile(
                selectedOrganizationId,
                resolvedPath,
              )
            ).content;
          } else {
            const desktopShell = readDesktopShell();
            if (!desktopShell) throw new Error("Desktop file access is unavailable");
            source = (await desktopShell.previewLocalFile(resolvedPath)).content;
          }
          if (
            source === null
            || await hashChatAnnotationSource(source) !== annotation.sourceHash
            || source.slice(
              Math.max(0, annotation.start - annotation.prefix.length),
              annotation.start,
            ) !== annotation.prefix
            || source.slice(
              annotation.end,
              annotation.end + annotation.suffix.length,
            ) !== annotation.suffix
          ) {
            throw new Error("Annotation source changed");
          }
          const label = resolvedPath.split(/[\\/]/u).filter(Boolean).at(-1)
            ?? resolvedPath;
          requestChatFileAnnotationLocation({
            surface: annotation.surface,
            sourceFilePath: resolvedPath,
            sourceHash: annotation.sourceHash,
            sourceRenderMode: annotation.sourceRenderMode,
            start: annotation.start,
            end: annotation.end,
          });
          openSidePanelTargetForContext(
            resolveCurrentSidePanelChatContextKey(),
            annotation.surface === "workspace_file"
              ? {
                  kind: annotation.sourceLibraryEntryId
                    ? "library_entry"
                    : "library_file",
                  ...(annotation.sourceLibraryEntryId
                    ? {
                        entryId: annotation.sourceLibraryEntryId,
                        path: resolvedPath,
                      }
                    : { filePath: resolvedPath }),
                  label,
                } as SidePanelTarget
              : {
                  kind: "local_file",
                  filePath: resolvedPath,
                  label,
                },
          );
        } catch {
          setUnlocatableResponseAnnotationId(annotation.id);
        }
      })();
      return;
    }
    if (
      selectedConversation
      && annotation.sourceConversationId !== selectedConversation.id
    ) {
      navigate(
        {
          pathname: chatConversationPath(annotation.sourceConversationId),
          search: `?messageId=${encodeURIComponent(annotation.sourceMessageId)}`,
        },
        {
          state: createChatResponseAnnotationNavigationState(
            annotation,
            ordinal,
            location.state,
          ),
        },
      );
      return;
    }
    const sourceMessage = rawMessages.find((message) => message.id === annotation.sourceMessageId);
    setHistoricalResponseAnnotations((current) => (
      current.some((candidate) => candidate.id === annotation.id)
        ? current
        : [...current, { ...annotation, ordinal }]
    ));
    setUnlocatableResponseAnnotationId(null);
    if (!sourceMessage || sourceMessage.supersededAt) {
      setUnlocatableResponseAnnotationId(annotation.id);
      return;
    }
    const isMatchingProcessEntry = (entry: TranscriptEntry) => {
      const candidate = entry as typeof entry & {
        generationId?: string;
        generationSeqStart?: number;
        generationSeqEnd?: number;
      };
      return (candidate.kind === "assistant" || candidate.kind === "thinking")
        && candidate.kind === annotation.transcriptKind
        && candidate.generationId === annotation.generationId
        && candidate.generationSeqStart === annotation.generationSeqStart
        && candidate.generationSeqEnd === annotation.generationSeqEnd;
    };
    void (async () => {
      if (annotation.surface === "process_transcript") {
        setProcessOpenForMessage(sourceMessage.id, true);
        let transcript = loadedTranscriptsByMessageId[sourceMessage.id]
          ?? sourceMessage.transcript
          ?? [];
        if (
          !transcript.some(isMatchingProcessEntry)
          && sourceMessage.transcriptSummary?.entryCount
        ) {
          transcript = await loadMessageTranscript(
            sourceMessage.conversationId,
            sourceMessage.id,
          ) ?? [];
        }
        if (!transcript.some(isMatchingProcessEntry)) {
          setUnlocatableResponseAnnotationId(annotation.id);
          return;
        }
      }
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const candidates = Array.from(document.querySelectorAll<HTMLElement>(
          `[data-annotation-surface="${annotation.surface}"]`,
        ));
        const sourceRoot = candidates.find((candidate) => (
          candidate.dataset.messageId === annotation.sourceMessageId
          && (
            annotation.surface === "assistant_body"
            || (
              candidate.dataset.transcriptKind === annotation.transcriptKind
              && candidate.dataset.generationId === annotation.generationId
              && Number(candidate.dataset.generationSeqStart) === annotation.generationSeqStart
              && Number(candidate.dataset.generationSeqEnd) === annotation.generationSeqEnd
            )
          )
        )) ?? null;
        if (!sourceRoot) continue;
        revealChatAnnotationSourceElement(sourceRoot);
        return;
      }
      setUnlocatableResponseAnnotationId(annotation.id);
    })();
  }, [
    loadMessageTranscript,
    loadedTranscriptsByMessageId,
    chatConversationPath,
    location.state,
    navigate,
    openSidePanelTargetForContext,
    rawMessages,
    resolveCurrentSidePanelChatContextKey,
    selectedConversation,
    selectedOrganizationId,
    setProcessOpenForMessage,
  ]);
  const pendingResponseAnnotationSource = useMemo(
    () => readChatResponseAnnotationNavigationState(location.state),
    [location.state],
  );
  useEffect(() => {
    if (
      !pendingResponseAnnotationSource
      || Boolean(
        selectedConversation
        && conversationId
        && messagesQuery.isPending
        && messagesQuery.data === undefined
      )
      || selectedConversation?.id !== pendingResponseAnnotationSource.annotation.sourceConversationId
    ) return;
    handleSelectSentResponseAnnotation(
      pendingResponseAnnotationSource.annotation,
      pendingResponseAnnotationSource.ordinal,
    );
    navigate(
      {
        pathname: location.pathname,
        search: location.search,
      },
      {
        replace: true,
        state: clearChatResponseAnnotationNavigationState(location.state),
      },
    );
  }, [
    handleSelectSentResponseAnnotation,
    conversationId,
    location.pathname,
    location.search,
    location.state,
    messagesQuery.data,
    messagesQuery.isPending,
    navigate,
    pendingResponseAnnotationSource,
    selectedConversation?.id,
  ]);
  const handleSentResponseAnnotationsExpanded = useCallback((
    annotations: ChatInlineAnnotation[],
    expanded: boolean,
  ) => {
    setHistoricalResponseAnnotations((current) => {
      if (expanded) {
        return annotations.map((annotation, index) => ({
          ...annotation,
          ordinal: index + 1,
        }));
      }
      const closingIds = new Set(annotations.map((annotation) => annotation.id));
      const currentBelongsToClosingCard = current.length > 0
        && current.every((annotation) => closingIds.has(annotation.id));
      return currentBelongsToClosingCard ? [] : current;
    });
    if (!expanded) setUnlocatableResponseAnnotationId((current) => {
      return annotations.some((annotation) => annotation.id === current) ? null : current;
    });
  }, []);
  const latestIncomingMessageId = useMemo(() => { const messages = [...rawMessages] .filter(isUserVisibleIncomingChatMessage) .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()); return messages[0]?.id ?? null; }, [rawMessages]); const displayedMessages = useMemo(
    () => computeDisplayedChatMessages(rawMessages, branchPreview), [rawMessages, branchPreview], ); const showMessagesLoading = transcriptLoadState.showMessagesLoading; const activeStream = readChatScopedState(streamDrafts, selectedConversationStreamScopeKey ?? undefined); const activeSendInFlight = readChatScopedFlag(sendInFlightByChatId, selectedConversationStreamScopeKey ?? undefined); const activeQueueItems = queueQuery.data?.items ?? []; const activeQueueProjectionKey = activeQueueItems.map((item) => `${item.id}:${item.status}:${item.version}`).join("|"); const visibleQueueItems = activeQueueItems.filter((item) => projectChatQueueDelivery(item).state !== "hidden"); const agentSelectionLocked = isChatAgentSelectionLocked({ hasConversation: Boolean(selectedConversation), preferredAgentId: selectedConversation?.preferredAgentId, hasActiveStream: Boolean(activeStream), hasActiveSendInFlight: activeSendInFlight, }); const projectSelectionLocked = isChatProjectSelectionLocked({
    hasConversation: Boolean(selectedConversation),
    hasLastMessageAt: Boolean(selectedConversation?.lastMessageAt),
    hasMessages: rawMessages.length > 0,
    hasActiveStream: Boolean(activeStream), hasActiveSendInFlight: activeSendInFlight, }); const activeEditCutoffMs = activeStream?.editedFromCreatedAt ? activeStream.editedFromCreatedAt.getTime() : null; const activeStreamFilteredMessages = activeStream ? displayedMessages.filter((message) => shouldShowMessageDuringActiveEdit(message, activeStream)) : displayedMessages; const activeStreamPreviewHidden = Boolean(activeStream?.chatTurnId && branchPreview?.chatTurnId === activeStream.chatTurnId && branchPreview.turnVariant !== activeStream.turnVariant); const visibleMessages = activeStream && !activeStreamPreviewHidden ? activeStreamFilteredMessages.filter((message) => shouldShowMessageDuringActiveStream(message, activeStream)) : activeStreamFilteredMessages; const scrollMapUserMessageCount = useMemo(
    () => countScrollMapUserMessages(visibleMessages), [visibleMessages],
  ); const showChatScrollMap = scrollMapUserMessageCount > CHAT_SCROLL_MAP_USER_MESSAGE_THRESHOLD; const jumpToChatMessage = useCallback((messageId: string) => {
    const scrollElement = chatMessagesScrollElementRef.current;
    if (!scrollElement) return;
    const target = findChatMessageElement(scrollElement, messageId);
    if (target) {
      revealChatMessageElement(target);
      return;
    }
    if (!conversationId) return;
    const nextSearch = new URLSearchParams(searchParams);
    nextSearch.set("targetMessageId", messageId);
    navigate({
      pathname: chatConversationPath(conversationId),
      search: `?${nextSearch.toString()}`,
    }, { replace: true });
  }, [chatConversationPath, conversationId, navigate, searchParams]); const openWorkManifestItem = useCallback((item: ChatWorkManifestItem) => {
    const metadata = item.metadata ?? {};
    if (item.targetType === "issue" || item.targetType === "issue_comment") {
      const issueId = typeof metadata.issueId === "string" ? metadata.issueId : null;
      if (!issueId) return;
      openSidePanelTargetForContext(resolveCurrentSidePanelChatContextKey(), {
        kind: "issue",
        issueId,
        ref: typeof metadata.ref === "string" ? metadata.ref : null,
        commentId: typeof metadata.commentId === "string" ? metadata.commentId : null,
        label: item.title,
      });
      return;
    }
    if (item.targetType === "automation") {
      const automationId = typeof metadata.automationId === "string" ? metadata.automationId : null;
      if (!automationId) return;
      openSidePanelTargetForContext(resolveCurrentSidePanelChatContextKey(), {
        kind: "automation",
        automationId,
        label: item.title,
      });
      return;
    }
    if (item.targetType === "chat_conversation") {
      const targetConversationId = typeof metadata.conversationId === "string" ? metadata.conversationId : null;
      if (!targetConversationId) return;
      const messageId = typeof metadata.messageId === "string" ? metadata.messageId : null;
      const pathname = chatConversationPath(targetConversationId);
      navigate(messageId ? {
        pathname,
        search: `?messageId=${encodeURIComponent(messageId)}`,
      } : pathname);
      return;
    }
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
    const contentType = typeof metadata.contentType === "string" ? metadata.contentType : null;
    if (item.targetType === "attachment" && isPreviewableImage(contentType, item.title)) {
      openImagePreview({
        alt: item.title,
        name: item.title,
        src: href,
        testId: "chat-work-manifest-image-preview-dialog",
        titleFallback: "Attachment preview",
      });
      return;
    }
    const opened = window.open(href, "_blank", "noopener,noreferrer");
    if (opened) opened.opener = null;
  }, [chatConversationPath, navigate, openImagePreview, openSidePanelTargetForContext, resolveCurrentSidePanelChatContextKey]);
  const openWorkManifestSubagents = useCallback(() => {
    if (!conversationId) return;
    openSidePanelTargetForContext(resolveCurrentSidePanelChatContextKey(), {
      kind: "subagents",
      conversationId,
      label: "Subagents",
    });
  }, [conversationId, openSidePanelTargetForContext, resolveCurrentSidePanelChatContextKey]);
  useEffect(() => {
    if (!selectedOrganizationId || !conversationId || !activeStream) return;
    void queryClient.invalidateQueries({
      queryKey: queryKeys.chats.workManifest(selectedOrganizationId, conversationId),
    });
  }, [activeStream?.transcript.length, conversationId, queryClient, selectedOrganizationId]);
  const latestUnansweredAskUserMessage = useMemo(
    () => findLatestUnansweredAskUserMessage(visibleMessages), [visibleMessages], ); const activeStreamUserTurnVisible = Boolean(activeStream && !activeStreamPreviewHidden); const activeStreamAskUserRequest = activeStreamUserTurnVisible && latestUnansweredAskUserMessage ? askUserRequestFromMessage(latestUnansweredAskUserMessage) : null; const pendingAskUserMessage = activeStreamUserTurnVisible ? null : latestUnansweredAskUserMessage; const pendingAskUserRequest = pendingAskUserMessage ? askUserRequestFromMessage(pendingAskUserMessage) : null; const lastMarkedReadKeyRef = useRef<string | null>(null); const optimisticReadBadgeMarkerRef = useRef<string | null>(null);
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
  const nativeSteerAnchors = useMemo(
    () => visibleMessages
      .map(nativeSteerTranscriptAnchor)
      .filter((anchor): anchor is NonNullable<ReturnType<typeof nativeSteerTranscriptAnchor>> => Boolean(anchor)),
    [visibleMessages],
  );
  const transcriptOwnerGenerationIds = useMemo(() => {
    const generationIds = new Set<string>();
    if (showActiveStreamDraft && activeStream?.generationId) {
      generationIds.add(activeStream.generationId);
    }
    for (const message of visibleMessages) {
      if (message.role === "assistant" && message.generationId) {
        generationIds.add(message.generationId);
      }
    }
    return generationIds;
  }, [activeStream?.generationId, showActiveStreamDraft, visibleMessages]);
  const nativeSteerMessagesByGenerationId = useMemo(() => {
    const messagesByGenerationId = new Map<string, ChatMessage[]>();
    for (const anchor of nativeSteerAnchors) {
      if (!transcriptOwnerGenerationIds.has(anchor.targetGenerationId)) continue;
      const messages = messagesByGenerationId.get(anchor.targetGenerationId) ?? [];
      messages.push(anchor.message);
      messagesByGenerationId.set(anchor.targetGenerationId, messages);
    }
    return messagesByGenerationId;
  }, [nativeSteerAnchors, transcriptOwnerGenerationIds]);
  const embeddedNativeSteerMessageIds = useMemo(
    () => new Set(
      [...nativeSteerMessagesByGenerationId.values()]
        .flatMap((messages) => messages.map((message) => message.id)),
    ),
    [nativeSteerMessagesByGenerationId],
  );
  const timelineMessages = useMemo(
    () => visibleMessages.filter((message) => !embeddedNativeSteerMessageIds.has(message.id)),
    [embeddedNativeSteerMessageIds, visibleMessages],
  );
  const chatTimelineRows = useMemo(() => {
    return buildChatTimelineRows(timelineMessages, activeStream, showActiveStreamDraft)
      .map((row) => row.kind === "message"
        ? {
            ...row,
            messageIndex: visibleMessages.findIndex((candidate) => candidate.id === row.message.id),
          }
        : row);
  }, [activeStream, showActiveStreamDraft, timelineMessages, visibleMessages]);
  const getChatTimelineItemKey = useCallback(
    (timelineRow: (typeof chatTimelineRows)[number]) => timelineRow.kind === "active_stream"
      ? `active-stream:${activeStream?.streamKey ?? "pending"}`
      : timelineRow.message.id,
    [activeStream?.streamKey],
  );
  const estimateChatTimelineItemSize = useCallback(() => 180, []);
  useEffect(() => {
    for (const message of visibleMessages) {
      if (message.role !== "assistant" || !message.generationId) continue;
      if ((nativeSteerMessagesByGenerationId.get(message.generationId)?.length ?? 0) === 0) continue;
      if ((loadedTranscriptsByMessageId[message.id] ?? message.transcript ?? []).length > 0) continue;
      if (!message.transcriptSummary?.entryCount || loadingTranscriptMessageIds[message.id]) continue;
      void loadMessageTranscript(message.conversationId, message.id);
    }
  }, [
    loadMessageTranscript,
    loadedTranscriptsByMessageId,
    loadingTranscriptMessageIds,
    nativeSteerMessagesByGenerationId,
    visibleMessages,
  ]);
  const loadError = conversationsQuery.error ?? conversationQuery.error ?? messagesQuery.error ?? agentsError ?? organizationSkillsError ?? activeAgentSkillsError ?? projectsError ?? issuesError;
  const loadErrorMessage = loadError instanceof Error ? loadError.message : loadError ? "Failed to load chat data." : null; const workManifestError = workManifestQuery.error instanceof Error ? workManifestQuery.error.message : workManifestQuery.error ? "Failed to load files and links." : null; const startActiveConversationRename = () => { if (!selectedConversation) return; setRenamingConversationId(selectedConversation.id); setRenameDraft(selectedConversation.title); }; const submitActiveConversationRename = () => { if (!selectedConversation || renamingConversationId !== selectedConversation.id) return; const trimmed = renameDraft.trim(); setRenamingConversationId(null); if (!trimmed || trimmed === selectedConversation.title) return; renameConversationMutation.mutate({ chatId: selectedConversation.id, title: trimmed }); }; const copyActiveConversationLink = async () => { if (!selectedConversation) return;
    try {
      await navigator.clipboard.writeText(chatReferenceMarkdown(selectedConversation));
      pushToast({ title: "Copied chat link", tone: "success" });
    } catch {
      pushToast({ title: "Could not copy chat link", tone: "error" });
    }
  }; const createGroupForActiveConversation = () => { if (!selectedConversation || !selectedConversationThreadKey) return; createCustomGroupForChatMutation.mutate({ conversation: selectedConversation, threadKey: selectedConversationThreadKey }); }; const moveActiveConversationToGroup = (groupId: string) => { if (!selectedConversationThreadKey) return; assignCustomGroupEntryMutation.mutate({ groupId, threadKey: selectedConversationThreadKey }); }; const removeActiveConversationFromGroup = () => { if (!selectedConversationThreadKey) return; removeCustomGroupEntryMutation.mutate(selectedConversationThreadKey); }; const controlsDisabled = activeSendInFlight || newConversationSendInFlight; const activeSelectedAgentId = activeAgentId === NO_CHAT_AGENT_ID ? null : activeAgentId; const canPersistSelectedAgentForConversation = Boolean( selectedConversation && !selectedConversation.preferredAgentId && activeSelectedAgentId, );
  const draftPreflightError = draftPreflightQuery.error instanceof Error
    ? draftPreflightQuery.error.message
    : draftPreflightQuery.error
      ? "Could not validate the selected chat configuration."
      : null;
  const draftPreflightUnavailable = !activeSelectedAgentId
    || draftPreflightQuery.isPending
    || Boolean(draftPreflightError)
    || !draftPreflightQuery.data?.available;
  const composerUnavailable = selectedConversation
    ? !selectedConversation.chatRuntime.available && !canPersistSelectedAgentForConversation
    : draftPreflightUnavailable;
  const composerUnavailableMessage = !activeSelectedAgentId
    ? "Create or activate an agent before sending messages."
    : selectedConversation
      ? selectedConversation.chatRuntime.error ?? "Selected chat agent is unavailable."
      : draftPreflightQuery.isPending
        ? null
      : draftPreflightError
        ?? draftPreflightQuery.data?.error
        ?? "Selected chat configuration is unavailable."; const hasPendingLightweightProposal = rawMessages.some(
    (message) => !message.supersededAt && message.kind === "operation_proposal" && !message.approval && operationProposalStatusFromMessage(message) === "pending", ); const hasActionableApprovals = rawMessages .filter((m) => !m.supersededAt) .some((message) => approvalNeedsAction(message.approval));
  const runtimePillLabel = chatRuntimeSelectionLabel({
    agent: activeSkillAgent,
    runtime: selectedConversation?.chatRuntime ?? draftPreflightQuery.data ?? null,
    overrides: activeRuntimeOverrides,
    adapterModels: adapterModelsQuery.data,
  }); const agentPillLabel = activeAgentId === NO_CHAT_AGENT_ID ? (agents ? NO_CHAT_AGENT_LABEL : "Loading agents") : activeSkillAgent ? formatChatAgentLabel(activeSkillAgent) : "Unknown agent"; const activeProjectContextLink = selectedConversation?.contextLinks.find((link) => link.entityType === "project") ?? null; const activeProject = activeProjectId === NO_PROJECT_ID ? null : visibleProjects.find((project) => project.id === activeProjectId) ?? null; const hasSelectedProject = activeProjectId !== NO_PROJECT_ID; const projectPillLabel = activeProject ? projectDisplayName(activeProject) : activeProjectId === NO_PROJECT_ID ? "No project" : activeProjectContextLink?.entity?.label ?? "Unknown project"; const showProjectSelector = !selectedConversation || activeProjectId !== NO_PROJECT_ID || !projectSelectionLocked; const allRecentProjectConversations = useMemo(() => {
    if (!activeProject) return [];
    return [...(projectConversationsQuery.data ?? [])]
      .filter((conversation) => projectContextId(conversation) === activeProject.id)
      .sort((a, b) => new Date(b.lastMessageAt ?? b.updatedAt).getTime() - new Date(a.lastMessageAt ?? a.updatedAt).getTime());
  }, [activeProject, projectConversationsQuery.data]); const recentProjectConversations = useMemo(
    () => allRecentProjectConversations.slice(0, recentProjectConversationLimit),
    [allRecentProjectConversations, recentProjectConversationLimit],
  ); const hasMoreRecentProjectConversations = recentProjectConversationLimit < allRecentProjectConversations.length; const loadMoreRecentProjectConversations = useCallback(() => {
    setRecentProjectConversationLimit((current) => Math.min(allRecentProjectConversations.length, current + RECENT_PROJECT_CONVERSATION_LOAD_INCREMENT));
  }, [allRecentProjectConversations.length]); useEffect(() => {
    setRecentProjectConversationLimit(RECENT_PROJECT_CONVERSATION_INITIAL_LIMIT);
  }, [activeProject?.id]); const pluginMentions = usePluginMentionCatalog(selectedOrganizationId); const availableChatSkills = useMemo(
    () => buildChatSkillOptions({
      agent: activeSkillAgent,
      orgUrlKey: selectedOrganization?.urlKey ?? "organization",
      organizationSkills,
      skillSnapshot: activeAgentSkillSnapshot,
      pluginManagedSkillIds: pluginMentions.managedSkillIds,
    }), [activeAgentSkillSnapshot, activeSkillAgent, organizationSkills, pluginMentions.managedSkillIds, selectedOrganization?.urlKey], ); const referenceChatSkills = useMemo(
    () => buildChatSkillReferenceOptions({
      agent: activeSkillAgent,
      orgUrlKey: selectedOrganization?.urlKey ?? "organization",
      organizationSkills,
      skillSnapshot: activeAgentSkillSnapshot,
      pluginManagedSkillIds: pluginMentions.managedSkillIds,
    }),
    [activeAgentSkillSnapshot, activeSkillAgent, organizationSkills, pluginMentions.managedSkillIds, selectedOrganization?.urlKey],
  ); const chatSkillReferences = useMemo<MarkdownSkillReferencePreview[]>(
    () => referenceChatSkills.map((skill) => ({
      href: skill.skillMarkdownTarget,
      label: skill.skillRefLabel,
      displayName: skill.skillDisplayName,
      description: skill.skillDescription,
      categoryLabel: skill.skillCategoryLabel,
      locationLabel: skill.skillLocationLabel,
      detailsHref: skill.skillDetailsHref,
      openHref: skill.skillOpenHref,
    })), [referenceChatSkills], ); const chatSkillDetailsHrefByTarget = useMemo(
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
      pluginMentionOptions: pluginMentions.options,
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
      pluginMentions.options,
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
      }); } }, [pushToast, readComposerDraft]); const applyPreferredAgent = (value: string) => { if (agentSelectionLocked || runtimeSelectionPending || !isSelectableChatAgentId(value, agents) || value === activeAgentId) return; setDraftRuntimeOverrides({ modelOverride: null, effortOverride: null }); setDraftPreferredAgentId(value); if (selectedOrganizationId) rememberChatAgentId(selectedOrganizationId, value); if (selectedConversation) updateConversationMutation.mutate({ chatId: selectedConversation.id, data: { preferredAgentId: value, modelOverride: null, effortOverride: null, }, }); }; const applyProjectContext = (value: string) => {
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
    const persistedAnnotations = chatInlineAnnotationsFromStructuredPayload(message.structuredPayload);
    if (!body && persistedAnnotations.length === 0) { pushToast({ title: "Message cannot be empty", tone: "error" });
      return; }
    void sendMessage({
      bodyOverride: body,
      filesOverride: [],
      inlineAnnotationsOverride: persistedAnnotations,
      annotationDraftPersistence: "memory",
      conversationOverride: selectedConversation,
      editUserMessageIdOverride: message.id,
      onUserMessageAcknowledged: () => {
        setInlineEditUserMessageId(null);
        setInlineEditDraft("");
        setBranchPreview(null);
      },
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
  }; const selectedConversationHasActiveReply = Boolean(selectedConversation && (activeStream || activeSendInFlight || serverActiveGenerationId)); const retryFailedMessage = useCallback(
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
        editIntent: "retry",
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
    activeProjectName: emptyStateProjectName, userNickname, t, }); const emptyStateHeadingKey = emptyStateProjectName ? `project:${activeProject?.id}:${emptyStateProjectName}` : "no-project"; const composerPlaceholder = activePlanMode ? t("chat.composer.planModePlaceholder") : draftIssueContext ? t("chat.composer.issuePlaceholder", { issue: draftIssueContextLabel(draftIssueContext) }) : t("chat.composer.placeholder"); const emptyStatePromptOptionsId = "chat-empty-state-prompt-options"; const emptyStatePromptSuggestions = useMemo(() => chatPromptSuggestionsForDraft(draft), [draft]); const emptyStatePromptQuery = chatPromptQueryKey(draft); const displayedEmptyStatePromptSuggestions = chatPromptSuggestionsForDisplay(emptyStatePromptSuggestions, retainedEmptyStatePromptSuggestions, emptyStatePromptQuery, dismissedEmptyStatePromptQuery); const showEmptyStatePromptSuggestions = !selectedConversation && emptyStatePromptSuggestions.length > 0 && dismissedEmptyStatePromptQuery !== emptyStatePromptQuery; const boundedEmptyStateActiveSuggestionIndex = emptyStatePromptSuggestions.length > 0 ? Math.min(emptyStateActiveSuggestionIndex, emptyStatePromptSuggestions.length - 1) : 0; const activeEmptyStatePromptOptionId = showEmptyStatePromptSuggestions ? `${emptyStatePromptOptionsId}-${emptyStatePromptSuggestions[boundedEmptyStateActiveSuggestionIndex]?.id ?? ""}` : null;
  useEffect(() => {
    if (emptyStatePromptSuggestions.length > 0) {
      setRetainedEmptyStatePromptSuggestions(emptyStatePromptSuggestions);
    }
  }, [emptyStatePromptSuggestions]);
  const selectedEmptyStatePromptGroup = useMemo(() => chatPromptGroupForExactTrigger(draft), [draft]);
  const showEmptyStateSupplementalContent = emptyStatePromptQuery.length === 0
    && pendingFiles.length === 0
    && responseAnnotationState.annotations.length === 0;
  const emptyStatePromptFlowState = showEmptyStateSupplementalContent ? "starters" : showEmptyStatePromptSuggestions ? "suggestions" : "hidden";
  const hasRecentProjectConversations = allRecentProjectConversations.length > 0;
  const canQueueDraft = canQueueComposerDraft({
    activeReply: selectedConversationHasActiveReply,
    body: draft,
    annotationCount: responseAnnotationState.annotations.length,
    pendingRegularFileCount: pendingFiles.length,
    newConversationSendInFlight,
  });
  const activeStreamStopState = activeStream?.state === "stopping" || activeStream?.state === "stopped";
  const selectedStopRequestPending = Boolean(selectedConversation && stoppingChatIds.has(selectedConversation.id));
  const sendButtonMode: SendButtonMode = newConversationSendInFlight || (activeSendInFlight && !activeStream) ? "sending" : selectedStopRequestPending || activeStreamStopState ? "stopping" : canQueueDraft ? "queue" : activeSendInFlight ? "stop" : "send";
  const selectedConversationExternalBound = isExternalBoundConversation(selectedConversation);
  const sideChatSlashAnchor = selectedConversation ? latestSideChatAnchor(visibleMessages) : null;
  const showSideChatSlashCommand = Boolean(
    selectedConversation
    && !selectedConversationExternalBound
    && /^\/(?:s(?:i(?:d(?:e)?)?)?)?$/.test(draft.trim().toLowerCase()),
  );
  const activateSideChatSlashCommand = useCallback(() => {
    if (!selectedConversation || !sideChatSlashAnchor) return;
    openSidePanelTargetForContext(
      resolveCurrentSidePanelChatContextKey(),
      sideChatTargetFromMessage(selectedConversation, sideChatSlashAnchor),
    );
    setDraft("");
  }, [
    openSidePanelTargetForContext,
    resolveCurrentSidePanelChatContextKey,
    selectedConversation,
    setDraft,
    sideChatSlashAnchor,
  ]);
  useEffect(() => {
    if (!showSideChatSlashCommand) {
      setSideChatSlashMenuPosition(null);
      return;
    }
    const updatePosition = () => {
      const anchor = composerSurfaceRef.current;
      if (!anchor) return;
      setSideChatSlashMenuPosition(composerMenuPositionForAnchor(anchor));
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [showSideChatSlashCommand]);
  const renderSideChatSlashCommandMenu = () => {
    if (!showSideChatSlashCommand || !sideChatSlashMenuPosition || typeof document === "undefined") return null;
    return createPortal(
      <div
        data-testid="chat-slash-command-menu"
        role="menu"
        aria-label="Chat commands"
        className="chat-composer-context-menu motion-chat-composer-menu-pop surface-overlay fixed z-50 overflow-hidden rounded-[var(--radius-lg)] border p-1.5 text-foreground"
        style={sideChatSlashMenuPosition}
      >
        <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">Commands</div>
        <button
          type="button"
          role="menuitem"
          className="chat-composer-menu-row"
          disabled={!sideChatSlashAnchor}
          data-chat-composer-menu-item
          data-testid="chat-slash-side-chat"
          onClick={activateSideChatSlashCommand}
        >
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[color:var(--surface-active)] text-[color:var(--accent-base)]">
            <CirclePlus className="h-4 w-4" />
          </span>
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="shrink-0 font-medium text-foreground">Side Chat</span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {sideChatSlashAnchor ? "Ask from the latest assistant answer" : "Wait for an assistant answer first"}
            </span>
          </span>
          <kbd className="shrink-0 rounded-[calc(var(--radius-sm)-2px)] border border-[color:var(--border-soft)] bg-[color:var(--surface-inset)] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            Enter
          </kbd>
        </button>
      </div>,
      document.body,
    );
  };
  const sendButtonDisabled = chatSendButtonDisabled({
    selectedConversationExternalBound,
    modelSelectionPending: runtimeSelectionPending,
    composerUnavailable,
    sendButtonMode,
    hasDraft: canSubmitChatResponseAnnotations(draft, responseAnnotationState),
  });
  const canSteerQueuedMessages = Boolean(
    (
      serverActiveGenerationId
      && queueQuery.data?.activeAttemptEpoch !== null
      && queueQuery.data?.activeAttemptEpoch !== undefined
      && queueQuery.data?.activeControlVersion !== null
      && queueQuery.data?.activeControlVersion !== undefined
    )
    || activeQueueItems.some((item) => item.status === "queued" || item.status === "failed_actionable"),
  );
  const canStopSelectedConversationReply = Boolean(selectedConversation && !selectedStopRequestPending && !activeStreamStopState && (activeSendInFlight || serverActiveGenerationId));
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
  }, [boundedEmptyStateActiveSuggestionIndex, emptyStatePromptQuery, emptyStatePromptSuggestions, selectEmptyStatePromptSuggestion, showEmptyStatePromptSuggestions]);
  const handleComposerSuggestionKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      showSideChatSlashCommand
      && sideChatSlashAnchor
      && (event.key === "Enter" || event.key === "Tab")
      && !event.shiftKey
      && !event.altKey
      && !event.ctrlKey
      && !event.metaKey
      && !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      event.stopPropagation();
      activateSideChatSlashCommand();
      return;
    }
    handleEmptyStatePromptKeyDown(event);
  }, [activateSideChatSlashCommand, handleEmptyStatePromptKeyDown, showSideChatSlashCommand, sideChatSlashAnchor]);
  useEffect(() => {
    if (!showEmptyStateSupplementalContent) {
      setRecentProjectConversationLimit(RECENT_PROJECT_CONVERSATION_INITIAL_LIMIT);
    }
  }, [showEmptyStateSupplementalContent]); const renderComposerContextMenu = () => { if (!composerContextMenuOpen || !composerMenuPosition || typeof document === "undefined") return null; const activeMenu = projectMenuOpen ? "project" : agentMenuOpen ? "agent" : "skill";
    return createPortal(
      <ChatComposerContextMenu
        menuRef={composerContextMenuRef}
        testId={`chat-${activeMenu}-menu`}
        ariaLabel={activeMenu === "agent" ? "Chat agent" : undefined}
        onKeyDown={agentMenuOpen ? handleChatAgentMenuKeyDown : undefined}
        position={composerMenuPosition}
      >
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
        {agentMenuOpen ? (
          <ChatAgentMenuContent agents={liveAgents} activeAgentId={activeAgentId} agentSelectionLocked={agentSelectionLocked} runtimeSelectionPending={runtimeSelectionPending} newConversationSendInFlight={newConversationSendInFlight} externalBound={selectedConversationExternalBound} adapterModels={adapterModelsQuery.data} overrides={activeRuntimeOverrides} runtimeLabel={runtimePillLabel} isLoading={adapterModelsQuery.isPending} error={adapterModelsQuery.error} modelSelectRef={runtimeModelSelectRef} onSelectAgent={applyPreferredAgent} onChangeRuntime={applyRuntimeOverrides} />
        ) : null}
        {skillMenuOpen ? (
          <ChatComposerSkillsMenuContent
            pending={chatSkillsPending}
            skills={availableChatSkills}
            filteredSkills={filteredChatSkills}
            searchQuery={skillSearchQuery}
            searchInputRef={skillSearchInputRef}
            onSearchQueryChange={setSkillSearchQuery}
            onSelect={insertSkillReference}
          />
        ) : null}
      </ChatComposerContextMenu>,
      document.body,
    );
  }; const refreshQueue = (chatId: string) => {
    if (!selectedOrganizationId) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.chats.queue(selectedOrganizationId, chatId) });
  };
  useEffect(() => {
    if (!selectedOrganizationId || !selectedConversation) return;
    void queryClient.invalidateQueries({
      queryKey: queryKeys.chats.messages(selectedOrganizationId, selectedConversation.id),
    });
  }, [activeQueueProjectionKey, queryClient, selectedConversation, selectedOrganizationId]);
  const clearSteerRetry = (pending: PendingChatSteerRetry) => {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    if (steerRetryStatesRef.current.get(pending.key) === pending) {
      steerRetryStatesRef.current.delete(pending.key);
    }
  };
  const scheduleSteerRetry = (pending: PendingChatSteerRetry) => {
    if (steerRetryStatesRef.current.get(pending.key) !== pending || pending.timer) return;
    const delayMs = CHAT_STEER_RETRY_DELAYS_MS[
      Math.min(pending.retryCount, CHAT_STEER_RETRY_DELAYS_MS.length - 1)
    ];
    pending.retryCount += 1;
    pending.timer = setTimeout(() => {
      pending.timer = null;
      if (steerRetryStatesRef.current.get(pending.key) === pending) {
        submitSteerRetryRef.current(pending);
      }
    }, delayMs);
  };
  const submitSteerRetry = (pending: PendingChatSteerRetry) => {
    const { chatId, itemId, orgId, request } = pending;
    if (steeringQueuedItemIdsRef.current.has(itemId)) return;
    steeringQueuedItemIdsRef.current.add(itemId);
    setSteeringQueuedItemIds((current) => new Set(current).add(itemId));
    queryClient.setQueryData(
      queryKeys.chats.queue(orgId, chatId),
      (current: Awaited<ReturnType<typeof chatsApi.listQueue>> | undefined) => ({
        activeGenerationId: current?.activeGenerationId ?? request.expectedActiveGenerationId ?? null,
        activeAttemptEpoch: current?.activeAttemptEpoch ?? request.expectedAttemptEpoch ?? null,
        activeControlVersion: current?.activeControlVersion ?? request.expectedControlVersion ?? null,
        activeGenerationStatus: current?.activeGenerationStatus ?? null,
        items: (current?.items ?? []).map((item) => item.id === itemId && item.status === "queued"
          ? {
              ...item,
              status: "steer_pending" as const,
              deliveryIntent: "steer" as const,
              deliveryDisposition: "pending" as const,
              controlActionId: request.controlActionId,
              lastDeliveryReason: null,
            }
          : item),
      }),
    );
    let retryScheduled = false;
    void chatsApi.steerQueuedMessage(chatId, itemId, request)
      .then((result) => {
        clearSteerRetry(pending);
        queryClient.setQueryData(
          queryKeys.chats.queue(orgId, chatId),
          (current: Awaited<ReturnType<typeof chatsApi.listQueue>> | undefined) => ({
            activeGenerationId: current?.activeGenerationId ?? request.expectedActiveGenerationId ?? null,
            activeAttemptEpoch: current?.activeAttemptEpoch ?? request.expectedAttemptEpoch ?? null,
            activeControlVersion: current?.activeControlVersion ?? request.expectedControlVersion ?? null,
            activeGenerationStatus: current?.activeGenerationStatus ?? null,
            items: (current?.items ?? []).map((item) => item.id === itemId ? result.item : item),
          }),
        );
        refreshQueue(chatId);
      })
      .catch((error) => {
        refreshQueue(chatId);
        if (!(error instanceof ApiError)) {
          retryScheduled = true;
          scheduleSteerRetry(pending);
          return;
        }
        clearSteerRetry(pending);
      })
      .finally(() => {
        steeringQueuedItemIdsRef.current.delete(itemId);
        if (retryScheduled) return;
        setSteeringQueuedItemIds((current) => {
          if (!current.has(itemId)) return current;
          const next = new Set(current);
          next.delete(itemId);
          return next;
        });
      });
  };
  submitSteerRetryRef.current = submitSteerRetry;
  const steerQueuedMessage = (itemId: string) => {
    if (!selectedConversation || !selectedOrganizationId || steeringQueuedItemIdsRef.current.has(itemId)) return;
    const activeGenerationId = serverActiveGenerationId;
    const expectedAttemptEpoch = queueQuery.data?.activeAttemptEpoch;
    const expectedControlVersion = queueQuery.data?.activeControlVersion;
    const chatId = selectedConversation.id;
    const item = activeQueueItems.find((candidate) => candidate.id === itemId);
    const request: ChatSteerQueuedMessageRequest = {
      controlActionId: item?.status === "failed_actionable"
        ? globalThis.crypto.randomUUID()
        : item?.controlActionId ?? globalThis.crypto.randomUUID(),
      ...(activeGenerationId ? { expectedActiveGenerationId: activeGenerationId } : {}),
      ...(expectedAttemptEpoch !== null && expectedAttemptEpoch !== undefined
        ? { expectedAttemptEpoch }
        : {}),
      ...(expectedControlVersion !== null && expectedControlVersion !== undefined
        ? { expectedControlVersion }
        : {}),
      ...(streamDrafts[streamScopeKeyForChatId(chatId)] ? {
        lastCommittedRenderSeq: streamDrafts[streamScopeKeyForChatId(chatId)].lastCommittedRenderSeq ?? 0,
        renderedBodyHash: streamDrafts[streamScopeKeyForChatId(chatId)].renderedBodyHash ?? EMPTY_CHAT_BODY_SHA256,
      } : {}),
    };
    const pending: PendingChatSteerRetry = {
      key: `${chatId}\u0000${itemId}`,
      orgId: selectedOrganizationId,
      chatId,
      itemId,
      request,
      retryCount: 0,
      timer: null,
    };
    steerRetryStatesRef.current.set(pending.key, pending);
    submitSteerRetry(pending);
  };
  const editQueuedMessage = (itemId: string, body: string) => {
    const item = activeQueueItems.find((candidate) => candidate.id === itemId);
    if (!item) return;
    setEditingQueuedItem({ itemId, value: body, version: item.version });
  };
  const saveQueuedMessage = (item: ChatQueuedMessage) => {
    if (!selectedConversation || editingQueuedItem?.itemId !== item.id || !selectedOrganizationId) return;
    const body = editingQueuedItem.value.trim();
    if (!body && (item.payload.inlineAnnotations?.length ?? 0) === 0) {
      pushToast({ title: "Queued message cannot be empty", tone: "error" });
      return;
    }
    const chatId = selectedConversation.id;
    void chatsApi.updateQueuedMessage(chatId, item.id, {
      version: editingQueuedItem.version,
      payload: queuedMessagePayloadForBodyEdit(item.payload, body),
    }).then((updated) => {
      queryClient.setQueryData(
        queryKeys.chats.queue(selectedOrganizationId, chatId),
        (current: Awaited<ReturnType<typeof chatsApi.listQueue>> | undefined) => ({
          activeGenerationId: current?.activeGenerationId ?? queueQuery.data?.activeGenerationId ?? null,
          activeAttemptEpoch: current?.activeAttemptEpoch ?? queueQuery.data?.activeAttemptEpoch ?? null,
          activeControlVersion: current?.activeControlVersion ?? queueQuery.data?.activeControlVersion ?? null,
          activeGenerationStatus: current?.activeGenerationStatus ?? queueQuery.data?.activeGenerationStatus ?? null,
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
    <ChatComposerSurface
      ref={composerSurfaceRef}
      centered={centered}
      streaming={composerStreaming}
      fileDragActive={composerFileDragActive}
      fileDropTargetProps={composerFileDropTargetProps}
    >
      {composerFileDragActive ? <ChatComposerFileDropOverlay /> : null}
      {selectedConversation && visibleQueueItems.length > 0 ? (
        <div data-testid="chat-running-queue" className="mb-2.5 rounded-[var(--radius-md)] border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_88%,transparent)] p-2">
          <div className="mb-1.5 flex items-center justify-between gap-2 px-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            <span>Queue</span>
            <span>{visibleQueueItems.length} queued</span>
          </div>
          <div className="space-y-1.5">
            {visibleQueueItems.map((item, index) => {
              const itemSteering = steeringQueuedItemIds.has(item.id);
              const delivery = projectChatQueueDelivery(item, itemSteering);
              const itemEditable = delivery.state === "queued" && !itemSteering;
              const itemRetryable = delivery.state === "failed" && !itemSteering;
              return (
                <div key={item.id} data-testid="chat-running-queue-item" className="flex min-w-0 items-center gap-2 rounded-[var(--radius-md)] border border-border/60 bg-background/70 px-2.5 py-2 text-sm">
                  <span className="shrink-0 text-xs font-semibold text-muted-foreground">#{index + 1}</span>
                  {editingQueuedItem?.itemId === item.id && itemEditable ? (
                    <>
                      <Textarea aria-label="Edit queued message text" data-testid="chat-running-queue-edit" className="min-h-9 flex-1 resize-none rounded-[var(--radius-sm)] border-border/70 bg-background px-2 py-1.5 text-sm" value={editingQueuedItem.value} onChange={(event) => setEditingQueuedItem((current) => current?.itemId === item.id ? { ...current, value: event.target.value } : current)} />
                      <button type="button" className="shrink-0 rounded-full px-2 py-1 text-xs font-semibold text-foreground transition-colors hover:bg-muted" onClick={() => saveQueuedMessage(item)}>Save</button>
                      <button type="button" className="shrink-0 rounded-full px-2 py-1 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted" onClick={() => setEditingQueuedItem(null)}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate text-foreground">{item.payload.body}</span>
                      {item.payload.inlineAnnotations?.length ? (
                        <span
                          data-testid="chat-running-queue-annotation-count"
                          className="chat-chip shrink-0 px-2 py-0.5 text-[11px] text-muted-foreground"
                        >
                          {item.payload.inlineAnnotations.length} {item.payload.inlineAnnotations.length === 1 ? "annotation" : "annotations"}
                        </span>
                      ) : null}
                      {delivery.state !== "hidden" ? (
                        <span className={cn(
                          "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                          delivery.state === "failed"
                            ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                            : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                        )}>{delivery.label}</span>
                      ) : null}
                      {itemEditable ? (
                        <>
                          {canSteerQueuedMessages ? (
                            <button type="button" className="shrink-0 rounded-full px-2 py-1 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-500/10 dark:text-emerald-300" onClick={() => steerQueuedMessage(item.id)}>Steer</button>
                          ) : null}
                          <button type="button" aria-label="Edit queued message" className="shrink-0 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" onClick={() => editQueuedMessage(item.id, item.payload.body)}><Pencil className="h-3.5 w-3.5" /></button>
                          <button type="button" aria-label="Delete queued message" className="shrink-0 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" onClick={() => deleteQueuedMessage(item.id)}><Trash2 className="h-3.5 w-3.5" /></button>
                        </>
                      ) : itemRetryable ? (
                        <button type="button" className="shrink-0 rounded-full px-2 py-1 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-500/10 dark:text-emerald-300" onClick={() => steerQueuedMessage(item.id)}>Retry</button>
                      ) : null}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
      {responseAnnotationState.annotations.length > 0 ? (
        <div
          className="mb-2.5 flex flex-col items-start gap-2"
        >
          <DraftResponseAnnotationsPopover
            annotations={responseAnnotationState.annotations}
            pendingFilesByAnnotationId={responseAnnotationState.pendingFilesByAnnotationId}
            open={responseAnnotationsExpanded}
            buttonRef={draftResponseAnnotationsChipRef}
            onOpenChange={(open) => {
              setResponseAnnotationsExpanded(open);
              if (open) {
                responseAnnotationEditor.close();
              }
            }}
            onClear={() => {
              dispatchResponseAnnotation({ type: "clear" });
              setResponseAnnotationsExpanded(false);
              responseAnnotationEditor.close();
              setResponseAnnotationAnnouncement(t("chat.annotations.removed"));
            }}
            onEdit={(annotation) => {
              responseAnnotationEditor.openFromAnchor(
                annotation.id,
                draftResponseAnnotationsChipRef.current,
              );
            }}
            onDelete={(annotationId) => {
              dispatchResponseAnnotation({ type: "delete", id: annotationId });
              if (responseAnnotationState.annotations.length === 1) {
                setResponseAnnotationsExpanded(false);
              }
              if (responseAnnotationEditor.annotationId === annotationId) {
                responseAnnotationEditor.close();
              }
              setResponseAnnotationAnnouncement(t("chat.annotations.removed"));
            }}
          />
          {responseAnnotationEditor.annotationId ? (() => {
            const annotation = responseAnnotationState.annotations.find(
              (candidate) => candidate.id === responseAnnotationEditor.annotationId,
            );
            if (!annotation) return null;
            return (
              <ResponseAnnotationEditor
                key={annotation.id}
                annotation={annotation}
                ordinal={annotation.ordinal}
                pendingFiles={
                  responseAnnotationState.pendingFilesByAnnotationId[annotation.id] ?? []
                }
                {...responseAnnotationEditor.editorPlacement}
                validateSave={(changes) => validateChatResponseAnnotationReplacement(
                  responseAnnotationState,
                  annotation.id,
                  {
                    comment: changes.comment,
                    attachmentIds: changes.attachmentIds,
                    files: changes.pendingFiles,
                  },
                )}
                onSave={(changes) => {
                  dispatchResponseAnnotation({
                    type: "replaceDraft",
                    id: annotation.id,
                    comment: changes.comment,
                    attachmentIds: changes.attachmentIds,
                    files: changes.pendingFiles,
                  });
                  responseAnnotationEditor.close();
                }}
                onCancel={responseAnnotationEditor.close}
                onDelete={() => {
                  dispatchResponseAnnotation({ type: "delete", id: annotation.id });
                  responseAnnotationEditor.close();
                  setResponseAnnotationAnnouncement(t("chat.annotations.removed"));
                }}
              />
            );
          })() : null}
        </div>
      ) : null}
      {pendingFiles.length > 0 ? (
        <div data-testid="chat-pending-attachments" className="mb-2.5 flex flex-wrap gap-2 px-3">
          {pendingFiles.map((file) => { const fileKey = pendingAttachmentKey(file);
            return (
              <div key={fileKey} data-testid="chat-pending-attachment" className="max-w-full" >
                <PendingAttachmentPreview file={file} onRemove={() => removePendingFile(fileKey)} /> </div> );
          })} </div> ) : null}
      <ChatComposerEditor
          ref={composerEditorRef}
          scrollRef={composerEditorScrollRef}
          value={draft}
          onChange={handleComposerDraftChange}
          mentions={mentionOptions}
          onMentionQueryChange={setLibraryFileMentionQuery}
          mentionMenuAnchorRef={composerSurfaceRef}
          mentionMenuPlacement="container"
          onInlineTokenClick={handleComposerInlineTokenClick}
          onKeyDownCapture={handleComposerSuggestionKeyDown}
          onPasteCapture={handlePendingAttachmentPasteCapture}
          contentClassName={cn(
            selectedEmptyStatePromptGroup && "font-semibold",
          )}
          placeholder={composerPlaceholder}
          onSubmit={() => {
            if (composerUnavailable || newConversationSendInFlight || runtimeSelectionPending) return;
            if (selectedConversationHasActiveReply && selectedConversation) {
              void queueComposerMessage(selectedConversation);
              return;
            }
            if (!controlsDisabled) {
              void sendMessage(); }
          }}
        />
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {responseAnnotationAnnouncement}
      </div>
      {renderSideChatSlashCommandMenu()}
      {composerUnavailable && composerUnavailableMessage ? (
        <div className="chat-warning mt-2.5 rounded-[var(--radius-md)] px-3 py-2.5 text-sm">
          {composerUnavailableMessage}{" "}
          <Link to="/agents" className="underline underline-offset-4 hover:text-foreground">
            Open agents </Link> </div> ) : null}
      <ChatComposerToolbar
        actions={(
          <>
            {canStopSelectedConversationReply && selectedConversation && sendButtonMode !== "stop" && sendButtonMode !== "sending" && sendButtonMode !== "stopping" ? (
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Stop streaming" onClick={() => stopStreaming(selectedConversation.id)} className={cn(
                "shrink-0 rounded-full border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-active)_52%,transparent)] text-foreground",
                "hover:bg-[color:var(--surface-active)]",
                "focus-visible:ring-2 focus-visible:ring-ring/40",
              )} >
                <Square className="h-3.5 w-3.5 fill-current" /> </Button>
            ) : null}
            <ChatComposerSendButton
              mode={sendButtonMode}
              disabled={sendButtonDisabled}
              stoppingComplete={activeStream?.state === "stopped"}
              onClick={() => {
                if (sendButtonMode === "stop" && selectedConversation) {
                  stopStreaming(selectedConversation.id);
                  return;
                }
                if (sendButtonMode === "queue" && selectedConversation) {
                  void queueComposerMessage(selectedConversation);
                  return;
                }
                if (sendButtonMode === "send") {
                  void sendMessage();
                }
              }}
            />
          </>
        )}
      >
          <ChatComposerAddMenu
            open={plusMenuOpen}
            onOpenChange={setPlusMenuOpen}
            onAddFiles={() => fileInputRef.current?.click()}
          >
              <ChatPlanModeMenuToggle active={activePlanMode} onChange={applyPlanMode} />
          </ChatComposerAddMenu>
          {activePlanMode ? <ChatPlanModeChip onDisable={() => applyPlanMode(false)} /> : null}
          {showProjectSelector ? (
            <div className="group/project relative inline-flex max-w-[min(100%,15rem)] min-w-0">
              <button type="button" data-testid="chat-project-selector" aria-label={`Project context: ${projectPillLabel}`} aria-expanded={projectSelectionLocked ? false : projectMenuOpen} disabled={projectSelectionLocked} title={projectSelectionLocked ? "Project context is locked after conversation starts." : undefined} className={cn(
                  "chat-chip inline-flex w-full min-w-0 items-center gap-1.5 rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium",
                  projectSelectionLocked ? "cursor-default" : "transition-colors hover:bg-[color:var(--surface-active)]",
                  projectMenuOpen && "bg-[color:var(--surface-active)]",
                )} onClick={() => { if (projectSelectionLocked) return;
                  if (projectMenuOpen) { closeComposerContextMenus();
                    return; } openComposerContextMenu("project");
                }} >
                {hasSelectedProject ? (
                  <ProjectIcon
                    color={activeProject?.color}
                    icon={activeProject?.icon}
                    size="xs"
                    testId="chat-project-icon"
                    className={cn(
                      "transition-opacity",
                      !projectSelectionLocked && "group-focus-within/project:opacity-0 group-hover/project:opacity-0",
                    )}
                  />
                ) : null}
                <span className="min-w-0 truncate">{projectPillLabel}</span>
              </button>
              {hasSelectedProject && !projectSelectionLocked ? (
                <button type="button" data-testid="chat-project-clear" aria-label={`Clear project context: ${projectPillLabel}`} title="Clear project context" className="absolute left-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-[var(--radius-sm)] text-muted-foreground opacity-0 pointer-events-none transition-[color,background-color,opacity] hover:bg-[color:var(--surface-inset)] hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40 group-focus-within/project:pointer-events-auto group-focus-within/project:opacity-100 group-hover/project:pointer-events-auto group-hover/project:opacity-100" onClick={(event) => {
                    event.stopPropagation();
                    applyProjectContext(NO_PROJECT_ID);
                  }} >
                  <X className="h-4 w-4" strokeWidth={2.4} />
                </button>
              ) : null}
            </div>
          ) : null}
          <ChatAgentSelectorButton buttonRef={runtimeSelectorRef} agent={activeSkillAgent} label={agentPillLabel} expanded={agentMenuOpen} disabled={!agents || (!selectedConversation && newConversationSendInFlight)} onClick={() => {
              if (agentMenuOpen) { closeComposerContextMenus();
                return; } openComposerContextMenu("agent");
            }} />
          {showChatSkillsPicker ? (
            <ChatComposerSkillsButton open={skillMenuOpen} onClick={() => {
                if (skillMenuOpen) { closeComposerContextMenus();
                  return; } openComposerContextMenu("skill");
              }} />
          ) : null}
      </ChatComposerToolbar>
      {pendingResponseAnnotationSelection ? (
        <SelectionAnnotationToolbar
          open
          anchorRect={pendingResponseAnnotationSelection.anchorRect}
          getAnchorSnapshot={() => {
            try {
              const liveSelection = restoreLiveChatAnnotationRange({
                anchor: pendingResponseAnnotationSelection.anchor,
                source: pendingResponseAnnotationSelection.source,
                searchRoot: chatMainWorkspaceRef.current ?? document,
              });
              return {
                available: Boolean(liveSelection),
                anchorRect: liveSelection?.range.getBoundingClientRect() ?? null,
                boundaryRect: chatMainWorkspaceRef.current?.getBoundingClientRect() ?? null,
              };
            } catch {
              return {
                available: false,
                anchorRect: null,
                boundaryRect: null,
              };
            }
          }}
          anchorObservationRoot={chatMainWorkspaceRef.current}
          boundaryRect={chatMainWorkspaceRef.current?.getBoundingClientRect() ?? null}
          onAddToChat={() => void handleAddSelectionToChat()}
          onAskInSideChat={() => void handleAskSelectionInSideChat()}
          askInSideChatDisabled={!pendingResponseAnnotationSelection.sideChatEligible}
          onDismiss={() => setPendingResponseAnnotationSelection(null)}
          onAnchorUnavailable={() => setPendingResponseAnnotationSelection(null)}
          onReturnFocus={() => composerEditorRef.current?.focus()}
          autoFocus={pendingResponseAnnotationSelection.autoFocusToolbar}
        />
      ) : null}
      {renderComposerContextMenu()} </ChatComposerSurface> );
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
                interactive={suggestionsActive && !emptyStatePromptSuggestionsLocked}
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
      <input ref={fileInputRef} type="file" className="hidden"
        multiple onChange={(event) => { const files = Array.from(event.target.files ?? []); void appendPendingFiles(files); event.currentTarget.value = "";
        }} />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row md:gap-1.5">
        <main
          ref={chatMainWorkspaceRef}
          data-testid="chat-main-workspace-card"
          className="workspace-main-card relative flex min-h-0 flex-1 flex-col overflow-hidden md:rounded-[var(--desktop-workspace-radius)]"
        >
          {conversationId && macDesktopShell ? (
            <div
              data-testid="chat-desktop-toolbar-clearance"
              className="chat-desktop-toolbar-clearance workspace-main-header hidden shrink-0 items-center px-3 pr-32 md:flex"
            >
              {selectedConversation ? (
                <ChatConversationHeader
                  agent={conversationHeaderAgent}
                  title={conversationDisplayTitle(selectedConversation)}
                />
              ) : null}
            </div>
          ) : null}
          {loadErrorMessage && conversationId ? (
            <div
              aria-hidden="true"
              data-testid="chat-load-error-mobile-clearance"
              className="h-14 shrink-0 md:hidden"
            />
          ) : null}
          {loadErrorMessage ? (
            <div
              role="alert"
              data-testid="chat-load-error"
              className={cn(
                "chat-load-error-offset mx-6 rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive",
              )}
            >
              {loadErrorMessage} </div> ) : null}
          {!selectedOrganizationId ? (
            <div className="flex flex-1 items-center justify-center px-6 py-12 text-sm text-muted-foreground">
              Select a organization first. </div> ) : showConversationLoading ? (
            <div className="chat-conversation-loading-offset flex min-h-0 flex-1 flex-col overflow-hidden px-4 md:px-5" data-testid="chat-conversation-loading-state">
              <div ref={chatMessagesScrollRef} data-testid="chat-messages-scroll-region" className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto">
                <div data-testid="chat-messages-content" className="mx-auto flex w-full max-w-4xl flex-col gap-5 pr-1">
                  <ChatMessagesLoadingState />
                </div>
              </div>
            </div> ) : selectedConversation ? ( <>
              <div
                data-testid="chat-desktop-toolbar-actions"
                className={cn(
                  "pointer-events-none absolute right-3 top-12 z-30 flex justify-end gap-1.5",
                  macDesktopShell
                    ? "md:right-3 md:top-2"
                    : "workspace-card-header workspace-main-header md:relative md:right-auto md:top-auto md:h-11 md:shrink-0 md:items-center md:justify-between md:px-3",
                )}
              >
                {!macDesktopShell ? (
                  <ChatConversationHeader
                    agent={conversationHeaderAgent}
                    title={conversationDisplayTitle(selectedConversation)}
                    className="hidden md:flex"
                  />
                ) : null}
                <div className="ml-auto flex items-center gap-1.5">
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
                    <ChatAgentRunMenuItem conversation={selectedConversation} isLoading={showMessagesLoading} messages={rawMessages} onOpen={({ agentId, runId }) => navigate(`/agents/${agentId}/runs/${runId}`)} />
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
              </div>
              <div className="pointer-events-none absolute right-4 top-12 z-20 md:right-5">
                <ChatWorkManifest
                  manifest={workManifest}
                  loading={workManifestQuery.isPending}
                  error={workManifestError}
                  sidePanelOpen={sidePanelOpen}
                  wideOpen={workManifestWideOpen}
                  onOpenItem={openWorkManifestItem}
                  onOpenSubagents={openWorkManifestSubagents}
                  onJumpToMessage={jumpToChatMessage}
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
                    "chat-messages-scroll-content min-h-full px-4 transition-[padding] duration-[var(--motion-duration-standard)] ease-[var(--motion-ease-enter)] motion-reduce:transition-none md:px-5",
                    workManifestRailOpen && "xl:pr-[20rem]",
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
                          <VirtualizedActivityTimeline
                            items={chatTimelineRows}
                            scrollElementRef={chatMessagesScrollElementRef}
                            estimateSize={estimateChatTimelineItemSize}
                            getItemKey={getChatTimelineItemKey}
                            targetKey={pendingTargetMessageId}
                            onTargetMounted={(targetMessageId) => {
                              const scrollElement = chatMessagesScrollElementRef.current;
                              if (!scrollElement) return;
                              const target = findChatMessageElement(scrollElement, targetMessageId);
                              if (!target) return;
                              revealChatMessageElement(target);
                              if (!conversationId) return;
                              const nextSearch = new URLSearchParams(searchParams);
                              nextSearch.delete("messageId");
                              nextSearch.delete("targetMessageId");
                              navigate({
                                pathname: chatConversationPath(conversationId),
                                search: nextSearch.toString() ? `?${nextSearch.toString()}` : "",
                              }, { replace: true });
                            }}
                            testId="chat-virtual-timeline"
                          >
                          {(timelineRow) => {
                            if (timelineRow.kind === "active_stream") {
                              if (!activeStream) return null;
                              return (
                                <Fragment key={`active-stream-${activeStream.streamKey}`}>
                                  {showOptimisticUserMessage ? (
                                    <OptimisticUserDraftItem
                                      body={activeStream.userBody}
                                      createdAt={activeStream.userCreatedAt} onCopyMessageText={copyChatMessageText} onEditDraftOnly={editDraftOnly}
                                      skillReferences={chatSkillReferences} onMarkdownLinkClick={handleChatMarkdownLinkClick}
                                      askUserAnswer={
                                        activeStreamAskUserRequest ? parseAskUserAnswerMessage(activeStreamAskUserRequest, activeStream.userBody) : null
                                      }
                                      animateAskUserAnswer={activeStream.userBody.startsWith(ASK_USER_ANSWER_PREFIX)}
                                      turnBranchControls={turnBranchControlsForTurn(activeStream.chatTurnId, activeStream.turnVariant)} /> ) : null}
                                  <StreamTranscriptItem key={`${activeStream.chatId}-${activeStream.createdAt.getTime()}`}
                                    entries={activeStream.transcript}
                                    steerMessages={activeStream.generationId
                                      ? nativeSteerMessagesByGenerationId.get(activeStream.generationId) ?? []
                                      : []}
                                    state={activeStream.state}
                                    streamStartedAt={activeStream.createdAt}
                                    assistantMessageBody={activeStream.body}
                                    showDeveloperDiagnostics={showDeveloperDiagnostics}
                                    onOpenFile={openTranscriptFile}
                                    onOpenSkill={openTranscriptSkill}
                                    canOpenSkill={canOpenTranscriptSkill}
                                    onOpenAgent={openSubagentInspection}
                                    sentAnnotationContext={{
                                      onSelect: handleSelectSentResponseAnnotation,
                                      onExpandedChange: handleSentResponseAnnotationsExpanded,
                                      unlocatableAnnotationId: unlocatableResponseAnnotationId,
                                    }} />
                                  <AssistantDraftItem
                                    body={activeStream.body}
                                    createdAt={activeStream.createdAt}
                                    state={activeStream.state}
                                    replyingAgentId={activeStream.replyingAgentId}
                                    conversation={selectedConversation}
                                    agents={agents} onCopyMessageText={copyChatMessageText}
                                    skillReferences={chatSkillReferences} onMarkdownLinkClick={handleChatMarkdownLinkClick} />
                                </Fragment>
                              );
                            }
                            const { message, messageIndex } = timelineRow;
                            const previousMessage = visibleMessages[messageIndex - 1] ?? null; const previousPreviousMessage = visibleMessages[messageIndex - 2] ?? null; if (shouldAttachIssueCreatedSystemMessage(previousMessage, message) || shouldAttachApprovalFeedbackSystemMessage(previousPreviousMessage, previousMessage, message)) return null; const nextMessage = visibleMessages[messageIndex + 1] ?? null; const issueCreatedMessage = shouldAttachIssueCreatedSystemMessage(message, nextMessage) ? nextMessage : null; const persistedTranscript = (loadedTranscriptsByMessageId[message.id] ?? message.transcript ?? []) as TranscriptEntry[];
                            const messageSteerMessages = message.generationId
                              ? nativeSteerMessagesByGenerationId.get(message.generationId) ?? []
                              : [];
                            const messageCanShowProcess = message.role === "assistant"
                              || message.kind === "issue_proposal" || message.kind === "operation_proposal";
                            const shouldRenderPersistedTranscript =
                              (persistedTranscript.length > 0 || messageSteerMessages.length > 0)
                              && messageCanShowProcess; const shouldRenderLazyTranscript = persistedTranscript.length === 0 && messageSteerMessages.length === 0 && messageCanShowProcess && Boolean(message.transcriptSummary?.entryCount); const persistedProcessStartedAt = shouldRenderPersistedTranscript ? resolvePersistedChatProcessStartedAt(visibleMessages, message, persistedTranscript) : null; const persistedProcessEndedAt = shouldRenderPersistedTranscript ? resolvePersistedChatProcessEndedAt(message, persistedTranscript) : null;
                            const messageTurnBranchControls = turnBranchControlsFor(message);
                            const refreshTurnBranchControls = message.chatTurnId ? turnBranchControlsForTurn(message.chatTurnId) : null;
                            const historicalAnnotationsForMessage = historicalResponseAnnotations.filter(
                              (annotation) => annotation.sourceMessageId === message.id,
                            );
                            const historicalAnnotationIds = new Set(
                              historicalAnnotationsForMessage.map((annotation) => annotation.id),
                            );
                            const responseAnnotationsForMessage = [
                              ...responseAnnotationState.annotations.filter(
                                (annotation) => !historicalAnnotationIds.has(annotation.id),
                              ),
                              ...historicalAnnotationsForMessage,
                            ];
                            return (
                              <Fragment key={message.id}>
                                {shouldRenderPersistedTranscript ? (
                                  <StreamTranscriptItem
                                    entries={persistedTranscript}
                                    steerMessages={messageSteerMessages}
                                    state={message.status}
                                    generationTerminalReason={message.generationTerminalReason}
                                    streamStartedAt={persistedProcessStartedAt!}
                                    streamEndedAt={persistedProcessEndedAt}
                                    assistantMessageBody={message.body}
                                    showDeveloperDiagnostics={showDeveloperDiagnostics}
                                    open={openProcessMessageIds[message.id]} onOpenChange={(open) => setProcessOpenForMessage(message.id, open)}
                                    onOpenFile={openTranscriptFile}
                                    onOpenSkill={openTranscriptSkill}
                                    canOpenSkill={canOpenTranscriptSkill}
                                    onOpenAgent={openSubagentInspection}
                                    annotationSource={
                                      message.role === "assistant"
                                      && (message.status === "completed" || message.status === "stopped" || message.status === "failed")
                                          ? {
                                            sourceConversationId: message.conversationId,
                                            sourceMessageId: message.id,
                                            annotations: responseAnnotationsForMessage,
                                            onActivateAnnotation: (annotationId, anchor) => {
                                              if (responseAnnotationState.annotations.some(
                                                (annotation) => annotation.id === annotationId,
                                              )) {
                                                setResponseAnnotationsExpanded(false);
                                                responseAnnotationEditor.openFromAnchor(
                                                  annotationId,
                                                  anchor,
                                                );
                                              } else {
                                                responseAnnotationEditor.close();
                                              }
                                            },
                                          }
                                        : undefined
                                    }
                                    sentAnnotationContext={{
                                      onSelect: handleSelectSentResponseAnnotation,
                                      onExpandedChange: handleSentResponseAnnotationsExpanded,
                                      unlocatableAnnotationId: unlocatableResponseAnnotationId,
                                    }} /> ) : shouldRenderLazyTranscript && message.transcriptSummary ? (
                                  <LazyStreamTranscriptItem
                                    summary={message.transcriptSummary}
                                    state={message.status}
                                    generationTerminalReason={message.generationTerminalReason}
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
                                  } onCopyMessageText={copyChatMessageText} onOpenSideChat={selectedConversationExternalBound ? undefined : (messageForSideChat) => {
                                    openSidePanelTargetForContext(
                                      resolveCurrentSidePanelChatContextKey(),
                                      sideChatTargetFromMessage(selectedConversation, messageForSideChat),
                                    );
                                  }} onEditUserMessage={selectedConversationExternalBound ? undefined : beginEditUserMessage} onContinueInterruptedMessage={selectedConversationExternalBound ? undefined : () => {
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
                                  })} onOpenFile={openLocalFile} onMarkdownLinkClick={handleChatMarkdownLinkClick}
                                  responseAnnotations={responseAnnotationsForMessage}
                                  onEditResponseAnnotation={(annotationId, anchor) => {
                                    if (responseAnnotationState.annotations.some(
                                      (annotation) => annotation.id === annotationId,
                                    )) {
                                      setResponseAnnotationsExpanded(false);
                                      responseAnnotationEditor.openFromAnchor(
                                        annotationId,
                                        anchor,
                                      );
                                    } else {
                                      responseAnnotationEditor.close();
                                    }
                                  }}
                                  onSelectResponseAnnotation={handleSelectSentResponseAnnotation}
                                  onResponseAnnotationsExpanded={handleSentResponseAnnotationsExpanded}
                                  unlocatableResponseAnnotationId={unlocatableResponseAnnotationId}
                                  turnBranchControls={messageTurnBranchControls}
                                  skillReferences={chatSkillReferences}
                                  issueCreatedMessage={issueCreatedMessage}
                                  inlineEdit={inlineEditUserMessageId === message.id ? {
                                    draft: inlineEditDraft,
                                    canSubmitWithoutBody: (
                                      chatInlineAnnotationsFromStructuredPayload(
                                        message.structuredPayload,
                                      ).length > 0
                                    ),
                                    disabled: controlsDisabled || selectedConversationHasActiveReply || composerUnavailable || selectedConversationExternalBound,
                                    mentions: mentionOptions,
                                    surfaceRef: inlineEditSurfaceRef,
                                    editorRef: inlineEditEditorRef,
                                    onChange: setInlineEditDraft,
                                    onSubmit: () => submitInlineEditUserMessage(message),
                                    onCancel: cancelInlineEditUserMessage,
                                    onMentionQueryChange: setLibraryFileMentionQuery,
                                    onInlineTokenClick: handleComposerInlineTokenClick,
                                  } : null}
                                  answered={activeStreamUserTurnVisible || isAskUserMessageAnswered(message, visibleMessages)}
                                  askUserAnswer={askUserAnswerFromMessage(message, visibleMessages)}
                                  animateAskUserAnswer={message.id === recentAskUserAnswerMessageId} /> </Fragment> ); }}
                          </VirtualizedActivityTimeline> </>
                      )} </div> </div> </div> </div>
                {hasActionableApprovals || hasPendingLightweightProposal ? null : (
                  <div
                    data-testid="chat-composer-layout"
                    className={cn(
                    "w-full shrink-0 px-4 pb-4 transition-[padding] duration-[var(--motion-duration-standard)] ease-[var(--motion-ease-enter)] motion-reduce:transition-none md:px-5",
                    workManifestRailOpen && "xl:pr-[20rem]",
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
                        onDropAttachments={appendPendingFiles}
                        onRemovePendingFile={removePendingFile}
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
                      <div className="mb-2 flex min-h-8 items-center px-1">
                        <TabsList variant="line" aria-label="New chat empty state" className="h-8 gap-1 border-transparent bg-transparent p-0">
                          <TabsTrigger value="use-cases" id="chat-empty-state-tab-use-cases" data-testid="chat-empty-state-tab-use-cases" className="h-8 flex-none rounded-[var(--radius-md)] border border-transparent px-3 text-sm data-[state=active]:!border-[color:var(--border-soft)] data-[state=active]:!bg-[color:var(--surface-active)] data-[state=active]:shadow-none after:hidden">
                            <span>Use cases</span>
                          </TabsTrigger>
                          <TabsTrigger value="recent" id="chat-empty-state-tab-recent" data-testid="chat-empty-state-tab-recent" className="h-8 flex-none rounded-[var(--radius-md)] border border-transparent px-3 text-sm data-[state=active]:!border-[color:var(--border-soft)] data-[state=active]:!bg-[color:var(--surface-active)] data-[state=active]:shadow-none after:hidden">
                            <span>Chats</span>
                          </TabsTrigger>
                        </TabsList>
                      </div>
                      <TabsContent value="use-cases" id="chat-empty-state-use-cases-panel" aria-labelledby="chat-empty-state-tab-use-cases" className="mt-0 flex flex-col items-center">
                        {renderEmptyStatePromptFlow()}
                      </TabsContent>
                      <TabsContent value="recent" id="chat-empty-state-recent-panel" aria-labelledby="chat-empty-state-tab-recent" className="mt-0">
                        <ChatEmptyStateRecentConversations
                          key={activeProject ? `project:${activeProject.id}` : "no-project"}
                          className="!mt-0"
                          conversations={recentProjectConversations}
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
