import { isImageContentType } from "@/lib/image-actions";
import {
  CHAT_ANNOTATION_IGNORE_ATTRIBUTE,
  restoreChatAnnotationRange,
} from "@/lib/chat-response-annotation-selection";
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
  type CSSProperties,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  ChatFileAttachmentChip,
  ChatImageAttachmentTile,
  PendingAttachmentPreview,
} from "../../pages/Chat.attachments";

export type ResponseAnnotationAnchorRect = Pick<
  DOMRect,
  "left" | "right" | "top" | "bottom" | "width" | "height"
>;

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
): { left: number; top: number } {
  return {
    left: Math.max(0, finalLineRect.right - sourceRootRect.left + 6),
    top: Math.max(0, finalLineRect.top - sourceRootRect.top),
  };
}

export type ResponseAnnotationLabels = {
  annotation: string;
  annotations: string;
  showAnnotations: (count: number) => string;
  hideAnnotations: (count: number) => string;
  clearAll: string;
  selectedText: string;
  userComment: string;
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
  selectedText: "Selected text:",
  userComment: "User comment:",
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

export function ResponseAnnotationCountChip({
  count,
  expanded,
  controlsId,
  onToggle,
  onClear,
  labels = DEFAULT_LABELS,
  className,
}: {
  count: number;
  expanded: boolean;
  controlsId?: string;
  onToggle: () => void;
  onClear?: () => void;
  labels?: ResponseAnnotationLabels;
  className?: string;
}) {
  return (
    <div
      data-testid="chat-response-annotation-count"
      className={cn(
        "inline-flex h-8 items-center overflow-hidden rounded-full border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] text-xs font-medium text-foreground shadow-[var(--shadow-xs)] [@media(pointer:coarse)]:h-11",
        className,
      )}
    >
      <button
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
}

export function ResponseAnnotationMarker({
  annotationId,
  ordinal,
  excerpt,
  onActivate,
  className,
  style,
}: {
  annotationId?: string;
  ordinal: number;
  excerpt: string;
  onActivate: (anchor: HTMLButtonElement) => void;
  className?: string;
  style?: CSSProperties;
}) {
  const boundedExcerpt = excerpt.replace(/\s+/gu, " ").trim().slice(0, 80);
  return (
    <button
      type="button"
      data-testid="chat-response-annotation-marker"
      data-annotation-id={annotationId}
      {...{ [CHAT_ANNOTATION_IGNORE_ATTRIBUTE]: "" }}
      className={cn(
        "inline-flex h-7 w-7 select-none items-center justify-center rounded-full text-[11px] font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11",
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
}

export function AnchoredResponseAnnotationMarkers({
  sourceRootRef,
  source,
  annotations,
  onActivate,
}: {
  sourceRootRef: RefObject<HTMLElement | null>;
  source: string;
  annotations: Array<ChatInlineAnnotationInput & { ordinal?: number }>;
  onActivate?: (annotationId: string, anchor: HTMLButtonElement) => void;
}) {
  const [positions, setPositions] = useState<Record<string, { left: number; top: number }>>({});

  useLayoutEffect(() => {
    const sourceRoot = sourceRootRef.current;
    if (!sourceRoot || annotations.length === 0) {
      setPositions({});
      return;
    }
    let frameId: number | null = null;
    const update = () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        frameId = null;
        const rootRect = sourceRoot.getBoundingClientRect();
        const next: Record<string, { left: number; top: number }> = {};
        for (const annotation of annotations) {
          const range = restoreChatAnnotationRange({
            sourceRoot,
            source,
            start: annotation.start,
            end: annotation.end,
          });
          if (!range || typeof range.getBoundingClientRect !== "function") continue;
          const rects = typeof range.getClientRects === "function"
            ? Array.from(range.getClientRects())
            : [];
          const anchorRect = rects.at(-1) ?? range.getBoundingClientRect();
          next[annotation.id] = placeResponseAnnotationMarker(anchorRect, rootRect);
        }
        setPositions(next);
      });
    };
    update();
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(update);
    observer?.observe(sourceRoot);
    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true);
      observer?.disconnect();
    };
  }, [annotations, source, sourceRootRef]);

  return annotations.map((annotation, index) => {
    const position = positions[annotation.id];
    if (!position) return null;
    return (
      <ResponseAnnotationMarker
        key={annotation.id}
        annotationId={annotation.id}
        ordinal={annotation.ordinal ?? index + 1}
        excerpt={annotation.selectedText}
        onActivate={(anchor) => onActivate?.(annotation.id, anchor)}
        className="absolute z-20 -translate-y-0.5"
        style={position}
      />
    );
  });
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
}: {
  annotation: ChatInlineAnnotation | ChatInlineAnnotationInput;
  ordinal: number;
  attachments: ChatAttachment[];
  labels: ResponseAnnotationLabels;
}) {
  return (
    <>
      <p className="text-xs font-medium text-muted-foreground">
        {ordinal}. {labels.selectedText}
      </p>
      <blockquote className="mt-1 whitespace-pre-wrap text-sm leading-5 text-foreground">
        {annotation.selectedText}
      </blockquote>
      {annotation.comment?.trim() ? (
        <>
          <p className="mt-3 text-xs font-medium text-muted-foreground">{labels.userComment}</p>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-5 text-foreground">{annotation.comment}</p>
        </>
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
  const [editorSize, setEditorSize] = useState({ width: 352, height: 320 });
  const inputId = useId();
  const editorRef = useRef<HTMLElement>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
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

  const dismiss = useCallback(() => {
    onCancel();
    restoreFocus();
  }, [onCancel, restoreFocus]);

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
      if (getAnchorRect) setLiveAnchorRect(getAnchorRect());
      if (getBoundaryRect) setLiveBoundaryRect(getBoundaryRect());
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
      if (event.key !== "Escape" || event.defaultPrevented) return;
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
    onSave(changes);
    restoreFocus();
  }

  const editor = (
    <section
      ref={editorRef}
      data-testid="chat-response-annotation-editor"
      data-placement={placement?.placement}
      className={cn(
        "w-[min(22rem,calc(100vw-1rem))] rounded-[var(--radius-xl)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] p-4 shadow-[var(--shadow-lg)]",
        anchored && "fixed z-[90] max-h-[min(36rem,calc(100vh-1rem))] overflow-y-auto overscroll-contain",
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
      aria-label="Edit annotation"
    >
      <AnnotationContent
        annotation={annotation}
        ordinal={ordinal}
        attachments={[]}
        labels={labels}
      />
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
      <label htmlFor={`${inputId}-comment`} className="mt-3 block text-xs font-medium text-muted-foreground">
        {labels.userComment}
      </label>
      <textarea
        id={`${inputId}-comment`}
        ref={commentRef}
        value={comment}
        onChange={(event) => {
          setComment(event.target.value);
          setValidationError(null);
        }}
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
          {labels.addFiles}
        </label>
        <button
          type="button"
          className="ml-auto inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-md)] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 motion-reduce:transition-none"
          aria-label="Delete annotation"
          onClick={() => {
            onDelete();
            restoreFocus();
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
          onToggle={() => setExpanded((current) => {
            const next = !current;
            onExpandedChange?.(next);
            return next;
          })}
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
                {onSelect ? (
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
