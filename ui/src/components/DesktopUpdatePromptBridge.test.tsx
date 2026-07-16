// @vitest-environment jsdom

import type { DesktopDeferredUpdatePrompt, DesktopShellApi } from "@/lib/desktop-shell";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopUpdatePromptBridge } from "./DesktopUpdatePromptBridge";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let cleanupFn: (() => void) | null = null;

const prompt: DesktopDeferredUpdatePrompt = {
  promptId: "prompt-1",
  title: "Rudder",
  message: "There is 1 running agent run in this Rudder instance.",
  detail:
    "Rudder can download the installer now, keep running work alive, then apply the update automatically after the runs finish. "
    + "The desktop app may close and reopen automatically when it is safe to replace. "
    + "Choose Stop Runs and Update Now to cancel the listed runs, quit Rudder, and apply the update immediately.\n\n"
    + "Z Studio: Codex (run run-1)",
  totalRuns: 1,
  blockers: [{
    runId: "run-1",
    agentId: "agent-codex",
    agentName: "Codex",
    issueId: "issue-1",
    organizationId: "org-z-studio",
    organizationName: "Z Studio",
  }],
  confirmLabel: "Download and Update When Idle",
  forceLabel: "Stop Runs and Update Now",
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

    expect(document.body.textContent).toContain("There is 1 running agent run in this Rudder instance.");
    expect(document.body.textContent).toContain("Rudder can download the installer now");
    expect(document.body.textContent).toContain("cancel the listed runs");
    expect(document.body.textContent).toContain("Z Studio: Codex (run run-1)");
    expect(document.body.querySelector('[role="dialog"]')).toBeTruthy();
  });

  it("keeps long update actions inside a responsive footer", () => {
    const harness = renderHarness();
    harness.emit({
      ...prompt,
      message: "There are 2 running agent runs in this Rudder instance.",
      detail:
        "Rudder can download the installer now, keep running work alive, then apply the update automatically after the runs finish. "
        + "The desktop app may close and reopen automatically when it is safe to replace. "
        + "Choose Stop Runs and Update Now to cancel the listed runs, quit Rudder, and apply the update immediately.\n\n"
        + "Z Studio: Codex (run run-1)\nRemote Org: Wesley (run run-2)",
      totalRuns: 2,
      blockers: [
        ...prompt.blockers,
        {
          runId: "run-2",
          agentId: "agent-wesley",
          agentName: "Wesley",
          issueId: null,
          organizationId: "org-remote",
          organizationName: "Remote Org",
        },
      ],
    });

    const dialog = document.body.querySelector('[role="dialog"]');
    const footer = document.body.querySelector('[data-slot="dialog-footer"]');
    const waitAction = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Download and Update When Idle");
    const forceAction = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Stop Runs and Update Now");

    expect(dialog?.className).toContain("sm:max-w-[34rem]");
    expect(footer?.className).toContain("sm:grid-cols-2");
    expect(waitAction?.className).toContain("h-auto");
    expect(waitAction?.className).toContain("min-h-10");
    expect(waitAction?.className).toContain("whitespace-normal");
    expect(waitAction?.className).toContain("sm:col-span-2");
    expect(forceAction?.className).toContain("h-auto");
    expect(forceAction?.className).toContain("min-h-10");
    expect(forceAction?.className).toContain("whitespace-normal");
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
    expect(document.body.textContent).not.toContain("There is 1 running agent run in this Rudder instance.");
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

  it("returns force when the operator chooses to stop runs and update immediately", async () => {
    const harness = renderHarness();
    harness.emit(prompt);

    const action = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Stop Runs and Update Now");

    await act(async () => {
      action?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(harness.respondDeferredUpdatePrompt).toHaveBeenCalledWith("prompt-1", "force");
  });
});
