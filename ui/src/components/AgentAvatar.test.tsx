// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentIdentity } from "./AgentAvatar";

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

describe("AgentIdentity", () => {
  it("renders uploaded avatar assets as images", () => {
    const container = render(
      <AgentIdentity
        name="Alice Smith"
        icon="asset:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa?bg=peach"
        size="sm"
      />,
    );

    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/api/assets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/content");
    expect(img?.getAttribute("style")).toContain("background:");
    expect(container.textContent).toContain("Alice Smith");
  });

  it("renders DiceBear Notionists avatar references as images", () => {
    const container = render(
      <AgentIdentity
        name="Alice Smith"
        icon="dicebear:notionists:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb?bg=violet"
        size="sm"
      />,
    );

    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(container.textContent).toContain("Alice Smith");
  });

  it("renders a role avatar instead of fallback initials when no custom icon is set", () => {
    const container = render(<AgentIdentity name="Penelope (CEO)" role="ceo" size="sm" />);

    const fallback = container.querySelector('[data-slot="avatar-fallback"]');
    expect(fallback?.textContent).toBe("");
    expect(fallback?.querySelector("svg")).toBeTruthy();
  });
});
