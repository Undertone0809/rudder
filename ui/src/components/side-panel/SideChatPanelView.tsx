import type { TranscriptEntry } from "@/agent-runtimes";
import { appendTranscriptEntry } from "@/agent-runtimes/transcript";
import { agentsApi } from "@/api/agents";
import { chatsApi } from "@/api/chats";
import { organizationSkillsApi } from "@/api/organizationSkills";
import { organizationsApi } from "@/api/orgs";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import type { MarkdownSkillReferencePreview } from "@/components/SkillReferenceToken";
import {
  DraftResponseAnnotationsPopover,
  ResponseAnnotationEditor,
} from "@/components/chat/ResponseAnnotations";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ChatStreamDraftState } from "@/context/ChatGenerationContext";
import { formatChatAgentLabel } from "@/lib/agent-labels";
import { selectableChatAgents } from "@/lib/chat-agent-selection";
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
import { sidePanelTargetKey, type SidePanelTarget } from "@/lib/side-panel-targets";
import { PendingAttachmentPreview } from "@/pages/Chat.attachments";
import { AssistantDraftItem, ChatMessageItem, StreamTranscriptItem } from "@/pages/Chat.messages";
import {
  ChatAgentMenuContent,
  ChatAgentSelectorButton,
  chatRuntimeSelectionLabel,
  handleChatAgentMenuKeyDown,
  useChatRuntimeSelection,
  type ChatRuntimeOverrides,
} from "@/pages/Chat.model-selector";
import {
  materializePendingAttachment,
  mergeChatMessages,
  pendingAttachmentKey,
} from "@/pages/Chat.parts";
import type {
  Agent,
  ChatConversation,
  ChatInlineAnnotation,
  ChatMessage,
} from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Clock3, Loader2, Paperclip, Plus } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
} from "react";

type SideChatTarget = Extract<SidePanelTarget, { kind: "side_chat" }>;

type SideChatStream = {
  body: string;
  createdAt: Date;
  generationId: string | null;
  replyingAgentId: string | null;
  state: ChatStreamDraftState;
  transcript: TranscriptEntry[];
};

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
  onRegisterCloseHandler,
  onReplaceTarget,
  onSelectResponseAnnotation,
}: {
  organizationId: string;
  target: SideChatTarget;
  onRegisterCloseHandler: (clientMutationId: string, handler: (() => Promise<string | null>) | null) => void;
  onReplaceTarget: (key: string, target: SidePanelTarget) => void;
  onSelectResponseAnnotation: (annotation: ChatInlineAnnotation, ordinal: number) => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [stream, setStream] = useState<SideChatStream | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [draftPreferredAgentId, setDraftPreferredAgentId] = useState<string | null>(null);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [agentMenuPosition, setAgentMenuPosition] = useState<CSSProperties | null>(null);
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
  const agentMenuRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const draftAgentInitializedRef = useRef(false);
  const closeRequestedRef = useRef(false);
  const createPromiseRef = useRef<Promise<ChatConversation> | null>(null);
  const conversationIdRef = useRef(target.conversationId);
  const destroyPromiseRef = useRef<Promise<void> | null>(null);
  const streamAbortControllerRef = useRef<AbortController | null>(null);
  conversationIdRef.current = target.conversationId ?? conversationIdRef.current;

  const destroyForClose = useCallback(async () => {
    closeRequestedRef.current = true;
    streamAbortControllerRef.current?.abort();
    let conversationId = conversationIdRef.current;
    if (!conversationId && createPromiseRef.current) {
      const created = await createPromiseRef.current.catch(() => null);
      if (!created) return null;
      conversationId = created.id;
      conversationIdRef.current = created.id;
    }
    if (!conversationId) return null;
    if (!destroyPromiseRef.current) {
      const request = chatsApi.destroySideChat(conversationId).then(() => undefined);
      destroyPromiseRef.current = request;
      try {
        await request;
      } catch (error) {
        if (destroyPromiseRef.current === request) destroyPromiseRef.current = null;
        closeRequestedRef.current = false;
        throw error;
      }
    } else {
      await destroyPromiseRef.current;
    }
    return conversationId;
  }, []);

  useEffect(() => {
    onRegisterCloseHandler(target.clientMutationId, destroyForClose);
    return () => onRegisterCloseHandler(target.clientMutationId, null);
  }, [destroyForClose, onRegisterCloseHandler, target.clientMutationId]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

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
    setPendingConversationRuntimeOverrides,
  } = useChatRuntimeSelection({
    selectedOrganizationId: organizationId,
    selectedConversation: conversation,
    activeAgentId: selectedAgentId,
    activeAgent: selectedAgent,
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
  const readOnly = sideChatIsReadOnly(conversation, now);
  const stateLabel = readOnly
    ? "Expired · read-only"
    : expiryLabel(conversation?.sideChatExpiresAt, now);
  const setConversationCache = (updated: ChatConversation) => {
    queryClient.setQueryData(queryKeys.chats.detail(organizationId, updated.id), updated);
  };
  const runtimeMutation = useMutation({
    mutationFn: ({
      chatId,
      overrides,
    }: {
      chatId: string;
      overrides: ChatRuntimeOverrides;
    }) => chatsApi.update(chatId, overrides),
    onMutate: ({ chatId, overrides }) => {
      setPendingConversationRuntimeOverrides({ chatId, ...overrides });
      setSendError(null);
    },
    onSuccess: (updated) => {
      setPendingConversationRuntimeOverrides(null);
      setConversationCache(updated);
    },
    onError: (error) => {
      setPendingConversationRuntimeOverrides(null);
      setSendError(error instanceof Error ? error.message : "Could not update Side Chat runtime.");
    },
  });
  const applyRuntimeOverrides = (overrides: ChatRuntimeOverrides) => {
    if (!selectedAgent || runtimeMutation.isPending) return;
    if (!conversation) {
      setDraftRuntimeOverrides(overrides);
      return;
    }
    runtimeMutation.mutate({ chatId: conversation.id, overrides });
  };
  const applyPreferredAgent = (agentId: string) => {
    if (conversation || runtimeMutation.isPending || agentId === selectedAgentId) return;
    if (!liveAgents.some((agent) => agent.id === agentId)) return;
    setDraftRuntimeOverrides({ modelOverride: null, effortOverride: null });
    setDraftPreferredAgentId(agentId);
    setSkillMenuOpen(false);
    setSkillSearchQuery("");
  };

  const appendPendingFiles = async (incomingFiles: Iterable<File>) => {
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
  };
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
      || readOnly
      || !sourceMessageId
    ) return;
    const regularFiles = [...pendingFiles];
    const serializedAnnotations = serializeChatResponseAnnotations(annotationState, {
      fileIndexOffset: regularFiles.length,
    });
    const createdAt = new Date();
    let acknowledged = false;
    setSending(true);
    setSendError(null);
    setDraft("");
    setStream({
      body: "",
      createdAt,
      generationId: null,
      replyingAgentId: selectedAgentId,
      state: "streaming",
      transcript: [],
    });
    let conversationId = target.conversationId;
    try {
      if (!conversationId) {
        const createPromise = chatsApi.createSideChat(target.sourceConversationId, {
          sourceMessageId,
          clientMutationId: target.clientMutationId,
          preferredAgentId: selectedAgentId ?? undefined,
          modelOverride: activeRuntimeOverrides.modelOverride,
          effortOverride: activeRuntimeOverrides.effortOverride,
        });
        createPromiseRef.current = createPromise;
        const created = await createPromise;
        createPromiseRef.current = null;
        conversationId = created.id;
        conversationIdRef.current = created.id;
        if (closeRequestedRef.current) {
          await destroyForClose();
          return;
        }
        setConversationCache(created);
        queryClient.setQueryData(queryKeys.chats.messages(organizationId, created.id), []);
        onReplaceTarget(sidePanelTargetKey(target), {
          ...target,
          sourceMessageId,
          sourcePreview,
          conversationId: created.id,
        });
      }
      if (closeRequestedRef.current) {
        await destroyForClose();
        return;
      }
      const abortController = new AbortController();
      streamAbortControllerRef.current = abortController;
      await chatsApi.sendMessageStream(conversationId, body, {
        signal: abortController.signal,
        files: [...regularFiles, ...serializedAnnotations.files],
        inlineAnnotations: serializedAnnotations.inlineAnnotations,
        onEvent: async (event) => {
          if (event.type === "ack") {
            acknowledged = true;
            upsertMessage(conversationId!, event.userMessage);
            setStream((current) => current ? {
              ...current,
              generationId: event.generationId ?? current.generationId,
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
          if (event.type === "assistant_delta") {
            setStream((current) => current ? {
              ...current,
              body: `${current.body}${event.delta}`,
              generationId: event.generationId ?? current.generationId,
            } : current);
          }
          if (event.type === "assistant_state") {
            setStream((current) => current ? { ...current, state: event.state } : current);
          }
          if (event.type === "transcript_entry") {
            setStream((current) => {
              if (!current) return current;
              const transcript = [...current.transcript];
              appendTranscriptEntry(transcript, event.entry);
              return {
                ...current,
                generationId: event.generationId ?? current.generationId,
                transcript,
              };
            });
          }
          if (event.type === "final") {
            for (const message of event.messages) upsertMessage(conversationId!, message);
            setStream(null);
          }
          if (event.type === "error") {
            if (!acknowledged && event.messageId) {
              acknowledged = true;
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
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(organizationId, conversationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.chats.messages(organizationId, conversationId) }),
      ]);
    } catch (error) {
      if (closeRequestedRef.current) return;
      if (!acknowledged) setDraft((current) => current || body);
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
      setStream((current) => current ? { ...current, state: "failed" } : current);
      setSendError(error instanceof Error ? error.message : "Could not send this message.");
    } finally {
      streamAbortControllerRef.current = null;
      setSending(false);
    }
  };

  const anchorLoading = (!target.sourceMessageId || !target.sourcePreview) && sourceMessagesQuery.isPending;
  const noAnchor = !anchorLoading && !sourceMessageId;
  const agents = agentsQuery.data as Agent[] | undefined;
  const runtimeLabel = chatRuntimeSelectionLabel({
    agent: selectedAgent,
    runtime: conversation?.chatRuntime ?? null,
    overrides: activeRuntimeOverrides,
  });
  const agentLabel = selectedAgent
    ? formatChatAgentLabel(selectedAgent)
    : agentsQuery.isPending
      ? "Loading agents"
      : "No agent";

  useEffect(() => {
    if (!agentMenuOpen) {
      setAgentMenuPosition(null);
      return;
    }
    const updatePosition = () => {
      const anchor = runtimeSelectorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(360, window.innerWidth - 24);
      setAgentMenuPosition({
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        bottom: Math.max(12, window.innerHeight - rect.top + 8),
        width,
        maxHeight: Math.max(180, rect.top - 24),
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [agentMenuOpen, runtimeSelectorRef]);

  useEffect(() => {
    if (!agentMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const node = event.target;
      if (!(node instanceof Node)) return;
      if (node instanceof Element && node.closest("[data-chat-runtime-submenu]")) return;
      if (agentMenuRef.current?.contains(node) || runtimeSelectorRef.current?.contains(node)) return;
      setAgentMenuOpen(false);
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setAgentMenuOpen(false);
      requestAnimationFrame(() => runtimeSelectorRef.current?.focus());
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [agentMenuOpen, runtimeSelectorRef]);

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
          <div className="chat-composer mx-auto w-full max-w-4xl rounded-[var(--radius-lg)] p-3">
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
              <div data-testid="side-chat-pending-attachments" className="mb-2.5 flex flex-wrap gap-2">
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
            <MarkdownEditor
              value={draft}
              onChange={setDraft}
              submitShortcut="enter"
              plainText
              bordered={false}
              className="rounded-[var(--radius-md)] bg-transparent"
              contentClassName="min-h-[88px] bg-transparent text-[15px] leading-7 text-foreground"
              placeholder="Ask a focused follow-up…"
              onSubmit={() => void handleSend()}
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2.5" data-testid="side-chat-composer-toolbar">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <DropdownMenu open={plusMenuOpen} onOpenChange={setPlusMenuOpen}>
                  <DropdownMenuTrigger
                    type="button"
                    aria-label="Add files and options"
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-active)_52%,transparent)] text-foreground transition-colors hover:bg-[color:var(--surface-active)] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40"
                  >
                    <Plus className="h-4 w-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    side="top"
                    sideOffset={8}
                    className="surface-overlay w-64 rounded-[var(--radius-lg)] border p-1.5 text-foreground"
                  >
                    <DropdownMenuItem
                      className="rounded-[var(--radius-md)] px-3 py-2.5"
                      onSelect={(event) => {
                        event.preventDefault();
                        setPlusMenuOpen(false);
                        window.setTimeout(() => fileInputRef.current?.click(), 0);
                      }}
                    >
                      <Paperclip className="mr-2 h-4 w-4" />
                      Add files
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <ChatAgentSelectorButton
                  buttonRef={runtimeSelectorRef}
                  agent={selectedAgent}
                  label={agentLabel}
                  expanded={agentMenuOpen}
                  disabled={agentsQuery.isPending || sending || runtimeMutation.isPending}
                  onClick={() => setAgentMenuOpen((open) => !open)}
                />
                <DropdownMenu
                  open={skillMenuOpen}
                  onOpenChange={(open) => {
                    setSkillMenuOpen(open);
                    if (!open) setSkillSearchQuery("");
                  }}
                >
                  <DropdownMenuTrigger
                    type="button"
                    aria-label="Skills"
                    className="chat-chip inline-flex max-w-[min(100%,16rem)] min-w-0 items-center rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[color:var(--surface-active)] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40"
                  >
                    Skills
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    side="top"
                    sideOffset={8}
                    className="surface-overlay max-h-[min(60vh,320px)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-[var(--radius-lg)] border p-1.5 text-foreground"
                  >
                    {agentSkillsQuery.isPending || organizationSkillsQuery.isPending ? (
                      <div className="flex items-center gap-2 rounded-[var(--radius-md)] px-3 py-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading skills...
                      </div>
                    ) : availableChatSkills.length === 0 ? (
                      <div className="rounded-[var(--radius-md)] px-3 py-2 text-sm text-muted-foreground">
                        This agent has no enabled skills.
                      </div>
                    ) : (
                      <>
                        <div className="p-1">
                          <input
                            className="w-full rounded-[var(--radius-md)] border border-border bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-ring"
                            placeholder="Search skills..."
                            value={skillSearchQuery}
                            onChange={(event) => setSkillSearchQuery(event.target.value)}
                          />
                        </div>
                        {filteredChatSkills.length === 0 ? (
                          <div className="rounded-[var(--radius-md)] px-3 py-2 text-sm text-muted-foreground">
                            No skills match search.
                          </div>
                        ) : filteredChatSkills.map((entry) => (
                          <DropdownMenuItem
                            key={entry.skillMarkdownTarget}
                            className="items-start rounded-[var(--radius-md)] px-3 py-2"
                            onSelect={() => insertSkillReference(entry)}
                          >
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate text-sm font-medium">{entry.skillDisplayName}</span>
                              <span className="truncate text-xs text-muted-foreground">
                                {entry.skillDescription ?? entry.skillLocationLabel ?? entry.skillRefLabel}
                              </span>
                            </span>
                          </DropdownMenuItem>
                        ))}
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <button
                type="button"
                aria-label="Send Side Chat message"
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:cursor-not-allowed disabled:opacity-45"
                disabled={
                  (pendingFiles.length === 0 && !canSubmitChatResponseAnnotations(draft, annotationState))
                  || sending
                  || runtimeMutation.isPending
                  || !selectedAgentId
                  || noAnchor
                }
                onClick={() => void handleSend()}
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
              </button>
            </div>
          </div>
          {agentMenuOpen && agentMenuPosition ? (
            <div
              ref={agentMenuRef}
              role="menu"
              aria-label="Side Chat agent"
              data-testid="side-chat-agent-menu"
              className="chat-composer-context-menu motion-chat-composer-menu-pop surface-overlay fixed z-50 overflow-y-auto rounded-[var(--radius-lg)] border p-1.5 text-foreground"
              style={agentMenuPosition}
              onKeyDown={handleChatAgentMenuKeyDown}
            >
              <ChatAgentMenuContent
                agents={liveAgents}
                activeAgentId={selectedAgentId ?? ""}
                agentSelectionLocked={Boolean(conversation)}
                runtimeSelectionPending={runtimeMutation.isPending}
                newConversationSendInFlight={sending}
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
            </div>
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
