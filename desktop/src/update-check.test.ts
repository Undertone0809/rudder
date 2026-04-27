import { describe, expect, it } from "vitest";
import {
  checkForStableUpdates,
  chooseLatestStableRelease,
  compareRudderVersions,
  normalizeReleaseVersion,
} from "./update-check.js";

describe("desktop update checks", () => {
  it("normalizes only stable release tags", () => {
    expect(normalizeReleaseVersion("v0.1.0")).toBe("0.1.0");
    expect(normalizeReleaseVersion("0.2.0")).toBe("0.2.0");
    expect(normalizeReleaseVersion("v0.1.0-canary.4")).toBeNull();
    expect(normalizeReleaseVersion("v0.1.0-beta.1")).toBeNull();
  });

  it("treats stable releases as newer than prereleases with the same base version", () => {
    expect(compareRudderVersions("0.1.0", "0.1.0-canary.14")).toBeGreaterThan(0);
    expect(compareRudderVersions("0.1.0", "0.1.0-beta.1")).toBeGreaterThan(0);
    expect(compareRudderVersions("0.2.0-canary.1", "0.1.0")).toBeGreaterThan(0);
  });

  it("chooses the highest stable release and ignores canary or beta releases", () => {
    expect(chooseLatestStableRelease([
      { tag_name: "v0.3.0-canary.1", prerelease: true, html_url: "canary" },
      { tag_name: "v0.2.0-beta.1", prerelease: true, html_url: "beta" },
      { tag_name: "v0.1.0", prerelease: false, html_url: "stable-old" },
      { tag_name: "v0.2.0", prerelease: false, html_url: "stable-new" },
    ])).toEqual({
      version: "0.2.0",
      releaseUrl: "stable-new",
    });
  });

  it("reports update availability against the latest stable release", async () => {
    const result = await checkForStableUpdates({
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
    expect(result.latestVersion).toBe("0.1.0");
    expect(result.releaseUrl).toBe("stable");
  });
});
