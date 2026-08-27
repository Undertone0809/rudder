// @vitest-environment jsdom

import { DesktopUpdateProgressProvider } from "@/context/DesktopUpdateProgressContext";
import { I18nProvider } from "@/context/I18nContext";
import type { DesktopShellApi, DesktopUpdateProgressEvent } from "@/lib/desktop-shell";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  vi.useRealTimers();
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

  it("keeps runtime preparation active and continues to later update progress", async () => {
    const harness = renderHarness({
      updateId: "update-layered",
      version: "0.7.14",
      phase: "preparing_runtime",
      message: "Preparing the target runtime for a lightweight update.",
      at: new Date().toISOString(),
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("Updating to v0.7.14");
    expect(document.body.textContent).toContain("Preparing the target runtime for a lightweight update.");
    expect(document.body.querySelector('[data-testid="desktop-update-status-card"]')?.getAttribute("data-update-phase"))
      .toBe("preparing_runtime");
    expect(document.body.querySelector('[role="progressbar"]')?.getAttribute("aria-label"))
      .toBe("Preparing lightweight update...");
    expect(document.body.textContent).not.toContain("Update failed");
    expect(document.body.textContent).not.toContain("Retry");

    harness.emit({
      updateId: "update-layered",
      version: "0.7.14",
      phase: "downloading_asset",
      message: "Downloading lightweight desktop asset.",
      percent: 12,
      at: new Date().toISOString(),
    });

    expect(document.body.textContent).toContain("Downloading lightweight desktop asset.");
    expect(document.body.querySelector('[data-testid="desktop-update-status-card"]')?.getAttribute("data-update-phase"))
      .toBe("downloading_asset");
    expect(document.body.textContent).toContain("12%");
    expect(document.body.textContent).not.toContain("Update failed");
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

    expect(harness.applyUpdate).toHaveBeenCalledWith("update-3", undefined);
  });

  it("does not ask for a second confirmation when ready will apply automatically", async () => {
    renderHarness({
      updateId: "update-auto-ready",
      version: "0.2.3",
      phase: "ready_to_install",
      message: "Desktop update is downloaded and verified.",
      percent: 100,
      automaticApply: true,
      at: new Date().toISOString(),
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("Update ready");
    expect(document.body.textContent).not.toContain("Quit and update");
    expect(document.body.textContent).not.toContain("Update when idle");
    expect(document.body.textContent).not.toContain("Stop runs and update now");
  });

  it("shows current blocker identity and only the explicit stop-runs action while waiting", async () => {
    const harness = renderHarness({
      updateId: "update-force-ready",
      version: "0.2.3",
      phase: "waiting_for_active_runs",
      message: "Waiting for 1 running agent run before applying the update.",
      percent: 100,
      totalRuns: 1,
      automaticApply: true,
      blockers: [{
        runId: "f5258de4-b835-4e68-b49e-301d3e0bc97a",
        agentId: "agent-wesley",
        agentName: "Wesley",
        issueId: "issue-zst-776",
        organizationId: "org-z-studio",
        organizationName: "Z Studio",
      }],
      at: new Date().toISOString(),
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("Running work delaying update");
    expect(document.body.textContent).toContain("Z Studio · Wesley · run f5258de4");
    expect(document.body.textContent).toContain("Rudder will update automatically");
    expect(document.body.textContent).not.toContain("Update when idle");
    const forceAction = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Stop runs and update now");
    expect(forceAction).toBeTruthy();

    await act(async () => {
      forceAction?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(harness.applyUpdate).toHaveBeenCalledWith("update-force-ready", { force: true });
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

  it("shows the actionable child-process diagnostic when a desktop update fails", async () => {
    renderHarness({
      updateId: "update-failed",
      version: "0.3.3",
      phase: "failed",
      message: "Update installer exited with code 1.",
      error: "No checksummed Rudder Desktop asset found for darwin/arm64 in Undertone0809/rudder@canary/v0.3.3-canary.0.",
      at: new Date().toISOString(),
    });

    await act(async () => {
      await Promise.resolve();
    });

    const bodyText = document.body.textContent ?? "";
    expect(bodyText).toContain("Update failed");
    expect(bodyText).toContain("No checksummed Rudder Desktop asset found for darwin/arm64");
    expect(bodyText).not.toContain("Update failed.Update failed.");
  });

  it("uses a failed progress message when no separate error is available", async () => {
    renderHarness({
      updateId: "update-failed-message",
      version: "0.3.3",
      phase: "failed",
      message: "Update installer exited with code 1.",
      at: new Date().toISOString(),
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("Update installer exited with code 1.");
  });

  it("clears a completed desktop update after a short confirmation window", async () => {
    vi.useFakeTimers();
    renderHarness({
      updateId: "update-complete",
      version: "0.3.4",
      phase: "complete",
      message: "Rudder Desktop launched.",
      percent: 100,
      at: new Date().toISOString(),
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("Restart handoff complete");
    expect(document.body.textContent).toContain("Rudder Desktop launched.");

    act(() => {
      vi.advanceTimersByTime(4_000);
    });

    expect(document.body.textContent).not.toContain("Restart handoff complete");
  });
});
