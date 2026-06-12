import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react"; import { createPortal } from "react-dom"; import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
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
  MoreHorizontal,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Settings2,
  Square,
  Trash2,
  X, } from "lucide-react";
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
  type Project, } from "@rudderhq/shared"; import type { TranscriptEntry } from "@/agent-runtimes"; import { appendTranscriptEntry } from "@/agent-runtimes/transcript"; import { Link, useLocation, useNavigate, useParams, useSearchParams } from "@/lib/router"; import { Button } from "@/components/ui/button"; import { Textarea } from "@/components/ui/textarea"; import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger, } from "@/components/ui/dropdown-menu"; import { MarkdownBody, type MarkdownLinkClickHandler } from "@/components/MarkdownBody"; import { ChatRichReferences } from "@/components/chat-renderables/ChatRichReferences"; import { TextDots } from "@/components/TextDots"; import { formatPriorityLabel } from "@/lib/priorities"; import { ImagePreviewDialog } from "@/components/ImagePreviewDialog"; import type { MarkdownSkillReferencePreview } from "@/components/SkillReferenceToken"; import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "@/components/MarkdownEditor"; import { AgentIcon, getAgentAvatarImageSrc } from "@/components/AgentIconPicker"; import { HoverTimestampLabel } from "@/components/HoverTimestamp"; import { StatusBadge } from "@/components/StatusBadge"; import { RunTranscriptView } from "@/components/transcript/RunTranscriptView"; import { Skeleton } from "@/components/ui/skeleton"; import { useOrganization } from "@/context/OrganizationContext"; import { useBreadcrumbs } from "@/context/BreadcrumbContext"; import { useSidebar } from "@/context/SidebarContext"; import { useToast } from "@/context/ToastContext"; import { useDialog } from "@/context/DialogContext"; import { useChatGenerations, type ChatStreamDraft, type ChatStreamDraftState } from "@/context/ChatGenerationContext"; import { agentsApi } from "@/api/agents"; import { approvalsApi } from "@/api/approvals"; import { authApi } from "@/api/auth"; import { ApiError } from "@/api/client"; import { chatsApi } from "@/api/chats"; import { instanceSettingsApi } from "@/api/instanceSettings"; import { issuesApi } from "@/api/issues"; import { organizationsApi } from "@/api/orgs"; import { projectsApi } from "@/api/projects"; import { organizationSkillsApi } from "@/api/organizationSkills"; import { prefetchChatConversation } from "@/lib/chat-prefetch"; import { clearChatAskUserDraft, readChatDraft, saveChatDraft } from "@/lib/chat-draft-storage";
import {
  readChatPendingAttachmentsForScope,
  resolveChatPendingAttachmentScopeKey,
  updateChatPendingAttachmentsForScope, } from "@/lib/chat-pending-attachments";
import {
  NO_CHAT_AGENT_ID,
  isSelectableChatAgentId,
  rememberChatAgentId,
  resolveDefaultChatAgentId,
  selectableChatAgents, } from "@/lib/chat-agent-selection"; import { resolveRequestedPreferredAgentId } from "@/lib/chat-route-state"; import { buildChatSkillOptions, filterChatSkillOptions } from "@/lib/chat-skill-options"; import { buildMarkdownMentionOptions } from "@/lib/markdown-mention-options"; import { parseMentionChipHref } from "@/lib/mention-chips"; import type { AtomicInlineTokenElement } from "@/lib/inline-token-dom"; import { displayChatTitle, promoteDefaultChatTitle } from "@/lib/chat-title"; import { formatChatAgentLabel } from "@/lib/agent-labels"; import { rememberMessengerPath } from "@/lib/messenger-memory"; import { invalidateMessengerThreadSummaryQueries, markMessengerChatReadInCache, upsertMessengerThreadSummaryQueries } from "@/lib/messenger-query-cache"; import { projectColorCssVars } from "@/lib/project-colors"; import { ProjectIcon } from "@/components/ProjectIdentity"; import { queryKeys } from "@/lib/queryKeys";
import {
  formatChatProcessDuration,
  lastTranscriptAtMs,
  resolvePersistedChatProcessEndedAt,
  resolvePersistedChatProcessStartedAt, } from "@/lib/chat-process-duration";
import {
  readChatScopedFlag,
  readChatScopedState,
  shouldShowMessageDuringActiveStream, } from "@/lib/chat-stream-state"; import { toOrganizationRelativePath } from "@/lib/organization-routes";
import {
  appendSkillReferencesToDraft, } from "@/lib/organization-skill-picker"; import { formatAssigneeUserLabel } from "@/lib/assignees"; import { readDesktopShell } from "@/lib/desktop-shell";
import {
  canShowImageInFolder,
  copyImage as copyImageAction,
  isImageContentType,
  showImageInFolder as showImageInFolderAction, } from "@/lib/image-actions"; import { resolveLocalFileTarget } from "@/lib/local-file-targets"; import { cn } from "@/lib/utils"; import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef"; import { useI18n } from "@/context/I18nContext"; import { ApprovalAction, AttachmentPreviewState, ChatImageContextMenuPosition, OPEN_TASK_PRIORITY_PROMPT, EMPTY_STATE_PROMPT_GROUPS, NO_PROJECT_ID, CHAT_LAST_PROJECT_STORAGE_KEY, EmptyStatePromptLabel, EmptyStatePromptGroup, ChatEmptyStatePromptOptions, ChatEmptyStateRecentConversations, rememberChatProjectId, rememberChatProjectIdForAgent, resolveDefaultDraftChatProjectId, projectContextId, resolveDraftIssueContext, draftIssueContextLabel, buildDraftChatContextLinks, issueAssigneeMentionLabel, projectDisplayName, chatEmptyStateHeading, COMPOSER_MENU_VIEWPORT_PADDING, COMPOSER_MENU_OFFSET, COMPOSER_MENU_MIN_HEIGHT, COMPOSER_MENU_MAX_HEIGHT, COMPOSER_MENU_MIN_WIDTH, composerMenuPositionForAnchor, inferAttachmentExtension, materializePendingAttachment, pendingAttachmentKey, attachmentDisplayName, clampChatImageContextMenuPosition, shouldHandlePlainChatLinkClick, ChatImageAttachmentTile, ChatFileAttachmentChip, PendingAttachmentPreview, ChatAttachmentList, ChatAttachmentPreviewDialog, NO_CHAT_AGENT_LABEL, PLAN_MODE_HELP_TEXT, ChatBranchPreview, mergeChatMessages, scrollChatMessagesToBottom, computeDisplayedChatMessages, mergeChatConversationsForStatus, conversationDisplayTitle, buildMessengerChatThreadSummary, withOptimisticOutgoingMessage, withOptimisticPlanMode, isChatAgentSelectionLocked, isChatProjectSelectionLocked, approvalNeedsAction, buildChatProposalRevisionPrompt, chatIssueApprovalPayloadWithProposalOverride, issueProposalFromMessage, issueProposalPrincipalLabel, operationProposalFromMessage, operationProposalStatusFromMessage, proposalReviewStatus, proposalReviewBannerCopy, askUserRequestFromMessage, isAskUserMessageAnswered, findLatestUnansweredAskUserMessage, askUserQuestionTitle, AskUserAnswerRecord, ASK_USER_ANSWER_PREFIX, formatAskUserAnswerLines, parseAskUserAnswerMessage, askUserAnswerFromMessage, formatChatPrimaryIssueBreadcrumb, INTERRUPTED_CHAT_CONTINUATION_PROMPT, canContinueInterruptedChatMessage, canRetryFailedChatMessage, findRetrySourceUserMessage, isUserVisibleIncomingChatMessage, assistantStateLabel, statusChipClassName, ChatAssistantAttributionRow, ProposalCard, chatMessageHoverBarClass, ChatLongMessageBody, readStructuredPayloadString, issueCreatedSystemMessageParts, ChatSystemMessageBody, AskUserHistoryRecord, AskUserAnswerBubble, AskUserPanel, ChatMessageItem, OptimisticUserDraftItem, ChatMessagesLoadingState, LazyStreamTranscriptItem, StreamTranscriptItem, AssistantDraftItem } from "./Chat.parts";
export * from "./Chat.parts";
export * from "./Chat.attachments";
export * from "./Chat.messages";
export function Chat() { const { selectedOrganizationId } = useOrganization();
  if (!selectedOrganizationId) {
    return <div className="text-sm text-muted-foreground">Select a organization first.</div>; }
  return <ChatWorkspace key={selectedOrganizationId} />; }
function clipboardAttachmentPayloadKey(file: File) {
  return `${file.name.trim()}\u0000${file.type.trim().toLowerCase()}\u0000${file.size}`;
}
const RECENT_PROJECT_CONVERSATION_INITIAL_LIMIT = 5;
const RECENT_PROJECT_CONVERSATION_LOAD_INCREMENT = 10;
function ChatWorkspace() { const { conversationId } = useParams<{ conversationId?: string }>(); const location = useLocation(); const navigate = useNavigate(); const [searchParams] = useSearchParams(); const queryClient = useQueryClient(); const { selectedOrganization, selectedOrganizationId } = useOrganization(); const { t } = useI18n(); const { setBreadcrumbs } = useBreadcrumbs(); const { pushToast } = useToast(); const { confirm } = useDialog();
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
  const [pendingProjectContextOverride, setPendingProjectContextOverride] = useState<{ chatId: string; projectId: string | null; } | null>(null); const [draftPlanMode, setDraftPlanMode] = useState(false); const [pendingPlanModeOverride, setPendingPlanModeOverride] = useState<boolean | null>(null); const [decisionNotesByMessageId, setDecisionNotesByMessageId] = useState<Record<string, string>>({}); const [issueProposalOverridesByMessageId, setIssueProposalOverridesByMessageId] = useState<Record<string, Record<string, unknown>>>({}); const [plusMenuOpen, setPlusMenuOpen] = useState(false); const [agentMenuOpen, setAgentMenuOpen] = useState(false); const [projectMenuOpen, setProjectMenuOpen] = useState(false); const [skillMenuOpen, setSkillMenuOpen] = useState(false); const [skillSearchQuery, setSkillSearchQuery] = useState(""); const [libraryFileMentionQuery, setLibraryFileMentionQuery] = useState<string | null>(null); const [composerMenuPosition, setComposerMenuPosition] = useState<CSSProperties | null>(null); const [inlineEditUserMessageId, setInlineEditUserMessageId] = useState<string | null>(null); const [inlineEditDraft, setInlineEditDraft] = useState(""); const [branchPreview, setBranchPreview] = useState<ChatBranchPreview | null>(null); const [expandedEmptyStatePrompt, setExpandedEmptyStatePrompt] = useState<EmptyStatePromptLabel | null>(null); const [emptyStatePromptPanelEntered, setEmptyStatePromptPanelEntered] = useState(false); const [emptyStateActiveTab, setEmptyStateActiveTab] = useState<"recent" | "use-cases">("recent"); const [recentProjectConversationLimit, setRecentProjectConversationLimit] = useState(RECENT_PROJECT_CONVERSATION_INITIAL_LIMIT); const [attachmentPreview, setAttachmentPreview] = useState<AttachmentPreviewState | null>(null); const [recentAskUserAnswerMessageId, setRecentAskUserAnswerMessageId] = useState<string | null>(null); const fileInputRef = useRef<HTMLInputElement>(null); const composerSurfaceRef = useRef<HTMLDivElement>(null); const composerEditorRef = useRef<MarkdownEditorRef>(null); const inlineEditSurfaceRef = useRef<HTMLDivElement>(null); const inlineEditEditorRef = useRef<MarkdownEditorRef>(null); const composerContextMenuRef = useRef<HTMLDivElement>(null); const composerEditorScrollRef = useScrollbarActivityRef(); const skillSearchInputRef = useRef<HTMLInputElement>(null); const stopRequestedChatIdsRef = useRef<Set<string>>(new Set()); const newConversationSendLockRef = useRef(false); const chatSendLocksRef = useRef<Record<string, true>>({}); const lastAppliedPrefillRef = useRef<string | null>(null); const lastAppliedAgentPrefillRef = useRef<string | null>(null); const lastAppliedProjectPrefillRef = useRef<string | null>(null); const draftProjectScopeKeyRef = useRef<string | null>(null); const draftProjectDefaultKeyRef = useRef<string | null>(null); const draftProjectManuallySelectedRef = useRef(false); const chatMessagesScrollElementRef = useRef<HTMLDivElement | null>(null); const initialScrolledConversationRef = useRef<string | null>(null); const { isMobile } = useSidebar(); const chatMessagesActivityRef = useScrollbarActivityRef(); const chatMessagesScrollRef = useCallback((element: HTMLDivElement | null) => { chatMessagesScrollElementRef.current = element; chatMessagesActivityRef(element); }, [chatMessagesActivityRef]); const pendingPrefill = searchParams.get("prefill") ?? ""; const pendingAgentPrefill = searchParams.get("agentId")?.trim() ?? ""; const pendingProjectPrefill = searchParams.get("projectId")?.trim() ?? ""; const pendingIssueId = searchParams.get("issueId")?.trim() ?? ""; const relativePath = toOrganizationRelativePath(location.pathname); const chatRouteBase = relativePath.startsWith("/messenger/chat") ? "/messenger/chat" : "/chat"; const openLocalFile = useCallback((targetPath: string) => { const desktopShell = readDesktopShell();
    if (!desktopShell) {
      pushToast({
        title: "Open from Desktop",
        body: "Local chat file links can only be opened from the Rudder Desktop app.", tone: "warn", });
      return; }
    void desktopShell.openPath(targetPath).catch((error) => {
      pushToast({
        title: "Failed to open file",
        body: error instanceof Error ? error.message : `Could not open ${targetPath}.`, tone: "error", }); }); }, [pushToast]);
  const handleChatMarkdownLinkClick = useCallback<MarkdownLinkClickHandler>(({ event, href }) => { if (!shouldHandlePlainChatLinkClick(event)) return; const targetPath = resolveLocalFileTarget(href); if (!targetPath) return; event.preventDefault(); event.stopPropagation(); openLocalFile(targetPath); return true; }, [openLocalFile]); const chatRootPath = chatRouteBase; const chatConversationPath = useCallback((id: string) => `${chatRouteBase}/${id}`, [chatRouteBase]); const composerContextMenuOpen = projectMenuOpen || agentMenuOpen || skillMenuOpen;
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
    queryKey: queryKeys.chats.list(selectedOrganizationId ?? "__none__", "active"),
    queryFn: () => chatsApi.list(selectedOrganizationId!, "active"), enabled: !!selectedOrganizationId && isMobile, }); const mentionConversationsQuery = useQuery({
    queryKey: queryKeys.chats.list(selectedOrganizationId ?? "__none__", "active"),
    queryFn: () => chatsApi.list(selectedOrganizationId!, "active"), enabled: !!selectedOrganizationId, }); const conversationQuery = useQuery({
    queryKey: queryKeys.chats.detail(conversationId ?? "__none__"),
    queryFn: () => chatsApi.get(conversationId!), enabled: !!conversationId, }); const messagesQuery = useQuery({
    queryKey: queryKeys.chats.messages(conversationId ?? "__none__"),
    queryFn: () => chatsApi.listMessages(conversationId!, { includeTranscript: false }), enabled: !!conversationId, });
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
  const { data: issues, error: issuesError } = useQuery({
    queryKey: queryKeys.issues.list(selectedOrganizationId ?? "__none__"),
    queryFn: () => issuesApi.list(selectedOrganizationId!), enabled: !!selectedOrganizationId, }); const { data: libraryDocuments } = useQuery({
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
    selectedOrganizationId, visibleProjects, draftPreferredAgentId, ]); const selectedConversation = conversationQuery.data ?? conversationsQuery.data?.find((conversation) => conversation.id === conversationId) ?? null; const selectedConversationGenerating = Boolean(selectedConversation && (streamDrafts[selectedConversation.id] || sendInFlightByChatId[selectedConversation.id])); const draftIssueContext = !selectedConversation ? resolveDraftIssueContext(issues, pendingIssueId) : null; const draftIssueContextId = !selectedConversation && pendingIssueId ? draftIssueContext?.id ?? pendingIssueId : null; const activeAgentId = selectedConversation?.preferredAgentId ?? draftPreferredAgentId; const selectedConversationProjectId = projectContextId(selectedConversation);
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
  useEffect(() => { if (!selectedOrganizationId) return; if (!relativePath.startsWith("/messenger/chat")) return; rememberMessengerPath(selectedOrganizationId, relativePath); }, [relativePath, selectedOrganizationId]); const refreshChat = async (chatId?: string | null) => { if (!selectedOrganizationId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(selectedOrganizationId, "active") }),
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(selectedOrganizationId, "all") }), invalidateMessengerThreadSummaryQueries(queryClient, selectedOrganizationId), ]);
    if (chatId) { await queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(chatId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.chats.messages(chatId) }); } await queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedOrganizationId) }); }; const upsertConversation = (conversation: ChatConversation) => { queryClient.setQueryData(queryKeys.chats.detail(conversation.id), conversation);
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
      queryKeys.chats.messages(chatId), (current) => mergeChatMessages(current ?? [], incoming), ); }; const acquireNewConversationSendLock = useCallback(() => { if (newConversationSendLockRef.current) return false; newConversationSendLockRef.current = true; setNewConversationSendInFlight(true); return true; }, []); const releaseNewConversationSendLock = useCallback(() => { if (!newConversationSendLockRef.current) return; newConversationSendLockRef.current = false; setNewConversationSendInFlight(false); }, []); const acquireChatSendLock = useCallback((chatId: string) => { if (chatSendLocksRef.current[chatId]) return false;
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
        queryKeys.chats.messages(chatId),
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
  }, [loadingTranscriptMessageIds, pushToast, queryClient, setProcessOpenForMessage]); const keepProcessOpenForMessages = useCallback((messages: ChatMessage[]) => { const messageIds = messages .filter((message) => { const transcript = (message.transcript ?? []) as TranscriptEntry[];
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
  }, []); const updateConversationMutation = useMutation({
    mutationFn: ({ chatId, data }: { chatId: string; data: Parameters<typeof chatsApi.update>[1] }) =>
      chatsApi.update(chatId, data),
    onSuccess: async (conversation) => {
      if (conversation.status === "archived" && conversation.id === selectedConversation?.id) {
        navigate(chatRootPath); } upsertConversation(conversation); upsertMessengerThreadSummary(conversation);
      await refreshChat(conversation.id); },
    onError: (error) => {
      pushToast({
        title: "Failed to update conversation",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error", }); }, }); const updateConversationUserStateMutation = useMutation({
    mutationFn: ({ chatId, pinned }: { chatId: string; pinned: boolean }) =>
      chatsApi.updateUserState(chatId, { pinned }),
    onSuccess: async (conversation) => {
      upsertConversation(conversation); upsertMessengerThreadSummary(conversation);
      await refreshChat(conversation.id); },
    onError: (error) => {
      pushToast({
        title: "Failed to update conversation",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error", }); }, }); const deleteConversationMutation = useMutation({
    mutationFn: (chatId: string) => chatsApi.remove(chatId),
    onSuccess: async (conversation) => {
      if (conversation.id === selectedConversation?.id) {
        navigate(chatRootPath); }
      await refreshChat(conversation.id); },
    onError: (error) => {
      pushToast({
        title: "Failed to delete conversation",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error", }); }, }); const updateProjectContextMutation = useMutation({
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
    void chatsApi.stopMessageStream(chatId).catch((error) => {
      pushToast({
        title: "Failed to stop streaming",
        body: error instanceof Error ? error.message : "Try again.", tone: "error", }); }); abortChatStream(chatId); setStreamDraftForChat(chatId, (current) => (current ? { ...current, state: "stopped" } : current)); }, [abortChatStream, pushToast, setStreamDraftForChat]); const readComposerDraft = useCallback(
    () => composerEditorRef.current?.getMarkdown?.() ?? draft,
    [draft],
  ); const sendMessage = async (
    options?: { bodyOverride?: string; filesOverride?: File[]; conversationOverride?: ChatConversation;
      editUserMessageIdOverride?: string | null; clearPendingFilesOnSuccess?: boolean; onUserMessageAcknowledged?: () => void; },
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
        navigate(chatConversationPath(conversation.id)); } const chatId = conversation.id; if (!acquireChatSendLock(chatId)) return; chatSendLockAcquired = true; activeChatId = chatId; const selectedAgentId = activeAgentId === NO_CHAT_AGENT_ID ? null : activeAgentId;
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
        editedFromCreatedAt: editTargetMessage ? new Date(editTargetMessage.createdAt) : null,
        body: "",
        state: "streaming",
        createdAt: startedAt,
        transcript: [], replyingAgentId: conversation.chatRuntime.runtimeAgentId ?? conversation.preferredAgentId ?? null, });
      await chatsApi.sendMessageStream(chatId, body, {
        signal: abortController.signal,
        editUserMessageId,
        files: filesToUpload,
        onEvent: async (event) => {
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
                chatTurnId: event.userMessage.chatTurnId ?? null, } : current), );
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
      await refreshChat(chatId); setStreamDraftForChat(chatId, null);
    } catch (error) {
      const isAbort = error instanceof DOMException ? error.name === "AbortError" : error instanceof Error && error.name === "AbortError";
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
    () => computeDisplayedChatMessages(rawMessages, branchPreview), [rawMessages, branchPreview], ); const showMessagesLoading = Boolean(selectedConversation && conversationId && messagesQuery.isPending && messagesQuery.data === undefined); const activeStream = readChatScopedState(streamDrafts, selectedConversation?.id); const activeSendInFlight = readChatScopedFlag(sendInFlightByChatId, selectedConversation?.id); const agentSelectionLocked = isChatAgentSelectionLocked({
    hasConversation: Boolean(selectedConversation),
    preferredAgentId: selectedConversation?.preferredAgentId,
    hasLastMessageAt: Boolean(selectedConversation?.lastMessageAt),
    hasMessages: rawMessages.length > 0,
    hasActiveStream: Boolean(activeStream), hasActiveSendInFlight: activeSendInFlight, }); const projectSelectionLocked = isChatProjectSelectionLocked({
    hasConversation: Boolean(selectedConversation),
    hasLastMessageAt: Boolean(selectedConversation?.lastMessageAt),
    hasMessages: rawMessages.length > 0,
    hasActiveStream: Boolean(activeStream), hasActiveSendInFlight: activeSendInFlight, }); const activeEditCutoffMs = activeStream?.editedFromCreatedAt ? activeStream.editedFromCreatedAt.getTime() : null; const activeStreamFilteredMessages = activeEditCutoffMs === null ? displayedMessages : displayedMessages.filter((message) => new Date(message.createdAt).getTime() < activeEditCutoffMs); const visibleMessages = activeStream ? activeStreamFilteredMessages.filter((message) => shouldShowMessageDuringActiveStream(message, activeStream)) : activeStreamFilteredMessages; const pendingAskUserMessage = useMemo(
    () => findLatestUnansweredAskUserMessage(visibleMessages), [visibleMessages], ); const pendingAskUserRequest = pendingAskUserMessage ? askUserRequestFromMessage(pendingAskUserMessage) : null; const lastMarkedReadKeyRef = useRef<string | null>(null); const optimisticReadBadgeMarkerRef = useRef<string | null>(null);
  useEffect(() => { if (!pendingAskUserRequest) return; closeComposerContextMenus(); }, [closeComposerContextMenus, pendingAskUserRequest]);
  useEffect(() => { const chatId = selectedConversation?.id ?? null; if (!chatId || showMessagesLoading) return; if (initialScrolledConversationRef.current === chatId) return; initialScrolledConversationRef.current = chatId; const frame = requestAnimationFrame(() => { const scrollElement = chatMessagesScrollElementRef.current; if (!scrollElement) return; scrollChatMessagesToBottom(scrollElement); }); return () => cancelAnimationFrame(frame); }, [selectedConversation?.id, showMessagesLoading, visibleMessages.length]);
  useEffect(() => { if (!selectedConversation?.id || !latestIncomingMessageId) return; if (typeof document !== "undefined" && document.visibilityState !== "visible") return; const shouldMarkRead = selectedConversation.isUnread || latestIncomingMessageId !== lastMarkedReadKeyRef.current?.split(":")[1]; if (!shouldMarkRead) return; const nextKey = `${selectedConversation.id}:${latestIncomingMessageId}`; const shouldDecrementSidebarBadge = selectedConversation.isUnread && optimisticReadBadgeMarkerRef.current !== nextKey; if (selectedOrganizationId) {
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
  ]); const showOptimisticUserMessage = Boolean(
    activeStream && (
      activeEditCutoffMs !== null
      || !activeStream.userMessageId || !rawMessages.some((message) => message.id === activeStream.userMessageId) ), );
  useEffect(() => {
    if (agentSelectionLocked) {
      setAgentMenuOpen(false); } }, [agentSelectionLocked]);
  const loadError = conversationsQuery.error ?? conversationQuery.error ?? messagesQuery.error ?? agentsError ?? organizationSkillsError ?? activeAgentSkillsError ?? projectsError ?? issuesError;
  const loadErrorMessage = loadError instanceof Error ? loadError.message : loadError ? "Failed to load chat data." : null; const controlsDisabled = activeSendInFlight || newConversationSendInFlight; const activeSelectedAgentId = activeAgentId === NO_CHAT_AGENT_ID ? null : activeAgentId; const canPersistSelectedAgentForConversation = Boolean( selectedConversation && !selectedConversation.preferredAgentId && activeSelectedAgentId, );
  const composerUnavailable = selectedConversation ? !selectedConversation.chatRuntime.available && !canPersistSelectedAgentForConversation : !activeSelectedAgentId; const composerUnavailableMessage = activeSelectedAgentId ? selectedConversation?.chatRuntime.error ?? "Selected chat agent is unavailable." : "Create or activate an agent before sending messages."; const hasPendingLightweightProposal = rawMessages.some(
    (message) => !message.supersededAt && message.kind === "operation_proposal" && !message.approval && operationProposalStatusFromMessage(message) === "pending", ); const hasActionableApprovals = rawMessages .filter((m) => !m.supersededAt) .some((message) => approvalNeedsAction(message.approval));
  const agentPillLabel =
    activeAgentId === NO_CHAT_AGENT_ID ? (agents ? NO_CHAT_AGENT_LABEL : "Loading agents") : (() => { const activeAgent = (agents ?? []).find((agent) => agent.id === activeAgentId); return activeAgent ? formatChatAgentLabel(activeAgent) : "Unknown agent"; })(); const activeProjectContextLink = selectedConversation?.contextLinks.find((link) => link.entityType === "project") ?? null; const activeProject = activeProjectId === NO_PROJECT_ID ? null : visibleProjects.find((project) => project.id === activeProjectId) ?? null; const projectPillLabel = activeProject ? projectDisplayName(activeProject) : activeProjectId === NO_PROJECT_ID ? "No project" : activeProjectContextLink?.entity?.label ?? "Unknown project"; const allRecentProjectConversations = useMemo(() => {
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
      const target = parsed.kind === "agent"
        ? `/agents/${parsed.agentId}`
        : parsed.kind === "issue"
          ? `/issues/${parsed.ref ?? parsed.issueId}`
          : parsed.kind === "chat"
            ? `/messenger/chat/${parsed.conversationId}`
          : parsed.kind === "library_doc"
            ? `/library?doc=${encodeURIComponent(parsed.documentId)}`
            : parsed.kind === "library_entry"
              ? `/library?entry=${encodeURIComponent(parsed.entryId)}`
              : parsed.kind === "library_file"
                ? `/library?path=${encodeURIComponent(parsed.filePath)}`
                : parsed.kind === "library_directory"
                  ? `/library?directory=${encodeURIComponent(parsed.directoryPath)}`
              : `/projects/${parsed.projectId}`;
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
          if (action !== "requestRevision" || !selectedConversation) return;
          void sendMessage({
            bodyOverride: buildChatProposalRevisionPrompt({
              proposalTitle,
              feedback,
            }),
            filesOverride: [],
            conversationOverride: selectedConversation,
          });
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
  }; const retryFailedMessage = useCallback(
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
      }); }, [pushToast, rawMessages, selectedConversation, sendMessage], ); const editDraftOnly = useCallback((text: string) => { setInlineEditUserMessageId(null); setInlineEditDraft(""); setDraft(text);
    requestAnimationFrame(() => { composerEditorRef.current?.focus(); }); }, []); const toggleEmptyStatePrompt = useCallback((label: EmptyStatePromptLabel) => { setExpandedEmptyStatePrompt((current) => (current === label ? null : label)); }, []); const applyEmptyStateExample = useCallback((example: string) => { setDraft(example); setExpandedEmptyStatePrompt(null);
    requestAnimationFrame(() => { composerEditorRef.current?.focus(); }); }, []); const turnBranchControlsFor = useCallback(
    (message: ChatMessage) => { const tid = message.chatTurnId; if (!tid || message.role !== "user" || message.kind !== "message") return null; const userRows = rawMessages.filter( (m) => m.role === "user" && m.kind === "message" && m.chatTurnId === tid, ); const variants = [...new Set(userRows.map((m) => m.turnVariant))].sort((a, b) => a - b); if (variants.length < 2) return null; const activeRows = userRows.filter((m) => !m.supersededAt);
      const activeVariant = activeRows.length > 0 ? Math.max(...activeRows.map((m) => m.turnVariant)) : variants[variants.length - 1]!;
      const selected = branchPreview?.chatTurnId === tid ? branchPreview.turnVariant : activeVariant; let idx = variants.indexOf(selected); if (idx < 0) idx = variants.length - 1;
      return {
        current: idx + 1,
        total: variants.length,
        canPrev: idx > 0,
        canNext: idx < variants.length - 1,
        onPrev: () => setBranchPreview({ chatTurnId: tid, turnVariant: variants[idx - 1]! }),
        onNext: () => setBranchPreview({ chatTurnId: tid, turnVariant: variants[idx + 1]! }),
      }; }, [rawMessages, branchPreview], ); const userNickname = profileQuery.data?.nickname.trim() ?? ""; const emptyStateProjectName = activeProject ? projectDisplayName(activeProject) : null; const emptyStateHeading = chatEmptyStateHeading({
    activeProjectName: emptyStateProjectName, userNickname, t, }); const emptyStateHeadingKey = emptyStateProjectName ? `project:${activeProject?.id}:${emptyStateProjectName}` : "no-project"; const composerPlaceholder = activePlanMode ? t("chat.composer.planModePlaceholder") : draftIssueContext ? t("chat.composer.issuePlaceholder", { issue: draftIssueContextLabel(draftIssueContext) }) : t("chat.composer.placeholder"); const expandedPromptGroup = EMPTY_STATE_PROMPT_GROUPS.find((group) => group.label === expandedEmptyStatePrompt) ?? null; const emptyStatePromptOptionsId = "chat-empty-state-prompt-options"; const emptyStatePromptOriginX = expandedEmptyStatePrompt === "Scope a new feature" ? "22%" : expandedEmptyStatePrompt === "Clarify a vague request" ? "50%" : expandedEmptyStatePrompt === "Turn a chat into an issue" ? "78%" : "50%";
  const showEmptyStateRecentConversations = draft.trim().length === 0;
  const hasRecentProjectConversations = allRecentProjectConversations.length > 0;
  const sendButtonMode = newConversationSendInFlight || (activeSendInFlight && (!activeStream || !activeStream.userMessageId)) ? "sending" : activeSendInFlight ? "stop" : "send";
  const sendButtonDisabled = composerUnavailable || sendButtonMode === "sending" || (sendButtonMode === "send" && draft.trim().length === 0);
  useEffect(() => {
    if (!expandedEmptyStatePrompt) { setEmptyStatePromptPanelEntered(false);
      return; } setEmptyStatePromptPanelEntered(false); const frame = requestAnimationFrame(() => { setEmptyStatePromptPanelEntered(true); }); return () => cancelAnimationFrame(frame); }, [expandedEmptyStatePrompt]); useEffect(() => {
    if (!showEmptyStateRecentConversations) {
      setRecentProjectConversationLimit(RECENT_PROJECT_CONVERSATION_INITIAL_LIMIT);
    }
  }, [showEmptyStateRecentConversations]); useEffect(() => {
    if (!hasRecentProjectConversations && emptyStateActiveTab !== "recent") {
      setEmptyStateActiveTab("recent");
    }
  }, [emptyStateActiveTab, hasRecentProjectConversations]); const renderComposerContextMenu = () => { if (!composerContextMenuOpen || !composerMenuPosition || typeof document === "undefined") return null; const activeMenu = projectMenuOpen ? "project" : agentMenuOpen ? "agent" : "skill";
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
                  ))} </div> </> )} </> ) : null} </div>, document.body, ); }; const renderComposer = (centered: boolean) => (
    <div ref={composerSurfaceRef} className={cn(
        "chat-composer rounded-[var(--radius-lg)] p-3 transition-all duration-300",
        centered ? "mx-auto w-full max-w-3xl" : "w-full",
      )} >
      <div ref={composerEditorScrollRef} data-testid="chat-composer-editor-scroll" className="chat-composer-editor-scroll scrollbar-auto-hide overflow-y-auto overscroll-contain pr-1" onPasteCapture={handlePendingAttachmentPasteCapture} >
        <MarkdownEditor ref={composerEditorRef} value={draft} onChange={setDraft}
          mentions={mentionOptions}
          onMentionQueryChange={setLibraryFileMentionQuery}
          mentionMenuAnchorRef={composerSurfaceRef}
          mentionMenuPlacement="container"
          submitShortcut="enter"
          onInlineTokenClick={handleComposerInlineTokenClick}
          plainText className="rounded-[var(--radius-md)] bg-transparent"
          contentClassName="min-h-[88px] bg-transparent text-[15px] leading-7 text-foreground"
          bordered={false} placeholder={composerPlaceholder} onSubmit={() => {
            if (!controlsDisabled && !composerUnavailable) {
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
              <DropdownMenuSeparator className="panel-divider" />
              <DropdownMenuItem
                className="rounded-[var(--radius-md)] px-3 py-2.5 text-muted-foreground focus:text-foreground"
                onSelect={() => { setPlusMenuOpen(false); navigate("/organization/settings"); }}
              >
                Open chat settings </DropdownMenuItem> </DropdownMenuContent> </DropdownMenu>
          {activePlanMode ? (
            <button type="button" className="inline-flex max-w-[10rem] min-w-0 items-center gap-1.5 rounded-[var(--radius-md)] bg-[color:color-mix(in_oklab,var(--accent-soft)_78%,var(--surface-elevated))] px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-[color:color-mix(in_oklab,var(--accent-soft)_92%,var(--surface-elevated))] hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40" aria-label="Turn off plan mode" title={PLAN_MODE_HELP_TEXT} onClick={() => applyPlanMode(false)} >
              <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[color:color-mix(in_oklab,var(--ink-muted)_78%,transparent)] text-[color:var(--surface-elevated)]">
                <X className="h-3 w-3" strokeWidth={2.6} /> </span>
              <span className="min-w-0 truncate">Plan</span> </button> ) : null}
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
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => {
            if (sendButtonMode === "stop" && selectedConversation) { stopStreaming(selectedConversation.id);
              return; }
            if (sendButtonMode === "send") {
              void sendMessage(); }
          }} disabled={sendButtonDisabled} aria-busy={sendButtonMode === "sending" ? true : undefined} aria-label={
            sendButtonMode === "sending" ? "Sending" : sendButtonMode === "stop" ? "Stop streaming" : "Send"
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
  const renderEmptyStateUseCases = () => (
    <>
      <div className="flex max-w-3xl flex-wrap justify-center gap-2">
        {EMPTY_STATE_PROMPT_GROUPS.map((group) => { const expanded = expandedEmptyStatePrompt === group.label;
          return (
            <button key={group.label} type="button" aria-expanded={expanded} aria-controls={expanded ? emptyStatePromptOptionsId : undefined} onClick={() => toggleEmptyStatePrompt(group.label)} className={cn(
                "chat-chip inline-flex items-center gap-2 rounded-[calc(var(--radius-sm)+2px)] px-4 py-2 text-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-[color:var(--surface-active)] hover:text-foreground",
                expanded && "bg-[color:var(--surface-active)] text-foreground",
              )} >
              <span>{group.label}</span> <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-200", expanded && "rotate-180")} /> </button> );
        })} </div>
      {expandedPromptGroup ? (
        <ChatEmptyStatePromptOptions
          group={expandedPromptGroup}
          optionsId={emptyStatePromptOptionsId}
          entered={emptyStatePromptPanelEntered}
          originX={emptyStatePromptOriginX} onExampleSelect={applyEmptyStateExample} /> ) : null}
    </>
  );
  return (
    <div className="chat-shell relative flex min-h-[calc(100dvh-8rem)] flex-col overflow-hidden text-foreground md:-mx-3.5 md:h-full md:min-h-0 md:px-0 lg:-mx-5">
      <ChatAttachmentPreviewDialog
        preview={attachmentPreview} onOpenChange={(open) => { if (!open) setAttachmentPreview(null);
        }} />
      <input ref={fileInputRef} type="file" className="hidden"
        multiple onChange={(event) => { const files = Array.from(event.target.files ?? []); void appendPendingFiles(files); event.currentTarget.value = "";
        }} />
      {loadErrorMessage ? (
        <div className="mx-6 mt-6 rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {loadErrorMessage} </div> ) : null}
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {!selectedOrganizationId ? (
            <div className="flex flex-1 items-center justify-center px-6 py-12 text-sm text-muted-foreground">
              Select a organization first. </div> ) : selectedConversation ? ( <>
              <div className="pointer-events-none absolute right-3 top-12 z-20 flex justify-end md:right-3 md:top-2">
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
                    <DropdownMenuItem
                      onClick={() => updateConversationUserStateMutation.mutate({
                        chatId: selectedConversation.id,
                        pinned: !selectedConversation.isPinned,
                      })}
                    >
                      {selectedConversation.isPinned ? (
                        <>
                          <PinOff className="h-4 w-4" />
                          Unpin Chat
                        </>
                      ) : (
                        <>
                          <Pin className="h-4 w-4" />
                          Pin Chat
                        </>
                      )}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={selectedConversationGenerating}
                      onClick={async () => {
                        const confirmed = await confirm({
                          title: "Delete chat",
                          description: `Delete "${conversationDisplayTitle(selectedConversation)}"? This cannot be undone.`,
                          confirmLabel: "Delete",
                          tone: "destructive",
                        });
                        if (!confirmed) return;
                        deleteConversationMutation.mutate(selectedConversation.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => updateConversationMutation.mutate({
                        chatId: selectedConversation.id,
                        data: { status: "archived" },
                      })}
                    >
                      <Archive className="h-4 w-4" />
                      Archive
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
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
                          <DropdownMenuItem key={c.id} className={cn(c.id === selectedConversation.id && "bg-[color:var(--surface-active)]")} onClick={() => { void prefetchChatConversation(queryClient, c.id); navigate(chatConversationPath(c.id));
                            }} onPointerDown={() => {
                              if (c.id !== selectedConversation.id) {
                                void prefetchChatConversation(queryClient, c.id); }
                            }} onMouseEnter={() => {
                              if (c.id !== selectedConversation.id) {
                                void prefetchChatConversation(queryClient, c.id); }
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
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-4 md:px-5">
                <div ref={chatMessagesScrollRef} data-testid="chat-messages-scroll-region" className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto" >
                  <div data-testid="chat-messages-content" className="mx-auto flex w-full max-w-4xl flex-col gap-5 pr-1" >
                      {showMessagesLoading ? (
                        <ChatMessagesLoadingState /> ) : visibleMessages.length === 0 && !activeStream ? (
                        <div className="surface-inset rounded-[var(--radius-xl)] border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
                          No messages yet. Start by describing the work and Rudder will clarify it first. </div> ) : ( <>
                          {visibleMessages.map((message) => { const persistedTranscript = (loadedTranscriptsByMessageId[message.id] ?? message.transcript ?? []) as TranscriptEntry[];
                            const messageCanShowProcess = message.role === "assistant"
                              || message.kind === "issue_proposal" || message.kind === "operation_proposal";
                            const shouldRenderPersistedTranscript =
                              persistedTranscript.length > 0 && messageCanShowProcess; const shouldRenderLazyTranscript = persistedTranscript.length === 0 && messageCanShowProcess && Boolean(message.transcriptSummary?.entryCount); const persistedProcessStartedAt = shouldRenderPersistedTranscript ? resolvePersistedChatProcessStartedAt(visibleMessages, message, persistedTranscript) : null; const persistedProcessEndedAt = shouldRenderPersistedTranscript ? resolvePersistedChatProcessEndedAt(message, persistedTranscript) : null;
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
                                    || operationProposalMutation.isPending }
                                  decisionNote={decisionNotesByMessageId[message.id] ?? ""} onDecisionNoteChange={(value) => setDecisionNoteForMessage(message.id, value)} onApprovalAction={handleProposalApprovalAction} onResolveOperationProposal={handleOperationProposalDecision} onConvertToIssue={(messageToConvert) =>
                                    convertToIssueMutation.mutate({
                                      chatId: selectedConversation.id,
                                      message: messageToConvert,
                                      proposalOverride: issueProposalOverridesByMessageId[messageToConvert.id], })
                                  } onCopyMessageText={copyChatMessageText} onEditUserMessage={beginEditUserMessage} onContinueInterruptedMessage={() => {
                                    void sendMessage({
                                      bodyOverride: INTERRUPTED_CHAT_CONTINUATION_PROMPT,
                                      filesOverride: [], conversationOverride: selectedConversation, });
                                  }} onRetryFailedMessage={retryFailedMessage} onOpenImage={setAttachmentPreview} onOpenFile={openLocalFile} onMarkdownLinkClick={handleChatMarkdownLinkClick}
                                  turnBranchControls={turnBranchControlsFor(message)}
                                  skillReferences={chatSkillReferences}
                                  inlineEdit={inlineEditUserMessageId === message.id ? {
                                    draft: inlineEditDraft,
                                    disabled: controlsDisabled || composerUnavailable,
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
                          {activeStream ? ( <>
                              {showOptimisticUserMessage ? (
                                <OptimisticUserDraftItem
                                  body={activeStream.userBody}
                                  createdAt={activeStream.userCreatedAt} onCopyMessageText={copyChatMessageText} onEditDraftOnly={editDraftOnly}
                                  skillReferences={chatSkillReferences} onMarkdownLinkClick={handleChatMarkdownLinkClick}
                                  askUserAnswer={
                                    pendingAskUserRequest ? parseAskUserAnswerMessage(pendingAskUserRequest, activeStream.userBody) : null
                                  }
                                  animateAskUserAnswer={activeStream.userBody.startsWith(ASK_USER_ANSWER_PREFIX)} /> ) : null}
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
                      )} </div> </div>
                {hasActionableApprovals || hasPendingLightweightProposal ? null : (
                  <div className="mx-auto w-full max-w-4xl shrink-0 space-y-4">
                    {pendingAskUserMessage && pendingAskUserRequest ? (
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
                    )} </div>
                )} </div> </> ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-8">
              <div className="mx-auto flex w-full max-w-4xl flex-col items-center justify-center">
                <div className="mb-5 w-full max-w-3xl px-1 text-center">
                  <h1 key={emptyStateHeadingKey} className="motion-chat-empty-heading max-w-full text-[2rem] leading-[1.1] tracking-normal text-foreground [overflow-wrap:anywhere] md:text-[2.3rem]" >
                    {emptyStateHeading} </h1> </div>
                <div className="w-full max-w-3xl">
                  {renderComposer(true)} </div>
                {hasRecentProjectConversations && showEmptyStateRecentConversations ? (
                  <Tabs value={emptyStateActiveTab} onValueChange={(value) => setEmptyStateActiveTab(value as "recent" | "use-cases")} className="mt-4 w-full max-w-3xl gap-2" data-testid="chat-empty-state-tabs">
                    <TabsList variant="line" aria-label="New chat empty state" className="h-auto gap-2 border-transparent bg-transparent px-0">
                      <TabsTrigger value="recent" id="chat-empty-state-tab-recent" data-testid="chat-empty-state-tab-recent" className="h-9 flex-none rounded-full border border-transparent px-4 text-sm data-[state=active]:!border-[color:var(--border-soft)] data-[state=active]:!bg-[color:var(--surface-active)] data-[state=active]:shadow-none after:hidden">
                        <span>Chats</span>
                      </TabsTrigger>
                      <TabsTrigger value="use-cases" id="chat-empty-state-tab-use-cases" data-testid="chat-empty-state-tab-use-cases" className="h-9 flex-none rounded-full border border-transparent px-4 text-sm data-[state=active]:!border-[color:var(--border-soft)] data-[state=active]:!bg-[color:var(--surface-active)] data-[state=active]:shadow-none after:hidden">
                        <span>Use cases</span>
                      </TabsTrigger>
                    </TabsList>
                    <TabsContent value="recent" id="chat-empty-state-recent-panel" aria-labelledby="chat-empty-state-tab-recent" className="mt-0">
                      <ChatEmptyStateRecentConversations
                        key={activeProject ? `project:${activeProject.id}` : "no-project"}
                        className="!mt-0"
                        conversations={recentProjectConversations}
                        projectName={activeProject ? projectDisplayName(activeProject) : null}
                        visible={showEmptyStateRecentConversations}
                        conversationPath={chatConversationPath}
                        onPrefetchConversation={(conversationId) => void prefetchChatConversation(queryClient, conversationId)}
                        hasMoreConversations={hasMoreRecentProjectConversations}
                        onLoadMoreConversations={loadMoreRecentProjectConversations}
                      />
                    </TabsContent>
                    <TabsContent value="use-cases" id="chat-empty-state-use-cases-panel" aria-labelledby="chat-empty-state-tab-use-cases" className="mt-0 flex flex-col items-center">
                      {renderEmptyStateUseCases()}
                    </TabsContent>
                  </Tabs>
                ) : !hasRecentProjectConversations && showEmptyStateRecentConversations ? (
                  <div className="mt-4 flex w-full flex-col items-center">
                    {renderEmptyStateUseCases()}
                  </div>
                ) : null} </div> </div> )} </main> </div> ); }
