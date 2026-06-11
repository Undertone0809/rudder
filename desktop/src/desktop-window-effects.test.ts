import { describe, expect, it } from "vitest";
import {
  normalizeDesktopWindowEffectMode,
  resolveDesktopWindowBackgroundColorForEffect,
  resolveDesktopWindowChromeOptions,
  resolveDesktopWindowEffectMode,
  resolveDesktopWindowEffects,
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
    expect(resolveDesktopWindowEffectMode({})).toBe("transparent_vibrant");
    expect(resolveDesktopWindowEffectMode({ RUDDER_DESKTOP_MAC_WINDOW_MODE: "opaque" })).toBe("opaque");
    expect(resolveDesktopWindowEffectMode({
      RUDDER_DESKTOP_WINDOW_EFFECT_MODE: "transparent",
      RUDDER_DESKTOP_MAC_WINDOW_MODE: "opaque",
    })).toBe("transparent");
  });
});

describe("desktop window effects", () => {
  it("uses a frameless host window only on Windows so the renderer can clip rounded corners", () => {
    expect(resolveDesktopWindowChromeOptions("win32")).toEqual({ frame: false });
    expect(resolveDesktopWindowChromeOptions("darwin")).toEqual({});
    expect(resolveDesktopWindowChromeOptions("linux")).toEqual({});
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

  it("uses Windows background material for the default vibrant mode", () => {
    expect(resolveDesktopWindowEffects({
      platform: "win32",
      mode: "transparent_vibrant",
      appearance: "dark",
      desktopWindowBackground,
      transparentWindowBackground,
    })).toEqual({
      transparent: true,
      backgroundColor: transparentWindowBackground.dark,
      backgroundMaterial: "mica",
    });
  });

  it("uses a transparent tinted window on Linux where compositor blur support varies", () => {
    expect(resolveDesktopWindowEffects({
      platform: "linux",
      mode: "transparent_vibrant",
      appearance: "light",
      desktopWindowBackground,
      transparentWindowBackground,
    })).toEqual({
      transparent: true,
      backgroundColor: transparentWindowBackground.light,
    });
  });

  it("keeps the opaque escape hatch free of transparent window flags on non-macOS platforms", () => {
    expect(resolveDesktopWindowEffects({
      platform: "win32",
      mode: "opaque",
      appearance: "dark",
      desktopWindowBackground,
      transparentWindowBackground,
    })).toEqual({
      backgroundColor: desktopWindowBackground.dark,
    });
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
