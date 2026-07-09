import { describe, expect, it } from "vitest";
import { isSidePanelCloseShortcutInput } from "./side-panel-close-shortcut.js";

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
});
