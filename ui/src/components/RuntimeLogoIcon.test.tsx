// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeLogoIcon } from "./RuntimeLogoIcon";
import { ADAPTER_DISPLAY_LIST } from "./AgentConfigForm.advanced";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  document.body.innerHTML = "";
});

function render(element: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  cleanupFn = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };
  act(() => {
    root.render(element);
  });
  return container;
}

describe("RuntimeLogoIcon", () => {
  it("renders logos for every enabled local runtime shown in the adapter menu", () => {
    const enabledLocalRuntimeTypes = [
      "claude_local",
      "codex_local",
      "gemini_local",
      "opencode_local",
      "pi_local",
      "cursor",
    ];

    for (const runtimeType of enabledLocalRuntimeTypes) {
      const container = render(<RuntimeLogoIcon runtimeType={runtimeType} />);
      expect(container.querySelector("svg,img")).toBeTruthy();
      cleanupFn?.();
      cleanupFn = null;
      document.body.innerHTML = "";
    }
  });

  it("uses a display label for pi_local instead of the raw key", () => {
    expect(ADAPTER_DISPLAY_LIST.find((item) => item.value === "pi_local")?.label).toBe("Pi (local)");
  });
});
