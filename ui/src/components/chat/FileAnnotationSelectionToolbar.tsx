import {
  CHAT_FILE_ANNOTATION_LOCATE_EVENT,
  consumePendingChatFileAnnotationLocation,
  readPendingChatFileAnnotationLocation,
  requestChatFileAnnotation,
  type ChatFileAnnotationLocateDetail,
} from "@/lib/chat-file-annotation-events";
import {
  chatAnnotationRenderedTextToSourceSpans,
  chatAnnotationSemanticOffsetForBoundary,
  chatAnnotationSemanticSelectedText,
  chatAnnotationSemanticText,
  chatAnnotationSemanticTextSpans,
  hashChatAnnotationSource,
  shouldAutoFocusChatAnnotationToolbar,
} from "@/lib/chat-response-annotation-selection";
import {
  MAX_CHAT_INLINE_ANNOTATION_CONTEXT_LENGTH,
  type ChatInlineAnnotationInput,
} from "@rudderhq/shared";
import { useEffect, useRef, useState, type RefObject } from "react";
import { SelectionAnnotationToolbar } from "./SelectionAnnotationToolbar";

export type FileTextSelection = {
  start: number;
  end: number;
  selectedText: string;
  anchorRect: Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width" | "height">;
};

type FileAnnotationSource =
  | {
    surface: "workspace_file";
    sourceFilePath: string;
    sourceLibraryEntryId: string | null;
  }
  | {
    surface: "local_file";
    sourceFilePath: string;
  };

type PendingFileSelection = FileTextSelection & {
  autoFocus: boolean;
  sourceHash: string;
};

export function resolveRenderedFileSelectionRange(
  root: HTMLElement,
  range: Range,
  source: string,
  sourceOffset = 0,
) {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return null;
  }
  const renderedStart = chatAnnotationSemanticOffsetForBoundary(
    root,
    range.startContainer,
    range.startOffset,
  );
  if (renderedStart === null) return null;
  const selectedText = chatAnnotationSemanticSelectedText(range);
  const renderedText = chatAnnotationSemanticText(root);
  const renderedEnd = renderedStart + selectedText.length;
  if (!selectedText.trim() || renderedEnd > renderedText.length) return null;
  const spans = chatAnnotationRenderedTextToSourceSpans(renderedText, source);
  const start = spans[renderedStart]?.start;
  const end = spans[renderedEnd - 1]?.end;
  if (start === undefined || end === undefined || end <= start) return null;
  return { start: sourceOffset + start, end: sourceOffset + end, selectedText };
}

function domBoundaryAtSemanticOffset(
  spans: ReturnType<typeof chatAnnotationSemanticTextSpans>,
  offset: number,
  bias: "start" | "end",
) {
  for (const span of spans) {
    if (offset >= span.start && offset <= span.end) {
      return { node: span.node, offset: Math.max(0, Math.min(span.end - span.start, offset - span.start)) };
    }
  }
  const fallback = bias === "start"
    ? spans.find((span) => span.start >= offset)
    : [...spans].reverse().find((span) => span.end <= offset);
  return fallback
    ? { node: fallback.node, offset: bias === "start" ? 0 : fallback.end - fallback.start }
    : null;
}

function locateMarkdownSourceRange(
  root: HTMLElement,
  renderedSource: string,
  start: number,
  end: number,
) {
  const renderedText = chatAnnotationSemanticText(root);
  const sourceSpans = chatAnnotationRenderedTextToSourceSpans(renderedText, renderedSource);
  const renderedStart = sourceSpans.findIndex((span) => span.end > start);
  const renderedEndIndex = sourceSpans.findIndex((span) => span.end >= end);
  const renderedEnd = renderedEndIndex < 0 ? -1 : renderedEndIndex + 1;
  if (renderedStart < 0 || renderedEnd <= renderedStart) return false;
  const spans = chatAnnotationSemanticTextSpans(root);
  const startBoundary = domBoundaryAtSemanticOffset(spans, renderedStart, "start");
  const endBoundary = domBoundaryAtSemanticOffset(spans, renderedEnd, "end");
  if (!startBoundary || !endBoundary) return false;
  const range = document.createRange();
  range.setStart(startBoundary.node, startBoundary.offset);
  range.setEnd(endBoundary.node, endBoundary.offset);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  startBoundary.node.parentElement?.scrollIntoView({ block: "center", inline: "nearest" });
  return true;
}

export function FileAnnotationSelectionToolbar({
  containerRef,
  conversationId,
  explicitSelection,
  saved,
  source,
  sourceIdentity,
  sourceRenderMode,
  renderedSource = source,
  renderedSourceOffset = 0,
}: {
  containerRef: RefObject<HTMLElement | null>;
  conversationId: string | null;
  explicitSelection?: FileTextSelection | null;
  saved: boolean;
  source: string;
  sourceIdentity: FileAnnotationSource;
  sourceRenderMode: "markdown" | "text";
  renderedSource?: string;
  renderedSourceOffset?: number;
}) {
  const selectionSequenceRef = useRef(0);
  const [pending, setPending] = useState<PendingFileSelection | null>(null);

  useEffect(() => {
    if (sourceRenderMode !== "markdown") return undefined;
    const handleLocation = (detail: ChatFileAnnotationLocateDetail | null) => {
      const root = containerRef.current;
      if (
        !detail
        || !root
        || detail.surface !== sourceIdentity.surface
        || detail.sourceFilePath !== sourceIdentity.sourceFilePath
        || detail.sourceRenderMode !== "markdown"
      ) return;
      void hashChatAnnotationSource(source).then((sourceHash) => {
        if (sourceHash !== detail.sourceHash) return;
        const located = locateMarkdownSourceRange(
          root,
          renderedSource,
          detail.start - renderedSourceOffset,
          detail.end - renderedSourceOffset,
        );
        if (located) consumePendingChatFileAnnotationLocation(detail);
      });
    };
    const listener = (event: Event) => {
      handleLocation((event as CustomEvent<ChatFileAnnotationLocateDetail>).detail);
    };
    window.addEventListener(CHAT_FILE_ANNOTATION_LOCATE_EVENT, listener);
    handleLocation(readPendingChatFileAnnotationLocation());
    return () => window.removeEventListener(CHAT_FILE_ANNOTATION_LOCATE_EVENT, listener);
  }, [
    containerRef,
    renderedSource,
    renderedSourceOffset,
    source,
    sourceIdentity.sourceFilePath,
    sourceIdentity.surface,
    sourceRenderMode,
  ]);

  useEffect(() => {
    if (!conversationId || !saved || explicitSelection === undefined) {
      if (!saved || !conversationId) setPending(null);
      return;
    }
    const sequence = ++selectionSequenceRef.current;
    if (!explicitSelection || !explicitSelection.selectedText.trim()) {
      setPending(null);
      return;
    }
    void hashChatAnnotationSource(source).then((sourceHash) => {
      if (selectionSequenceRef.current !== sequence) return;
      setPending({ ...explicitSelection, sourceHash, autoFocus: false });
    });
  }, [conversationId, explicitSelection, saved, source]);

  useEffect(() => {
    if (explicitSelection !== undefined) return undefined;
    const updateSelection = (event: MouseEvent | TouchEvent | KeyboardEvent) => {
      const root = containerRef.current;
      const selection = window.getSelection();
      if (!conversationId || !saved || !root || !selection || selection.rangeCount !== 1 || selection.isCollapsed) {
        setPending(null);
        return;
      }
      const range = selection.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) {
        setPending(null);
        return;
      }
      const sourceRange = resolveRenderedFileSelectionRange(
        root,
        range,
        renderedSource,
        renderedSourceOffset,
      );
      const selectedText = sourceRange?.selectedText ?? "";
      if (!selectedText.trim() || !sourceRange) {
        setPending(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        setPending(null);
        return;
      }
      const sequence = ++selectionSequenceRef.current;
      void hashChatAnnotationSource(source).then((sourceHash) => {
        if (selectionSequenceRef.current !== sequence) return;
        setPending({
          ...sourceRange,
          selectedText,
          anchorRect: rect,
          autoFocus: shouldAutoFocusChatAnnotationToolbar(event),
          sourceHash,
        });
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
  }, [containerRef, conversationId, explicitSelection, saved, source]);

  if (!pending || !conversationId) return null;
  const boundaryRect = containerRef.current?.getBoundingClientRect() ?? null;
  const request = (action: "add_to_chat" | "ask_in_side_chat") => {
    const annotation: ChatInlineAnnotationInput = {
      id: globalThis.crypto.randomUUID(),
      comment: null,
      attachmentIds: [],
      selectedText: pending.selectedText,
      sourceConversationId: conversationId,
      sourceHash: pending.sourceHash,
      start: pending.start,
      end: pending.end,
      prefix: source.slice(
        Math.max(0, pending.start - MAX_CHAT_INLINE_ANNOTATION_CONTEXT_LENGTH),
        pending.start,
      ),
      suffix: source.slice(
        pending.end,
        pending.end + MAX_CHAT_INLINE_ANNOTATION_CONTEXT_LENGTH,
      ),
      sourceRenderMode,
      ...sourceIdentity,
    };
    requestChatFileAnnotation({
      action,
      annotation,
      anchorRect: pending.anchorRect,
      boundaryRect,
    });
    setPending(null);
  };

  return (
    <SelectionAnnotationToolbar
      open
      anchorRect={pending.anchorRect}
      boundaryRect={boundaryRect}
      anchorObservationRoot={containerRef.current}
      onAddToChat={() => request("add_to_chat")}
      onAskInSideChat={() => request("ask_in_side_chat")}
      onDismiss={() => setPending(null)}
      onAnchorUnavailable={() => setPending(null)}
      autoFocus={pending.autoFocus}
    />
  );
}
