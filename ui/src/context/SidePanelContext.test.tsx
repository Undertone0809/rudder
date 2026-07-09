// @vitest-environment jsdom

import type { SidePanelTarget } from "@/lib/side-panel-targets";
import { act } from "react";
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
  const desktopShell = {
    setSidePanelCloseShortcutActive: vi.fn(async () => undefined),
    onCloseSidePanelActiveTab: vi.fn((listener: () => void) => {
      closeListener = listener;
      return () => {
        closeListener = null;
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
  };
}

function SidePanelProbe() {
  const sidePanel = useSidePanel();

  return (
    <div>
      <button type="button" onClick={() => sidePanel.setContextKey("chat:a")}>Chat A</button>
      <button type="button" onClick={() => sidePanel.setContextKey("chat:b")}>Chat B</button>
      <button type="button" onClick={() => sidePanel.openTarget(issueTarget)}>Open issue</button>
      <button type="button" onClick={() => sidePanel.openTargetForContext("chat:a", issueTarget)}>Open issue for A</button>
      <button type="button" onClick={sidePanel.openEmpty}>Open empty</button>
      <button type="button" onClick={sidePanel.hidePanel}>Hide</button>
      <span data-testid="context-key">{sidePanel.contextKey}</span>
      <span data-testid="open">{String(sidePanel.open)}</span>
      <span data-testid="active-key">{sidePanel.activeKey ?? ""}</span>
      <span data-testid="tab-count">{String(sidePanel.tabs.length)}</span>
    </div>
  );
}

function renderSidePanelProvider() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <SidePanelProvider>
        <SidePanelProbe />
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
    expect(text(container, "open")).toBe("true");
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
    expect(text(container, "open")).toBe("true");
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

    expect(text(container, "open")).toBe("true");
    expect(text(container, "active-key")).toBe("");
    expect(text(container, "tab-count")).toBe("0");
  });
});
