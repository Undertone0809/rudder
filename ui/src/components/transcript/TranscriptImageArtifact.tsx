import { useImagePreview } from "@/context/ImagePreviewContext";
import { FolderOpen, ImageOff, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { createBrowserLocalFilePreview } from "../../api/browserLocalFiles";
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
  const desktopShell = readDesktopShell();
  const { closeImagePreviewIfSource } = useImagePreview();
  const [preview, setPreview] = useState<DesktopLocalFilePreview | null>(null);
  const [browserImageSrc, setBrowserImageSrc] = useState<{ path: string; url: string } | null>(null);
  const browserUrlRef = useRef<string | null>(null);
  const browserRequestRef = useRef(0);
  const currentPathRef = useRef(path);
  currentPathRef.current = path;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!durableAssetPath);
  const browserFileInputRef = useRef<HTMLInputElement | null>(null);
  const previewRequestRef = useRef<{
    path: string;
    promise: Promise<DesktopLocalFilePreview>;
  } | null>(null);
  const releaseBrowserUrl = useCallback(() => {
    const url = browserUrlRef.current;
    if (!url) return;
    browserUrlRef.current = null;
    closeImagePreviewIfSource(url);
    URL.revokeObjectURL(url);
  }, [closeImagePreviewIfSource]);

  useEffect(() => {
    let cancelled = false;
    browserRequestRef.current += 1;
    setBrowserImageSrc(null);
    releaseBrowserUrl();
    if (durableAssetPath) {
      setLoading(false);
      setError(null);
      setPreview(null);
      return undefined;
    }
    if (!desktopShell) {
      setLoading(false);
      setError(null);
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
  }, [desktopShell, displayLabel, durableAssetPath, path, releaseBrowserUrl]);

  useEffect(() => () => {
    browserRequestRef.current += 1;
    releaseBrowserUrl();
  }, [displayLabel, path, releaseBrowserUrl]);

  const chooseBrowserImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const selectedFile = input.files?.[0] ?? null;
    input.value = "";
    if (!selectedFile) return;
    const request = ++browserRequestRef.current;
    const selectedPath = path;
    releaseBrowserUrl();
    setBrowserImageSrc(null);
    setLoading(true);
    setError(null);
    try {
      const selectedPreview = await createBrowserLocalFilePreview(selectedFile, path);
      if (selectedPreview.previewKind !== "image" || !selectedPreview.contentPath) {
        if (selectedPreview.contentPath?.startsWith("blob:")) URL.revokeObjectURL(selectedPreview.contentPath);
        throw new Error("Select an image file matching the recorded filename.");
      }
      if (request !== browserRequestRef.current || selectedPath !== currentPathRef.current) {
        if (selectedPreview.contentPath.startsWith("blob:")) URL.revokeObjectURL(selectedPreview.contentPath);
        return;
      }
      releaseBrowserUrl();
      browserUrlRef.current = selectedPreview.contentPath.startsWith("blob:") ? selectedPreview.contentPath : null;
      setBrowserImageSrc({ path: selectedPath, url: selectedPreview.contentPath });
    } catch (cause) {
      if (request !== browserRequestRef.current || selectedPath !== currentPathRef.current) return;
      setBrowserImageSrc(null);
      setError(imagePreviewFailureMessage(cause, displayLabel));
    } finally {
      if (request === browserRequestRef.current && selectedPath === currentPathRef.current) setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="ml-5 mt-1.5 flex h-20 w-32 items-center justify-center rounded-lg border border-border/45 bg-muted/10 text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        <span className="sr-only">Loading {displayLabel}</span>
      </div>
    );
  }

  const currentBrowserImageSrc = browserImageSrc?.path === path ? browserImageSrc.url : null;
  const src = durableAssetPath ? path : preview ? imagePreviewDataUrl(preview) : currentBrowserImageSrc;
  if (error || !src) {
    if (!durableAssetPath && !desktopShell) {
      return (
        <div className="ml-5 mt-1.5 max-w-sm rounded-lg border border-border/45 bg-muted/10 px-3 py-2 text-xs text-muted-foreground" data-testid="transcript-browser-image-picker">
          <input
            ref={browserFileInputRef}
            type="file"
            accept="image/*"
            className="sr-only"
            aria-label={`Choose ${displayLabel} from this device`}
            onChange={(event) => void chooseBrowserImage(event)}
          />
          {error ? <p role="alert">{error}</p> : (
            <p>Choose a local image named {displayLabel}. Its original workspace path cannot be verified.</p>
          )}
          <button type="button" className="mt-2 inline-flex items-center gap-1.5 rounded-sm border border-border px-2 py-1 text-foreground" onClick={() => browserFileInputRef.current?.click()}>
            <FolderOpen className="h-3.5 w-3.5" aria-hidden />
            Choose local image
          </button>
          <p className="mt-2">File contents stay in this browser and are not sent to Rudder.</p>
        </div>
      );
    }
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
      {currentBrowserImageSrc && !desktopShell ? (
        <div className="mt-1.5 max-w-xs text-xs text-muted-foreground">
          <p>Selected in this browser by filename; original workspace path is not verified.</p>
          <input
            ref={browserFileInputRef}
            type="file"
            accept="image/*"
            className="sr-only"
            aria-label={`Choose another ${displayLabel} from this device`}
            onChange={(event) => void chooseBrowserImage(event)}
          />
          <button type="button" className="mt-1 rounded-sm text-foreground underline-offset-2 hover:underline" onClick={() => browserFileInputRef.current?.click()}>
            Choose another image
          </button>
        </div>
      ) : null}
    </div>
  );
}
