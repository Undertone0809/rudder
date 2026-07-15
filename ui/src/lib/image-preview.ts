export interface ImageNaturalSize {
  width: number;
  height: number;
}

export interface ImagePreviewElementDetails {
  alt: string;
  naturalSize: ImageNaturalSize | null;
  src: string;
}

const IMAGE_PREVIEW_VIEWPORT_PADDING = 24;
const IMAGE_PREVIEW_MAX_WIDTH = 1440;
const IMAGE_PREVIEW_CONTROL_SAFE_HEIGHT = 48;
const IMAGE_PREVIEW_EDGE_INSET = 8;
const IMAGE_PREVIEW_CONTROL_GAP = 8;
const IMAGE_PREVIEW_ACTION_SIZE = 32;
const IMAGE_PREVIEW_ACTION_GAP = 4;
const IMAGE_PREVIEW_TOOLBAR_HORIZONTAL_PADDING = 8;
const IMAGE_PREVIEW_CLOSE_SIZE = 32;

export function isValidImageNaturalSize(size: ImageNaturalSize | null | undefined): size is ImageNaturalSize {
  return Boolean(size && size.width > 0 && size.height > 0);
}

export function getImagePreviewElementDetails(image: HTMLImageElement): ImagePreviewElementDetails {
  return {
    alt: image.alt,
    naturalSize:
      image.naturalWidth > 0 && image.naturalHeight > 0
        ? { width: image.naturalWidth, height: image.naturalHeight }
        : null,
    src: image.currentSrc || image.src,
  };
}

export function getImagePreviewName(
  alt: string | null | undefined,
  src: string,
  baseUrl = typeof window === "undefined" ? "http://localhost" : window.location.href,
) {
  const normalizedAlt = alt?.trim();
  if (normalizedAlt) return normalizedAlt;
  try {
    const url = new URL(src, baseUrl);
    const filename = url.pathname.split("/").filter(Boolean).at(-1)?.trim();
    if (filename) return decodeURIComponent(filename);
  } catch {
    // Fall through to the generic label for malformed sources.
  }
  return "Image preview";
}

export function getImagePreviewControlSafeWidth(actionCount: number) {
  const normalizedActionCount = Math.max(0, Math.floor(actionCount));
  const toolbarWidth = normalizedActionCount > 0
    ? IMAGE_PREVIEW_TOOLBAR_HORIZONTAL_PADDING
      + normalizedActionCount * IMAGE_PREVIEW_ACTION_SIZE
      + (normalizedActionCount - 1) * IMAGE_PREVIEW_ACTION_GAP
    : 0;
  return IMAGE_PREVIEW_EDGE_INSET
    + toolbarWidth
    + (toolbarWidth > 0 ? IMAGE_PREVIEW_CONTROL_GAP : 0)
    + IMAGE_PREVIEW_CLOSE_SIZE
    + IMAGE_PREVIEW_EDGE_INSET;
}

export function getImagePreviewViewportBounds(viewportWidth: number, viewportHeight: number) {
  return {
    maxWidth: Math.max(0, Math.min(viewportWidth - IMAGE_PREVIEW_VIEWPORT_PADDING, IMAGE_PREVIEW_MAX_WIDTH)),
    maxHeight: Math.max(0, viewportHeight - IMAGE_PREVIEW_VIEWPORT_PADDING),
  };
}

export function getContainedImagePreviewSize(
  naturalSize: ImageNaturalSize,
  viewportWidth: number,
  viewportHeight: number,
): ImageNaturalSize {
  const bounds = getImagePreviewViewportBounds(viewportWidth, viewportHeight);
  if (!isValidImageNaturalSize(naturalSize) || bounds.maxWidth === 0 || bounds.maxHeight === 0) {
    return { width: 0, height: 0 };
  }

  const scale = Math.min(bounds.maxWidth / naturalSize.width, bounds.maxHeight / naturalSize.height, 1);
  return {
    width: Math.max(1, Math.floor(naturalSize.width * scale)),
    height: Math.max(1, Math.floor(naturalSize.height * scale)),
  };
}

export function getImagePreviewMediaSize(
  imageSize: ImageNaturalSize,
  viewportWidth: number,
  viewportHeight: number,
  actionCount = 2,
): ImageNaturalSize {
  const bounds = getImagePreviewViewportBounds(viewportWidth, viewportHeight);
  return {
    width: Math.min(bounds.maxWidth, Math.max(imageSize.width, getImagePreviewControlSafeWidth(actionCount))),
    height: Math.min(bounds.maxHeight, Math.max(imageSize.height, IMAGE_PREVIEW_CONTROL_SAFE_HEIGHT)),
  };
}
