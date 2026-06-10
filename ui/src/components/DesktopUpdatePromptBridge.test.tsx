// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopDeferredUpdatePrompt, DesktopShellApi } from "@/lib/desktop-shell";
import { DesktopUpdatePromptBridge } from "./DesktopUpdatePromptBridge";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let cleanupFn: (() => void) | null = null;

const prompt: DesktopDeferredUpdatePrompt = {
  promptId: "prompt-1",
  title: "Rudder",
  message: "There is 1 active agent run.",
  detail:
    "Rudder can download the installer now, keep active work running, then apply the update after the runs finish. "
    + "The desktop app may close and reopen automatically when it is safe to replace.\n\n"
    + "Z Studio: 1 running",
  totalRuns: 1,
  confirmLabel: "Download and Update When Idle",
  cancelLabel: "Cancel",
};

function renderHarness() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let listener: ((nextPrompt: DesktopDeferredUpdatePrompt) => void) | null = null;
  const respondDeferredUpdatePrompt = vi.fn().mockResolvedValue(undefined);

  Object.defineProperty(window, "desktopShell", {
    configurable: true,
    value: {
      onDeferredUpdatePrompt: vi.fn((nextListener: (nextPrompt: DesktopDeferredUpdatePrompt) => void) => {
        listener = nextListener;
        return () => {
          listener = null;
        };
      }),
      respondDeferredUpdatePrompt,
    } as Partial<DesktopShellApi>,
  });

  act(() => {
    root.render(<DesktopUpdatePromptBridge />);
  });

  cleanupFn = () => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    delete (window as typeof window & { desktopShell?: unknown }).desktopShell;
  };

  return {
    respondDeferredUpdatePrompt,
    emit(nextPrompt: DesktopDeferredUpdatePrompt) {
      act(() => listener?.(nextPrompt));
    },
  };
}

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
});

describe("DesktopUpdatePromptBridge", () => {
  it("renders the deferred update prompt with Rudder dialog components", () => {
    const harness = renderHarness();
    harness.emit(prompt);

    expect(document.body.textContent).toContain("There is 1 active agent run.");
    expect(document.body.textContent).toContain("Rudder can download the installer now");
    expect(document.body.textContent).toContain("Z Studio: 1 running");
    expect(document.body.querySelector('[role="dialog"]')).toBeTruthy();
  });

  it("returns wait when the primary action is selected", async () => {
    const harness = renderHarness();
    harness.emit(prompt);

    const action = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Download and Update When Idle");

    await act(async () => {
      action?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(harness.respondDeferredUpdatePrompt).toHaveBeenCalledWith("prompt-1", "wait");
    expect(document.body.textContent).not.toContain("There is 1 active agent run.");
  });

  it("returns cancel when the secondary action is selected", async () => {
    const harness = renderHarness();
    harness.emit(prompt);

    const action = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Cancel");

    await act(async () => {
      action?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(harness.respondDeferredUpdatePrompt).toHaveBeenCalledWith("prompt-1", "cancel");
  });
});
