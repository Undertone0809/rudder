import { agentsApi } from "@/api/agents";
import { approvalsApi } from "@/api/approvals";
import { chatsApi } from "@/api/chats";
import { ApiError } from "@/api/client";
import type { HealthStatus } from "@/api/health";
import { organizationSkillsApi } from "@/api/organizationSkills";
import { organizationsApi } from "@/api/orgs";
import type { MarkdownLinkClickHandler } from "@/components/MarkdownBody";
import type { MarkdownSkillReferencePreview } from "@/components/SkillReferenceToken";
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
import {
  DraftResponseAnnotationsPopover,
  ResponseAnnotationEditor,
} from "@/components/chat/ResponseAnnotations";
import {
  ChatGenerationCloseSupersededError,
  useChatGenerationActions,
  useChatGenerations,
} from "@/context/ChatGenerationContext";
import { useOptionalSidePanel } from "@/context/SidePanelContext";
import { useToast } from "@/context/ToastContext";
import { formatChatAgentLabel } from "@/lib/agent-labels";
import { selectableChatAgents } from "@/lib/chat-agent-selection";
import { blockStaleAnnotationSubmission } from "@/lib/chat-annotation-runtime";
import { chatErrorMessage } from "@/lib/chat-errors";
import {
  canSubmitChatResponseAnnotations,
  createChatResponseAnnotationState,
  responseAnnotationReducer,
  serializeChatResponseAnnotations,
  validateChatResponseAnnotationReplacement,
} from "@/lib/chat-response-annotations";
import { preparePendingChatSendMutation } from "@/lib/chat-send-mutation-storage";
import {
  buildChatSkillOptions,
  buildChatSkillReferenceOptions,
  filterChatSkillOptions,
} from "@/lib/chat-skill-options";
import { resolveLocalFileTarget } from "@/lib/local-file-targets";
import { appendSkillReferencesToDraft } from "@/lib/organization-skill-picker";
import { queryKeys } from "@/lib/queryKeys";
import { latestSideChatAnchor, sideChatConversationMessages, sideChatIsReadOnly } from "@/lib/side-chat";
import {
  sideChatGenerationScopeKey,
  sidePanelTargetKey,
  type SidePanelTarget,
} from "@/lib/side-panel-targets";
import { PendingAttachmentPreview } from "@/pages/Chat.attachments";
import {
  ChatComposerFileDropOverlay,
  useChatComposerFileDrop,
  useChatComposerPasteAttachments,
} from "@/pages/Chat.file-drop";
import {
  AskUserPanel,
} from "@/pages/Chat.messages";
import {
  ChatAgentMenuContent,
  ChatAgentSelectorButton,
  chatRuntimeSelectionLabel,
  handleChatAgentMenuKeyDown,
  useChatRuntimeSelection,
  type ChatRuntimeOverrides,
} from "@/pages/Chat.model-selector";
import type { ApprovalAction } from "@/pages/Chat.parts";
import {
  askUserRequestFromMessage,
  chatSidePanelTargetFromHref,
  composerMenuPositionForAnchor,
  findLatestUnansweredAskUserMessage,
  materializePendingAttachment,
  mergeChatMessages,
  pendingAttachmentKey,
  shouldHandlePlainChatLinkClick,
} from "@/pages/Chat.parts";
import { ChatPlanModeChip, ChatPlanModeMenuToggle } from "@/pages/Chat.plan-mode-controls";
import { EMPTY_CHAT_BODY_SHA256, applyChatStreamProgressEvent } from "@/pages/Chat.workspace-helpers";
import type {
  Agent,
  ChatAskUserResponse,
  ChatConversation,
  ChatInlineAnnotation,
  ChatMessage,
  ChatOperationProposalDecisionAction,
} from "@rudderhq/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { SideChatPanelMessages } from "./SideChatPanelMessages";

type SideChatTarget = Extract<SidePanelTarget, { kind: "side_chat" }>;

function expiryLabel(expiresAt: Date | string | null | undefined, now: Date) {
  if (!expiresAt) return null;
  const remaining = new Date(expiresAt).getTime() - now.getTime();
  if (remaining <= 0) return "Expired · read-only";
  const minutes = Math.max(1, Math.ceil(remaining / 60_000));
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m left`;
}

function noop() {}

function isCopiedSideChatSourceMessage(message: ChatMessage) {
  const source = message.structuredPayload?.sideChatSource;
  return Boolean(source && typeof source === "object" && !Array.isArray(source));
}

async function waitForSideChatGenerationTerminal(
  organizationId: string,
  conversationId: string,
  generationId: string | null,
) {
  if (!generationId) return true;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const queue = await chatsApi.listQueue(conversationId);
    if (queue.activeGenerationId !== generationId && queue.activeGenerationId === null) {
      // Confirm the projected message is no longer streaming before allowing a
      // close to remove the conversation row.
      const messages = await chatsApi.listMessages(organizationId, conversationId, { includeTranscript: false });
      const generationMessage = messages.find((message) => message.generationId === generationId);
      if (!generationMessage || generationMessage.status !== "streaming") return true;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 200));
  }
  return false;
}

export function SideChatPanelView({
  organizationId,
  target,
  active = true,
  onRegisterCloseHandler,
  onReplaceTarget,
  onSelectResponseAnnotation,
}: {
  organizationId: string;
  target: SideChatTarget;
  active?: boolean;
  onRegisterCloseHandler: (clientMutationId: string, handler: (() => Promise<string | null>) | null) => void;
  onReplaceTarget: (key: string, target: SidePanelTarget) => void;
  onSelectResponseAnnotation: (annotation: ChatInlineAnnotation, ordinal: number) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const sidePanel = useOptionalSidePanel();
  const sidePanelContextKey = sidePanel?.contextKey ?? null;
  const openTargetForContext = sidePanel?.openTargetForContext;
  const { sendInFlightByChatId, streamDrafts } = useChatGenerations();
  const {
    clearChatGenerationConversation,
    clearChatGenerationProviderState,
    destroyChatGenerationConversation,
    getChatGenerationEpoch,
    isChatGenerationClosePending,
    isChatGenerationCurrent,
    rememberChatGenerationConversation,
    requestChatGenerationClose,
    releaseChatGenerationScope,
    resetChatGenerationClose,
    setChatGenerationConversation,
    setChatSendInFlight,
    setStreamAbortController,
    setStreamDraftForChat,
    tryBeginChatGeneration,
  } = useChatGenerationActions();
  const streamScopeKey = sideChatGenerationScopeKey(organizationId, target);
  const stream = streamDrafts[streamScopeKey] ?? null;
  const sending = Boolean(sendInFlightByChatId[streamScopeKey]);
  const [draft, setDraft] = useState("");
  const [draftPlanMode, setDraftPlanMode] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [stopPending, setStopPending] = useState(false);
  const [decisionNotesByMessageId, setDecisionNotesByMessageId] = useState<Record<string, string>>({});
  const [pendingActionKey, setPendingActionKey] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [draftPreferredAgentId, setDraftPreferredAgentId] = useState<string | null>(null);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [composerMenuPosition, setComposerMenuPosition] = useState<CSSProperties | null>(null);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [skillSearchQuery, setSkillSearchQuery] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [annotationState, dispatchAnnotation] = useReducer(
    responseAnnotationReducer,
    target.inlineAnnotations ?? [],
    createChatResponseAnnotationState,
  );
  const [annotationsExpanded, setAnnotationsExpanded] = useState(false);
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const editingAnnotationAnchorRef = useRef<HTMLButtonElement | null>(null);
  const annotationDetailsChipRef = useRef<HTMLButtonElement | null>(null);
  const composerSurfaceRef = useRef<HTMLDivElement | null>(null);
  const composerContextMenuRef = useRef<HTMLDivElement | null>(null);
  const skillSearchInputRef = useRef<HTMLInputElement | null>(null);
  const skillButtonRef = useRef<HTMLButtonElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const draftAgentInitializedRef = useRef(false);
  const conversationIdRef = useRef(target.conversationId);
  const conversationScopeKeyRef = useRef(streamScopeKey);
  const retryUserMessageIdRef = useRef<string | null>(null);
  const stopRequestedStreamKeyRef = useRef<string | null>(null);
  const stopRequestTokenRef = useRef(0);
  const planModeMutationTokenRef = useRef(0);
  const activeStopRequestRef = useRef<{
    token: number;
    streamKey: string | null;
  } | null>(null);
  if (conversationScopeKeyRef.current !== streamScopeKey) {
    conversationScopeKeyRef.current = streamScopeKey;
    conversationIdRef.current = target.conversationId;
    retryUserMessageIdRef.current = null;
  } else {
    conversationIdRef.current = target.conversationId ?? conversationIdRef.current;
  }

  const clearProviderOwnedGeneration = useCallback((
    epoch: number,
    streamKey?: string | null,
  ) => {
    const cleared = clearChatGenerationProviderState(streamScopeKey, epoch, streamKey);
    if (cleared) retryUserMessageIdRef.current = null;
    return cleared;
  }, [
    clearChatGenerationProviderState,
    streamScopeKey,
  ]);

  const stopSideChatGeneration = useCallback(async ({
    conversationId,
    draft: draftToStop,
    clearLocalState = true,
    generationEpoch: generationEpochOverride,
  }: {
    conversationId: string | null | undefined;
    draft: typeof stream;
    clearLocalState?: boolean;
    generationEpoch?: number | null;
  }) => {
    if (!conversationId) return true;
    const streamKey = draftToStop?.streamKey ?? null;
    const generationEpoch = generationEpochOverride
      ?? draftToStop?.generationEpoch
      ?? getChatGenerationEpoch(streamScopeKey);
    const stopToken = ++stopRequestTokenRef.current;
    activeStopRequestRef.current = { token: stopToken, streamKey };
    if (streamKey) {
      stopRequestedStreamKeyRef.current = streamKey;
      setStreamDraftForChat(streamScopeKey, (current) => (
        current?.streamKey === streamKey ? { ...current, state: "stopping" } : current
      ));
    }
    setStopPending(true);
    try {
      const queue = await chatsApi.listQueue(conversationId);
      const generationFence = queue.activeGenerationId
        && queue.activeAttemptEpoch !== null
        && queue.activeAttemptEpoch !== undefined
        && queue.activeControlVersion !== null
        && queue.activeControlVersion !== undefined
        ? {
            expectedGenerationId: queue.activeGenerationId,
            expectedAttemptEpoch: queue.activeAttemptEpoch,
            expectedControlVersion: queue.activeControlVersion,
          }
        : null;
      const result = await chatsApi.stopMessageStream(conversationId, {
        controlActionId: globalThis.crypto.randomUUID(),
        ...(generationFence ?? {}),
        ...(draftToStop ? {
          lastCommittedRenderSeq: draftToStop.lastCommittedRenderSeq ?? 0,
          renderedBodyHash: draftToStop.renderedBodyHash ?? EMPTY_CHAT_BODY_SHA256,
        } : {}),
      });
      const terminal = await waitForSideChatGenerationTerminal(
        organizationId,
        conversationId,
        result.generationId ?? draftToStop?.generationId ?? null,
      );
      if (!terminal) throw new Error("Side Chat runtime did not reach a terminal state before timeout.");
      if (clearLocalState && generationEpoch !== null && generationEpoch !== undefined) {
        const cleared = clearProviderOwnedGeneration(generationEpoch, streamKey);
        if (cleared) {
          releaseChatGenerationScope(streamScopeKey, generationEpoch);
          await Promise.allSettled([
            queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(organizationId, conversationId) }),
            queryClient.invalidateQueries({ queryKey: queryKeys.chats.messages(organizationId, conversationId) }),
          ]);
        }
      }
      return true;
    } catch (error) {
      const ownsStopRequest = activeStopRequestRef.current?.token === stopToken;
      if (ownsStopRequest && streamKey) {
        setStreamDraftForChat(streamScopeKey, (current) => (
          current?.streamKey === streamKey && current.state === "stopping"
            ? { ...current, state: "streaming" }
            : current
        ));
      }
      throw error;
    } finally {
      if (activeStopRequestRef.current?.token === stopToken) {
        activeStopRequestRef.current = null;
        if (stopRequestedStreamKeyRef.current === streamKey) {
          stopRequestedStreamKeyRef.current = null;
        }
        setStopPending(false);
      }
    }
  }, [
    clearProviderOwnedGeneration,
    getChatGenerationEpoch,
    organizationId,
    queryClient,
    releaseChatGenerationScope,
    setStreamDraftForChat,
    streamScopeKey,
  ]);

  useEffect(() => {
    if (target.conversationId) {
      rememberChatGenerationConversation(streamScopeKey, target.conversationId);
    }
  }, [rememberChatGenerationConversation, streamScopeKey, target.conversationId]);

  const destroyForClose = useCallback(async () => {
    const activeGenerationEpoch = getChatGenerationEpoch(streamScopeKey);
    const activeStreamKey = stream?.streamKey ?? null;
    const close = requestChatGenerationClose(streamScopeKey, conversationIdRef.current);
    const conversationId = close.conversationId;
    if (!conversationId) {
      if (!isChatGenerationClosePending(streamScopeKey, close.epoch)) {
        throw new ChatGenerationCloseSupersededError();
      }
      clearProviderOwnedGeneration(close.epoch, activeStreamKey);
      releaseChatGenerationScope(streamScopeKey, close.epoch);
      return null;
    }
    try {
      if (stream || sending) {
        const terminal = await stopSideChatGeneration({
          conversationId,
          draft: stream,
          clearLocalState: false,
          generationEpoch: activeGenerationEpoch,
        });
        if (!terminal) throw new Error("Side Chat could not confirm runtime termination before close.");
      }
      if (!isChatGenerationClosePending(streamScopeKey, close.epoch)) {
        throw new ChatGenerationCloseSupersededError();
      }
      await destroyChatGenerationConversation(
        streamScopeKey,
        conversationId,
        async () => {
          await chatsApi.destroySideChat(conversationId);
        },
      );
    } catch (error) {
      if (!isChatGenerationClosePending(streamScopeKey, close.epoch)) {
        throw new ChatGenerationCloseSupersededError();
      }
      if (error instanceof ApiError && error.status === 404) {
        clearProviderOwnedGeneration(close.epoch, activeStreamKey);
        clearChatGenerationConversation(streamScopeKey, conversationId);
        releaseChatGenerationScope(streamScopeKey, close.epoch);
        // Let the parent reconcile the tab and query cache using its existing 404/409 path.
        throw error;
      }
      if (error instanceof ApiError && error.status === 409) {
        // An active-generation conflict is retryable. Keep close requested and
        // preserve the provider-owned state so the next close can stop it.
        throw error;
      }
      clearProviderOwnedGeneration(close.epoch, activeStreamKey);
      resetChatGenerationClose(streamScopeKey, close.epoch);
      throw error;
    }
    if (!isChatGenerationClosePending(streamScopeKey, close.epoch)) {
      throw new ChatGenerationCloseSupersededError();
    }
    clearChatGenerationConversation(streamScopeKey, conversationId);
    if (!clearProviderOwnedGeneration(close.epoch, activeStreamKey)) {
      throw new ChatGenerationCloseSupersededError();
    }
    releaseChatGenerationScope(streamScopeKey, close.epoch);
    return conversationId;
  }, [
    clearChatGenerationConversation,
    clearProviderOwnedGeneration,
    destroyChatGenerationConversation,
    getChatGenerationEpoch,
    isChatGenerationClosePending,
    releaseChatGenerationScope,
    requestChatGenerationClose,
    resetChatGenerationClose,
    streamScopeKey,
    stopSideChatGeneration,
    stream,
    sending,
  ]);

  useEffect(() => {
    onRegisterCloseHandler(streamScopeKey, destroyForClose);
    return () => onRegisterCloseHandler(streamScopeKey, null);
  }, [destroyForClose, onRegisterCloseHandler, streamScopeKey]);

  useEffect(() => {
    const streamActive = stream !== null;
    if (!active && !streamActive) return undefined;
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, stream !== null]);

  const sourceConversationQuery = useQuery({
    queryKey: queryKeys.chats.detail(organizationId, target.sourceConversationId),
    queryFn: () => chatsApi.get(target.sourceConversationId),
  });
  const sourceMessagesQuery = useQuery({
    queryKey: queryKeys.chats.messages(organizationId, target.sourceConversationId),
    queryFn: () => chatsApi.listMessages(organizationId, target.sourceConversationId),
    enabled: !target.sourceMessageId || !target.sourcePreview,
  });
  const sourceMessages = sourceMessagesQuery.data ?? [];
  const resolvedAnchor = useMemo(() => {
    if (target.sourceMessageId) {
      return sourceMessages.find((message) => message.id === target.sourceMessageId) ?? null;
    }
    return latestSideChatAnchor(sourceMessages);
  }, [sourceMessages, target.sourceMessageId]);
  const sourceMessageId = target.sourceMessageId ?? resolvedAnchor?.id ?? null;
  const sourcePreview = target.sourcePreview ?? resolvedAnchor?.body ?? null;

  const conversationQuery = useQuery({
    queryKey: queryKeys.chats.detail(organizationId, target.conversationId ?? "__side-chat-draft__"),
    queryFn: () => chatsApi.get(target.conversationId!),
    enabled: Boolean(target.conversationId),
  });
  const messagesQuery = useQuery({
    queryKey: queryKeys.chats.messages(organizationId, target.conversationId ?? "__side-chat-draft__"),
    queryFn: () => chatsApi.listMessages(
      organizationId,
      target.conversationId!,
      { includeTranscript: false },
    ),
    enabled: Boolean(target.conversationId),
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(organizationId),
    queryFn: () => agentsApi.list(organizationId),
  });
  const organizationQuery = useQuery({
    queryKey: queryKeys.organizations.detail(organizationId),
    queryFn: () => organizationsApi.get(organizationId),
  });
  const organizationSkillsQuery = useQuery({
    queryKey: queryKeys.organizationSkills.list(organizationId),
    queryFn: () => organizationSkillsApi.list(organizationId),
  });

  const conversation = conversationQuery.data ?? null;
  const displayConversation = conversation ?? sourceConversationQuery.data ?? null;
  const liveAgents = useMemo(
    () => selectableChatAgents(agentsQuery.data),
    [agentsQuery.data],
  );
  useEffect(() => {
    if (conversation || draftAgentInitializedRef.current || !sourceConversationQuery.data) return;
    const sourceAgentId = sourceConversationQuery.data.preferredAgentId;
    const selectedAgent = liveAgents.find((agent) => agent.id === sourceAgentId) ?? liveAgents[0] ?? null;
    setDraftPreferredAgentId(selectedAgent?.id ?? null);
    draftAgentInitializedRef.current = true;
  }, [conversation, liveAgents, sourceConversationQuery.data]);
  const selectedAgentId = conversation?.preferredAgentId
    ?? draftPreferredAgentId
    ?? sourceConversationQuery.data?.preferredAgentId
    ?? null;
  const selectedAgent = selectedAgentId
    ? liveAgents.find((agent) => agent.id === selectedAgentId) ?? null
    : null;
  const agentSkillsQuery = useQuery({
    queryKey: queryKeys.agents.skills(selectedAgentId ?? "__none__"),
    queryFn: () => agentsApi.skills(selectedAgentId!, organizationId),
    enabled: Boolean(selectedAgentId),
  });
  const availableChatSkills = useMemo(
    () => buildChatSkillOptions({
      agent: selectedAgent,
      orgUrlKey: organizationQuery.data?.urlKey ?? "organization",
      organizationSkills: organizationSkillsQuery.data,
      skillSnapshot: agentSkillsQuery.data,
    }),
    [
      agentSkillsQuery.data,
      organizationQuery.data?.urlKey,
      organizationSkillsQuery.data,
      selectedAgent,
    ],
  );
  const chatSkillReferences = useMemo<MarkdownSkillReferencePreview[]>(
    () => buildChatSkillReferenceOptions({
      agent: selectedAgent,
      orgUrlKey: organizationQuery.data?.urlKey ?? "organization",
      organizationSkills: organizationSkillsQuery.data,
      skillSnapshot: agentSkillsQuery.data,
    }).map((skill) => ({
      href: skill.skillMarkdownTarget,
      label: skill.skillRefLabel,
      displayName: skill.skillDisplayName,
      description: skill.skillDescription,
      categoryLabel: skill.skillCategoryLabel,
      locationLabel: skill.skillLocationLabel,
      detailsHref: skill.skillDetailsHref,
      openHref: skill.skillOpenHref,
    })),
    [
      agentSkillsQuery.data,
      organizationQuery.data?.urlKey,
      organizationSkillsQuery.data,
      selectedAgent,
    ],
  );
  const filteredChatSkills = useMemo(
    () => filterChatSkillOptions(availableChatSkills, skillSearchQuery),
    [availableChatSkills, skillSearchQuery],
  );
  const {
    activeRuntimeOverrides,
    adapterModelsQuery,
    runtimeModelSelectRef,
    runtimeSelectorRef,
    setDraftRuntimeOverrides,
  } = useChatRuntimeSelection({
    selectedOrganizationId: organizationId,
    selectedConversation: conversation,
    activeAgentId: selectedAgentId,
    activeAgent: selectedAgent,
    composerScopeKey: target.clientMutationId,
  });
  const messages = sideChatConversationMessages(messagesQuery.data ?? []);
  const authoritativeTerminalMessage = stream?.generationId
    ? messages.find((message) => (
        message.role === "assistant"
        && message.generationId === stream.generationId
        && message.status !== "streaming"
      )) ?? null
    : null;
  const displayedStream = authoritativeTerminalMessage ? null : stream;
  const visibleMessages = displayedStream?.generationId
    ? messages.filter((message) => (
        message.role !== "assistant"
        || message.generationId !== displayedStream.generationId
      ))
    : messages;
  const showOptimisticUserMessage = Boolean(
    displayedStream && (
      !displayedStream.userMessageId
      || !messages.some((message) => message.id === displayedStream.userMessageId)
    )
  );
  const readOnly = sideChatIsReadOnly(conversation, now);
  const stateLabel = readOnly
    ? "Expired · read-only"
    : expiryLabel(conversation?.sideChatExpiresAt, now);
  const isMessageMutationAllowed = useCallback((messageId: string) => {
    if (readOnly) return false;
    const message = visibleMessages.find((candidate) => candidate.id === messageId);
    return !message || !isCopiedSideChatSourceMessage(message);
  }, [readOnly, visibleMessages]);
  const setConversationCache = (updated: ChatConversation) => {
    queryClient.setQueryData(queryKeys.chats.detail(organizationId, updated.id), updated);
  };
  const activePlanMode = conversation?.planMode ?? draftPlanMode;
  const applyPlanMode = (value: boolean) => {
    const conversationId = conversation?.id ?? target.conversationId;
    if (value === activePlanMode) return;
    const previousConversation = conversation;
    const previousPlanMode = activePlanMode;
    const mutationToken = ++planModeMutationTokenRef.current;
    setDraftPlanMode(value);
    if (!conversationId) return;
    if (previousConversation) {
      setConversationCache({ ...previousConversation, planMode: value });
    }
    void chatsApi.update(conversationId, { planMode: value }).then((updated) => {
      if (planModeMutationTokenRef.current !== mutationToken) return;
      setConversationCache(updated);
      setDraftPlanMode(updated.planMode);
    }).catch((error: unknown) => {
      if (planModeMutationTokenRef.current !== mutationToken) return;
      setDraftPlanMode(previousPlanMode);
      if (previousConversation) setConversationCache(previousConversation);
      setSendError(error instanceof Error ? error.message : "Failed to update Plan Mode.");
    });
  };
  const openSideChatFile = useCallback((targetPath: string, label: string) => {
    openTargetForContext?.(sidePanelContextKey, {
      kind: "local_file",
      filePath: targetPath,
      label,
    });
  }, [openTargetForContext, sidePanelContextKey]);
  const handleMarkdownLinkClick = useCallback<MarkdownLinkClickHandler>(({
    event,
    href,
    label,
    sourceHref,
  }) => {
    if (!shouldHandlePlainChatLinkClick(event) || !openTargetForContext) return;
    const organizationSkills = organizationSkillsQuery.data;
    const sidePanelTarget = (sourceHref
      ? chatSidePanelTargetFromHref(sourceHref, label, organizationSkills)
      : null)
      ?? chatSidePanelTargetFromHref(href, label, organizationSkills);
    const localFilePath = sidePanelTarget ? null : resolveLocalFileTarget(href, label);
    const targetToOpen = sidePanelTarget ?? (localFilePath
      ? {
          kind: "local_file" as const,
          filePath: localFilePath,
          label: label.trim() || localFilePath.split(/[\\/]/u).at(-1) || localFilePath,
        }
      : null);
    if (!targetToOpen) return;
    event.preventDefault();
    event.stopPropagation();
    openTargetForContext(sidePanelContextKey, targetToOpen);
    return true;
  }, [
    openTargetForContext,
    organizationSkillsQuery.data,
    sidePanelContextKey,
  ]);
  const applyRuntimeOverrides = (overrides: ChatRuntimeOverrides) => {
    if (!selectedAgent) return;
    setDraftRuntimeOverrides(overrides);
  };
  const applyPreferredAgent = (agentId: string) => {
    if (conversation || agentId === selectedAgentId) return;
    if (!liveAgents.some((agent) => agent.id === agentId)) return;
    setDraftRuntimeOverrides({ modelOverride: null, effortOverride: null });
    setDraftPreferredAgentId(agentId);
    setSkillMenuOpen(false);
    setSkillSearchQuery("");
  };

  const appendPendingFiles = useCallback(async (incomingFiles: Iterable<File>) => {
    const files = Array.from(incomingFiles).filter((file) => file.size > 0);
    if (files.length === 0) return;
    try {
      const safeFiles = await Promise.all(
        files.map((file, index) => materializePendingAttachment(file, index)),
      );
      setPendingFiles((current) => [...current, ...safeFiles]);
      setSendError(null);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Could not stage this attachment.");
    }
  }, []);
  const handlePendingAttachmentPasteCapture = useChatComposerPasteAttachments(
    appendPendingFiles,
  );
  const {
    active: composerFileDragActive,
    targetProps: composerFileDropTargetProps,
  } = useChatComposerFileDrop(appendPendingFiles);
  const insertSkillReference = (entry: (typeof availableChatSkills)[number]) => {
    if (!entry.skillRefLabel || !entry.skillMarkdownTarget) return;
    setDraft((current) => appendSkillReferencesToDraft(
      current,
      [`[${entry.skillRefLabel}](${entry.skillMarkdownTarget})`],
    ));
    setSkillMenuOpen(false);
    setSkillSearchQuery("");
  };

  const upsertMessage = (conversationId: string, message: ChatMessage) => {
    queryClient.setQueryData<ChatMessage[]>(
      queryKeys.chats.messages(organizationId, conversationId),
      (current = []) => mergeChatMessages(current, [message]),
    );
  };

  const pendingAskUserMessage = useMemo(
    () => findLatestUnansweredAskUserMessage(visibleMessages),
    [visibleMessages],
  );
  const pendingAskUserRequest = pendingAskUserMessage
    ? askUserRequestFromMessage(pendingAskUserMessage)
    : null;

  const refreshSideChat = useCallback(async (conversationId: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(organizationId, conversationId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.messages(organizationId, conversationId) }),
    ]);
  }, [organizationId, queryClient]);

  const handleApprovalAction = useCallback(async (
    approvalId: string,
    action: ApprovalAction,
    messageId: string,
    payloadOverride?: Record<string, unknown>,
  ) => {
    const conversationId = conversationIdRef.current;
    if (!conversationId || !isMessageMutationAllowed(messageId)) return;
    const actionKey = `approval:${messageId}:${action}`;
    if (pendingActionKey) return;
    setPendingActionKey(actionKey);
    const note = decisionNotesByMessageId[messageId]?.trim() || undefined;
    try {
      if (action === "approve") await approvalsApi.approve(approvalId, note, payloadOverride);
      else if (action === "reject") await approvalsApi.reject(approvalId, note);
      else await approvalsApi.requestRevision(approvalId, note);
      setDecisionNotesByMessageId((current) => {
        if (!(messageId in current)) return current;
        const { [messageId]: _removed, ...rest } = current;
        return rest;
      });
      await refreshSideChat(conversationId);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Failed to apply approval action.");
    } finally {
      setPendingActionKey(null);
    }
  }, [
    decisionNotesByMessageId,
    isMessageMutationAllowed,
    pendingActionKey,
    refreshSideChat,
  ]);

  const handleOperationProposal = useCallback(async (
    messageId: string,
    action: ChatOperationProposalDecisionAction,
    decisionNote: string,
  ) => {
    const conversationId = conversationIdRef.current;
    if (!conversationId || pendingActionKey || !isMessageMutationAllowed(messageId)) return;
    setPendingActionKey(`operation:${messageId}:${action}`);
    try {
      await chatsApi.resolveOperationProposal(conversationId, messageId, {
        action,
        decisionNote: decisionNote.trim() || undefined,
      });
      await refreshSideChat(conversationId);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Failed to resolve operation proposal.");
    } finally {
      setPendingActionKey(null);
    }
  }, [isMessageMutationAllowed, pendingActionKey, refreshSideChat]);

  const handleConvertToIssue = useCallback(async (message: ChatMessage) => {
    const conversationId = conversationIdRef.current;
    if (
      !conversationId
      || pendingActionKey
      || readOnly
      || isCopiedSideChatSourceMessage(message)
    ) return;
    setPendingActionKey(`convert:${message.id}`);
    try {
      await chatsApi.convertToIssue(conversationId, { messageId: message.id });
      await refreshSideChat(conversationId);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Failed to create issue.");
    } finally {
      setPendingActionKey(null);
    }
  }, [pendingActionKey, readOnly, refreshSideChat]);

  const handleSend = async (
    bodyOverride?: string,
    filesOverride?: File[],
  ) => {
    const body = (bodyOverride ?? draft).trim();
    const filesForSend = filesOverride ?? pendingFiles;
    if (
      (filesForSend.length === 0 && !canSubmitChatResponseAnnotations(body, annotationState))
      || sending
      || isChatGenerationClosePending(streamScopeKey)
      || readOnly
      || !sourceMessageId
    ) return;
    const regularFiles = [...filesForSend];
    const serializedAnnotations = serializeChatResponseAnnotations(annotationState, {
      fileIndexOffset: regularFiles.length,
    });
    if (blockStaleAnnotationSubmission({
      annotations: serializedAnnotations.inlineAnnotations,
      devServer: queryClient.getQueryData<HealthStatus>(queryKeys.health)?.devServer,
      draftPersistence: "memory",
      pushToast,
    })) return;
    const createdAt = new Date();
    const retryUserMessageId = retryUserMessageIdRef.current;
    const retrySourceDraft = stream?.state === "failed" ? stream : null;
    const generation = tryBeginChatGeneration(streamScopeKey, target.conversationId);
    if (!generation) return;
    retryUserMessageIdRef.current = null;
    const generationEpoch = generation.epoch;
    const streamKey = `${streamScopeKey}:${createdAt.getTime()}:${Math.random().toString(36).slice(2)}`;
    let acknowledged = false;
    let receivedAckEvent = false;
    let acknowledgedUserMessageId: string | null = retryUserMessageId;
    let receivedFinal = false;
    let settleClientMutation = () => {};
    setChatSendInFlight(streamScopeKey, true);
    setSendError(null);
    setDraft("");
    setStreamDraftForChat(streamScopeKey, {
      chatId: generation.conversationId,
      streamKey,
      generationEpoch,
      clientMutationId: null,
      userBody: body,
      userFiles: regularFiles,
      userCreatedAt: createdAt,
      userMessageId: retryUserMessageId,
      chatTurnId: retrySourceDraft?.chatTurnId ?? null,
      turnVariant: retrySourceDraft?.turnVariant ?? 0,
      editedFromCreatedAt: retrySourceDraft?.userCreatedAt ?? null,
      body: "",
      generationId: null,
      attemptEpoch: null,
      lastCommittedRenderSeq: 0,
      renderedBodyHash: EMPTY_CHAT_BODY_SHA256,
      state: "streaming",
      createdAt,
      transcript: [],
      replyingAgentId: selectedAgentId,
    });
    let conversationId = generation.conversationId;
    const destroyCreatedConversation = async (createdConversationId: string) => {
      await destroyChatGenerationConversation(
        streamScopeKey,
        createdConversationId,
        async () => {
          await chatsApi.destroySideChat(createdConversationId);
        },
      );
      clearChatGenerationConversation(streamScopeKey, createdConversationId);
    };
    try {
      if (!conversationId) {
        let created = await chatsApi.createSideChat(target.sourceConversationId, {
          sourceMessageId,
          clientMutationId: target.clientMutationId,
          preferredAgentId: selectedAgentId ?? undefined,
        });
        if (created.planMode !== draftPlanMode) {
          try {
            created = await chatsApi.update(created.id, { planMode: draftPlanMode });
          } catch (error) {
            await chatsApi.destroySideChat(created.id).catch(() => undefined);
            throw error;
          }
        }
        if (
          !setChatGenerationConversation(streamScopeKey, generationEpoch, created.id)
          || !isChatGenerationCurrent(streamScopeKey, generationEpoch)
        ) {
          await destroyCreatedConversation(created.id);
          return;
        }
        conversationId = created.id;
        conversationIdRef.current = created.id;
        setConversationCache(created);
        queryClient.setQueryData(queryKeys.chats.messages(organizationId, created.id), []);
        onReplaceTarget(sidePanelTargetKey(target), {
          ...target,
          sourceMessageId,
          sourcePreview,
          conversationId: created.id,
        });
      }
      if (!conversationId || !isChatGenerationCurrent(streamScopeKey, generationEpoch)) {
        if (conversationId) await destroyCreatedConversation(conversationId);
        return;
      }
      const preparedMutation = preparePendingChatSendMutation({
        orgId: organizationId,
        conversationId,
        editUserMessageId: retryUserMessageId,
        body,
        files: [...regularFiles, ...serializedAnnotations.files],
        inlineAnnotations: serializedAnnotations.inlineAnnotations,
        modelOverride: activeRuntimeOverrides.modelOverride,
        effortOverride: activeRuntimeOverrides.effortOverride,
      });
      settleClientMutation = preparedMutation.settle;
      const clientMutationId = preparedMutation.clientMutationId;
      setStreamDraftForChat(streamScopeKey, (current) => current?.streamKey === streamKey
        ? { ...current, clientMutationId }
        : current);
      const abortController = new AbortController();
      setStreamAbortController(streamScopeKey, abortController);
      await chatsApi.sendMessageStream(conversationId, body, {
        signal: abortController.signal,
        clientMutationId,
        editUserMessageId: retryUserMessageId,
        modelOverride: activeRuntimeOverrides.modelOverride,
        effortOverride: activeRuntimeOverrides.effortOverride,
        files: [...regularFiles, ...serializedAnnotations.files],
        inlineAnnotations: serializedAnnotations.inlineAnnotations,
        onEvent: async (event) => {
          if (!isChatGenerationCurrent(streamScopeKey, generationEpoch)) return;
          if (event.type === "ack") {
            acknowledged = true;
            settleClientMutation();
            setDraftRuntimeOverrides({ modelOverride: null, effortOverride: null });
            receivedAckEvent = true;
            acknowledgedUserMessageId = event.userMessage.id;
            retryUserMessageIdRef.current = null;
            upsertMessage(conversationId!, event.userMessage);
            setStreamDraftForChat(streamScopeKey, (current) => current?.streamKey === streamKey ? {
              ...current,
              chatId: conversationId,
              generationId: event.generationId ?? current.generationId,
              userBody: event.userMessage.body,
              userCreatedAt: new Date(event.userMessage.createdAt),
              userMessageId: event.userMessage.id,
              chatTurnId: event.userMessage.chatTurnId ?? current.chatTurnId,
              turnVariant: event.userMessage.turnVariant ?? current.turnVariant,
              attemptEpoch: event.attemptEpoch ?? current.attemptEpoch ?? null,
              lastCommittedRenderSeq: event.generationSeq ?? current.lastCommittedRenderSeq ?? 0,
              renderedBodyHash: event.bodyHash ?? current.renderedBodyHash ?? EMPTY_CHAT_BODY_SHA256,
            } : current);
            dispatchAnnotation({ type: "clear" });
            setPendingFiles([]);
            setAnnotationsExpanded(false);
            setEditingAnnotationId(null);
            onReplaceTarget(
              sidePanelTargetKey({ ...target, conversationId }),
              {
                ...target,
                sourceMessageId,
                sourcePreview,
                conversationId,
                inlineAnnotations: [],
              },
            );
          }
          if (event.type === "assistant_delta" || event.type === "assistant_state" || event.type === "transcript_entry") {
            setStreamDraftForChat(
              streamScopeKey,
              (current) => applyChatStreamProgressEvent(current, streamKey, event),
            );
          }
          if (event.type === "final") {
            receivedFinal = true;
            retryUserMessageIdRef.current = null;
            for (const message of event.messages) upsertMessage(conversationId!, message);
            setStreamDraftForChat(
              streamScopeKey,
              (current) => current?.streamKey === streamKey ? null : current,
            );
          }
          if (event.type === "error") {
            if (!acknowledged && event.messageId) {
              acknowledged = true;
              acknowledgedUserMessageId = event.messageId;
              dispatchAnnotation({ type: "clear" });
              setPendingFiles([]);
              setAnnotationsExpanded(false);
              setEditingAnnotationId(null);
              onReplaceTarget(
                sidePanelTargetKey({ ...target, conversationId }),
                {
                  ...target,
                  sourceMessageId,
                  sourcePreview,
                  conversationId,
                  inlineAnnotations: [],
                },
              );
            }
            throw new Error(event.error);
          }
        },
      });
      if (!receivedFinal) {
        throw new Error("Side Chat stream ended before a final response.");
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(organizationId, conversationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.chats.messages(organizationId, conversationId) }),
      ]);
    } catch (error) {
      if (!isChatGenerationCurrent(streamScopeKey, generationEpoch)) return;
      if (stopRequestedStreamKeyRef.current === streamKey) {
        setStreamDraftForChat(
          streamScopeKey,
          (current) => current?.streamKey === streamKey ? null : current,
        );
        return;
      }
      if (!acknowledged) {
        retryUserMessageIdRef.current = retryUserMessageId;
        setDraft((current) => current || body);
      } else if (receivedAckEvent && conversationId) {
        retryUserMessageIdRef.current = acknowledgedUserMessageId;
        setDraft((current) => current || body);
      } else {
        retryUserMessageIdRef.current = acknowledgedUserMessageId;
      }
      if (acknowledged && conversationId) {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: queryKeys.chats.detail(organizationId, conversationId),
          }),
          queryClient.invalidateQueries({
            queryKey: queryKeys.chats.messages(organizationId, conversationId),
          }),
        ]).catch(() => undefined);
      }
      setStreamDraftForChat(
        streamScopeKey,
        (current) => current?.streamKey === streamKey ? { ...current, state: "failed" } : current,
      );
      setSendError(chatErrorMessage(error, "side-chat"));
    } finally {
      if (isChatGenerationCurrent(streamScopeKey, generationEpoch)) {
        setStreamAbortController(streamScopeKey, null);
        setChatSendInFlight(streamScopeKey, false);
        releaseChatGenerationScope(streamScopeKey, generationEpoch);
      }
      if (stopRequestedStreamKeyRef.current === streamKey) {
        stopRequestedStreamKeyRef.current = null;
      }
    }
  };

  const anchorLoading = (!target.sourceMessageId || !target.sourcePreview) && sourceMessagesQuery.isPending;
  const noAnchor = !anchorLoading && !sourceMessageId;
  const agents = agentsQuery.data as Agent[] | undefined;
  const runtimeLabel = chatRuntimeSelectionLabel({
    agent: selectedAgent,
    runtime: conversation?.chatRuntime ?? null,
    overrides: activeRuntimeOverrides,
    adapterModels: adapterModelsQuery.data,
  });
  const agentLabel = selectedAgent
    ? formatChatAgentLabel(selectedAgent)
    : agentsQuery.isPending
      ? "Loading agents"
      : "No agent";
  const composerContextMenuOpen = agentMenuOpen || skillMenuOpen;
  const closeComposerContextMenus = useCallback(() => {
    setAgentMenuOpen(false);
    setSkillMenuOpen(false);
    setSkillSearchQuery("");
  }, []);
  useEffect(() => {
    if (active) return;
    closeComposerContextMenus();
    setComposerMenuPosition(null);
  }, [active, closeComposerContextMenus]);
  const openComposerContextMenu = useCallback((kind: "agent" | "skill") => {
    const anchor = kind === "agent"
      ? runtimeSelectorRef.current ?? composerSurfaceRef.current
      : composerSurfaceRef.current;
    if (anchor) setComposerMenuPosition(composerMenuPositionForAnchor(anchor));
    setAgentMenuOpen(kind === "agent");
    setSkillMenuOpen(kind === "skill");
    if (kind !== "skill") setSkillSearchQuery("");
  }, [runtimeSelectorRef]);

  useEffect(() => {
    if (!composerContextMenuOpen) {
      setComposerMenuPosition(null);
      return;
    }
    const updatePosition = () => {
      const anchor = agentMenuOpen
        ? runtimeSelectorRef.current ?? composerSurfaceRef.current
        : composerSurfaceRef.current;
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
  }, [agentMenuOpen, composerContextMenuOpen, runtimeSelectorRef]);

  useEffect(() => {
    if (!composerContextMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const node = event.target;
      if (!(node instanceof Node)) return;
      if (node instanceof Element && node.closest("[data-chat-runtime-submenu]")) return;
      if (composerContextMenuRef.current?.contains(node)) return;
      if (runtimeSelectorRef.current?.contains(node)) return;
      closeComposerContextMenus();
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const restoreRuntimeFocus = agentMenuOpen;
      const restoreSkillsFocus = skillMenuOpen;
      closeComposerContextMenus();
      if (restoreRuntimeFocus) {
        requestAnimationFrame(() => runtimeSelectorRef.current?.focus());
      } else if (restoreSkillsFocus) {
        requestAnimationFrame(() => skillButtonRef.current?.focus());
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    agentMenuOpen,
    closeComposerContextMenus,
    composerContextMenuOpen,
    runtimeSelectorRef,
    skillMenuOpen,
  ]);
  useEffect(() => {
    if (!agentMenuOpen) return;
    requestAnimationFrame(() => {
      composerContextMenuRef.current
        ?.querySelector<HTMLButtonElement>("[data-chat-composer-menu-item]")
        ?.focus();
    });
  }, [agentMenuOpen]);
  useEffect(() => {
    if (!skillMenuOpen) return;
    requestAnimationFrame(() => skillSearchInputRef.current?.focus());
  }, [skillMenuOpen]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="side-chat-panel-view">
      <div className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
          {stateLabel ? (
            <div className="flex justify-end">
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground" data-testid="side-chat-state">
                <Clock3 className="h-3 w-3" />
                {stateLabel}
              </span>
            </div>
          ) : null}
          {conversation?.runtimeContinuity === "context_handoff" ? (
            <p className="text-xs text-muted-foreground" data-testid="side-chat-context-handoff">
              Context was handed off from the source conversation; this Side Chat now continues independently.
            </p>
          ) : null}
          {noAnchor ? (
            <p className="text-sm text-destructive">The main chat needs a completed assistant response first.</p>
          ) : null}

          <SideChatPanelMessages
            conversation={displayConversation}
            transcriptConversationId={target.conversationId}
            messages={visibleMessages}
            stream={displayedStream}
            showOptimisticUserMessage={showOptimisticUserMessage}
            agents={agents}
            decisionNotesByMessageId={decisionNotesByMessageId}
            isMessageMutationAllowed={isMessageMutationAllowed}
            actionPending={Boolean(pendingActionKey)}
            onDecisionNoteChange={(messageId, value) => {
              setDecisionNotesByMessageId((current) => ({ ...current, [messageId]: value }));
            }}
            onApprovalAction={handleApprovalAction}
            onResolveOperationProposal={handleOperationProposal}
            onConvertToIssue={handleConvertToIssue}
            onCopyMessageText={(text) => navigator.clipboard?.writeText(text)}
            onEditDraftOnly={setDraft}
            onOpenFile={openSideChatFile}
            onMarkdownLinkClick={handleMarkdownLinkClick}
            onSelectResponseAnnotation={onSelectResponseAnnotation}
            skillReferences={chatSkillReferences}
          />
        </div>
      </div>

      {sendError ? <div role="alert" className="px-4 pb-2 text-sm text-destructive">{sendError}</div> : null}

      {!readOnly ? (
        <div className="shrink-0 px-4 pb-4" data-testid="side-chat-composer">
          {pendingAskUserMessage && pendingAskUserRequest ? (
            <AskUserPanel
              message={pendingAskUserMessage}
              request={pendingAskUserRequest}
              disabled={sending || stopPending || pendingActionKey !== null}
              pendingFiles={pendingFiles}
              onAddAttachment={() => fileInputRef.current?.click()}
              onDropAttachments={appendPendingFiles}
              onRemovePendingFile={(fileKey) => setPendingFiles((current) => (
                current.filter((file) => pendingAttachmentKey(file) !== fileKey)
              ))}
              onPasteAttachment={handlePendingAttachmentPasteCapture}
              onSubmit={(body) => void handleSend(body, pendingFiles)}
              onStructuredSubmit={(inputResponse: ChatAskUserResponse) => {
                const approvalId = pendingAskUserMessage.approval?.id ?? pendingAskUserMessage.approvalId;
                if (!approvalId) {
                  setSendError("This input request is no longer available.");
                  return;
                }
                void handleApprovalAction(
                  approvalId,
                  "approve",
                  pendingAskUserMessage.id,
                  { inputResponse },
                );
              }}
            />
          ) : null}
          {pendingAskUserMessage && pendingAskUserRequest ? null : <ChatComposerSurface
            ref={composerSurfaceRef}
            fileDragActive={composerFileDragActive}
            fileDropTargetProps={composerFileDropTargetProps}
            className="mx-auto max-w-4xl"
            testId="side-chat-composer-file-drop-target"
          >
            {composerFileDragActive ? <ChatComposerFileDropOverlay /> : null}
            {annotationState.annotations.length > 0 ? (
              <div
                className="mb-3 flex flex-col items-start gap-2"
              >
                <DraftResponseAnnotationsPopover
                  annotations={annotationState.annotations}
                  pendingFilesByAnnotationId={annotationState.pendingFilesByAnnotationId}
                  open={annotationsExpanded}
                  buttonRef={annotationDetailsChipRef}
                  onOpenChange={(open) => {
                    setAnnotationsExpanded(open);
                    if (open) setEditingAnnotationId(null);
                  }}
                  onClear={() => {
                    dispatchAnnotation({ type: "clear" });
                    setAnnotationsExpanded(false);
                    setEditingAnnotationId(null);
                  }}
                  onEdit={(annotation) => {
                    editingAnnotationAnchorRef.current = annotationDetailsChipRef.current;
                    setEditingAnnotationId(annotation.id);
                  }}
                  onDelete={(annotationId) => {
                    dispatchAnnotation({ type: "delete", id: annotationId });
                    if (annotationState.annotations.length === 1) {
                      setAnnotationsExpanded(false);
                    }
                    setEditingAnnotationId((current) => (
                      current === annotationId ? null : current
                    ));
                  }}
                />
                {editingAnnotationId ? (() => {
                  const annotation = annotationState.annotations.find(
                    (candidate) => candidate.id === editingAnnotationId,
                  );
                  if (!annotation) return null;
                  const editorAnchor = editingAnnotationAnchorRef.current;
                  const editorBoundary = editorAnchor?.closest<HTMLElement>(
                    '[data-testid="side-chat-panel-view"]',
                  ) ?? null;
                  return (
                    <ResponseAnnotationEditor
                      annotation={annotation}
                      ordinal={annotation.ordinal}
                      pendingFiles={annotationState.pendingFilesByAnnotationId[annotation.id] ?? []}
                      showSelectedTextContext
                      anchorRect={editorAnchor?.getBoundingClientRect() ?? null}
                      getAnchorRect={() => (
                        editorAnchor?.isConnected ? editorAnchor.getBoundingClientRect() : null
                      )}
                      boundaryRect={editorBoundary?.getBoundingClientRect() ?? null}
                      getBoundaryRect={() => (
                        editorBoundary?.isConnected ? editorBoundary.getBoundingClientRect() : null
                      )}
                      returnFocusRef={editingAnnotationAnchorRef}
                      validateSave={(changes) => validateChatResponseAnnotationReplacement(
                        annotationState,
                        annotation.id,
                        {
                          comment: changes.comment,
                          attachmentIds: changes.attachmentIds,
                          files: changes.pendingFiles,
                        },
                      )}
                      onSave={({ comment, pendingFiles, attachmentIds }) => {
                        dispatchAnnotation({
                          type: "replaceDraft",
                          id: annotation.id,
                          comment,
                          attachmentIds,
                          files: pendingFiles,
                        });
                        setEditingAnnotationId(null);
                      }}
                      onCancel={() => setEditingAnnotationId(null)}
                      onDelete={() => {
                        dispatchAnnotation({ type: "delete", id: annotation.id });
                        setEditingAnnotationId(null);
                      }}
                    />
                  );
                })() : null}
              </div>
            ) : null}
            {pendingFiles.length > 0 ? (
              <div data-testid="side-chat-pending-attachments" className="mb-2.5 flex flex-wrap gap-2 px-3">
                {pendingFiles.map((file) => {
                  const fileKey = pendingAttachmentKey(file);
                  return (
                    <div key={fileKey} data-testid="side-chat-pending-attachment" className="max-w-full">
                      <PendingAttachmentPreview
                        file={file}
                        onRemove={() => setPendingFiles((current) => (
                          current.filter((candidate) => pendingAttachmentKey(candidate) !== fileKey)
                        ))}
                      />
                    </div>
                  );
                })}
              </div>
            ) : null}
                  <ChatComposerEditor
              value={draft}
              onChange={setDraft}
              onPasteCapture={handlePendingAttachmentPasteCapture}
              scrollTestId="side-chat-composer-editor-scroll"
              placeholder={activePlanMode ? "Plan a focused follow-up…" : "Ask a focused follow-up…"}
              onSubmit={() => void handleSend()}
            />
            <ChatComposerToolbar
              testId="side-chat-composer-toolbar"
              actions={(
                <ChatComposerSendButton
                  mode={stopPending
                    ? "stopping"
                    : sending && conversationIdRef.current
                      ? "stop"
                      : sending
                        ? "sending"
                        : "send"}
                  ariaLabel={stopPending
                    ? "Stopping Side Chat response"
                    : sending && conversationIdRef.current
                      ? "Stop Side Chat response"
                      : sending
                        ? "Sending Side Chat message"
                        : "Send Side Chat message"}
                  disabled={
                    (!sending && (pendingFiles.length === 0
                      && !canSubmitChatResponseAnnotations(draft, annotationState)))
                    || stopPending
                    || !selectedAgentId
                    || noAnchor
                  }
                  onClick={() => {
                    if (sending && conversationIdRef.current) {
                      void stopSideChatGeneration({
                        conversationId: conversationIdRef.current,
                        draft: stream,
                      }).catch((error) => {
                        setSendError(error instanceof Error ? error.message : "Failed to stop Side Chat response.");
                      });
                      return;
                    }
                    void handleSend();
                  }}
                />
              )}
            >
                <ChatComposerAddMenu
                  open={plusMenuOpen}
                  onOpenChange={setPlusMenuOpen}
                  onAddFiles={() => fileInputRef.current?.click()}
                >
                  <ChatPlanModeMenuToggle
                    active={activePlanMode}
                    onChange={applyPlanMode}
                  />
                </ChatComposerAddMenu>
                {activePlanMode ? (
                  <ChatPlanModeChip onDisable={() => applyPlanMode(false)} />
                ) : null}
                <ChatAgentSelectorButton
                  buttonRef={runtimeSelectorRef}
                  agent={selectedAgent}
                  label={agentLabel}
                  expanded={agentMenuOpen}
                  disabled={agentsQuery.isPending}
                  onClick={() => {
                    if (agentMenuOpen) {
                      closeComposerContextMenus();
                      return;
                    }
                    openComposerContextMenu("agent");
                  }}
                />
                <ChatComposerSkillsButton
                  open={skillMenuOpen}
                  buttonRef={skillButtonRef}
                  onClick={() => {
                    if (skillMenuOpen) {
                      closeComposerContextMenus();
                      return;
                    }
                    openComposerContextMenu("skill");
                  }}
                />
            </ChatComposerToolbar>
          </ChatComposerSurface>}
          {composerContextMenuOpen && composerMenuPosition && typeof document !== "undefined" ? createPortal(
            <ChatComposerContextMenu
              menuRef={composerContextMenuRef}
              testId={agentMenuOpen ? "side-chat-agent-menu" : "side-chat-skill-menu"}
              ariaLabel={agentMenuOpen ? "Side Chat agent" : "Side Chat skills"}
              position={composerMenuPosition}
              onKeyDown={agentMenuOpen ? handleChatAgentMenuKeyDown : undefined}
            >
              {agentMenuOpen ? (
                <ChatAgentMenuContent
                  agents={liveAgents}
                  activeAgentId={selectedAgentId ?? ""}
                  agentSelectionLocked={Boolean(conversation)}
                  runtimeSelectionPending={false}
                  newConversationSendInFlight={sending && !conversation}
                  externalBound={false}
                  adapterModels={adapterModelsQuery.data}
                  overrides={activeRuntimeOverrides}
                  runtimeLabel={runtimeLabel}
                  isLoading={adapterModelsQuery.isPending}
                  error={adapterModelsQuery.error}
                  runtimePanelPlacement="above"
                  modelSelectRef={runtimeModelSelectRef}
                  onSelectAgent={applyPreferredAgent}
                  onChangeRuntime={applyRuntimeOverrides}
                />
              ) : null}
              {skillMenuOpen ? (
                <ChatComposerSkillsMenuContent
                  pending={agentSkillsQuery.isPending || organizationSkillsQuery.isPending}
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
          ) : null}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              void appendPendingFiles(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
            }}
          />
        </div>
      ) : (
        <div className="shrink-0 border-t border-[color:var(--border-soft)] px-4 py-3 text-sm text-muted-foreground" data-testid="side-chat-read-only">
          This Side Chat has expired and can no longer be edited. Close the tab to destroy it.
        </div>
      )}
    </div>
  );
}
