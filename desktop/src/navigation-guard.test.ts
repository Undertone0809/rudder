import { describe, expect, it } from "vitest";
import {
  canOpenBlockedNavigationExternally,
  classifyBlockedDesktopNavigation,
  collectDesktopNavigationOrigins,
  isAllowedDesktopNavigation,
  sanitizeDesktopNavigationForLog,
} from "./navigation-guard.js";

describe("desktop navigation guard", () => {
  it("collects distinct app origins from desktop runtime URLs", () => {
    expect(collectDesktopNavigationOrigins("http://127.0.0.1:3100/api", "http://127.0.0.1:3100/messenger")).toEqual([
      "http://127.0.0.1:3100",
    ]);
  });

  it("allows same-origin app routes and recovery screens", () => {
    const origins = ["http://127.0.0.1:3100"];

    expect(isAllowedDesktopNavigation("http://127.0.0.1:3100/messenger/chat/abc", origins)).toBe(true);
    expect(isAllowedDesktopNavigation("data:text/html,Rudder%20is%20loading", origins)).toBe(true);
  });

  it("blocks renderer-initiated data URL navigation", () => {
    expect(isAllowedDesktopNavigation("data:text/html,not%20the%20app", ["http://127.0.0.1:3100"], {
      allowInternalProtocols: false,
    })).toBe(false);
  });

  it("blocks external web links but marks them safe for OS browser opening", () => {
    const target = "https://gingiris.github.io/growth-tools/blog/2026/04/02/github-readme-template-guide/";

    expect(isAllowedDesktopNavigation(target, ["http://127.0.0.1:3100"])).toBe(false);
    expect(canOpenBlockedNavigationExternally(target)).toBe(true);
    expect(classifyBlockedDesktopNavigation(target)).toBe("browser_router");
  });

  it("keeps non-web external protocols on their explicit system path", () => {
    expect(classifyBlockedDesktopNavigation("mailto:hello@example.com")).toBe("external");
    expect(classifyBlockedDesktopNavigation("file:///tmp/private.txt")).toBe("deny");
  });

  it("does not open unsafe blocked protocols externally", () => {
    expect(canOpenBlockedNavigationExternally("javascript:alert(1)")).toBe(false);
    expect(canOpenBlockedNavigationExternally("file:///Users/zeeland/.ssh/id_rsa")).toBe(false);
  });

  it("sanitizes navigation log targets without query credentials", () => {
    expect(sanitizeDesktopNavigationForLog("https://example.com/path?token=secret#private"))
      .toBe("https://example.com");
    expect(sanitizeDesktopNavigationForLog("mailto:secret@example.com")).toBe("non-web URL");
    expect(sanitizeDesktopNavigationForLog("not a URL")).toBe("invalid URL");
  });
});
