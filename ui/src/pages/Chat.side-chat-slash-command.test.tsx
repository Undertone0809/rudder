// @vitest-environment jsdom

import { act, createElement, useRef, useState, type CSSProperties } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSideChatSlashCommandMenu } from "./Chat.side-chat-slash-command";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Chat Side Chat slash command menu", () => {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.querySelector('[data-testid="chat-slash-command-menu"]')?.remove();
  });

  it("shows an enabled Side Chat command only when the slash menu is available", async () => {
    const onActivate = vi.fn();
    const getMenuPosition = () => ({ top: 20, left: 40 });
    function Harness({ visible, hasAnchor }: { visible: boolean; hasAnchor: boolean }) {
      const composerSurfaceRef = useRef<HTMLDivElement>(null);
      const [position, setPosition] = useState<CSSProperties | null>({ top: 20, left: 40 });
      return createElement(
        "div",
        null,
        createElement("div", { ref: composerSurfaceRef }),
        createElement(ChatSideChatSlashCommandMenu, {
          visible,
          hasAnchor,
          position,
          setPosition,
          composerSurfaceRef,
          getMenuPosition,
          onActivate,
        }),
      );
    }

    await act(async () => root?.render(createElement(Harness, { visible: true, hasAnchor: false })));
    const disabledAction = document.body.querySelector<HTMLButtonElement>('[data-testid="chat-slash-side-chat"]');
    expect(disabledAction?.disabled).toBe(true);
    expect(disabledAction?.textContent).toContain("Wait for an assistant answer first");

    await act(async () => root?.render(createElement(Harness, { visible: true, hasAnchor: true })));
    const enabledAction = document.body.querySelector<HTMLButtonElement>('[data-testid="chat-slash-side-chat"]');
    expect(enabledAction?.disabled).toBe(false);
    await act(async () => enabledAction?.click());
    expect(onActivate).toHaveBeenCalledTimes(1);

    await act(async () => root?.render(createElement(Harness, { visible: false, hasAnchor: true })));
    expect(document.body.querySelector('[data-testid="chat-slash-command-menu"]')).toBeNull();
  });
});
