import { useImagePreview } from "@/context/ImagePreviewContext";
import { getImagePreviewElementDetails } from "@/lib/image-preview";
import { Eye, ImageOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ImgHTMLAttributes, type MouseEvent, type KeyboardEvent as ReactKeyboardEvent, type SyntheticEvent } from "react";
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

type ImageLoadState = "loading" | "loaded" | "error";

const DEFAULT_IMAGE_ASPECT_RATIO = 16 / 9;

function positiveDimension(value: number | string | undefined) {
  const dimension = typeof value === "number" ? value : Number(value);
  return Number.isFinite(dimension) && dimension > 0 ? dimension : null;
}

function declaredImageAspectRatio(
  width: ImgHTMLAttributes<HTMLImageElement>["width"],
  height: ImgHTMLAttributes<HTMLImageElement>["height"],
) {
  const numericWidth = positiveDimension(width);
  const numericHeight = positiveDimension(height);
  return numericWidth && numericHeight ? numericWidth / numericHeight : null;
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
  onLoad: onImageLoad,
  onError: onImageError,
  ...imgProps
}: InspectableImageProps) {
  const { openImagePreview } = useImagePreview();
  const imageRef = useRef<HTMLImageElement>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState<ImageContextMenuPosition | null>(null);
  const [imageLoadState, setImageLoadState] = useState<ImageLoadState>("loading");
  const [loadedAspectRatio, setLoadedAspectRatio] = useState<number | null>(null);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const closeImageContextMenu = useCallback(() => setContextMenuPosition(null), []);
  const declaredAspectRatio = declaredImageAspectRatio(imgProps.width, imgProps.height);
  const imageLoadError = imageLoadState === "error";
  const imageAspectRatio = loadedAspectRatio ?? declaredAspectRatio ?? DEFAULT_IMAGE_ASPECT_RATIO;
  const imageFrameStyle = {
    "--rudder-image-aspect-ratio": String(imageAspectRatio),
  } as CSSProperties;

  useEffect(() => {
    setImageLoadState("loading");
    setLoadedAspectRatio(null);
    setRetryAttempt(0);
    setContextMenuPosition(null);
  }, [declaredAspectRatio, src]);

  useEffect(() => {
    const image = imageRef.current;
    if (!image?.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
    setLoadedAspectRatio(image.naturalWidth / image.naturalHeight);
    setImageLoadState("loaded");
  }, [retryAttempt, src]);

  const handleImageLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
      setLoadedAspectRatio(image.naturalWidth / image.naturalHeight);
    }
    setImageLoadState("loaded");
    onImageLoad?.(event);
  };

  const retryImageLoad = () => {
    setImageLoadState("loading");
    setLoadedAspectRatio(declaredAspectRatio);
    setContextMenuPosition(null);
    setRetryAttempt((attempt) => attempt + 1);
  };

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
    if (imageLoadError) {
      retryImageLoad();
      return;
    }
    inspectImage();
  };

  const openImagePreviewFromKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    if (imageLoadError) {
      retryImageLoad();
      return;
    }
    inspectImage();
  };

  const openImageContextMenu = (event: MouseEvent) => {
    if (imageLoadError) return;
    event.preventDefault();
    event.stopPropagation();
    setContextMenuPosition(clampImageContextMenuPosition(event.clientX, event.clientY));
  };

  const handleImageError = (event: SyntheticEvent<HTMLImageElement>) => {
    setImageLoadState("error");
    setContextMenuPosition(null);
    onImageError?.(event);
  };

  return (
    <span
      className={`rudder-inspectable-image${wrapperClassName ? ` ${wrapperClassName}` : ""}`}
      data-image-state={imageLoadState}
    >
      <button
        type="button"
        className={`rudder-inspectable-image-trigger${triggerClassName ? ` ${triggerClassName}` : ""}`}
        aria-busy={imageLoadState === "loading" ? "true" : undefined}
        aria-label={imageLoadError ? `Retry loading image: ${name}` : `Open image preview: ${name}`}
        data-image-state={imageLoadState}
        title={imageLoadError ? `Retry loading image: ${name}` : "Open image preview"}
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
            <span className="rudder-inspectable-image-fallback-label">Image unavailable. Click to retry.</span>
          </span>
        ) : (
          <span
            className="rudder-inspectable-image-frame"
            data-image-state={imageLoadState}
            style={imageFrameStyle}
          >
            {imageLoadState === "loading" ? (
              <span
                aria-label={`Loading image: ${name}`}
                className="rudder-inspectable-image-skeleton"
                data-testid="inspectable-image-skeleton"
                role="status"
              />
            ) : null}
            <img
              key={`${src}:${retryAttempt}`}
              {...imgProps}
              ref={imageRef}
              src={src}
              alt={alt ?? ""}
              className={className}
              onError={handleImageError}
              onLoad={handleImageLoad}
              onContextMenu={openImageContextMenu}
            />
          </span>
        )}
        {showInspectOverlay && imageLoadState === "loaded" ? (
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
