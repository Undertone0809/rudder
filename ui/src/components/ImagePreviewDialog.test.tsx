// @vitest-environment jsdom

import { act, type CSSProperties, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImagePreviewDialog } from "./ImagePreviewDialog";

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) => open ? children : null,
  DialogClose: ({ children, ...props }: { children: ReactNode }) => <button {...props}>{children}</button>,
  DialogContent: ({
    children,
    showCloseButton: _showCloseButton,
    ...props
  }: {
    children: ReactNode;
    showCloseButton?: boolean;
    style?: CSSProperties;
  }) => <div {...props}>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
  Reflect.deleteProperty(window, "desktopShell");
  vi.unstubAllGlobals();
});

describe("ImagePreviewDialog", () => {
  it("keeps Desktop close and action controls separate when image loading fails", async () => {
    let failImageLoad: (() => void) | null = null;
    class FailingImage {
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;

      set src(_value: string) {
        failImageLoad = () => this.onerror?.();
      }
    }
    vi.stubGlobal("Image", FailingImage);
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: { showImageInFolder: vi.fn() },
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanup = () => act(() => root.unmount());

    await act(async () => {
      root.render(
        <ImagePreviewDialog
          preview={{ alt: "Broken image", name: "broken.png", src: "/missing.png" }}
          onOpenChange={() => undefined}
          testId="broken-image-preview"
          titleFallback="Image preview"
        />,
      );
    });

    const preview = container.querySelector<HTMLElement>("[data-testid='broken-image-preview']");
    expect(preview?.style.width).toBe("168px");
    expect(preview?.style.height).toBe("48px");
    expect(preview?.textContent).toContain("Close image preview");
    expect(preview?.textContent).toContain("Copy Image");
    expect(preview?.textContent).toContain("Download Image");
    expect(preview?.textContent).toContain("Show in folder");

    const image = preview?.querySelector("img");
    act(() => {
      image?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 32,
        clientY: 48,
      }));
    });
    const contextMenu = document.body.querySelector('[data-testid="image-preview-context-menu"]');
    expect(contextMenu?.textContent).toContain("Copy Image");
    expect(contextMenu?.textContent).toContain("Download Image");

    await act(async () => {
      failImageLoad?.();
    });
    expect(preview?.style.width).toBe("168px");
    expect(preview?.style.height).toBe("48px");
  });
});
