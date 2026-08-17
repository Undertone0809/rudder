import { useImagePreview } from "@/context/ImagePreviewContext";
import { copyImage } from "@/lib/image-actions";
import { getImagePreviewElementDetails } from "@/lib/image-preview";
import { Eye, ImageOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ImgHTMLAttributes, type MouseEvent, type KeyboardEvent as ReactKeyboardEvent, type SyntheticEvent } from "react";
import {
  clampImageContextMenuPosition,
  ImageContextMenu,
  type ImageContextMenuPosition,
} from "./ImageContextMenu";
import { VisualMediaActions } from "./VisualMediaActions";

export interface InspectableImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "onClick" | "onDoubleClick" | "onContextMenu"> {
  name: string;
  mediaActions?: "inspect" | "preview-copy";
  previewTestId?: string;
  previewTitleFallback?: string;
  showInspectOverlay?: boolean;
  src: string;
  triggerClassName?: string;
  wrapperClassName?: string;
}

export function InspectableImage({
  alt,
  className,
  mediaActions = "inspect",
  name,
  previewTestId,
  previewTitleFallback,
  showInspectOverlay = true,
  src,
  triggerClassName,
  wrapperClassName,
  onError: onImageError,
  ...imgProps
}: InspectableImageProps) {
  const { openImagePreview } = useImagePreview();
  const imageRef = useRef<HTMLImageElement>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState<ImageContextMenuPosition | null>(null);
  const [imageLoadError, setImageLoadError] = useState(false);
  const closeImageContextMenu = useCallback(() => setContextMenuPosition(null), []);

  useEffect(() => {
    setImageLoadError(false);
    setContextMenuPosition(null);
  }, [src]);

  const inspectImage = () => {
    const image = imageRef.current;
    if (!image) return;
    openImagePreview({
      ...getImagePreviewElementDetails(image),
      name,
      testId: previewTestId,
      titleFallback: previewTitleFallback,
    });
  };

  const openImagePreviewFromTrigger = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (imageLoadError) return;
    inspectImage();
  };

  const openImagePreviewFromKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    if (imageLoadError) return;
    inspectImage();
  };

  const openImageContextMenu = (event: MouseEvent) => {
    if (imageLoadError) return;
    event.preventDefault();
    event.stopPropagation();
    setContextMenuPosition(clampImageContextMenuPosition(event.clientX, event.clientY));
  };

  const handleImageError = (event: SyntheticEvent<HTMLImageElement>) => {
    setImageLoadError(true);
    onImageError?.(event);
  };

  return (
    <span className={`rudder-inspectable-image${wrapperClassName ? ` ${wrapperClassName}` : ""}`}>
      <button
        type="button"
        className={`rudder-inspectable-image-trigger${triggerClassName ? ` ${triggerClassName}` : ""}`}
        aria-label={imageLoadError ? `${name} unavailable` : `Open image preview: ${name}`}
        aria-disabled={imageLoadError}
        title={imageLoadError ? "Image unavailable" : "Open image preview"}
        onClick={openImagePreviewFromTrigger}
        onDoubleClick={openImagePreviewFromTrigger}
        onKeyDown={openImagePreviewFromKeyboard}
        onContextMenu={openImageContextMenu}
      >
        {imageLoadError ? (
          <span
            className="rudder-inspectable-image-fallback"
            role="img"
            aria-label={`${name} unavailable`}
          >
            <ImageOff className="size-4 shrink-0" aria-hidden="true" />
            <span className="rudder-inspectable-image-fallback-label">Image unavailable</span>
          </span>
        ) : (
          <img
            {...imgProps}
            ref={imageRef}
            src={src}
            alt={alt ?? ""}
            className={className}
            onError={handleImageError}
            onContextMenu={openImageContextMenu}
          />
        )}
        {showInspectOverlay && mediaActions === "inspect" && !imageLoadError ? (
          <span className="rudder-inspectable-image-overlay" aria-hidden="true">
            <Eye className="size-3.5" />
          </span>
        ) : null}
      </button>
      {mediaActions === "preview-copy" && !imageLoadError ? (
        <VisualMediaActions
          onPreview={inspectImage}
          onCopy={() => copyImage(src, name)}
          testId="markdown-image-actions"
        />
      ) : null}
      {contextMenuPosition ? (
        <ImageContextMenu
          name={name}
          onClose={closeImageContextMenu}
          onOpen={inspectImage}
          position={contextMenuPosition}
          src={src}
        />
      ) : null}
    </span>
  );
}
