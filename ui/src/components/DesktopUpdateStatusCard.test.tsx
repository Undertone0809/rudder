// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopUpdateProgressProvider } from "@/context/DesktopUpdateProgressContext";
import { I18nProvider } from "@/context/I18nContext";
import type { DesktopUpdateProgressEvent, DesktopShellApi } from "@/lib/desktop-shell";
import { DesktopUpdateStatusCard } from "./DesktopUpdateStatusCard";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let cleanupFn: (() => void) | null = null;

function renderHarness(initialProgress: DesktopUpdateProgressEvent | null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  let listener: ((event: DesktopUpdateProgressEvent) => void) | null = null;
  const applyUpdate = vi.fn().mockResolvedValue({
    status: "started",
    updateId: initialProgress?.updateId ?? "update-test",
    version: initialProgress?.version ?? "0.0.0",
  });

  Object.defineProperty(window, "desktopShell", {
    configurable: true,
    value: {
      getUpdateProgress: vi.fn().mockResolvedValue(initialProgress),
      onUpdateProgress: vi.fn((nextListener: (event: DesktopUpdateProgressEvent) => void) => {
        listener = nextListener;
        return () => {
          listener = null;
        };
      }),
      installUpdate: vi.fn(),
      applyUpdate,
      openExternal: vi.fn(),
    } as Partial<DesktopShellApi>,
  });

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <DesktopUpdateProgressProvider>
            <DesktopUpdateStatusCard />
          </DesktopUpdateProgressProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });

  cleanupFn = () => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    delete (window as typeof window & { desktopShell?: unknown }).desktopShell;
  };

  return {
    applyUpdate,
    emit(event: DesktopUpdateProgressEvent) {
      act(() => listener?.(event));
    },
  };
}

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
});

describe("DesktopUpdateStatusCard", () => {
  it("renders a compact bottom-right progress card for active desktop updates", async () => {
    renderHarness({
      updateId: "update-1",
      version: "0.2.1",
      phase: "downloading_asset",
      message: "Downloading desktop asset",
      percent: 42,
      transferredBytes: 42,
      totalBytes: 100,
      at: new Date().toISOString(),
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("Updating to v0.2.1");
    expect(document.body.textContent).toContain("42%");
    expect(document.body.textContent).toContain("Downloading desktop asset");
  });

  it("updates when the desktop shell publishes a new progress event", async () => {
    const harness = renderHarness(null);

    await act(async () => {
      await Promise.resolve();
    });
    expect(document.body.textContent).not.toContain("Updating to");

    harness.emit({
      updateId: "update-2",
      version: "0.2.2",
      phase: "verifying_checksum",
      message: "Verifying checksum",
      at: new Date().toISOString(),
    });

    expect(document.body.textContent).toContain("Updating to v0.2.2");
    expect(document.body.textContent).toContain("Verifying checksum");
  });

  it("shows a single starting status with an immediate progress rail", async () => {
    renderHarness({
      updateId: "update-starting",
      version: "0.2.2",
      phase: "starting",
      message: "Starting update to v0.2.2.",
      at: new Date().toISOString(),
    });

    await act(async () => {
      await Promise.resolve();
    });

    const bodyText = document.body.textContent ?? "";
    expect(bodyText).toContain("Updating to v0.2.2");
    expect(bodyText.match(/Starting update/g)?.length).toBe(1);
    expect(document.body.querySelectorAll('[role="progressbar"]').length).toBe(1);
  });

  it("shows the final restart action after the update package is ready", async () => {
    const harness = renderHarness({
      updateId: "update-3",
      version: "0.2.3",
      phase: "ready_to_install",
      message: "Desktop update is downloaded and verified.",
      percent: 100,
      at: new Date().toISOString(),
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("Update ready");
    const action = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Quit and update");
    expect(action).toBeTruthy();

    await act(async () => {
      action?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(harness.applyUpdate).toHaveBeenCalledWith("update-3");
  });

  it("shows an apply error when the update session is no longer available", async () => {
    const harness = renderHarness({
      updateId: "update-expired",
      version: "0.2.3",
      phase: "ready_to_install",
      message: "Desktop update is downloaded and verified.",
      percent: 100,
      at: new Date().toISOString(),
    });
    harness.applyUpdate.mockResolvedValueOnce({
      status: "unavailable",
      message: "The update session is no longer waiting to apply. Start the update again.",
    });

    await act(async () => {
      await Promise.resolve();
    });

    const action = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Quit and update");

    await act(async () => {
      action?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.body.textContent).toContain("The update session is no longer waiting to apply. Start the update again.");
  });
});
