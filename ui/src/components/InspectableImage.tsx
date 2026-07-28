import { useImagePreview } from "@/context/ImagePreviewContext";
import { getImagePreviewElementDetails } from "@/lib/image-preview";
import { Eye } from "lucide-react";
import { useCallback, useRef, useState, type ImgHTMLAttributes, type MouseEvent } from "react";
import {
  clampImageContextMenuPosition,
  ImageContextMenu,
  type ImageContextMenuPosition,
} from "./ImageContextMenu";

export interface InspectableImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "onClick" | "onDoubleClick" | "onContextMenu"> {
  name: string;
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
  name,
  previewTestId,
  previewTitleFallback,
  showInspectOverlay = true,
  src,
  triggerClassName,
  wrapperClassName,
  ...imgProps
}: InspectableImageProps) {
  const { openImagePreview } = useImagePreview();
  const imageRef = useRef<HTMLImageElement>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState<ImageContextMenuPosition | null>(null);
  const closeImageContextMenu = useCallback(() => setContextMenuPosition(null), []);

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
    inspectImage();
  };

  const openImageContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenuPosition(clampImageContextMenuPosition(event.clientX, event.clientY));
  };

  return (
    <span className={`rudder-inspectable-image${wrapperClassName ? ` ${wrapperClassName}` : ""}`}>
      <button
        type="button"
        className={`rudder-inspectable-image-trigger${triggerClassName ? ` ${triggerClassName}` : ""}`}
        aria-label={`Open image preview: ${name}`}
        title="Open image preview"
        onClick={openImagePreviewFromTrigger}
        onDoubleClick={openImagePreviewFromTrigger}
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
        {showInspectOverlay ? (
          <span className="rudder-inspectable-image-overlay" aria-hidden="true">
            <Eye className="size-3.5" />
          </span>
        ) : null}
      </button>
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
