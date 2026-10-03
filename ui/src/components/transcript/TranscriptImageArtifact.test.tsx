// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as browserLocalFiles from "../../api/browserLocalFiles";
import { TranscriptImageArtifact } from "./TranscriptImageArtifact";

const { closeImagePreviewIfSource, readDesktopShell, previewLocalFile } = vi.hoisted(() => ({
  closeImagePreviewIfSource: vi.fn(),
  readDesktopShell: vi.fn(),
  previewLocalFile: vi.fn(),
}));

vi.mock("@/context/ImagePreviewContext", () => ({ useImagePreview: () => ({ closeImagePreviewIfSource }) }));
vi.mock("../../lib/desktop-shell", () => ({ readDesktopShell }));
vi.mock("../InspectableImage", () => ({
  InspectableImage: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
let originalCreateObjectURL: PropertyDescriptor | undefined;
let originalRevokeObjectURL: PropertyDescriptor | undefined;
const createObjectURL = vi.fn(() => "blob:browser-image-preview");
const revokeObjectURL = vi.fn();

async function render(path = "/tmp/screenshot.png", displayLabel = "screenshot.png") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<TranscriptImageArtifact path={path} displayLabel={displayLabel} />);
  });
  return container;
}

async function chooseFile(container: HTMLElement, file: File) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).not.toBeNull();
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => {
    input?.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
  readDesktopShell.mockReturnValue(null);
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  if (originalCreateObjectURL) Object.defineProperty(URL, "createObjectURL", originalCreateObjectURL);
  else Reflect.deleteProperty(URL, "createObjectURL");
  if (originalRevokeObjectURL) Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectURL);
  else Reflect.deleteProperty(URL, "revokeObjectURL");
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("TranscriptImageArtifact", () => {
  it("previews a user-selected matching image locally without a server request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const container = await render();
    expect(container.textContent).toContain("original workspace path cannot be verified");
    expect(container.textContent).toContain("not sent to Rudder");

    await chooseFile(container, new File([new Uint8Array([137, 80, 78, 71])], "screenshot.png", { type: "image/png" }));

    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:browser-image-preview");
    expect(container.textContent).toContain("original workspace path is not verified");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(previewLocalFile).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    await act(async () => {
      roots.pop()?.unmount();
    });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:browser-image-preview");
    expect(closeImagePreviewIfSource).toHaveBeenCalledWith("blob:browser-image-preview");
    expect(closeImagePreviewIfSource.mock.invocationCallOrder[0]).toBeLessThan(revokeObjectURL.mock.invocationCallOrder[0]!);
  });

  it("rejects a different filename and a non-image file without reading a path", async () => {
    const container = await render();
    await chooseFile(container, new File(["wrong"], "other.png", { type: "image/png" }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("screenshot.png");
    await chooseFile(container, new File(["not an image"], "screenshot.png", { type: "text/plain" }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Select an image file");
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("rejects oversized selected images before allocating a blob URL", async () => {
    const container = await render();
    const oversized = new File(["image"], "screenshot.png", { type: "image/png" });
    Object.defineProperty(oversized, "size", { value: 100 * 1024 * 1024 + 1 });
    await chooseFile(container, oversized);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("100 MiB browser preview limit");
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("releases the adopted browser URL when the recorded entry changes", async () => {
    const container = await render();
    const root = roots.at(-1)!;
    await chooseFile(container, new File(["image"], "screenshot.png", { type: "image/png" }));
    await act(async () => { root.render(<TranscriptImageArtifact path="/tmp/other.png" displayLabel="other.png" />); });
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("other.png");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:browser-image-preview");
    expect(closeImagePreviewIfSource).toHaveBeenCalledWith("blob:browser-image-preview");
  });

  it("releases the prior URL when a replacement selection fails", async () => {
    const container = await render();
    await chooseFile(container, new File(["image"], "screenshot.png", { type: "image/png" }));
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:browser-image-preview");
    await chooseFile(container, new File(["wrong"], "other.png", { type: "image/png" }));
    expect(container.querySelector("img")).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:browser-image-preview");
    expect(closeImagePreviewIfSource).toHaveBeenCalledWith("blob:browser-image-preview");
  });

  it("releases a created URL when the selected file is not an image", async () => {
    const container = await render();
    await chooseFile(container, new File(["pdf"], "screenshot.png", { type: "application/pdf" }));
    expect(container.querySelector("img")).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:browser-image-preview");
  });

  it("keeps durable assets on their existing API URL without a local picker", async () => {
    const container = await render("/api/assets/asset-1/content", "asset.png");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/assets/asset-1/content");
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });

  it("preserves the Desktop preview bridge", async () => {
    readDesktopShell.mockReturnValue({ previewLocalFile });
    previewLocalFile.mockResolvedValue({
      previewKind: "image",
      contentType: "image/png",
      base64: "aW1hZ2U=",
      fileName: "screenshot.png",
    });
    const container = await render();
    expect(previewLocalFile).toHaveBeenCalledWith("/tmp/screenshot.png");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,aW1hZ2U=");
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });

  it("discards and revokes a selection that resolves after the recorded path changes", async () => {
    const actual = browserLocalFiles.createBrowserLocalFilePreview;
    let release: (() => void) | undefined;
    vi.spyOn(browserLocalFiles, "createBrowserLocalFilePreview").mockImplementation(async (file, path) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return actual(file, path);
    });
    const container = await render();
    const root = roots.at(-1)!;
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["image"], "screenshot.png", { type: "image/png" })] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => { root.render(<TranscriptImageArtifact path="/tmp/other/screenshot.png" displayLabel="screenshot.png" />); });
    await act(async () => { release?.(); });
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("screenshot.png");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:browser-image-preview");
  });

  it("discards and revokes a selection that resolves after unmount", async () => {
    const actual = browserLocalFiles.createBrowserLocalFilePreview;
    let release: (() => void) | undefined;
    vi.spyOn(browserLocalFiles, "createBrowserLocalFilePreview").mockImplementation(async (file, path) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return actual(file, path);
    });
    const container = await render();
    const root = roots.pop()!;
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["image"], "screenshot.png", { type: "image/png" })] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => { root.unmount(); });
    await act(async () => { release?.(); });
    expect(container.querySelector("img")).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:browser-image-preview");
  });
});
