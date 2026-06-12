// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  eventMatchesShortcutAction,
  findShortcutConflict,
  formatShortcutBinding,
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
  it("falls back to default bindings when settings are missing", () => {
    expect(eventMatchesShortcutAction(keydown("c"), "issue.create", null)).toBe(true);
    expect(eventMatchesShortcutAction(keydown("k", { metaKey: true }), "commandPalette.open", null)).toBe(true);
    expect(eventMatchesShortcutAction(keydown("k", { metaKey: true }), "commandPalette.open", undefined)).toBe(false);
  });

  it("disables actions from preferences", () => {
    const settings = {
      shortcuts: [{ actionId: "issue.create" as const, disabled: true }],
    };

    expect(resolveKeyboardShortcutBindings(settings)["issue.create"]).toEqual([]);
    expect(eventMatchesShortcutAction(keydown("c"), "issue.create", settings)).toBe(false);
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
    expect(
      findShortcutConflict("issue.create", { key: "k", metaKey: true }, { shortcuts: [] }),
    ).toBe("commandPalette.open");
    expect(isReservedShortcut({ key: "l", metaKey: true })).toBe(true);
  });

  it("formats shortcuts for display", () => {
    expect(formatShortcutBinding({ key: ",", ctrlKey: true })).toContain("Ctrl");
  });
});
