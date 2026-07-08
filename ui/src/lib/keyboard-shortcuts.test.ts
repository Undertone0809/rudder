// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  eventMatchesShortcutAction,
  findShortcutConflict,
  formatShortcutBinding,
  getKeyboardShortcutPlatform,
  isReservedShortcut,
  resolveKeyboardShortcutBindings,
} from "./keyboard-shortcuts";

function keydown(key: string, init: KeyboardEventInit = {}) {
  return new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
}

describe("keyboard shortcuts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to default bindings when settings are missing", () => {
    expect(eventMatchesShortcutAction(keydown("c"), "issue.create", null)).toBe(false);
    expect(eventMatchesShortcutAction(keydown("s", { code: "KeyS", metaKey: true, altKey: true }), "chat.create", null, "mac")).toBe(true);
    expect(eventMatchesShortcutAction(keydown("k", { code: "KeyK", metaKey: true }), "commandPalette.open", null, "mac")).toBe(true);
    expect(eventMatchesShortcutAction(keydown("k", { metaKey: true }), "commandPalette.open", undefined)).toBe(false);
  });

  it("detects macOS from browser userAgentData platform casing", () => {
    vi.stubGlobal("navigator", { userAgentData: { platform: "macOS" }, platform: "Win32" });

    expect(getKeyboardShortcutPlatform()).toBe("mac");
    expect(formatShortcutBinding({ key: "k", metaKey: true })).toBe("⌘K");
    expect(resolveKeyboardShortcutBindings(null)["commandPalette.open"]).toEqual([
      { key: "k", code: "KeyK", metaKey: true },
    ]);
  });

  it("resolves platform-specific default bindings without mixing Mac and non-Mac variants", () => {
    expect(resolveKeyboardShortcutBindings(null, "mac")["commandPalette.open"]).toEqual([
      { key: "k", code: "KeyK", metaKey: true },
    ]);
    expect(resolveKeyboardShortcutBindings(null, "nonMac")["commandPalette.open"]).toEqual([
      { key: "k", code: "KeyK", ctrlKey: true },
    ]);
    expect(resolveKeyboardShortcutBindings(null, "nonMac")["issue.create"]).toEqual([
      { key: "n", code: "KeyN", ctrlKey: true },
    ]);
    expect(resolveKeyboardShortcutBindings(null, "mac")["chat.create"]).toEqual([
      { key: "s", code: "KeyS", metaKey: true, altKey: true },
    ]);
    expect(eventMatchesShortcutAction(keydown("n", { code: "KeyN", ctrlKey: true }), "issue.create", null, "nonMac")).toBe(true);
    expect(eventMatchesShortcutAction(keydown("n", { code: "KeyN", metaKey: true }), "issue.create", null, "nonMac")).toBe(false);
    expect(eventMatchesShortcutAction(keydown("s", { code: "KeyS", ctrlKey: true, altKey: true }), "chat.create", null, "nonMac")).toBe(true);
  });

  it("matches shortcut defaults by physical key code when Option changes the reported key", () => {
    expect(eventMatchesShortcutAction(keydown("ß", { code: "KeyS", metaKey: true, altKey: true }), "chat.create", null, "mac")).toBe(true);
    expect(eventMatchesShortcutAction(keydown("ß", { code: "KeyA", metaKey: true, altKey: true }), "chat.create", null, "mac")).toBe(false);
  });

  it("falls back to the current create-chat default when legacy chat defaults are persisted", () => {
    const legacySettings = {
      shortcuts: [
        {
          actionId: "chat.create" as const,
          bindings: [
            { key: "n", metaKey: true },
            { key: "o", metaKey: true, shiftKey: true },
          ],
        },
      ],
    };

    expect(resolveKeyboardShortcutBindings(legacySettings, "mac")["chat.create"]).toEqual([
      { key: "s", code: "KeyS", metaKey: true, altKey: true },
    ]);
    expect(eventMatchesShortcutAction(keydown("s", { code: "KeyS", metaKey: true, altKey: true }), "chat.create", legacySettings, "mac")).toBe(true);
    expect(eventMatchesShortcutAction(keydown("n", { metaKey: true }), "chat.create", legacySettings, "mac")).toBe(false);
  });

  it("disables actions from preferences", () => {
    const settings = {
      shortcuts: [{ actionId: "issue.create" as const, disabled: true }],
    };

    expect(resolveKeyboardShortcutBindings(settings)["issue.create"]).toEqual([]);
    expect(eventMatchesShortcutAction(keydown("n", { metaKey: true }), "issue.create", settings, "mac")).toBe(false);
  });

  it("uses custom bindings instead of defaults", () => {
    const settings = {
      shortcuts: [
        {
          actionId: "issue.create" as const,
          bindings: [{ key: "i", metaKey: true }],
        },
      ],
    };

    expect(eventMatchesShortcutAction(keydown("i", { metaKey: true }), "issue.create", settings)).toBe(true);
    expect(eventMatchesShortcutAction(keydown("c"), "issue.create", settings)).toBe(false);
  });

  it("detects conflicts and reserved shortcuts", () => {
    expect(findShortcutConflict("issue.create", { key: "k", metaKey: true }, { shortcuts: [] }, "mac"))
      .toBe("commandPalette.open");
    expect(isReservedShortcut({ key: "l", metaKey: true })).toBe(true);
  });

  it("formats shortcuts for display", () => {
    expect(formatShortcutBinding({ key: "a", metaKey: true, shiftKey: true }, "mac")).toBe("⇧⌘A");
    expect(formatShortcutBinding({ key: "s", metaKey: true, altKey: true }, "mac")).toBe("⌥⌘S");
    expect(formatShortcutBinding({ key: ",", ctrlKey: true }, "nonMac")).toContain("Ctrl");
  });
});
