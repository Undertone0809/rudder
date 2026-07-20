// @vitest-environment jsdom

import { sidePanelTargetKey, type SidePanelTarget } from "@/lib/side-panel-targets";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidePanelProvider, useSidePanel } from "./SidePanelContext";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const issueTarget: SidePanelTarget = {
  kind: "issue",
  issueId: "issue-1",
  ref: "ORZ-13",
  commentId: null,
  label: "ORZ-13 create coding agent",
};

function stubDesktopShell() {
  let closeListener: (() => void) | null = null;
  let browserResetListener: (() => void) | null = null;
  const desktopShell = {
    setSidePanelCloseShortcutActive: vi.fn(async () => undefined),
    onCloseSidePanelActiveTab: vi.fn((listener: () => void) => {
      closeListener = listener;
      return () => {
        closeListener = null;
      };
    }),
    onBrowserReset: vi.fn((listener: () => void) => {
      browserResetListener = listener;
      return () => {
        browserResetListener = null;
      };
    }),
  };
  Object.defineProperty(window, "desktopShell", {
    configurable: true,
    value: desktopShell,
  });
  return {
    desktopShell,
    emitCloseActiveTab: () => closeListener?.(),
    emitBrowserReset: () => browserResetListener?.(),
  };
}

function SidePanelProbe({ onCloseRequest }: { onCloseRequest?: (target: SidePanelTarget) => void }) {
  const sidePanel = useSidePanel();

  useEffect(() => {
    if (!onCloseRequest) return undefined;
    return sidePanel.registerCloseRequestHandler(onCloseRequest);
  }, [onCloseRequest, sidePanel.registerCloseRequestHandler]);

  return (
    <div>
      <button type="button" onClick={() => sidePanel.setContextKey("chat:a")}>Chat A</button>
      <button type="button" onClick={() => sidePanel.setContextKey("chat:b")}>Chat B</button>
      <button type="button" onClick={() => sidePanel.openTarget(issueTarget)}>Open issue</button>
      <button type="button" onClick={() => sidePanel.openTarget({ kind: "browser", url: "https://example.com", label: "Example", tabId: "browser-1" })}>Open browser</button>
      <button type="button" onClick={() => sidePanel.reorderTarget("browser-tab:browser-1", "issue:issue-1:", "before")}>Move browser first</button>
      <button type="button" onClick={() => sidePanel.reorderTarget("browser-tab:browser-1", "issue:issue-1:", "after")}>Move browser last</button>
      <button type="button" onClick={() => {
        for (let index = 1; index <= 9; index += 1) {
          sidePanel.openTarget({
            kind: "browser",
            url: `https://example.com/${index}`,
            label: `Example ${index}`,
            tabId: `browser-${index}`,
          });
        }
      }}>Open many browsers</button>
      <button type="button" onClick={() => sidePanel.openTarget({
        kind: "browser",
        url: "https://example.com/reused-link",
        label: "Reused link",
        tabId: "routed-link",
        dedupeKey: "https://example.com/reused-link",
      })}>Open routed link</button>
      <button type="button" onClick={() => sidePanel.openTargetForContext("chat:a", issueTarget)}>Open issue for A</button>
      <button type="button" onClick={sidePanel.openEmpty}>Open empty</button>
      <button type="button" onClick={sidePanel.hidePanel}>Hide</button>
      <button type="button" onClick={() => sidePanel.activeKey && sidePanel.closeTarget(sidePanel.activeKey)}>Close active</button>
      <span data-testid="context-key">{sidePanel.contextKey}</span>
      <span data-testid="open">{String(sidePanel.open)}</span>
      <span data-testid="active-key">{sidePanel.activeKey ?? ""}</span>
      <span data-testid="tab-count">{String(sidePanel.tabs.length)}</span>
      <span data-testid="tab-keys">{sidePanel.tabs.map(sidePanelTargetKey).join(",")}</span>
      <span data-testid="tab-urls">{sidePanel.tabs.map((target) => target.kind === "browser" ? target.url : "").join(",")}</span>
    </div>
  );
}

function renderSidePanelProvider(onCloseRequest?: (target: SidePanelTarget) => void) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <SidePanelProvider>
        <SidePanelProbe onCloseRequest={onCloseRequest} />
      </SidePanelProvider>,
    );
  });

  return { container, root };
}

function click(container: Element, label: string) {
  act(() => {
    const button = Array.from(container.querySelectorAll("button"))
      .find((candidate) => candidate.textContent === label);
    button?.click();
  });
}

function text(container: Element, testId: string) {
  return container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";
}

describe("SidePanelProvider context visibility", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = null;
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "desktopShell");
  });

  it("restores an open chat side panel after switching away and back", () => {
    ({ container, root } = renderSidePanelProvider());

    click(container, "Chat A");
    click(container, "Open issue");
    expect(text(container, "context-key")).toBe("chat:a");
    expect(text(container, "open")).toBe("true");
    expect(text(container, "active-key")).toBe("issue:issue-1:");
    expect(text(container, "tab-count")).toBe("1");

    click(container, "Chat B");
    expect(text(container, "context-key")).toBe("chat:b");
    expect(text(container, "open")).toBe("false");
    expect(text(container, "active-key")).toBe("");
    expect(text(container, "tab-count")).toBe("0");

    click(container, "Chat A");
    expect(text(container, "context-key")).toBe("chat:a");
    expect(text(container, "open")).toBe("true");
    expect(text(container, "active-key")).toBe("issue:issue-1:");
    expect(text(container, "tab-count")).toBe("1");
  });

  it("preserves hidden tabs without reopening a chat the operator closed", () => {
    ({ container, root } = renderSidePanelProvider());

    click(container, "Chat A");
    click(container, "Open issue");
    click(container, "Hide");
    expect(text(container, "open")).toBe("false");
    expect(text(container, "tab-count")).toBe("1");

    click(container, "Chat B");
    click(container, "Chat A");
    expect(text(container, "context-key")).toBe("chat:a");
    expect(text(container, "active-key")).toBe("issue:issue-1:");
    expect(text(container, "open")).toBe("false");
    expect(text(container, "tab-count")).toBe("1");
  });

  it("reorders tabs inside their context without changing the active tab", () => {
    ({ container, root } = renderSidePanelProvider());

    click(container, "Chat A");
    click(container, "Open issue");
    click(container, "Open browser");
    expect(text(container, "tab-keys")).toBe("issue:issue-1:,browser-tab:browser-1");
    expect(text(container, "active-key")).toBe("browser-tab:browser-1");

    click(container, "Move browser first");
    expect(text(container, "tab-keys")).toBe("browser-tab:browser-1,issue:issue-1:");
    expect(text(container, "active-key")).toBe("browser-tab:browser-1");

    click(container, "Move browser last");
    expect(text(container, "tab-keys")).toBe("issue:issue-1:,browser-tab:browser-1");
    expect(text(container, "active-key")).toBe("browser-tab:browser-1");

    click(container, "Move browser first");

    click(container, "Chat B");
    click(container, "Chat A");
    expect(text(container, "tab-keys")).toBe("browser-tab:browser-1,issue:issue-1:");
  });

  it("closes the Side Panel when its last tab is closed", () => {
    ({ container, root } = renderSidePanelProvider());

    click(container, "Chat A");
    click(container, "Open issue");
    click(container, "Close active");

    expect(text(container, "open")).toBe("false");
    expect(text(container, "active-key")).toBe("");
    expect(text(container, "tab-count")).toBe("0");
  });

  it("preserves the destination chat closed state even when the current chat is open", () => {
    ({ container, root } = renderSidePanelProvider());

    click(container, "Chat A");
    click(container, "Open issue");
    click(container, "Hide");
    expect(text(container, "open")).toBe("false");
    expect(text(container, "tab-count")).toBe("1");

    click(container, "Chat B");
    click(container, "Open issue");
    expect(text(container, "context-key")).toBe("chat:b");
    expect(text(container, "open")).toBe("true");
    expect(text(container, "tab-count")).toBe("1");

    click(container, "Chat A");
    expect(text(container, "context-key")).toBe("chat:a");
    expect(text(container, "open")).toBe("false");
    expect(text(container, "active-key")).toBe("issue:issue-1:");
    expect(text(container, "tab-count")).toBe("1");
  });

  it("opens targets into an explicit chat context even when the provider context is stale", () => {
    ({ container, root } = renderSidePanelProvider());

    click(container, "Chat B");
    click(container, "Open issue for A");
    expect(text(container, "context-key")).toBe("chat:b");
    expect(text(container, "open")).toBe("false");
    expect(text(container, "active-key")).toBe("");
    expect(text(container, "tab-count")).toBe("0");

    click(container, "Chat B");
    expect(text(container, "open")).toBe("false");
    expect(text(container, "active-key")).toBe("");
    expect(text(container, "tab-count")).toBe("0");

    click(container, "Chat A");
    expect(text(container, "open")).toBe("true");
    expect(text(container, "active-key")).toBe("issue:issue-1:");
    expect(text(container, "tab-count")).toBe("1");
  });

  it("only intercepts Command+W when an active tab can be closed", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    ({ container, root } = renderSidePanelProvider());

    click(container, "Chat A");
    click(container, "Open empty");
    expect(text(container, "open")).toBe("true");
    expect(text(container, "active-key")).toBe("");
    const emptyShortcut = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "w", metaKey: true });
    act(() => {
      document.dispatchEvent(emptyShortcut);
    });
    expect(emptyShortcut.defaultPrevented).toBe(false);
    expect(text(container, "open")).toBe("true");

    click(container, "Open issue");
    expect(text(container, "active-key")).toBe("issue:issue-1:");
    const tabShortcut = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "w", metaKey: true });
    act(() => {
      document.dispatchEvent(tabShortcut);
    });
    expect(tabShortcut.defaultPrevented).toBe(true);
    expect(text(container, "open")).toBe("false");
    expect(text(container, "active-key")).toBe("");
    expect(text(container, "tab-count")).toBe("0");
  });

  it("does not intercept the non-platform close-tab modifier", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    ({ container, root } = renderSidePanelProvider());

    click(container, "Chat A");
    click(container, "Open issue");
    const macControlShortcut = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "w", ctrlKey: true });
    act(() => {
      document.dispatchEvent(macControlShortcut);
    });
    expect(macControlShortcut.defaultPrevented).toBe(false);
    expect(text(container, "open")).toBe("true");
    expect(text(container, "tab-count")).toBe("1");

    vi.stubGlobal("navigator", { platform: "Win32" });
    const nonMacMetaShortcut = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "w", metaKey: true });
    act(() => {
      document.dispatchEvent(nonMacMetaShortcut);
    });
    expect(nonMacMetaShortcut.defaultPrevented).toBe(false);
    expect(text(container, "open")).toBe("true");
    expect(text(container, "tab-count")).toBe("1");

    const nonMacControlShortcut = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "w", ctrlKey: true });
    act(() => {
      document.dispatchEvent(nonMacControlShortcut);
    });
    expect(nonMacControlShortcut.defaultPrevented).toBe(true);
    expect(text(container, "open")).toBe("false");
    expect(text(container, "active-key")).toBe("");
    expect(text(container, "tab-count")).toBe("0");
  });

  it("keeps the Desktop close-window accelerator disabled only while an active tab can be closed", async () => {
    const { desktopShell } = stubDesktopShell();
    ({ container, root } = renderSidePanelProvider());

    click(container, "Chat A");
    click(container, "Open empty");
    await act(async () => {
      await Promise.resolve();
    });
    expect(desktopShell.setSidePanelCloseShortcutActive).toHaveBeenLastCalledWith(false);

    click(container, "Open issue");
    await act(async () => {
      await Promise.resolve();
    });
    expect(desktopShell.setSidePanelCloseShortcutActive).toHaveBeenLastCalledWith(true);

    click(container, "Hide");
    await act(async () => {
      await Promise.resolve();
    });
    expect(desktopShell.setSidePanelCloseShortcutActive).toHaveBeenLastCalledWith(false);
  });

  it("closes the active tab when Desktop forwards a protected close-tab shortcut", async () => {
    const { desktopShell, emitCloseActiveTab } = stubDesktopShell();
    ({ container, root } = renderSidePanelProvider());

    click(container, "Chat A");
    click(container, "Open issue");
    await act(async () => {
      await Promise.resolve();
    });

    expect(desktopShell.onCloseSidePanelActiveTab).toHaveBeenCalledTimes(1);
    act(() => {
      emitCloseActiveTab();
    });

    expect(text(container, "open")).toBe("false");
    expect(text(container, "active-key")).toBe("");
    expect(text(container, "tab-count")).toBe("0");
  });

  it("routes Desktop close requests through the registered target lifecycle handler", async () => {
    const { emitCloseActiveTab } = stubDesktopShell();
    const closeRequest = vi.fn();
    ({ container, root } = renderSidePanelProvider(closeRequest));

    click(container, "Chat A");
    click(container, "Open issue");
    await act(async () => {
      await Promise.resolve();
    });

    act(() => emitCloseActiveTab());

    expect(closeRequest).toHaveBeenCalledWith(issueTarget);
    expect(text(container, "tab-count")).toBe("1");
  });

  it("removes Browser tabs from every context after disable or clear without removing other tabs", async () => {
    const { emitBrowserReset } = stubDesktopShell();
    ({ container, root } = renderSidePanelProvider());

    click(container, "Chat A");
    click(container, "Open issue");
    click(container, "Open browser");
    expect(text(container, "tab-count")).toBe("2");

    click(container, "Chat B");
    click(container, "Open browser");
    expect(text(container, "tab-count")).toBe("1");

    act(() => emitBrowserReset());
    expect(text(container, "tab-count")).toBe("0");
    expect(text(container, "active-key")).toBe("");

    click(container, "Chat A");
    expect(text(container, "tab-count")).toBe("1");
    expect(text(container, "active-key")).toBe("issue:issue-1:");
  });

  it("bounds Browser tabs in one context without replacing existing Browser tabs", () => {
    ({ container, root } = renderSidePanelProvider());

    click(container, "Open many browsers");

    expect(text(container, "tab-count")).toBe("8");
    expect(text(container, "active-key")).toBe("browser-tab:browser-8");
    expect(text(container, "tab-keys")).toContain("browser-tab:browser-1");
    expect(text(container, "tab-keys")).not.toContain("browser-tab:browser-9");
  });

  it("reuses the active Browser tab for an ordinary routed link at capacity", () => {
    ({ container, root } = renderSidePanelProvider());

    click(container, "Open many browsers");
    click(container, "Open routed link");

    expect(text(container, "tab-count")).toBe("8");
    expect(text(container, "active-key")).toBe("browser-tab:browser-8");
    expect(text(container, "tab-urls")).toContain("https://example.com/reused-link");
    expect(text(container, "tab-urls")).not.toContain("https://example.com/8,");
  });

  it("keeps the empty picker active when Browser reset removes background tabs", () => {
    const { emitBrowserReset } = stubDesktopShell();
    ({ container, root } = renderSidePanelProvider());

    click(container, "Open issue");
    click(container, "Open browser");
    click(container, "Open empty");
    expect(text(container, "active-key")).toBe("");
    act(() => emitBrowserReset());

    expect(text(container, "active-key")).toBe("");
    expect(text(container, "tab-count")).toBe("1");
    expect(text(container, "tab-keys")).toBe("issue:issue-1:");
  });
});
