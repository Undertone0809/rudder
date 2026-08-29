import type { TranscriptEntry } from "@/agent-runtimes";
import { agentsApi } from "@/api/agents";
import { chatsApi } from "@/api/chats";
import { ApiError } from "@/api/client";
import { healthApi } from "@/api/health";
import { projectsApi } from "@/api/projects";
import {
  ChatComposerContextMenu,
  ChatComposerEditor,
  ChatComposerSendButton,
  ChatComposerSurface,
  ChatComposerToolbar,
} from "@/components/chat/ChatComposer";
import {
  ChatProjectMenuContent,
  ChatProjectSelectorButton,
} from "@/components/chat/ChatProjectSelector";
import {
  DraftResponseAnnotationsPopover,
  ResponseAnnotationEditor,
} from "@/components/chat/ResponseAnnotations";
import { useToast } from "@/context/ToastContext";
import { formatChatAgentLabel } from "@/lib/agent-labels";
import { selectableChatAgents } from "@/lib/chat-agent-selection";
import { blockStaleAnnotationSubmission } from "@/lib/chat-annotation-runtime";
import { chatErrorMessage } from "@/lib/chat-errors";
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
import {
  ChatAgentMenuContent,
  ChatAgentSelectorButton,
  handleChatAgentMenuKeyDown,
} from "@/pages/Chat.model-selector";
import { composerMenuPositionForAnchor, mergeChatMessages } from "@/pages/Chat.parts";
import { activeGenerationIdFromSnapshot } from "@/pages/Chat.workspace-helpers";
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
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";

type RunFeedbackTarget = Extract<SidePanelTarget, { kind: "run_feedback_chat" }>;
type RunDebugTarget = Extract<SidePanelTarget, { kind: "run_debug_chat" }>;
type RunChatTarget = RunFeedbackTarget | RunDebugTarget;
type RunDebugSession = { autoSendConsumed: true; conversationId: string | null };
type RunDebugRuntimeState = {
  sending: boolean;
  stopping: boolean;
  stopRequested: boolean;
  stopAccepted: boolean;
  conversationId: string | null;
};
type RunDebugRuntime = {
  key: string;
  state: RunDebugRuntimeState;
  listeners: Set<() => void>;
  abortController: AbortController | null;
  streamFence: StreamFence;
};

const EMPTY_RUN_DEBUG_RUNTIME_STATE: RunDebugRuntimeState = {
  sending: false,
  stopping: false,
  stopRequested: false,
  stopAccepted: false,
  conversationId: null,
};
const runDebugRuntimes = new Map<string, RunDebugRuntime>();

function runDebugRuntimeKey(organizationId: string, clientMutationId: string) {
  return `${organizationId}:${clientMutationId}`;
}

function getRunDebugRuntime(organizationId: string, clientMutationId: string) {
  const key = runDebugRuntimeKey(organizationId, clientMutationId);
  const existing = runDebugRuntimes.get(key);
  if (existing) return existing;
  const runtime: RunDebugRuntime = {
    key,
    state: EMPTY_RUN_DEBUG_RUNTIME_STATE,
    listeners: new Set(),
    abortController: null,
    streamFence: newStreamFence(),
  };
  runDebugRuntimes.set(key, runtime);
  return runtime;
}

function updateRunDebugRuntime(runtime: RunDebugRuntime | null, patch: Partial<RunDebugRuntimeState>) {
  if (!runtime) return;
  runtime.state = { ...runtime.state, ...patch };
  for (const listener of runtime.listeners) listener();
}

function runDebugSessionQueryKey(organizationId: string, clientMutationId: string) {
  return ["run-debug-chat-session", organizationId, clientMutationId] as const;
}

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

function hasApiStatus(error: unknown, status: number) {
  if (error instanceof ApiError) return error.status === status;
  return Boolean(
    error
    && typeof error === "object"
    && "status" in error
    && (error as { status?: unknown }).status === status,
  );
}

const EMPTY_CHAT_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const STOP_TERMINAL_POLL_INTERVAL_MS = 250;
const STOP_TERMINAL_TIMEOUT_MS = 10_000;
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
  const activeGenerationId = activeGenerationIdFromSnapshot(snapshot);
  if (!generationId) return activeGenerationId === null;
  return activeGenerationId !== generationId;
}

export function RunFeedbackChatPanel({
  organizationId,
  target,
  onReplaceTarget,
}: {
  organizationId: string;
  target: RunChatTarget;
  onReplaceTarget: (key: string, target: SidePanelTarget) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const isDebug = target.kind === "run_debug_chat";
  const autoSend = target.kind === "run_debug_chat" && target.autoSend;
  const debugRuntime = useMemo(
    () => isDebug ? getRunDebugRuntime(organizationId, target.clientMutationId) : null,
    [isDebug, organizationId, target.clientMutationId],
  );
  const debugRuntimeState = useSyncExternalStore(
    (listener) => {
      if (!debugRuntime) return () => undefined;
      debugRuntime.listeners.add(listener);
      return () => {
        debugRuntime.listeners.delete(listener);
        queueMicrotask(() => {
          if (
            debugRuntime.listeners.size === 0
            && !debugRuntime.state.sending
            && !debugRuntime.abortController
          ) {
            runDebugRuntimes.delete(debugRuntime.key);
          }
        });
      };
    },
    () => debugRuntime?.state ?? EMPTY_RUN_DEBUG_RUNTIME_STATE,
    () => debugRuntime?.state ?? EMPTY_RUN_DEBUG_RUNTIME_STATE,
  );
  const [draft, setDraft] = useState(target.body ?? "");
  const [composerRevision, setComposerRevision] = useState(0);
  const [projectId, setProjectId] = useState<string | null>(target.projectId ?? null);
  const [composerMenu, setComposerMenu] = useState<"project" | "agent" | null>(null);
  const [composerMenuPosition, setComposerMenuPosition] = useState<CSSProperties | null>(null);
  const [sending, setSending] = useState(debugRuntimeState.sending);
  const [stopping, setStopping] = useState(debugRuntimeState.stopping);
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
  const composerSurfaceRef = useRef<HTMLDivElement | null>(null);
  const composerMenuRef = useRef<HTMLDivElement | null>(null);
  const projectSelectorRef = useRef<HTMLButtonElement | null>(null);
  const agentSelectorRef = useRef<HTMLButtonElement | null>(null);
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
  const sendInFlightRef = useRef(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const renderedTargetRef = useRef<Pick<RunChatTarget, "conversationId" | "clientMutationId">>(target);
  targetRef.current = target;
  mutationKeyRef.current = target.clientMutationId || mutationKeyRef.current;

  useEffect(() => {
    if (!debugRuntime) return;
    setSending(debugRuntimeState.sending);
    setStopping(debugRuntimeState.stopping);
    if (debugRuntimeState.conversationId) {
      activeConversationIdRef.current = debugRuntimeState.conversationId;
    }
  }, [debugRuntime, debugRuntimeState]);

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
    if (target.kind !== "run_feedback_chat") return;
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
    retry: (failureCount, queryError) => !hasApiStatus(queryError, 404) && failureCount < 2,
  });
  const messagesQuery = useQuery({
    queryKey: queryKeys.chats.messages(organizationId, target.conversationId ?? "__run-feedback-draft__"),
    queryFn: () => chatsApi.listMessages(organizationId, target.conversationId!, { includeTranscript: true }),
    enabled: Boolean(target.conversationId),
  });
  const queueQuery = useQuery({
    queryKey: queryKeys.chats.queue(organizationId, target.conversationId ?? "__run-feedback-draft__"),
    queryFn: () => chatsApi.listQueue(target.conversationId!),
    enabled: Boolean(target.conversationId),
    refetchInterval: sending ? 1_000 : false,
  });

  useEffect(() => {
    if (target.kind !== "run_debug_chat" || !target.conversationId || !queueQuery.data) return;
    const active = activeGenerationIdFromSnapshot(queueQuery.data) !== null;
    if (active) {
      setSending(true);
      updateRunDebugRuntime(debugRuntime, {
        sending: true,
        conversationId: target.conversationId,
      });
      return;
    }
    if (debugRuntimeState.sending) {
      setSending(false);
      updateRunDebugRuntime(debugRuntime, { sending: false, stopping: false });
    }
  }, [debugRuntime, debugRuntimeState.sending, queueQuery.data, target.conversationId, target.kind]);

  useEffect(() => {
    if (messagesQuery.data) setMessages((current) => mergeChatMessages(current, messagesQuery.data));
  }, [messagesQuery.data]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, streamBody]);
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

  const conversation = conversationQuery.data as ChatConversation | undefined;
  const liveAgents = useMemo(
    () => selectableChatAgents(agentsQuery.data),
    [agentsQuery.data],
  );
  const activeAgentId = target.conversationId
    ? conversation?.preferredAgentId ?? target.agentId
    : target.kind === "run_debug_chat"
      ? target.preferredAgentId
      : target.agentId;
  const selectedAgent = useMemo(
    () => liveAgents.find((agent) => agent.id === activeAgentId) ?? null,
    [activeAgentId, liveAgents],
  );
  const selectedProject = useMemo(
    () => (projectsQuery.data ?? []).find((project) => project.id === projectId) ?? null,
    [projectId, projectsQuery.data],
  );
  const projectLocked = target.kind === "run_debug_chat" || Boolean(
    sending
    || target.projectLocked
    || target.conversationId
    || messages.some((message) => message.role === "user"),
  );
  const agentLocked = target.kind === "run_feedback_chat" || Boolean(
    sending
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

  const updateTarget = useCallback((patch: Partial<RunChatTarget>) => {
    const current = targetRef.current;
    const next = current.kind === "run_feedback_chat"
      ? { ...current, ...patch, preferredAgentId: current.agentId } as RunFeedbackTarget
      : { ...current, ...patch } as RunDebugTarget;
    targetRef.current = next;
    onReplaceTarget(sidePanelTargetKey(current), next);
  }, [onReplaceTarget]);

  useEffect(() => {
    if (target.kind !== "run_feedback_chat") return;
    if (target.preferredAgentId && target.preferredAgentId !== target.agentId) {
      updateTarget({ preferredAgentId: target.agentId });
    }
  }, [target.agentId, target.kind, target.preferredAgentId, updateTarget]);

  const recoverUnavailableConversation = useCallback((conversationId: string) => {
    const current = targetRef.current;
    if (current.conversationId !== conversationId) return false;
    if (current.kind === "run_debug_chat") {
      setError("This Debug Chat is no longer available. Open Ask agent again to retry.");
      return false;
    }
    const clientMutationId = makeId();
    mutationKeyRef.current = clientMutationId;
    activeConversationIdRef.current = null;
    setMessages([]);
    setStreamBody("");
    setComposerMenu(null);
    setComposerMenuPosition(null);
    updateTarget({
      conversationId: null,
      projectLocked: false,
      clientMutationId,
      preferredAgentId: current.agentId,
      recoveryNotice: "The previous feedback chat is no longer available. Your draft was kept. Choose a project and send again.",
    });
    return true;
  }, [updateTarget]);

  useEffect(() => {
    if (
      target.conversationId
      && hasApiStatus(conversationQuery.error, 404)
    ) {
      recoverUnavailableConversation(target.conversationId);
    }
  }, [conversationQuery.error, recoverUnavailableConversation, target.conversationId]);

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
    const conversationId = streamTarget?.conversationId
      ?? activeConversationIdRef.current
      ?? debugRuntimeState.conversationId;
    const recoveredDebugStream = Boolean(debugRuntime && debugRuntimeState.sending);
    if (
      !conversationId
      || !sending
      || stopping
      || (!streamTargetMatchesCurrentTarget() && !recoveredDebugStream)
    ) return;
    const controlActionId = makeId();
    stopRequestedRef.current = true;
    setStopping(true);
    updateRunDebugRuntime(debugRuntime, { stopping: true, stopRequested: true, stopAccepted: false });
    setStopIndeterminate(false);
    setError(null);
    try {
      const latestQueue = await queryClient.fetchQuery({
        queryKey: queryKeys.chats.queue(organizationId, conversationId),
        queryFn: () => chatsApi.listQueue(conversationId),
        staleTime: 0,
      });
      queryClient.setQueryData(queryKeys.chats.queue(organizationId, conversationId), latestQueue);
      const streamFence = debugRuntime?.streamFence ?? streamFenceRef.current;
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
        updateRunDebugRuntime(debugRuntime, { stopAccepted: true });
        pendingStreamEventsRef.current = [];
        setStreamBody("");
        (debugRuntime?.abortController ?? streamAbortControllerRef.current)?.abort();
        const terminalEvidence = result.disposition === "stopped"
          || result.disposition === "interrupted_unverified"
          || await waitForTerminalStop(conversationId, result.generationId ?? generationFence?.generationId ?? null);
        if (terminalEvidence) {
          setStopping(false);
          updateRunDebugRuntime(debugRuntime, { sending: false, stopping: false });
          setStopIndeterminate(false);
        } else {
          setStopping(false);
          updateRunDebugRuntime(debugRuntime, { sending: false, stopping: false });
          setStopIndeterminate(true);
          setError("Stop was accepted, but the final runtime state could not be confirmed yet.");
        }
      } else {
        stopRequestedRef.current = false;
        await replayPendingStreamEvents();
        setStopping(false);
        updateRunDebugRuntime(debugRuntime, { stopping: false, stopRequested: false, stopAccepted: false });
      }
      await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(organizationId, conversationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.chats.messages(organizationId, conversationId) }),
      ]);
    } catch (stopError) {
      stopRequestedRef.current = false;
      await replayPendingStreamEvents();
      setStopping(false);
      updateRunDebugRuntime(debugRuntime, { stopping: false, stopRequested: false, stopAccepted: false });
      setStopIndeterminate(false);
      setError(stopError instanceof Error ? stopError.message : "Could not stop feedback.");
    }
  }, [debugRuntime, debugRuntimeState, organizationId, queryClient, replayPendingStreamEvents, sending, stopping, streamTargetMatchesCurrentTarget, waitForTerminalStop]);

  const handleProjectChange = (value: string) => {
    if (projectLocked) return;
    const next = value || null;
    setProjectId(next);
    updateTarget({ projectId: next });
  };

  const closeComposerMenu = useCallback(() => {
    setComposerMenu(null);
    setComposerMenuPosition(null);
  }, []);
  const openComposerMenu = useCallback((menu: "project" | "agent") => {
    const anchor = menu === "project" ? projectSelectorRef.current : agentSelectorRef.current;
    if (anchor) setComposerMenuPosition(composerMenuPositionForAnchor(anchor));
    setComposerMenu(menu);
  }, []);
  const handleAgentChange = (agentId: string) => {
    if (agentLocked || !liveAgents.some((agent) => agent.id === agentId)) return;
    updateTarget({ preferredAgentId: agentId });
    closeComposerMenu();
  };
  useEffect(() => {
    if (!composerMenu) return;
    const updatePosition = () => {
      const anchor = composerMenu === "project" ? projectSelectorRef.current : agentSelectorRef.current;
      if (anchor) setComposerMenuPosition(composerMenuPositionForAnchor(anchor));
    };
    const handlePointerDown = (event: PointerEvent) => {
      const node = event.target;
      if (!(node instanceof Node)) return;
      if (composerMenuRef.current?.contains(node)) return;
      if (projectSelectorRef.current?.contains(node) || agentSelectorRef.current?.contains(node)) return;
      closeComposerMenu();
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const restoreFocus = composerMenu === "project" ? projectSelectorRef.current : agentSelectorRef.current;
      closeComposerMenu();
      requestAnimationFrame(() => restoreFocus?.focus());
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeComposerMenu, composerMenu]);

  const handleSend = async () => {
    if (sendInFlightRef.current || sending || stopping || stopIndeterminate || !canSend) return;
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
    sendInFlightRef.current = true;
    if (sendTarget.kind === "run_feedback_chat" && sendTarget.recoveryNotice) {
      updateTarget({ recoveryNotice: null });
    }
    if (sendTarget.kind === "run_debug_chat" && sendTarget.errorMessage) {
      updateTarget({ errorMessage: null });
    }
    if (sendTarget.kind === "run_debug_chat") {
      setDraft("");
    }
    setSending(true);
    updateRunDebugRuntime(debugRuntime, {
      sending: true,
      stopping: false,
      stopRequested: false,
      stopAccepted: false,
    });
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
    if (debugRuntime) {
      debugRuntime.abortController = streamAbortController;
      debugRuntime.streamFence = streamFenceRef.current;
    }
    const isCurrentStream = () => streamRunIdRef.current === streamRunId
      && streamTargetMatchesCurrentTarget();
    const applyStreamEvent = async (event: ChatStreamEvent) => {
      if (!isCurrentStream() || stopCutoffAcceptedRef.current) return;
      if (event.type === "ack") {
        recordStreamFence(streamFenceRef.current, event);
        activeConversationIdRef.current = event.userMessage.conversationId;
        updateRunDebugRuntime(debugRuntime, {
          conversationId: event.userMessage.conversationId,
          sending: true,
        });
        if (!sendTarget.conversationId && streamTargetRef.current) {
          streamTargetRef.current = {
            ...streamTargetRef.current,
            conversationId: event.userMessage.conversationId,
          };
        }
        setMessages((current) => mergeChatMessages(current, [event.userMessage]));
        for (const annotationId of sentAnnotationIds) {
          dispatchAnnotation({ type: "delete", id: annotationId });
        }
        const current = targetRef.current;
        const remainingAnnotations = current.inlineAnnotations.filter((annotation) => !sentAnnotationIds.has(annotation.id));
        const nextTarget: RunChatTarget = sendTarget.conversationId
          ? {
              ...current,
              body: current.body === body ? "" : current.body,
              inlineAnnotations: remainingAnnotations,
            }
          : current.kind === "run_feedback_chat" ? {
              ...current,
              conversationId: event.userMessage.conversationId,
              projectLocked: true,
              projectId: sendTarget.projectId,
              body: current.body === body ? "" : current.body,
              inlineAnnotations: remainingAnnotations,
            } : {
              ...current,
              conversationId: event.userMessage.conversationId,
              body: current.body === body ? "" : current.body,
              inlineAnnotations: remainingAnnotations,
            };
        updateTarget(nextTarget);
        if (sendTarget.kind === "run_debug_chat") {
          queryClient.setQueryData<RunDebugSession>(
            runDebugSessionQueryKey(organizationId, sendTarget.clientMutationId),
            { autoSendConsumed: true, conversationId: event.userMessage.conversationId },
          );
          setDraft("");
          setComposerRevision((current) => current + 1);
        }
        setAnnotationsExpanded(remainingAnnotations.length > 0);
        if (!sendTarget.conversationId && sendTarget.kind === "run_feedback_chat") {
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
        setMessages((current) => mergeChatMessages(current, event.messages));
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
    let sendFailureMessage: string | null = null;
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
          preferredAgentId: sendTarget.kind === "run_debug_chat"
            ? sendTarget.preferredAgentId
            : sendTarget.agentId,
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
      const acceptedStop = stopCutoffAcceptedRef.current || debugRuntime?.state.stopAccepted;
      if (!acceptedStop && (!isAbort || !stopRequestedRef.current)) {
        if (
          sendTarget.conversationId
          && hasApiStatus(sendError, 404)
        ) {
          recoverUnavailableConversation(sendTarget.conversationId);
        } else {
          sendFailureMessage = sendTarget.kind === "run_debug_chat"
            ? `${chatErrorMessage(sendError)} Choose another agent or try again.`
            : chatErrorMessage(sendError, "feedback");
        }
      }
    } finally {
      const stopCutoffPending = stopCutoffAcceptedRef.current;
      streamAbortControllerRef.current = null;
      sendInFlightRef.current = false;
      setSending(false);
      updateRunDebugRuntime(debugRuntime, {
        sending: false,
        stopping: false,
        stopRequested: false,
        stopAccepted: false,
      });
      if (debugRuntime?.abortController === streamAbortController) {
        debugRuntime.abortController = null;
      }
      if (!stopCutoffPending && !stopRequestedRef.current) setStopping(false);
      if (!stopRequestedRef.current || stopCutoffPending) {
        streamEventHandlerRef.current = null;
        streamTargetRef.current = null;
        pendingStreamEventsRef.current = [];
        stopRequestedRef.current = false;
      }
      if (sendFailureMessage) {
        setError(sendFailureMessage);
        if (sendTarget.kind === "run_debug_chat") {
          setDraft(body);
          updateTarget({ autoSend: false, errorMessage: sendFailureMessage });
        }
      }
    }
  };

  useEffect(() => {
    if (target.kind !== "run_debug_chat") return;
    const session = queryClient.getQueryData<RunDebugSession>(
      runDebugSessionQueryKey(organizationId, target.clientMutationId),
    );
    if (
      !session?.conversationId
      || (target.conversationId === session.conversationId && !target.body && !target.autoSend)
    ) return;
    setDraft("");
    setComposerRevision((current) => current + 1);
    updateTarget({
      conversationId: session.conversationId,
      body: "",
      autoSend: false,
    });
  }, [autoSend, organizationId, queryClient, target.body, target.clientMutationId, target.conversationId, target.kind, updateTarget]);

  useEffect(() => {
    if (target.kind !== "run_debug_chat" || !autoSend || agentsQuery.isPending) return;
    const sessionKey = runDebugSessionQueryKey(organizationId, target.clientMutationId);
    const session = queryClient.getQueryData<RunDebugSession>(sessionKey);
    if (session?.autoSendConsumed) {
      const conversationId = session.conversationId ?? activeConversationIdRef.current;
      updateTarget({
        autoSend: false,
        conversationId: conversationId ?? target.conversationId,
        body: conversationId ? "" : target.body,
      });
      return;
    }
    queryClient.setQueryData<RunDebugSession>(sessionKey, {
      autoSendConsumed: true,
      conversationId: null,
    });
    updateTarget({ autoSend: false });
    if (!selectedAgent) {
      const unavailableMessage = "The Run agent is unavailable. Choose another agent or try again.";
      setError(unavailableMessage);
      updateTarget({ autoSend: false, errorMessage: unavailableMessage });
      return;
    }
    void handleSend();
  }, [agentsQuery.isPending, autoSend, selectedAgent, target.clientMutationId, target.kind]);

  const visibleMessages = messages;
  const recoveredDebugStreamCanBeStopped = Boolean(
    isDebug
    && sending
    && target.conversationId
    && activeGenerationIdFromSnapshot(queueQuery.data),
  );
  const currentStreamCanBeStopped = sending
    && Boolean(activeConversationIdRef.current)
    && (streamTargetMatchesCurrentTarget() || recoveredDebugStreamCanBeStopped);
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
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid={isDebug ? "run-debug-chat-panel" : "run-feedback-chat-panel"}
      data-debug-conversation-id={isDebug ? target.conversationId ?? "" : undefined}
      data-debug-runtime-sending={isDebug ? String(debugRuntimeState.sending) : undefined}
      data-debug-queue-status={isDebug ? queueQuery.data?.activeGenerationStatus ?? "" : undefined}
    >
      <div
        className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto px-4 py-4"
        data-testid="run-chat-messages-scroll"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          <div className="flex items-center gap-2 border-b border-border/70 pb-3">
            <MessageSquare className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{isDebug ? "Debug Run" : "Run feedback"}</div>
              <div className="truncate text-xs text-muted-foreground">{selectedAgent?.name ?? target.agentId}</div>
            </div>
          </div>
          {conversation ? <div className="text-xs text-muted-foreground">{conversation.title}</div> : null}
          {isDebug && sending && !target.conversationId && target.body.trim() && !messages.some((message) => message.role === "user") ? (
            <div
              className="ml-6 rounded-lg border bg-muted/30 px-3 py-2 text-sm"
              data-testid="run-chat-pending-message"
            >
              <div className="whitespace-pre-wrap break-words">{target.body}</div>
            </div>
          ) : null}
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
          <div ref={endRef} data-testid="run-chat-message-end" />
        </div>
      </div>
      {error || (target.kind === "run_feedback_chat" ? target.recoveryNotice : target.errorMessage) || annotationValidationError ? (
        <div role="alert" className="px-4 pb-2 text-sm text-destructive">
          {error ?? (target.kind === "run_feedback_chat" ? target.recoveryNotice : target.errorMessage) ?? annotationValidationError}
        </div>
      ) : null}
      <div className="shrink-0 px-4 pb-4">
        <ChatComposerSurface ref={composerSurfaceRef} className="mx-auto max-w-3xl" testId="run-feedback-composer">
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
            key={isDebug ? composerRevision : undefined}
            value={draft}
            onChange={(value) => {
              if (sending || stopping || stopIndeterminate) return;
              setDraft(value);
              updateTarget({ body: value });
            }}
            placeholder={isDebug ? "Ask a follow-up…" : "Add context for this feedback…"}
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
            {!isDebug ? <ChatProjectSelectorButton
              project={selectedProject}
              label={selectedProject?.name ?? "No project"}
              expanded={composerMenu === "project"}
              disabled={projectLocked || projectsQuery.isPending}
              buttonRef={projectSelectorRef}
              testId="run-feedback-project-selector"
              iconTestId="run-feedback-project-icon"
              clearTestId="run-feedback-project-clear"
              onClick={() => {
                if (composerMenu === "project") closeComposerMenu();
                else openComposerMenu("project");
              }}
              onClear={() => handleProjectChange("")}
            /> : null}
            <ChatAgentSelectorButton
              buttonRef={agentSelectorRef}
              agent={selectedAgent}
              label={selectedAgent ? formatChatAgentLabel(selectedAgent) : agentsQuery.isPending ? "Loading agents" : "No agent"}
              expanded={composerMenu === "agent"}
              disabled={agentLocked || agentsQuery.isPending}
              onClick={() => {
                if (composerMenu === "agent") closeComposerMenu();
                else openComposerMenu("agent");
              }}
            />
          </ChatComposerToolbar>
        </ChatComposerSurface>
        {composerMenu && composerMenuPosition && typeof document !== "undefined" ? createPortal(
          <ChatComposerContextMenu
            menuRef={composerMenuRef}
            testId={`run-feedback-${composerMenu}-menu`}
            ariaLabel={composerMenu === "agent" ? "Run feedback agent" : "Run feedback project"}
            position={composerMenuPosition}
            onKeyDown={composerMenu === "agent" ? handleChatAgentMenuKeyDown : undefined}
          >
            {composerMenu === "project" ? (
              <>
                <ChatProjectMenuContent
                  projects={(projectsQuery.data ?? []) as Project[]}
                  activeProjectId={projectId}
                  onSelect={(nextProjectId) => {
                    handleProjectChange(nextProjectId ?? "");
                    closeComposerMenu();
                  }}
                />
                {projectsQuery.isError ? (
                  <div className="mt-1 flex items-center justify-between gap-3 border-t border-[color:var(--border-soft)] px-3 py-2 text-xs">
                    <span role="alert" className="text-destructive">Projects could not be loaded.</span>
                    <button
                      type="button"
                      data-chat-composer-menu-item
                      className="font-medium text-foreground hover:underline disabled:text-muted-foreground disabled:no-underline"
                      disabled={projectsQuery.isFetching}
                      onClick={() => void projectsQuery.refetch()}
                    >
                      {projectsQuery.isFetching ? "Retrying..." : "Retry"}
                    </button>
                  </div>
                ) : null}
              </>
            ) : (
              <ChatAgentMenuContent
                agents={liveAgents}
                activeAgentId={activeAgentId}
                agentSelectionLocked={agentLocked}
                runtimeSelectionPending={false}
                newConversationSendInFlight={sending && !conversation}
                externalBound={false}
                adapterModels={null}
                overrides={{ modelOverride: null, effortOverride: null }}
                runtimeLabel=""
                showRuntimeControls={false}
                onSelectAgent={handleAgentChange}
                onChangeRuntime={() => undefined}
              />
            )}
          </ChatComposerContextMenu>,
          document.body,
        ) : null}
      </div>
    </div>
  );
}
