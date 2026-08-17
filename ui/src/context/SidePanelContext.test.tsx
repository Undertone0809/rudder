// @vitest-environment jsdom

import { savedViewKeepInputFromSidePanelTarget } from "@/lib/messenger-saved-views";
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
  let openEmptyListener: (() => void) | null = null;
  let browserResetListener: (() => void) | null = null;
  const desktopShell = {
    setSidePanelCloseShortcutActive: vi.fn(async () => undefined),
    onCloseSidePanelActiveTab: vi.fn((listener: () => void) => {
      closeListener = listener;
      return () => {
        closeListener = null;
      };
    }),
    onOpenEmptySidePanel: vi.fn((listener: () => void) => {
      openEmptyListener = listener;
      return () => {
        openEmptyListener = null;
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
    emitOpenEmpty: () => openEmptyListener?.(),
    emitBrowserReset: () => browserResetListener?.(),
  };
}

let sidePanelControls: ReturnType<typeof useSidePanel> | null = null;

function SidePanelProbe({ onCloseRequest }: { onCloseRequest?: (target: SidePanelTarget) => void }) {
  const sidePanel = useSidePanel();
  sidePanelControls = sidePanel;

  useEffect(() => {
    if (!onCloseRequest) return undefined;
    return sidePanel.registerCloseRequestHandler(onCloseRequest);
  }, [onCloseRequest, sidePanel.registerCloseRequestHandler]);

  return (
    <div>
      <button type="button" onClick={() => sidePanel.setContextKey("chat:a")}>Chat A</button>
      <button type="button" onClick={() => sidePanel.setContextKey("chat:b")}>Chat B</button>
      <button type="button" onClick={() => sidePanel.openTarget(issueTarget)}>Open issue</button>
      <button type="button" onClick={() => sidePanel.openTarget({
        kind: "goal_chat",
        organizationId: "org-a",
        goalId: "goal-1",
        agentId: "agent-1",
        conversationId: null,
        clientMutationId: "goal-chat-mutation-1",
        body: "",
        label: "Ship Goal v2",
      })}>Open Goal Chat</button>
      <button type="button" onClick={() => sidePanel.openTarget({ kind: "library_file", filePath: "docs/spec.md", label: "Spec" })}>Open file</button>
      <button type="button" onClick={() => sidePanel.openTargetInNewTab({ kind: "library_file", filePath: "docs/spec.md", label: "Spec copy" })}>Open file in new tab</button>
      <button type="button" onClick={() => sidePanel.openTarget({
        kind: "local_app",
        desktopInstallationId: "desktop/a",
        appPublicId: "app:a",
        localBindingId: "binding-a",
        label: "Dashboard",
      })}>Open local app</button>
      <button type="button" onClick={() => sidePanel.openTargetInNewTab({
        kind: "local_app",
        desktopInstallationId: "desktop/a",
        appPublicId: "app:a",
        localBindingId: "binding-a",
        label: "Dashboard copy",
      })}>Open local app in new tab</button>
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
      <button type="button" onClick={() => sidePanel.holdDisplayedContext("org-a", "chat:a")}>Hold chat A</button>
      <button type="button" onClick={sidePanel.clearDisplayedContextHold}>Clear hold</button>
      <button type="button" onClick={sidePanel.openEmpty}>Open empty</button>
      <button type="button" onClick={sidePanel.hidePanel}>Hide</button>
      <button type="button" onClick={() => sidePanel.activeKey && sidePanel.closeTarget(sidePanel.activeKey)}>Close active</button>
      <span data-testid="context-key">{sidePanel.contextKey}</span>
      <span data-testid="open">{String(sidePanel.open)}</span>
      <span data-testid="active-key">{sidePanel.activeKey ?? ""}</span>
      <span data-testid="tab-count">{String(sidePanel.tabs.length)}</span>
      <span data-testid="tab-keys">{sidePanel.tabs.map(sidePanelTargetKey).join(",")}</span>
      <span data-testid="tab-urls">{sidePanel.tabs.map((target) => target.kind === "browser" ? target.url : "").join(",")}</span>
      <span data-testid="view-instance-ids">{sidePanel.tabs.map((target) => "viewInstanceId" in target ? target.viewInstanceId ?? "" : "").join(",")}</span>
      <span data-testid="held-context">{sidePanel.displayedContextHold ? `${sidePanel.displayedContextHold.organizationId}:${sidePanel.displayedContextHold.contextKey}` : ""}</span>
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
    sidePanelControls = null;
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "desktopShell");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    window.history.replaceState({}, "", "/");
  });

  it("keeps Goal Chat in the mobile overlay and routes full-page targets", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    window.history.replaceState({}, "", "/rudder-studio/goals/goal-1");
    ({ container, root } = renderSidePanelProvider());

    click(container, "Open Goal Chat");

    expect(window.location.pathname).toBe("/rudder-studio/goals/goal-1");
    expect(text(container, "open")).toBe("true");
    expect(text(container, "active-key")).toBe("goal-chat:org-a:goal-1");
    expect(text(container, "tab-count")).toBe("1");

    click(container, "Open issue");

    expect(window.location.pathname).toBe("/rudder-studio/issues/issue-1");
    expect(text(container, "open")).toBe("true");
    expect(text(container, "active-key")).toBe("goal-chat:org-a:goal-1");
    expect(text(container, "tab-count")).toBe("1");
  });

  it("routes Issue links away from the mobile Side Panel", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    window.history.replaceState({}, "", "/rudder-studio/issues/source-1");
    ({ container, root } = renderSidePanelProvider());

    click(container, "Open issue");

    expect(window.location.pathname).toBe("/rudder-studio/issues/issue-1");
    expect(text(container, "tab-count")).toBe("0");
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

  it("closes the active tab, focuses its sibling, and keeps the Side Panel open", () => {
    ({ container, root } = renderSidePanelProvider());

    click(container, "Chat A");
    click(container, "Open issue");
    click(container, "Open file");
    expect(text(container, "open")).toBe("true");
    expect(text(container, "active-key")).toMatch(/^library-file:docs\/spec\.md:/);
    expect(text(container, "tab-count")).toBe("2");

    click(container, "Close active");

    expect(text(container, "open")).toBe("true");
    expect(text(container, "active-key")).toBe("issue:issue-1:");
    expect(text(container, "tab-count")).toBe("1");
    expect(text(container, "tab-keys")).toBe("issue:issue-1:");
  });

  it("detaches the exact active middle tab and selects its right neighbor without requesting close", () => {
    const closeRequest = vi.fn();
    ({ container, root } = renderSidePanelProvider(closeRequest));
    act(() => sidePanelControls!.setContextKey("chat:a"));
    for (const tabId of ["a", "b", "c"]) {
      act(() => sidePanelControls!.openTarget({
        kind: "browser",
        url: `https://example.com/${tabId}`,
        label: tabId.toUpperCase(),
        tabId,
      }));
    }
    act(() => sidePanelControls!.setActiveKey("browser-tab:b"));
    const revision = sidePanelControls!.getTargetRevisionForContext("chat:a", "browser-tab:b");
    expect(revision).not.toBeNull();

    let result: unknown;
    act(() => {
      result = sidePanelControls!.detachTargetForContext("chat:a", "browser-tab:b", revision!);
    });

    expect(result).toMatchObject({
      detached: true,
      target: { kind: "browser", tabId: "b" },
    });
    expect(sidePanelControls!.tabs.map(sidePanelTargetKey)).toEqual([
      "browser-tab:a",
      "browser-tab:c",
    ]);
    expect(sidePanelControls!.activeKey).toBe("browser-tab:c");
    expect(sidePanelControls!.open).toBe(true);
    expect(closeRequest).not.toHaveBeenCalled();
  });

  it("rejects a stale exact detach after that target was replaced", () => {
    ({ container, root } = renderSidePanelProvider());
    act(() => sidePanelControls!.setContextKey("chat:a"));
    act(() => sidePanelControls!.openTarget({
      kind: "browser",
      url: "https://example.com/original",
      label: "Original",
      tabId: "browser-a",
    }));
    const key = "browser-tab:browser-a";
    const revision = sidePanelControls!.getTargetRevisionForContext("chat:a", key);
    expect(revision).not.toBeNull();
    act(() => sidePanelControls!.replaceTargetForContext("chat:a", key, {
      kind: "browser",
      url: "https://example.com/changed",
      label: "Changed",
      tabId: "browser-a",
    }));

    let result: unknown;
    act(() => {
      result = sidePanelControls!.detachTargetForContext("chat:a", key, revision!);
    });

    expect(result).toEqual({
      detached: false,
      reason: "revision_mismatch",
      revision: (revision ?? 0) + 1,
    });
    expect(sidePanelControls!.tabs).toHaveLength(1);
    expect(sidePanelControls!.tabs[0]).toMatchObject({
      kind: "browser",
      url: "https://example.com/changed",
    });
  });

  it("rejects an exact detach when the caller did not capture a revision", () => {
    ({ container, root } = renderSidePanelProvider());
    act(() => sidePanelControls!.setContextKey("chat:a"));
    act(() => sidePanelControls!.openTarget({
      kind: "browser",
      url: "https://example.com/revision-required",
      label: "Revision required",
      tabId: "browser-revision-required",
    }));
    const key = "browser-tab:browser-revision-required";
    const detachWithoutRevision = sidePanelControls!.detachTargetForContext as (
      contextKey: string,
      exactKey: string,
    ) => unknown;

    let result: unknown;
    act(() => {
      result = detachWithoutRevision("chat:a", key);
    });

    expect(result).toEqual({
      detached: false,
      reason: "revision_mismatch",
      revision: 0,
    });
    expect(sidePanelControls!.tabs).toHaveLength(1);
  });

  it("does not let an old revision detach a later tab that reused the same exact key", () => {
    ({ container, root } = renderSidePanelProvider());
    const target: SidePanelTarget = {
      kind: "browser",
      url: "https://example.com/reused",
      label: "Reused",
      tabId: "browser-reused",
    };
    const key = "browser-tab:browser-reused";
    act(() => sidePanelControls!.setContextKey("chat:a"));
    act(() => sidePanelControls!.openTarget(target));
    const firstRevision = sidePanelControls!.getTargetRevisionForContext("chat:a", key);
    expect(firstRevision).not.toBeNull();
    act(() => {
      sidePanelControls!.detachTargetForContext("chat:a", key, firstRevision!);
      sidePanelControls!.openTargetForContext("chat:a", target);
    });

    let staleResult: unknown;
    act(() => {
      staleResult = sidePanelControls!.detachTargetForContext("chat:a", key, firstRevision!);
    });

    expect(staleResult).toEqual({
      detached: false,
      reason: "revision_mismatch",
      revision: (firstRevision ?? 0) + 1,
    });
    expect(sidePanelControls!.tabs).toHaveLength(1);
  });

  it("detaches a non-current context without changing the displayed context", () => {
    ({ container, root } = renderSidePanelProvider());
    act(() => sidePanelControls!.setContextKey("chat:a"));
    act(() => sidePanelControls!.openTarget({
      kind: "browser",
      url: "https://example.com/a",
      label: "A",
      tabId: "a",
    }));
    const revision = sidePanelControls!.getTargetRevisionForContext("chat:a", "browser-tab:a");
    expect(revision).not.toBeNull();
    act(() => sidePanelControls!.setContextKey("chat:b"));
    act(() => sidePanelControls!.openTarget(issueTarget));

    act(() => {
      sidePanelControls!.detachTargetForContext("chat:a", "browser-tab:a", revision!);
    });

    expect(sidePanelControls!.contextKey).toBe("chat:b");
    expect(sidePanelControls!.open).toBe(true);
    expect(sidePanelControls!.activeKey).toBe("issue:issue-1:");
    expect(sidePanelControls!.tabs.map(sidePanelTargetKey)).toEqual(["issue:issue-1:"]);

    act(() => sidePanelControls!.setContextKey("chat:a"));
    expect(sidePanelControls!.open).toBe(false);
    expect(sidePanelControls!.tabs).toHaveLength(0);
  });

  it("holds a displayed source context until explicit hide or clear", () => {
    ({ container, root } = renderSidePanelProvider());

    click(container, "Chat A");
    click(container, "Open issue");
    click(container, "Hold chat A");
    expect(text(container, "held-context")).toBe("org-a:chat:a");

    click(container, "Hide");
    expect(text(container, "held-context")).toBe("");

    click(container, "Hold chat A");
    click(container, "Clear hold");
    expect(text(container, "held-context")).toBe("");
  });

  it("focuses a canonical file normally but creates a distinct explicit instance", () => {
    ({ container, root } = renderSidePanelProvider());

    click(container, "Open file");
    const firstInstance = text(container, "view-instance-ids");
    expect(firstInstance).toBeTruthy();

    click(container, "Open file");
    expect(text(container, "tab-count")).toBe("1");
    expect(text(container, "view-instance-ids")).toBe(firstInstance);

    click(container, "Open file in new tab");
    const instances = text(container, "view-instance-ids").split(",");
    expect(text(container, "tab-count")).toBe("2");
    expect(new Set(instances).size).toBe(2);
  });

  it("shares one Local App identity across distinct view instances without stopping it on close", () => {
    const stop = vi.fn(async () => undefined);
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: { localApps: { supported: true, stop } },
    });
    ({ container, root } = renderSidePanelProvider());

    click(container, "Open local app");
    const firstInstance = text(container, "view-instance-ids");
    expect(firstInstance).toBeTruthy();

    click(container, "Open local app");
    expect(text(container, "tab-count")).toBe("1");
    expect(text(container, "view-instance-ids")).toBe(firstInstance);

    click(container, "Open local app in new tab");
    const instances = text(container, "view-instance-ids").split(",");
    expect(text(container, "tab-count")).toBe("2");
    expect(new Set(instances).size).toBe(2);

    click(container, "Close active");
    expect(text(container, "tab-count")).toBe("1");
    expect(stop).not.toHaveBeenCalled();
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

  it("does not steal Command+W or the Desktop accelerator from a Main runtime", async () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    const { desktopShell } = stubDesktopShell();
    ({ container, root } = renderSidePanelProvider());
    click(container, "Chat A");
    click(container, "Open issue");

    const mainHost = document.createElement("div");
    mainHost.dataset.testid = "live-surface-runtime-host";
    mainHost.dataset.ownerId = "main:org-a:view-a";
    const mainInput = document.createElement("input");
    mainHost.appendChild(mainInput);
    document.body.appendChild(mainHost);
    await act(async () => {
      mainInput.focus();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(desktopShell.setSidePanelCloseShortcutActive)
      .toHaveBeenLastCalledWith(false);

    const shortcut = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "w",
      metaKey: true,
    });
    act(() => mainInput.dispatchEvent(shortcut));

    expect(shortcut.defaultPrevented).toBe(false);
    expect(text(container, "open")).toBe("true");
    expect(text(container, "tab-count")).toBe("1");
    mainHost.remove();
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

  it("opens an empty picker from Desktop without discarding existing tabs", async () => {
    const { desktopShell, emitOpenEmpty } = stubDesktopShell();
    ({ container, root } = renderSidePanelProvider());
    click(container, "Chat A");
    click(container, "Open issue");
    click(container, "Hide");
    await act(async () => {
      await Promise.resolve();
    });

    expect(desktopShell.onOpenEmptySidePanel).toHaveBeenCalled();
    act(() => emitOpenEmpty());
    expect(text(container, "open")).toBe("true");
    expect(text(container, "active-key")).toBe("");
    expect(text(container, "tab-count")).toBe("1");

    act(() => emitOpenEmpty());
    expect(text(container, "tab-count")).toBe("1");
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

  it("shares the Side Browser limit across retained Chat and Issue contexts", () => {
    ({ container, root } = renderSidePanelProvider());

    act(() => {
      for (let index = 1; index <= 8; index += 1) {
        const contextKey = index <= 4 ? "chat:a" : "issue:b";
        expect(sidePanelControls?.openTargetForContext(contextKey, {
          kind: "browser",
          label: `Browser ${index}`,
          tabId: `browser-${index}`,
          url: `https://example.com/${index}`,
        })).toEqual({ admitted: true });
      }
    });

    let overflow: ReturnType<NonNullable<typeof sidePanelControls>["openTargetForContext"]>
      | undefined;
    act(() => {
      overflow = sidePanelControls?.openTargetForContext("chat:c", {
        kind: "browser",
        label: "Browser 9",
        tabId: "browser-9",
        url: "https://example.com/9",
      });
    });
    expect(overflow).toEqual({ admitted: false, reason: "browser_capacity" });
    act(() => sidePanelControls?.setContextKey("chat:c"));
    expect(text(container, "tab-count")).toBe("0");
  });

  it("rejects an unrelated ordinary routed link at capacity without reusing an exact tab", () => {
    ({ container, root } = renderSidePanelProvider());

    click(container, "Open many browsers");
    click(container, "Open routed link");

    expect(text(container, "tab-count")).toBe("8");
    expect(text(container, "active-key")).toBe("browser-tab:browser-8");
    expect(text(container, "tab-urls")).not.toContain("https://example.com/reused-link");
    expect(text(container, "tab-urls")).toContain("https://example.com/8");
  });

  it("preserves one Browser logical identity and Saved recovery when a routed link dedupes", () => {
    ({ container, root } = renderSidePanelProvider());
    const restoredTarget: Extract<SidePanelTarget, { kind: "browser" }> = {
      kind: "browser",
      url: "https://example.com/report",
      label: "Saved report",
      tabId: "physical-a",
      dedupeKey: "https://example.com/report",
      viewInstanceId: "instance-a",
      savedViewRecovery: {
        id: "saved-a",
        persistedMetadata: {
          target: {
            kind: "browser",
            tabId: "physical-a",
            url: "https://example.com/report",
            viewInstanceId: "instance-a",
          },
          title: "Saved report",
          subtitle: "https://example.com/report",
          favicon: null,
        },
      },
    };
    act(() => sidePanelControls!.openTarget(restoredTarget));
    act(() => sidePanelControls!.openTarget({
      kind: "browser",
      url: "https://example.com/report",
      label: "Report reopened",
      tabId: "physical-b",
      dedupeKey: "https://example.com/report",
    }));

    expect(sidePanelControls!.tabs).toHaveLength(1);
    expect(sidePanelControls!.tabs[0]).toMatchObject({
      kind: "browser",
      tabId: "physical-a",
      viewInstanceId: "instance-a",
      label: "Report reopened",
      savedViewRecovery: { id: "saved-a" },
    });
    expect(savedViewKeepInputFromSidePanelTarget(sidePanelControls!.tabs[0]!, {
      clientMutationId: "retry-after-navigation",
      placement: { kind: "group", groupId: "group-a" },
    })?.target).toMatchObject({
      kind: "browser",
      tabId: "physical-a",
      viewInstanceId: "instance-a",
    });
  });

  it("keeps the active Saved Browser unchanged when an unrelated routed link is rejected at capacity", () => {
    ({ container, root } = renderSidePanelProvider());
    for (let index = 1; index <= 7; index += 1) {
      act(() => sidePanelControls!.openTarget({
        kind: "browser",
        url: `https://example.com/${index}`,
        label: `Example ${index}`,
        tabId: `physical-${index}`,
      }));
    }
    act(() => sidePanelControls!.openTarget({
      kind: "browser",
      url: "https://saved.example/old",
      label: "Saved old",
      tabId: "physical-active",
      viewInstanceId: "instance-active",
      savedViewRecovery: {
        id: "saved-active",
        persistedMetadata: {
          target: {
            kind: "browser",
            tabId: "physical-active",
            url: "https://saved.example/old",
            viewInstanceId: "instance-active",
          },
          title: "Saved old",
          subtitle: "https://saved.example/old",
          favicon: null,
        },
      },
    }));
    let openResult: ReturnType<NonNullable<typeof sidePanelControls>["openTarget"]> | undefined;
    act(() => {
      openResult = sidePanelControls!.openTarget({
        kind: "browser",
        url: "https://example.com/capacity-navigation",
        label: "Capacity navigation",
        tabId: "discarded-physical",
        dedupeKey: "https://example.com/capacity-navigation",
      });
    });

    expect(openResult).toEqual({ admitted: false, reason: "browser_capacity" });
    expect(sidePanelControls!.tabs).toHaveLength(8);
    expect(sidePanelControls!.activeKey).toBe("browser-tab:physical-active");
    expect(sidePanelControls!.tabs.at(-1)).toMatchObject({
      kind: "browser",
      tabId: "physical-active",
      viewInstanceId: "instance-active",
      url: "https://saved.example/old",
      label: "Saved old",
      savedViewRecovery: { id: "saved-active" },
    });
  });

  it("keeps an explicit new Browser tab logically distinct from ordinary routed-link reuse", () => {
    ({ container, root } = renderSidePanelProvider());
    act(() => sidePanelControls!.openTarget({
      kind: "browser",
      url: "https://example.com/explicit",
      label: "First",
      tabId: "physical-first",
      dedupeKey: "https://example.com/explicit",
    }));
    act(() => sidePanelControls!.openTarget({
      kind: "browser",
      url: "https://example.com/explicit",
      label: "Repeated",
      tabId: "physical-repeated",
      dedupeKey: "https://example.com/explicit",
    }));
    act(() => sidePanelControls!.openTargetInNewTab({
      kind: "browser",
      url: "https://example.com/explicit",
      label: "Explicit new",
      tabId: "physical-explicit",
    }));

    expect(sidePanelControls!.tabs).toHaveLength(2);
    expect(sidePanelControls!.tabs.map((target) => target.kind === "browser" && target.tabId)).toEqual([
      "physical-first",
      "physical-explicit",
    ]);
    expect(sidePanelControls!.tabs.map((target) => (
      target.kind === "browser" ? target.viewInstanceId : null
    ))).toEqual(["physical-first", "physical-explicit"]);
  });

  it("rejects a Saved Browser restore at capacity without changing its canonical identity", () => {
    ({ container, root } = renderSidePanelProvider());
    for (let index = 1; index <= 8; index += 1) {
      act(() => sidePanelControls!.openTarget({
        kind: "browser",
        url: `https://example.com/${index}`,
        label: `Example ${index}`,
        tabId: `physical-${index}`,
      }));
    }
    let openResult: unknown;
    act(() => {
      openResult = sidePanelControls!.openTarget({
      kind: "browser",
      url: "https://saved.example/restored",
      label: "Restored Saved View",
      tabId: "old-saved-physical",
      viewInstanceId: "saved-instance",
      savedViewRecovery: {
        id: "saved-capacity",
        persistedMetadata: {
          target: {
            kind: "browser",
            tabId: "old-saved-physical",
            url: "https://saved.example/restored",
            viewInstanceId: "saved-instance",
          },
          title: "Restored Saved View",
          subtitle: "https://saved.example/restored",
          favicon: null,
        },
      },
      });
    });

    expect(openResult).toEqual({ admitted: false, reason: "browser_capacity" });
    expect(sidePanelControls!.tabs).toHaveLength(8);
    expect(sidePanelControls!.activeKey).toBe("browser-tab:physical-8");
    expect(sidePanelControls!.tabs.at(-1)).toMatchObject({
      kind: "browser",
      tabId: "physical-8",
      viewInstanceId: "physical-8",
      url: "https://example.com/8",
    });
    expect(sidePanelControls!.tabs.some((target) => (
      target.kind === "browser" && target.savedViewRecovery?.id === "saved-capacity"
    ))).toBe(false);
  });

  it("retains incoming Saved recovery when an exact physical Browser tab has none", () => {
    ({ container, root } = renderSidePanelProvider());
    act(() => sidePanelControls!.openTarget({
      kind: "browser",
      url: "https://example.com/original",
      label: "Original",
      tabId: "physical-exact",
      viewInstanceId: "instance-exact",
    }));
    act(() => sidePanelControls!.openTarget({
      kind: "browser",
      url: "https://example.com/restored",
      label: "Restored",
      tabId: "physical-exact",
      viewInstanceId: "saved-instance-exact",
      savedViewRecovery: {
        id: "saved-exact",
        persistedMetadata: {
          target: {
            kind: "browser",
            tabId: "physical-exact",
            url: "https://example.com/restored",
            viewInstanceId: "saved-instance-exact",
          },
          title: "Restored",
          subtitle: "https://example.com/restored",
          favicon: null,
        },
      },
    }));

    expect(sidePanelControls!.tabs).toHaveLength(1);
    expect(sidePanelControls!.tabs[0]).toMatchObject({
      kind: "browser",
      tabId: "physical-exact",
      viewInstanceId: "instance-exact",
      url: "https://example.com/restored",
      savedViewRecovery: { id: "saved-exact" },
    });
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
