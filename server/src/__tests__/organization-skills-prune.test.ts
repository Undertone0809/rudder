import { describe, expect, it } from "vitest";
import {
  listLegacyUserHomeLocalScanSkillIds,
  listStaleBundledSkillIds,
} from "../services/organization-skills.js";

describe("organization bundled skill pruning", () => {
  it("prunes stale bundled rows that are no longer present in the current bundled set", () => {
    const staleIds = listStaleBundledSkillIds(
      [
        {
          id: "keep-rudder",
          key: "rudder/rudder",
          metadata: { sourceKind: "rudder_bundled" },
        },
        {
          id: "drop-agent-browser",
          key: "rudder/agent-browser",
          metadata: { sourceKind: "rudder_bundled" },
        },
        {
          id: "drop-legacy-paperclip",
          key: "rudder/office-hours",
          metadata: { sourceKind: "paperclip_bundled" },
        },
        {
          id: "keep-local",
          key: "organization/org-1/build-advisor",
          metadata: { sourceKind: "managed_local" },
        },
      ],
      ["rudder/rudder", "rudder/rudder-create-agent"],
    );

    expect(staleIds).toEqual(["drop-agent-browser", "drop-legacy-paperclip"]);
  });
});

describe("organization local scan pruning", () => {
  it("prunes legacy user-home local scans without pruning managed or manual local skills", () => {
    const staleIds = listLegacyUserHomeLocalScanSkillIds(
      [
        {
          id: "drop-global-scan-root",
          key: "organization/org-1/global-a",
          sourceLocator: "/Users/example/.agents/skills/global-a",
          metadata: {
            sourceKind: "local_scan",
            sourceRoot: "/Users/example/.agents",
          },
        },
        {
          id: "drop-global-scan-locator",
          key: "organization/org-1/global-b",
          sourceLocator: "/Users/example/.agents/skills/global-b/SKILL.md",
          metadata: {
            sourceKind: "local_scan",
          },
        },
        {
          id: "keep-org-workspace-scan",
          key: "organization/org-1/org-skill",
          sourceLocator: "/Users/example/.rudder/instances/default/organizations/org-1/workspaces/skills/org-skill",
          metadata: {
            sourceKind: "local_scan",
            sourceRoot: "/Users/example/.rudder/instances/default/organizations/org-1/workspaces/skills",
          },
        },
        {
          id: "keep-manual-local-import",
          key: "organization/org-1/manual",
          sourceLocator: "/Users/example/.agents/skills/manual",
          metadata: {
            sourceKind: "local_path",
          },
        },
        {
          id: "keep-managed-local",
          key: "organization/org-1/managed",
          sourceLocator: "/Users/example/.rudder/instances/default/organizations/org-1/workspaces/skills/managed",
          metadata: {
            sourceKind: "managed_local",
          },
        },
      ],
      "/Users/example/.agents",
    );

    expect(staleIds).toEqual(["drop-global-scan-root", "drop-global-scan-locator"]);
  });
});
