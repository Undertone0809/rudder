import { ImageOff, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { readDesktopShell, type DesktopLocalFilePreview } from "../../lib/desktop-shell";
import { InspectableImage } from "../InspectableImage";

function imagePreviewDataUrl(preview: DesktopLocalFilePreview): string | null {
  if (
    preview.previewKind !== "image"
    || !preview.contentType.toLowerCase().startsWith("image/")
    || !preview.base64
  ) {
    return null;
  }
  return `data:${preview.contentType};base64,${preview.base64}`;
}

function isRudderAssetPath(path: string) {
  return /^\/api\/assets\/[^/]+\/content(?:[?#].*)?$/u.test(path);
}

function imagePreviewFailureMessage(cause: unknown, displayLabel: string) {
  const message = cause instanceof Error ? cause.message : "";
  if (/\bENOENT\b|no such file or directory/iu.test(message)) {
    return "This historical image was stored in a temporary runtime folder and is no longer available.";
  }
  return message || `Could not preview ${displayLabel}.`;
}

export function TranscriptImageArtifact({
  path,
  displayLabel,
}: {
  path: string;
  displayLabel: string;
}) {
  const durableAssetPath = isRudderAssetPath(path);
  const [preview, setPreview] = useState<DesktopLocalFilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!durableAssetPath);
  const previewRequestRef = useRef<{
    path: string;
    promise: Promise<DesktopLocalFilePreview>;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (durableAssetPath) {
      setLoading(false);
      setError(null);
      setPreview(null);
      return undefined;
    }
    const desktopShell = readDesktopShell();
    if (!desktopShell) {
      setLoading(false);
      setError("Image previews are available in the Rudder Desktop app.");
      return undefined;
    }

    setLoading(true);
    setError(null);
    if (previewRequestRef.current?.path !== path) {
      previewRequestRef.current = {
        path,
        promise: desktopShell.previewLocalFile(path),
      };
    }
    void previewRequestRef.current.promise
      .then((nextPreview) => {
        if (cancelled) return;
        if (!imagePreviewDataUrl(nextPreview)) {
          setPreview(null);
          setError("The recorded artifact is not a supported local image preview.");
          return;
        }
        setPreview(nextPreview);
      })
      .catch((cause) => {
        if (cancelled) return;
        setPreview(null);
        setError(imagePreviewFailureMessage(cause, displayLabel));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [displayLabel, durableAssetPath, path]);

  if (loading) {
    return (
      <div className="ml-5 mt-1.5 flex h-20 w-32 items-center justify-center rounded-lg border border-border/45 bg-muted/10 text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        <span className="sr-only">Loading {displayLabel}</span>
      </div>
    );
  }

  const src = durableAssetPath ? path : preview ? imagePreviewDataUrl(preview) : null;
  if (error || !src) {
    return (
      <div className="ml-5 mt-1.5 flex max-w-sm items-center gap-2 rounded-lg border border-border/45 bg-muted/10 px-3 py-2 text-xs text-muted-foreground" role="alert">
        <ImageOff className="h-4 w-4 shrink-0" aria-hidden />
        <span>{error ?? `Could not preview ${displayLabel}.`}</span>
      </div>
    );
  }

  return (
    <div className="motion-disclosure-enter ml-5 mt-1.5 w-fit max-w-full rounded-lg border border-border/45 bg-muted/10 p-1.5">
      <InspectableImage
        src={src}
        name={preview?.fileName || displayLabel}
        alt={`Preview of ${displayLabel}`}
        previewTitleFallback={displayLabel}
        previewTestId="transcript-image-preview-dialog"
        className="h-24 w-36 max-w-full rounded-md object-contain"
        triggerClassName="rounded-md"
        wrapperClassName="block"
      />
    </div>
  );
}
