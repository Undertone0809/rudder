import { describe, expect, it } from "vitest";
import {
  BROWSER_SIDE_PANEL_BLANK_URL,
  browserSidePanelLabel,
  createBrowserSidePanelTarget,
  normalizeBrowserSidePanelUrl,
} from "./browser-side-panel";

describe("Browser Side Panel targets", () => {
  it("normalizes URLs, local file URLs, and search input without allowing privileged protocols", () => {
    expect(normalizeBrowserSidePanelUrl("example.com/docs")).toBe("https://example.com/docs");
    expect(normalizeBrowserSidePanelUrl("localhost:4173/app")).toBe("http://localhost:4173/app");
    expect(normalizeBrowserSidePanelUrl("browser automation")).toBe("https://www.google.com/search?q=browser%20automation");
    expect(normalizeBrowserSidePanelUrl("file:///tmp/private.txt")).toBe("file:///tmp/private.txt");
    expect(normalizeBrowserSidePanelUrl("file:///C:/Users/example/report.html"))
      .toBe("file:///C:/Users/example/report.html");
    expect(normalizeBrowserSidePanelUrl("file://remote-host/share/private.txt"))
      .toBe("https://www.google.com/search?q=file%3A%2F%2Fremote-host%2Fshare%2Fprivate.txt");
    expect(normalizeBrowserSidePanelUrl("file:relative.txt"))
      .toBe("https://www.google.com/search?q=file%3Arelative.txt");
    expect(normalizeBrowserSidePanelUrl("javascript:alert(1)")).toBe(
      "https://www.google.com/search?q=javascript%3Aalert(1)",
    );
    expect(normalizeBrowserSidePanelUrl("")).toBe(BROWSER_SIDE_PANEL_BLANK_URL);
  });

  it.each([
    "file:////server/share/private.txt",
    "file:///\\\\server\\share\\private.txt",
    "file:///%2F%2Fserver/share/private.txt",
    "file:///%5C%5Cserver%5Cshare%5Cprivate.txt",
  ])("searches instead of navigating UNC-equivalent file URL %s", (target) => {
    expect(normalizeBrowserSidePanelUrl(target))
      .toBe(`https://www.google.com/search?q=${encodeURIComponent(target)}`);
  });

  it("keeps tab identity unique while giving ordinary links a stable URL dedupe key", () => {
    const linked = createBrowserSidePanelTarget("https://example.com", { newTab: false });
    const repeatedLink = createBrowserSidePanelTarget("https://example.com", { newTab: false });
    const firstPopup = createBrowserSidePanelTarget("https://example.com", { newTab: true });
    const secondPopup = createBrowserSidePanelTarget("https://example.com", { newTab: true });

    expect(linked.tabId).not.toBe(repeatedLink.tabId);
    expect(linked.dedupeKey).toBe("https://example.com/");
    expect(repeatedLink.dedupeKey).toBe(linked.dedupeKey);
    expect(firstPopup.tabId).toBeTruthy();
    expect(secondPopup.tabId).not.toBe(firstPopup.tabId);
    expect(linked.label).toBe("example.com");
    expect(createBrowserSidePanelTarget("file:///tmp/private.txt").label).toBe("private.txt");
    expect(browserSidePanelLabel(BROWSER_SIDE_PANEL_BLANK_URL)).toBe("New tab");
  });
});
