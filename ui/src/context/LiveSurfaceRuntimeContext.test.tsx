// @vitest-environment jsdom

import type { MainWorkbenchTarget } from "@/lib/main-workbench-state";
import type { SidePanelTarget } from "@/lib/side-panel-targets";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLiveSurfaceRuntimeId,
  LiveSurfaceAnchor,
  LiveSurfaceRuntimeLayer,
  LiveSurfaceRuntimeProvider,
  useLiveSurfaceRuntime,
  type LiveSurfaceRenderContext,
} from "./LiveSurfaceRuntimeContext";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/workbench/BrowserLiveSurface", () => ({
  BrowserLiveSurface: ({ active }: { active: boolean }) => {
    const [value, setValue] = useState(0);
    return (
      <button
        type="button"
        data-testid="physical-browser"
        data-active={active ? "true" : "false"}
        onClick={() => setValue((current) => current + 1)}
      >
        {value}
      </button>
    );
  },
}));

vi.mock("@/components/side-panel/LocalAppPanelView", () => ({
  LocalAppPanelView: ({ active }: { active: boolean }) => (
    <div data-testid="physical-local-app" data-active={active ? "true" : "false"} />
  ),
}));

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let runtime: ReturnType<typeof useLiveSurfaceRuntime> | null = null;

function RuntimeProbe() {
  runtime = useLiveSurfaceRuntime();
  return null;
}

function RecreatedTargetAnchor() {
  useLiveSurfaceRuntime();
  const target = { ...browser };
  return (
    <LiveSurfaceAnchor
      active
      hostId="side-host"
      ownerId="side:chat-a:view-a"
      runtimeId={createLiveSurfaceRuntimeId("org-a", target)}
      target={target}
    />
  );
}

const browser: Extract<MainWorkbenchTarget, { kind: "browser" }> = {
  kind: "browser",
  label: "Example",
  tabId: "browser-a",
  url: "https://example.com",
  viewInstanceId: "view-a",
};
const libraryFile: Extract<MainWorkbenchTarget, { kind: "library_file" }> = {
  kind: "library_file",
  filePath: "notes/draft.md",
  label: "draft.md",
  viewInstanceId: "view-a",
};

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

describe("LiveSurfaceRuntimeProvider", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let originalRect: typeof HTMLElement.prototype.getBoundingClientRect;

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    originalRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      const ownerId = this.getAttribute("data-owner-id");
      if (ownerId === "side:chat-a:view-a") return rect(900, 80, 420, 700);
      if (ownerId === "main:org-a:view-a") return rect(300, 40, 900, 760);
      return originalRect.call(this);
    };
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    runtime = null;
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    vi.unstubAllGlobals();
  });

  function render({
    main = false,
    mainCloseTarget,
    mainOpenTarget,
    renderSurface,
    sideCloseTarget,
    sideOpenTarget,
    target = browser,
  }: {
    main?: boolean;
    mainCloseTarget?: (target: SidePanelTarget) => void;
    mainOpenTarget?: (target: SidePanelTarget) => void;
    renderSurface?: (context: LiveSurfaceRenderContext) => React.ReactNode;
    sideCloseTarget?: (target: SidePanelTarget) => void;
    sideOpenTarget?: (target: SidePanelTarget) => void;
    target?: MainWorkbenchTarget;
  } = {}) {
    const runtimeId = createLiveSurfaceRuntimeId("org-a", target);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <LiveSurfaceRuntimeProvider>
          <RuntimeProbe />
          <LiveSurfaceAnchor
            active
            callbacks={{
              onCloseTarget: sideCloseTarget,
              onOpenTarget: sideOpenTarget,
            }}
            hostId="side-host"
            ownerId="side:chat-a:view-a"
            runtimeId={runtimeId}
            target={target}
            renderSurface={renderSurface}
          />
          {main ? (
            <LiveSurfaceAnchor
              active
              autoClaim={false}
              callbacks={{
                onCloseTarget: mainCloseTarget,
                onOpenTarget: mainOpenTarget,
              }}
              hostId="main:org-a:view-a"
              ownerId="main:org-a:view-a"
              runtimeId={runtimeId}
              target={target}
            />
          ) : null}
          <LiveSurfaceRuntimeLayer />
        </LiveSurfaceRuntimeProvider>,
      );
    });
    return runtimeId;
  }

  it("moves one physical Browser instance between exact owner anchors", () => {
    const runtimeId = render({ main: true });
    const physicalBefore = container?.querySelector('[data-testid="physical-browser"]');
    expect(physicalBefore?.textContent).toBe("0");
    expect(container?.querySelector('[data-testid="live-surface-runtime-host"]')
      ?.getAttribute("data-owner-id")).toBe("side:chat-a:view-a");

    act(() => {
      physicalBefore?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(runtime?.claimSurface(runtimeId, "main:org-a:view-a")).toBe(true);
    });

    const physicalAfter = container?.querySelector('[data-testid="physical-browser"]');
    expect(physicalAfter).toBe(physicalBefore);
    expect(physicalAfter?.textContent).toBe("1");
    const host = container?.querySelector<HTMLElement>(
      '[data-testid="live-surface-runtime-host"]',
    );
    expect(host?.getAttribute("data-owner-id")).toBe("main:org-a:view-a");
    expect(host?.style.left).toBe("300px");
    expect(host?.style.width).toBe("900px");
  });

  it("retains a Side renderer and its editor state when Main does not replace it", () => {
    const retained = vi.fn(({ surface }: LiveSurfaceRenderContext) => (
      <label>
        {surface}
        <textarea defaultValue="draft" data-testid="retained-editor" />
      </label>
    ));
    const runtimeId = render({
      main: true,
      renderSurface: retained,
      target: libraryFile,
    });
    const editor = container?.querySelector<HTMLTextAreaElement>(
      '[data-testid="retained-editor"]',
    );
    expect(editor).not.toBeNull();
    act(() => {
      if (editor) editor.value = "unsaved draft";
      runtime?.claimSurface(runtimeId, "main:org-a:view-a");
    });

    expect(container?.querySelector('[data-testid="retained-editor"]')).toBe(editor);
    expect(editor?.value).toBe("unsaved draft");
    expect(container?.textContent).toContain("workbench");
  });

  it("keeps the source visible but inert while an exact transfer is locked", () => {
    const runtimeId = render();
    act(() => {
      runtime?.setInteractionLocked(runtimeId, true);
    });
    const host = container?.querySelector<HTMLElement>(
      '[data-testid="live-surface-runtime-host"]',
    );
    expect(host?.hidden).toBe(false);
    expect(host?.style.pointerEvents).toBe("none");
    expect(host?.hasAttribute("inert")).toBe(true);

    act(() => {
      runtime?.setInteractionLocked(runtimeId, false);
    });
    expect(host?.style.pointerEvents).toBe("auto");
    expect(host?.hasAttribute("inert")).toBe(false);
  });

  it("opens popup targets in the exact owner that currently leases the guest", () => {
    const sideOpenTarget = vi.fn();
    const mainOpenTarget = vi.fn();
    const runtimeId = render({
      main: true,
      mainOpenTarget,
      sideOpenTarget,
    });
    const popupTarget = {
      ...browser,
      tabId: "browser-popup",
      viewInstanceId: "view-popup",
    };

    act(() => {
      runtime?.registerWebContentsId(runtimeId, 42);
      (runtime as unknown as {
        openTargetForGuest(
          webContentsId: number,
          target: MainWorkbenchTarget,
        ): boolean;
      }).openTargetForGuest(42, popupTarget);
    });
    expect(sideOpenTarget).toHaveBeenCalledWith(popupTarget);
    expect(mainOpenTarget).not.toHaveBeenCalled();

    act(() => {
      runtime?.claimSurface(runtimeId, "main:org-a:view-a");
      (runtime as unknown as {
        openTargetForGuest(
          webContentsId: number,
          target: MainWorkbenchTarget,
        ): boolean;
      }).openTargetForGuest(42, popupTarget);
    });
    expect(mainOpenTarget).toHaveBeenCalledWith(popupTarget);
  });

  it("dispatches a Browser shortcut only to the exact source guest controller", () => {
    const runtimeId = render();
    const controller = vi.fn();

    act(() => {
      runtime?.registerWebContentsId(runtimeId, 42);
      (runtime as unknown as {
        registerBrowserShortcutController(
          runtimeId: string,
          controller: ((action: string) => void) | null,
        ): void;
      }).registerBrowserShortcutController(runtimeId, controller);
      (runtime as unknown as {
        dispatchBrowserShortcutForGuest(
          webContentsId: number,
          action: string,
        ): boolean;
      }).dispatchBrowserShortcutForGuest(42, "new_tab");
    });

    expect(controller).toHaveBeenCalledOnce();
    expect(controller).toHaveBeenCalledWith("new_tab");
  });

  it("closes only the exact owner that currently leases the source guest", () => {
    const sideCloseTarget = vi.fn();
    const mainCloseTarget = vi.fn();
    const runtimeId = render({
      main: true,
      mainCloseTarget,
      sideCloseTarget,
    });

    act(() => {
      runtime?.registerWebContentsId(runtimeId, 42);
      (runtime as unknown as {
        closeTargetForGuest(webContentsId: number): boolean;
      }).closeTargetForGuest(42);
    });
    expect(sideCloseTarget).toHaveBeenCalledWith(browser);
    expect(mainCloseTarget).not.toHaveBeenCalled();

    act(() => {
      runtime?.claimSurface(runtimeId, "main:org-a:view-a");
      (runtime as unknown as {
        closeTargetForGuest(webContentsId: number): boolean;
      }).closeTargetForGuest(42);
    });
    expect(mainCloseTarget).toHaveBeenCalledWith(browser);
  });

  it("does not resubscribe ResizeObserver after a geometry-only update", async () => {
    let observerCount = 0;
    let notifyResize: ResizeObserverCallback | null = null;
    class NotifyingResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        observerCount += 1;
        notifyResize = callback;
      }

      observe() {}

      unobserve() {}

      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", NotifyingResizeObserver);

    render();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const settledObserverCount = observerCount;
    await act(async () => {
      notifyResize?.([], {} as ResizeObserver);
      await Promise.resolve();
    });

    expect(observerCount).toBe(settledObserverCount);
  });

  it("treats recreated but semantically identical targets as one owner update", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <LiveSurfaceRuntimeProvider>
          <RecreatedTargetAnchor />
          <LiveSurfaceRuntimeLayer />
        </LiveSurfaceRuntimeProvider>,
      );
      await Promise.resolve();
    });

    expect(container.querySelectorAll(
      '[data-testid="live-surface-runtime-host"]',
    )).toHaveLength(1);
  });
});
