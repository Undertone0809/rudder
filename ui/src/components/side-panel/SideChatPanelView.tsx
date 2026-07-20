import type { TranscriptEntry } from "@/agent-runtimes";
import { appendTranscriptEntry } from "@/agent-runtimes/transcript";
import { agentsApi } from "@/api/agents";
import { chatsApi } from "@/api/chats";
import { projectsApi } from "@/api/projects";
import { AgentIcon } from "@/components/AgentIconPicker";
import { MarkdownBody } from "@/components/MarkdownBody";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import type { MarkdownSkillReferencePreview } from "@/components/SkillReferenceToken";
import { Button } from "@/components/ui/button";
import type { ChatStreamDraftState } from "@/context/ChatGenerationContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { latestSideChatAnchor, sideChatConversationMessages, sideChatIsReadOnly } from "@/lib/side-chat";
import { sidePanelTargetKey, type SidePanelTarget } from "@/lib/side-panel-targets";
import { AssistantDraftItem, ChatMessageItem, StreamTranscriptItem } from "@/pages/Chat.messages";
import type { Agent, ChatConversation, ChatMessage } from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, CirclePlus, Clock3, Folder, Loader2, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type SideChatTarget = Extract<SidePanelTarget, { kind: "side_chat" }>;

type SideChatStream = {
  body: string;
  createdAt: Date;
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
  onKept,
}: {
  organizationId: string;
  target: SideChatTarget;
  onRegisterCloseHandler: (clientMutationId: string, handler: (() => Promise<string | null>) | null) => void;
  onReplaceTarget: (key: string, target: SidePanelTarget) => void;
  onKept: (conversation: ChatConversation) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [stream, setStream] = useState<SideChatStream | null>(null);
  const [now, setNow] = useState(() => new Date());
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
      destroyPromiseRef.current = chatsApi.destroySideChat(conversationId).then(() => undefined);
    }
    await destroyPromiseRef.current;
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
  const contextConversation = conversation?.contextLinks.some((link) => link.entityType === "project")
    ? conversation
    : sourceConversationQuery.data;
  const projectId = contextConversation?.contextLinks.find((link) => link.entityType === "project")?.entityId ?? null;
  const selectedProject = projectId
    ? (projectsQuery.data ?? []).find((project) => project.id === projectId) ?? null
    : null;

  const setConversationCache = (updated: ChatConversation) => {
    queryClient.setQueryData(queryKeys.chats.detail(organizationId, updated.id), updated);
  };

  const keepMutation = useMutation({
    mutationFn: () => chatsApi.keepSideChat(target.conversationId!),
    onSuccess: (updated) => {
      setConversationCache(updated);
      void queryClient.invalidateQueries({ queryKey: ["messenger", organizationId] });
      pushToast({
        title: "Kept in Messenger",
        body: "This is now a normal Messenger chat.",
        tone: "success",
      });
      onKept(updated);
    },
    onError: (error) => {
      pushToast({
        title: "Could not keep Side Chat",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      });
    },
  });

  const appendMessage = (conversationId: string, message: ChatMessage) => {
    queryClient.setQueryData<ChatMessage[]>(
      queryKeys.chats.messages(organizationId, conversationId),
      (current = []) => current.some((candidate) => candidate.id === message.id)
        ? current
        : [...current, message],
    );
  };

  const handleSend = async () => {
    const body = draft.trim();
    if (!body || sending || readOnly || !sourceMessageId) return;
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
        onEvent: async (event) => {
          if (event.type === "ack") appendMessage(conversationId!, event.userMessage);
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
      setDraft((current) => current || body);
      setStream((current) => current ? { ...current, state: "failed" } : current);
      setSendError(error instanceof Error ? error.message : "Could not send this message.");
    } finally {
      streamAbortControllerRef.current = null;
      setSending(false);
    }
  };

  const anchorLoading = (!target.sourceMessageId || !target.sourcePreview) && sourceMessagesQuery.isPending;
  const noAnchor = !anchorLoading && !sourceMessageId;
  const canKeep = Boolean(target.conversationId && conversation?.sideChatState === "active" && !readOnly);
  const agents = agentsQuery.data as Agent[] | undefined;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="side-chat-panel-view">
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
                    skillReferences={EMPTY_SKILL_REFERENCES}
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
                <button type="button" aria-label="Add files and options" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-active)_52%,transparent)] text-foreground">
                  <Plus className="h-4 w-4" />
                </button>
                <span className="inline-flex max-w-[11rem] min-w-0 items-center gap-1.5 rounded-[var(--radius-md)] bg-[color:var(--surface-active)] px-2.5 py-1.5 text-xs font-medium text-muted-foreground" data-testid="side-chat-project-chip">
                  <Folder className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{selectedProject?.name ?? "No project"}</span>
                </span>
                <span className="inline-flex max-w-[13rem] min-w-0 items-center gap-1.5 rounded-[var(--radius-md)] bg-[color:var(--surface-active)] px-2.5 py-1.5 text-xs font-medium text-muted-foreground" data-testid="side-chat-agent-chip">
                  <AgentIcon icon={selectedAgent?.icon} role={selectedAgent?.role} fallbackSeed={selectedAgent?.id ?? selectedAgentId} className="h-4 w-4 shrink-0" />
                  <span className="truncate">{selectedAgent?.name ?? displayConversation?.chatRuntime?.sourceLabel ?? "Assistant"}</span>
                </span>
                <span className="inline-flex rounded-[var(--radius-md)] bg-[color:var(--surface-active)] px-2.5 py-1.5 text-xs font-medium text-muted-foreground">Skills</span>
              </div>
              <button
                type="button"
                aria-label="Send Side Chat message"
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:cursor-not-allowed disabled:opacity-45"
                disabled={!draft.trim() || sending || noAnchor}
                onClick={() => void handleSend()}
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
              </button>
            </div>
          </div>
          {canKeep ? (
            <div className="mx-auto mt-2 flex w-full max-w-4xl justify-end">
              <Button type="button" variant="outline" size="sm" disabled={sending || keepMutation.isPending} onClick={() => keepMutation.mutate()}>
                {keepMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Keep in Messenger
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="shrink-0 border-t border-[color:var(--border-soft)] px-4 py-3 text-sm text-muted-foreground" data-testid="side-chat-read-only">
          This Side Chat has expired and can no longer be edited. Close the tab to destroy it.
        </div>
      )}
    </div>
  );
}
