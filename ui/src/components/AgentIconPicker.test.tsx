// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentIcon, getAgentAvatarImageSrc } from "./AgentIconPicker";

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

describe("AgentIcon", () => {
  it("renders uploaded avatar asset references as images", () => {
    const icon = "asset:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const container = render(<AgentIcon icon={icon} className="h-4 w-4" />);

    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    expect(img?.getAttribute("src")).toBe("/api/assets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/content");
    expect(getAgentAvatarImageSrc(icon)).toBe("/api/assets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/content");
  });

  it("renders custom emoji values as text", () => {
    const container = render(<AgentIcon icon="🧪" />);

    expect(container.textContent).toBe("🧪");
    expect(container.querySelector("img")).toBeNull();
  });
});
