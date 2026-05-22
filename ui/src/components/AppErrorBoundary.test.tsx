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
});
