import { describe, expect, it, vi } from "vitest";
import {
  checkForRudderDesktopUpdates,
  chooseLatestRelease,
  compareRudderVersions,
  normalizeReleaseVersion,
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
    expect(normalizeReleaseVersion("v0.1.0", "canary")).toBeNull();
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

  it("chooses the highest canary release for canary builds", () => {
    expect(chooseLatestRelease([
      { tag_name: "canary/v0.1.0-canary.9", prerelease: true, html_url: "canary-old" },
      { tag_name: "canary/v0.1.0-canary.32", prerelease: true, html_url: "canary-new" },
      { tag_name: "v0.2.0", prerelease: false, html_url: "stable" },
    ], "canary")).toEqual({
      version: "0.1.0-canary.32",
      releaseUrl: "canary-new",
    });
  });

  it("reports update availability against the latest canary release for canary builds", async () => {
    const result = await checkForRudderDesktopUpdates({
      currentVersion: "0.1.0-canary.14",
      appName: "Rudder",
      repo: "example/rudder",
      releasesUrl: "https://example.test/releases",
      fetchImpl: async () => new Response(JSON.stringify([
        { tag_name: "v0.1.1-canary.1", prerelease: true, html_url: "canary" },
        { tag_name: "v0.1.0", prerelease: false, html_url: "stable" },
      ])),
    });

    expect(result.status).toBe("update-available");
    expect(result.channel).toBe("canary");
    expect(result.latestVersion).toBe("0.1.1-canary.1");
    expect(result.releaseUrl).toBe("canary");
  });

  it("falls back to the releases page when the GitHub API is rate-limited", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await checkForRudderDesktopUpdates({
        currentVersion: "0.1.0-canary.18",
        appName: "Rudder",
        repo: "example/rudder",
        releasesUrl: "https://github.com/example/rudder/releases",
        fetchImpl: async (url) => {
          if (String(url).includes("api.github.com")) {
            return new Response("rate limited", { status: 403 });
          }
          return new Response(`
            <a href="/example/rudder/releases/tag/canary%2Fv0.1.0-canary.31">canary 31</a>
            <a href="/example/rudder/releases/tag/canary%2Fv0.1.0-canary.32">canary 32</a>
          `);
        },
      });

      expect(result.status).toBe("update-available");
      expect(result.latestVersion).toBe("0.1.0-canary.32");
      expect(result.releaseUrl).toBe("https://github.com/example/rudder/releases/tag/canary%2Fv0.1.0-canary.32");
    } finally {
      warn.mockRestore();
    }
  });
});
