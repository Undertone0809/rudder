import { describe, expect, it } from "vitest";
import {
  isSidePanelCloseShortcutInput,
  isSidePanelToggleShortcutInput,
  resolveProtectedDesktopShortcutRoute,
} from "./side-panel-close-shortcut.js";

describe("side panel close shortcut input", () => {
  it("matches macOS Command+W only", () => {
    expect(isSidePanelCloseShortcutInput({ key: "w", meta: true }, "darwin")).toBe(true);
    expect(isSidePanelCloseShortcutInput({ code: "KeyW", meta: true }, "darwin")).toBe(true);
    expect(isSidePanelCloseShortcutInput({ key: "w", control: true }, "darwin")).toBe(false);
    expect(isSidePanelCloseShortcutInput({ key: "w", meta: true, control: true }, "darwin")).toBe(false);
  });

  it("matches non-macOS Ctrl+W only", () => {
    expect(isSidePanelCloseShortcutInput({ key: "w", control: true }, "win32")).toBe(true);
    expect(isSidePanelCloseShortcutInput({ key: "w", meta: true }, "win32")).toBe(false);
    expect(isSidePanelCloseShortcutInput({ key: "w", control: true, meta: true }, "linux")).toBe(false);
  });

  it("ignores release and modified close-key events", () => {
    expect(isSidePanelCloseShortcutInput({ type: "keyUp", key: "w", meta: true }, "darwin")).toBe(false);
    expect(isSidePanelCloseShortcutInput({ key: "w", meta: true, shift: true }, "darwin")).toBe(false);
    expect(isSidePanelCloseShortcutInput({ key: "w", control: true, alt: true }, "win32")).toBe(false);
    expect(isSidePanelCloseShortcutInput({ key: "q", meta: true }, "darwin")).toBe(false);
  });

  it("routes Browser actions only for focused renderer surfaces or operator guests", () => {
    const inactive = {
      sidePanelCloseActive: true,
      browserSurfaceActive: false,
      operatorBrowserGuest: false,
    };
    expect(resolveProtectedDesktopShortcutRoute({ key: "r", meta: true }, inactive, "darwin")).toBeNull();
    expect(resolveProtectedDesktopShortcutRoute({ key: "r", meta: true }, {
      ...inactive,
      browserSurfaceActive: true,
    }, "darwin")).toEqual({ kind: "browser", action: "reload" });
    expect(resolveProtectedDesktopShortcutRoute({ key: "r", meta: true }, {
      ...inactive,
      operatorBrowserGuest: true,
    }, "darwin")).toEqual({ kind: "browser", action: "reload" });
  });

  it("keeps the Side Panel close route independent of Browser focus", () => {
    expect(resolveProtectedDesktopShortcutRoute({ key: "w", meta: true }, {
      sidePanelCloseActive: true,
      browserSurfaceActive: false,
      operatorBrowserGuest: false,
    }, "darwin")).toEqual({ kind: "close_side_panel_tab" });
    expect(resolveProtectedDesktopShortcutRoute({ key: "w", meta: true }, {
      sidePanelCloseActive: false,
      browserSurfaceActive: true,
      operatorBrowserGuest: false,
      browserSurfaceOwner: "main_workbench",
    }, "darwin")).toBeNull();
  });

  it("routes Command+W from an operator guest to that exact Browser owner", () => {
    expect(resolveProtectedDesktopShortcutRoute({ key: "w", meta: true }, {
      sidePanelCloseActive: true,
      browserSurfaceActive: false,
      operatorBrowserGuest: true,
    }, "darwin")).toEqual({ kind: "close_browser_owner_tab" });
  });

  it("routes Cmd/Ctrl+T to open an empty Side Panel without changing the close route", () => {
    expect(isSidePanelToggleShortcutInput({ key: "t", meta: true }, "darwin")).toBe(true);
    expect(isSidePanelToggleShortcutInput({ code: "KeyT", control: true }, "win32")).toBe(true);
    expect(isSidePanelToggleShortcutInput({ key: "t", control: true }, "darwin")).toBe(false);
    expect(isSidePanelToggleShortcutInput({ key: "t", meta: true, shift: true }, "darwin")).toBe(false);
    expect(resolveProtectedDesktopShortcutRoute({ key: "t", meta: true }, {
      sidePanelCloseActive: false,
      browserSurfaceActive: false,
      operatorBrowserGuest: false,
    }, "darwin")).toEqual({ kind: "open_empty_side_panel" });
    expect(resolveProtectedDesktopShortcutRoute({ key: "t", meta: true }, {
      sidePanelCloseActive: false,
      browserSurfaceActive: true,
      operatorBrowserGuest: false,
      browserSurfaceOwner: "main_workbench",
    }, "darwin")).toEqual({ kind: "browser", action: "new_tab" });
    expect(resolveProtectedDesktopShortcutRoute({ key: "t", meta: true }, {
      sidePanelCloseActive: false,
      browserSurfaceActive: false,
      operatorBrowserGuest: true,
      browserSurfaceOwner: "main_workbench",
    }, "darwin")).toEqual({ kind: "browser", action: "new_tab" });
    expect(resolveProtectedDesktopShortcutRoute({ key: "w", meta: true }, {
      sidePanelCloseActive: true,
      browserSurfaceActive: false,
      operatorBrowserGuest: false,
    }, "darwin")).toEqual({ kind: "close_side_panel_tab" });
  });

  it("opens the Side Panel from Side Browser and Local App surfaces while preserving Main Browser new-tab", () => {
    const sideBrowserGuest = {
      sidePanelCloseActive: false,
      browserSurfaceActive: false,
      operatorBrowserGuest: true,
      browserSurfaceOwner: "side_panel",
    } as const;
    const sideBrowserRenderer = {
      ...sideBrowserGuest,
      operatorBrowserGuest: false,
      browserSurfaceActive: true,
    } as const;
    const sideLocalAppGuest = {
      ...sideBrowserGuest,
      browserSurfaceOwner: "side_panel",
    } as const;
    const mainBrowserGuest = {
      ...sideBrowserGuest,
      browserSurfaceOwner: "main_workbench",
    } as const;
    const mainBrowserRenderer = {
      ...mainBrowserGuest,
      operatorBrowserGuest: false,
      browserSurfaceActive: true,
    } as const;

    expect(resolveProtectedDesktopShortcutRoute({ key: "t", meta: true }, sideBrowserGuest, "darwin"))
      .toEqual({ kind: "open_empty_side_panel" });
    expect(resolveProtectedDesktopShortcutRoute({ key: "t", meta: true }, sideBrowserRenderer, "darwin"))
      .toEqual({ kind: "open_empty_side_panel" });
    expect(resolveProtectedDesktopShortcutRoute({ key: "t", meta: true }, sideLocalAppGuest, "darwin"))
      .toEqual({ kind: "open_empty_side_panel" });
    expect(resolveProtectedDesktopShortcutRoute({ key: "t", meta: true }, mainBrowserGuest, "darwin"))
      .toEqual({ kind: "browser", action: "new_tab" });
    expect(resolveProtectedDesktopShortcutRoute({ key: "t", meta: true }, mainBrowserRenderer, "darwin"))
      .toEqual({ kind: "browser", action: "new_tab" });
  });
});
