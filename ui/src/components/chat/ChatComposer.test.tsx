// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatComposerContextMenu } from "./ChatComposer";

vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: () => null,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ChatComposerContextMenu", () => {
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    host?.remove();
    host = null;
  });

  it("keeps the scrollbar hidden until the menu is scrolled", () => {
    host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        <ChatComposerContextMenu position={{ maxHeight: 120 }}>
          <div>Menu content</div>
        </ChatComposerContextMenu>,
      );
    });

    const menu = host.querySelector<HTMLElement>('[role="menu"]');
    expect(menu?.className).toContain("scrollbar-auto-hide");
    expect(menu?.classList.contains("is-scrolling")).toBe(false);

    act(() => {
      menu?.dispatchEvent(new Event("scroll"));
    });

    expect(menu?.classList.contains("is-scrolling")).toBe(true);
    act(() => root.unmount());
  });
});
