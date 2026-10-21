// @vitest-environment jsdom

import { Button } from "@/components/ui/button";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatComposerContextMenu,
  ChatComposerSendButton,
  ChatComposerToolbar,
  type ChatComposerSendMode,
} from "./ChatComposer";

vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: () => null,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ChatComposerContextMenu", () => {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
  });

  it("keeps the scrollbar hidden until the menu is scrolled", () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    act(() => {
      root?.render(
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
  });
});

describe("ChatComposerToolbar primary action", () => {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
  });

  function renderToolbar(input: {
    mode: ChatComposerSendMode;
    disabled: boolean;
    onClick: () => void;
    onStopClick?: () => void;
    attachmentName?: string;
    stoppingComplete?: boolean;
  }) {
    if (!host) {
      host = document.createElement("div");
      document.body.append(host);
      root = createRoot(host);
    }
    act(() => {
      root?.render(
        <ChatComposerToolbar
          actions={(
            <>
              {input.mode === "queue" || input.onStopClick ? (
                <Button type="button" aria-label="Stop streaming" onClick={input.onStopClick ?? vi.fn()}>
                  Stop
                </Button>
              ) : null}
              <ChatComposerSendButton
                mode={input.mode}
                disabled={input.disabled}
                stoppingComplete={input.stoppingComplete}
                onClick={input.onClick}
              />
            </>
          )}
        >
          {input.attachmentName ? <span>{input.attachmentName}</span> : null}
        </ChatComposerToolbar>,
      );
    });
    return host;
  }

  it("uses one Send action for a queueable draft during an active run", () => {
    const queueDraft = vi.fn();
    const stopRun = vi.fn();
    const toolbar = renderToolbar({
      mode: "queue",
      disabled: false,
      onClick: queueDraft,
      onStopClick: stopRun,
    });
    const buttons = toolbar.querySelectorAll("button");

    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute("aria-label")).toBe("Send");
    act(() => buttons[0]?.click());
    expect(queueDraft).toHaveBeenCalledOnce();
    expect(stopRun).not.toHaveBeenCalled();
  });

  it("returns to one Stop action when the busy draft is cleared", () => {
    const stopRun = vi.fn();
    const toolbar = renderToolbar({ mode: "queue", disabled: false, onClick: vi.fn() });
    expect(toolbar.querySelectorAll("button")).toHaveLength(1);

    renderToolbar({ mode: "stop", disabled: false, onClick: stopRun });
    const buttons = toolbar.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute("aria-label")).toBe("Stop streaming");
    act(() => buttons[0]?.click());
    expect(stopRun).toHaveBeenCalledOnce();
  });

  it("keeps a pending stop as one disabled Stopping action", () => {
    const onClick = vi.fn();
    const toolbar = renderToolbar({ mode: "stopping", disabled: true, onClick });
    const buttons = toolbar.querySelectorAll("button");

    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute("aria-label")).toBe("Stopping response");
    expect(buttons[0]?.disabled).toBe(true);
    act(() => buttons[0]?.click());
    expect(onClick).not.toHaveBeenCalled();
  });

  it("keeps an idle empty composer as a disabled Send action", () => {
    const onClick = vi.fn();
    const toolbar = renderToolbar({ mode: "send", disabled: true, onClick });
    const buttons = toolbar.querySelectorAll("button");

    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute("aria-label")).toBe("Send");
    expect(buttons[0]?.disabled).toBe(true);
  });

  it("keeps only Stop when a queue submit is disabled but a run can still be stopped", () => {
    const stopRun = vi.fn();
    const toolbar = renderToolbar({
      mode: "queue",
      disabled: true,
      onClick: vi.fn(),
      onStopClick: stopRun,
    });
    const buttons = toolbar.querySelectorAll("button");

    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute("aria-label")).toBe("Stop streaming");
    act(() => buttons[0]?.click());
    expect(stopRun).toHaveBeenCalledOnce();
  });

  it("uses only Stop when a server-owned run is active and the draft is empty", () => {
    const stopRun = vi.fn();
    const toolbar = renderToolbar({
      mode: "send",
      disabled: true,
      onClick: vi.fn(),
      onStopClick: stopRun,
    });
    expect(toolbar.querySelectorAll("button")).toHaveLength(1);
    expect(toolbar.querySelector("button")?.getAttribute("aria-label")).toBe("Stop streaming");
    act(() => toolbar.querySelector("button")?.click());
    expect(stopRun).toHaveBeenCalledOnce();
  });

  it("retains Stop for a regular-file draft during a server-owned run and allows normal idle Send", () => {
    const stopRun = vi.fn();
    const activeToolbar = renderToolbar({
      mode: "send",
      disabled: true,
      onClick: vi.fn(),
      onStopClick: stopRun,
      attachmentName: "report.pdf",
    });
    expect(activeToolbar.textContent).toContain("report.pdf");
    expect(activeToolbar.querySelectorAll("button")).toHaveLength(1);
    expect(activeToolbar.querySelector("button")?.getAttribute("aria-label")).toBe("Stop streaming");

    const sendMessage = vi.fn();
    const idleToolbar = renderToolbar({
      mode: "send",
      disabled: false,
      onClick: sendMessage,
      attachmentName: "report.pdf",
    });
    expect(idleToolbar.querySelectorAll("button")).toHaveLength(1);
    expect(idleToolbar.querySelector("button")?.getAttribute("aria-label")).toBe("Send");
    act(() => idleToolbar.querySelector("button")?.click());
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(stopRun).not.toHaveBeenCalled();
  });
});
