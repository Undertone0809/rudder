// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./AppErrorBoundary";

const CHILDREN_ONLY_MESSAGE = "React.Children.only expected to receive a single React element child.";
const AUTO_RECOVERY_STORAGE_KEY = "rudder:app-error-boundary:auto-recovery.v1";

function ThrowingChild() {
  throw new Error("composer exploded");
  return <div />;
}

function ThrowingChildrenOnlyChild() {
  throw new Error(CHILDREN_ONLY_MESSAGE);
  return <div />;
}

describe("AppErrorBoundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    window.sessionStorage.clear();
    Reflect.deleteProperty(window, "desktopShell");
  });

  it("shows a recovery surface instead of unmounting to a blank page", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const container = document.createElement("div");
    document.body.appendChild(container);

    createRoot(container).render(
      <AppErrorBoundary>
        <ThrowingChild />
      </AppErrorBoundary>,
    );

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Rudder hit a UI failure.");
    });
    expect(container.textContent).toContain("Reload UI");
    expect(container.textContent).toContain("Copy diagnostic");
    expect(container.textContent).toContain("composer exploded");
  });

  it("reloads once for recoverable React child shape failures without showing diagnostics", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reloadApp = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: { reloadApp },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);

    createRoot(container).render(
      <AppErrorBoundary>
        <ThrowingChildrenOnlyChild />
      </AppErrorBoundary>,
    );

    await vi.waitFor(() => {
      expect(reloadApp).toHaveBeenCalledTimes(1);
    });
    expect(container.textContent).toContain("Rudder is refreshing the UI...");
    expect(container.textContent).not.toContain("Rudder hit a UI failure.");
    expect(container.textContent).not.toContain(CHILDREN_ONLY_MESSAGE);
  });

  it("falls back to diagnostics when the recoverable failure repeats after an automatic reload", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reloadApp = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: { reloadApp },
    });
    window.sessionStorage.setItem(AUTO_RECOVERY_STORAGE_KEY, JSON.stringify({
      attemptedAt: Date.now(),
      message: CHILDREN_ONLY_MESSAGE,
      route: "/",
    }));
    const container = document.createElement("div");
    document.body.appendChild(container);

    createRoot(container).render(
      <AppErrorBoundary>
        <ThrowingChildrenOnlyChild />
      </AppErrorBoundary>,
    );

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Rudder hit a UI failure.");
    });
    expect(reloadApp).not.toHaveBeenCalled();
    expect(container.textContent).toContain(CHILDREN_ONLY_MESSAGE);
  });

  it("copies route and component stack context with the diagnostic", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    window.history.pushState({}, "", "/issues/ORG-1?tab=activity");
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);

    createRoot(container).render(
      <AppErrorBoundary>
        <ThrowingChild />
      </AppErrorBoundary>,
    );

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Copy diagnostic");
    });

    container.querySelector<HTMLButtonElement>("button:last-of-type")?.click();

    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Route: http://localhost:3000/issues/ORG-1?tab=activity"));
    });
    const diagnostic = writeText.mock.calls[0]?.[0] as string;
    expect(diagnostic).toContain("composer exploded");
    expect(diagnostic).toContain("Time:");
    expect(diagnostic).toContain("User agent:");
    expect(diagnostic).toContain("ThrowingChild");
  });
});
