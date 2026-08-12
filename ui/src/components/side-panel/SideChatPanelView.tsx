import type { TranscriptEntry } from "@/agent-runtimes";
import { agentsApi } from "@/api/agents";
import { chatsApi } from "@/api/chats";
import { ApiError } from "@/api/client";
import type { HealthStatus } from "@/api/health";
import { organizationSkillsApi } from "@/api/organizationSkills";
import { organizationsApi } from "@/api/orgs";
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
import { useToast } from "@/context/ToastContext";
import { formatChatAgentLabel } from "@/lib/agent-labels";
import { selectableChatAgents } from "@/lib/chat-agent-selection";
import { blockStaleAnnotationSubmission } from "@/lib/chat-annotation-runtime";
import {
  canSubmitChatResponseAnnotations,
  createChatResponseAnnotationState,
  responseAnnotationReducer,
  serializeChatResponseAnnotations,
  validateChatResponseAnnotationReplacement,
} from "@/lib/chat-response-annotations";
import { buildChatSkillOptions, filterChatSkillOptions } from "@/lib/chat-skill-options";
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
  AssistantDraftItem,
  ChatMessageItem,
  OptimisticUserDraftItem,
  StreamTranscriptItem,
} from "@/pages/Chat.messages";
import {
  ChatAgentMenuContent,
  ChatAgentSelectorButton,
  chatRuntimeSelectionLabel,
  handleChatAgentMenuKeyDown,
  useChatRuntimeSelection,
  type ChatRuntimeOverrides,
} from "@/pages/Chat.model-selector";
import {
  composerMenuPositionForAnchor,
  materializePendingAttachment,
  mergeChatMessages,
  pendingAttachmentKey,
} from "@/pages/Chat.parts";
import { EMPTY_CHAT_BODY_SHA256, applyChatStreamProgressEvent } from "@/pages/Chat.workspace-helpers";
import type {
  Agent,
  ChatConversation,
  ChatInlineAnnotation,
  ChatMessage,
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

type SideChatTarget = Extract<SidePanelTarget, { kind: "side_chat" }>;

const EMPTY_SKILL_REFERENCES: MarkdownSkillReferencePreview[] = [];

function expiryLabel(expiresAt: Date | string | null | undefined, now: Date) {
  if (!expiresAt) return null;
  const remaining = new Date(expiresAt).getTime() - now.getTime();
  if (remaining <= 0) return "Expired · read-only";
  const minutes = Math.max(1, Math.ceil(remaining / 60_000));
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m left`;
}

function transcriptEntries(message: ChatMessage) {
  return (message.transcript ?? []) as TranscriptEntry[];
}

function noop() {}

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
  const { sendInFlightByChatId, streamDrafts } = useChatGenerations();
  const {
    abortChatStream,
    clearChatGenerationConversation,
    destroyChatGenerationConversation,
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
  const [sendError, setSendError] = useState<string | null>(null);
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
  if (conversationScopeKeyRef.current !== streamScopeKey) {
    conversationScopeKeyRef.current = streamScopeKey;
    conversationIdRef.current = target.conversationId;
    retryUserMessageIdRef.current = null;
  } else {
    conversationIdRef.current = target.conversationId ?? conversationIdRef.current;
  }

  const clearProviderOwnedGeneration = useCallback(() => {
    retryUserMessageIdRef.current = null;
    setStreamAbortController(streamScopeKey, null);
    setChatSendInFlight(streamScopeKey, false);
    setStreamDraftForChat(streamScopeKey, null);
  }, [
    setChatSendInFlight,
    setStreamAbortController,
    setStreamDraftForChat,
    streamScopeKey,
  ]);

  useEffect(() => {
    if (target.conversationId) {
      rememberChatGenerationConversation(streamScopeKey, target.conversationId);
    }
  }, [rememberChatGenerationConversation, streamScopeKey, target.conversationId]);

  const destroyForClose = useCallback(async () => {
    const close = requestChatGenerationClose(streamScopeKey, conversationIdRef.current);
    abortChatStream(streamScopeKey);
    const conversationId = close.conversationId;
    if (!conversationId) {
      if (!isChatGenerationClosePending(streamScopeKey, close.epoch)) {
        throw new ChatGenerationCloseSupersededError();
      }
      clearProviderOwnedGeneration();
      releaseChatGenerationScope(streamScopeKey, close.epoch);
      return null;
    }
    try {
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
      clearProviderOwnedGeneration();
      if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
        clearChatGenerationConversation(streamScopeKey, conversationId);
        releaseChatGenerationScope(streamScopeKey, close.epoch);
        // Let the parent reconcile the tab and query cache using its existing 404/409 path.
        throw error;
      }
      resetChatGenerationClose(streamScopeKey, close.epoch);
      throw error;
    }
    if (!isChatGenerationClosePending(streamScopeKey, close.epoch)) {
      throw new ChatGenerationCloseSupersededError();
    }
    clearChatGenerationConversation(streamScopeKey, conversationId);
    clearProviderOwnedGeneration();
    releaseChatGenerationScope(streamScopeKey, close.epoch);
    return conversationId;
  }, [
    abortChatStream,
    clearChatGenerationConversation,
    clearProviderOwnedGeneration,
    destroyChatGenerationConversation,
    isChatGenerationClosePending,
    releaseChatGenerationScope,
    requestChatGenerationClose,
    resetChatGenerationClose,
    streamScopeKey,
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
      { includeTranscript: true },
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
  const setConversationCache = (updated: ChatConversation) => {
    queryClient.setQueryData(queryKeys.chats.detail(organizationId, updated.id), updated);
  };
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

  const handleSend = async () => {
    const body = draft.trim();
    if (
      (pendingFiles.length === 0 && !canSubmitChatResponseAnnotations(body, annotationState))
      || sending
      || isChatGenerationClosePending(streamScopeKey)
      || readOnly
      || !sourceMessageId
    ) return;
    const regularFiles = [...pendingFiles];
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
    setChatSendInFlight(streamScopeKey, true);
    setSendError(null);
    setDraft("");
    setStreamDraftForChat(streamScopeKey, {
      chatId: generation.conversationId,
      streamKey,
      userBody: body,
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
        const created = await chatsApi.createSideChat(target.sourceConversationId, {
          sourceMessageId,
          clientMutationId: target.clientMutationId,
          preferredAgentId: selectedAgentId ?? undefined,
        });
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
      const abortController = new AbortController();
      setStreamAbortController(streamScopeKey, abortController);
      await chatsApi.sendMessageStream(conversationId, body, {
        signal: abortController.signal,
        editUserMessageId: retryUserMessageId,
        modelOverride: activeRuntimeOverrides.modelOverride,
        effortOverride: activeRuntimeOverrides.effortOverride,
        files: [...regularFiles, ...serializedAnnotations.files],
        inlineAnnotations: serializedAnnotations.inlineAnnotations,
        onEvent: async (event) => {
          if (!isChatGenerationCurrent(streamScopeKey, generationEpoch)) return;
          if (event.type === "ack") {
            acknowledged = true;
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
      setSendError(error instanceof Error ? error.message : "Could not send this message.");
    } finally {
      if (isChatGenerationCurrent(streamScopeKey, generationEpoch)) {
        setStreamAbortController(streamScopeKey, null);
        setChatSendInFlight(streamScopeKey, false);
        releaseChatGenerationScope(streamScopeKey, generationEpoch);
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
          {noAnchor ? (
            <p className="text-sm text-destructive">The main chat needs a completed assistant response first.</p>
          ) : null}

          <div className="flex min-h-[12rem] flex-col gap-5" data-testid="side-chat-messages">
            {displayConversation ? visibleMessages.map((message) => {
              const transcript = transcriptEntries(message);
              return (
                <div key={message.id}>
                  {message.role === "assistant" && transcript.length > 0 ? (
                    <StreamTranscriptItem
                      entries={transcript}
                      state={message.status}
                      generationTerminalReason={message.generationTerminalReason}
                      streamStartedAt={new Date(message.createdAt)}
                      streamEndedAt={new Date(message.updatedAt)}
                      assistantMessageBody={message.body}
                      showDeveloperDiagnostics={false}
                    />
                  ) : null}
                  <ChatMessageItem
                    conversation={displayConversation}
                    message={message}
                    agents={agents}
                    decisionNote=""
                    onDecisionNoteChange={noop}
                    decisionNoteMentions={[]}
                    onDecisionNoteMentionQueryChange={noop}
                    onDecisionNoteInlineTokenClick={noop}
                    onApprovalAction={noop}
                    onIssueProposalChange={noop}
                    onResolveOperationProposal={noop}
                    onConvertToIssue={noop}
                    actionPending={false}
                    onCopyMessageText={(text) => navigator.clipboard?.writeText(text)}
                    onOpenFile={noop}
                    onSelectResponseAnnotation={onSelectResponseAnnotation}
                    skillReferences={EMPTY_SKILL_REFERENCES}
                  />
                </div>
              );
            }) : null}
            {displayedStream && displayConversation ? (
              <div className="flex flex-col gap-5" data-testid="side-chat-streaming-reply">
                {showOptimisticUserMessage ? (
                  <OptimisticUserDraftItem
                    body={displayedStream.userBody}
                    createdAt={displayedStream.userCreatedAt}
                    onCopyMessageText={(text) => navigator.clipboard?.writeText(text)}
                    onEditDraftOnly={setDraft}
                    skillReferences={EMPTY_SKILL_REFERENCES}
                  />
                ) : null}
                <StreamTranscriptItem
                  entries={displayedStream.transcript}
                  state={displayedStream.state}
                  streamStartedAt={displayedStream.createdAt}
                  assistantMessageBody={displayedStream.body}
                  showDeveloperDiagnostics={false}
                />
                <AssistantDraftItem
                  body={displayedStream.body}
                  createdAt={displayedStream.createdAt}
                  state={displayedStream.state}
                  replyingAgentId={displayedStream.replyingAgentId}
                  conversation={displayConversation}
                  agents={agents}
                  onCopyMessageText={(text) => navigator.clipboard?.writeText(text)}
                  skillReferences={EMPTY_SKILL_REFERENCES}
                />
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {sendError ? <div role="alert" className="px-4 pb-2 text-sm text-destructive">{sendError}</div> : null}

      {!readOnly ? (
        <div className="shrink-0 px-4 pb-4" data-testid="side-chat-composer">
          <ChatComposerSurface
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
              placeholder="Ask a focused follow-up…"
              onSubmit={() => void handleSend()}
            />
            <ChatComposerToolbar
              testId="side-chat-composer-toolbar"
              actions={(
                <ChatComposerSendButton
                  mode={sending ? "sending" : "send"}
                  ariaLabel={sending ? "Sending Side Chat message" : "Send Side Chat message"}
                  disabled={
                    (pendingFiles.length === 0
                      && !canSubmitChatResponseAnnotations(draft, annotationState))
                    || sending
                    || !selectedAgentId
                    || noAnchor
                  }
                  onClick={() => void handleSend()}
                />
              )}
            >
                <ChatComposerAddMenu
                  open={plusMenuOpen}
                  onOpenChange={setPlusMenuOpen}
                  onAddFiles={() => fileInputRef.current?.click()}
                />
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
          </ChatComposerSurface>
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
