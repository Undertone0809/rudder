import { ImagePreviewDialog } from "@/components/ImagePreviewDialog";
import { useToast } from "@/context/ToastContext";
import {
  canShowImageInFolder,
  copyImage as copyImageAction,
  isImageContentType,
  showImageInFolder as showImageInFolderAction,
} from "@/lib/image-actions";
import { resolveLocalFileTarget } from "@/lib/local-file-targets";
import {
  type ChatMessage
} from "@rudderhq/shared";
import {
  Copy,
  Folder,
  Paperclip,
  X
} from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { AttachmentPreviewState, ChatImageContextMenuPosition, attachmentDisplayName, clampChatImageContextMenuPosition } from "./Chat.parts";

export function ChatImageAttachmentTile({
  src,
  name,
  onOpen,
  onRemove,
  testId,
}: {
  src: string;
  name: string;
  onOpen: () => void;
  onRemove?: () => void;
  testId?: string;
}) {
  const { pushToast } = useToast();
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState<ChatImageContextMenuPosition | null>(null);
  const canShowInFolder = canShowImageInFolder();

  useEffect(() => {
    if (!contextMenuPosition) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (contextMenuRef.current?.contains(event.target as Node)) return;
      setContextMenuPosition(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenuPosition(null);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenuPosition]);

  const openImageContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenuPosition(clampChatImageContextMenuPosition(event.clientX, event.clientY));
  };

  const copyImage = async () => {
    setContextMenuPosition(null);
    try {
      await copyImageAction(src, name);
      pushToast({ title: "Image copied", tone: "success" });
    } catch (error) {
      pushToast({
        title: "Copy Image failed",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    }
  };

  const showImageInFolder = async () => {
    setContextMenuPosition(null);
    if (!canShowInFolder) {
      pushToast({
        title: "Show in folder unavailable",
        body: "Show in folder is available in the desktop app.",
        tone: "error",
      });
      return;
    }

    try {
      await showImageInFolderAction(src, name);
    } catch (error) {
      pushToast({
        title: "Show in folder failed",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    }
  };

  return (
    <div
      data-testid={testId}
      className="relative inline-flex max-w-full"
    >
      <button
        type="button"
        aria-label={`Open image preview: ${name}`}
        className="flex h-12 w-12 min-w-0 items-center justify-center overflow-hidden rounded-[calc(var(--radius-sm)+4px)] border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-active)_42%,transparent)] text-left transition-[border-color,box-shadow] hover:border-[color:var(--border-strong)] focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        onClick={onOpen}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpen();
        }}
        onContextMenu={openImageContextMenu}
      >
        <img
          src={src}
          alt={name}
          className="h-full w-full shrink-0 object-cover"
          onContextMenu={openImageContextMenu}
        />
      </button>
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
      {contextMenuPosition && typeof document !== "undefined" ? createPortal(
        <div
          ref={contextMenuRef}
          data-testid="chat-image-context-menu"
          role="menu"
          className="motion-chat-composer-menu-pop surface-overlay fixed z-50 min-w-[172px] rounded-[var(--radius-lg)] border p-1.5 text-foreground shadow-[var(--shadow-lg)]"
          style={contextMenuPosition}
        >
          <button
            type="button"
            role="menuitem"
            className="chat-composer-menu-row w-full disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canShowInFolder}
            onClick={showImageInFolder}
          >
            <Folder className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Show in folder</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="chat-composer-menu-row w-full"
            onClick={copyImage}
          >
            <Copy className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Copy Image</span>
          </button>
        </div>,
        document.body,
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
  onOpenImage,
  onRemove,
}: {
  file: File;
  onOpenImage: (preview: AttachmentPreviewState) => void;
  onRemove: () => void;
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
        onOpen={() => onOpenImage({ src: previewSrc, name })}
        onRemove={onRemove}
        testId="chat-pending-image-attachment"
      />
    );
  }

  return <ChatFileAttachmentChip name={name} onRemove={onRemove} />;
}

export function ChatAttachmentList({
  attachments,
  onOpenImage,
  onOpenFile,
}: {
  attachments: ChatMessage["attachments"];
  onOpenImage: (preview: AttachmentPreviewState) => void;
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
              onOpen={() => onOpenImage({ src: attachment.contentPath, name })}
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

export function ChatAttachmentPreviewDialog({
  preview,
  onOpenChange,
}: {
  preview: AttachmentPreviewState | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <ImagePreviewDialog
      preview={preview ? { src: preview.src, name: preview.name, alt: preview.name } : null}
      onOpenChange={onOpenChange}
      testId="chat-image-preview-dialog"
      titleFallback="Attachment preview"
    />
  );
}
