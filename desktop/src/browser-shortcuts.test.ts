import { describe, expect, it } from "vitest";
import { isDesktopBrowserShortcutAction, resolveDesktopBrowserShortcutInput } from "./browser-shortcuts.js";

describe("Desktop browser shortcut resolver", () => {
  it("resolves normal and hard reload in precedence order", () => {
    expect(resolveDesktopBrowserShortcutInput({ key: "r", meta: true }, "darwin")).toBe("reload");
    expect(resolveDesktopBrowserShortcutInput({ key: "r", meta: true, shift: true }, "darwin")).toBe("reload_ignoring_cache");
    expect(resolveDesktopBrowserShortcutInput({ key: "r", control: true, shift: true }, "linux")).toBe("reload_ignoring_cache");
  });

  it("supports address, tabs, history and browser zoom key variants", () => {
    expect(resolveDesktopBrowserShortcutInput({ code: "KeyT", meta: true }, "darwin")).toBe("new_tab");
    expect(resolveDesktopBrowserShortcutInput({ code: "KeyL", control: true }, "win32")).toBe("focus_location");
    expect(resolveDesktopBrowserShortcutInput({ code: "BracketLeft", meta: true }, "darwin")).toBe("go_back");
    expect(resolveDesktopBrowserShortcutInput({ code: "BracketRight", control: true }, "linux")).toBe("go_forward");
    expect(resolveDesktopBrowserShortcutInput({ key: "=", meta: true }, "darwin")).toBe("zoom_in");
    expect(resolveDesktopBrowserShortcutInput({ key: "+", code: "Equal", meta: true, shift: true }, "darwin")).toBe("zoom_in");
    expect(resolveDesktopBrowserShortcutInput({ code: "NumpadAdd", control: true }, "win32")).toBe("zoom_in");
    expect(resolveDesktopBrowserShortcutInput({ code: "NumpadSubtract", control: true }, "win32")).toBe("zoom_out");
    expect(resolveDesktopBrowserShortcutInput({ code: "Numpad0", control: true }, "win32")).toBe("zoom_reset");
  });

  it("rejects key releases and conflicting modifiers", () => {
    expect(resolveDesktopBrowserShortcutInput({ type: "keyUp", key: "t", meta: true }, "darwin")).toBeNull();
    expect(resolveDesktopBrowserShortcutInput({ key: "t", meta: true, control: true }, "darwin")).toBeNull();
    expect(resolveDesktopBrowserShortcutInput({ key: "l", meta: true, alt: true }, "darwin")).toBeNull();
    expect(resolveDesktopBrowserShortcutInput({ key: "t", meta: true, shift: true }, "darwin")).toBeNull();
    expect(isDesktopBrowserShortcutAction("zoom_reset")).toBe(true);
    expect(isDesktopBrowserShortcutAction("quit")).toBe(false);
  });
});
