import { isImageContentType } from "@/lib/image-actions";
import { cn } from "@/lib/utils";
import type {
  ChatAttachment,
  ChatInlineAnnotation,
  ChatInlineAnnotationInput,
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
  useId,
  useState,
  type ChangeEvent,
} from "react";
import {
  ChatFileAttachmentChip,
  ChatImageAttachmentTile,
  PendingAttachmentPreview,
} from "../../pages/Chat.attachments";

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
};

function countLabel(count: number, labels: ResponseAnnotationLabels) {
  return `${count} ${count === 1 ? labels.annotation : labels.annotations}`;
}

export function ResponseAnnotationCountChip({
  count,
  expanded,
  onToggle,
  onClear,
  labels = DEFAULT_LABELS,
  className,
}: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
  onClear?: () => void;
  labels?: ResponseAnnotationLabels;
  className?: string;
}) {
  return (
    <div
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
  ordinal,
  excerpt,
  onActivate,
  className,
}: {
  ordinal: number;
  excerpt: string;
  onActivate: () => void;
  className?: string;
}) {
  const boundedExcerpt = excerpt.replace(/\s+/gu, " ").trim().slice(0, 80);
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11",
        className,
      )}
      aria-label={`Annotation ${ordinal}: ${boundedExcerpt}`}
      onClick={onActivate}
    >
      <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-1 shadow-[var(--shadow-sm)]">
        {ordinal}
      </span>
    </button>
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
  pendingFiles,
  attachments = [],
  onSave,
  onCancel,
  onDelete,
  onAddFiles,
  onRemovePendingFile,
  labels = DEFAULT_LABELS,
  className,
}: {
  annotation: ChatInlineAnnotation | ChatInlineAnnotationInput;
  pendingFiles: File[];
  attachments?: ChatAttachment[];
  onSave: (changes: Pick<ChatInlineAnnotationInput, "comment">) => void;
  onCancel: () => void;
  onDelete: () => void;
  onAddFiles: (files: File[]) => void;
  onRemovePendingFile: (fileIndex: number) => void;
  labels?: ResponseAnnotationLabels;
  className?: string;
}) {
  const [comment, setComment] = useState(annotation.comment ?? "");
  const inputId = useId();

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (files.length > 0) onAddFiles(files);
    event.target.value = "";
  }

  return (
    <section
      className={cn(
        "w-[min(22rem,calc(100vw-1rem))] rounded-[var(--radius-xl)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] p-4 shadow-[var(--shadow-lg)]",
        className,
      )}
      aria-label="Edit annotation"
    >
      <AnnotationContent annotation={annotation} ordinal={1} attachments={attachments} labels={labels} />
      <label htmlFor={`${inputId}-comment`} className="mt-3 block text-xs font-medium text-muted-foreground">
        {labels.userComment}
      </label>
      <textarea
        id={`${inputId}-comment`}
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        placeholder={labels.optionalComment}
        maxLength={2_000}
        className="mt-1 min-h-20 w-full resize-y rounded-[var(--radius-md)] border border-[color:var(--border-soft)] bg-transparent px-3 py-2 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
      />
      {pendingFiles.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {pendingFiles.map((file, index) => (
            <div key={`${file.name}-${file.size}-${file.lastModified}-${index}`} className="max-w-full">
              <span className="sr-only">{file.name}</span>
              <PendingAttachmentPreview
                file={file}
                onRemove={() => onRemovePendingFile(index)}
              />
            </div>
          ))}
        </div>
      ) : null}
      <div className="mt-4 flex items-center gap-2">
        <input
          id={`${inputId}-files`}
          type="file"
          multiple
          className="sr-only"
          onChange={handleFiles}
        />
        <label
          htmlFor={`${inputId}-files`}
          className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground focus-within:ring-2 focus-within:ring-ring/40 [@media(pointer:coarse)]:h-11 motion-reduce:transition-none"
        >
          <Paperclip className="h-3.5 w-3.5" />
          {labels.addFiles}
        </label>
        <button
          type="button"
          className="ml-auto inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-md)] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 motion-reduce:transition-none"
          aria-label="Delete annotation"
          onClick={onDelete}
        >
          <Trash2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="inline-flex h-9 items-center rounded-[var(--radius-md)] px-3 text-sm font-medium text-foreground transition-colors hover:bg-[color:var(--surface-active)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 [@media(pointer:coarse)]:h-11 motion-reduce:transition-none"
          onClick={onCancel}
        >
          {labels.cancel}
        </button>
        <button
          type="button"
          className="inline-flex h-9 items-center rounded-[var(--radius-md)] bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 [@media(pointer:coarse)]:h-11 motion-reduce:transition-none"
          onClick={() => onSave({ comment: comment.trim() || null })}
        >
          {labels.save}
        </button>
      </div>
    </section>
  );
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
  onEdit: (annotation: ChatInlineAnnotationInput) => void;
  onDelete: (annotationId: string) => void;
  labels?: ResponseAnnotationLabels;
}) {
  return (
    <ol className="w-[min(28rem,calc(100vw-1rem))] divide-y divide-[color:var(--border-soft)] rounded-[var(--radius-xl)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] shadow-[var(--shadow-lg)]">
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
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-[color:var(--surface-active)] hover:text-foreground [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
                aria-label={`Edit annotation ${index + 1}`}
                onClick={() => onEdit(annotation)}
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
  labels = DEFAULT_LABELS,
  className,
}: {
  annotations: ChatInlineAnnotation[];
  attachments: ChatAttachment[];
  onSelect?: (annotation: ChatInlineAnnotation) => void;
  labels?: ResponseAnnotationLabels;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (annotations.length === 0) return null;

  return (
    <div className={cn("flex flex-col items-start gap-2", className)}>
      <ResponseAnnotationCountChip
        count={annotations.length}
        expanded={expanded}
        onToggle={() => setExpanded((current) => !current)}
        labels={labels}
      />
      {expanded ? (
        <ol className="w-[min(28rem,calc(100vw-1rem))] divide-y divide-[color:var(--border-soft)] overflow-hidden rounded-[var(--radius-xl)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] shadow-[var(--shadow-md)]">
          {annotations.map((annotation, index) => {
            const ownedAttachments = attachments.filter((attachment) => annotation.attachmentIds.includes(attachment.id));
            return (
              <li key={annotation.id} className="p-4">
                <button
                  type="button"
                  data-annotation-id={annotation.id}
                  className="block w-full rounded-[var(--radius-md)] text-left transition-colors hover:bg-[color:var(--surface-active)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 motion-reduce:transition-none"
                  onClick={() => onSelect?.(annotation)}
                >
                  <AnnotationContent
                    annotation={annotation}
                    ordinal={index + 1}
                    attachments={[]}
                    labels={labels}
                  />
                </button>
                {ownedAttachments.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {ownedAttachments.map((attachment) => (
                      <AnnotationAttachment key={attachment.id} attachment={attachment} />
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}
