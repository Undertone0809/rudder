// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImagePreviewProvider, useImagePreview } from "./ImagePreviewContext";

vi.mock("@/components/ImagePreviewDialog", () => ({
  ImagePreviewDialog: ({
    onOpenChange,
    preview,
    testId,
  }: {
    onOpenChange(open: boolean): void;
    preview: { name: string; src: string } | null;
    testId: string;
  }) => preview ? (
    <div data-testid={testId}>
      <img alt={preview.name} src={preview.src} />
      <button type="button" onClick={() => onOpenChange(false)}>Close image preview</button>
    </div>
  ) : null,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
});

function PreviewHarness() {
  const { openImagePreview } = useImagePreview();
  const navigate = useNavigate();
  return (
    <>
      <button
        type="button"
        onClick={() => openImagePreview({
          alt: "First",
          name: "first.png",
          src: "/api/assets/first/content",
          testId: "first-preview",
        })}
      >
        First
      </button>
      <button
        type="button"
        onClick={() => openImagePreview({
          alt: "Second",
          name: "second.png",
          src: "/api/assets/second/content",
          testId: "second-preview",
        })}
      >
        Second
      </button>
      <button type="button" onClick={() => navigate("/another-route")}>Change route</button>
    </>
  );
}

describe("ImagePreviewProvider", () => {
  it("owns one replaceable preview and exposes a consistent close path", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanup = () => act(() => root.unmount());

    act(() => {
      root.render(
        <MemoryRouter initialEntries={["/chat/one"]}>
          <ImagePreviewProvider>
            <PreviewHarness />
          </ImagePreviewProvider>
        </MemoryRouter>,
      );
    });

    const buttons = container.querySelectorAll("button");
    act(() => buttons[0]?.click());
    expect(document.querySelectorAll("[data-testid$='-preview']")).toHaveLength(1);
    expect(document.querySelector("[data-testid='first-preview'] img")?.getAttribute("src"))
      .toBe("/api/assets/first/content");

    act(() => buttons[1]?.click());
    expect(document.querySelector("[data-testid='first-preview']")).toBeNull();
    expect(document.querySelectorAll("[data-testid$='-preview']")).toHaveLength(1);
    expect(document.querySelector("[data-testid='second-preview'] img")?.getAttribute("src"))
      .toBe("/api/assets/second/content");

    act(() => {
      document.querySelector<HTMLButtonElement>("[data-testid='second-preview'] button")?.click();
    });
    expect(document.querySelector("[data-testid='second-preview']")).toBeNull();
  });

  it("closes stale previews when application location changes", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanup = () => act(() => root.unmount());

    act(() => {
      root.render(
        <MemoryRouter initialEntries={["/chat/one"]}>
          <ImagePreviewProvider>
            <PreviewHarness />
          </ImagePreviewProvider>
        </MemoryRouter>,
      );
    });

    const firstButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "First");
    const routeButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Change route");
    act(() => firstButton?.click());
    expect(document.querySelector("[data-testid='first-preview']")).toBeTruthy();

    act(() => routeButton?.click());
    expect(document.querySelector("[data-testid='first-preview']")).toBeNull();
  });
});
