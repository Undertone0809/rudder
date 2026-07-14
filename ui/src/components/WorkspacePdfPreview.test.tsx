// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspacePdfPreview } from "./WorkspacePdfPreview";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pdfMocks = vi.hoisted(() => ({
  getDocument: vi.fn(),
  workerOptions: { workerSrc: "" },
}));

vi.mock("pdfjs-dist", () => ({
  getDocument: pdfMocks.getDocument,
  GlobalWorkerOptions: pdfMocks.workerOptions,
}));

vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: "/mock-pdf-worker.mjs",
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  pdfMocks.getDocument.mockReset();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(() => ({}) as CanvasRenderingContext2D);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WorkspacePdfPreview", () => {
  it("clears a page render error after a successful zoom retry", async () => {
    let shouldFail = true;
    const render = vi.fn()
      .mockImplementation(() => ({
        cancel: vi.fn(),
        promise: Promise.resolve().then(() => {
          if (shouldFail) throw new Error("Page render failed.");
        }),
      }));
    const page = {
      getTextContent: vi.fn().mockResolvedValue({
        items: [{ str: "Accessible PDF text" }],
      }),
      getViewport: ({ scale }: { scale: number }) => ({
        height: 792 * scale,
        width: 612 * scale,
      }),
      render,
    };
    const pdfDocument = {
      getPage: vi.fn().mockResolvedValue(page),
      numPages: 1,
    };
    const loadingTask = {
      destroy: vi.fn(),
      promise: Promise.resolve(pdfDocument),
    };
    pdfMocks.getDocument.mockReturnValue(loadingTask);

    await act(async () => {
      root.render(
        <WorkspacePdfPreview
          src="/api/report.pdf"
          testId="pdf-preview"
          title="report.pdf"
        />,
      );
    });
    await act(async () => {
      await vi.waitFor(() => {
        const alert = container.querySelector("[role='alert']");
        expect(alert).not.toBeNull();
        expect(alert?.textContent).toContain("Page render failed.");
      });
    });

    const zoomOut = container.querySelector<HTMLButtonElement>("button[aria-label='Zoom out PDF']");
    expect(zoomOut).not.toBeNull();
    shouldFail = false;

    await act(async () => {
      zoomOut?.click();
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(container.querySelector("[role='alert']")).toBeNull();
        expect(container.querySelector("canvas")?.getAttribute("data-rendered-page")).toBe("1");
        expect(container.querySelector("[data-testid='pdf-preview-text-content']")?.textContent)
          .toContain("Accessible PDF text");
      });
    });

    expect(render.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(page.getTextContent).toHaveBeenCalledTimes(1);
  });

  it("caps extreme page dimensions before allocating the backing canvas", async () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const render = vi.fn().mockReturnValue({
      cancel: vi.fn(),
      promise: Promise.resolve(),
    });
    const page = {
      getTextContent: vi.fn().mockResolvedValue({ items: [] }),
      getViewport: ({ scale }: { scale: number }) => ({
        height: 14_400 * scale,
        width: scale,
      }),
      render,
    };
    pdfMocks.getDocument.mockReturnValue({
      destroy: vi.fn(),
      promise: Promise.resolve({
        getPage: vi.fn().mockResolvedValue(page),
        numPages: 1,
      }),
    });

    await act(async () => {
      root.render(
        <WorkspacePdfPreview
          src="/api/extreme.pdf"
          testId="extreme-pdf-preview"
          title="extreme.pdf"
        />,
      );
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(container.querySelector("canvas")?.getAttribute("data-rendered-page")).toBe("1");
      });
    });

    const renderParameters = render.mock.calls.at(-1)?.[0] as {
      viewport: { height: number; width: number };
    } | undefined;
    expect(renderParameters).toBeDefined();
    expect(renderParameters?.viewport.width).toBeLessThanOrEqual(16_384);
    expect(renderParameters?.viewport.height).toBeLessThanOrEqual(16_384);
    expect((renderParameters?.viewport.width ?? 0) * (renderParameters?.viewport.height ?? 0))
      .toBeLessThanOrEqual(16_777_216);
    const canvas = container.querySelector<HTMLCanvasElement>("canvas");
    expect(Number.parseFloat(canvas?.style.width ?? "0")).toBeLessThanOrEqual(16_384);
    expect(Number.parseFloat(canvas?.style.height ?? "0")).toBeLessThanOrEqual(16_384);
  });
});
