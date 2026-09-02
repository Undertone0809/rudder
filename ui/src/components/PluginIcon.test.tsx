// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { PluginIcon, themedPluginIconUrl } from "./PluginIcon";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  document.body.replaceChildren();
});

function render(element: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  cleanupFn = () => act(() => root.unmount());
  act(() => root.render(element));
  return { container, root };
}

describe("PluginIcon", () => {
  it("adds the selected theme only to catalog icon URLs", () => {
    expect(themedPluginIconUrl("/api/plugins/catalog/canva/icon", "dark")).toBe(
      "/api/plugins/catalog/canva/icon?theme=dark",
    );
    expect(themedPluginIconUrl("/api/plugins/catalog/canva/icon?size=small", "light")).toBe(
      "/api/plugins/catalog/canva/icon?size=small&theme=light",
    );
    expect(themedPluginIconUrl("data:image/png;base64,icon", "dark")).toBe("data:image/png;base64,icon");
  });

  it("falls back after an image error and retries when the source changes", () => {
    const { container, root } = render(
      <PluginIcon
        src="/api/plugins/catalog/canva/icon?theme=light"
        testId="plugin-icon"
        fallbackClassName="fallback"
      />,
    );

    expect(container.querySelector("img[data-testid='plugin-icon']")?.getAttribute("src")).toContain("canva");
    act(() => container.querySelector("img")?.dispatchEvent(new Event("error")));
    expect(container.querySelector("img[data-testid='plugin-icon']")).toBeNull();
    expect(container.querySelector("svg.fallback")).not.toBeNull();

    act(() => root.render(<PluginIcon src="/api/plugins/catalog/vercel/icon?theme=light" testId="plugin-icon" />));
    expect(container.querySelector("img[data-testid='plugin-icon']")?.getAttribute("src")).toContain("vercel");
  });
});
