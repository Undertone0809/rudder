export interface RenderedVisualCapture {
  blob: Blob;
  height: number;
  width: number;
}

export interface RenderedVisualCaptureSize {
  height: number;
  scale: number;
  width: number;
}

const MAX_CAPTURE_EDGE = 4096;
const MAX_CAPTURE_SCALE = 2;

function positiveFinite(value: number) {
  return Number.isFinite(value) && value > 0;
}

export function getRenderedVisualCaptureSize(
  sourceWidth: number,
  sourceHeight: number,
  devicePixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio,
): RenderedVisualCaptureSize {
  const normalizedWidth = positiveFinite(sourceWidth) ? sourceWidth : 1;
  const normalizedHeight = positiveFinite(sourceHeight) ? sourceHeight : 1;
  const requestedScale = Math.min(
    MAX_CAPTURE_SCALE,
    Math.max(1, positiveFinite(devicePixelRatio) ? devicePixelRatio : 1),
  );
  const edgeScale = Math.min(
    MAX_CAPTURE_EDGE / normalizedWidth,
    MAX_CAPTURE_EDGE / normalizedHeight,
  );
  const scale = Math.min(requestedScale, edgeScale);

  return {
    width: Math.max(1, Math.round(normalizedWidth * scale)),
    height: Math.max(1, Math.round(normalizedHeight * scale)),
    scale,
  };
}

function loadSvgImage(svg: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      resolve(image);
    };
    image.onerror = () => {
      reject(new Error("Unable to render this visual as an image."));
    };
    // Chromium treats foreignObject content loaded from a blob URL as
    // cross-origin and taints the destination canvas. A data URL keeps the
    // serialized, already-sanitized markup in the document's origin.
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

function canvasToPngBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error("Unable to create a PNG from this visual."));
    }, "image/png");
  });
}

async function rasterizeSvg(
  svg: string,
  sourceWidth: number,
  sourceHeight: number,
): Promise<RenderedVisualCapture> {
  const output = getRenderedVisualCaptureSize(sourceWidth, sourceHeight);
  const image = await loadSvgImage(svg);
  const canvas = document.createElement("canvas");
  canvas.width = output.width;
  canvas.height = output.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to prepare image capture.");
  context.drawImage(image, 0, 0, output.width, output.height);
  return {
    blob: await canvasToPngBlob(canvas),
    width: output.width,
    height: output.height,
  };
}

function serializeSvgElement(svgElement: SVGSVGElement, width: number, height: number) {
  const clone = svgElement.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  if (!clone.getAttribute("viewBox")) clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
  return new XMLSerializer().serializeToString(clone);
}

function svgSourceSize(svgElement: SVGSVGElement) {
  const viewBox = svgElement.viewBox.baseVal;
  if (positiveFinite(viewBox.width) && positiveFinite(viewBox.height)) {
    return { width: viewBox.width, height: viewBox.height };
  }
  const bounds = svgElement.getBoundingClientRect();
  return {
    width: positiveFinite(bounds.width) ? bounds.width : 1,
    height: positiveFinite(bounds.height) ? bounds.height : 1,
  };
}

export async function captureSvgElementAsPng(svgElement: SVGSVGElement) {
  const sourceSize = svgSourceSize(svgElement);
  return rasterizeSvg(
    serializeSvgElement(svgElement, sourceSize.width, sourceSize.height),
    sourceSize.width,
    sourceSize.height,
  );
}

function serializeInlineVisualDocument(
  frameDocument: Document,
  width: number,
  height: number,
) {
  const clone = frameDocument.documentElement.cloneNode(true) as HTMLElement;
  clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  clone.style.width = `${width}px`;
  clone.style.height = `${height}px`;
  clone.style.margin = "0";
  const serializedDocument = new XMLSerializer().serializeToString(clone);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<foreignObject width="100%" height="100%">${serializedDocument}</foreignObject>`,
    "</svg>",
  ].join("");
}

export async function captureInlineVisualDocumentAsPng(
  frameDocument: Document,
  width: number,
  height: number,
) {
  if (!positiveFinite(width) || !positiveFinite(height)) {
    throw new Error("The visual is not ready to capture.");
  }
  return rasterizeSvg(
    serializeInlineVisualDocument(frameDocument, width, height),
    width,
    height,
  );
}

export function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Unable to prepare the captured image."));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Unable to prepare the captured image."));
    reader.readAsDataURL(blob);
  });
}

export function renderedVisualPngName(name: string | null | undefined, fallback: string) {
  const normalized = name?.trim() || fallback;
  const withoutExtension = normalized.replace(/\.[a-z0-9]{1,8}$/iu, "");
  return `${withoutExtension || fallback}.png`;
}
