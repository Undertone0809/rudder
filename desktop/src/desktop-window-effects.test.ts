import { describe, expect, it } from "vitest";
import {
  normalizeDesktopWindowEffectMode,
  resolveDesktopWindowBackgroundColorForEffect,
  resolveDesktopWindowChromeOptions,
  resolveDesktopWindowEffectMode,
  resolveDesktopWindowEffects,
  resolveRoundedWindowShapeRects,
} from "./desktop-window-effects.js";
import type { DesktopAppearance } from "./theme-preference.js";

const desktopWindowBackground: Record<DesktopAppearance, string> = {
  light: "#f1f0ef",
  dark: "#1f1f1d",
};
const transparentWindowBackground: Record<DesktopAppearance, string> = {
  light: "rgba(246, 244, 241, 0.18)",
  dark: "rgba(18, 20, 24, 0.28)",
};

describe("desktop window effect mode", () => {
  it("normalizes supported values and rejects unknown values", () => {
    expect(normalizeDesktopWindowEffectMode("transparent-vibrant")).toBe("transparent_vibrant");
    expect(normalizeDesktopWindowEffectMode(" TRANSPARENT ")).toBe("transparent");
    expect(normalizeDesktopWindowEffectMode("opaque")).toBe("opaque");
    expect(normalizeDesktopWindowEffectMode("glass")).toBeNull();
  });

  it("prefers the cross-platform env var while preserving the legacy macOS env fallback", () => {
    expect(resolveDesktopWindowEffectMode({}, "darwin")).toBe("transparent_vibrant");
    expect(resolveDesktopWindowEffectMode({}, "win32")).toBe("transparent_vibrant");
    expect(resolveDesktopWindowEffectMode({}, "linux")).toBe("opaque");
    expect(resolveDesktopWindowEffectMode({ RUDDER_DESKTOP_MAC_WINDOW_MODE: "transparent" }, "darwin"))
      .toBe("transparent");
    expect(resolveDesktopWindowEffectMode({ RUDDER_DESKTOP_MAC_WINDOW_MODE: "opaque" }, "win32"))
      .toBe("transparent_vibrant");
    expect(resolveDesktopWindowEffectMode({
      RUDDER_DESKTOP_WINDOW_EFFECT_MODE: "transparent",
      RUDDER_DESKTOP_MAC_WINDOW_MODE: "opaque",
    }, "win32")).toBe("transparent");
  });
});

describe("desktop window effects", () => {
  it("uses a frameless host window only on Windows", () => {
    expect(resolveDesktopWindowChromeOptions("win32")).toEqual({ frame: false, roundedCorners: true });
    expect(resolveDesktopWindowChromeOptions("darwin")).toEqual({});
    expect(resolveDesktopWindowChromeOptions("linux")).toEqual({});
  });

  it("builds a rounded restored-window shape for Windows", () => {
    const rects = resolveRoundedWindowShapeRects(100, 80, 10);

    expect(rects).toHaveLength(13);
    expect(rects[0]).toEqual({ x: 7, y: 0, width: 86, height: 1 });
    expect(rects[5]).toEqual({ x: 1, y: 6, width: 98, height: 4 });
    expect(rects[6]).toEqual({ x: 0, y: 10, width: 100, height: 60 });
    expect(rects[12]).toEqual({ x: 7, y: 79, width: 86, height: 1 });
  });

  it("uses native macOS vibrancy while keeping the hidden inset titlebar", () => {
    expect(resolveDesktopWindowEffects({
      platform: "darwin",
      mode: "transparent_vibrant",
      appearance: "light",
      desktopWindowBackground,
      transparentWindowBackground,
    })).toEqual({
      titleBarStyle: "hiddenInset",
      transparent: true,
      backgroundColor: transparentWindowBackground.light,
      vibrancy: "under-window",
      visualEffectState: "active",
    });
  });

  it("keeps the Windows host window fully transparent", () => {
    expect(resolveDesktopWindowEffects({
      platform: "win32",
      mode: "transparent_vibrant",
      appearance: "dark",
      desktopWindowBackground,
      transparentWindowBackground,
    })).toEqual({
      transparent: true,
      backgroundColor: "#00000000",
    });
  });

  it("keeps the opaque escape hatch free of transparent flags", () => {
    expect(resolveDesktopWindowEffects({
      platform: "win32",
      mode: "opaque",
      appearance: "dark",
      desktopWindowBackground,
      transparentWindowBackground,
    })).toEqual({ backgroundColor: desktopWindowBackground.dark });
  });

  it("chooses the matching background color when the theme changes", () => {
    expect(resolveDesktopWindowBackgroundColorForEffect({
      mode: "opaque",
      appearance: "light",
      desktopWindowBackground,
      transparentWindowBackground,
    })).toBe(desktopWindowBackground.light);
    expect(resolveDesktopWindowBackgroundColorForEffect({
      mode: "transparent",
      appearance: "dark",
      desktopWindowBackground,
      transparentWindowBackground,
    })).toBe(transparentWindowBackground.dark);
  });
});
