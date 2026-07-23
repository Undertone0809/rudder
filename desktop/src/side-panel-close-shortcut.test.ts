import { describe, expect, it } from "vitest";
import {
  isSidePanelCloseShortcutInput,
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
    }, "darwin")).toBeNull();
  });

  it("routes Command+W from an operator guest to that exact Browser owner", () => {
    expect(resolveProtectedDesktopShortcutRoute({ key: "w", meta: true }, {
      sidePanelCloseActive: true,
      browserSurfaceActive: false,
      operatorBrowserGuest: true,
    }, "darwin")).toEqual({ kind: "close_browser_owner_tab" });
  });
});
