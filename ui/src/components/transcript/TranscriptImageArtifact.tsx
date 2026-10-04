import { useImagePreview } from "@/context/ImagePreviewContext";
import { FolderOpen, ImageOff, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  browserLocalDirectoryPickerError,
  createBrowserLocalFilePreview,
  getBrowserLocalDirectoryPicker,
  readBrowserLocalFileFromDirectory,
  readBrowserLocalFileFromDirectorySelection,
} from "../../api/browserLocalFiles";
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
  const [browserImageSrc, setBrowserImageSrc] = useState<{
    path: string;
    url: string;
    rootName: string;
    relativePath: string;
  } | null>(null);
  const browserUrlRef = useRef<string | null>(null);
  const browserRequestRef = useRef(0);
  const currentPathRef = useRef(path);
  currentPathRef.current = path;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!durableAssetPath);
  const browserDirectoryInputRef = useRef<HTMLInputElement | null>(null);
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

  const acceptBrowserDirectoryRead = async (
    selected: Awaited<ReturnType<typeof readBrowserLocalFileFromDirectory>>,
    selectedPath: string,
    request: number,
  ) => {
    const selectedPreview = await createBrowserLocalFilePreview(selected.file, selectedPath);
    if (selectedPreview.previewKind !== "image" || !selectedPreview.contentPath) {
      if (selectedPreview.contentPath?.startsWith("blob:")) URL.revokeObjectURL(selectedPreview.contentPath);
      throw new Error("Select an image file matching the recorded relative path.");
    }
    if (request !== browserRequestRef.current || selectedPath !== currentPathRef.current) {
      if (selectedPreview.contentPath.startsWith("blob:")) URL.revokeObjectURL(selectedPreview.contentPath);
      return;
    }
    releaseBrowserUrl();
    browserUrlRef.current = selectedPreview.contentPath.startsWith("blob:") ? selectedPreview.contentPath : null;
    setBrowserImageSrc({
      path: selectedPath,
      url: selectedPreview.contentPath,
      rootName: selected.rootName,
      relativePath: selected.relativePath,
    });
  };

  const handleBrowserDirectoryChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const selectedFiles = Array.from(input.files ?? []);
    input.value = "";
    if (!selectedFiles.length) return;
    const request = ++browserRequestRef.current;
    const selectedPath = path;
    setLoading(true);
    setError(null);
    try {
      const selected = readBrowserLocalFileFromDirectorySelection(selectedFiles, selectedPath);
      releaseBrowserUrl();
      setBrowserImageSrc(null);
      await acceptBrowserDirectoryRead(selected, selectedPath, request);
    } catch (cause) {
      if (request !== browserRequestRef.current || selectedPath !== currentPathRef.current) return;
      releaseBrowserUrl();
      setBrowserImageSrc(null);
      setError(imagePreviewFailureMessage(cause, displayLabel));
    } finally {
      if (request === browserRequestRef.current && selectedPath === currentPathRef.current) setLoading(false);
    }
  };

  const chooseBrowserWorkspaceFolder = async () => {
    const picker = getBrowserLocalDirectoryPicker();
    if (!picker) {
      browserDirectoryInputRef.current?.click();
      return;
    }

    const request = ++browserRequestRef.current;
    const selectedPath = path;
    let directoryGranted = false;
    setError(null);
    try {
      const directory = await picker({ mode: "read" });
      if (request !== browserRequestRef.current || selectedPath !== currentPathRef.current) return;
      directoryGranted = true;
      releaseBrowserUrl();
      setBrowserImageSrc(null);
      setLoading(true);
      const selected = await readBrowserLocalFileFromDirectory(directory, selectedPath);
      await acceptBrowserDirectoryRead(selected, selectedPath, request);
    } catch (cause) {
      if (request !== browserRequestRef.current || selectedPath !== currentPathRef.current) return;
      if (!directoryGranted) {
        setError(cause instanceof DOMException && cause.name === "AbortError"
          ? null
          : browserLocalDirectoryPickerError(cause));
        return;
      }
      releaseBrowserUrl();
      setBrowserImageSrc(null);
      setError(browserLocalDirectoryPickerError(cause) || imagePreviewFailureMessage(cause, displayLabel));
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
            ref={(input) => {
              browserDirectoryInputRef.current = input;
              input?.setAttribute("webkitdirectory", "");
            }}
            type="file"
            multiple
            accept="image/*"
            className="sr-only"
            aria-label={`Choose the folder containing ${displayLabel}`}
            onChange={(event) => void handleBrowserDirectoryChange(event)}
          />
          {error ? <p role="alert">{error}</p> : (
            <p>To preview {displayLabel}, grant read-only access to a folder whose name appears once in the recorded path. Only the remaining relative path is read. The browser cannot verify the selected folder&apos;s full system path.</p>
          )}
          <button type="button" className="mt-2 inline-flex items-center gap-1.5 rounded-sm border border-border px-2 py-1 text-foreground" onClick={() => void chooseBrowserWorkspaceFolder()}>
            <FolderOpen className="h-3.5 w-3.5" aria-hidden />
            Choose workspace folder
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
          <p>Read locally from {browserImageSrc?.rootName} at relative path: {browserImageSrc?.relativePath}. The browser cannot verify the selected folder&apos;s full system path.</p>
          <input
            ref={(input) => {
              browserDirectoryInputRef.current = input;
              input?.setAttribute("webkitdirectory", "");
            }}
            type="file"
            multiple
            accept="image/*"
            className="sr-only"
            aria-label={`Choose another folder containing ${displayLabel}`}
            onChange={(event) => void handleBrowserDirectoryChange(event)}
          />
          <button type="button" className="mt-1 rounded-sm text-foreground underline-offset-2 hover:underline" onClick={() => void chooseBrowserWorkspaceFolder()}>
            Choose another workspace folder
          </button>
        </div>
      ) : null}
    </div>
  );
}
