// @vitest-environment jsdom

import type { DesktopReleaseNotesResult, DesktopShellApi } from "@/lib/desktop-shell";
import { RUDDER_DOCS_URL } from "@/lib/product-links";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopReleaseNotesDialog } from "./DesktopReleaseNotesDialog";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let cleanupFn: (() => void) | null = null;

function renderHarness(result: DesktopReleaseNotesResult) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const markReleaseNotesShown = vi.fn().mockResolvedValue(undefined);
  const openExternal = vi.fn().mockResolvedValue(undefined);

  Object.defineProperty(window, "desktopShell", {
    configurable: true,
    value: {
      getReleaseNotes: vi.fn().mockResolvedValue(result),
      markReleaseNotesShown,
      openExternal,
    } as Partial<DesktopShellApi>,
  });

  act(() => {
    root.render(<DesktopReleaseNotesDialog />);
  });

  cleanupFn = () => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    delete (window as typeof window & { desktopShell?: unknown }).desktopShell;
  };

  return { markReleaseNotesShown, openExternal };
}

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
});

describe("DesktopReleaseNotesDialog", () => {
  it("shows release notes returned by the desktop shell and marks them read", async () => {
    const harness = renderHarness({
      status: "available",
      notes: {
        version: "0.4.0",
        title: "What's new in Rudder 0.4.0",
        sections: [
          {
            title: "New Features",
            items: ["Moved organization workspaces to Documents."],
          },
        ],
      },
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("What's new in Rudder 0.4.0");
    expect(document.body.textContent).toContain("Moved organization workspaces to Documents.");
    expect(document.body.querySelector('img[alt="Rudder"]')?.getAttribute("src")).toBe("/rudder-logo.png");

    const docsAction = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Docs");
    await act(async () => {
      docsAction?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(harness.openExternal).toHaveBeenCalledWith(RUDDER_DOCS_URL);
    expect(harness.markReleaseNotesShown).not.toHaveBeenCalled();

    const action = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Continue");
    await act(async () => {
      action?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(harness.markReleaseNotesShown).toHaveBeenCalledWith("0.4.0");
    expect(document.body.textContent).not.toContain("What's new in Rudder 0.4.0");
  });

  it("stays hidden when the current version has already been shown", async () => {
    renderHarness({ status: "already-shown" });

    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});
