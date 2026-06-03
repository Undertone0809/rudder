// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./AppErrorBoundary";

function ThrowingChild() {
  throw new Error("composer exploded");
  return <div />;
}

describe("AppErrorBoundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
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
