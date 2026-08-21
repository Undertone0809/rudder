import type { TranscriptEntry } from "@/agent-runtimes";
import { agentsApi } from "@/api/agents";
import { chatsApi } from "@/api/chats";
import { ApiError } from "@/api/client";
import { AgentIdentity } from "@/components/AgentAvatar";
import {
  ChatComposerEditor,
  ChatComposerSendButton,
  ChatComposerSurface,
  ChatComposerToolbar,
} from "@/components/chat/ChatComposer";
import { Button } from "@/components/ui/button";
import { chatErrorMessage } from "@/lib/chat-errors";
import {
  clearPendingChatStopRecovery,
  createChatStopRecoveryRetrier,
  createPendingChatStopRecovery,
  readPendingChatStopRecovery,
  savePendingChatStopRecovery,
  type PendingChatStopRecovery,
} from "@/lib/chat-stop-recovery";
import { queryKeys } from "@/lib/queryKeys";
import { useNavigate } from "@/lib/router";
import { sidePanelTargetKey, type SidePanelTarget } from "@/lib/side-panel-targets";
import { ChatMessageItem, StreamTranscriptItem } from "@/pages/Chat.messages";
import { activeGenerationIdFromSnapshot } from "@/pages/Chat.workspace-helpers";
import type { ChatConversation, ChatMessage } from "@rudderhq/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, MessageSquare } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type GoalChatTarget = Extract<SidePanelTarget, { kind: "goal_chat" }>;

function messageBody(message: ChatMessage) {
  return message.body?.trim() || message.kind;
}

function transcriptEntries(message: ChatMessage) {
  return (message.transcript ?? []) as TranscriptEntry[];
}

function noop() {}

export function GoalChatPanel({
  target,
  onReplaceTarget,
}: {
  target: GoalChatTarget;
  onReplaceTarget: (key: string, target: SidePanelTarget) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [draft, setDraft] = useState(target.body);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamBody, setStreamBody] = useState("");
  const [sending, setSending] = useState(false);
  const [workingSince, setWorkingSince] = useState<number | null>(null);
  const [workingSeconds, setWorkingSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failedBody, setFailedBody] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [decisionNotes, setDecisionNotes] = useState<Record<string, string>>({});
  const targetRef = useRef(target);
  const sendInFlightRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeBodyRef = useRef<string | null>(null);
  const stopRequestInFlightRef = useRef(false);
  const submitStopRecoveryRef = useRef<(recovery: PendingChatStopRecovery) => void>(() => undefined);
  const stopRecoveryRetrierRef = useRef<ReturnType<typeof createChatStopRecoveryRetrier> | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  if (!stopRecoveryRetrierRef.current) {
    stopRecoveryRetrierRef.current = createChatStopRecoveryRetrier((recovery) => {
      submitStopRecoveryRef.current(recovery);
    });
  }
  targetRef.current = target;

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(target.organizationId),
    queryFn: () => agentsApi.list(target.organizationId),
  });
  const conversationQuery = useQuery({
    queryKey: queryKeys.chats.detail(target.organizationId, target.conversationId ?? "__goal-chat-draft__"),
    queryFn: () => chatsApi.get(target.conversationId!),
    enabled: Boolean(target.conversationId),
  });
  const messagesQuery = useQuery({
    queryKey: queryKeys.chats.messages(target.organizationId, target.conversationId ?? "__goal-chat-draft__"),
    queryFn: () => chatsApi.listMessages(target.organizationId, target.conversationId!, { includeTranscript: true }),
    enabled: Boolean(target.conversationId),
  });
  const queueQuery = useQuery({
    queryKey: queryKeys.chats.queue(target.organizationId, target.conversationId ?? "__goal-chat-draft__"),
    queryFn: () => chatsApi.listQueue(target.conversationId!),
    enabled: Boolean(target.conversationId),
    refetchInterval: sending && target.conversationId ? 2_000 : false,
  });

  const selectedAgent = useMemo(() => {
    const agents = agentsQuery.data ?? [];
    return target.agentId ? agents.find((agent) => agent.id === target.agentId) ?? null : null;
  }, [agentsQuery.data, target.agentId]);
  const ownerUnavailable = Boolean(!agentsQuery.isPending && !selectedAgent);
  const conversation = conversationQuery.data as ChatConversation | undefined;
  const loadError = conversationQuery.error ?? messagesQuery.error;

  useEffect(() => {
    if (messagesQuery.data && !sendInFlightRef.current) setMessages(messagesQuery.data);
  }, [messagesQuery.data]);

  useEffect(() => {
    setDraft(target.body);
  }, [target.body]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        `rudder.goal-chat:${target.organizationId}:${target.goalId}`,
        JSON.stringify(target),
      );
    } catch {
      // The live Side Panel state remains authoritative when storage is unavailable.
    }
  }, [target]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, streamBody]);

  useEffect(() => () => {
    abortControllerRef.current?.abort();
    stopRecoveryRetrierRef.current?.dispose();
  }, []);

  useEffect(() => {
    const conversationId = target.conversationId;
    if (!conversationId) return;
    const replayPendingStop = () => {
      const recovery = readPendingChatStopRecovery(target.organizationId, conversationId);
      if (recovery) stopRecoveryRetrierRef.current?.retryNow(recovery);
    };
    replayPendingStop();
    window.addEventListener("online", replayPendingStop);
    return () => window.removeEventListener("online", replayPendingStop);
  }, [target.conversationId, target.organizationId]);

  useEffect(() => {
    if (workingSince === null) {
      setWorkingSeconds(0);
      return;
    }
    const updateElapsed = () => setWorkingSeconds(Math.floor((Date.now() - workingSince) / 1000));
    updateElapsed();
    const interval = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(interval);
  }, [workingSince]);

  const updateTarget = useCallback((patch: Partial<GoalChatTarget>) => {
    const current = targetRef.current;
    const next = { ...current, ...patch } satisfies GoalChatTarget;
    targetRef.current = next;
    onReplaceTarget(sidePanelTargetKey(current), next);
  }, [onReplaceTarget]);

  const openFullChat = useCallback(() => {
    const conversationId = targetRef.current.conversationId;
    if (conversationId) navigate(`/messenger/chat/${conversationId}`);
  }, [navigate]);

  const handleSend = async (bodyOverride?: string) => {
    const body = (bodyOverride ?? draft).trim();
    const sendTarget = targetRef.current;
    if (!body || sending || !selectedAgent) return;
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    activeBodyRef.current = body;
    sendInFlightRef.current = true;
    setSending(true);
    setWorkingSince(Date.now());
    setError(null);
    setNotice(null);
    setFailedBody(null);
    setStreamBody("");
    let completedConversationId: string | null = null;
    try {
      const onEvent = async (event: Parameters<NonNullable<Parameters<typeof chatsApi.sendMessageStream>[2]["onEvent"]>>[0]) => {
        if (event.type === "ack") {
          setMessages((current) => [...current, event.userMessage]);
          const current = targetRef.current;
          updateTarget({
            conversationId: event.userMessage.conversationId,
            body: current.body === body ? "" : current.body,
          });
          setDraft((current) => current.trim() === body ? "" : current);
        }
        if (event.type === "assistant_delta") setStreamBody((current) => current + event.delta);
        if (event.type === "final") {
          setStreamBody("");
          setMessages((current) => [...current, ...event.messages]);
        }
        if (event.type === "error") throw new Error(event.error);
      };

      if (sendTarget.conversationId) {
        await chatsApi.sendMessageStream(sendTarget.conversationId, body, {
          onEvent,
          signal: abortController.signal,
        });
      } else {
        await chatsApi.sendFirstMessageStream(target.organizationId, body, {
          preferredAgentId: selectedAgent.id,
          issueCreationMode: "manual_approval",
          planMode: false,
          modelOverride: null,
          effortOverride: null,
          contextLinks: [{ entityType: "goal", entityId: target.goalId }],
          clientMutationId: target.clientMutationId,
          signal: abortController.signal,
          onEvent,
        });
      }
      completedConversationId = targetRef.current.conversationId ?? sendTarget.conversationId;
    } catch (sendError) {
      if (!abortController.signal.aborted) {
        setFailedBody(body);
        setError(chatErrorMessage(sendError, "side-chat"));
      }
    } finally {
      if (abortControllerRef.current === abortController) abortControllerRef.current = null;
      activeBodyRef.current = null;
      sendInFlightRef.current = false;
      setSending(false);
      setWorkingSince(null);
    }
    if (completedConversationId) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(target.organizationId, completedConversationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.chats.messages(target.organizationId, completedConversationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.goals.detail(target.goalId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(target.organizationId) }),
        queryClient.invalidateQueries({ queryKey: ["goals", "workspace", target.organizationId] }),
      ]);
    }
  };

  const refreshAfterStop = useCallback(async (organizationId: string, conversationId: string) => {
    await Promise.allSettled([
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(organizationId, conversationId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.messages(organizationId, conversationId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.queue(organizationId, conversationId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.goals.detail(target.goalId) }),
    ]);
  }, [queryClient, target.goalId]);

  const submitStopRecovery = useCallback((recovery: PendingChatStopRecovery) => {
    if (stopRequestInFlightRef.current) return;
    stopRequestInFlightRef.current = true;
    setStopping(true);
    setError(null);
    setNotice("Stopping response...");
    void (async () => {
      try {
        const result = await chatsApi.stopMessageStream(recovery.chatId, recovery.request);
        const acknowledgedActionId = result.controlActionId ?? recovery.request.controlActionId;
        if (acknowledgedActionId !== recovery.request.controlActionId) {
          setNotice("Stop confirmation pending. Rudder will retry automatically.");
          stopRecoveryRetrierRef.current?.schedule(recovery);
          return;
        }

        const disposition = result.disposition ?? "";
        const cutoffAccepted = result.stopped || [
          "startup_cancelled",
          "stopping",
          "stop_requested",
          "stopped",
          "interrupted_unverified",
        ].includes(disposition);
        const completionCommitted = !result.stopped && disposition === "completion_committed";
        clearPendingChatStopRecovery(recovery.orgId, recovery.chatId, recovery.request.controlActionId);
        stopRecoveryRetrierRef.current?.resolve(recovery);

        if (cutoffAccepted) {
          const body = activeBodyRef.current;
          abortControllerRef.current?.abort();
          setFailedBody(body);
          setNotice(result.stopped
            ? "Response stopped. Retry when ready or continue in full chat."
            : "Response frozen. Runtime termination could not be independently confirmed.");
        } else if (completionCommitted) {
          setFailedBody(null);
          setNotice("Response completed before Stop reached the cutoff.");
        } else {
          setNotice("No active response was available to stop.");
        }
        await refreshAfterStop(recovery.orgId, recovery.chatId);
      } catch (stopError) {
        const definitivelyRejected = stopError instanceof ApiError
          && stopError.status >= 400
          && stopError.status < 500;
        if (definitivelyRejected) {
          clearPendingChatStopRecovery(recovery.orgId, recovery.chatId, recovery.request.controlActionId);
          stopRecoveryRetrierRef.current?.resolve(recovery);
          setNotice(null);
          setError(`Stop was rejected. ${stopError.message}`);
        } else {
          setNotice("Stop confirmation pending. Rudder will retry automatically.");
          setError(null);
          stopRecoveryRetrierRef.current?.schedule(recovery);
        }
      } finally {
        stopRequestInFlightRef.current = false;
        setStopping(false);
      }
    })();
  }, [refreshAfterStop]);
  submitStopRecoveryRef.current = submitStopRecovery;

  const handleStop = () => {
    if (!sending || stopping) return;
    const currentTarget = targetRef.current;
    const conversationId = currentTarget.conversationId;
    if (!conversationId) {
      setNotice("Stop becomes available as soon as this Chat starts.");
      return;
    }
    const existingRecovery = readPendingChatStopRecovery(currentTarget.organizationId, conversationId);
    if (existingRecovery) {
      stopRecoveryRetrierRef.current?.retryNow(existingRecovery);
      return;
    }
    const activeGenerationId = activeGenerationIdFromSnapshot(queueQuery.data);
    const hasFence = activeGenerationId
      && queueQuery.data?.activeAttemptEpoch !== null
      && queueQuery.data?.activeAttemptEpoch !== undefined
      && queueQuery.data?.activeControlVersion !== null
      && queueQuery.data?.activeControlVersion !== undefined;
    const recovery = createPendingChatStopRecovery({
      orgId: currentTarget.organizationId,
      chatId: conversationId,
      request: {
        controlActionId: globalThis.crypto.randomUUID(),
        ...(hasFence ? {
          expectedGenerationId: activeGenerationId,
          expectedAttemptEpoch: queueQuery.data!.activeAttemptEpoch!,
          expectedControlVersion: queueQuery.data!.activeControlVersion!,
        } : {}),
      },
      frozenDraft: null,
    });
    savePendingChatStopRecovery(recovery);
    submitStopRecovery(recovery);
  };

  const canSend = Boolean(draft.trim() && selectedAgent && !sending);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="goal-chat-panel">
      <div className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          <div className="flex min-w-0 items-center gap-2 border-b border-border/70 pb-3">
            <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">Chat about Goal</div>
              <div className="truncate text-xs text-muted-foreground">{target.label}</div>
            </div>
            {target.conversationId ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label="Open full chat"
                title="Open full chat"
                onClick={() => navigate(`/messenger/chat/${target.conversationId}`)}
              >
                <ExternalLink className="h-4 w-4" />
                <span className="hidden sm:inline">Open full chat</span>
              </Button>
            ) : null}
          </div>

          {target.conversationId && (conversationQuery.isPending || messagesQuery.isPending) ? (
            <p className="text-sm text-muted-foreground">Loading conversation...</p>
          ) : null}
          {loadError ? (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-2 text-sm text-destructive">
              <span>{loadError instanceof Error ? loadError.message : "Could not load this conversation."}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void Promise.all([conversationQuery.refetch(), messagesQuery.refetch()])}
              >
                Retry
              </Button>
            </div>
          ) : null}
          {!target.conversationId && messages.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No messages yet.</p>
          ) : null}

          {conversation ? messages.map((message) => {
            const transcript = transcriptEntries(message);
            return (
              <div key={message.id} data-testid="goal-chat-message">
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
                  conversation={conversation}
                  message={message}
                  agents={agentsQuery.data}
                  decisionNote={decisionNotes[message.id] ?? ""}
                  onDecisionNoteChange={(value) => setDecisionNotes((current) => ({ ...current, [message.id]: value }))}
                  decisionNoteMentions={[]}
                  onDecisionNoteMentionQueryChange={noop}
                  onDecisionNoteInlineTokenClick={noop}
                  onApprovalAction={openFullChat}
                  onIssueProposalChange={openFullChat}
                  onResolveOperationProposal={openFullChat}
                  onConvertToIssue={openFullChat}
                  actionPending={false}
                  onCopyMessageText={(text) => navigator.clipboard?.writeText(text)}
                  onRetryFailedMessage={openFullChat}
                  onOpenFile={openFullChat}
                  onSelectResponseAnnotation={(annotation) => {
                    if (annotation.surface !== "agent_run_transcript") return;
                    navigate(`/agents/${annotation.sourceAgentId}/runs/${annotation.sourceRunId}`);
                  }}
                  skillReferences={[]}
                />
              </div>
            );
          }) : messages.map((message) => (
            <div
              key={message.id}
              className={`rounded-md border px-3 py-2 text-sm ${message.role === "user" ? "ml-6 bg-muted/30" : "mr-6"}`}
            >
              <div className="mb-1 text-xs text-muted-foreground">{message.role === "user" ? "You" : selectedAgent?.name ?? "Agent"}</div>
              <div className="whitespace-pre-wrap break-words">{messageBody(message)}</div>
            </div>
          ))}
          {streamBody ? (
            <div data-testid="goal-chat-streaming" className="mr-6 whitespace-pre-wrap break-words text-sm text-foreground">
              {streamBody}
            </div>
          ) : null}
          {sending ? (
            <div role="status" data-testid="goal-chat-working" className="mr-6 flex items-center gap-2 rounded-lg border border-border bg-muted/25 px-3 py-2.5">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {workingSeconds >= 30 ? "Still working on this Goal..." : `${selectedAgent?.name ?? "Agent"} is working...`}
                </p>
                {targetRef.current.conversationId ? <p className="text-xs text-muted-foreground">You can keep this panel open or continue in full chat.</p> : null}
              </div>
            </div>
          ) : null}
          <div ref={endRef} />
        </div>
      </div>

      {notice ? <div role="status" className="px-4 pb-2 text-sm text-muted-foreground">{notice}</div> : null}
      {error || failedBody ? (
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-2">
          {error ? <span role="alert" className="text-sm text-destructive">{error}</span> : <span />}
          <div className="flex items-center gap-2">
            {failedBody ? (
              <Button type="button" size="sm" variant="outline" disabled={sending} onClick={() => void handleSend(failedBody)}>
                Retry message
              </Button>
            ) : null}
            {target.conversationId ? (
              <Button type="button" size="sm" variant="ghost" onClick={openFullChat}>Open full chat</Button>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="shrink-0 px-4 pb-4">
        {ownerUnavailable ? (
          <p role="alert" className="mx-auto mb-2 max-w-3xl text-sm text-destructive">
            The Goal Owner is unavailable. Reassign the Goal before starting a chat.
          </p>
        ) : null}
        <ChatComposerSurface className="mx-auto max-w-3xl" testId="goal-chat-composer">
          <ChatComposerEditor
            value={draft}
            onChange={(value) => {
              if (sending) return;
              setDraft(value);
              updateTarget({ body: value });
            }}
            placeholder="Message about this Goal..."
            onSubmit={() => void handleSend()}
          />
          <ChatComposerToolbar
            actions={(
              <ChatComposerSendButton
                mode={sending ? (stopping ? "stopping" : "stop") : "send"}
                ariaLabel={sending
                  ? stopping
                    ? "Stopping response"
                    : target.conversationId
                      ? "Stop streaming"
                      : "Stop unavailable until chat starts"
                  : "Send message"}
                disabled={sending ? stopping || !target.conversationId : !canSend}
                onClick={() => void (sending ? handleStop() : handleSend())}
              />
            )}
          >
            {selectedAgent ? (
              <AgentIdentity name={selectedAgent.name} icon={selectedAgent.icon} role={selectedAgent.role} size="sm" className="min-w-0" />
            ) : (
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {agentsQuery.isPending ? "Loading Agent..." : ownerUnavailable ? "Owner unavailable" : "No Agent available"}
              </span>
            )}
          </ChatComposerToolbar>
        </ChatComposerSurface>
      </div>
    </div>
  );
}
