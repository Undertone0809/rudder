import { useEffect, useRef, useState, type ImgHTMLAttributes, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { Copy, Download, ExternalLink, Eye, Folder } from "lucide-react";
import { useToast } from "@/context/ToastContext";
import {
  canShowImageInFolder,
  copyImage,
  downloadImage,
  openImage,
  showImageInFolder,
} from "@/lib/image-actions";

const CONTEXT_MENU_WIDTH = 190;
const CONTEXT_MENU_HEIGHT = 178;

type ImageContextMenuPosition = {
  left: number;
  top: number;
};

function clampImageContextMenuPosition(left: number, top: number): ImageContextMenuPosition {
  if (typeof window === "undefined") return { left, top };
  return {
    left: Math.min(left, Math.max(8, window.innerWidth - CONTEXT_MENU_WIDTH)),
    top: Math.min(top, Math.max(8, window.innerHeight - CONTEXT_MENU_HEIGHT)),
  };
}

function actionErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function useMaybeToast() {
  try {
    return useToast();
  } catch {
    return null;
  }
}

export interface InspectableImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "onClick" | "onDoubleClick" | "onContextMenu"> {
  name: string;
  src: string;
  onInspect?: (image: HTMLImageElement) => void;
}

export function InspectableImage({
  alt,
  className,
  name,
  onInspect,
  src,
  ...imgProps
}: InspectableImageProps) {
  const toast = useMaybeToast();
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState<ImageContextMenuPosition | null>(null);
  const canOpenInFinder = canShowImageInFolder();

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

  const inspectImage = () => {
    const image = imageRef.current;
    if (!image || !onInspect) return;
    onInspect(image);
  };

  const openImageContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenuPosition(clampImageContextMenuPosition(event.clientX, event.clientY));
  };

  const runImageAction = async (
    title: string,
    action: () => Promise<void> | void,
    successTitle?: string,
  ) => {
    setContextMenuPosition(null);
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

  return (
    <span className="rudder-inspectable-image">
      <button
        type="button"
        className="rudder-inspectable-image-trigger"
        aria-label={`Open image preview: ${name}`}
        title="Open image preview"
        onClick={inspectImage}
        onDoubleClick={inspectImage}
        onContextMenu={openImageContextMenu}
      >
        <img
          {...imgProps}
          ref={imageRef}
          src={src}
          alt={alt ?? ""}
          className={className}
          onContextMenu={openImageContextMenu}
        />
        <span className="rudder-inspectable-image-overlay" aria-hidden="true">
          <Eye className="size-3.5" />
        </span>
      </button>
      {contextMenuPosition && typeof document !== "undefined" ? createPortal(
        <div
          ref={contextMenuRef}
          data-testid="markdown-image-context-menu"
          role="menu"
          className="motion-chat-composer-menu-pop surface-overlay fixed z-50 min-w-[190px] rounded-[var(--radius-lg)] border p-1.5 text-foreground shadow-[var(--shadow-lg)]"
          style={contextMenuPosition}
        >
          <button
            type="button"
            role="menuitem"
            className="chat-composer-menu-row w-full"
            onClick={() => runImageAction("Open Image failed", () => openImage(src))}
          >
            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Open Image</span>
          </button>
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
          {canOpenInFinder ? (
            <button
              type="button"
              role="menuitem"
              className="chat-composer-menu-row w-full"
              onClick={() => runImageAction("Open in Finder failed", () => showImageInFolder(src, name))}
            >
              <Folder className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">Open in Finder</span>
            </button>
          ) : null}
        </div>,
        document.body,
      ) : null}
    </span>
  );
}
