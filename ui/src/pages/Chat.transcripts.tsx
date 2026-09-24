import type { TranscriptEntry } from "@/agent-runtimes";
import { chatsApi } from "@/api/chats";
import { TranscriptContinuationControls } from "@/components/transcript/TranscriptContinuationControls";
import {
  chatTranscriptEntriesForMessage,
  isAgentRunTranscriptActiveStatus,
  readLegacyChatTranscript,
  useAgentRunTranscripts,
  type AgentRunTranscriptNavigation,
  type AgentRunTranscriptState,
} from "@/components/transcript/useAgentRunTranscripts";
import { queryKeys } from "@/lib/queryKeys";
import {
  hashChatAnnotationSource,
} from "@/lib/chat-response-annotation-selection";
import {
  responseAnnotationReducer,
  validateChatResponseAnnotationAdd,
  type ChatResponseAnnotationState,
} from "@/lib/chat-response-annotations";
import type {
  ChatInlineAnnotationInput,
  ChatMessage,
} from "@rudderhq/shared";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode } from "react";
import type {
  TranscriptRunAnnotationContext,
  TranscriptRunAnnotationInput,
} from "@/components/transcript/RunTranscriptView";

type AnnotationAddAction = Extract<Parameters<typeof responseAnnotationReducer>[1], { type: "add" }>;
type ChatTranscriptToast = { title: string; body?: string; tone: "error" };

export function useChatTranscripts(input: {
  messages: ChatMessage[];
  selectedOrganizationId: string | null;
  queryClient: QueryClient;
  pushToast: (toast: ChatTranscriptToast) => void;
  annotationState: ChatResponseAnnotationState;
  dispatchResponseAnnotation: Dispatch<AnnotationAddAction>;
  setAnnouncement: (value: string) => void;
  translate: (key: "chat.annotations.couldNotAdd" | "chat.annotations.added") => string;
}) {
  const [openProcessMessageIds, setOpenProcessMessageIds] = useState<Record<string, boolean>>({});
  const [loadingTranscriptMessageIds, setLoadingTranscriptMessageIds] = useState<Record<string, true>>({});
  const [loadedTranscriptsByMessageId, setLoadedTranscriptsByMessageId] = useState<Record<string, TranscriptEntry[]>>({});
  const transcriptLoadPromisesRef = useRef<Record<string, Promise<TranscriptEntry[] | null>>>({});
  const targets = useMemo(
    () => input.messages.flatMap((message) => message.runId
      ? [{ runId: message.runId, active: isAgentRunTranscriptActiveStatus(message.status) }]
      : []),
    [input.messages],
  );
  const {
    transcriptByRun,
    transcriptStateByRun,
    transcriptNavigationByRun,
    refetchRun,
  } = useAgentRunTranscripts(targets);

  const setProcessOpenForMessage = useCallback((messageId: string, open: boolean) => {
    setOpenProcessMessageIds((current) => {
      if (messageId in current && current[messageId] === open) return current;
      return { ...current, [messageId]: open };
    });
  }, []);

  const loadMessageTranscript = useCallback((chatId: string, messageId: string, sourceMessageOverride?: ChatMessage | null) => {
    const pending = transcriptLoadPromisesRef.current[messageId];
    if (pending) return pending;
    const request = (async () => {
      setLoadingTranscriptMessageIds((current) => ({ ...current, [messageId]: true }));
      try {
        const sourceMessage = sourceMessageOverride ?? input.messages.find((message) => message.id === messageId);
        const nativeRunId = sourceMessage?.runId ?? null;
        let transcript: TranscriptEntry[];
        if (nativeRunId) {
          transcript = sourceMessage
            ? chatTranscriptEntriesForMessage(sourceMessage, loadedTranscriptsByMessageId, transcriptByRun)
            : [];
          if (!transcriptStateByRun.get(nativeRunId)?.hasData) {
            transcript = (await refetchRun(nativeRunId))?.entries ?? transcript;
          }
        } else {
          transcript = await readLegacyChatTranscript(chatId, messageId, nativeRunId);
        }
        setLoadedTranscriptsByMessageId((current) => ({ ...current, [messageId]: transcript }));
        input.queryClient.setQueryData<ChatMessage[]>(
          queryKeys.chats.messages(input.selectedOrganizationId ?? "__none__", chatId),
          (current) => (current ?? []).map((message) =>
            message.id === messageId
              ? { ...message, transcript }
              : message,
          ),
        );
        setProcessOpenForMessage(messageId, true);
        return transcript;
      } catch (error) {
        input.pushToast({
          title: "Failed to load process details",
          body: error instanceof Error ? error.message : "Try again.",
          tone: "error",
        });
        return null;
      } finally {
        const { [messageId]: _removed, ...rest } = transcriptLoadPromisesRef.current;
        transcriptLoadPromisesRef.current = rest;
        setLoadingTranscriptMessageIds((current) => {
          if (!(messageId in current)) return current;
          const { [messageId]: _removed, ...rest } = current;
          return rest;
        });
      }
    })();
    transcriptLoadPromisesRef.current[messageId] = request;
    return request;
  }, [input.messages, input.pushToast, input.queryClient, input.selectedOrganizationId, loadedTranscriptsByMessageId, refetchRun, setProcessOpenForMessage, transcriptByRun, transcriptStateByRun]);

  const keepProcessOpenForMessages = useCallback((messages: ChatMessage[]) => {
    const messageIds = messages
      .filter((message) => {
        const transcript = chatTranscriptEntriesForMessage(message, loadedTranscriptsByMessageId, transcriptByRun);
        return transcript.length > 0 && (
          message.role === "assistant"
          || message.kind === "issue_proposal" || message.kind === "operation_proposal"
        );
      })
      .map((message) => message.id);
    if (messageIds.length === 0) return;
    setOpenProcessMessageIds((current) => {
      let changed = false;
      const next = { ...current };
      for (const messageId of messageIds) {
        if (next[messageId]) continue;
        next[messageId] = true;
        changed = true;
      }
      return changed ? next : current;
    });
  }, [loadedTranscriptsByMessageId, transcriptByRun]);

  const {
    annotationState,
    dispatchResponseAnnotation,
    pushToast,
    setAnnouncement,
    translate,
  } = input;
  const handleRunAnnotation = useCallback(async (annotationInput: TranscriptRunAnnotationInput) => {
    const annotation: ChatInlineAnnotationInput = {
      id: globalThis.crypto.randomUUID(),
      selectedText: annotationInput.text,
      comment: annotationInput.comment,
      sourceHash: await hashChatAnnotationSource(annotationInput.text),
      surface: "agent_run_transcript",
      sourceRunId: annotationInput.sourceRunId,
      sourceAgentId: annotationInput.sourceAgentId,
      anchorKind: annotationInput.anchorKind,
      sourceEntryId: annotationInput.blockId,
      sourceMemberIds: annotationInput.sourceMemberIds?.length ? annotationInput.sourceMemberIds : [annotationInput.blockId],
      attachmentIds: annotationInput.attachmentIds,
    };
    const validationError = validateChatResponseAnnotationAdd(annotationState, annotation);
    if (validationError) {
      pushToast({
        title: translate("chat.annotations.couldNotAdd"),
        body: validationError,
        tone: "error",
      });
      return;
    }
    dispatchResponseAnnotation({ type: "add", annotation, files: annotationInput.pendingFiles });
    setAnnouncement(translate("chat.annotations.added"));
  }, [annotationState, dispatchResponseAnnotation, pushToast, setAnnouncement, translate]);

  return {
    openProcessMessageIds,
    loadingTranscriptMessageIds,
    loadedTranscriptsByMessageId,
    transcriptByRun,
    transcriptStateByRun,
    transcriptNavigationByRun,
    setProcessOpenForMessage,
    loadMessageTranscript,
    keepProcessOpenForMessages,
    handleRunAnnotation,
  };
}

export function useAutoLoadChatSteerTranscripts(input: {
  visibleMessages: ChatMessage[];
  nativeSteerMessagesByGenerationId: ReadonlyMap<string, ChatMessage[]>;
  loadedTranscriptsByMessageId: Readonly<Record<string, TranscriptEntry[]>>;
  loadingTranscriptMessageIds: Readonly<Record<string, true>>;
  transcriptByRun: ReadonlyMap<string, TranscriptEntry[]>;
  transcriptStateByRun: ReadonlyMap<string, AgentRunTranscriptState>;
  loadMessageTranscript: (chatId: string, messageId: string, sourceMessage?: ChatMessage | null) => Promise<TranscriptEntry[] | null>;
}) {
  useEffect(() => {
    for (const message of input.visibleMessages) {
      if (message.role !== "assistant" || !message.generationId) continue;
      if ((input.nativeSteerMessagesByGenerationId.get(message.generationId)?.length ?? 0) === 0) continue;
      const transcript = chatTranscriptEntriesForMessage(
        message,
        input.loadedTranscriptsByMessageId,
        input.transcriptByRun,
      );
      if (transcript.length > 0) continue;
      if (message.runId) continue;
      if (message.runId
        ? input.transcriptStateByRun.get(message.runId)?.hasData
        : !message.transcriptSummary?.entryCount) continue;
      if (input.loadingTranscriptMessageIds[message.id]) continue;
      void input.loadMessageTranscript(message.conversationId, message.id, message);
    }
  }, [
    input.loadMessageTranscript,
    input.loadedTranscriptsByMessageId,
    input.loadingTranscriptMessageIds,
    input.nativeSteerMessagesByGenerationId,
    input.transcriptByRun,
    input.transcriptStateByRun,
    input.visibleMessages,
  ]);
}

export function chatTranscriptPresentationForMessage(
  message: ChatMessage,
  loadedTranscriptsByMessageId: Readonly<Record<string, TranscriptEntry[]>>,
  transcriptByRun: ReadonlyMap<string, TranscriptEntry[]>,
  transcriptStateByRun: ReadonlyMap<string, AgentRunTranscriptState>,
  transcriptNavigationByRun: ReadonlyMap<string, AgentRunTranscriptNavigation>,
) {
  return {
    entries: chatTranscriptEntriesForMessage(message, loadedTranscriptsByMessageId, transcriptByRun),
    state: message.runId ? transcriptStateByRun.get(message.runId) ?? null : null,
    navigation: message.runId ? transcriptNavigationByRun.get(message.runId) ?? null : null,
  };
}

export function chatRunAnnotationContextForMessage(
  message: ChatMessage,
  onAnnotate: (input: TranscriptRunAnnotationInput) => void | Promise<void>,
): TranscriptRunAnnotationContext | undefined {
  return message.runId && message.replyingAgentId
    ? {
        sourceRunId: message.runId,
        sourceAgentId: message.replyingAgentId,
        onAnnotate,
      }
    : undefined;
}

export function renderChatRunTranscriptContinuation(
  message: ChatMessage,
  canShowProcess: boolean,
  navigation: AgentRunTranscriptNavigation | null,
  state: AgentRunTranscriptState | null,
): ReactNode {
  return message.runId && canShowProcess
    ? <TranscriptContinuationControls navigation={navigation} state={state} />
    : null;
}
