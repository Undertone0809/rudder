// @vitest-environment jsdom

import { ToastProvider } from "@/context/ToastContext";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastViewport } from "./ToastViewport";
import { VisualMediaActions } from "./VisualMediaActions";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => void) | null = null;

function render(element: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ToastProvider>
        {element}
        <ToastViewport />
      </ToastProvider>,
    );
  });
  cleanup = () => act(() => root.unmount());
  return container;
}

afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("VisualMediaActions", () => {
  it("exposes icon buttons with accessible names and reports copy success", async () => {
    const onCopy = vi.fn(async () => undefined);
    const onPreview = vi.fn(async () => undefined);
    const container = render(<VisualMediaActions onCopy={onCopy} onPreview={onPreview} />);

    const buttons = container.querySelectorAll<HTMLButtonElement>("button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.getAttribute("aria-label")).toBe("Open image preview");
    expect(buttons[1]?.getAttribute("aria-label")).toBe("Copy Image");

    await act(async () => {
      buttons[1]?.click();
      await Promise.resolve();
    });

    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Image copied");
  });

  it("keeps the visual usable and reports a copy failure", async () => {
    const container = render(
      <VisualMediaActions
        onPreview={() => undefined}
        onCopy={() => Promise.reject(new Error("Clipboard permission denied"))}
      />,
    );

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Copy Image"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("Copy Image failed");
    expect(document.body.textContent).toContain("Clipboard permission denied");
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Copy Image"]')?.disabled).toBe(false);
  });

  it("reports a preview failure and restores the action", async () => {
    const container = render(
      <VisualMediaActions
        onPreview={() => Promise.reject(new Error("Canvas capture failed"))}
        onCopy={() => undefined}
      />,
    );

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Open image preview"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("Open image preview failed");
    expect(document.body.textContent).toContain("Canvas capture failed");
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Open image preview"]')?.disabled).toBe(false);
  });
});
