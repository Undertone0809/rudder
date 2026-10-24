import { describe, expect, it, vi } from "vitest";
import {
  checkForRudderDesktopUpdates,
  chooseLatestRelease,
  compareRudderVersions,
  normalizeReleaseVersion,
  requiredDesktopUpdateAssetNames,
  resolveUpdateChannel,
} from "./update-check.js";

describe("desktop update checks", () => {
  it("normalizes only stable release tags", () => {
    expect(normalizeReleaseVersion("v0.1.0")).toBe("0.1.0");
    expect(normalizeReleaseVersion("0.2.0")).toBe("0.2.0");
    expect(normalizeReleaseVersion("v0.1.0-canary.4")).toBeNull();
    expect(normalizeReleaseVersion("canary/v0.1.0-canary.4")).toBeNull();
    expect(normalizeReleaseVersion("v0.1.0-beta.1")).toBeNull();
  });

  it("normalizes canary release tags for canary builds", () => {
    expect(normalizeReleaseVersion("canary/v0.1.0-canary.4", "canary")).toBe("0.1.0");
    expect(normalizeReleaseVersion("canary%2Fv0.1.0-canary.4", "canary")).toBe("0.1.0");
    expect(normalizeReleaseVersion("v0.1.0", "canary")).toBe("0.1.0");
    expect(normalizeReleaseVersion("v0.1.0-beta.1", "canary")).toBeNull();
  });

  it("treats stable releases as newer than prereleases with the same base version", () => {
    expect(compareRudderVersions("0.1.0", "0.1.0-canary.14")).toBeGreaterThan(0);
    expect(compareRudderVersions("0.1.0", "0.1.0-beta.1")).toBeGreaterThan(0);
    expect(compareRudderVersions("0.2.0-canary.1", "0.1.0")).toBeGreaterThan(0);
  });

  it("compares numeric prerelease identifiers semantically", () => {
    expect(compareRudderVersions("0.1.0-canary.32", "0.1.0-canary.9")).toBeGreaterThan(0);
  });

  it("resolves the update channel from the running version", () => {
    expect(resolveUpdateChannel("0.1.0")).toBe("stable");
    expect(resolveUpdateChannel("0.1.0-beta.1")).toBe("stable");
    expect(resolveUpdateChannel("0.1.0-canary.18")).toBe("canary");
  });

  it("chooses the highest stable release and ignores canary or beta releases", () => {
    expect(chooseLatestRelease([
      { tag_name: "v0.3.0-canary.1", prerelease: true, html_url: "canary" },
      { tag_name: "v0.2.0-beta.1", prerelease: true, html_url: "beta" },
      { tag_name: "v0.1.0", prerelease: false, html_url: "stable-old" },
      { tag_name: "v0.2.0", prerelease: false, html_url: "stable-new" },
    ])).toEqual({
      version: "0.2.0",
      releaseUrl: "stable-new",
    });
  });

  it("chooses the highest release across stable and canary when canary is selected", () => {
    expect(chooseLatestRelease([
      { tag_name: "canary/v0.1.0-canary.9", prerelease: true, html_url: "canary-old" },
      { tag_name: "canary/v0.2.0-canary.32", prerelease: true, html_url: "canary-new" },
      { tag_name: "v0.2.1", prerelease: false, html_url: "stable" },
    ], "canary")).toEqual({
      version: "0.2.1",
      releaseUrl: "stable",
    });
  });

  it("defaults update checks to stable even when the running version is canary", async () => {
    const result = await checkForRudderDesktopUpdates({
      currentVersion: "0.1.0-canary.14",
      appName: "Rudder",
      repo: "example/rudder",
      releasesUrl: "https://example.test/releases",
      requiredAssetNamesForVersion: () => [],
      fetchImpl: async () => new Response(JSON.stringify([
        { tag_name: "v0.1.1-canary.1", prerelease: true, html_url: "canary" },
        { tag_name: "v0.1.0", prerelease: false, html_url: "stable" },
      ])),
    });

    expect(result.status).toBe("update-available");
    expect(result.channel).toBe("stable");
    expect(result.latestVersion).toBe("0.1.0");
    expect(result.releaseUrl).toBe("stable");
  });

  it("finds the stable release when recent canary releases fill the first API page", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      tag_name: `canary/v0.7.24-canary.${200 - index}`,
      prerelease: true,
      html_url: `canary-${200 - index}`,
    }));
    const requestedUrls: string[] = [];
    const result = await checkForRudderDesktopUpdates({
      currentVersion: "0.7.24-canary.23",
      appName: "Rudder",
      repo: "example/rudder",
      releasesUrl: "https://example.test/releases",
      requiredAssetNamesForVersion: () => [],
      fetchImpl: async (url) => {
        requestedUrls.push(String(url));
        return new Response(JSON.stringify(String(url).includes("page=2")
          ? [{ tag_name: "v0.7.23", prerelease: false, html_url: "stable" }]
          : firstPage));
      },
    });

    expect(result.status).toBe("up-to-date");
    expect(result.channel).toBe("stable");
    expect(result.latestVersion).toBe("0.7.23");
    expect(result.releaseUrl).toBe("stable");
    expect(requestedUrls).toEqual([
      "https://api.github.com/repos/example/rudder/releases?per_page=100&page=1",
      "https://api.github.com/repos/example/rudder/releases?per_page=100&page=2",
    ]);
  });

  it("finds an eligible canary release for the Stable + Canary channel", async () => {
    const version = "0.7.24-canary.32";
    const result = await checkForRudderDesktopUpdates({
      currentVersion: "0.7.24-canary.23",
      appName: "Rudder",
      repo: "example/rudder",
      releasesUrl: "https://example.test/releases",
      channel: "canary",
      fetchImpl: async () => new Response(JSON.stringify([
        {
          tag_name: `canary/v${version}`,
          prerelease: true,
          html_url: "canary-new",
          assets: requiredDesktopUpdateAssetNames(version, process.platform).map((name) => ({ name })),
        },
        {
          tag_name: "v0.7.23",
          prerelease: false,
          html_url: "stable",
          assets: requiredDesktopUpdateAssetNames("0.7.23", process.platform).map((name) => ({ name })),
        },
      ])),
    });

    expect(result).toMatchObject({
      status: "update-available",
      channel: "canary",
      currentVersion: "0.7.24-canary.23",
      latestVersion: version,
      releaseUrl: "canary-new",
    });
  });

  it("keeps a newer verified release from an earlier page if a later page fails", async () => {
    const version = "0.7.24-canary.32";
    const firstPage = Array.from({ length: 100 }, (_, index) => index === 0
      ? {
        tag_name: `canary/v${version}`,
        prerelease: true,
        html_url: "canary-new",
        assets: requiredDesktopUpdateAssetNames(version, process.platform).map((name) => ({ name })),
      }
      : {
        tag_name: `canary/v0.7.24-canary.${index}`,
        prerelease: true,
        html_url: `canary-${index}`,
      });
    const requestedUrls: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await checkForRudderDesktopUpdates({
        currentVersion: "0.7.24-canary.23",
        appName: "Rudder",
        repo: "example/rudder",
        releasesUrl: "https://example.test/releases",
        channel: "canary",
        fetchImpl: async (url) => {
          requestedUrls.push(String(url));
          return String(url).includes("page=2")
            ? new Response("temporarily unavailable", { status: 503 })
            : new Response(JSON.stringify(firstPage));
        },
      });

      expect(result).toMatchObject({
        status: "update-available",
        latestVersion: version,
        releaseUrl: "canary-new",
      });
      expect(requestedUrls).toHaveLength(2);
      expect(requestedUrls[0]).toContain("per_page=100&page=1");
      expect(requestedUrls[1]).toContain("per_page=100&page=2");
    } finally {
      warn.mockRestore();
    }
  });

  it("reports update availability against the latest stable or canary release when canary is selected", async () => {
    const result = await checkForRudderDesktopUpdates({
      currentVersion: "0.2.0-canary.41",
      appName: "Rudder",
      repo: "example/rudder",
      releasesUrl: "https://example.test/releases",
      channel: "canary",
      requiredAssetNamesForVersion: () => [],
      fetchImpl: async () => new Response(JSON.stringify([
        { tag_name: "canary/v0.2.0-canary.41", prerelease: true, html_url: "canary" },
        { tag_name: "v0.2.1", prerelease: false, html_url: "stable" },
      ])),
    });

    expect(result.status).toBe("update-available");
    expect(result.channel).toBe("canary");
    expect(result.latestVersion).toBe("0.2.1");
    expect(result.releaseUrl).toBe("stable");
  });

  it("falls back to the releases page when the GitHub API is rate-limited", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await checkForRudderDesktopUpdates({
        currentVersion: "0.1.0-canary.18",
        appName: "Rudder",
        repo: "example/rudder",
        releasesUrl: "https://github.com/example/rudder/releases",
        channel: "canary",
        requiredAssetNamesForVersion: () => [],
        fetchImpl: async (url) => {
          if (String(url).includes("api.github.com")) {
            return new Response("rate limited", { status: 403 });
          }
          return new Response(`
            <a href="/example/rudder/releases/tag/v0.1.1">stable 0.1.1</a>
            <a href="/example/rudder/releases/tag/canary%2Fv0.1.0-canary.31">canary 31</a>
            <a href="/example/rudder/releases/tag/canary%2Fv0.1.0-canary.32">canary 32</a>
          `);
        },
      });

      expect(result.status).toBe("update-available");
      expect(result.latestVersion).toBe("0.1.1");
      expect(result.releaseUrl).toBe("https://github.com/example/rudder/releases/tag/v0.1.1");
    } finally {
      warn.mockRestore();
    }
  });

  it("skips a newer release whose platform assets are still uploading", async () => {
    const portableAsset = (version: string) => requiredDesktopUpdateAssetNames(version, process.platform)[1];
    const result = await checkForRudderDesktopUpdates({
      currentVersion: "0.1.0",
      appName: "Rudder",
      repo: "example/rudder",
      releasesUrl: "https://example.test/releases",
      fetchImpl: async () => new Response(JSON.stringify([
        {
          tag_name: "v0.2.0",
          prerelease: false,
          html_url: "incomplete",
          assets: [{ name: "Rudder-0.2.0-linux-x64.AppImage" }],
        },
        {
          tag_name: "v0.1.1",
          prerelease: false,
          html_url: "complete",
          assets: [
            { name: "SHASUMS256.txt" },
            { name: portableAsset("0.1.1") },
          ],
        },
      ])),
    });

    expect(result.status).toBe("update-available");
    expect(result.latestVersion).toBe("0.1.1");
    expect(result.releaseUrl).toBe("complete");
  });

  it.each(["stable", "canary"] as const)("checks real platform assets in the %s HTML fallback after a 403", async (channel) => {
    const version = channel === "canary" ? "0.7.24-canary.48" : "0.7.24";
    const tag = channel === "canary" ? `canary/v${version}` : `v${version}`;
    const requests: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await checkForRudderDesktopUpdates({
        currentVersion: "0.7.24-canary.23", appName: "Rudder", repo: "example/rudder",
        releasesUrl: "https://github.com/example/rudder/releases", channel,
        fetchImpl: async (input, init) => {
          const url = String(input);
          requests.push(url);
          expect(init?.cache).toBe("no-store");
          if (url.includes("api.github.com")) return new Response("rate limited", { status: 403 });
          if (!url.includes("expanded_assets")) return new Response(`
            <a href="/example/rudder/releases/tag/%malformed">unrelated</a>
            <a href="/example/rudder/releases/tag/${encodeURIComponent(tag)}">release</a>
          `);
          return new Response(requiredDesktopUpdateAssetNames(version, process.platform).map((name) =>
            `<a href="/example/rudder/releases/download/${encodeURIComponent(tag)}/${name}">${name}</a>`,
          ).join(""));
        },
      });
      expect(result).toMatchObject({ status: "update-available", channel, latestVersion: version });
      expect(requests.at(-1)).toBe(`https://github.com/example/rudder/releases/expanded_assets/${encodeURIComponent(tag)}`);
    } finally { warn.mockRestore(); }
  });

  it.each(["incomplete", "failed", "missing", "wrong-release"])("handles a %s newer HTML asset lookup without inventing update availability", async (failure) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const currentVersion = "0.7.24-canary.47";
    try {
      const result = await checkForRudderDesktopUpdates({
        currentVersion, appName: "Rudder", repo: "example/rudder",
        releasesUrl: "https://github.com/example/rudder/releases", channel: "canary",
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.includes("api.github.com")) return new Response("rate limited", { status: 403 });
          if (!url.includes("expanded_assets")) return new Response([47, 48].map((number) =>
            `<a href="/example/rudder/releases/tag/canary%2Fv0.7.24-canary.${number}">release</a>`,
          ).join(""));
          const version = url.endsWith("48") ? "0.7.24-canary.48" : currentVersion;
          if (version.endsWith("48") && failure === "failed") return new Response("failed", { status: 503 });
          if (version.endsWith("48") && failure === "missing") return new Response("missing", { status: 404 });
          const tag = failure === "wrong-release" && version.endsWith("48")
            ? "canary/v0.7.24-canary.49" : `canary/v${version}`;
          return new Response(requiredDesktopUpdateAssetNames(version, process.platform)
            .filter((name) => !(version.endsWith("48") && failure === "incomplete" && name === "SHASUMS256.txt"))
            .map((name) => `<a href="/example/rudder/releases/download/${encodeURIComponent(tag)}/${name}">asset</a>`).join(""));
        },
      });
      expect(result.status).toBe(failure === "incomplete" ? "up-to-date" : "unavailable");
      expect(result.latestVersion).toBe(failure === "incomplete" ? currentVersion : undefined);
    } finally { warn.mockRestore(); }
  });

  it("does not advertise a release when the API and HTML fallback have no complete assets", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await checkForRudderDesktopUpdates({
        currentVersion: "0.1.0-canary.1",
        appName: "Rudder",
        repo: "example/rudder",
        releasesUrl: "https://github.com/example/rudder/releases",
        channel: "canary",
        requiredAssetNamesForVersion: () => ["SHASUMS256.txt", "Rudder-update.zip"],
        fetchImpl: async (url) => {
          if (String(url).includes("api.github.com")) {
            return new Response(JSON.stringify([
              {
                tag_name: "canary/v0.2.0-canary.0",
                prerelease: true,
                html_url: "incomplete",
                assets: [{ name: "Rudder-0.2.0-canary.0-linux-x64.AppImage" }],
              },
            ]));
          }
          return new Response('<a href="/example/rudder/releases/tag/canary%2Fv0.2.0-canary.0">canary</a>');
        },
      });

      expect(result.status).toBe("unavailable");
      expect(result.latestVersion).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });
});
