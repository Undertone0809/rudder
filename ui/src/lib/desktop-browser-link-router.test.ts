import { describe, expect, it, vi } from "vitest";
import { routeDesktopWebLink } from "./desktop-browser-link-router";

describe("Desktop Browser link router", () => {
  it("opens built-in links in a stable Side Panel tab by default", async () => {
    const openBuiltIn = vi.fn();
    const forceOpenExternal = vi.fn();
    const resolveFavicon = vi.fn(() => "data:image/png;base64,aWNvbg==");

    await expect(routeDesktopWebLink({
      request: { url: "https://example.com/docs", source: "link" },
      getSettings: async () => ({ enabled: true, openLinksIn: "built_in" }),
      openBuiltIn,
      forceOpenExternal,
      resolveFavicon,
    })).resolves.toBe("built_in");

    expect(openBuiltIn).toHaveBeenCalledWith(expect.objectContaining({
      kind: "browser",
      favicon: "data:image/png;base64,aWNvbg==",
      url: "https://example.com/docs",
    }));
    expect(resolveFavicon).toHaveBeenCalledWith("https://example.com/docs");
    expect(openBuiltIn.mock.calls[0]?.[0]).toMatchObject({ dedupeKey: "https://example.com/docs" });
    expect(forceOpenExternal).not.toHaveBeenCalled();
  });

  it("opens Browser popup requests as distinct tabs", async () => {
    const openBuiltIn = vi.fn();
    await routeDesktopWebLink({
      request: { url: "https://example.com/popup", source: "browser_popup" },
      getSettings: async () => ({ enabled: true, openLinksIn: "built_in" }),
      openBuiltIn,
      forceOpenExternal: vi.fn(),
    });

    expect(openBuiltIn).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://example.com/popup",
      tabId: expect.any(String),
    }));
  });

  it("rejects file requests from renderer links and Browser popups", async () => {
    const openBuiltIn = vi.fn();
    const forceOpenExternal = vi.fn();
    for (const source of ["link", "browser_popup"] as const) {
      await expect(routeDesktopWebLink({
        request: { url: "file:///tmp/report.html", source },
        getSettings: async () => ({ enabled: true, openLinksIn: "built_in" }),
        openBuiltIn,
        forceOpenExternal,
      })).resolves.toBe("ignored");
    }

    expect(openBuiltIn).not.toHaveBeenCalled();
    expect(forceOpenExternal).not.toHaveBeenCalled();
  });

  it("keeps Browser popups in the Side Panel when ordinary links use the system browser", async () => {
    const openBuiltIn = vi.fn();
    const forceOpenExternal = vi.fn();

    await expect(routeDesktopWebLink({
      request: { url: "https://example.com/popup", source: "browser_popup" },
      getSettings: async () => ({ enabled: true, openLinksIn: "default_browser" }),
      openBuiltIn,
      forceOpenExternal,
    })).resolves.toBe("built_in");

    expect(openBuiltIn).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://example.com/popup",
      tabId: expect.any(String),
    }));
    expect(forceOpenExternal).not.toHaveBeenCalled();
  });

  it("keeps ordinary link routing independent from Agent Browser access", async () => {
    const openBuiltIn = vi.fn();
    const forceOpenExternal = vi.fn();

    await expect(routeDesktopWebLink({
      request: { url: "https://example.com", source: "link" },
      getSettings: async () => ({ enabled: false, openLinksIn: "built_in" }),
      openBuiltIn,
      forceOpenExternal,
    })).resolves.toBe("built_in");

    expect(openBuiltIn).toHaveBeenCalledWith(expect.objectContaining({
      kind: "browser",
      url: "https://example.com",
    }));
    expect(forceOpenExternal).not.toHaveBeenCalled();
  });

  it("uses the system browser when configured or settings cannot be loaded", async () => {
    for (const getSettings of [
      async () => ({ enabled: true, openLinksIn: "default_browser" as const }),
      async () => { throw new Error("offline"); },
    ]) {
      const openBuiltIn = vi.fn();
      const forceOpenExternal = vi.fn(async () => undefined);
      await expect(routeDesktopWebLink({
        request: { url: "https://example.com", source: "link" },
        getSettings,
        openBuiltIn,
        forceOpenExternal,
      })).resolves.toBe("default_browser");
      expect(openBuiltIn).not.toHaveBeenCalled();
      expect(forceOpenExternal).toHaveBeenCalledWith("https://example.com");
    }
  });

  it("rejects unsupported protocol requests without opening either browser", async () => {
    const openBuiltIn = vi.fn();
    const forceOpenExternal = vi.fn();
    await expect(routeDesktopWebLink({
      request: { url: "javascript:alert(1)", source: "link" },
      getSettings: async () => ({ enabled: true, openLinksIn: "built_in" }),
      openBuiltIn,
      forceOpenExternal,
    })).resolves.toBe("ignored");
    expect(openBuiltIn).not.toHaveBeenCalled();
    expect(forceOpenExternal).not.toHaveBeenCalled();
  });
});
