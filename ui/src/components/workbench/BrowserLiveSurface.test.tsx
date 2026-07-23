// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserLiveSurface } from "./BrowserLiveSurface";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("BrowserLiveSurface", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    Reflect.deleteProperty(window, "desktopShell");
  });

  it("routes guest Ctrl+Tab to the current surface owner without recreating the guest", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const onCycleTab = vi.fn();

    act(() => {
      root?.render(
        <BrowserLiveSurface
          active
          canOpenNewTab
          target={{
            kind: "browser",
            label: "Example",
            tabId: "browser-1",
            url: "https://example.com",
            viewInstanceId: "view-1",
          }}
          targetKey="browser-tab:browser-1"
          onOpenTarget={vi.fn()}
          onReplaceTarget={vi.fn()}
          onCloseTarget={vi.fn()}
          onCycleTab={onCycleTab}
          onRegisterShortcutController={vi.fn()}
        />,
      );
    });

    const webview = container.querySelector("webview");
    expect(webview).not.toBeNull();
    const event = new Event("before-input-event", { cancelable: true });
    Object.defineProperty(event, "input", {
      configurable: true,
      value: {
        type: "keyDown",
        key: "Tab",
        code: "Tab",
        control: true,
        shift: true,
      },
    });

    act(() => {
      webview?.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(onCycleTab).toHaveBeenCalledWith(-1);
    expect(container.querySelector("webview")).toBe(webview);
  });

  it("reports the physical guest identity without persisting it into the target", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const onWebContentsIdChange = vi.fn();

    act(() => {
      root?.render(
        <BrowserLiveSurface
          active
          canOpenNewTab
          target={{
            kind: "browser",
            label: "Example",
            tabId: "browser-identity",
            url: "https://example.com",
            viewInstanceId: "view-identity",
          }}
          targetKey="browser-tab:browser-identity"
          onOpenTarget={vi.fn()}
          onReplaceTarget={vi.fn()}
          onCloseTarget={vi.fn()}
          onRegisterShortcutController={vi.fn()}
          onWebContentsIdChange={onWebContentsIdChange}
        />,
      );
    });

    const webview = container.querySelector("webview") as HTMLElement & {
      getWebContentsId?: () => number;
    };
    webview.getWebContentsId = () => 73;
    act(() => {
      webview.dispatchEvent(new Event("dom-ready"));
    });

    expect(onWebContentsIdChange).toHaveBeenCalledWith(73);
  });
});
