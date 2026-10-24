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
import { ChatSendRecoveryNotice, ChatSendRecoveryProblem, type ChatSendRecovery } from "@/components/chat/ChatSendRecoveryNotice";
import { useChatSendRecoveryDiscovery } from "@/components/chat/useChatSendRecoveryDiscovery";
import { Button } from "@/components/ui/button";
import type { ChatStreamDraft } from "@/context/ChatGenerationContext";
import { chatClientCheckpointKey, createChatClientCheckpointDispatcher } from "@/lib/chat-client-checkpoints";
import { chatErrorMessage } from "@/lib/chat-errors";
import * as chatSendMutationStorage from "@/lib/chat-send-mutation-storage";
import { settleStoppedChatInput } from "@/lib/chat-send-recovery-settlement";
import {
  CHAT_RECOVERY_STATUS_CHECKING_MESSAGE,
  CHAT_RECOVERY_STATUS_UNAVAILABLE_MESSAGE,
  CHAT_STOP_CONFIRMATION_PENDING_MESSAGE,
  CHAT_STOP_OWNER_LOST_MESSAGE,
  CHAT_STOP_REJECTED_MESSAGE,
  CHAT_STOP_REQUIRES_FRESH_ACTION_MESSAGE,
  CHAT_STOP_TARGET_UNVERIFIED_MESSAGE,
} from "@/lib/chat-stop-feedback";
import {
  clearPendingChatStopRecovery,
  createChatStopRecoveryRetrier,
  createPendingChatStopRecovery,
  hasCompleteNativeStopFence,
  hydrateIncompleteNativeChatStopRecovery,
  readPendingChatStopRecovery,
  savePendingChatStopRecovery,
  type PendingChatStopRecovery,
} from "@/lib/chat-stop-recovery";
import { queryKeys } from "@/lib/queryKeys";
import { useNavigate } from "@/lib/router";
import { sidePanelTargetKey, type SidePanelTarget } from "@/lib/side-panel-targets";
import { useNativeChatRecovery } from "@/lib/use-native-chat-recovery";
import { ChatMessageItem, StreamTranscriptItem } from "@/pages/Chat.messages";
import { mergeChatMessages } from "@/pages/Chat.parts";
import { activeGenerationIdFromSnapshot, applyChatStreamProgressEvent, EMPTY_CHAT_BODY_SHA256 } from "@/pages/Chat.workspace-helpers";
import type { ChatConversation, ChatMessage } from "@rudderhq/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, MessageSquare } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

type GoalChatTarget = Extract<SidePanelTarget, { kind: "goal_chat" }>;

function goalSendTargetScope(target: GoalChatTarget) {
  return JSON.stringify([
    target.organizationId,
    target.goalId,
    target.agentId,
    target.conversationId ?? null,
  ]);
}

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
  const [checkpointRevision, setCheckpointRevision] = useState(0);
  const [sending, setSending] = useState(false);
  const [workingSince, setWorkingSince] = useState<number | null>(null);
  const [workingSeconds, setWorkingSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sendRecovery, setSendRecovery] = useState<ChatSendRecovery | null>(null);
  const recoveryDiscovery = useChatSendRecoveryDiscovery(target.conversationId
    ? { orgId: target.organizationId, conversationId: target.conversationId }
    : null);
  const activeSendRecovery = sendRecovery ?? recoveryDiscovery.recovery;
  const [failedBody, setFailedBody] = useState<string | null>(null);
  const [failedUserMessageId, setFailedUserMessageId] = useState<string | null>(null);
  const [confirmedOwnerLoss, setConfirmedOwnerLoss] = useState<{
    conversationId: string;
    generationId: string;
    recoveryReadUpdatedAt: number;
  } | null>(null);
  const [stopping, setStopping] = useState(false);
  const [decisionNotes, setDecisionNotes] = useState<Record<string, string>>({});
  const targetRef = useRef(target);
  const renderedTargetScopeRef = useRef(goalSendTargetScope(target));
  const expectedTargetScopeRef = useRef(goalSendTargetScope(target));
  const sendOperationRef = useRef(0);
  const streamDraftRef = useRef<ChatStreamDraft | null>(null);
  const checkpointDispatcherRef = useRef<ReturnType<typeof createChatClientCheckpointDispatcher> | null>(null);
  if (!checkpointDispatcherRef.current) {
    checkpointDispatcherRef.current = createChatClientCheckpointDispatcher((checkpoint) => {
      const { chatId, ...request } = checkpoint;
      return chatsApi.checkpointMessageStream(chatId, request);
    });
  }
  const checkpointDispatcher = checkpointDispatcherRef.current;
  const sendInFlightRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const ownerLostStopRef = useRef(false);
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

  useEffect(() => {
    const nextScope = goalSendTargetScope(target);
    if (renderedTargetScopeRef.current === nextScope) return;
    renderedTargetScopeRef.current = nextScope;
    if (expectedTargetScopeRef.current === nextScope) return;
    expectedTargetScopeRef.current = nextScope;
    sendOperationRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    activeBodyRef.current = null;
    sendInFlightRef.current = false;
    setSending(false);
    setWorkingSince(null);
    setError(null);
    setNotice(null);
    setSendRecovery(null);
    setFailedBody(null);
    setFailedUserMessageId(null);
    setMessages([]);
    streamDraftRef.current = null;
    checkpointDispatcher.retain(new Set());
    setStreamBody("");
    setDraft(target.body);
  }, [checkpointDispatcher, target]);

  useLayoutEffect(() => {
    const activeCheckpointKeys = new Set<string>();
    const current = streamDraftRef.current;
    if (current
      && ["streaming", "tool_busy", "finalizing"].includes(current.state)
      && current.chatId
      && current.generationId
      && Number.isSafeInteger(current.attemptEpoch)
      && current.attemptEpoch != null
      && Number.isSafeInteger(current.lastCommittedRenderSeq)
      && current.lastCommittedRenderSeq != null
      && current.lastCommittedRenderSeq >= 0
      && typeof current.renderedBodyHash === "string"
      && /^[0-9a-f]{64}$/u.test(current.renderedBodyHash)) {
      const checkpoint = {
        chatId: current.chatId,
        generationId: current.generationId,
        attemptEpoch: current.attemptEpoch,
        generationSeq: current.lastCommittedRenderSeq,
        renderedBodyHash: current.renderedBodyHash,
      };
      activeCheckpointKeys.add(chatClientCheckpointKey(checkpoint));
      checkpointDispatcher.enqueue(checkpoint);
    }
    checkpointDispatcher.retain(activeCheckpointKeys);
  }, [checkpointDispatcher, checkpointRevision]);

  useEffect(() => () => checkpointDispatcher.dispose(), [checkpointDispatcher]);

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
  const nativeRecoveryQuery = useNativeChatRecovery(target.organizationId, target.conversationId ?? null);
  const ownerLost = nativeRecoveryQuery.recovery !== null
    || Boolean(target.conversationId
      && confirmedOwnerLoss?.conversationId === target.conversationId
      && (nativeRecoveryQuery.status.kind !== "native"
        || nativeRecoveryQuery.dataUpdatedAt <= confirmedOwnerLoss.recoveryReadUpdatedAt
        || nativeRecoveryQuery.recovery !== null));
  const nativeRecoveryUnavailable = nativeRecoveryQuery.unavailable;
  const nativeRecoveryChecking = Boolean(target.conversationId && nativeRecoveryQuery.status.kind === "checking");

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
    expectedTargetScopeRef.current = goalSendTargetScope(next);
    targetRef.current = next;
    onReplaceTarget(sidePanelTargetKey(current), next);
  }, [onReplaceTarget]);

  const openFullChat = useCallback(() => {
    const conversationId = targetRef.current.conversationId;
    if (conversationId) navigate(`/messenger/chat/${conversationId}`);
  }, [navigate]);

  const handleSend = async (bodyOverride?: string, retryUserMessageId?: string | null, resumeClientMutationId?: string) => {
    const isResume = Boolean(resumeClientMutationId);
    const body = (bodyOverride ?? draft).trim();
    const sendTarget = targetRef.current;
    let expectedConversationId = sendTarget.conversationId;
    if (ownerLost && sendTarget.conversationId) {
      setNotice(CHAT_STOP_OWNER_LOST_MESSAGE);
      return;
    }
    if (nativeRecoveryUnavailable && sendTarget.conversationId) {
      setNotice(CHAT_RECOVERY_STATUS_UNAVAILABLE_MESSAGE);
      return;
    }
    if (nativeRecoveryChecking && sendTarget.conversationId) {
      return;
    }
    ownerLostStopRef.current = false;
    if (!body || sending || (activeSendRecovery && !isResume)
      || (recoveryDiscovery.checking && !isResume)
      || (recoveryDiscovery.problem && !isResume) || !selectedAgent) return;
    const sendOperation = ++sendOperationRef.current;
    const streamKey = `goal-chat:${sendOperation}`;
    const streamStartedAt = new Date();
    streamDraftRef.current = {
      chatId: sendTarget.conversationId,
      streamKey,
      userBody: body,
      userCreatedAt: streamStartedAt,
      userMessageId: retryUserMessageId ?? null,
      chatTurnId: null,
      turnVariant: 0,
      editedFromCreatedAt: null,
      body: "",
      generationId: null,
      attemptEpoch: null,
      renderedBodyHash: EMPTY_CHAT_BODY_SHA256,
      state: "streaming",
      createdAt: streamStartedAt,
      transcript: [],
      replyingAgentId: selectedAgent.id,
    };
    const abortController = new AbortController();
    const isCurrentSendTarget = () => {
      const current = targetRef.current;
      return sendOperationRef.current === sendOperation
        && !abortController.signal.aborted
        && current.organizationId === sendTarget.organizationId
        && current.goalId === sendTarget.goalId
        && current.agentId === sendTarget.agentId
        && current.conversationId === expectedConversationId;
    };
    abortControllerRef.current = abortController;
    activeBodyRef.current = body;
    sendInFlightRef.current = true;
    setSending(true);
    setWorkingSince(Date.now());
    setError(null);
    setNotice(null);
    setFailedBody(null);
    setFailedUserMessageId(null);
    setStreamBody("");
    let committedUserMessageId = retryUserMessageId ?? null;
    let completedConversationId: string | null = null;
    let pendingSend: Awaited<ReturnType<typeof chatSendMutationStorage.preparePendingChatSendMutation>> | null = null;
    let mutationAcknowledged = false;
    let mutationTerminal = false;
    let requestDispatched = false;
    try {
      let userMessageAcknowledged = false;
      const onEvent = async (event: Parameters<NonNullable<Parameters<typeof chatsApi.sendMessageStream>[2]["onEvent"]>>[0]) => {
        if (!isCurrentSendTarget()) return;
        if (event.type === "ack") {
          userMessageAcknowledged = true;
          mutationAcknowledged = true;
          committedUserMessageId = event.userMessage.id;
          const currentStream = streamDraftRef.current;
          if (currentStream?.streamKey === streamKey) {
            streamDraftRef.current = {
              ...currentStream,
              chatId: event.userMessage.conversationId,
              userMessageId: event.userMessage.id,
              generationId: event.generationId ?? currentStream.generationId ?? null,
              attemptEpoch: event.attemptEpoch ?? currentStream.attemptEpoch ?? null,
              lastCommittedRenderSeq: event.generationSeq ?? currentStream.lastCommittedRenderSeq,
              renderedBodyHash: event.bodyHash ?? currentStream.renderedBodyHash ?? EMPTY_CHAT_BODY_SHA256,
            };
            setCheckpointRevision((revision) => revision + 1);
          }
          setMessages((current) => [...current, event.userMessage]);
          expectedConversationId = event.userMessage.conversationId;
          const current = targetRef.current;
          updateTarget({
            conversationId: event.userMessage.conversationId,
            body: !isResume && current.body === body ? "" : current.body,
          });
          if (!isResume) setDraft((current) => current.trim() === body ? "" : current);
        }
        if (event.type === "error" && !userMessageAcknowledged && event.messageId) {
          committedUserMessageId = event.messageId;
        }
        if (event.type === "assistant_delta" || event.type === "assistant_snapshot") {
          const currentStream = streamDraftRef.current;
          if (currentStream?.streamKey === streamKey) {
            const nextStream = applyChatStreamProgressEvent(currentStream, streamKey, event);
            if (nextStream && nextStream !== currentStream) {
              streamDraftRef.current = nextStream;
              setStreamBody(nextStream.body);
              setCheckpointRevision((revision) => revision + 1);
            }
          }
        }
        if (event.type === "final") {
          mutationTerminal = true;
          if (streamDraftRef.current?.streamKey === streamKey) streamDraftRef.current = null;
          checkpointDispatcher.retain(new Set());
          if (pendingSend) await pendingSend.settle();
          setSendRecovery(null);
          setStreamBody("");
          setMessages((current) => [...current, ...event.messages]);
        }
        if (event.type === "error") {
          if (event.terminal) {
            mutationTerminal = true;
            if (streamDraftRef.current?.streamKey === streamKey) streamDraftRef.current = null;
            checkpointDispatcher.retain(new Set());
          }
          throw new Error(event.error);
        }
      };

      if (sendTarget.conversationId) {
        pendingSend = await chatSendMutationStorage.preparePendingChatSendMutation({
          orgId: sendTarget.organizationId,
          conversationId: sendTarget.conversationId,
          editUserMessageId: retryUserMessageId,
          reconcilePendingMutation: (clientMutationId, exactBody) => chatsApi.reconcilePendingMessageSend(sendTarget.conversationId!, {
            clientMutationId,
            body: exactBody,
          }),
          body,
          files: [],
          inlineAnnotations: [],
          resumeClientMutationId,
        });
        if (!isCurrentSendTarget()) {
          return;
        }
        if (pendingSend.status === "recovered") {
          const recoveredMessage = pendingSend.reconciliation?.outcome === "accepted"
            ? pendingSend.reconciliation.message
            : null;
          if (recoveredMessage) setMessages((current) => mergeChatMessages(current, [recoveredMessage]));
          if (!isResume) setDraft((current) => current || body);
          setSendRecovery(null);
          setNotice("The earlier response already reached a terminal state. Your current draft was not sent.");
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(sendTarget.organizationId, sendTarget.conversationId) }),
            queryClient.invalidateQueries({ queryKey: queryKeys.chats.messages(sendTarget.organizationId, sendTarget.conversationId) }),
          ]).catch(() => undefined);
          return;
        }
        if (pendingSend.status === "resume_required") {
          if (!isResume) setDraft((current) => current || body);
          setSendRecovery({
            clientMutationId: pendingSend.clientMutationId,
            body: pendingSend.recoveryBody ?? (pendingSend.reconciliation?.outcome === "accepted"
              ? pendingSend.reconciliation.message.body
              : body),
            action: "resume",
          });
          setNotice("The earlier message was accepted and is still unresolved. Resume its response below; the current draft was not sent.");
          const acceptedMessage = pendingSend.reconciliation?.outcome === "accepted"
            ? pendingSend.reconciliation.message
            : null;
          if (acceptedMessage) setMessages((current) => mergeChatMessages(current, [acceptedMessage]));
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(sendTarget.organizationId, sendTarget.conversationId) }),
            queryClient.invalidateQueries({ queryKey: queryKeys.chats.messages(sendTarget.organizationId, sendTarget.conversationId) }),
          ]).catch(() => undefined);
          return;
        }
        if (pendingSend.status === "retry_required") {
          if (!isResume) setDraft((current) => current || body);
          setSendRecovery({
            clientMutationId: pendingSend.clientMutationId,
            body: pendingSend.recoveryBody ?? body,
            action: "retry",
          });
          setNotice("Rudder confirmed the earlier message was not accepted. Retry that exact message below; your current draft was not sent.");
          return;
        }
        requestDispatched = true;
        await chatsApi.sendMessageStream(sendTarget.conversationId, body, {
          clientMutationId: pendingSend.clientMutationId,
          editUserMessageId: retryUserMessageId,
          onEvent: async (event) => {
            if (event.type === "ack") {
              mutationAcknowledged = true;
              await pendingSend!.markAccepted();
            } else if (event.type === "queued") {
              mutationAcknowledged = true;
              await pendingSend!.markAccepted();
            } else if (event.type === "error") {
              if (event.messageId) {
                mutationAcknowledged = true;
                await pendingSend!.markAccepted();
              }
              if (event.terminal) {
                mutationTerminal = true;
                await pendingSend!.settle();
                setSendRecovery(null);
              } else if (mutationAcknowledged) {
                await pendingSend!.markRecoverable();
                setSendRecovery({ clientMutationId: pendingSend!.clientMutationId, body });
              }
            }
            await onEvent(event);
          },
          signal: abortController.signal,
        });
        if (mutationAcknowledged && !mutationTerminal) {
          await pendingSend.markRecoverable();
          setSendRecovery({ clientMutationId: pendingSend.clientMutationId, body });
          throw new Error("The message was accepted, but Rudder did not confirm the response's terminal state. Resume the response without sending it again.");
        }
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
      if (isCurrentSendTarget()) {
        completedConversationId = targetRef.current.conversationId ?? sendTarget.conversationId;
      }
    } catch (sendError) {
      if (!ownerLostStopRef.current && pendingSend && requestDispatched && !mutationAcknowledged && !mutationTerminal) {
        await pendingSend.markUnknown();
      }
      if (!ownerLostStopRef.current && pendingSend && mutationAcknowledged && !mutationTerminal) {
        await pendingSend.markRecoverable();
        setSendRecovery({ clientMutationId: pendingSend.clientMutationId, body });
      }
      if (!abortController.signal.aborted && isCurrentSendTarget()) {
        if (pendingSend && requestDispatched && !mutationAcknowledged && !mutationTerminal) {
          recoveryDiscovery.retry();
        }
        if (sendError instanceof chatSendMutationStorage.PendingChatSendAlreadyAcceptedError) {
          setDraft((current) => current || body);
          setFailedBody(null);
          setFailedUserMessageId(null);
          setError(null);
          setNotice(`${sendError.message} The recovered message is being refreshed below.`);
          if (sendTarget.conversationId) {
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(sendTarget.organizationId, sendTarget.conversationId) }),
              queryClient.invalidateQueries({ queryKey: queryKeys.chats.messages(sendTarget.organizationId, sendTarget.conversationId) }),
            ]).catch(() => undefined);
          }
        } else {
          setFailedBody(body);
          setFailedUserMessageId(committedUserMessageId);
          setError(chatErrorMessage(sendError, "side-chat"));
        }
      }
    } finally {
      if (sendOperationRef.current === sendOperation) {
        if (mutationTerminal || abortController.signal.aborted) {
          checkpointDispatcher.retain(new Set());
        }
        if (abortControllerRef.current === abortController) abortControllerRef.current = null;
        activeBodyRef.current = null;
        sendInFlightRef.current = false;
        setSending(false);
        setWorkingSince(null);
      }
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
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.nativeRecovery(organizationId, conversationId) }),
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
      let recoveryToSubmit = recovery;
      try {
        if (recoveryToSubmit.executionAuthority !== "legacy_ts"
          && !hasCompleteNativeStopFence(recoveryToSubmit.request)) {
          const generationId = recoveryToSubmit.request.expectedGenerationId
            ?? recoveryToSubmit.frozenDraft?.generationId
            ?? null;
          const attemptEpoch = recoveryToSubmit.request.expectedAttemptEpoch
            ?? recoveryToSubmit.frozenDraft?.attemptEpoch
            ?? null;
          let control: Awaited<ReturnType<typeof chatsApi.readNativeChatControl>> | null = null;
          if (generationId && attemptEpoch) {
            try {
              control = await chatsApi.readNativeChatControl(recoveryToSubmit.chatId, recoveryToSubmit.orgId, generationId);
            } catch {
              // Do not replay an incomplete old action when its original
              // generation and attempt cannot be revalidated.
            }
          }
          const hydratedRecovery = hydrateIncompleteNativeChatStopRecovery(
            recoveryToSubmit,
            control,
            EMPTY_CHAT_BODY_SHA256,
          );
          if (!hydratedRecovery) {
            clearPendingChatStopRecovery(
              recoveryToSubmit.orgId,
              recoveryToSubmit.chatId,
              recoveryToSubmit.request.controlActionId,
            );
            stopRecoveryRetrierRef.current?.resolve(recoveryToSubmit);
            setNotice(null);
            setError(CHAT_STOP_REQUIRES_FRESH_ACTION_MESSAGE);
            await refreshAfterStop(recoveryToSubmit.orgId, recoveryToSubmit.chatId);
            return;
          }
          recoveryToSubmit = hydratedRecovery;
          if (!savePendingChatStopRecovery(recoveryToSubmit)) {
            throw new Error("The saved Stop request could not be refreshed safely.");
          }
        }

        const nativeStop = recoveryToSubmit.executionAuthority !== "legacy_ts";
        const result = await chatsApi.stopMessageStream(recoveryToSubmit.chatId, recoveryToSubmit.request);
        const acknowledgedActionId = nativeStop
          ? result.controlActionId
          : result.controlActionId ?? recoveryToSubmit.request.controlActionId;
        if (acknowledgedActionId !== recoveryToSubmit.request.controlActionId
            || (nativeStop && (!recoveryToSubmit.request.expectedGenerationId
              || !result.generationId
              || result.generationId !== recoveryToSubmit.request.expectedGenerationId))) {
          setNotice(CHAT_STOP_CONFIRMATION_PENDING_MESSAGE);
          stopRecoveryRetrierRef.current?.schedule(recoveryToSubmit);
          return;
        }

        if (nativeStop && result.disposition === "control_lost") {
          ownerLostStopRef.current = true;
          setConfirmedOwnerLoss({
            conversationId: recoveryToSubmit.chatId,
            generationId: result.generationId!,
            recoveryReadUpdatedAt: nativeRecoveryQuery.dataUpdatedAt,
          });
          const inputSettled = await settleStoppedChatInput(recoveryToSubmit);
          clearPendingChatStopRecovery(
            recoveryToSubmit.orgId,
            recoveryToSubmit.chatId,
            recoveryToSubmit.request.controlActionId,
          );
          stopRecoveryRetrierRef.current?.resolve(recoveryToSubmit);
          if (inputSettled) {
            setSendRecovery(null);
            recoveryDiscovery.clearRecovery();
          }
          abortControllerRef.current?.abort();
          setFailedBody(null);
          setFailedUserMessageId(null);
          setError(null);
          setNotice(CHAT_STOP_OWNER_LOST_MESSAGE);
          await refreshAfterStop(recoveryToSubmit.orgId, recoveryToSubmit.chatId);
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
        const stopped = result.stopped && (!nativeStop || disposition === "stopped");
        const alreadyTerminal = !result.stopped && disposition === "no_active_generation";
        const terminalConfirmed = nativeStop
          ? stopped || completionCommitted || alreadyTerminal
          : cutoffAccepted || completionCommitted || alreadyTerminal;

        if (nativeStop && !terminalConfirmed) {
          if (cutoffAccepted) {
            const body = activeBodyRef.current;
            abortControllerRef.current?.abort();
            setFailedBody(body);
          }
          setNotice(CHAT_STOP_CONFIRMATION_PENDING_MESSAGE);
          stopRecoveryRetrierRef.current?.schedule(recoveryToSubmit);
          return;
        }

        clearPendingChatStopRecovery(
          recoveryToSubmit.orgId,
          recoveryToSubmit.chatId,
          recoveryToSubmit.request.controlActionId,
        );
        stopRecoveryRetrierRef.current?.resolve(recoveryToSubmit);

        if (stopped || (!nativeStop && cutoffAccepted)) {
          const body = activeBodyRef.current;
          abortControllerRef.current?.abort();
          setFailedBody(body);
          setNotice(stopped
            ? "Response stopped. Retry when ready or continue in full chat."
            : "Response frozen. Runtime termination could not be independently confirmed.");
        } else if (completionCommitted) {
          setFailedBody(null);
          setNotice("Response completed before Stop reached the cutoff.");
        } else if (alreadyTerminal) {
          setFailedBody(null);
          setNotice("The response had already ended.");
        } else {
          setNotice("No active response was available to stop.");
        }
        await refreshAfterStop(recoveryToSubmit.orgId, recoveryToSubmit.chatId);
      } catch (stopError) {
        const definitivelyRejected = stopError instanceof ApiError
          && stopError.status >= 400
          && stopError.status < 500;
        if (definitivelyRejected) {
          const nativeStop = recoveryToSubmit.executionAuthority !== "legacy_ts";
          if (!nativeStop) {
            clearPendingChatStopRecovery(recoveryToSubmit.orgId, recoveryToSubmit.chatId, recoveryToSubmit.request.controlActionId);
            stopRecoveryRetrierRef.current?.resolve(recoveryToSubmit);
            setNotice(null);
            setError(CHAT_STOP_REJECTED_MESSAGE);
          } else {
            setNotice(CHAT_STOP_CONFIRMATION_PENDING_MESSAGE);
            setError(null);
            stopRecoveryRetrierRef.current?.schedule(recoveryToSubmit);
          }
        } else {
          setNotice(CHAT_STOP_CONFIRMATION_PENDING_MESSAGE);
          setError(null);
          stopRecoveryRetrierRef.current?.schedule(recoveryToSubmit);
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
    if (stopRequestInFlightRef.current) return;
    const stopTargetScope = goalSendTargetScope(currentTarget);
    const stopSendOperation = sendOperationRef.current;
    const isCurrentStopTarget = () => sendOperationRef.current === stopSendOperation
      && goalSendTargetScope(targetRef.current) === stopTargetScope;
    setStopping(true);
    setError(null);
    setNotice("Checking the active response...");
    void (async () => {
      try {
        const currentStream = streamDraftRef.current;
        const queueKey = queryKeys.chats.queue(currentTarget.organizationId, conversationId);
        let latestQueue = queryClient.getQueryData<typeof queueQuery.data>(queueKey) ?? queueQuery.data;
        let activeGenerationId = activeGenerationIdFromSnapshot(latestQueue) ?? currentStream?.generationId ?? null;
        if (!activeGenerationId) {
          latestQueue = await chatsApi.listQueue(conversationId);
          queryClient.setQueryData(queueKey, latestQueue);
          activeGenerationId = activeGenerationIdFromSnapshot(latestQueue);
        }
        if (!activeGenerationId || !isCurrentStopTarget()) {
          throw new Error("The active response could not be identified");
        }
        const capabilities = await chatsApi.getNativeChatCapabilities();
        if (!isCurrentStopTarget()) throw new Error("The Goal chat changed during Stop verification");
        let executionAuthority: "native_rust" | "legacy_ts";
        let request: PendingChatStopRecovery["request"];
        if (capabilities === null) {
          executionAuthority = "legacy_ts";
          const queueFence = latestQueue?.activeGenerationId === activeGenerationId
            && latestQueue.activeAttemptEpoch != null
            && latestQueue.activeControlVersion != null
            ? {
                expectedGenerationId: activeGenerationId,
                expectedAttemptEpoch: latestQueue.activeAttemptEpoch,
                expectedControlVersion: latestQueue.activeControlVersion,
              }
            : {};
          request = {
            controlActionId: globalThis.crypto.randomUUID(),
            ...queueFence,
            ...(currentStream?.generationId === activeGenerationId ? {
              lastCommittedRenderSeq: currentStream.lastCommittedRenderSeq ?? 0,
              renderedBodyHash: currentStream.renderedBodyHash ?? EMPTY_CHAT_BODY_SHA256,
            } : {}),
          };
        } else {
          if (!capabilities.readTurn) {
            throw new Error("This server cannot verify the active response before Stop.");
          }
          const control = await chatsApi.readNativeChatControl(
            conversationId,
            currentTarget.organizationId,
            activeGenerationId,
          );
          if (!isCurrentStopTarget()) throw new Error("The Goal chat changed during Stop verification");
          if (control.orgId !== currentTarget.organizationId
            || control.conversationId !== conversationId
            || control.generationId !== activeGenerationId
            || (currentStream?.generationId && currentStream.generationId !== activeGenerationId)
            || (currentStream?.attemptEpoch != null && currentStream.attemptEpoch !== control.attemptEpoch)
            || control.runtimeTerminal) {
            throw new Error("Stop target changed during verification");
          }
          if (latestQueue?.activeGenerationId && latestQueue.activeGenerationId !== activeGenerationId) {
            throw new Error("A newer response is active");
          }
          if (latestQueue?.activeGenerationId === activeGenerationId && (
            (latestQueue.activeAttemptEpoch != null && latestQueue.activeAttemptEpoch !== control.attemptEpoch)
            || (latestQueue.activeControlVersion != null && latestQueue.activeControlVersion !== control.controlVersion)
          )) {
            throw new Error("The active response attempt changed");
          }
          executionAuthority = control.executionAuthority;
          if (control.executionAuthority === "native_rust" && !capabilities.nativeControls) {
            throw new Error("Native Stop is not enabled on this server");
          }

          const draftCutoffIsValid = control.executionAuthority === "native_rust"
            && currentStream?.generationId === activeGenerationId
            && currentStream.attemptEpoch === control.attemptEpoch
            && Number.isSafeInteger(currentStream.lastCommittedRenderSeq)
            && Number(currentStream.lastCommittedRenderSeq) >= 0
            && Number(currentStream.lastCommittedRenderSeq) <= control.lastSequence
            && typeof currentStream.renderedBodyHash === "string"
            && /^[0-9a-f]{64}$/u.test(currentStream.renderedBodyHash);
          const checkpointIsValid = control.executionAuthority === "native_rust"
            && control.lastClientCheckpointSeq !== null
            && Number.isSafeInteger(control.lastClientCheckpointSeq)
            && control.lastClientCheckpointSeq >= 0
            && control.lastClientCheckpointSeq <= control.lastSequence
            && typeof control.lastClientCheckpointHash === "string"
            && /^[0-9a-f]{64}$/u.test(control.lastClientCheckpointHash);
          const cutoff = draftCutoffIsValid
            ? {
                sequence: currentStream.lastCommittedRenderSeq!,
                hash: currentStream.renderedBodyHash!,
              }
            : checkpointIsValid
              ? {
                  sequence: control.lastClientCheckpointSeq!,
                  hash: control.lastClientCheckpointHash!,
                }
              : currentStream?.body.length
                ? null
                : control.executionAuthority === "native_rust"
                  ? { sequence: 0, hash: EMPTY_CHAT_BODY_SHA256 }
                  : null;
          if (control.executionAuthority === "native_rust" && !cutoff) {
            throw new Error("The visible response cutoff could not be verified");
          }
          request = {
            controlActionId: globalThis.crypto.randomUUID(),
            expectedGenerationId: control.generationId,
            expectedAttemptEpoch: control.attemptEpoch,
            expectedControlVersion: control.controlVersion,
            ...(cutoff ? {
              lastCommittedRenderSeq: cutoff.sequence,
              renderedBodyHash: cutoff.hash,
            } : {}),
          };
        }

        const recovery = createPendingChatStopRecovery({
          orgId: currentTarget.organizationId,
          chatId: conversationId,
          request,
          executionAuthority,
          frozenDraft: currentStream,
        });
        if (!savePendingChatStopRecovery(recovery)) {
          throw new Error("Stop recovery could not be saved");
        }
        setStopping(false);
        submitStopRecovery(recovery);
      } catch {
        setStopping(false);
        setNotice(null);
        setError(CHAT_STOP_TARGET_UNVERIFIED_MESSAGE);
      }
    })();
  };

  const canSend = Boolean(draft.trim() && selectedAgent && !sending && !ownerLost && !nativeRecoveryUnavailable && !nativeRecoveryChecking);

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

      {recoveryDiscovery.checking ? (
        <div role="status" className="px-4 pb-2 text-sm text-muted-foreground">
          Checking the previous message before sending. Your current draft is preserved.
        </div>
      ) : null}
      {recoveryDiscovery.problem ? (
        <ChatSendRecoveryProblem message={recoveryDiscovery.problem} onRetry={recoveryDiscovery.retry} />
      ) : null}
      {recoveryDiscovery.completedNotice ? (
        <div role="status" className="px-4 pb-2 text-sm text-muted-foreground">{recoveryDiscovery.completedNotice}</div>
      ) : null}
      {activeSendRecovery && !ownerLost ? (
        <ChatSendRecoveryNotice
          disabled={sending}
          action={activeSendRecovery.action}
          onResume={() => {
            setSendRecovery(null);
            recoveryDiscovery.clearRecovery();
            recoveryDiscovery.clearCompletedNotice();
            void handleSend(activeSendRecovery.body, null, activeSendRecovery.clientMutationId);
          }}
        />
      ) : ownerLost ? <div role="status" data-testid="goal-chat-owner-loss-blocked" className="px-4 pb-2 text-sm text-amber-800 dark:text-amber-200">{CHAT_STOP_OWNER_LOST_MESSAGE}</div>
        : nativeRecoveryUnavailable ? <div role="status" data-testid="goal-chat-recovery-status-unavailable" className="px-4 pb-2 text-sm text-amber-800 dark:text-amber-200">{CHAT_RECOVERY_STATUS_UNAVAILABLE_MESSAGE}</div>
        : nativeRecoveryChecking ? <div role="status" data-testid="goal-chat-recovery-status-checking" className="px-4 pb-2 text-sm text-muted-foreground">{CHAT_RECOVERY_STATUS_CHECKING_MESSAGE}</div>
        : notice ? <div role="status" className="px-4 pb-2 text-sm text-muted-foreground">{notice}</div> : null}
      {(error || failedBody) && !ownerLost ? (
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-2">
          {error ? <span role="alert" className="text-sm text-destructive">{error}</span> : <span />}
          <div className="flex items-center gap-2">
            {failedBody ? (
              <Button type="button" size="sm" variant="outline" disabled={sending} onClick={() => void handleSend(failedBody, failedUserMessageId)}>
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
            readOnly={sending || ownerLost}
            onChange={(value) => {
              if (sending || ownerLost) return;
              setDraft(value);
              updateTarget({ body: value });
            }}
            placeholder="Message about this Goal..."
            onSubmit={() => void handleSend()}
          />
          <ChatComposerToolbar
            actions={(
              <ChatComposerSendButton
                mode={ownerLost ? "send" : sending ? (stopping ? "stopping" : "stop") : "send"}
                ariaLabel={ownerLost ? "Send message" : sending
                  ? stopping
                    ? "Stopping response"
                    : target.conversationId
                      ? "Stop streaming"
                      : "Stop unavailable until chat starts"
                  : "Send message"}
                disabled={ownerLost || nativeRecoveryUnavailable || (sending
                  ? stopping || !target.conversationId
                  : !canSend || recoveryDiscovery.checking || Boolean(activeSendRecovery) || Boolean(recoveryDiscovery.problem))}
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
