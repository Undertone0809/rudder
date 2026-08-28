// @vitest-environment jsdom

import { PencilLine } from "lucide-react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { EmptyState } from "./EmptyState";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
});

describe("EmptyState", () => {
  it("keeps the full-width surface and allows the helper message to be omitted", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => {
      act(() => root.unmount());
      container.remove();
    };

    act(() => {
      root.render(<EmptyState icon={PencilLine} />);
    });

    const surface = container.querySelector(".surface-panel");
    expect(surface?.className).toContain("w-full");
    expect(surface?.className).toContain("max-w-xl");
    expect(surface?.querySelectorAll("p")).toHaveLength(1);
  });

  it("still renders a provided helper message", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => {
      act(() => root.unmount());
      container.remove();
    };

    act(() => {
      root.render(<EmptyState icon={PencilLine} message="A helper message" />);
    });

    expect(container.textContent).toContain("A helper message");
  });
});
