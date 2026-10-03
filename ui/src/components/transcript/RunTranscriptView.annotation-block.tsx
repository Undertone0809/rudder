import {
  ResponseAnnotationEditor,
  type ResponseAnnotationEditorChanges,
} from "@/components/chat/ResponseAnnotations";
import { SelectionAnnotationToolbar } from "@/components/chat/SelectionAnnotationToolbar";
import type { ChatInlineAnnotationInput } from "@rudderhq/shared";
import { MessageSquare } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  shouldAutoFocusChatAnnotationToolbar,
} from "../../lib/chat-response-annotation-selection";
import { cn } from "../../lib/utils";
import {
  TranscriptBlock,
  transcriptBlockIdentity,
  TranscriptPresentation,
  TranscriptRunAnnotationContext,
} from "./RunTranscriptView.common";
import { formatNiceToolRequest, formatNiceToolResponse } from "./RunTranscriptView.presentation";

function isStableTranscriptBlock(block: TranscriptBlock): boolean {
  switch (block.type) {
    case "message":
    case "thinking":
      return !block.streaming;
    case "tool":
      return block.status !== "running";
    case "command_group":
      return block.items.length > 0 && block.items.every((item) => item.status !== "running");
    case "activity":
      return block.status === "completed";
    case "todo_list":
      return block.items.length > 0 && block.items.every((item) => item.status !== "in_progress");
    case "stdout":
      return true;
    case "memory_update":
      return block.status === "completed" || block.status === "error";
    case "event":
      return true;
  }
}

function transcriptBlockAnnotationText(block: TranscriptBlock): string {
  const limit = (value: string) => value.length > 4000 ? `${value.slice(0, 3997)}...` : value;
  switch (block.type) {
    case "message":
    case "thinking":
    case "stdout":
      return limit(block.text);
    case "tool": {
      const request = formatNiceToolRequest(block.name, block.input);
      const response = block.result ? formatNiceToolResponse(block.name, block.input, block.result) : "";
      return limit([request, response].filter(Boolean).join("\n\n"));
    }
    case "command_group":
      return limit(block.items.map((item) => {
        const request = formatNiceToolRequest(item.name, item.input);
        return [request, item.result].filter(Boolean).join("\n\n");
      }).filter(Boolean).join("\n\n"));
    case "activity":
      return limit(block.name);
    case "todo_list":
      return limit(block.items.map((item) => item.text).join("\n"));
    case "memory_update":
      return limit([block.summary, block.effect].filter(Boolean).join("\n\n"));
    case "event":
      return limit([block.label, block.text, block.detail].filter(Boolean).join("\n\n"));
  }
}

export function TranscriptRunAnnotationBlock({
  block,
  presentation,
  context,
  streaming = false,
  interactionId,
  children,
}: {
  block: TranscriptBlock;
  presentation: TranscriptPresentation;
  context?: TranscriptRunAnnotationContext;
  streaming?: boolean;
  /** Stable DOM/focus identity for a synthetic projection of real source entries. */
  interactionId?: string;
  children: ReactNode;
}) {
  const stable = isStableTranscriptBlock(block);
  const blockId = transcriptBlockIdentity(block);
  const itemInteractionId = interactionId ?? blockId;
  const annotationText = transcriptBlockAnnotationText(block);
  const isTextBlock = (block.type === "message" && block.role === "assistant") || block.type === "thinking";
  const canAnnotate = (presentation === "detail" || (presentation === "chat" && isTextBlock))
    && !streaming
    && stable
    && Boolean(context)
    && Boolean(context?.sourceRunId.trim())
    && Boolean(context?.sourceAgentId.trim())
    && (block.sourceEntryIds?.length ?? 0) > 0
    && block.sourceEntryIds!.every(id => Boolean(id.trim()))
    && Boolean(annotationText.trim());
  const canSelectText = canAnnotate
    && isTextBlock;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const blockRootRef = useRef<HTMLDivElement | null>(null);
  const getAnnotationBoundaryRect = useCallback(() => (
    blockRootRef.current
      ?.closest<HTMLElement>(
        '.transcript-modal-body, [data-testid="agent-runs-detail-pane"]',
      )
      ?.getBoundingClientRect()
      ?? null
  ), []);
  const [pendingSelection, setPendingSelection] = useState<{
    text: string;
    range: Range;
    anchorRect: DOMRect;
    autoFocus: boolean;
  } | null>(null);
  const [pendingAnnotation, setPendingAnnotation] = useState<{
    annotation: ChatInlineAnnotationInput;
    anchorKind: "text" | "transition";
    anchorRect: DOMRect;
    autoFocus: boolean;
  } | null>(null);
  const beginAnnotation = (
    text: string,
    anchor: HTMLButtonElement | null,
    anchorKind: "text" | "transition",
    anchorRect?: DOMRect,
    autoFocus = true,
  ) => {
    if (!context || !canAnnotate) return;
    const normalizedText = text.trim();
    if (!normalizedText) return;
    const rect = anchorRect ?? anchor?.getBoundingClientRect();
    if (!rect) return;
    if (rect.width <= 0 || rect.height <= 0) return;
    setPendingAnnotation({
      annotation: {
        id: globalThis.crypto?.randomUUID?.() ?? `run-annotation-${Date.now()}`,
        selectedText: normalizedText,
        comment: null,
        sourceHash: "pending",
        surface: "agent_run_transcript",
        sourceRunId: context.sourceRunId,
        sourceAgentId: context.sourceAgentId,
        anchorKind,
        sourceEntryId: blockId,
        sourceMemberIds: block.sourceEntryIds?.length ? block.sourceEntryIds : [blockId],
        attachmentFileIndexes: [],
      },
      anchorKind,
      anchorRect: rect,
      autoFocus,
    });
    setPendingSelection(null);
  };
  const handleAnnotate = (anchor: HTMLButtonElement) => {
    beginAnnotation(annotationText, anchor, "transition");
  };
  useEffect(() => {
    if (!canSelectText) {
      setPendingSelection(null);
      return undefined;
    }
    const updateSelection = (event: Event) => {
      const eventTarget = event.target instanceof Element ? event.target : null;
      if (eventTarget?.closest('[role="toolbar"][aria-label="Response annotation actions"], [data-testid="chat-response-annotation-editor"]')) return;
      const root = blockRootRef.current;
      const selection = window.getSelection();
      if (!root || !selection || selection.rangeCount !== 1 || selection.isCollapsed) {
        setPendingSelection(null);
        return;
      }
      const range = selection.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) {
        setPendingSelection(null);
        return;
      }
      const text = selection.toString().trim();
      const anchorRect = range.getBoundingClientRect();
      if (!text || anchorRect.width <= 0 || anchorRect.height <= 0) {
        setPendingSelection(null);
        return;
      }
      setPendingSelection({
        text,
        range: range.cloneRange(),
        anchorRect,
        autoFocus: shouldAutoFocusChatAnnotationToolbar(event),
      });
    };
    document.addEventListener("mouseup", updateSelection);
    document.addEventListener("touchend", updateSelection);
    document.addEventListener("keyup", updateSelection);
    document.addEventListener("selectionchange", updateSelection);
    return () => {
      document.removeEventListener("mouseup", updateSelection);
      document.removeEventListener("touchend", updateSelection);
      document.removeEventListener("keyup", updateSelection);
      document.removeEventListener("selectionchange", updateSelection);
    };
  }, [canSelectText]);

  useEffect(() => {
    if (!canAnnotate || (context?.activeBlockId && context.activeBlockId !== itemInteractionId)) {
      setPendingAnnotation(null);
      setPendingSelection(null);
    }
  }, [canAnnotate, context?.activeBlockId, itemInteractionId]);

  // A reused row must never submit a draft belonging to a previous Run or
  // changed source window, even if its visible text happens to be identical.
  const sourceIdentity = JSON.stringify([context?.sourceRunId, context?.sourceAgentId, blockId, block.sourceEntryIds, annotationText]);
  useEffect(() => {
    setPendingAnnotation(null);
    setPendingSelection(null);
  }, [sourceIdentity]);

  if (!context) return children;

  const commitPendingSelection = () => {
    if (!pendingSelection || !canSelectText) return;
    beginAnnotation(
      pendingSelection.text,
      triggerRef.current,
      "text",
      pendingSelection.anchorRect,
      pendingSelection.autoFocus,
    );
    window.getSelection()?.removeAllRanges();
  };

  const finishAnnotation = ({
    comment,
    pendingFiles,
    attachmentIds,
  }: ResponseAnnotationEditorChanges) => {
    if (!pendingAnnotation || !canAnnotate) return;
    const annotation = pendingAnnotation.annotation;
    context.onAnnotate({
      sourceRunId: context.sourceRunId,
      sourceAgentId: context.sourceAgentId,
      blockId,
      sourceMemberIds: block.sourceEntryIds,
      blockType: block.type,
      text: annotation.selectedText,
      anchorKind: pendingAnnotation.anchorKind,
      ts: block.ts,
      anchor: triggerRef.current ?? document.createElement("button"),
      comment,
      pendingFiles,
      attachmentIds,
      block,
    });
    setPendingAnnotation(null);
  };

  return (
    <div
      ref={blockRootRef}
      data-run-transcript-block="true"
      data-run-transcript-block-id={itemInteractionId}
      data-run-transcript-block-type={block.type}
      data-run-transcript-block-ts={block.ts}
      data-run-transcript-block-stable={stable ? "true" : undefined}
      data-run-transcript-selection-owner={canSelectText && presentation === "chat" ? "true" : undefined}
      tabIndex={canSelectText && presentation === "chat" ? -1 : undefined}
      className={cn("group/run-transcript-block relative", canAnnotate && presentation === "detail" && "pr-8")}
      onFocusCapture={() => context.onAnnotationFocus?.(itemInteractionId)}
      onMouseEnter={() => context.onAnnotationFocus?.(itemInteractionId)}
    >
      {children}
      {canAnnotate && presentation === "detail" ? (
        <button
          ref={triggerRef}
          type="button"
          data-testid="run-transcript-annotation-trigger"
          data-run-transcript-annotation-trigger="true"
          className="absolute right-0 top-0 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted/70 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 group-hover/run-transcript-block:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100 motion-reduce:transition-none"
          aria-label="Annotate transcript block"
          title="Annotate transcript block"
          onClick={(event) => handleAnnotate(event.currentTarget)}
        >
          <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
      {canSelectText && pendingSelection && !pendingAnnotation ? (
        <SelectionAnnotationToolbar
          open
          anchorRect={pendingSelection.anchorRect}
          getAnchorRect={() => (
            typeof pendingSelection.range.getBoundingClientRect === "function"
              ? pendingSelection.range.getBoundingClientRect()
              : pendingSelection.anchorRect
          )}
          boundaryRect={getAnnotationBoundaryRect()}
          getBoundaryRect={getAnnotationBoundaryRect}
          anchorObservationRoot={blockRootRef.current}
          onAddToChat={commitPendingSelection}
          onAskInSideChat={commitPendingSelection}
          showAskInSideChat={false}
          onDismiss={() => setPendingSelection(null)}
          onAnchorUnavailable={() => setPendingSelection(null)}
          autoFocus={pendingSelection.autoFocus}
        />
      ) : null}
      {canAnnotate && pendingAnnotation ? (
        <ResponseAnnotationEditor
          annotation={pendingAnnotation.annotation}
          ordinal={1}
          pendingFiles={[]}
          anchorRect={pendingAnnotation.anchorRect}
          getAnchorRect={() => (
            pendingAnnotation.anchorKind === "text"
              ? pendingAnnotation.anchorRect
              : triggerRef.current?.isConnected
                ? triggerRef.current.getBoundingClientRect()
                : pendingAnnotation.anchorRect
          )}
          boundaryRect={getAnnotationBoundaryRect()}
          getBoundaryRect={getAnnotationBoundaryRect}
          returnFocusRef={presentation === "chat" ? blockRootRef : triggerRef}
          autoFocus={pendingAnnotation.autoFocus}
          showSelectedTextContext
          onSave={finishAnnotation}
          onCancel={() => setPendingAnnotation(null)}
          onDelete={() => setPendingAnnotation(null)}
        />
      ) : null}
    </div>
  );
}
