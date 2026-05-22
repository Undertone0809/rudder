// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "@/context/ToastContext";
import { ToastViewport } from "./ToastViewport";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let cleanupFn: (() => void) | null = null;

function renderToastHarness() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onAction = vi.fn();

  function Harness() {
    const { pushToast } = useToast();
    return (
      <button
        type="button"
        onClick={() => pushToast({
          id: "desktop-update-available",
          title: "New version available",
          body: "v0.2.25 is ready to download.",
          tone: "info",
          persistent: true,
          icon: "download",
          action: {
            label: "Download update",
            onClick: onAction,
          },
        })}
      >
        Trigger update toast
      </button>
    );
  }

  act(() => {
    root.render(
      <ToastProvider>
        <Harness />
        <ToastViewport />
      </ToastProvider>,
    );
  });

  cleanupFn = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.body.replaceChildren();
  };

  return { container, onAction };
}

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
});

describe("ToastViewport", () => {
  it("renders update notifications as a bottom-right download card", async () => {
    const { container, onAction } = renderToastHarness();

    act(() => {
      container.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => {
      await Promise.resolve();
    });

    const viewport = document.body.querySelector("aside");
    expect(viewport?.className).toContain("bottom-4");
    expect(viewport?.className).toContain("right-4");
    expect(document.body.textContent).toContain("New version available");
    expect(document.body.textContent).toContain("v0.2.25 is ready to download.");

    const action = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Download update");
    expect(action).toBeTruthy();

    act(() => {
      action?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("New version available");
  });
});
