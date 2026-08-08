// @vitest-environment jsdom

import type { BrowserShortcutAction } from "@rudderhq/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserLiveSurface } from "./BrowserLiveSurface";

vi.mock("@/context/I18nContext", async () => {
  const actual = await vi.importActual<typeof import("@/context/I18nContext")>("@/context/I18nContext");
  return {
    ...actual,
    useI18n: () => ({
      locale: "en",
      t: (key: import("@/i18n/locales/en").TranslationKey) => actual.translateMessage("en", key),
    }),
  };
});

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
    window.localStorage.clear();
    window.sessionStorage.clear();
    Reflect.deleteProperty(window, "desktopShell");
  });

  it("introduces the Side Panel Browser once without onboarding the Main Workbench", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const commonProps = {
      active: true,
      canOpenNewTab: true,
      target: {
        kind: "browser" as const,
        label: "Example",
        tabId: "browser-onboarding",
        url: "https://example.com",
        viewInstanceId: "view-onboarding",
      },
      targetKey: "browser-tab:browser-onboarding",
      onOpenTarget: vi.fn(),
      onReplaceTarget: vi.fn(),
      onCloseTarget: vi.fn(),
      onRegisterShortcutController: vi.fn(),
    };

    act(() => {
      root?.render(<BrowserLiveSurface {...commonProps} surface="workbench" />);
    });
    expect(container.querySelector("[data-testid='browser-side-panel-onboarding']")).toBeNull();

    act(() => {
      root?.render(<BrowserLiveSurface {...commonProps} surface="side_panel" />);
    });
    const onboarding = container.querySelector("[data-testid='browser-side-panel-onboarding']");
    expect(onboarding?.getAttribute("role")).toBe("status");
    expect(onboarding?.getAttribute("aria-live")).toBe("polite");
    expect(onboarding?.textContent).toContain("Rudder starts with its Built-in Browser");
    expect(onboarding?.textContent).toContain("Settings");
    expect(onboarding?.textContent).toContain("default browser");
    expect(
      onboarding?.querySelector("[data-onboarding-actions]")?.getAttribute("data-onboarding-actions"),
    ).toBe("stacked");

    act(() => {
      onboarding?.querySelector<HTMLButtonElement>("button")?.click();
    });
    expect(container.querySelector("[data-testid='browser-side-panel-onboarding']")).toBeNull();
    expect(window.localStorage.getItem("rudder.browser.side-panel-onboarding.dismissed.v1")).toBe("true");

    act(() => {
      root?.render(
        <BrowserLiveSurface
          {...commonProps}
          surface="side_panel"
          target={{ ...commonProps.target, tabId: "browser-onboarding-next" }}
          targetKey="browser-tab:browser-onboarding-next"
        />,
      );
    });
    expect(container.querySelector("[data-testid='browser-side-panel-onboarding']")).toBeNull();
  });

  it("opens the exact Browser settings destination from onboarding", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const onOpenBrowserSettings = vi.fn();

    act(() => {
      root?.render(
        <BrowserLiveSurface
          active
          canOpenNewTab
          surface="side_panel"
          target={{
            kind: "browser",
            label: "Example",
            tabId: "browser-settings-link",
            url: "https://example.com",
            viewInstanceId: "view-settings-link",
          }}
          targetKey="browser-tab:browser-settings-link"
          onOpenBrowserSettings={onOpenBrowserSettings}
          onOpenTarget={vi.fn()}
          onReplaceTarget={vi.fn()}
          onCloseTarget={vi.fn()}
          onRegisterShortcutController={vi.fn()}
        />,
      );
    });

    const settingsButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Browser settings");
    expect(settingsButton).toBeDefined();
    act(() => settingsButton?.click());

    expect(onOpenBrowserSettings).toHaveBeenCalledOnce();
    expect(container.querySelector("[data-testid='browser-side-panel-onboarding']")).toBeNull();
    expect(window.localStorage.getItem("rudder.browser.side-panel-onboarding.dismissed.v1")).toBe("true");
  });

  it("uses opaque surface tokens for the Browser frame and toolbar", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <BrowserLiveSurface
          active
          canOpenNewTab
          surface="side_panel"
          target={{
            kind: "browser",
            label: "Example",
            tabId: "browser-opaque",
            url: "https://example.com",
            viewInstanceId: "view-opaque",
          }}
          targetKey="browser-tab:browser-opaque"
          onOpenTarget={vi.fn()}
          onReplaceTarget={vi.fn()}
          onCloseTarget={vi.fn()}
          onRegisterShortcutController={vi.fn()}
        />,
      );
    });

    expect(container.querySelector("[data-testid='chat-side-panel-browser-view']")
      ?.classList.contains("bg-[color:var(--surface-elevated)]")).toBe(true);
    expect(container.querySelector("[data-testid='chat-side-panel-browser-toolbar']")
      ?.classList.contains("bg-[color:var(--surface-elevated)]")).toBe(true);
    expect(container.querySelector("webview")
      ?.classList.contains("bg-[color:var(--surface-elevated)]")).toBe(true);
    expect(container.querySelector("[data-testid='chat-side-panel-browser-toolbar']")
      ?.nextElementSibling?.getAttribute("data-testid"))
      .toBe("chat-side-panel-browser-content");
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
          surface="side_panel"
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
          surface="side_panel"
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

  it("ignores late webview events from any previous address after navigation", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const previousUrl = "https://example.com/previous";
    const nextUrl = "https://example.com/next";
    const onReplaceTarget = vi.fn();
    let guestUrl = previousUrl;

    act(() => {
      root?.render(
        <BrowserLiveSurface
          active
          canOpenNewTab
          surface="side_panel"
          target={{
            kind: "browser",
            label: "Previous",
            tabId: "browser-stale-events",
            url: previousUrl,
            viewInstanceId: "view-stale-events",
          }}
          targetKey="browser-tab:stale-events"
          onOpenTarget={vi.fn()}
          onReplaceTarget={onReplaceTarget}
          onCloseTarget={vi.fn()}
          onRegisterShortcutController={vi.fn()}
        />,
      );
    });

    const webview = container.querySelector("webview") as HTMLElement & { getURL?: () => string };
    webview.getURL = () => guestUrl;
    const address = container.querySelector<HTMLInputElement>("input[name='browser-url']");
    expect(address).not.toBeNull();

    act(() => {
      address!.value = nextUrl;
      address!.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    onReplaceTarget.mockClear();

    guestUrl = nextUrl;
    const didNavigate = new Event("did-navigate");
    Object.defineProperty(didNavigate, "url", { configurable: true, value: nextUrl });
    act(() => webview.dispatchEvent(didNavigate));
    onReplaceTarget.mockClear();

    const finalUrl = "https://example.com/final";
    act(() => {
      address!.value = finalUrl;
      address!.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    onReplaceTarget.mockClear();

    guestUrl = previousUrl;
    act(() => webview.dispatchEvent(new Event("did-stop-loading")));

    expect(onReplaceTarget).not.toHaveBeenCalled();
  });

  it("uses the attached guest to navigate instead of relying on a src update", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const loadURL = vi.fn(async () => undefined);

    act(() => {
      root?.render(
        <BrowserLiveSurface
          active
          canOpenNewTab
          surface="side_panel"
          target={{
            kind: "browser",
            label: "Previous",
            tabId: "browser-attached-guest",
            url: "https://example.com/previous",
            viewInstanceId: "view-attached-guest",
          }}
          targetKey="browser-tab:attached-guest"
          onOpenTarget={vi.fn()}
          onReplaceTarget={vi.fn()}
          onCloseTarget={vi.fn()}
          onRegisterShortcutController={vi.fn()}
        />,
      );
    });

    const webview = container.querySelector("webview") as HTMLElement & {
      loadURL?: (url: string) => Promise<void>;
    };
    webview.loadURL = loadURL;
    act(() => webview.dispatchEvent(new Event("dom-ready")));

    const address = container.querySelector<HTMLInputElement>("input[name='browser-url']");
    act(() => {
      address!.value = "https://example.com/next#section";
      address!.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(loadURL).toHaveBeenCalledWith("https://example.com/next#section");
  });

  it("accepts an explicit back navigation to a historical URL", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const previousUrl = "https://example.com/previous";
    const nextUrl = "https://example.com/next";
    const onReplaceTarget = vi.fn();
    let guestUrl = previousUrl;

    act(() => {
      root?.render(
        <BrowserLiveSurface
          active
          canOpenNewTab
          surface="side_panel"
          target={{
            kind: "browser",
            label: "Previous",
            tabId: "browser-history-back",
            url: previousUrl,
            viewInstanceId: "view-history-back",
          }}
          targetKey="browser-tab:history-back"
          onOpenTarget={vi.fn()}
          onReplaceTarget={onReplaceTarget}
          onCloseTarget={vi.fn()}
          onRegisterShortcutController={vi.fn()}
        />,
      );
    });

    const webview = container.querySelector("webview") as HTMLElement & { getURL?: () => string };
    webview.getURL = () => guestUrl;
    const address = container.querySelector<HTMLInputElement>("input[name='browser-url']");
    act(() => webview.dispatchEvent(new Event("dom-ready")));

    act(() => {
      address!.value = nextUrl;
      address!.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    onReplaceTarget.mockClear();

    guestUrl = nextUrl;
    const didNavigate = new Event("did-navigate");
    Object.defineProperty(didNavigate, "url", { configurable: true, value: nextUrl });
    act(() => webview.dispatchEvent(didNavigate));
    onReplaceTarget.mockClear();

    guestUrl = previousUrl;
    const backNavigation = new Event("did-navigate");
    Object.defineProperty(backNavigation, "url", { configurable: true, value: previousUrl });
    act(() => webview.dispatchEvent(backNavigation));

    expect(onReplaceTarget).toHaveBeenCalledWith(
      "browser-tab:history-back",
      expect.objectContaining({ url: previousUrl }),
    );
  });

  it("lets the Desktop owner bridge exclusively route guest Browser shortcuts", () => {
    const onOpenTarget = vi.fn();
    const onCloseTarget = vi.fn();
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: {
        onBrowserShortcut: vi.fn(),
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <BrowserLiveSurface
          active
          canOpenNewTab
          surface="side_panel"
          target={{
            kind: "browser",
            label: "Example",
            tabId: "browser-owner",
            url: "https://example.com",
            viewInstanceId: "view-owner",
          }}
          targetKey="browser-tab:browser-owner"
          onOpenTarget={onOpenTarget}
          onReplaceTarget={vi.fn()}
          onCloseTarget={onCloseTarget}
          onRegisterShortcutController={vi.fn()}
        />,
      );
    });
    const webview = container.querySelector("webview");
    const newTab = new Event("before-input-event", { cancelable: true });
    Object.defineProperty(newTab, "input", {
      configurable: true,
      value: { key: "t", meta: true, type: "keyDown" },
    });
    const close = new Event("before-input-event", { cancelable: true });
    Object.defineProperty(close, "input", {
      configurable: true,
      value: { control: true, key: "w", type: "keyDown" },
    });

    act(() => {
      webview?.dispatchEvent(newTab);
      webview?.dispatchEvent(close);
    });

    expect(onOpenTarget).not.toHaveBeenCalled();
    expect(onCloseTarget).not.toHaveBeenCalled();
  });

  it("executes owner-routed Browser actions against the active ready guest", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const onOpenTarget = vi.fn();
    let shortcutController: ((action: BrowserShortcutAction) => void) | null = null;
    act(() => {
      root?.render(
        <BrowserLiveSurface
          active
          canOpenNewTab
          surface="side_panel"
          target={{
            kind: "browser",
            label: "Example",
            tabId: "browser-actions",
            url: "https://example.com",
            viewInstanceId: "view-actions",
          }}
          targetKey="browser-tab:browser-actions"
          onOpenTarget={onOpenTarget}
          onReplaceTarget={vi.fn()}
          onCloseTarget={vi.fn()}
          onRegisterShortcutController={(_key, controller) => {
            shortcutController = controller;
          }}
        />,
      );
    });

    const webview = container.querySelector("webview") as HTMLElement & {
      canGoBack?: () => boolean;
      canGoForward?: () => boolean;
      goBack?: () => void;
      goForward?: () => void;
      reload?: () => void;
      reloadIgnoringCache?: () => void;
      setZoomFactor?: (factor: number) => void;
    };
    const reload = vi.fn();
    const reloadIgnoringCache = vi.fn();
    const goBack = vi.fn();
    const goForward = vi.fn();
    const setZoomFactor = vi.fn();
    Object.assign(webview, {
      canGoBack: () => true,
      canGoForward: () => true,
      goBack,
      goForward,
      reload,
      reloadIgnoringCache,
      setZoomFactor,
    });
    act(() => webview.dispatchEvent(new Event("dom-ready")));

    act(() => {
      shortcutController?.("reload");
      shortcutController?.("reload_ignoring_cache");
      shortcutController?.("go_back");
      shortcutController?.("go_forward");
      shortcutController?.("zoom_in");
    });

    expect(reload).toHaveBeenCalledOnce();
    expect(reloadIgnoringCache).toHaveBeenCalledOnce();
    expect(goBack).toHaveBeenCalledOnce();
    expect(goForward).toHaveBeenCalledOnce();
    expect(setZoomFactor).toHaveBeenLastCalledWith(1.1);
    expect(container.querySelector("[data-testid='chat-side-panel-browser-zoom']")).toBeNull();

    const address = container.querySelector<HTMLInputElement>('input[aria-label="Browser URL"]')!;
    address.setSelectionRange(0, 0);
    act(() => {
      shortcutController?.("focus_location");
      shortcutController?.("new_tab");
      shortcutController?.("zoom_reset");
    });
    expect(document.activeElement).toBe(address);
    expect(address.selectionStart).toBe(0);
    expect(address.selectionEnd).toBe(address.value.length);
    expect(onOpenTarget).toHaveBeenCalledOnce();
    expect(setZoomFactor).toHaveBeenLastCalledWith(1);
  });
});
