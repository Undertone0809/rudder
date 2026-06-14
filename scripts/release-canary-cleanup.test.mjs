import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseCanaryTag,
  planCanaryCleanup,
} from "./cleanup-obsolete-canaries.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

describe("obsolete canary cleanup", () => {
  it("parses Rudder canary tags without treating stable releases as canaries", () => {
    expect(parseCanaryTag("canary/v0.3.4-canary.12")).toEqual({
      tag: "canary/v0.3.4-canary.12",
      version: "0.3.4-canary.12",
      base: {
        major: 0,
        minor: 3,
        patch: 4,
        version: "0.3.4",
      },
      canary: 12,
    });
    expect(parseCanaryTag("v0.3.4")).toBeNull();
    expect(parseCanaryTag("canary/v0.3.5-alpha.1")).toBeNull();
  });

  it("deletes canaries at or below the stable base while preserving the active npm canary", () => {
    const plan = planCanaryCleanup({
      stableVersion: "0.3.4",
      preserveCanaryVersion: "0.3.4-canary.34",
      releaseTags: [
        "canary/v0.3.3-canary.2",
        "canary/v0.3.4-canary.33",
        "canary/v0.3.4-canary.34",
        "canary/v0.3.5-canary.0",
      ],
      remoteTags: [
        "canary/v0.3.3-canary.1",
        "canary/v0.3.3-canary.2",
        "canary/v0.3.4-canary.33",
        "canary/v0.3.4-canary.34",
        "canary/v0.3.5-canary.0",
      ],
    });

    expect(plan.releaseTagsToDelete).toEqual([
      "canary/v0.3.3-canary.2",
      "canary/v0.3.4-canary.33",
    ]);
    expect(plan.tagOnlyRefsToDelete).toEqual(["canary/v0.3.3-canary.1"]);
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        {
          tag: "canary/v0.3.4-canary.34",
          reason: "current npm canary dist-tag",
        },
        {
          tag: "canary/v0.3.5-canary.0",
          reason: "base 0.3.5 is newer than stable 0.3.4",
        },
      ]),
    );
  });

  it("wires stable releases to canary cleanup after desktop assets are available", () => {
    const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
    const desktopWaitIndex = workflow.indexOf("Wait for desktop release assets");
    const cleanupIndex = workflow.indexOf("Clean up obsolete canary releases");

    expect(cleanupIndex).toBeGreaterThan(desktopWaitIndex);
    expect(workflow).toContain("node scripts/cleanup-obsolete-canaries.mjs");
    expect(workflow).toContain('--stable-version "${{ steps.publish.outputs.version }}"');
  });
});
