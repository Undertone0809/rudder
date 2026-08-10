import type { TranscriptEntry } from "@/agent-runtimes";
import { isUsableSelectionAnnotationRect } from "@/components/chat/SelectionAnnotationToolbar";
import {
  CHAT_ANNOTATION_SOURCE_ATTRIBUTE,
  hashChatAnnotationSource,
  readChatAnnotationSourceText,
  resolveChatAnnotationRange,
  restoreLiveChatAnnotationRange,
  shouldAutoFocusChatAnnotationToolbar,
  type ChatAnnotationSelectionAnchor,
} from "@/lib/chat-response-annotation-selection";
import type { ChatMessage } from "@rudderhq/shared";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

export type PendingChatResponseAnnotationSelection = {
  source: string;
  sourceConversationId: string;
  sourceMessageId: string;
  surface: "assistant_body" | "process_transcript";
  anchor: ChatAnnotationSelectionAnchor;
  anchorRect: DOMRect;
  sideChatEligible: boolean;
  autoFocusToolbar: boolean;
};

const CHAT_PENDING_SELECTION_HIGHLIGHT = "rudder-chat-pending-selection";

export function usePendingChatResponseAnnotationSelection(input: {
  rawMessages: ChatMessage[];
  loadedTranscriptsByMessageId: Record<string, TranscriptEntry[]>;
  selectedConversationId: string | null;
  draftStorageScopeKey: string;
  activeDraftScopeRef: RefObject<string>;
  chatMainWorkspaceRef: RefObject<HTMLElement | null>;
}) {
  const [pendingSelection, setPendingSelection] =
    useState<PendingChatResponseAnnotationSelection | null>(null);
  const selectionSequenceRef = useRef(0);

  useEffect(() => {
    const updateSelection = (event: Event) => {
      const selectionSequence = selectionSequenceRef.current + 1;
      selectionSequenceRef.current = selectionSequence;
      const eventTarget = event.target;
      if (
        eventTarget instanceof Element
        && (
          eventTarget.closest('[role="toolbar"][aria-label="Response annotation actions"]')
          || eventTarget.closest("[data-testid='chat-response-annotation-editor']")
          || eventTarget.closest("[data-testid='chat-response-annotation-card']")
        )
      ) {
        return;
      }
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        setPendingSelection(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const startElement = range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
      const endElement = range.endContainer instanceof Element
        ? range.endContainer
        : range.endContainer.parentElement;
      const sourceRoot = startElement?.closest<HTMLElement>(
        `[${CHAT_ANNOTATION_SOURCE_ATTRIBUTE}]`,
      ) ?? null;
      if (
        !sourceRoot
        || endElement?.closest(`[${CHAT_ANNOTATION_SOURCE_ATTRIBUTE}]`) !== sourceRoot
      ) {
        setPendingSelection(null);
        return;
      }
      const surface = sourceRoot.dataset.annotationSurface;
      if (surface !== "assistant_body" && surface !== "process_transcript") {
        setPendingSelection(null);
        return;
      }
      const sourceMessageId = sourceRoot.dataset.messageId?.trim() ?? "";
      const sourceMessage = input.rawMessages.find(
        (message) => message.id === sourceMessageId,
      );
      if (
        !sourceMessage
        || sourceMessage.role !== "assistant"
        || sourceMessage.kind !== "message"
        || sourceMessage.supersededAt
        || !(
          sourceMessage.status === "completed"
          || sourceMessage.status === "stopped"
          || sourceMessage.status === "failed"
        )
      ) {
        setPendingSelection(null);
        return;
      }
      let source = sourceMessage.body;
      let processProvenance: {
        transcriptKind: "assistant" | "thinking";
        generationId: string;
        generationSeqStart: number;
        generationSeqEnd: number;
      } | null = null;
      if (surface === "process_transcript") {
        const transcriptKind = sourceRoot.dataset.transcriptKind;
        const generationId = sourceRoot.dataset.generationId?.trim() ?? "";
        const generationSeqStart = Number(sourceRoot.dataset.generationSeqStart);
        const generationSeqEnd = Number(sourceRoot.dataset.generationSeqEnd);
        if (
          (transcriptKind !== "assistant" && transcriptKind !== "thinking")
          || !generationId
          || !Number.isInteger(generationSeqStart)
          || !Number.isInteger(generationSeqEnd)
        ) {
          setPendingSelection(null);
          return;
        }
        const transcriptEntries = input.loadedTranscriptsByMessageId[sourceMessage.id]
          ?? sourceMessage.transcript
          ?? [];
        const sourceEntry = transcriptEntries.find((entry) => {
          const candidate = entry as typeof entry & {
            generationId?: string;
            generationSeqStart?: number;
            generationSeqEnd?: number;
          };
          return candidate.kind === transcriptKind
            && candidate.generationId === generationId
            && candidate.generationSeqStart === generationSeqStart
            && candidate.generationSeqEnd === generationSeqEnd;
        });
        if (
          !sourceEntry
          || (sourceEntry.kind !== "assistant" && sourceEntry.kind !== "thinking")
        ) {
          setPendingSelection(null);
          return;
        }
        const visibleSource = readChatAnnotationSourceText(sourceRoot);
        if (visibleSource === null) {
          setPendingSelection(null);
          return;
        }
        source = visibleSource;
        processProvenance = {
          transcriptKind,
          generationId,
          generationSeqStart,
          generationSeqEnd,
        };
      }
      const anchorRect = range.getBoundingClientRect();
      if (!isUsableSelectionAnnotationRect(anchorRect)) {
        setPendingSelection(null);
        return;
      }
      const autoFocusToolbar = shouldAutoFocusChatAnnotationToolbar(event);
      const common = {
        range,
        sourceRoot,
        source,
        sourceHash: "",
        sourceConversationId: sourceMessage.conversationId,
        sourceMessageId: sourceMessage.id,
      };
      const provisionalAnchor = processProvenance
        ? resolveChatAnnotationRange({
            ...common,
            surface: "process_transcript",
            ...processProvenance,
          })
        : resolveChatAnnotationRange({
            ...common,
            surface: "assistant_body",
          });
      if (!provisionalAnchor) {
        setPendingSelection(null);
        return;
      }
      void hashChatAnnotationSource(source).then((sourceHash) => {
        if (
          selectionSequenceRef.current !== selectionSequence
          || input.activeDraftScopeRef.current !== input.draftStorageScopeKey
          || sourceMessage.conversationId !== input.selectedConversationId
        ) {
          return;
        }
        const anchor = { ...provisionalAnchor, sourceHash } as ChatAnnotationSelectionAnchor;
        const liveSelection = restoreLiveChatAnnotationRange({
          anchor,
          source,
          searchRoot: input.chatMainWorkspaceRef.current ?? document,
        });
        if (!liveSelection) {
          setPendingSelection(null);
          return;
        }
        const liveRect = liveSelection.range.getBoundingClientRect();
        setPendingSelection({
          source,
          sourceConversationId: sourceMessage.conversationId,
          sourceMessageId: sourceMessage.id,
          surface,
          anchor,
          anchorRect: isUsableSelectionAnnotationRect(liveRect) ? liveRect : anchorRect,
          sideChatEligible: sourceMessage.status === "completed",
          autoFocusToolbar,
        });
      }).catch(() => {
        if (selectionSequenceRef.current === selectionSequence) {
          setPendingSelection(null);
        }
      });
    };
    document.addEventListener("mouseup", updateSelection);
    document.addEventListener("touchend", updateSelection);
    document.addEventListener("keyup", updateSelection);
    return () => {
      selectionSequenceRef.current += 1;
      document.removeEventListener("mouseup", updateSelection);
      document.removeEventListener("touchend", updateSelection);
      document.removeEventListener("keyup", updateSelection);
    };
  }, [
    input.activeDraftScopeRef,
    input.chatMainWorkspaceRef,
    input.draftStorageScopeKey,
    input.loadedTranscriptsByMessageId,
    input.rawMessages,
    input.selectedConversationId,
  ]);

  useLayoutEffect(() => {
    if (!pendingSelection) return;
    if (
      input.activeDraftScopeRef.current !== input.draftStorageScopeKey
      || pendingSelection.sourceConversationId !== input.selectedConversationId
    ) {
      return;
    }
    const liveSelection = restoreLiveChatAnnotationRange({
      anchor: pendingSelection.anchor,
      source: pendingSelection.source,
      searchRoot: input.chatMainWorkspaceRef.current ?? document,
    });
    if (!liveSelection) return;
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(liveSelection.range);
    if (typeof Highlight === "undefined" || !CSS.highlights) return;
    const highlight = new Highlight(liveSelection.range);
    CSS.highlights.set(CHAT_PENDING_SELECTION_HIGHLIGHT, highlight);
    return () => {
      if (CSS.highlights.get(CHAT_PENDING_SELECTION_HIGHLIGHT) === highlight) {
        CSS.highlights.delete(CHAT_PENDING_SELECTION_HIGHLIGHT);
      }
    };
  }, [
    input.activeDraftScopeRef,
    input.chatMainWorkspaceRef,
    input.draftStorageScopeKey,
    input.selectedConversationId,
    pendingSelection,
  ]);

  const clearPendingSelection = () => {
    selectionSequenceRef.current += 1;
    setPendingSelection(null);
  };

  return {
    pendingSelection,
    setPendingSelection,
    clearPendingSelection,
  };
}
