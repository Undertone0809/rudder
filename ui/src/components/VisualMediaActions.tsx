import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useImagePreview } from "@/context/ImagePreviewContext";
import { useOptionalToast } from "@/context/ToastContext";
import { copyImageBlob } from "@/lib/image-actions";
import {
  blobToDataUrl,
  renderedVisualPngName,
  type RenderedVisualCapture,
} from "@/lib/rendered-visual-image";
import { cn } from "@/lib/utils";
import { Copy, Loader2, Maximize2 } from "lucide-react";
import { useCallback, useState, type MouseEvent } from "react";

type VisualMediaAction = "copy" | "preview";

function actionErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function VisualMediaActions({
  className,
  onCopy,
  onPreview,
  testId = "visual-media-actions",
}: {
  className?: string;
  onCopy: () => Promise<void> | void;
  onPreview: () => Promise<void> | void;
  testId?: string;
}) {
  const toast = useOptionalToast();
  const [pendingAction, setPendingAction] = useState<VisualMediaAction | null>(null);

  const runAction = useCallback(async (
    event: MouseEvent<HTMLButtonElement>,
    action: VisualMediaAction,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (pendingAction) return;
    setPendingAction(action);
    try {
      if (action === "preview") {
        await onPreview();
      } else {
        await onCopy();
        toast?.pushToast({ title: "Image copied", tone: "success" });
      }
    } catch (error) {
      toast?.pushToast({
        title: action === "preview" ? "Open image preview failed" : "Copy Image failed",
        body: actionErrorMessage(error),
        tone: "error",
      });
    } finally {
      setPendingAction(null);
    }
  }, [onCopy, onPreview, pendingAction, toast]);

  return (
    <TooltipProvider>
      <span
        className={cn("rudder-visual-media-actions", className)}
        data-testid={testId}
        {...{ "data-annotation-ignore": "" }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="rudder-visual-media-action"
              aria-label="Open image preview"
              disabled={pendingAction !== null}
              onClick={(event) => void runAction(event, "preview")}
            >
              {pendingAction === "preview" ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Maximize2 className="size-4" aria-hidden="true" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={8}>Open image preview</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="rudder-visual-media-action"
              aria-label="Copy Image"
              disabled={pendingAction !== null}
              onClick={(event) => void runAction(event, "copy")}
            >
              {pendingAction === "copy" ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Copy className="size-4" aria-hidden="true" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={8}>Copy Image</TooltipContent>
        </Tooltip>
      </span>
    </TooltipProvider>
  );
}

export function CapturedVisualMediaActions({
  capture,
  name,
  previewTestId,
  testId,
}: {
  capture: () => Promise<RenderedVisualCapture>;
  name: string;
  previewTestId: string;
  testId?: string;
}) {
  const { openImagePreview } = useImagePreview();
  const filename = renderedVisualPngName(name, "visualization");

  const preview = useCallback(async () => {
    const captured = await capture();
    openImagePreview({
      alt: name,
      name: filename,
      src: await blobToDataUrl(captured.blob),
      naturalSize: { width: captured.width, height: captured.height },
      testId: previewTestId,
      titleFallback: "Visual preview",
    });
  }, [capture, filename, name, openImagePreview, previewTestId]);

  const copy = useCallback(async () => {
    const captured = await capture();
    await copyImageBlob(captured.blob, filename);
  }, [capture, filename]);

  return (
    <VisualMediaActions
      onPreview={preview}
      onCopy={copy}
      testId={testId}
    />
  );
}
