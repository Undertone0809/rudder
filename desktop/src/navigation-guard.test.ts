import { describe, expect, it } from "vitest";
import {
  canOpenBlockedNavigationExternally,
  collectDesktopNavigationOrigins,
  isAllowedDesktopNavigation,
  isAllowedDesktopPrivilegedDocument,
  isAllowedDesktopWebviewNavigation,
  normalizeExternalOpenTarget,
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
  });

  it("does not open unsafe blocked protocols externally", () => {
    expect(canOpenBlockedNavigationExternally("javascript:alert(1)")).toBe(false);
    expect(canOpenBlockedNavigationExternally("file:///Users/zeeland/.ssh/id_rsa")).toBe(false);
  });

  it("normalizes only explicit safe external protocols", () => {
    expect(normalizeExternalOpenTarget(" https://example.com/docs ")).toBe("https://example.com/docs");
    expect(normalizeExternalOpenTarget("mailto:security@example.com?subject=Report")).toBe(
      "mailto:security@example.com?subject=Report",
    );
    expect(normalizeExternalOpenTarget("https://user:password@example.com/private")).toBeNull();
    expect(normalizeExternalOpenTarget("https://example.com/\nfile:///etc/passwd")).toBeNull();
    expect(normalizeExternalOpenTarget("mailto:security@example.com?subject=Report%0ABcc:attacker@example.com")).toBeNull();
    expect(normalizeExternalOpenTarget({ href: "https://example.com" })).toBeNull();
  });

  it("allows webviews to load only credential-free HTTP(S) pages", () => {
    expect(isAllowedDesktopWebviewNavigation("https://example.com/docs")).toBe(true);
    expect(isAllowedDesktopWebviewNavigation("http://example.com/")).toBe(true);
    expect(isAllowedDesktopWebviewNavigation("data:text/html,<h1>unsafe</h1>")).toBe(false);
    expect(isAllowedDesktopWebviewNavigation("file:///Users/zeeland/.ssh/id_rsa")).toBe(false);
    expect(isAllowedDesktopWebviewNavigation("about:blank")).toBe(false);
  });

  it("trusts app documents but not same-origin API or plugin responses", () => {
    const origins = ["http://127.0.0.1:3100"];

    expect(isAllowedDesktopPrivilegedDocument("http://127.0.0.1:3100/messenger/chat/abc", origins)).toBe(true);
    expect(isAllowedDesktopPrivilegedDocument("http://127.0.0.1:3100/api/assets/asset-1/content", origins)).toBe(false);
    expect(isAllowedDesktopPrivilegedDocument("http://127.0.0.1:3100/_plugins/example/index.html", origins)).toBe(false);
    expect(isAllowedDesktopPrivilegedDocument("http://127.0.0.1:3100/API/assets/asset-1/content", origins)).toBe(false);
    expect(isAllowedDesktopPrivilegedDocument("http://127.0.0.1:3100/_PLUGINS/example/index.html", origins)).toBe(false);
    expect(isAllowedDesktopPrivilegedDocument("http://127.0.0.1:3100/api%5Cassets/payload.html", origins)).toBe(false);
    expect(isAllowedDesktopPrivilegedDocument("http://127.0.0.1:3100/%2561pi/assets/payload.html", origins)).toBe(false);
    expect(isAllowedDesktopPrivilegedDocument("https://example.com/messenger", origins)).toBe(false);
  });
});
