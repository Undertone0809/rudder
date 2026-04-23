import { describe, expect, it } from "vitest";
import { readDesktopCapabilities } from "./desktop-capabilities.js";

describe("readDesktopCapabilities", () => {
  it("defaults optional desktop channels to unsupported when boot state omits them", () => {
    expect(readDesktopCapabilities(undefined)).toEqual({
      badgeCount: false,
      notifications: false,
    });
  });

  it("preserves explicit desktop capability flags", () => {
    expect(readDesktopCapabilities({
      capabilities: {
        badgeCount: true,
        notifications: true,
      },
    })).toEqual({
      badgeCount: true,
      notifications: true,
    });
  });
});
