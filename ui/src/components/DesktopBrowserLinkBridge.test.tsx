// @vitest-environment jsdom

import { SidePanelProvider, useSidePanel } from "@/context/SidePanelContext";
import type { DesktopShellApi, DesktopWebLinkRequest } from "@/lib/desktop-shell";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
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

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as typeof window & { desktopShell?: DesktopShellApi }).desktopShell;
});

describe("DesktopBrowserLinkBridge", () => {
  it("subscribes to Desktop link requests and opens the global Side Panel Browser", async () => {
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

    await act(async () => root.unmount());
    expect(unsubscribe).toHaveBeenCalledOnce();
    container.remove();
  });
});
