// @vitest-environment jsdom

import {
  createLiveSurfaceRuntimeId,
  LiveSurfaceAnchor,
  LiveSurfaceRuntimeProvider,
  useLiveSurfaceRuntime,
  type LiveSurfaceTarget,
} from "@/context/LiveSurfaceRuntimeContext";
import { SidePanelProvider, useSidePanel } from "@/context/SidePanelContext";
import type {
  DesktopBrowserShortcutRequest,
  DesktopShellApi,
  DesktopWebLinkRequest,
} from "@/lib/desktop-shell";
import type { SidePanelTarget } from "@/lib/side-panel-targets";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopBrowserLinkBridge } from "./DesktopBrowserLinkBridge";

const { getBrowser } = vi.hoisted(() => ({ getBrowser: vi.fn() }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: { getBrowser },
}));

function Probe() {
  const sidePanel = useSidePanel();
  return <div data-testid="probe">{JSON.stringify({ open: sidePanel.open, tabs: sidePanel.tabs })}</div>;
}

const ownerBrowser: LiveSurfaceTarget = {
  kind: "browser",
  label: "Owner",
  tabId: "owner-browser",
  url: "https://owner.example",
  viewInstanceId: "owner-view",
};

function ExactGuestOwner({
  onCloseTarget,
  onOpenTarget,
  shortcutController,
}: {
  onCloseTarget: (target: SidePanelTarget) => void;
  onOpenTarget: (target: SidePanelTarget) => void;
  shortcutController: (action: string) => void;
}) {
  const runtime = useLiveSurfaceRuntime();
  const runtimeId = createLiveSurfaceRuntimeId("org-a", ownerBrowser);
  useEffect(() => {
    runtime.registerWebContentsId(runtimeId, 42);
    runtime.registerBrowserShortcutController(
      runtimeId,
      shortcutController,
    );
    return () => {
      runtime.registerBrowserShortcutController(runtimeId, null);
      runtime.registerWebContentsId(runtimeId, null);
    };
  }, [runtime, runtimeId, shortcutController]);
  return (
    <>
      <LiveSurfaceAnchor
        active
        callbacks={{ onCloseTarget, onOpenTarget }}
        hostId="main:org-a:owner-view"
        ownerId="main:org-a:owner-view"
        runtimeId={runtimeId}
        target={ownerBrowser}
      />
      <button
        type="button"
        data-runtime-id={runtimeId}
        data-testid="active-browser-control"
      >
        Browser control
      </button>
    </>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as typeof window & { desktopShell?: DesktopShellApi }).desktopShell;
});

describe("DesktopBrowserLinkBridge", () => {
  it("subscribes to Desktop link requests and opens the global Side Panel Browser", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let listener: ((request: DesktopWebLinkRequest) => void) | null = null;
    const unsubscribe = vi.fn();
    const forceOpenExternal = vi.fn(async () => undefined);
    (window as typeof window & { desktopShell?: Partial<DesktopShellApi> }).desktopShell = {
      onOpenWebLink: (nextListener) => {
        listener = nextListener;
        return unsubscribe;
      },
      openExternal: forceOpenExternal,
      forceOpenExternal,
    };
    getBrowser.mockResolvedValue({ enabled: false, openLinksIn: "built_in" });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <SidePanelProvider>
            <DesktopBrowserLinkBridge />
            <Probe />
          </SidePanelProvider>
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      listener?.({ url: "https://example.com/docs", source: "link" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector("[data-testid='probe']")?.textContent).toContain("https://example.com/docs");
    expect(container.querySelector("[data-testid='probe']")?.textContent).toContain('"open":true');
    expect(forceOpenExternal).not.toHaveBeenCalled();

    await act(async () => {
      listener?.({ url: "https://example.com/docs", source: "link" });
      await Promise.resolve();
      await Promise.resolve();
    });
    const state = JSON.parse(container.querySelector("[data-testid='probe']")?.textContent ?? "{}") as {
      tabs?: unknown[];
    };
    expect(state.tabs).toHaveLength(1);

    await act(async () => {
      listener?.({
        source: "browser_popup",
        sourceWebContentsId: 999,
        url: "https://example.com/popup-without-owner",
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    const stateAfterOrphanPopup = JSON.parse(
      container.querySelector("[data-testid='probe']")?.textContent ?? "{}",
    ) as { tabs?: unknown[] };
    expect(stateAfterOrphanPopup.tabs).toHaveLength(1);

    await act(async () => root.unmount());
    expect(unsubscribe).toHaveBeenCalledOnce();
    container.remove();
  });

  it("routes popup and shortcut events to the exact guest owner", async () => {
    let linkListener: ((request: DesktopWebLinkRequest) => void) | null = null;
    let shortcutListener:
      | ((request: DesktopBrowserShortcutRequest) => void)
      | null = null;
    const openTarget = vi.fn();
    const closeTarget = vi.fn();
    const shortcutController = vi.fn();
    (window as typeof window & { desktopShell?: Partial<DesktopShellApi> }).desktopShell = {
      onBrowserShortcut: (nextListener) => {
        shortcutListener = nextListener;
        return () => undefined;
      },
      onOpenWebLink: (nextListener) => {
        linkListener = nextListener;
        return () => undefined;
      },
      openExternal: vi.fn(async () => undefined),
      forceOpenExternal: vi.fn(async () => undefined),
    };
    getBrowser.mockResolvedValue({ enabled: true, openLinksIn: "built_in" });
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = () => ({
      bottom: 100,
      height: 100,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <SidePanelProvider>
            <LiveSurfaceRuntimeProvider>
              <DesktopBrowserLinkBridge />
              <ExactGuestOwner
                onCloseTarget={closeTarget}
                onOpenTarget={openTarget}
                shortcutController={shortcutController}
              />
            </LiveSurfaceRuntimeProvider>
          </SidePanelProvider>
        </QueryClientProvider>,
      );
    });

    const popup = {
      source: "browser_popup" as const,
      sourceWebContentsId: 42,
      url: "https://popup.example/docs",
    };
    await act(async () => {
      linkListener?.(popup);
      await Promise.resolve();
      await Promise.resolve();
      shortcutListener?.({
        action: "new_tab",
        sourceWebContentsId: 42,
      });
      shortcutListener?.({
        action: "close_tab" as never,
        sourceWebContentsId: 42,
      });
      container.querySelector<HTMLButtonElement>(
        "[data-testid='active-browser-control']",
      )?.focus();
      shortcutListener?.({ action: "reload" });
    });

    expect(openTarget).toHaveBeenCalledOnce();
    expect(openTarget.mock.calls[0]?.[0]).toMatchObject({
      kind: "browser",
      url: popup.url,
    });
    expect(shortcutController).toHaveBeenCalledWith("new_tab");
    expect(shortcutController).toHaveBeenCalledWith("reload");
    expect(closeTarget).toHaveBeenCalledWith(ownerBrowser);

    await act(async () => root.unmount());
    container.remove();
    HTMLElement.prototype.getBoundingClientRect = originalRect;
  });
});
