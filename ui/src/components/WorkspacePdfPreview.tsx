import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight, ExternalLink, Loader2, ZoomIn, ZoomOut } from "lucide-react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";

const DEFAULT_PREVIEW_WIDTH = 640;
const MIN_PREVIEW_WIDTH = 280;
const MAX_PIXEL_RATIO = 2;
const MAX_CANVAS_DIMENSION = 16_384;
const MAX_CANVAS_PIXELS = 16_777_216;
const MAX_DISPLAY_DIMENSION = 16_384;
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.2;

let pdfJsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

function loadPdfJs() {
  pdfJsPromise ??= import("pdfjs-dist").then((pdfJs) => {
    pdfJs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    return pdfJs;
  });
  return pdfJsPromise;
}

function clampZoom(value: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

export function WorkspacePdfPreview({
  className,
  showOpenAction = false,
  src,
  testId,
  title,
}: {
  className?: string;
  showOpenAction?: boolean;
  src: string;
  testId: string;
  title: string;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const [containerWidth, setContainerWidth] = useState(DEFAULT_PREVIEW_WIDTH);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [documentLoading, setDocumentLoading] = useState(true);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageText, setPageText] = useState("");
  const [renderedPage, setRenderedPage] = useState<number | null>(null);
  const [rendering, setRendering] = useState(false);
  const [zoom, setZoom] = useState(1);
  const pageCount = document?.numPages ?? 0;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;

    const updateWidth = (width = viewport.getBoundingClientRect().width) => {
      if (width > 0) setContainerWidth(Math.max(MIN_PREVIEW_WIDTH, width));
    };
    const handleResize = () => updateWidth();
    updateWidth();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", handleResize);
      return () => window.removeEventListener("resize", handleResize);
    }

    const observer = new ResizeObserver((entries) => {
      updateWidth(entries[0]?.contentRect.width);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;

    setDocument(null);
    setDocumentError(null);
    setDocumentLoading(true);
    setPageNumber(1);
    setPageText("");
    setRenderedPage(null);
    setZoom(1);

    void loadPdfJs()
      .then((pdfJs) => {
        if (cancelled) return null;
        loadingTask = pdfJs.getDocument({ url: src, withCredentials: true });
        return loadingTask.promise;
      })
      .then((nextDocument) => {
        if (!nextDocument) return;
        if (cancelled) {
          void loadingTask?.destroy();
          return;
        }
        setDocument(nextDocument);
        setDocumentLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setDocumentError(error instanceof Error ? error.message : "The PDF could not be loaded.");
        setDocumentLoading(false);
      });

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
      if (loadingTask) void loadingTask.destroy();
    };
  }, [src]);

  useEffect(() => {
    if (!document) return undefined;
    let cancelled = false;

    renderTaskRef.current?.cancel();
    renderTaskRef.current = null;
    setDocumentError(null);
    setRenderedPage(null);
    setRendering(true);

    void document.getPage(pageNumber)
      .then(async (page) => {
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const canvasContext = canvas.getContext("2d");
        if (!canvasContext) throw new Error("Canvas rendering is unavailable.");

        const baseViewport = page.getViewport({ scale: 1 });
        const availableWidth = Math.max(MIN_PREVIEW_WIDTH - 32, containerWidth - 32);
        const fitScale = availableWidth / baseViewport.width;
        const displayScale = fitScale * zoom;
        const requestedDisplayViewport = page.getViewport({ scale: displayScale });
        const displayScaleLimit = Math.min(
          1,
          MAX_DISPLAY_DIMENSION / Math.max(1, requestedDisplayViewport.width),
          MAX_DISPLAY_DIMENSION / Math.max(1, requestedDisplayViewport.height),
        );
        const boundedDisplayScale = displayScale * displayScaleLimit;
        const displayViewport = displayScaleLimit < 1
          ? page.getViewport({ scale: boundedDisplayScale })
          : requestedDisplayViewport;
        const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
        const requestedRenderViewport = page.getViewport({ scale: boundedDisplayScale * pixelRatio });
        const requestedPixels = requestedRenderViewport.width * requestedRenderViewport.height;
        const bitmapScale = Math.min(
          1,
          Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, requestedPixels)),
          MAX_CANVAS_DIMENSION / Math.max(1, requestedRenderViewport.width),
          MAX_CANVAS_DIMENSION / Math.max(1, requestedRenderViewport.height),
        );
        const renderViewport = bitmapScale < 1
          ? page.getViewport({ scale: boundedDisplayScale * pixelRatio * bitmapScale })
          : requestedRenderViewport;
        canvas.width = Math.max(1, Math.floor(renderViewport.width));
        canvas.height = Math.max(1, Math.floor(renderViewport.height));
        canvas.style.width = `${Math.floor(displayViewport.width)}px`;
        canvas.style.height = `${Math.floor(displayViewport.height)}px`;

        const renderTask = page.render({ canvasContext, viewport: renderViewport });
        renderTaskRef.current = renderTask;
        await renderTask.promise;
        if (!cancelled) setRenderedPage(pageNumber);
      })
      .catch((error: unknown) => {
        if (cancelled || (error instanceof Error && error.name === "RenderingCancelledException")) return;
        setDocumentError(error instanceof Error ? error.message : "The PDF page could not be rendered.");
      })
      .finally(() => {
        if (!cancelled) setRendering(false);
      });

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
    };
  }, [containerWidth, document, pageNumber, zoom]);

  useEffect(() => {
    if (!document) return undefined;
    let cancelled = false;

    setPageText("");
    void document.getPage(pageNumber)
      .then((page) => page.getTextContent())
      .then((textContent) => textContent.items
        .map((item) => ("str" in item ? item.str : ""))
        .filter(Boolean)
        .join(" ")
        .trim())
      .then((nextPageText) => {
        if (!cancelled) setPageText(nextPageText);
      })
      .catch(() => {
        if (!cancelled) setPageText("");
      });

    return () => {
      cancelled = true;
    };
  }, [document, pageNumber]);

  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col bg-[color:var(--surface-page)]", className)}
      data-pdf-src={src}
      data-testid={testId}
    >
      <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] px-3">
        <div className="flex min-w-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Previous PDF page"
            title="Previous page"
            disabled={documentLoading || pageNumber <= 1}
            onClick={() => setPageNumber((current) => Math.max(1, current - 1))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="w-20 text-center text-xs tabular-nums text-muted-foreground" data-testid={`${testId}-page-indicator`}>
            {pageCount > 0 ? `${pageNumber} / ${pageCount}` : "- / -"}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Next PDF page"
            title="Next page"
            disabled={documentLoading || pageNumber >= pageCount}
            onClick={() => setPageNumber((current) => Math.min(pageCount, current + 1))}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom out PDF"
            title="Zoom out"
            disabled={documentLoading || zoom <= MIN_ZOOM}
            onClick={() => setZoom((current) => clampZoom(current - ZOOM_STEP))}
          >
            <ZoomOut className="h-4 w-4" />
          </Button>
          <span className="w-10 text-center text-xs tabular-nums text-muted-foreground">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom in PDF"
            title="Zoom in"
            disabled={documentLoading || zoom >= MAX_ZOOM}
            onClick={() => setZoom((current) => clampZoom(current + ZOOM_STEP))}
          >
            <ZoomIn className="h-4 w-4" />
          </Button>
          {showOpenAction ? (
            <a
              href={src}
              target="_blank"
              rel="noreferrer"
              className="ml-1 inline-flex h-7 items-center gap-1.5 rounded-[4px] px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Open</span>
            </a>
          ) : null}
        </div>
      </div>

      <div
        ref={viewportRef}
        className="scrollbar-auto-hide relative flex min-h-[360px] flex-1 items-start justify-center overflow-auto bg-[#ececec] p-4 dark:bg-[#202020]"
        role="region"
        aria-label={`PDF preview: ${title}`}
      >
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className={cn(
            "block max-w-none bg-white shadow-[0_1px_4px_rgba(0,0,0,0.2)]",
            renderedPage === pageNumber ? "visible" : "invisible",
          )}
          data-rendered-page={renderedPage ?? undefined}
          data-testid={`${testId}-canvas`}
        />
        {renderedPage === pageNumber ? (
          <p className="sr-only" data-testid={`${testId}-text-content`}>
            Page {pageNumber} of {pageCount}. {pageText || "This page contains no extractable text."}
          </p>
        ) : null}
        {documentLoading || rendering ? (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground" role="status" aria-label="Loading PDF preview">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : null}
        {documentError ? (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-muted-foreground" role="alert">
            Could not preview this PDF. {documentError}
          </div>
        ) : null}
      </div>
    </div>
  );
}
