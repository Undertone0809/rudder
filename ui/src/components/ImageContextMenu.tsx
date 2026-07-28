import { useOptionalToast } from "@/context/ToastContext";
import {
  canShowImageInFolder,
  copyImage,
  downloadImage,
  showImageInFolder,
} from "@/lib/image-actions";
import { getImagePreviewElementDetails, getImagePreviewName } from "@/lib/image-preview";
import { Copy, Download, ExternalLink, Folder } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

const CONTEXT_MENU_WIDTH = 190;
const CONTEXT_MENU_HEIGHT = 178;

export type ImageContextMenuPosition = {
  left: number;
  top: number;
};

export type ImageContextMenuTarget = ReturnType<typeof getImagePreviewElementDetails> & {
  name: string;
  position: ImageContextMenuPosition;
};

export function clampImageContextMenuPosition(left: number, top: number): ImageContextMenuPosition {
  if (typeof window === "undefined") return { left, top };
  return {
    left: Math.min(left, Math.max(8, window.innerWidth - CONTEXT_MENU_WIDTH)),
    top: Math.min(top, Math.max(8, window.innerHeight - CONTEXT_MENU_HEIGHT)),
  };
}

export function getImageContextMenuTarget(
  image: HTMLImageElement,
  clientX: number,
  clientY: number,
): ImageContextMenuTarget {
  const details = getImagePreviewElementDetails(image);
  return {
    ...details,
    name: getImagePreviewName(image.getAttribute("alt"), details.src),
    position: clampImageContextMenuPosition(clientX, clientY),
  };
}

function actionErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function ImageContextMenu({
  name,
  onClose,
  onOpen,
  position,
  src,
  testId = "markdown-image-context-menu",
}: {
  name: string;
  onClose: () => void;
  onOpen?: () => void;
  position: ImageContextMenuPosition;
  src: string;
  testId?: string;
}) {
  const toast = useOptionalToast();
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const canShowInFolder = canShowImageInFolder();

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (contextMenuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const runImageAction = async (
    title: string,
    action: () => Promise<void> | void,
    successTitle?: string,
  ) => {
    onClose();
    try {
      await action();
      if (successTitle) {
        toast?.pushToast({ title: successTitle, tone: "success" });
      }
    } catch (error) {
      toast?.pushToast({
        title,
        body: actionErrorMessage(error),
        tone: "error",
      });
    }
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={contextMenuRef}
      data-testid={testId}
      role="menu"
      className="motion-chat-composer-menu-pop surface-overlay fixed z-50 min-w-[190px] rounded-[var(--radius-lg)] border p-1.5 text-foreground shadow-[var(--shadow-lg)]"
      style={position}
    >
      {onOpen ? (
        <button
          type="button"
          role="menuitem"
          className="chat-composer-menu-row w-full"
          onClick={() => {
            onClose();
            onOpen();
          }}
        >
          <ExternalLink className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Open Image</span>
        </button>
      ) : null}
      <button
        type="button"
        role="menuitem"
        className="chat-composer-menu-row w-full"
        onClick={() => runImageAction("Copy Image failed", () => copyImage(src, name), "Image copied")}
      >
        <Copy className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">Copy Image</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="chat-composer-menu-row w-full"
        onClick={() => runImageAction("Download Image failed", () => downloadImage(src, name))}
      >
        <Download className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">Download Image</span>
      </button>
      {canShowInFolder ? (
        <button
          type="button"
          role="menuitem"
          className="chat-composer-menu-row w-full"
          onClick={() => runImageAction("Show in folder failed", () => showImageInFolder(src, name))}
        >
          <Folder className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Show in folder</span>
        </button>
      ) : null}
    </div>,
    document.body,
  );
}
