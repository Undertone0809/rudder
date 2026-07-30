import { describe, expect, it } from "vitest";
import { shouldOverrideDesktopDockIcon } from "./app-icon.js";

describe("desktop app icon", () => {
  it("keeps the bundle icon after a packaged macOS app launches", () => {
    expect(shouldOverrideDesktopDockIcon("darwin", true)).toBe(false);
  });

  it("allows macOS development to use its environment-specific Dock icon", () => {
    expect(shouldOverrideDesktopDockIcon("darwin", false)).toBe(true);
  });

  it("does not use the Dock icon API on non-macOS platforms", () => {
    expect(shouldOverrideDesktopDockIcon("win32", true)).toBe(false);
    expect(shouldOverrideDesktopDockIcon("linux", false)).toBe(false);
  });
});
