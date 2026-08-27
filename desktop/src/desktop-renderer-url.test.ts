import { describe, expect, it } from "vitest";
import { resolveDesktopRendererBaseUrl } from "./desktop-renderer-url.js";

describe("resolveDesktopRendererBaseUrl", () => {
  it("uses the standalone renderer origin without carrying a route", () => {
    expect(resolveDesktopRendererBaseUrl({
      runtimeBaseUrl: "http://127.0.0.1:3100",
      loadUrlOverride: "http://127.0.0.1:5173/messenger",
    })).toBe("http://127.0.0.1:5173");
  });

  it("falls back to the runtime for invalid or non-web overrides", () => {
    expect(resolveDesktopRendererBaseUrl({
      runtimeBaseUrl: "http://127.0.0.1:3100/",
      loadUrlOverride: "not a url",
    })).toBe("http://127.0.0.1:3100");
    expect(resolveDesktopRendererBaseUrl({
      runtimeBaseUrl: "http://127.0.0.1:3100",
      loadUrlOverride: "data:text/html,test",
    })).toBe("http://127.0.0.1:3100");
  });
});
