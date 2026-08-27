// @vitest-environment jsdom

import { ToastProvider, useToast } from "@/context/ToastContext";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastViewport } from "./ToastViewport";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let cleanupFn: (() => void) | null = null;

function renderToastHarness(options: {
  countdown?: boolean;
  onAction?: () => void | Promise<void>;
} = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onAction = vi.fn(options.onAction);

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
          persistent: options.countdown ? false : true,
          ttlMs: options.countdown ? 12_000 : undefined,
          countdown: options.countdown,
          icon: "download",
          action: {
            label: options.countdown ? "Undo" : "Download update",
            pendingLabel: options.countdown ? "Cancelling..." : undefined,
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

    await act(async () => {
      action?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("New version available");
  });

  it("ties opt-in countdown motion to the toast TTL and blocks duplicate actions while pending", async () => {
    let resolveAction: (() => void) | null = null;
    const actionPromise = new Promise<void>((resolve) => {
      resolveAction = resolve;
    });
    const { container, onAction } = renderToastHarness({
      countdown: true,
      onAction: () => actionPromise,
    });

    act(() => {
      container.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => Promise.resolve());
    const toast = document.body.querySelector('[data-toast-id="desktop-update-available"]') as HTMLElement | null;
    expect(toast?.dataset.countdown).toBe("true");
    expect(toast?.className).toContain("motion-toast-countdown");
    expect(toast?.style.getPropertyValue("--motion-toast-countdown-duration")).toBe("12000ms");
    expect(toast?.style.getPropertyValue("--motion-toast-countdown-elapsed")).toMatch(/^\d+ms$/);

    const action = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Undo");
    await act(async () => {
      action?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      action?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(action?.disabled).toBe(true);
    expect(action?.textContent).toBe("Cancelling...");

    await act(async () => {
      resolveAction?.();
      await actionPromise;
      await Promise.resolve();
    });
    expect(document.body.textContent).not.toContain("New version available");
  });

  it("keeps a failed action notification available for retry", async () => {
    const { container, onAction } = renderToastHarness({
      countdown: true,
      onAction: async () => {
        throw new Error("runtime did not acknowledge cancellation");
      },
    });

    act(() => {
      container.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => Promise.resolve());

    const action = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Undo");
    await act(async () => {
      action?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("New version available");
    expect(action?.disabled).toBe(false);
    expect(action?.textContent).toBe("Undo");
  });
});
