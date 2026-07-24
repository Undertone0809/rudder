import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebsiteMetadata } from "../api/websiteMetadata";
import {
  __clearWebsiteMetadataCacheForTests,
  canRequestWebsiteMetadata,
  getWebsiteMetadata,
} from "./website-metadata-cache";

const websiteMetadataApiMocks = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("../api/websiteMetadata", () => ({
  websiteMetadataApi: websiteMetadataApiMocks,
}));

function metadata(url: string, pageTitle: string | null): WebsiteMetadata {
  return {
    url,
    siteName: "Example",
    pageTitle,
    iconUrl: null,
  };
}

beforeEach(() => {
  websiteMetadataApiMocks.get.mockReset();
});

afterEach(() => {
  __clearWebsiteMetadataCacheForTests();
  vi.unstubAllGlobals();
});

describe("website metadata cache", () => {
  it("deduplicates concurrent requests for the exact URL and purpose", async () => {
    const url = "https://example.test/inflight";
    let resolveMetadata!: (value: WebsiteMetadata) => void;
    websiteMetadataApiMocks.get.mockReturnValue(new Promise((resolve) => {
      resolveMetadata = resolve;
    }));

    const first = getWebsiteMetadata(url, "authoring");
    const second = getWebsiteMetadata(url, "authoring");
    resolveMetadata(metadata(url, "Inflight title"));

    await expect(Promise.all([first, second])).resolves.toEqual([
      metadata(url, "Inflight title"),
      metadata(url, "Inflight title"),
    ]);
    expect(websiteMetadataApiMocks.get).toHaveBeenCalledTimes(1);
  });

  it("keeps preview and authoring entries distinct for the same exact URL", async () => {
    const url = "https://example.test/purposes";
    websiteMetadataApiMocks.get
      .mockResolvedValueOnce(metadata(url, null))
      .mockResolvedValueOnce(metadata(url, "Authoring title"));

    await expect(getWebsiteMetadata(url, "preview"))
      .resolves.toEqual(metadata(url, null));
    await expect(getWebsiteMetadata(url, "authoring"))
      .resolves.toEqual(metadata(url, "Authoring title"));

    expect(websiteMetadataApiMocks.get).toHaveBeenNthCalledWith(1, url, "preview");
    expect(websiteMetadataApiMocks.get).toHaveBeenNthCalledWith(2, url, "authoring");
  });

  it("clears resolved metadata between tests", async () => {
    const url = "https://example.test/clear";
    websiteMetadataApiMocks.get.mockResolvedValue(metadata(url, "Cached title"));

    await getWebsiteMetadata(url, "authoring");
    await getWebsiteMetadata(url, "authoring");
    expect(websiteMetadataApiMocks.get).toHaveBeenCalledTimes(1);

    __clearWebsiteMetadataCacheForTests();

    await getWebsiteMetadata(url, "authoring");
    expect(websiteMetadataApiMocks.get).toHaveBeenCalledTimes(2);
  });

  it("delegates to the Rudder API without directly fetching the website", async () => {
    const url = "https://example.test/api-only";
    websiteMetadataApiMocks.get.mockResolvedValue(metadata(url, "API title"));
    const fetchSpy = vi.fn().mockRejectedValue(new Error("direct fetch is forbidden"));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(getWebsiteMetadata(url, "authoring"))
      .resolves.toEqual(metadata(url, "API title"));

    expect(websiteMetadataApiMocks.get).toHaveBeenCalledWith(url, "authoring");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    "http://localhost:3100/library",
    "http://127.0.0.1/private",
    "http://10.0.0.8/private",
    "http://[::1]/private",
    "https://rudder.internal/private",
    "https://user:secret@example.test/private",
  ])("does not request metadata for an obviously unsafe target: %s", async (url) => {
    await expect(getWebsiteMetadata(url, "authoring")).resolves.toMatchObject({
      url,
      pageTitle: null,
      iconUrl: null,
    });
    expect(websiteMetadataApiMocks.get).not.toHaveBeenCalled();
  });

  it("does not request metadata for the current Rudder origin", () => {
    expect(canRequestWebsiteMetadata(
      "https://rudder.example.test/library",
      "https://rudder.example.test",
    )).toBe(false);
    expect(canRequestWebsiteMetadata(
      "https://public.example.test/article",
      "https://rudder.example.test",
    )).toBe(true);
  });

  it("expires cached metadata and ignores URL fragments in the cache identity", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const firstUrl = "https://example.test/article#one";
    websiteMetadataApiMocks.get.mockResolvedValue(metadata(firstUrl, "First"));

    await getWebsiteMetadata(firstUrl, "preview");
    await getWebsiteMetadata("https://example.test/article#two", "preview");
    expect(websiteMetadataApiMocks.get).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000 + 10 * 60 * 1000 + 1);
    websiteMetadataApiMocks.get.mockResolvedValue(
      metadata("https://example.test/article#three", "Fresh"),
    );
    await getWebsiteMetadata("https://example.test/article#three", "preview");
    expect(websiteMetadataApiMocks.get).toHaveBeenCalledTimes(2);
  });

  it("bounds resolved metadata entries with least-recently-used eviction", async () => {
    websiteMetadataApiMocks.get.mockImplementation(async (url: string) => (
      metadata(url, "Title")
    ));

    for (let index = 0; index <= 256; index += 1) {
      await getWebsiteMetadata(`https://example.test/${index}`, "preview");
    }
    await getWebsiteMetadata("https://example.test/0", "preview");

    expect(websiteMetadataApiMocks.get).toHaveBeenCalledTimes(258);
  });

  it("does not retain authoring-only favicon payloads", async () => {
    const url = "https://example.test/authoring";
    websiteMetadataApiMocks.get.mockResolvedValue({
      ...metadata(url, "Authoring title"),
      iconUrl: "data:image/png;base64,large",
    });

    await expect(getWebsiteMetadata(url, "authoring")).resolves.toMatchObject({
      pageTitle: "Authoring title",
      iconUrl: null,
    });
    await expect(getWebsiteMetadata(url, "authoring")).resolves.toMatchObject({
      pageTitle: "Authoring title",
      iconUrl: null,
    });
    expect(websiteMetadataApiMocks.get).toHaveBeenCalledTimes(1);
  });
});
