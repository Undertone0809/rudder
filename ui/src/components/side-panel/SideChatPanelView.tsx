import type { TranscriptEntry } from "@/agent-runtimes";
import { appendTranscriptEntry } from "@/agent-runtimes/transcript";
import { agentsApi } from "@/api/agents";
import { chatsApi } from "@/api/chats";
import { organizationSkillsApi } from "@/api/organizationSkills";
import { projectsApi } from "@/api/projects";
import { MarkdownBody } from "@/components/MarkdownBody";
import { MarkdownEditor, type MarkdownEditorRef } from "@/components/MarkdownEditor";
import { ProjectIcon } from "@/components/ProjectIdentity";
import type { MarkdownSkillReferencePreview } from "@/components/SkillReferenceToken";
import type { ChatStreamDraftState } from "@/context/ChatGenerationContext";
import { useOrganization } from "@/context/OrganizationContext";
import { useToast } from "@/context/ToastContext";
import { formatChatAgentLabel } from "@/lib/agent-labels";
import { buildChatSkillOptions, filterChatSkillOptions } from "@/lib/chat-skill-options";
import { appendSkillReferencesToDraft } from "@/lib/organization-skill-picker";
import { queryKeys } from "@/lib/queryKeys";
import { latestSideChatAnchor, sideChatConversationMessages, sideChatIsReadOnly } from "@/lib/side-chat";
import { sidePanelTargetKey, type SidePanelTarget } from "@/lib/side-panel-targets";
import { PendingAttachmentPreview } from "@/pages/Chat.attachments";
import {
  ChatComposerOptionsMenu,
  ChatLockedAgentChip,
  ChatLockedContextChip,
  ChatSkillPickerMenuContent,
  ChatSkillsButton,
} from "@/pages/Chat.composer-controls";
import { AssistantDraftItem, ChatMessageItem, StreamTranscriptItem } from "@/pages/Chat.messages";
import { composerMenuPositionForAnchor, materializePendingAttachment, pendingAttachmentKey } from "@/pages/Chat.parts";
import { ChatPlanModeChip } from "@/pages/Chat.plan-mode-controls";
import { clipboardAttachmentPayloadKey } from "@/pages/Chat.workspace-helpers";
import type { Agent, ChatConversation, ChatMessage } from "@rudderhq/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, CirclePlus, Clock3, Loader2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ClipboardEvent as ReactClipboardEvent,
} from "react";
import { createPortal } from "react-dom";

type SideChatTarget = Extract<SidePanelTarget, { kind: "side_chat" }>;

type SideChatStream = {
  body: string;
  createdAt: Date;
  replyingAgentId: string | null;
  state: ChatStreamDraftState;
  transcript: TranscriptEntry[];
};

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
}: {
  organizationId: string;
  target: SideChatTarget;
  onRegisterCloseHandler: (clientMutationId: string, handler: (() => Promise<string | null>) | null) => void;
  onReplaceTarget: (key: string, target: SidePanelTarget) => void;
}) {
  const queryClient = useQueryClient();
  const { selectedOrganization } = useOrganization();
  const { pushToast } = useToast();
  const [draft, setDraft] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [skillSearchQuery, setSkillSearchQuery] = useState("");
  const [skillMenuPosition, setSkillMenuPosition] = useState<CSSProperties | null>(null);
  const [provisionalPlanModeOverride, setProvisionalPlanModeOverride] = useState<boolean | null>(null);
  const [pendingPlanModeOverride, setPendingPlanModeOverride] = useState<boolean | null>(null);
  const [planModeUpdating, setPlanModeUpdating] = useState(false);
  const [planModeError, setPlanModeError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [stream, setStream] = useState<SideChatStream | null>(null);
  const [now, setNow] = useState(() => new Date());
  const composerSurfaceRef = useRef<HTMLDivElement>(null);
  const composerEditorRef = useRef<MarkdownEditorRef>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const skillMenuRef = useRef<HTMLDivElement>(null);
  const skillSearchInputRef = useRef<HTMLInputElement>(null);
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

  const appendPendingFiles = useCallback(async (incomingFiles: Iterable<File>) => {
    const files = Array.from(incomingFiles).filter((file) => file.size > 0);
    if (files.length === 0) return;
    setAttachmentError(null);
    try {
      const safeFiles = await Promise.all(
        files.map((file, index) => materializePendingAttachment(file, index)),
      );
      setPendingFiles((current) => [...current, ...safeFiles]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not stage this attachment.";
      setAttachmentError(message);
      pushToast({
        title: "Failed to stage attachment",
        body: message,
        tone: "error",
      });
    }
  }, [pushToast]);

  const removePendingFile = useCallback((targetKey: string) => {
    setPendingFiles((current) => (
      current.filter((file) => pendingAttachmentKey(file) !== targetKey)
    ));
  }, []);

  const handlePendingAttachmentPasteCapture = useCallback((
    event: ReactClipboardEvent<HTMLElement>,
  ) => {
    const clipboardData = event.clipboardData;
    const filesFromItems = Array.from(clipboardData?.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file instanceof File);
    const seenItemPayloads = new Map<string, number>();
    for (const file of filesFromItems) {
      const key = clipboardAttachmentPayloadKey(file);
      seenItemPayloads.set(key, (seenItemPayloads.get(key) ?? 0) + 1);
    }
    const filesFromList = Array.from(clipboardData?.files ?? [])
      .filter((file) => {
        const key = clipboardAttachmentPayloadKey(file);
        const remaining = seenItemPayloads.get(key) ?? 0;
        if (remaining <= 0) return true;
        if (remaining === 1) seenItemPayloads.delete(key);
        else seenItemPayloads.set(key, remaining - 1);
        return false;
      });
    const files = [...filesFromItems, ...filesFromList];
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    void appendPendingFiles(files);
  }, [appendPendingFiles]);

  const closeSkillMenu = useCallback(() => {
    setSkillMenuOpen(false);
    setSkillSearchQuery("");
  }, []);

  const openSkillMenu = useCallback(() => {
    const anchor = composerSurfaceRef.current;
    if (anchor) setSkillMenuPosition(composerMenuPositionForAnchor(anchor));
    setPlusMenuOpen(false);
    setSkillMenuOpen(true);
  }, []);

  useEffect(() => {
    if (!skillMenuOpen) {
      setSkillMenuPosition(null);
      return undefined;
    }
    const updatePosition = () => {
      const anchor = composerSurfaceRef.current;
      if (anchor) setSkillMenuPosition(composerMenuPositionForAnchor(anchor));
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [skillMenuOpen]);

  useEffect(() => {
    if (!skillMenuOpen) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const eventTarget = event.target;
      if (!(eventTarget instanceof Node)) return;
      if (skillMenuRef.current?.contains(eventTarget)) return;
      if (composerSurfaceRef.current?.contains(eventTarget)) return;
      closeSkillMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSkillMenu();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [closeSkillMenu, skillMenuOpen]);

  useEffect(() => {
    if (!skillMenuOpen) return;
    requestAnimationFrame(() => skillSearchInputRef.current?.focus());
  }, [skillMenuOpen]);

  const sourceConversationQuery = useQuery({
    queryKey: queryKeys.chats.detail(organizationId, target.sourceConversationId),
    queryFn: () => chatsApi.get(target.sourceConversationId),
  });
  const sourceMessagesQuery = useQuery({
    queryKey: queryKeys.chats.messages(organizationId, target.sourceConversationId),
    queryFn: () => chatsApi.listMessages(target.sourceConversationId),
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
    queryFn: () => chatsApi.listMessages(target.conversationId!, { includeTranscript: true }),
    enabled: Boolean(target.conversationId),
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(organizationId),
    queryFn: () => agentsApi.list(organizationId),
  });
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(organizationId),
    queryFn: () => projectsApi.list(organizationId),
  });

  const conversation = conversationQuery.data ?? null;
  const displayConversation = conversation ?? sourceConversationQuery.data ?? null;
  const messages = sideChatConversationMessages(messagesQuery.data ?? []);
  const readOnly = sideChatIsReadOnly(conversation, now);
  const stateLabel = readOnly
    ? "Expired · read-only"
    : expiryLabel(conversation?.sideChatExpiresAt, now);
  const selectedAgentId = displayConversation?.preferredAgentId ?? displayConversation?.routedAgentId ?? null;
  const selectedAgent = selectedAgentId
    ? (agentsQuery.data ?? []).find((agent) => agent.id === selectedAgentId) ?? null
    : null;
  const organizationSkillsQuery = useQuery({
    queryKey: queryKeys.organizationSkills.list(organizationId),
    queryFn: () => organizationSkillsApi.list(organizationId),
  });
  const agentSkillsQuery = useQuery({
    queryKey: queryKeys.agents.skills(selectedAgentId ?? "__none__"),
    queryFn: () => agentsApi.skills(selectedAgentId!, organizationId),
    enabled: Boolean(selectedAgentId),
  });
  const availableChatSkills = useMemo(
    () => buildChatSkillOptions({
      agent: selectedAgent,
      orgUrlKey: selectedOrganization?.id === organizationId
        ? selectedOrganization.urlKey
        : "organization",
      organizationSkills: organizationSkillsQuery.data,
      skillSnapshot: agentSkillsQuery.data,
    }),
    [
      agentSkillsQuery.data,
      organizationId,
      organizationSkillsQuery.data,
      selectedAgent,
      selectedOrganization?.id,
      selectedOrganization?.urlKey,
    ],
  );
  const filteredChatSkills = useMemo(
    () => filterChatSkillOptions(availableChatSkills, skillSearchQuery),
    [availableChatSkills, skillSearchQuery],
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
  const chatSkillsPending = Boolean(selectedAgentId)
    && (agentsQuery.isPending || organizationSkillsQuery.isPending || agentSkillsQuery.isPending);
  const chatSkillsError = agentsQuery.error
    ?? organizationSkillsQuery.error
    ?? agentSkillsQuery.error;
  const contextConversation = conversation?.contextLinks.some((link) => link.entityType === "project")
    ? conversation
    : sourceConversationQuery.data;
  const projectContextLink = contextConversation?.contextLinks.find((link) => link.entityType === "project") ?? null;
  const projectId = projectContextLink?.entityId ?? null;
  const selectedProject = projectId
    ? (projectsQuery.data ?? []).find((project) => project.id === projectId) ?? null
    : null;
  const projectLabel = selectedProject?.name?.trim()
    || projectContextLink?.entity?.label?.trim()
    || "Project context";
  const agentLabel = selectedAgent
    ? formatChatAgentLabel(selectedAgent)
    : displayConversation?.chatRuntime?.sourceLabel ?? "Assistant";
  const activePlanMode = pendingPlanModeOverride
    ?? conversation?.planMode
    ?? provisionalPlanModeOverride
    ?? sourceConversationQuery.data?.planMode
    ?? false;

  const setConversationCache = useCallback((updated: ChatConversation) => {
    queryClient.setQueryData(queryKeys.chats.detail(organizationId, updated.id), updated);
  }, [organizationId, queryClient]);

  const appendMessage = useCallback((conversationId: string, message: ChatMessage) => {
    queryClient.setQueryData<ChatMessage[]>(
      queryKeys.chats.messages(organizationId, conversationId),
      (current = []) => current.some((candidate) => candidate.id === message.id)
        ? current
        : [...current, message],
    );
  }, [organizationId, queryClient]);

  const insertSkillReference = useCallback((entry: (typeof availableChatSkills)[number]) => {
    if (!entry.skillRefLabel || !entry.skillMarkdownTarget) {
      closeSkillMenu();
      return;
    }
    const nextDraft = appendSkillReferencesToDraft(
      draft,
      [`[${entry.skillRefLabel}](${entry.skillMarkdownTarget})`],
    );
    setDraft(nextDraft);
    closeSkillMenu();
    requestAnimationFrame(() => composerEditorRef.current?.focus());
    if (nextDraft === draft) {
      pushToast({
        title: "Selected skills already in message",
        tone: "success",
      });
    }
  }, [availableChatSkills, closeSkillMenu, draft, pushToast]);

  const applyPlanMode = useCallback(async (value: boolean) => {
    setPlanModeError(null);
    const conversationId = target.conversationId ?? conversationIdRef.current;
    if (!conversationId) {
      setProvisionalPlanModeOverride(value);
      return;
    }
    if (planModeUpdating) return;

    const previousConversation = conversation;
    const previousPlanMode = activePlanMode;
    setPlanModeUpdating(true);
    setPendingPlanModeOverride(value);
    if (previousConversation) {
      setConversationCache({ ...previousConversation, planMode: value });
    }
    try {
      const updated = await chatsApi.update(conversationId, { planMode: value });
      setConversationCache(updated);
      setProvisionalPlanModeOverride(null);
      setPendingPlanModeOverride(null);
    } catch (error) {
      if (previousConversation) setConversationCache(previousConversation);
      setPendingPlanModeOverride(null);
      setProvisionalPlanModeOverride(previousPlanMode);
      setPlanModeError(error instanceof Error
        ? error.message
        : "Could not update Plan mode.");
    } finally {
      setPlanModeUpdating(false);
    }
  }, [
    activePlanMode,
    conversation,
    planModeUpdating,
    setConversationCache,
    target.conversationId,
  ]);

  const handleSend = async () => {
    const body = draft.trim();
    if (!body || sending || planModeUpdating || readOnly || !sourceMessageId) return;
    const filesToUpload = [...pendingFiles];
    const sentFileKeys = new Set(filesToUpload.map(pendingAttachmentKey));
    let acknowledged = false;
    const createdAt = new Date();
    setSending(true);
    setSendError(null);
    setDraft("");
    setStream({
      body: "",
      createdAt,
      replyingAgentId: selectedAgentId,
      state: "streaming",
      transcript: [],
    });
    try {
      let conversationId = target.conversationId;
      if (!conversationId) {
        const createPromise = chatsApi.createSideChat(target.sourceConversationId, {
          sourceMessageId,
          clientMutationId: target.clientMutationId,
          ...(provisionalPlanModeOverride === null
            ? {}
            : { planMode: provisionalPlanModeOverride }),
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
        setProvisionalPlanModeOverride(null);
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
        files: filesToUpload,
        onEvent: async (event) => {
          if (event.type === "ack") {
            acknowledged = true;
            appendMessage(conversationId!, event.userMessage);
            setPendingFiles((current) => (
              current.filter((file) => !sentFileKeys.has(pendingAttachmentKey(file)))
            ));
            setAttachmentError(null);
          }
          if (event.type === "assistant_delta") {
            setStream((current) => current ? { ...current, body: `${current.body}${event.delta}` } : current);
          }
          if (event.type === "assistant_state") {
            setStream((current) => current ? { ...current, state: event.state } : current);
          }
          if (event.type === "transcript_entry") {
            setStream((current) => {
              if (!current) return current;
              const transcript = [...current.transcript];
              appendTranscriptEntry(transcript, event.entry);
              return { ...current, transcript };
            });
          }
          if (event.type === "final") {
            for (const message of event.messages) appendMessage(conversationId!, message);
            setStream(null);
          }
          if (event.type === "error") throw new Error(event.error);
        },
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(organizationId, conversationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.chats.messages(organizationId, conversationId) }),
      ]);
    } catch (error) {
      if (closeRequestedRef.current) return;
      if (!acknowledged) {
        setDraft((current) => current.trim() ? `${body}\n\n${current}` : body);
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

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="side-chat-panel-view">
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
      <div className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
          <section className="rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <CirclePlus className="h-4 w-4 text-[color:var(--accent-base)]" data-testid="side-chat-icon" />
                Side Chat
              </div>
              {stateLabel ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground" data-testid="side-chat-state">
                  <Clock3 className="h-3 w-3" />
                  {stateLabel}
                </span>
              ) : null}
            </div>
            <div className="mt-3 border-l-2 border-[color:var(--accent-base)] pl-3">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.13em] text-muted-foreground">From the main chat</div>
              {anchorLoading ? (
                <div className="h-10 animate-pulse rounded bg-[color:var(--surface-active)]" />
              ) : noAnchor ? (
                <p className="text-sm text-destructive">The main chat needs a completed assistant response first.</p>
              ) : (
                <div className="line-clamp-5 text-sm leading-6 text-muted-foreground" data-testid="side-chat-anchor-preview">
                  <MarkdownBody>{sourcePreview ?? "Assistant response"}</MarkdownBody>
                </div>
              )}
            </div>
          </section>

          <div className="flex min-h-[12rem] flex-col gap-5" data-testid="side-chat-messages">
            {displayConversation ? messages.map((message) => {
              const transcript = transcriptEntries(message);
              return (
                <div key={message.id}>
                  {message.role === "assistant" && transcript.length > 0 ? (
                    <StreamTranscriptItem
                      entries={transcript}
                      state={message.status}
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
                    skillReferences={chatSkillReferences}
                  />
                </div>
              );
            }) : null}
            {stream && displayConversation ? (
              <div className="flex flex-col gap-5" data-testid="side-chat-streaming-reply">
                <StreamTranscriptItem
                  entries={stream.transcript}
                  state={stream.state}
                  streamStartedAt={stream.createdAt}
                  assistantMessageBody={stream.body}
                  showDeveloperDiagnostics={false}
                />
                <AssistantDraftItem
                  body={stream.body}
                  createdAt={stream.createdAt}
                  state={stream.state}
                  replyingAgentId={stream.replyingAgentId}
                  conversation={displayConversation}
                  agents={agents}
                  onCopyMessageText={(text) => navigator.clipboard?.writeText(text)}
                  skillReferences={chatSkillReferences}
                />
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {sendError ? <div role="alert" className="px-4 pb-2 text-sm text-destructive">{sendError}</div> : null}
      {planModeError ? (
        <div role="alert" className="px-4 pb-2 text-sm text-destructive">
          Plan mode was restored because the update failed: {planModeError}
        </div>
      ) : null}

      {!readOnly ? (
        <div className="shrink-0 px-4 pb-4" data-testid="side-chat-composer">
          <div
            ref={composerSurfaceRef}
            className="chat-composer mx-auto w-full max-w-4xl rounded-[var(--radius-lg)] p-3"
          >
            <div onPasteCapture={handlePendingAttachmentPasteCapture}>
              <MarkdownEditor
                ref={composerEditorRef}
                value={draft}
                onChange={(value) => {
                  setDraft(value);
                  setSendError(null);
                }}
                mentions={availableChatSkills}
                submitShortcut="enter"
                plainText
                bordered={false}
                className="rounded-[var(--radius-md)] bg-transparent"
                contentClassName="min-h-[88px] bg-transparent text-[15px] leading-7 text-foreground"
                placeholder={activePlanMode ? "Describe the plan you want…" : "Ask a focused follow-up…"}
                onSubmit={() => void handleSend()}
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2.5" data-testid="side-chat-composer-toolbar">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <ChatComposerOptionsMenu
                  open={plusMenuOpen}
                  onOpenChange={(open) => {
                    setPlusMenuOpen(open);
                    if (open) closeSkillMenu();
                  }}
                  onAddFiles={() => fileInputRef.current?.click()}
                  planMode={activePlanMode}
                  onPlanModeChange={(value) => void applyPlanMode(value)}
                  planModeDisabled={sending || planModeUpdating}
                />
                {activePlanMode ? (
                  <ChatPlanModeChip
                    disabled={sending || planModeUpdating}
                    onDisable={() => void applyPlanMode(false)}
                  />
                ) : null}
                {projectContextLink ? (
                  <ChatLockedContextChip
                    ariaLabel={`Project context: ${projectLabel}`}
                    icon={(
                      <ProjectIcon
                        color={selectedProject?.color}
                        icon={selectedProject?.icon}
                        size="xs"
                        testId="side-chat-project-icon"
                      />
                    )}
                    label={projectLabel}
                    testId="side-chat-project-chip"
                    title="Project context is inherited from the main chat."
                  />
                ) : null}
                <ChatLockedAgentChip
                  agent={selectedAgent}
                  fallbackSeed={selectedAgent?.id ?? selectedAgentId}
                  label={agentLabel}
                  testId="side-chat-agent-chip"
                />
                {selectedAgentId ? (
                  <ChatSkillsButton
                    open={skillMenuOpen}
                    onClick={() => {
                      if (skillMenuOpen) closeSkillMenu();
                      else openSkillMenu();
                    }}
                  />
                ) : null}
              </div>
              <button
                type="button"
                aria-label="Send Side Chat message"
                aria-busy={sending || undefined}
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:cursor-not-allowed disabled:opacity-45"
                disabled={!draft.trim() || sending || planModeUpdating || noAnchor}
                onClick={() => void handleSend()}
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
              </button>
            </div>
            {pendingFiles.length > 0 ? (
              <div data-testid="side-chat-pending-attachments" className="mt-2.5 flex flex-wrap gap-2">
                {pendingFiles.map((file) => {
                  const fileKey = pendingAttachmentKey(file);
                  return (
                    <div key={fileKey} data-testid="side-chat-pending-attachment" className="max-w-full">
                      <PendingAttachmentPreview
                        file={file}
                        onRemove={sending ? undefined : () => removePendingFile(fileKey)}
                      />
                    </div>
                  );
                })}
              </div>
            ) : null}
            {attachmentError ? (
              <div role="alert" className="mt-2 text-sm text-destructive">
                {attachmentError}
              </div>
            ) : null}
          </div>
          {skillMenuOpen && skillMenuPosition && typeof document !== "undefined"
            ? createPortal(
              <div
                ref={skillMenuRef}
                data-testid="side-chat-skill-menu"
                role="menu"
                className="chat-composer-context-menu motion-chat-composer-menu-pop surface-overlay fixed z-50 overflow-y-auto rounded-[var(--radius-lg)] border p-1.5 text-foreground"
                style={skillMenuPosition}
              >
                <ChatSkillPickerMenuContent
                  error={chatSkillsError}
                  filteredItems={filteredChatSkills}
                  items={availableChatSkills}
                  onSearchQueryChange={setSkillSearchQuery}
                  onSelect={insertSkillReference}
                  pending={chatSkillsPending}
                  searchInputRef={skillSearchInputRef}
                  searchQuery={skillSearchQuery}
                />
              </div>,
              document.body,
            )
            : null}
        </div>
      ) : (
        <div className="shrink-0 border-t border-[color:var(--border-soft)] px-4 py-3 text-sm text-muted-foreground" data-testid="side-chat-read-only">
          This Side Chat has expired and can no longer be edited. Close the tab to destroy it.
        </div>
      )}
    </div>
  );
}
