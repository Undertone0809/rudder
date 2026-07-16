import { describe, expect, it } from "vitest";
import { isBrowserShortcutAction, resolveBrowserShortcutInput } from "./browser-shortcuts.js";

describe("browser shortcut resolver", () => {
  it("maps the macOS browser command set", () => {
    expect(resolveBrowserShortcutInput({ key: "r", meta: true }, { isMac: true })).toBe("reload");
    expect(resolveBrowserShortcutInput({ key: "r", meta: true, shift: true }, { isMac: true })).toBe("reload_ignoring_cache");
    expect(resolveBrowserShortcutInput({ key: "t", meta: true }, { isMac: true })).toBe("new_tab");
    expect(resolveBrowserShortcutInput({ code: "KeyL", meta: true }, { isMac: true })).toBe("focus_location");
    expect(resolveBrowserShortcutInput({ key: "[", meta: true }, { isMac: true })).toBe("go_back");
    expect(resolveBrowserShortcutInput({ code: "BracketRight", meta: true }, { isMac: true })).toBe("go_forward");
    expect(resolveBrowserShortcutInput({ key: "=", meta: true }, { isMac: true })).toBe("zoom_in");
    expect(resolveBrowserShortcutInput({ key: "+", code: "Equal", meta: true, shift: true }, { isMac: true })).toBe("zoom_in");
    expect(resolveBrowserShortcutInput({ code: "NumpadAdd", meta: true }, { isMac: true })).toBe("zoom_in");
    expect(resolveBrowserShortcutInput({ key: "-", meta: true }, { isMac: true })).toBe("zoom_out");
    expect(resolveBrowserShortcutInput({ key: "0", meta: true }, { isMac: true })).toBe("zoom_reset");
  });

  it("maps Ctrl shortcuts outside macOS", () => {
    expect(resolveBrowserShortcutInput({ code: "KeyR", control: true }, { isMac: false })).toBe("reload");
    expect(resolveBrowserShortcutInput({ code: "KeyR", control: true, shift: true }, { isMac: false })).toBe("reload_ignoring_cache");
    expect(resolveBrowserShortcutInput({ code: "NumpadSubtract", control: true }, { isMac: false })).toBe("zoom_out");
    expect(resolveBrowserShortcutInput({ code: "Numpad0", control: true }, { isMac: false })).toBe("zoom_reset");
  });

  it("requires the exact platform modifier and supported shift combinations", () => {
    expect(resolveBrowserShortcutInput({ key: "r", control: true }, { isMac: true })).toBeNull();
    expect(resolveBrowserShortcutInput({ key: "r", meta: true }, { isMac: false })).toBeNull();
    expect(resolveBrowserShortcutInput({ key: "r", meta: true, control: true }, { isMac: true })).toBeNull();
    expect(resolveBrowserShortcutInput({ key: "t", meta: true, shift: true }, { isMac: true })).toBeNull();
    expect(resolveBrowserShortcutInput({ key: "l", meta: true, alt: true }, { isMac: true })).toBeNull();
    expect(resolveBrowserShortcutInput({ type: "keyUp", key: "r", meta: true }, { isMac: true })).toBeNull();
    expect(resolveBrowserShortcutInput({ key: "w", meta: true }, { isMac: true })).toBeNull();
  });

  it("validates actions crossing the Desktop IPC boundary", () => {
    expect(isBrowserShortcutAction("zoom_in")).toBe(true);
    expect(isBrowserShortcutAction("close_window")).toBe(false);
  });
});
