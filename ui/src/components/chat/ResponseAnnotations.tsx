import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  CHAT_ANNOTATION_IGNORE_ATTRIBUTE,
  restoreChatAnnotationRange,
} from "@/lib/chat-response-annotation-selection";
import { isImageContentType } from "@/lib/image-actions";
import { cn } from "@/lib/utils";
import type {
  ChatAttachment,
  ChatInlineAnnotation,
  ChatInlineAnnotationInput,
} from "@rudderhq/shared";
import {
  MAX_CHAT_INLINE_ANNOTATION_ATTACHMENTS,
  MAX_CHAT_INLINE_ANNOTATION_COMMENT_LENGTH,
  MAX_CHAT_INLINE_ANNOTATION_TOTAL_TEXT_LENGTH,
} from "@rudderhq/shared";
import {
  ChevronDown,
  ChevronUp,
  MessageSquareText,
  Paperclip,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type CSSProperties,
  type ReactElement,
  type Ref,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  ChatFileAttachmentChip,
  ChatImageAttachmentTile,
  PendingAttachmentPreview,
} from "../../pages/Chat.attachments";
import {
  collectResponseAnnotationTextRects,
  collectVisibleAnnotationRangeRects,
} from "./response-annotation-highlight-geometry";

export type ResponseAnnotationAnchorRect = Pick<
  DOMRect,
  "left" | "right" | "top" | "bottom" | "width" | "height"
>;

export function useResponseAnnotationEditorController(
  fallbackFocusRef: RefObject<HTMLButtonElement | null>,
) {
  const [annotationId, setAnnotationId] = useState<string | null>(null);
  const [initialAnchor, setInitialAnchor] = useState<{
    anchorRect: ResponseAnnotationAnchorRect;
    boundaryRect: ResponseAnnotationAnchorRect | null;
  } | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => {
    setInitialAnchor(null);
    setAnnotationId(null);
  }, []);
  const openFromAnchor = useCallback((
    nextAnnotationId: string,
    anchor: HTMLButtonElement | null,
  ) => {
    anchorRef.current = anchor;
    setInitialAnchor(null);
    setAnnotationId(nextAnnotationId);
  }, []);
  const openFromSelection = useCallback((
    nextAnnotationId: string,
    nextInitialAnchor: NonNullable<typeof initialAnchor>,
  ) => {
    anchorRef.current = null;
    setInitialAnchor(nextInitialAnchor);
    setAnnotationId(nextAnnotationId);
  }, []);
  const getAnchorRect = useCallback(() => (
    anchorRef.current?.isConnected
      ? anchorRef.current.getBoundingClientRect()
      : initialAnchor?.anchorRect ?? null
  ), [initialAnchor]);
  const getBoundaryRect = useCallback(() => (
    (anchorRef.current?.isConnected
      ? anchorRef.current
        .closest<HTMLElement>('[data-testid="chat-main-workspace-card"]')
        ?.getBoundingClientRect()
      : null)
      ?? initialAnchor?.boundaryRect
      ?? null
  ), [initialAnchor]);

  return {
    annotationId,
    close,
    openFromAnchor,
    openFromSelection,
    editorPlacement: {
      anchorRect: getAnchorRect(),
      getAnchorRect,
      boundaryRect: getBoundaryRect(),
      getBoundaryRect,
      returnFocusRef: anchorRef.current ? anchorRef : fallbackFocusRef,
    },
  };
}

export type ResponseAnnotationEditorChanges = {
  comment: string | null;
  pendingFiles: File[];
  attachmentIds: string[];
};

export function placeResponseAnnotationEditor(
  anchorRect: ResponseAnnotationAnchorRect,
  editorSize: { width: number; height: number },
  viewport: {
    width: number;
    height: number;
    padding: number;
    gap: number;
    boundaryRect?: ResponseAnnotationAnchorRect | null;
  },
): { left: number; top: number; placement: "top" | "bottom" } {
  const boundary = viewport.boundaryRect;
  const minLeft = Math.max(
    viewport.padding,
    boundary ? boundary.left + viewport.padding : viewport.padding,
  );
  const maxRight = Math.min(
    viewport.width - viewport.padding,
    boundary ? boundary.right - viewport.padding : viewport.width - viewport.padding,
  );
  const minTop = Math.max(
    viewport.padding,
    boundary ? boundary.top + viewport.padding : viewport.padding,
  );
  const maxBottom = Math.min(
    viewport.height - viewport.padding,
    boundary ? boundary.bottom - viewport.padding : viewport.height - viewport.padding,
  );
  const preferredLeft = anchorRect.left + (anchorRect.width - editorSize.width) / 2;
  const maxLeft = Math.max(minLeft, maxRight - editorSize.width);
  const left = Math.min(Math.max(preferredLeft, minLeft), maxLeft);
  const topPosition = anchorRect.top - viewport.gap - editorSize.height;
  const placement = topPosition >= minTop ? "top" : "bottom";
  const preferredTop = placement === "top"
    ? topPosition
    : anchorRect.bottom + viewport.gap;
  const maxTop = Math.max(minTop, maxBottom - editorSize.height);
  return {
    left,
    top: Math.min(Math.max(preferredTop, minTop), maxTop),
    placement,
  };
}

export function placeResponseAnnotationMarker(
  finalLineRect: ResponseAnnotationAnchorRect,
  sourceRootRect: ResponseAnnotationAnchorRect,
  viewport: {
    viewportWidth: number;
    markerSize: number;
    gap: number;
    padding: number;
    textRects?: ResponseAnnotationAnchorRect[];
  } = {
    viewportWidth: typeof window === "undefined" ? 1_024 : window.innerWidth,
    markerSize: 28,
    gap: 6,
    padding: 8,
  },
): { left: number; top: number } {
  const minLeft = viewport.padding - sourceRootRect.left;
  const maxLeft = viewport.viewportWidth
    - viewport.padding
    - viewport.markerSize
    - sourceRootRect.left;
  const right = finalLineRect.right - sourceRootRect.left + viewport.gap;
  const left = finalLineRect.left
    - sourceRootRect.left
    - viewport.gap
    - viewport.markerSize;
  const centeredTop = Math.max(
    0,
    finalLineRect.top
      - sourceRootRect.top
      + (finalLineRect.height - viewport.markerSize) / 2,
  );
  if (right <= maxLeft) return { left: right, top: centeredTop };
  if (left >= minLeft) return { left, top: centeredTop };
  const fallbackLeft = Math.min(Math.max(right, minLeft), maxLeft);
  const fallbackAbsoluteLeft = sourceRootRect.left + fallbackLeft;
  let fallbackAbsoluteTop = finalLineRect.bottom + viewport.gap;
  for (;;) {
    const collision = viewport.textRects?.find((rect) => (
      fallbackAbsoluteLeft < rect.right
      && fallbackAbsoluteLeft + viewport.markerSize > rect.left
      && fallbackAbsoluteTop < rect.bottom
      && fallbackAbsoluteTop + viewport.markerSize > rect.top
    ));
    if (!collision) break;
    fallbackAbsoluteTop = collision.bottom + viewport.gap;
  }
  return {
    left: fallbackLeft,
    top: Math.max(0, fallbackAbsoluteTop - sourceRootRect.top),
  };
}

export function avoidResponseAnnotationMarkerCollisions(
  positions: Array<{ id: string; left: number; top: number; direction?: -1 | 1 }>,
  markerSize: number,
  gap: number,
  bounds: { minLeft: number; maxLeft: number } = {
    minLeft: Number.NEGATIVE_INFINITY,
    maxLeft: Number.POSITIVE_INFINITY,
  },
  textRects: ResponseAnnotationAnchorRect[] = [],
) {
  const placed: Array<{ left: number; top: number }> = [];
  const result: Record<string, { left: number; top: number }> = {};
  for (const position of [...positions].sort(
    (left, right) => left.top - right.top || left.id.localeCompare(right.id),
  )) {
    let left = position.left;
    let top = position.top;
    const direction = position.direction ?? 1;
    const findMarkerCollision = () => placed.find((candidate) => (
      Math.abs(candidate.left - left) < markerSize + gap
      && Math.abs(candidate.top - top) < markerSize + gap
    ));
    const findTextCollision = () => textRects.find((rect) => (
      left < rect.right
      && left + markerSize > rect.left
      && top < rect.bottom
      && top + markerSize > rect.top
    ));
    let markerCollision = findMarkerCollision();
    let textCollision = findTextCollision();
    while (markerCollision || textCollision) {
      const shiftedLeft = left + direction * (markerSize + gap);
      const shiftedOverlapsText = textRects.some((rect) => (
        shiftedLeft < rect.right
        && shiftedLeft + markerSize > rect.left
        && top < rect.bottom
        && top + markerSize > rect.top
      ));
      if (
        shiftedLeft >= bounds.minLeft
        && shiftedLeft <= bounds.maxLeft
        && !shiftedOverlapsText
      ) {
        left = shiftedLeft;
      } else {
        left = position.left;
        top = Math.max(
          markerCollision ? markerCollision.top + markerSize + gap : top,
          textCollision ? textCollision.bottom + gap : top,
        );
      }
      markerCollision = findMarkerCollision();
      textCollision = findTextCollision();
    }
    result[position.id] = { left, top };
    placed.push({ left, top });
  }
  return result;
}

function completeVisualLineRect(
  textRects: DOMRect[],
  anchorRect: ResponseAnnotationAnchorRect,
): ResponseAnnotationAnchorRect | null {
  const anchorCenter = anchorRect.top + anchorRect.height / 2;
  const lineRects = textRects.filter(
    (rect) => anchorCenter >= rect.top - 1 && anchorCenter <= rect.bottom + 1,
  );
  if (lineRects.length === 0) return null;
  const left = Math.min(...lineRects.map((rect) => rect.left));
  const right = Math.max(...lineRects.map((rect) => rect.right));
  const top = Math.min(...lineRects.map((rect) => rect.top));
  const bottom = Math.max(...lineRects.map((rect) => rect.bottom));
  return {
    left,
    right,
    top,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

export type ResponseAnnotationLabels = {
  annotation: string;
  annotations: string;
  showAnnotations: (count: number) => string;
  hideAnnotations: (count: number) => string;
  clearAll: string;
  selectedText: string;
  comment: string;
  displayComment: string;
  optionalComment: string;
  addFiles: string;
  delete: string;
  cancel: string;
  save: string;
  showSource: string;
  sourceUnavailable: string;
};

const DEFAULT_LABELS: ResponseAnnotationLabels = {
  annotation: "annotation",
  annotations: "annotations",
  showAnnotations: (count) => `Show ${count} ${count === 1 ? "annotation" : "annotations"}`,
  hideAnnotations: (count) => `Hide ${count} ${count === 1 ? "annotation" : "annotations"}`,
  clearAll: "Clear all annotations",
  selectedText: "Selected excerpt",
  comment: "Comment",
  displayComment: "Your comment",
  optionalComment: "Add an optional comment…",
  addFiles: "Add images or files",
  delete: "Delete",
  cancel: "Cancel",
  save: "Save",
  showSource: "Show source",
  sourceUnavailable: "Source is no longer available.",
};

function countLabel(count: number, labels: ResponseAnnotationLabels) {
  return `${count} ${count === 1 ? labels.annotation : labels.annotations}`;
}

type ResponseAnnotation = ChatInlineAnnotation | ChatInlineAnnotationInput;

function isFileAnnotation(annotation: ResponseAnnotation) {
  return annotation.surface === "workspace_file" || annotation.surface === "local_file";
}

function AnnotationHoverDetails({
  annotations,
  labels,
}: {
  annotations: ResponseAnnotation[];
  labels: ResponseAnnotationLabels;
}) {
  return (
    <div
      data-testid="chat-response-annotation-hover-details"
      className="max-h-[min(18rem,calc(100vh-2rem))] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain text-left"
    >
      {annotations.map((annotation, index) => (
        <div
          key={annotation.id}
          className={cn(
            "min-w-0 whitespace-normal break-words",
            index > 0 && "mt-3 border-t border-[color:var(--border-soft)] pt-3",
          )}
        >
          <AnnotationContent
            annotation={annotation}
            ordinal={index + 1}
            attachments={[]}
            labels={labels}
          />
        </div>
      ))}
    </div>
  );
}

function AnnotationHoverTooltip({
  annotations,
  labels,
  children,
}: {
  annotations: ResponseAnnotation[];
  labels: ResponseAnnotationLabels;
  children: ReactElement;
}) {
  const chatAnnotations = annotations.filter((annotation) => !isFileAnnotation(annotation));
  if (chatAnnotations.length === 0) return children;
  return (
    <TooltipProvider
      delayDuration={180}
      skipDelayDuration={80}
      disableHoverableContent
    >
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent
          side="top"
          sideOffset={8}
          collisionPadding={8}
          data-testid="chat-response-annotation-hover-tooltip"
          className="pointer-events-none z-[100] max-w-[calc(100vw-1rem)] overflow-hidden border border-[color:var(--border-soft)] bg-popover p-3 text-left text-popover-foreground whitespace-normal shadow-lg"
        >
          <AnnotationHoverDetails annotations={chatAnnotations} labels={labels} />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function ResponseAnnotationCountChip({
  count,
  expanded,
  controlsId,
  onToggle,
  onClear,
  buttonRef,
  labels = DEFAULT_LABELS,
  hoverAnnotations = [],
  className,
}: {
  count: number;
  expanded: boolean;
  controlsId?: string;
  onToggle: () => void;
  onClear?: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
  labels?: ResponseAnnotationLabels;
  hoverAnnotations?: ResponseAnnotation[];
  className?: string;
}) {
  const chip = (
    <div
      data-testid="chat-response-annotation-count"
      className={cn(
        "inline-flex h-8 items-center overflow-hidden rounded-full border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] text-xs font-medium text-foreground shadow-[var(--shadow-xs)] [@media(pointer:coarse)]:h-11",
        className,
      )}
    >
      <button
        ref={buttonRef}
        type="button"
        className="inline-flex h-full items-center gap-1.5 px-3 transition-colors hover:bg-[color:var(--surface-active)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 motion-reduce:transition-none"
        aria-label={expanded ? labels.hideAnnotations(count) : labels.showAnnotations(count)}
        aria-expanded={expanded}
        aria-controls={controlsId}
        onClick={onToggle}
      >
        <MessageSquareText className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        {countLabel(count, labels)}
        {expanded
          ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />}
      </button>
      {onClear ? (
        <button
          type="button"
          className="inline-flex h-full w-8 items-center justify-center border-l border-[color:var(--border-soft)] text-muted-foreground transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 [@media(pointer:coarse)]:w-11 motion-reduce:transition-none"
          aria-label={labels.clearAll}
          onClick={onClear}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
  return (
    <AnnotationHoverTooltip annotations={hoverAnnotations} labels={labels}>
      {chip}
    </AnnotationHoverTooltip>
  );
}

export function ResponseAnnotationMarker({
  annotationId,
  ordinal,
  excerpt,
  annotation,
  labels = DEFAULT_LABELS,
  onActivate,
  className,
  style,
}: {
  annotationId?: string;
  ordinal: number;
  excerpt: string;
  annotation?: ResponseAnnotation;
  labels?: ResponseAnnotationLabels;
  onActivate: (anchor: HTMLButtonElement) => void;
  className?: string;
  style?: CSSProperties;
}) {
  const boundedExcerpt = excerpt.replace(/\s+/gu, " ").trim().slice(0, 80);
  const marker = (
    <button
      type="button"
      data-testid="chat-response-annotation-marker"
      data-annotation-id={annotationId}
      {...{ [CHAT_ANNOTATION_IGNORE_ATTRIBUTE]: "" }}
      className={cn(
        "motion-content-reveal inline-flex h-7 w-7 select-none items-center justify-center rounded-full text-[11px] font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 motion-reduce:animate-none",
        className,
      )}
      aria-label={`Annotation ${ordinal}: ${boundedExcerpt}`}
      onClick={(event) => onActivate(event.currentTarget)}
      style={style}
    >
      <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-1 shadow-[var(--shadow-sm)]">
        {ordinal}
      </span>
    </button>
  );
  return (
    <AnnotationHoverTooltip
      annotations={annotation ? [annotation] : []}
      labels={labels}
    >
      {marker}
    </AnnotationHoverTooltip>
  );
}

export function AnchoredResponseAnnotationMarkers({
  sourceRootRef,
  source,
  annotations,
  onActivate,
  labels = DEFAULT_LABELS,
}: {
  sourceRootRef: RefObject<HTMLElement | null>;
  source: string;
  annotations: Array<ChatInlineAnnotationInput & { ordinal?: number }>;
  onActivate?: (annotationId: string, anchor: HTMLButtonElement) => void;
  labels?: ResponseAnnotationLabels;
}) {
  const [positions, setPositions] = useState<Record<string, { left: number; top: number }>>({});
  const [highlightRects, setHighlightRects] = useState<Record<
    string,
    Array<{ left: number; top: number; width: number; height: number }>
  >>({});

  useLayoutEffect(() => {
    const sourceRoot = sourceRootRef.current;
    if (!sourceRoot || annotations.length === 0) {
      setPositions({});
      setHighlightRects({});
      return;
    }
    let frameId: number | null = null;
    const update = () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        frameId = null;
        const rootRect = sourceRoot.getBoundingClientRect();
        const textRects = collectResponseAnnotationTextRects(sourceRoot);
        const markerSize = window.matchMedia?.("(pointer: coarse)").matches ? 44 : 28;
        const nextHighlightRects: Record<
          string,
          Array<{ left: number; top: number; width: number; height: number }>
        > = {};
        const candidates: Array<{
          id: string;
          left: number;
          top: number;
          direction: -1 | 1;
        }> = [];
        for (const annotation of annotations) {
          if (annotation.surface === "agent_run_transcript") continue;
          const range = restoreChatAnnotationRange({
            sourceRoot,
            source,
            start: annotation.start,
            end: annotation.end,
          });
          if (!range || typeof range.getBoundingClientRect !== "function") continue;
          const rects = collectVisibleAnnotationRangeRects(sourceRoot, range);
          nextHighlightRects[annotation.id] = rects
            .map((rect) => ({
              left: rect.left - rootRect.left,
              top: rect.top - rootRect.top,
              width: rect.width,
              height: rect.height,
            }));
          const anchorRect = rects.at(-1);
          if (!anchorRect) continue;
          const lineRect = completeVisualLineRect(textRects, anchorRect) ?? anchorRect;
          const position = placeResponseAnnotationMarker(lineRect, rootRect, {
            viewportWidth: window.innerWidth,
            markerSize,
            gap: 6,
            padding: 8,
            textRects,
          });
          candidates.push({
            id: annotation.id,
            ...position,
            direction: position.left >= lineRect.right - rootRect.left ? 1 : -1,
          });
        }
        setPositions(avoidResponseAnnotationMarkerCollisions(
          candidates,
          markerSize,
          2,
          {
            minLeft: 8 - rootRect.left,
            maxLeft: window.innerWidth - 8 - markerSize - rootRect.left,
          },
          textRects.map((rect) => ({
            left: rect.left - rootRect.left,
            right: rect.right - rootRect.left,
            top: rect.top - rootRect.top,
            bottom: rect.bottom - rootRect.top,
            width: rect.width,
            height: rect.height,
          })),
        ));
        setHighlightRects(nextHighlightRects);
      });
    };
    update();
    window.addEventListener("resize", update);
    sourceRoot.addEventListener("scroll", update, true);
    sourceRoot.addEventListener("load", update, true);
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(update);
    observer?.observe(sourceRoot);
    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      window.removeEventListener("resize", update);
      sourceRoot.removeEventListener("scroll", update, true);
      sourceRoot.removeEventListener("load", update, true);
      observer?.disconnect();
    };
  }, [annotations, source, sourceRootRef]);

  return (
    <>
      {annotations.map((annotation) => (
        <span
          key={`highlight-${annotation.id}`}
          data-testid="chat-response-annotation-highlight"
          data-annotation-id={annotation.id}
          {...{ [CHAT_ANNOTATION_IGNORE_ATTRIBUTE]: "" }}
          className="pointer-events-none absolute inset-0 z-10"
          aria-hidden="true"
        >
          {(highlightRects[annotation.id] ?? []).map((rect, rectIndex) => (
            <span
              key={`${annotation.id}-${rectIndex}`}
              className="absolute rounded-[2px] bg-primary/20"
              style={rect}
            />
          ))}
        </span>
      ))}
      {annotations.map((annotation, index) => {
        const position = positions[annotation.id];
        if (!position) return null;
        return (
          <ResponseAnnotationMarker
            key={annotation.id}
            annotationId={annotation.id}
            ordinal={annotation.ordinal ?? index + 1}
            excerpt={annotation.selectedText}
            annotation={annotation}
            labels={labels}
            onActivate={(anchor) => onActivate?.(annotation.id, anchor)}
            className="absolute z-20"
            style={position}
          />
        );
      })}
    </>
  );
}

function AnnotationAttachment({
  attachment,
}: {
  attachment: ChatAttachment;
}) {
  const name = attachment.originalFilename ?? attachment.assetId;
  if (isImageContentType(attachment.contentType)) {
    return (
      <ChatImageAttachmentTile
        src={attachment.contentPath}
        name={name}
        testId="chat-annotation-image-attachment"
      />
    );
  }
  return <ChatFileAttachmentChip name={name} href={attachment.contentPath} />;
}

function EditableAnnotationAttachment({
  attachment,
  onRemove,
}: {
  attachment: ChatAttachment;
  onRemove: () => void;
}) {
  const name = attachment.originalFilename ?? attachment.assetId;
  return (
    <div className="relative inline-flex max-w-full items-center gap-1">
      <AnnotationAttachment attachment={attachment} />
      <button
        type="button"
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 motion-reduce:transition-none"
        aria-label={`Remove ${name}`}
        onClick={onRemove}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function AnnotationContent({
  annotation,
  ordinal,
  attachments,
  labels,
  showComment = true,
}: {
  annotation: ChatInlineAnnotation | ChatInlineAnnotationInput;
  ordinal: number;
  attachments: ChatAttachment[];
  labels: ResponseAnnotationLabels;
  showComment?: boolean;
}) {
  return (
    <>
      <section data-testid="chat-response-annotation-selected-text">
        <p className="text-xs font-semibold text-muted-foreground">
          {ordinal}. {labels.selectedText}
        </p>
        {annotation.surface === "workspace_file" || annotation.surface === "local_file" ? (
          <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={annotation.sourceFilePath}>
            {annotation.sourceFilePath}
          </p>
        ) : null}
        <blockquote className="mt-2 border-l-2 border-[color:var(--accent-base)] bg-muted/45 px-3 py-2 whitespace-pre-wrap text-sm leading-5 text-foreground">
          {annotation.selectedText}
        </blockquote>
      </section>
      {showComment && annotation.comment?.trim() ? (
        <section
          className="mt-3 border-t border-[color:var(--border-soft)] pt-3"
          data-testid="chat-response-annotation-comment"
        >
          <p className="text-xs font-semibold text-muted-foreground">{labels.displayComment}</p>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-5 text-foreground">
            {annotation.comment}
          </p>
        </section>
      ) : null}
      {attachments.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {attachments.map((attachment) => (
            <AnnotationAttachment key={attachment.id} attachment={attachment} />
          ))}
        </div>
      ) : null}
    </>
  );
}

export function ResponseAnnotationEditor({
  annotation,
  ordinal,
  pendingFiles,
  attachments = [],
  anchorRect,
  getAnchorRect,
  boundaryRect,
  getBoundaryRect,
  returnFocusRef,
  validateSave,
  autoFocus,
  showSelectedTextContext = false,
  onSave,
  onCancel,
  onDelete,
  labels = DEFAULT_LABELS,
  className,
}: {
  annotation: ChatInlineAnnotation | ChatInlineAnnotationInput;
  ordinal: number;
  pendingFiles: File[];
  attachments?: ChatAttachment[];
  anchorRect?: ResponseAnnotationAnchorRect | null;
  getAnchorRect?: () => ResponseAnnotationAnchorRect | null;
  boundaryRect?: ResponseAnnotationAnchorRect | null;
  getBoundaryRect?: () => ResponseAnnotationAnchorRect | null;
  returnFocusRef?: RefObject<HTMLElement | null>;
  validateSave?: (changes: ResponseAnnotationEditorChanges) => string | null;
  autoFocus?: boolean;
  showSelectedTextContext?: boolean;
  onSave: (changes: ResponseAnnotationEditorChanges) => void;
  onCancel: () => void;
  onDelete: () => void;
  labels?: ResponseAnnotationLabels;
  className?: string;
}) {
  const [comment, setComment] = useState(annotation.comment ?? "");
  const [draftPendingFiles, setDraftPendingFiles] = useState(() => [...pendingFiles]);
  const [draftAttachmentIds, setDraftAttachmentIds] = useState(() => (
    [...(annotation.attachmentIds ?? attachments.map((attachment) => attachment.id))]
  ));
  const [validationError, setValidationError] = useState<string | null>(null);
  const [liveAnchorRect, setLiveAnchorRect] = useState(anchorRect ?? null);
  const [liveBoundaryRect, setLiveBoundaryRect] = useState(boundaryRect ?? null);
  const [editorSize, setEditorSize] = useState({ width: 352, height: 224 });
  const [closing, setClosing] = useState(false);
  const inputId = useId();
  const editorRef = useRef<HTMLElement>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const closeActionRef = useRef<(() => void) | null>(null);
  const closeFallbackTimerRef = useRef<number | null>(null);
  const visibleAttachments = attachments.filter((attachment) => draftAttachmentIds.includes(attachment.id));
  const anchored = Boolean(anchorRect);
  const viewportWidth = typeof window === "undefined" ? 1024 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 768 : window.innerHeight;
  const boundaryMaxWidth = liveBoundaryRect
    ? Math.max(
        0,
        Math.min(viewportWidth - 8, liveBoundaryRect.right - 8)
          - Math.max(8, liveBoundaryRect.left + 8),
      )
    : undefined;
  const boundaryMaxHeight = liveBoundaryRect
    ? Math.max(
        0,
        Math.min(viewportHeight - 8, liveBoundaryRect.bottom - 8)
          - Math.max(8, liveBoundaryRect.top + 8),
      )
    : undefined;
  const placement = liveAnchorRect
    ? placeResponseAnnotationEditor(
        liveAnchorRect,
        editorSize,
        {
          width: viewportWidth,
          height: viewportHeight,
          padding: 8,
          gap: 8,
          boundaryRect: liveBoundaryRect,
        },
      )
    : null;

  const restoreFocus = useCallback(() => {
    returnFocusRef?.current?.focus();
  }, [returnFocusRef]);

  const completeClose = useCallback(() => {
    if (closeFallbackTimerRef.current !== null) {
      window.clearTimeout(closeFallbackTimerRef.current);
      closeFallbackTimerRef.current = null;
    }
    const action = closeActionRef.current;
    closeActionRef.current = null;
    action?.();
  }, []);

  const requestClose = useCallback((action: () => void) => {
    if (closing || closeActionRef.current) return;
    if (
      typeof window.matchMedia !== "function"
      || window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      action();
      return;
    }
    closeActionRef.current = action;
    setClosing(true);
    closeFallbackTimerRef.current = window.setTimeout(completeClose, 250);
  }, [closing, completeClose]);

  const dismiss = useCallback(() => {
    requestClose(() => {
      onCancel();
      restoreFocus();
    });
  }, [onCancel, requestClose, restoreFocus]);

  const commitWithExitSnapshot = useCallback((action: () => void) => {
    const editor = editorRef.current;
    const reduceMotion = (
      typeof window.matchMedia !== "function"
      || window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
    if (!editor || reduceMotion) {
      action();
      restoreFocus();
      return;
    }
    const rect = editor.getBoundingClientRect();
    const snapshot = editor.cloneNode(true) as HTMLElement;
    snapshot.setAttribute("aria-hidden", "true");
    snapshot.setAttribute("inert", "");
    snapshot.dataset.testid = "chat-response-annotation-editor-exit";
    snapshot.dataset.state = "open";
    snapshot.style.position = "fixed";
    snapshot.style.left = `${rect.left}px`;
    snapshot.style.top = `${rect.top}px`;
    snapshot.style.width = `${rect.width}px`;
    snapshot.style.height = `${rect.height}px`;
    snapshot.style.margin = "0";
    snapshot.style.pointerEvents = "none";
    snapshot.style.zIndex = "91";
    snapshot.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
    document.body.appendChild(snapshot);
    void snapshot.offsetWidth;
    snapshot.dataset.state = "closed";
    const removeSnapshot = () => snapshot.remove();
    snapshot.addEventListener("animationend", removeSnapshot, { once: true });
    window.setTimeout(removeSnapshot, 250);
    action();
    restoreFocus();
  }, [restoreFocus]);

  useEffect(() => () => {
    if (closeFallbackTimerRef.current !== null) {
      window.clearTimeout(closeFallbackTimerRef.current);
    }
  }, []);

  useEffect(() => {
    setLiveAnchorRect(anchorRect ?? null);
  }, [anchorRect]);

  useEffect(() => {
    setLiveBoundaryRect(boundaryRect ?? null);
  }, [boundaryRect]);

  useLayoutEffect(() => {
    if (!anchored) return;
    const editor = editorRef.current;
    if (!editor) return;
    const measure = () => {
      const rect = editor.getBoundingClientRect();
      const width = rect.width || editor.scrollWidth;
      const height = rect.height || editor.scrollHeight;
      if (width <= 0 || height <= 0) return;
      setEditorSize((current) => (
        current.width === width && current.height === height
          ? current
          : { width, height }
      ));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(editor);
    return () => observer?.disconnect();
  }, [anchored]);

  useEffect(() => {
    if (!anchored) return;
    const updatePosition = () => {
      const nextAnchorRect = getAnchorRect?.();
      if (nextAnchorRect) setLiveAnchorRect(nextAnchorRect);
      const nextBoundaryRect = getBoundaryRect?.();
      if (nextBoundaryRect) setLiveBoundaryRect(nextBoundaryRect);
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    document.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      document.removeEventListener("scroll", updatePosition, true);
    };
  }, [anchored, getAnchorRect, getBoundaryRect]);

  useEffect(() => {
    if (!anchored) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (editorRef.current?.contains(event.target as Node)) return;
      dismiss();
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismiss();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [anchored, dismiss]);

  useEffect(() => {
    if (!(autoFocus ?? anchored)) return;
    commentRef.current?.focus();
  }, [anchored, autoFocus]);

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (files.length > 0) {
      setDraftPendingFiles((current) => [...current, ...files]);
      setValidationError(null);
    }
    event.target.value = "";
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const images = Array.from(event.clipboardData.files).filter(
      (file) => file.type.startsWith("image/"),
    );
    if (images.length === 0) return;
    event.preventDefault();
    setDraftPendingFiles((current) => [...current, ...images]);
    setValidationError(null);
  }

  function handleSave() {
    const changes: ResponseAnnotationEditorChanges = {
      comment: comment.trim() || null,
      pendingFiles: draftPendingFiles,
      attachmentIds: draftAttachmentIds,
    };
    const localError = comment.length > MAX_CHAT_INLINE_ANNOTATION_COMMENT_LENGTH
      ? `An annotation comment cannot exceed ${MAX_CHAT_INLINE_ANNOTATION_COMMENT_LENGTH.toLocaleString()} characters.`
      : annotation.selectedText.length + comment.length > MAX_CHAT_INLINE_ANNOTATION_TOTAL_TEXT_LENGTH
        ? `Annotation text cannot exceed ${MAX_CHAT_INLINE_ANNOTATION_TOTAL_TEXT_LENGTH.toLocaleString()} characters in total.`
        : draftAttachmentIds.length + draftPendingFiles.length > MAX_CHAT_INLINE_ANNOTATION_ATTACHMENTS
          ? `Annotations can include at most ${MAX_CHAT_INLINE_ANNOTATION_ATTACHMENTS} files.`
          : null;
    const error = localError ?? validateSave?.(changes) ?? null;
    if (error) {
      setValidationError(error);
      return;
    }
    setValidationError(null);
    commitWithExitSnapshot(() => onSave(changes));
  }

  const editor = (
    <section
      ref={editorRef}
      data-testid="chat-response-annotation-editor"
      data-placement={placement?.placement}
      data-state={closing ? "closed" : "open"}
      className={cn(
        "motion-surface-pop w-[min(22rem,calc(100vw-1rem))] rounded-[var(--radius-xl)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] p-4 shadow-[var(--shadow-lg)]",
        anchored && "fixed z-[90] max-h-[min(36rem,calc(100vh-1rem))] overflow-y-auto overscroll-contain",
        closing && "pointer-events-none",
        className,
      )}
      style={anchored
        ? {
            left: placement?.left ?? 8,
            top: placement?.top ?? 8,
            maxWidth: boundaryMaxWidth,
            maxHeight: boundaryMaxHeight,
            visibility: placement ? "visible" : "hidden",
          }
        : undefined}
      aria-label={`Edit annotation ${ordinal}`}
      onAnimationEnd={(event) => {
        if (closing && event.currentTarget === event.target) completeClose();
      }}
    >
      {showSelectedTextContext ? (
        <div data-testid="chat-response-annotation-selected-text" className="mb-3">
          <p className="text-xs font-medium text-muted-foreground">
            {ordinal}. {labels.selectedText}
          </p>
          <blockquote className="mt-1 line-clamp-3 whitespace-pre-wrap text-sm leading-5 text-foreground">
            {annotation.selectedText}
          </blockquote>
        </div>
      ) : null}
      {visibleAttachments.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {visibleAttachments.map((attachment) => (
            <EditableAnnotationAttachment
              key={attachment.id}
              attachment={attachment}
              onRemove={() => {
                setDraftAttachmentIds((current) => (
                  current.filter((attachmentId) => attachmentId !== attachment.id)
                ));
                setValidationError(null);
              }}
            />
          ))}
        </div>
      ) : null}
      <label htmlFor={`${inputId}-comment`} className="sr-only">
        {labels.comment}
      </label>
      <textarea
        id={`${inputId}-comment`}
        ref={commentRef}
        value={comment}
        aria-label={labels.comment}
        onChange={(event) => {
          setComment(event.target.value);
          setValidationError(null);
        }}
        onPaste={handlePaste}
        placeholder={labels.optionalComment}
        maxLength={2_000}
        className="mt-1 min-h-20 w-full resize-y rounded-[var(--radius-md)] border border-[color:var(--border-soft)] bg-transparent px-3 py-2 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
      />
      {draftPendingFiles.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {draftPendingFiles.map((file, index) => (
            <div
              key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
              data-testid="chat-response-annotation-pending-attachment"
              className="max-w-full"
            >
              <span className="sr-only">{file.name}</span>
              <PendingAttachmentPreview
                file={file}
                onRemove={() => {
                  setDraftPendingFiles((current) => (
                    current.filter((_, fileIndex) => fileIndex !== index)
                  ));
                  setValidationError(null);
                }}
              />
            </div>
          ))}
        </div>
      ) : null}
      {validationError ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {validationError}
        </p>
      ) : null}
      <div className="mt-4 flex items-center gap-2">
        <label
          aria-label={labels.addFiles}
          title={labels.addFiles}
          className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/40 [@media(pointer:coarse)]:h-11 motion-reduce:transition-none"
        >
          <input
            id={`${inputId}-files`}
            type="file"
            multiple
            className="sr-only"
            onChange={handleFiles}
          />
          <Paperclip className="h-3.5 w-3.5" />
        </label>
        <button
          type="button"
          className="ml-auto inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-md)] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 motion-reduce:transition-none"
          aria-label="Delete annotation"
          onClick={() => {
            commitWithExitSnapshot(onDelete);
          }}
        >
          <Trash2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="inline-flex h-9 items-center rounded-[var(--radius-md)] px-3 text-sm font-medium text-foreground transition-colors hover:bg-[color:var(--surface-active)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 [@media(pointer:coarse)]:h-11 motion-reduce:transition-none"
          onClick={dismiss}
        >
          {labels.cancel}
        </button>
        <button
          type="button"
          className="inline-flex h-9 items-center rounded-[var(--radius-md)] bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 [@media(pointer:coarse)]:h-11 motion-reduce:transition-none"
          onClick={handleSave}
        >
          {labels.save}
        </button>
      </div>
    </section>
  );
  return anchored && typeof document !== "undefined"
    ? createPortal(editor, document.body)
    : editor;
}

export function EditableResponseAnnotationsCard({
  annotations,
  pendingFilesByAnnotationId,
  attachments = [],
  onEdit,
  onDelete,
  labels = DEFAULT_LABELS,
}: {
  annotations: Array<ChatInlineAnnotationInput & { ordinal?: number }>;
  pendingFilesByAnnotationId: Record<string, File[]>;
  attachments?: ChatAttachment[];
  onEdit: (annotation: ChatInlineAnnotationInput, anchor: HTMLButtonElement) => void;
  onDelete: (annotationId: string) => void;
  labels?: ResponseAnnotationLabels;
}) {
  return (
    <ol
      data-testid="chat-response-annotation-card"
      className="w-[min(28rem,calc(100vw-1rem))] divide-y divide-[color:var(--border-soft)] rounded-[var(--radius-xl)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] shadow-[var(--shadow-lg)]"
    >
      {annotations.map((annotation, index) => {
        const ownedAttachments = attachments.filter((attachment) => annotation.attachmentIds?.includes(attachment.id));
        return (
          <li key={annotation.id} className="group relative p-4">
            <AnnotationContent
              annotation={annotation}
              ordinal={annotation.ordinal ?? index + 1}
              attachments={ownedAttachments}
              labels={labels}
            />
            {(pendingFilesByAnnotationId[annotation.id] ?? []).length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                {(pendingFilesByAnnotationId[annotation.id] ?? []).map((file, fileIndex) => (
                  <span key={`${file.name}-${fileIndex}`} className="chat-chip inline-flex items-center gap-1.5 px-2 py-1">
                    <Paperclip className="h-3 w-3" />
                    {file.name}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="absolute right-2 top-2 flex opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none">
              <button
                type="button"
                data-annotation-id={annotation.id}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-[color:var(--surface-active)] hover:text-foreground [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
                aria-label={`Edit annotation ${index + 1}`}
                onClick={(event) => onEdit(annotation, event.currentTarget)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
                aria-label={`Delete annotation ${index + 1}`}
                onClick={() => onDelete(annotation.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function DraftResponseAnnotationsPopover({
  annotations,
  pendingFilesByAnnotationId,
  attachments = [],
  open,
  onOpenChange,
  onClear,
  onEdit,
  onDelete,
  buttonRef,
  labels = DEFAULT_LABELS,
}: {
  annotations: Array<ChatInlineAnnotationInput & { ordinal?: number }>;
  pendingFilesByAnnotationId: Record<string, File[]>;
  attachments?: ChatAttachment[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClear: () => void;
  onEdit: (annotation: ChatInlineAnnotationInput) => void;
  onDelete: (annotationId: string) => void;
  buttonRef?: Ref<HTMLButtonElement>;
  labels?: ResponseAnnotationLabels;
}) {
  const controlsId = useId();
  const internalButtonRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusOnCloseRef = useRef(true);
  const setButtonRef = useCallback((node: HTMLButtonElement | null) => {
    internalButtonRef.current = node;
    if (typeof buttonRef === "function") buttonRef(node);
    else if (buttonRef) buttonRef.current = node;
  }, [buttonRef]);
  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen) restoreFocusOnCloseRef.current = true;
    onOpenChange(nextOpen);
  }, [onOpenChange]);
  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverAnchor asChild>
        <div>
          <ResponseAnnotationCountChip
            count={annotations.length}
            expanded={open}
            controlsId={controlsId}
            buttonRef={setButtonRef}
            hoverAnnotations={annotations}
            onToggle={() => {
              restoreFocusOnCloseRef.current = true;
              handleOpenChange(!open);
            }}
            onClear={onClear}
            labels={labels}
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        ref={contentRef}
        id={controlsId}
        data-testid="chat-response-annotations-draft-popover"
        side="top"
        align="start"
        sideOffset={8}
        avoidCollisions={false}
        className="max-h-[min(32rem,var(--radix-popover-content-available-height))] w-[min(28rem,calc(100vw-1rem))] overflow-y-auto overscroll-contain border-0 bg-transparent p-0 shadow-none"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          requestAnimationFrame(() => {
            contentRef.current
              ?.querySelector<HTMLButtonElement>("[aria-label^='Edit annotation']")
              ?.focus();
          });
        }}
        onPointerDownOutside={() => {
          restoreFocusOnCloseRef.current = false;
        }}
        onEscapeKeyDown={() => {
          restoreFocusOnCloseRef.current = true;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (restoreFocusOnCloseRef.current) internalButtonRef.current?.focus();
          restoreFocusOnCloseRef.current = true;
        }}
      >
        <EditableResponseAnnotationsCard
          annotations={annotations}
          pendingFilesByAnnotationId={pendingFilesByAnnotationId}
          attachments={attachments}
          labels={labels}
          onEdit={(annotation) => {
            restoreFocusOnCloseRef.current = false;
            handleOpenChange(false);
            onEdit(annotation);
          }}
          onDelete={onDelete}
        />
      </PopoverContent>
    </Popover>
  );
}

export function SentResponseAnnotationsCard({
  annotations,
  attachments,
  onSelect,
  onExpandedChange,
  unlocatableAnnotationId,
  labels = DEFAULT_LABELS,
  className,
}: {
  annotations: ChatInlineAnnotation[];
  attachments: ChatAttachment[];
  onSelect?: (annotation: ChatInlineAnnotation, ordinal: number) => void;
  onExpandedChange?: (expanded: boolean) => void;
  unlocatableAnnotationId?: string | null;
  labels?: ResponseAnnotationLabels;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [cardPosition, setCardPosition] = useState<{ left: number; top: number } | null>(null);
  const annotationsListId = useId();
  const chipAnchorRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLOListElement>(null);
  const expandedRef = useRef(false);
  const closeDetails = useCallback((restoreFocus: boolean) => {
    if (!expandedRef.current) return;
    expandedRef.current = false;
    setExpanded(false);
    onExpandedChange?.(false);
    if (restoreFocus) {
      chipAnchorRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    }
  }, [onExpandedChange]);

  useEffect(() => {
    if (!expanded) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        chipAnchorRef.current?.contains(target)
        || cardRef.current?.contains(target)
      ) {
        return;
      }
      closeDetails(false);
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeDetails(true);
    };
    const handleOtherCardOpened = (event: Event) => {
      const openedId = (event as CustomEvent<{ id?: string }>).detail?.id;
      if (openedId && openedId !== annotationsListId) closeDetails(false);
    };
    document.addEventListener("click", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("rudder:sent-response-annotations-opened", handleOtherCardOpened);
    return () => {
      document.removeEventListener("click", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("rudder:sent-response-annotations-opened", handleOtherCardOpened);
    };
  }, [annotationsListId, closeDetails, expanded]);

  useLayoutEffect(() => {
    if (!expanded) {
      setCardPosition(null);
      return;
    }
    let frameId: number | null = null;
    const update = () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        frameId = null;
        const anchor = chipAnchorRef.current;
        const card = cardRef.current;
        if (!anchor || !card) return;
        const anchorRect = anchor.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        const padding = 8;
        const gap = 8;
        const above = anchorRect.top - cardRect.height - gap;
        const top = above >= padding
          ? above
          : Math.min(
              window.innerHeight - cardRect.height - padding,
              anchorRect.bottom + gap,
            );
        setCardPosition({
          left: Math.max(
            padding,
            Math.min(anchorRect.right - cardRect.width, window.innerWidth - cardRect.width - padding),
          ),
          top: Math.max(padding, top),
        });
      });
    };
    update();
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(update);
    if (chipAnchorRef.current) observer?.observe(chipAnchorRef.current);
    if (cardRef.current) observer?.observe(cardRef.current);
    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true);
      observer?.disconnect();
    };
  }, [annotations.length, expanded]);
  if (annotations.length === 0) return null;

  return (
    <div className={cn("flex flex-col items-start gap-2", className)}>
      <div ref={chipAnchorRef}>
        <ResponseAnnotationCountChip
          count={annotations.length}
          expanded={expanded}
          controlsId={annotationsListId}
          hoverAnnotations={annotations}
          onToggle={() => {
            const next = !expandedRef.current;
            if (next) {
              document.dispatchEvent(new CustomEvent(
                "rudder:sent-response-annotations-opened",
                { detail: { id: annotationsListId } },
              ));
            }
            expandedRef.current = next;
            setExpanded(next);
            onExpandedChange?.(next);
          }}
          labels={labels}
        />
      </div>
      {expanded && typeof document !== "undefined" ? createPortal(
        <ol
          ref={cardRef}
          id={annotationsListId}
          data-testid="chat-response-annotation-sent-card"
          className="fixed z-[90] max-h-[min(28rem,calc(100vh-1rem))] w-[min(28rem,calc(100vw-1rem))] divide-y divide-[color:var(--border-soft)] overflow-y-auto overscroll-contain rounded-[var(--radius-xl)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] shadow-[var(--shadow-md)]"
          style={{
            left: cardPosition?.left ?? 8,
            top: cardPosition?.top ?? 8,
            visibility: cardPosition ? "visible" : "hidden",
          }}
        >
          {annotations.map((annotation, index) => {
            const ownedAttachments = attachments.filter((attachment) => annotation.attachmentIds.includes(attachment.id));
            return (
              <li
                key={annotation.id}
                data-testid="chat-response-annotation-sent-card-entry"
                data-annotation-surface={annotation.surface}
                className="p-4"
              >
                <div className="rounded-[var(--radius-md)]">
                  <AnnotationContent
                    annotation={annotation}
                    ordinal={index + 1}
                    attachments={[]}
                    labels={labels}
                  />
                </div>
                {ownedAttachments.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {ownedAttachments.map((attachment) => (
                      <AnnotationAttachment key={attachment.id} attachment={attachment} />
                    ))}
                  </div>
                ) : null}
                {onSelect && !isFileAnnotation(annotation) ? (
                  <button
                    type="button"
                    data-annotation-id={annotation.id}
                    className="mt-3 inline-flex min-h-8 items-center rounded-[var(--radius-md)] px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 [@media(pointer:coarse)]:min-h-11 motion-reduce:transition-none"
                    onClick={() => onSelect(annotation, index + 1)}
                  >
                    {labels.showSource}
                  </button>
                ) : null}
                {unlocatableAnnotationId === annotation.id ? (
                  <p
                    role="status"
                    data-testid="chat-response-annotation-unlocatable"
                    className="mt-2 text-xs text-muted-foreground"
                  >
                    {labels.sourceUnavailable}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>,
        document.body,
      ) : null}
    </div>
  );
}
