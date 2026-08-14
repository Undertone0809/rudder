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

  it("wires stable releases to canary cleanup after public surfaces are verified", () => {
    const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
    const publishJobIndex = workflow.indexOf("\n  publish-stable:\n");
    const surfacesJobIndex = workflow.indexOf("\n  stable-surfaces:\n");
    const cleanupJobIndex = workflow.indexOf("\n  stable-cleanup:\n");
    const cleanupJob = workflow.slice(
      cleanupJobIndex,
      workflow.indexOf("\n  next-release-base:\n", cleanupJobIndex),
    );

    expect(publishJobIndex).toBeGreaterThan(-1);
    expect(surfacesJobIndex).toBeGreaterThan(publishJobIndex);
    expect(cleanupJobIndex).toBeGreaterThan(surfacesJobIndex);
    expect(cleanupJob).toContain("- stable-surfaces");
    expect(cleanupJob).toContain("needs.stable-surfaces.result == 'success'");
    expect(cleanupJob).toContain("node scripts/cleanup-obsolete-canaries.mjs");
    expect(cleanupJob).toContain('--stable-version "${{ needs.preflight.outputs.version }}"');
  });

  it("runs the real stable job without a second authorization input", () => {
    const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
    const stableJobStart = workflow.indexOf("\n  publish-stable:\n");
    const stableJobEnd = workflow.indexOf("\n  canary-install:\n", stableJobStart);
    const stableJob = workflow.slice(stableJobStart, stableJobEnd);
    const canaryJob = workflow.slice(
      workflow.indexOf("\n  publish-canary:\n"),
      stableJobStart,
    );
    const publishIndex = stableJob.indexOf("- name: Publish missing npm payloads");

    expect(workflow).not.toContain("confirm_stable:");
    expect(stableJob).not.toContain("CONFIRM_STABLE");
    expect(canaryJob).not.toContain("Confirm stable publish authorization");
    expect(publishIndex).toBeGreaterThan(-1);
  });
});
