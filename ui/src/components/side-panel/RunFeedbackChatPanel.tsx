import type { TranscriptEntry } from "@/agent-runtimes";
import { agentsApi } from "@/api/agents";
import { chatsApi } from "@/api/chats";
import { healthApi } from "@/api/health";
import { projectsApi } from "@/api/projects";
import {
  ChatComposerEditor,
  ChatComposerSendButton,
  ChatComposerSurface,
  ChatComposerToolbar,
} from "@/components/chat/ChatComposer";
import {
  DraftResponseAnnotationsPopover,
  ResponseAnnotationEditor,
} from "@/components/chat/ResponseAnnotations";
import { ProjectIcon } from "@/components/ProjectIdentity";
import { useToast } from "@/context/ToastContext";
import { blockStaleAnnotationSubmission } from "@/lib/chat-annotation-runtime";
import {
  canSubmitChatResponseAnnotations,
  chatResponseAnnotationsForDraft,
  createChatResponseAnnotationState,
  responseAnnotationReducer,
  serializeChatResponseAnnotations,
  validateChatResponseAnnotationReplacement,
  validateChatResponseAnnotationState,
} from "@/lib/chat-response-annotations";
import { queryKeys } from "@/lib/queryKeys";
import { useNavigate } from "@/lib/router";
import { consumeRunFeedbackPendingFiles } from "@/lib/run-feedback-pending-files";
import { sidePanelTargetKey, type SidePanelTarget } from "@/lib/side-panel-targets";
import { ChatMessageItem, StreamTranscriptItem } from "@/pages/Chat.messages";
import type {
  ChatConversation,
  ChatInlineAnnotationInput,
  ChatMessage,
  ChatStreamEvent,
  Project,
} from "@rudderhq/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

type RunFeedbackTarget = Extract<SidePanelTarget, { kind: "run_feedback_chat" }>;

function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? `annotation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function messageBody(message: ChatMessage) {
  return message.body?.trim() || (message.role === "user" ? "Annotation-only feedback" : "");
}

function transcriptEntries(message: ChatMessage) {
  return (message.transcript ?? []) as TranscriptEntry[];
}

function noop() {}

const EMPTY_CHAT_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const STOP_TERMINAL_POLL_INTERVAL_MS = 250;
const STOP_TERMINAL_TIMEOUT_MS = 10_000;
const ACTIVE_GENERATION_STATUSES = new Set([
  "starting",
  "active",
  "running",
  "tool_busy",
  "closing",
  "stop_requested",
  "stopping",
]);

type StreamFence = {
  generationId: string | null;
  attemptEpoch: number | null;
  lastCommittedRenderSeq: number;
  renderedBodyHash: string;
};

type StreamTargetIdentity = {
  conversationId: string | null;
  clientMutationId: string;
};

type StreamFenceEvent = Extract<
  ChatStreamEvent,
  { type: "ack" | "assistant_delta" | "assistant_state" | "transcript_entry" }
>;

function newStreamFence(): StreamFence {
  return {
    generationId: null,
    attemptEpoch: null,
    lastCommittedRenderSeq: 0,
    renderedBodyHash: EMPTY_CHAT_BODY_SHA256,
  };
}

function recordStreamFence(fence: StreamFence, event: StreamFenceEvent) {
  if (event.generationId) fence.generationId = event.generationId;
  if (event.attemptEpoch !== undefined) fence.attemptEpoch = event.attemptEpoch;
  if (event.generationSeq !== undefined) fence.lastCommittedRenderSeq = event.generationSeq;
  if (event.bodyHash) fence.renderedBodyHash = event.bodyHash;
}

function stopQueueSnapshotIsTerminal(
  snapshot: Awaited<ReturnType<typeof chatsApi.listQueue>>,
  generationId: string | null,
) {
  if (!generationId) return snapshot.activeGenerationId === null;
  if (snapshot.activeGenerationId !== generationId) return true;
  return snapshot.activeGenerationStatus !== null
    && !ACTIVE_GENERATION_STATUSES.has(snapshot.activeGenerationStatus);
}

export function RunFeedbackChatPanel({
  organizationId,
  target,
  onReplaceTarget,
}: {
  organizationId: string;
  target: RunFeedbackTarget;
  onReplaceTarget: (key: string, target: SidePanelTarget) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const [draft, setDraft] = useState(target.body ?? "");
  const [projectId, setProjectId] = useState<string | null>(target.projectId ?? null);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopIndeterminate, setStopIndeterminate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamBody, setStreamBody] = useState("");
  const [annotationState, dispatchAnnotation] = useReducer(
    responseAnnotationReducer,
    target.inlineAnnotations ?? [],
    createChatResponseAnnotationState,
  );
  const [annotationsExpanded, setAnnotationsExpanded] = useState(false);
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const annotationChipRef = useRef<HTMLButtonElement | null>(null);
  const editingAnchorRef = useRef<HTMLButtonElement | null>(null);
  const mutationKeyRef = useRef(target.clientMutationId || makeId());
  const targetRef = useRef(target);
  const activeConversationIdRef = useRef<string | null>(target.conversationId);
  const streamAbortControllerRef = useRef<AbortController | null>(null);
  const stopRequestedRef = useRef(false);
  const stopCutoffAcceptedRef = useRef(false);
  const streamFenceRef = useRef<StreamFence>(newStreamFence());
  const streamTargetRef = useRef<StreamTargetIdentity | null>(null);
  const streamRunIdRef = useRef(0);
  const pendingStreamEventsRef = useRef<ChatStreamEvent[]>([]);
  const streamEventHandlerRef = useRef<((event: ChatStreamEvent) => Promise<void> | void) | null>(null);
  const renderedTargetRef = useRef<Pick<RunFeedbackTarget, "conversationId" | "clientMutationId">>(target);
  targetRef.current = target;

  useEffect(() => {
    const previousTarget = renderedTargetRef.current;
    const sameFirstTurnStream = streamTargetRef.current?.conversationId === target.conversationId
      && streamTargetRef.current.clientMutationId === target.clientMutationId
      && previousTarget.conversationId === null
      && Boolean(target.conversationId);
    if (
      !sameFirstTurnStream
      && (
        previousTarget.conversationId !== target.conversationId
        || previousTarget.clientMutationId !== target.clientMutationId
      )
    ) {
      setMessages([]);
      setStreamBody("");
    }
    renderedTargetRef.current = target;
  }, [target.clientMutationId, target.conversationId]);
  useEffect(() => {
    if (sending || streamTargetRef.current) return;
    activeConversationIdRef.current = target.conversationId ?? null;
  }, [sending, target.conversationId]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        `rudder.run-feedback-draft:${organizationId}:${target.agentId}`,
        JSON.stringify(target),
      );
    } catch {
      // Ignore restricted storage environments; the Side Panel state remains authoritative.
    }
  }, [organizationId, target]);

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(organizationId),
    queryFn: () => agentsApi.list(organizationId),
  });
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(organizationId),
    queryFn: () => projectsApi.list(organizationId),
  });
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
  });
  const conversationQuery = useQuery({
    queryKey: queryKeys.chats.detail(organizationId, target.conversationId ?? "__run-feedback-draft__"),
    queryFn: () => chatsApi.get(target.conversationId!),
    enabled: Boolean(target.conversationId),
  });
  const messagesQuery = useQuery({
    queryKey: queryKeys.chats.messages(organizationId, target.conversationId ?? "__run-feedback-draft__"),
    queryFn: () => chatsApi.listMessages(organizationId, target.conversationId!, { includeTranscript: true }),
    enabled: Boolean(target.conversationId),
  });
  useQuery({
    queryKey: queryKeys.chats.queue(organizationId, target.conversationId ?? "__run-feedback-draft__"),
    queryFn: () => chatsApi.listQueue(target.conversationId!),
    enabled: Boolean(target.conversationId),
    refetchInterval: sending ? 1_000 : false,
  });

  useEffect(() => {
    if (messagesQuery.data) setMessages(messagesQuery.data);
  }, [messagesQuery.data]);
  useEffect(() => {
    setDraft(target.body ?? "");
  }, [target.body]);
  useEffect(() => {
    const targetAnnotations = target.inlineAnnotations ?? [];
    const localAnnotations = chatResponseAnnotationsForDraft(annotationState);
    const persistedTargetAnnotations = targetAnnotations.map((annotation) => {
      const {
        attachmentFileIndexes: _attachmentFileIndexes,
        ordinal: _ordinal,
        ...persistable
      } = annotation as ChatInlineAnnotationInput & { ordinal?: number };
      return persistable;
    });
    const stagedFiles = consumeRunFeedbackPendingFiles(target.clientMutationId);
    const targetAnnotationIds = new Set(targetAnnotations.map((annotation) => annotation.id));
    const existingPendingFiles = Object.fromEntries(
      Object.entries(annotationState.pendingFilesByAnnotationId)
        .filter(([annotationId]) => targetAnnotationIds.has(annotationId)),
    );
    const pendingFilesByAnnotationId = { ...existingPendingFiles, ...stagedFiles };
    if (
      JSON.stringify(persistedTargetAnnotations) === JSON.stringify(localAnnotations)
      && Object.keys(stagedFiles).length === 0
    ) return;
    dispatchAnnotation({
      type: "reset",
      annotations: targetAnnotations,
      pendingFilesByAnnotationId,
    });
    setAnnotationsExpanded(targetAnnotations.length > 0);
  }, [annotationState, target.clientMutationId, target.inlineAnnotations]);
  useEffect(() => {
    setProjectId(target.projectId ?? null);
  }, [target.projectId]);

  const selectedAgent = useMemo(
    () => (agentsQuery.data ?? []).find((agent) => agent.id === target.agentId) ?? null,
    [agentsQuery.data, target.agentId],
  );
  const selectedProject = useMemo(
    () => (projectsQuery.data ?? []).find((project) => project.id === projectId) ?? null,
    [projectId, projectsQuery.data],
  );
  const projectLocked = Boolean(
    sending
    ||
    target.projectLocked
    || target.conversationId
    || messages.some((message) => message.role === "user"),
  );
  const annotationCount = annotationState.annotations.length;
  const annotationValidationError = validateChatResponseAnnotationState(
    annotationState.annotations,
    Object.values(annotationState.pendingFilesByAnnotationId).reduce((total, files) => total + files.length, 0),
  );
  const hasPendingAnnotation = annotationState.annotations.some((annotation) => annotation.sourceHash === "pending");
  const canSend = !hasPendingAnnotation && !annotationValidationError && canSubmitChatResponseAnnotations(draft, annotationState);

  const updateTarget = useCallback((patch: Partial<RunFeedbackTarget>) => {
    const current = targetRef.current;
    const next = { ...current, ...patch } satisfies RunFeedbackTarget;
    targetRef.current = next;
    onReplaceTarget(sidePanelTargetKey(current), next);
  }, [onReplaceTarget]);

  const streamTargetMatchesCurrentTarget = useCallback(() => {
    const streamTarget = streamTargetRef.current;
    if (!streamTarget) return false;
    const currentTarget = targetRef.current;
    if (streamTarget.conversationId) return currentTarget.conversationId === streamTarget.conversationId;
    return currentTarget.clientMutationId === streamTarget.clientMutationId;
  }, []);

  const replayPendingStreamEvents = useCallback(async () => {
    const pendingEvents = pendingStreamEventsRef.current.splice(0);
    const handler = streamEventHandlerRef.current;
    if (!handler) return;
    for (const event of pendingEvents) await handler(event);
  }, []);

  const waitForTerminalStop = useCallback(async (conversationId: string, generationId: string | null) => {
    const deadline = Date.now() + STOP_TERMINAL_TIMEOUT_MS;
    const queryKey = queryKeys.chats.queue(organizationId, conversationId);
    while (Date.now() < deadline) {
      try {
        const snapshot = await queryClient.fetchQuery({
          queryKey,
          queryFn: () => chatsApi.listQueue(conversationId),
          staleTime: 0,
        });
        queryClient.setQueryData(queryKey, snapshot);
        if (stopQueueSnapshotIsTerminal(snapshot, generationId)) return true;
      } catch {
        // Keep the stop state pending when the terminal readback is unavailable.
      }
      await new Promise((resolve) => window.setTimeout(resolve, STOP_TERMINAL_POLL_INTERVAL_MS));
    }
    return false;
  }, [organizationId, queryClient]);

  const handleStop = useCallback(async () => {
    const streamTarget = streamTargetRef.current;
    const conversationId = streamTarget?.conversationId ?? activeConversationIdRef.current;
    if (!conversationId || !sending || stopping || !streamTargetMatchesCurrentTarget()) return;
    const controlActionId = makeId();
    stopRequestedRef.current = true;
    setStopping(true);
    setStopIndeterminate(false);
    setError(null);
    try {
      const latestQueue = await queryClient.fetchQuery({
        queryKey: queryKeys.chats.queue(organizationId, conversationId),
        queryFn: () => chatsApi.listQueue(conversationId),
        staleTime: 0,
      });
      queryClient.setQueryData(queryKeys.chats.queue(organizationId, conversationId), latestQueue);
      const streamFence = streamFenceRef.current;
      const generationFence = latestQueue.activeGenerationId
        && latestQueue.activeAttemptEpoch !== null
        && latestQueue.activeAttemptEpoch !== undefined
        && latestQueue.activeControlVersion !== null
        && latestQueue.activeControlVersion !== undefined
        ? {
            generationId: latestQueue.activeGenerationId,
            attemptEpoch: latestQueue.activeAttemptEpoch,
            controlVersion: latestQueue.activeControlVersion,
          }
        : null;
      const request = {
        controlActionId,
        ...(generationFence ? {
          expectedGenerationId: generationFence.generationId,
          expectedAttemptEpoch: generationFence.attemptEpoch,
          expectedControlVersion: generationFence.controlVersion,
        } : {}),
        lastCommittedRenderSeq: streamFence.lastCommittedRenderSeq,
        renderedBodyHash: streamFence.renderedBodyHash,
      };
      const result = await chatsApi.stopMessageStream(conversationId, request);
      if (result.controlActionId !== controlActionId) {
        throw new Error("Stop confirmation did not match this feedback stream.");
      }
      const cutoffAccepted = result.stopped || [
        "stopping",
        "stop_requested",
        "stopped",
        "interrupted_unverified",
      ].includes(result.disposition ?? "");
      if (cutoffAccepted) {
        stopCutoffAcceptedRef.current = true;
        pendingStreamEventsRef.current = [];
        setStreamBody("");
        streamAbortControllerRef.current?.abort();
        const terminalEvidence = result.disposition === "stopped"
          || result.disposition === "interrupted_unverified"
          || await waitForTerminalStop(conversationId, result.generationId ?? generationFence?.generationId ?? null);
        if (terminalEvidence) {
          setStopping(false);
          setStopIndeterminate(false);
        } else {
          setStopping(false);
          setStopIndeterminate(true);
          setError("Stop was accepted, but the final runtime state could not be confirmed yet.");
        }
      } else {
        stopRequestedRef.current = false;
        await replayPendingStreamEvents();
        setStopping(false);
      }
      await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(organizationId, conversationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.chats.messages(organizationId, conversationId) }),
      ]);
    } catch (stopError) {
      stopRequestedRef.current = false;
      await replayPendingStreamEvents();
      setStopping(false);
      setStopIndeterminate(false);
      setError(stopError instanceof Error ? stopError.message : "Could not stop feedback.");
    }
  }, [organizationId, queryClient, replayPendingStreamEvents, sending, stopping, streamTargetMatchesCurrentTarget, waitForTerminalStop]);

  const handleProjectChange = (value: string) => {
    if (projectLocked) return;
    const next = value || null;
    setProjectId(next);
    updateTarget({ projectId: next });
  };

  const handleSend = async () => {
    if (sending || stopping || stopIndeterminate || !canSend) return;
    const sendTarget = targetRef.current;
    const body = draft.trim();
    const serialized = serializeChatResponseAnnotations(annotationState);
    const sentAnnotationIds = new Set(serialized.inlineAnnotations.map((annotation) => annotation.id));
    if (blockStaleAnnotationSubmission({
      annotations: serialized.inlineAnnotations,
      devServer: healthQuery.data?.devServer,
      draftPersistence: "durable",
      pushToast,
    })) return;
    setSending(true);
    setStopping(false);
    setStopIndeterminate(false);
    stopRequestedRef.current = false;
    stopCutoffAcceptedRef.current = false;
    streamFenceRef.current = newStreamFence();
    setError(null);
    setStreamBody("");
    const streamRunId = streamRunIdRef.current + 1;
    streamRunIdRef.current = streamRunId;
    streamTargetRef.current = {
      conversationId: sendTarget.conversationId ?? null,
      clientMutationId: sendTarget.clientMutationId ?? mutationKeyRef.current,
    };
    pendingStreamEventsRef.current = [];
    const streamAbortController = new AbortController();
    streamAbortControllerRef.current = streamAbortController;
    const isCurrentStream = () => streamRunIdRef.current === streamRunId
      && streamTargetMatchesCurrentTarget();
    const applyStreamEvent = async (event: ChatStreamEvent) => {
      if (!isCurrentStream() || stopCutoffAcceptedRef.current) return;
      if (event.type === "ack") {
        recordStreamFence(streamFenceRef.current, event);
        activeConversationIdRef.current = event.userMessage.conversationId;
        if (!sendTarget.conversationId && streamTargetRef.current) {
          streamTargetRef.current = {
            ...streamTargetRef.current,
            conversationId: event.userMessage.conversationId,
          };
        }
        setMessages((current) => [...current, event.userMessage]);
        for (const annotationId of sentAnnotationIds) {
          dispatchAnnotation({ type: "delete", id: annotationId });
        }
        const current = targetRef.current;
        const remainingAnnotations = current.inlineAnnotations.filter((annotation) => !sentAnnotationIds.has(annotation.id));
        const nextTarget = sendTarget.conversationId
          ? {
              ...current,
              body: current.body === body ? "" : current.body,
              inlineAnnotations: remainingAnnotations,
            }
          : {
              ...current,
              conversationId: event.userMessage.conversationId,
              projectLocked: true,
              projectId: sendTarget.projectId,
              body: current.body === body ? "" : current.body,
              inlineAnnotations: remainingAnnotations,
            };
        updateTarget(nextTarget);
        setAnnotationsExpanded(remainingAnnotations.length > 0);
        if (!sendTarget.conversationId) {
          try {
            window.localStorage.setItem(
              `rudder.run-feedback-draft:${organizationId}:${sendTarget.agentId}`,
              JSON.stringify(nextTarget),
            );
          } catch {
            // Ignore restricted storage environments; the Side Panel state remains authoritative.
          }
        }
      }
      if (event.type === "assistant_delta") {
        recordStreamFence(streamFenceRef.current, event);
        setStreamBody((current) => current + event.delta);
      }
      if (event.type === "assistant_state" || event.type === "transcript_entry") {
        recordStreamFence(streamFenceRef.current, event);
      }
      if (event.type === "final") {
        setStreamBody("");
        setMessages((current) => [...current, ...event.messages]);
      }
      if (event.type === "error") throw new Error(event.error);
    };
    streamEventHandlerRef.current = applyStreamEvent;
    const onStreamEvent = async (event: ChatStreamEvent) => {
      if (!isCurrentStream() || stopCutoffAcceptedRef.current) return;
      if (stopRequestedRef.current && !stopCutoffAcceptedRef.current) {
        pendingStreamEventsRef.current.push(event);
        return;
      }
      await applyStreamEvent(event);
    };
    try {
      if (sendTarget.conversationId) {
        await chatsApi.sendMessageStream(sendTarget.conversationId, body, {
          signal: streamAbortController.signal,
          files: serialized.files,
          inlineAnnotations: serialized.inlineAnnotations,
          onEvent: onStreamEvent,
        });
      } else {
        await chatsApi.sendFirstMessageStream(organizationId, body, {
          signal: streamAbortController.signal,
          preferredAgentId: sendTarget.agentId,
          issueCreationMode: "manual_approval",
          planMode: false,
          modelOverride: null,
          effortOverride: null,
          contextLinks: sendTarget.projectId
            ? [{ entityType: "project", entityId: sendTarget.projectId }]
            : [],
          clientMutationId: mutationKeyRef.current,
          files: serialized.files,
          inlineAnnotations: serialized.inlineAnnotations,
          onEvent: onStreamEvent,
        });
      }
      if (sendTarget.conversationId) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(organizationId, sendTarget.conversationId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.chats.messages(organizationId, sendTarget.conversationId) }),
        ]);
      }
    } catch (sendError) {
      const isAbort = sendError instanceof DOMException
        ? sendError.name === "AbortError"
        : sendError instanceof Error && sendError.name === "AbortError";
      if (!isAbort || !stopRequestedRef.current) {
        setError(sendError instanceof Error ? sendError.message : "Could not send feedback.");
      }
    } finally {
      const stopCutoffPending = stopCutoffAcceptedRef.current;
      streamAbortControllerRef.current = null;
      setSending(false);
      if (!stopCutoffPending && !stopRequestedRef.current) setStopping(false);
      if (!stopRequestedRef.current || stopCutoffPending) {
        streamEventHandlerRef.current = null;
        streamTargetRef.current = null;
        pendingStreamEventsRef.current = [];
        stopRequestedRef.current = false;
      }
    }
  };

  const conversation = conversationQuery.data as ChatConversation | undefined;
  const visibleMessages = messages;
  const currentStreamCanBeStopped = sending
    && Boolean(activeConversationIdRef.current)
    && streamTargetMatchesCurrentTarget();
  const feedbackButtonMode = stopping || stopIndeterminate
    ? "stopping"
    : currentStreamCanBeStopped
      ? "stop"
      : sending
        ? "sending"
        : "send";
  const feedbackButtonDisabled = stopping || stopIndeterminate
    || (!sending && !canSend)
    || (sending && !currentStreamCanBeStopped);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="run-feedback-chat-panel">
      <div className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          <div className="flex items-center gap-2 border-b border-border/70 pb-3">
            <MessageSquare className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">Run feedback</div>
              <div className="truncate text-xs text-muted-foreground">{selectedAgent?.name ?? target.agentId}</div>
            </div>
          </div>
          {conversation ? <div className="text-xs text-muted-foreground">{conversation.title}</div> : null}
          {conversation ? visibleMessages.map((message) => {
            const transcript = transcriptEntries(message);
            return (
              <div key={message.id} data-testid="run-feedback-chat-message">
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
                {message.role === "user" && !message.body.trim() ? (
                  <div className="mb-2 text-xs text-muted-foreground">Annotation-only feedback</div>
                ) : null}
                <ChatMessageItem
                  conversation={conversation}
                  message={message}
                  agents={agentsQuery.data}
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
                  onSelectResponseAnnotation={(annotation) => {
                    if (annotation.surface !== "agent_run_transcript") return;
                    navigate(`/agents/${target.agentId}/runs/${annotation.sourceRunId}`);
                  }}
                  skillReferences={[]}
                />
              </div>
            );
          }) : visibleMessages.map((message) => (
            <div key={message.id} className={`rounded-lg border px-3 py-2 text-sm ${message.role === "user" ? "ml-6 bg-muted/30" : "mr-6"}`}>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{message.role}</div>
              <div className="whitespace-pre-wrap break-words">{messageBody(message)}</div>
            </div>
          ))}
          {conversation && streamBody ? (
            <div data-testid="run-feedback-chat-streaming">
              <div className="max-w-3xl whitespace-pre-wrap break-words text-sm text-foreground">{streamBody}</div>
            </div>
          ) : null}
        </div>
      </div>
      {error || annotationValidationError ? (
        <div role="alert" className="px-4 pb-2 text-sm text-destructive">
          {error ?? annotationValidationError}
        </div>
      ) : null}
      <div className="shrink-0 px-4 pb-4">
        <ChatComposerSurface className="mx-auto max-w-3xl" testId="run-feedback-composer">
          {annotationCount > 0 ? (
            <div className="mb-3 flex flex-col items-start gap-2">
              <DraftResponseAnnotationsPopover
                annotations={annotationState.annotations}
                pendingFilesByAnnotationId={annotationState.pendingFilesByAnnotationId}
                open={annotationsExpanded}
                buttonRef={annotationChipRef}
                onOpenChange={(open) => {
                  setAnnotationsExpanded(open);
                  if (open) setEditingAnnotationId(null);
                }}
                onClear={() => {
                  dispatchAnnotation({ type: "clear" });
                  updateTarget({ inlineAnnotations: [] });
                }}
                onEdit={(annotation) => {
                  editingAnchorRef.current = annotationChipRef.current;
                  setEditingAnnotationId(annotation.id);
                }}
                onDelete={(id) => {
                  dispatchAnnotation({ type: "delete", id });
                  updateTarget({ inlineAnnotations: annotationState.annotations.filter((item) => item.id !== id) });
                }}
              />
              {editingAnnotationId ? (() => {
                const annotation = annotationState.annotations.find((item) => item.id === editingAnnotationId);
                if (!annotation) return null;
                const anchor = editingAnchorRef.current;
                return (
                  <ResponseAnnotationEditor
                    annotation={annotation}
                    ordinal={annotation.ordinal}
                    pendingFiles={annotationState.pendingFilesByAnnotationId[annotation.id] ?? []}
                    showSelectedTextContext
                    anchorRect={anchor?.getBoundingClientRect() ?? null}
                    getAnchorRect={() => anchor?.getBoundingClientRect() ?? null}
                    boundaryRect={null}
                    getBoundaryRect={() => null}
                    returnFocusRef={editingAnchorRef}
                    validateSave={(changes) => validateChatResponseAnnotationReplacement(annotationState, annotation.id, {
                      comment: changes.comment,
                      attachmentIds: changes.attachmentIds,
                      files: changes.pendingFiles,
                    })}
                onSave={({ comment, pendingFiles, attachmentIds }) => {
                  dispatchAnnotation({ type: "replaceDraft", id: annotation.id, comment, attachmentIds, files: pendingFiles });
                  updateTarget({
                    inlineAnnotations: annotationState.annotations.map((item) => (
                      item.id === annotation.id
                        ? { ...item, comment, attachmentIds }
                        : item
                    )),
                  });
                  setEditingAnnotationId(null);
                }}
                onCancel={() => setEditingAnnotationId(null)}
                onDelete={() => {
                  dispatchAnnotation({ type: "delete", id: annotation.id });
                  updateTarget({ inlineAnnotations: annotationState.annotations.filter((item) => item.id !== annotation.id) });
                  setEditingAnnotationId(null);
                }}
                  />
                );
              })() : null}
            </div>
          ) : null}
          <ChatComposerEditor
            value={draft}
            onChange={(value) => {
              if (sending || stopping || stopIndeterminate) return;
              setDraft(value);
              updateTarget({ body: value });
            }}
            placeholder="Add context for this feedback…"
            onSubmit={() => void handleSend()}
          />
          <ChatComposerToolbar
            actions={(
              <ChatComposerSendButton
                mode={feedbackButtonMode}
                stoppingComplete={stopIndeterminate}
                ariaLabel={stopIndeterminate ? "Stop status pending" : feedbackButtonMode === "stop" ? "Stop feedback" : feedbackButtonMode === "stopping" ? "Stopping feedback" : feedbackButtonMode === "sending" ? "Sending feedback" : "Send feedback"}
                disabled={feedbackButtonDisabled}
                onClick={() => {
                  if (feedbackButtonMode === "stop") {
                    void handleStop();
                    return;
                  }
                  if (feedbackButtonMode === "send") void handleSend();
                }}
              />
            )}
          >
            <span className="inline-flex min-w-0 max-w-[min(100%,14rem)] items-center gap-1.5 text-xs text-muted-foreground" title={projectLocked ? "Project context is locked after conversation starts." : (selectedProject?.name ?? "No project")}>
              {selectedProject ? <ProjectIcon color={selectedProject.color} icon={selectedProject.icon} size="xs" label={selectedProject.name} /> : <span className="h-3.5 w-3.5 shrink-0 rounded border border-dashed border-muted-foreground/50" aria-hidden="true" />}
              <select
                aria-label="Project"
                value={projectId ?? ""}
                disabled={projectLocked || projectsQuery.isPending || sending}
                aria-disabled={projectLocked || projectsQuery.isPending || sending}
                onChange={(event) => handleProjectChange(event.currentTarget.value)}
                className="min-w-0 max-w-[10rem] truncate bg-transparent text-xs outline-none disabled:cursor-not-allowed disabled:opacity-60"
              >
                <option value="">No project</option>
                {(projectsQuery.data ?? []).map((project: Project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </span>
          </ChatComposerToolbar>
        </ChatComposerSurface>
      </div>
    </div>
  );
}
