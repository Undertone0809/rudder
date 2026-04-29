export interface ImageNaturalSize {
  width: number;
  height: number;
}

const IMAGE_PREVIEW_VIEWPORT_PADDING = 24;
const IMAGE_PREVIEW_MAX_WIDTH = 1440;

export function isValidImageNaturalSize(size: ImageNaturalSize | null | undefined): size is ImageNaturalSize {
  return Boolean(size && size.width > 0 && size.height > 0);
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
