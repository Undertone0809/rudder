import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  getContainedImagePreviewSize,
  getImagePreviewViewportBounds,
  isValidImageNaturalSize,
  type ImageNaturalSize,
} from "@/lib/image-preview";

export interface ImagePreviewState {
  alt: string;
  name: string;
  src: string;
  naturalSize?: ImageNaturalSize | null;
}

function getViewportSize() {
  if (typeof window === "undefined") {
    return { width: 1440, height: 900 };
  }
  return { width: window.innerWidth, height: window.innerHeight };
}

export function ImagePreviewDialog({
  preview,
  onOpenChange,
  testId,
  titleFallback,
}: {
  preview: ImagePreviewState | null;
  onOpenChange: (open: boolean) => void;
  testId: string;
  titleFallback: string;
}) {
  const [naturalSize, setNaturalSize] = useState<ImageNaturalSize | null>(preview?.naturalSize ?? null);
  const [viewportSize, setViewportSize] = useState(() => getViewportSize());

  useEffect(() => {
    if (!preview) {
      setNaturalSize(null);
      return;
    }

    setNaturalSize(isValidImageNaturalSize(preview.naturalSize) ? preview.naturalSize : null);

    if (!preview.src || isValidImageNaturalSize(preview.naturalSize)) {
      return;
    }

    const image = new window.Image();
    image.onload = () => {
      setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      setNaturalSize(null);
    };
    image.src = preview.src;
    return () => {
      image.onload = null;
      image.onerror = null;
    };
  }, [preview]);

  useEffect(() => {
    if (!preview || typeof window === "undefined") return;
    const syncViewportSize = () => {
      setViewportSize(getViewportSize());
    };
    syncViewportSize();
    window.addEventListener("resize", syncViewportSize);
    return () => {
      window.removeEventListener("resize", syncViewportSize);
    };
  }, [preview]);

  const containedSize = useMemo(
    () => (naturalSize ? getContainedImagePreviewSize(naturalSize, viewportSize.width, viewportSize.height) : null),
    [naturalSize, viewportSize.height, viewportSize.width],
  );
  const viewportBounds = useMemo(
    () => getImagePreviewViewportBounds(viewportSize.width, viewportSize.height),
    [viewportSize.height, viewportSize.width],
  );

  return (
    <Dialog open={preview !== null} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="rudder-markdown-editor-image-preview-panel top-[50%] w-fit translate-y-[-50%] border-0 bg-transparent p-0 shadow-none"
        style={{
          maxWidth: `${viewportBounds.maxWidth}px`,
          width: containedSize ? `${containedSize.width}px` : undefined,
        }}
      >
        <DialogTitle className="sr-only">{preview?.name ?? titleFallback}</DialogTitle>
        {preview ? (
          <div
            data-testid={testId}
            className="rudder-markdown-editor-image-preview-media relative flex w-fit max-w-full items-center justify-center overflow-hidden"
            style={
              containedSize
                ? { width: `${containedSize.width}px`, height: `${containedSize.height}px` }
                : { maxWidth: `${viewportBounds.maxWidth}px`, maxHeight: `${viewportBounds.maxHeight}px` }
            }
          >
            <DialogClose className="absolute right-2 top-2 z-10 flex size-8 items-center justify-center rounded-sm bg-black/55 text-white shadow-[0_6px_18px_rgb(0_0_0/0.28)] transition-colors hover:bg-black/70 focus:outline-none focus:ring-2 focus:ring-white/80">
              <X className="size-4" aria-hidden="true" />
              <span className="sr-only">Close image preview</span>
            </DialogClose>
            <img
              src={preview.src}
              alt={preview.alt}
              className="chat-attachment-preview-image"
              style={containedSize ? { width: "100%", height: "100%" } : undefined}
            />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
