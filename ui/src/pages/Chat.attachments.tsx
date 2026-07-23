import { InspectableImage } from "@/components/InspectableImage";
import {
  isImageContentType,
} from "@/lib/image-actions";
import { resolveLocalFileTarget } from "@/lib/local-file-targets";
import {
  type ChatMessage
} from "@rudderhq/shared";
import {
  Paperclip,
  X
} from "lucide-react";
import { useEffect, useState } from "react";
import { attachmentDisplayName } from "./Chat.parts";

export function ChatImageAttachmentTile({
  src,
  name,
  onRemove,
  testId,
}: {
  src: string;
  name: string;
  onRemove?: () => void;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="relative inline-flex max-w-full"
    >
      <InspectableImage
        src={src}
        alt={name}
        name={name}
        className="h-full w-full shrink-0 object-cover"
        triggerClassName="chat-image-attachment-trigger"
        previewTestId="chat-image-preview-dialog"
        previewTitleFallback="Attachment preview"
        showInspectOverlay={false}
      />
      {onRemove ? (
        <button
          type="button"
          className="absolute -right-1.5 -top-1.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] text-muted-foreground shadow-[var(--shadow-sm)] transition-colors hover:text-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

export function ChatFileAttachmentChip({
  name,
  href,
  onRemove,
  onOpenFile,
}: {
  name: string;
  href?: string;
  onRemove?: () => void;
  onOpenFile?: (targetPath: string) => void;
}) {
  const content = (
    <>
      <Paperclip className="h-3 w-3 shrink-0" />
      <span className="truncate">{name}</span>
    </>
  );

  if (href) {
    const localTargetPath = resolveLocalFileTarget(href);
    if (localTargetPath && onOpenFile) {
      return (
        <button
          type="button"
          className="chat-chip inline-flex max-w-full items-center gap-2 rounded-[calc(var(--radius-sm)+2px)] px-3 py-1.5 text-xs transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground"
          onClick={() => onOpenFile(localTargetPath)}
        >
          {content}
        </button>
      );
    }

    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="chat-chip inline-flex max-w-full items-center gap-2 rounded-[calc(var(--radius-sm)+2px)] px-3 py-1.5 text-xs transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground"
      >
        {content}
      </a>
    );
  }

  return (
    <span className="chat-chip inline-flex max-w-full items-center gap-2 rounded-[calc(var(--radius-sm)+2px)] px-3 py-1.5 text-xs">
      {content}
      {onRemove ? (
        <button
          type="button"
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </span>
  );
}

export function PendingAttachmentPreview({
  file,
  onRemove,
}: {
  file: File;
  onRemove?: () => void;
}) {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const isImage = isImageContentType(file.type);
  const name = attachmentDisplayName(file);

  useEffect(() => {
    if (!isImage) {
      setPreviewSrc(null);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setPreviewSrc(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file, isImage]);

  if (isImage && previewSrc) {
    return (
      <ChatImageAttachmentTile
        src={previewSrc}
        name={name}
        onRemove={onRemove}
        testId="chat-pending-image-attachment"
      />
    );
  }

  return <ChatFileAttachmentChip name={name} onRemove={onRemove} />;
}

export function ChatAttachmentList({
  attachments,
  onOpenFile,
}: {
  attachments: ChatMessage["attachments"];
  onOpenFile: (targetPath: string) => void;
}) {
  if (attachments.length === 0) return null;

  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {attachments.map((attachment) => {
        const name = attachmentDisplayName(attachment);
        if (isImageContentType(attachment.contentType)) {
          return (
            <ChatImageAttachmentTile
              key={attachment.id}
              src={attachment.contentPath}
              name={name}
              testId="chat-image-attachment"
            />
          );
        }
        return (
          <ChatFileAttachmentChip
            key={attachment.id}
            name={name}
            href={attachment.contentPath}
            onOpenFile={onOpenFile}
          />
        );
      })}
    </div>
  );
}
