import { describe, expect, it } from "vitest";
import {
  getBundledRudderSkillSlug,
  buildOrganizationSkillSearchText,
  formatOrganizationSkillPublicRef,
  normalizeOrganizationSkillKey,
  resolveOrganizationSkillReference,
  toBundledRudderSkillKey,
} from "./organization-skill-reference.js";
import type { OrganizationSkillListItem } from "./types/organization-skill.js";

const organizationContext = {
  orgUrlKey: "acme",
  agentUrlKey: null,
  scope: "organization" as const,
  orgId: "org-123",
};

const agentContext = {
  orgUrlKey: "acme",
  agentUrlKey: "builder",
  scope: "agent" as const,
  orgId: "org-123",
};

const organizationSkill: OrganizationSkillListItem = {
  id: "skill-org",
  orgId: "org-123",
  key: "organization/org-123/alpha-test",
  slug: "alpha-test",
  name: "Alpha Test",
  sourceType: "local_path",
  sourceLocator: "/workspace/skills/alpha-test",
  sourceBadge: "local",
  sourceLabel: "Rudder workspace",
  sourcePath: "/workspace/skills/alpha-test/SKILL.md",
  workspaceEditPath: null,
  description: null,
  sourceRef: null,
  trustLevel: "scripts_executables",
  compatibility: "compatible",
  fileInventory: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  attachedAgentCount: 0,
  editable: true,
  editableReason: null,
};

const bundledSkill: OrganizationSkillListItem = {
  id: "skill-bundled",
  orgId: "org-123",
  key: "rudder/build-advisor",
  slug: "build-advisor",
  name: "Build Advisor",
  sourceType: "local_path",
  sourceLocator: "/workspace/.agents/skills/build-advisor",
  sourceBadge: "rudder",
  sourceLabel: "Rudder bundled",
  sourcePath: "/workspace/.agents/skills/build-advisor/SKILL.md",
  workspaceEditPath: null,
  description: null,
  sourceRef: null,
  trustLevel: "scripts_executables",
  compatibility: "compatible",
  fileInventory: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  attachedAgentCount: 0,
  editable: true,
  editableReason: null,
};

describe("organization-skill-reference", () => {
  it("formats scope-aware public refs", () => {
    expect(formatOrganizationSkillPublicRef(organizationSkill, organizationContext)).toBe("org/acme/alpha-test");
    expect(formatOrganizationSkillPublicRef(organizationSkill, agentContext)).toBe("org/acme/builder/alpha-test");
    expect(formatOrganizationSkillPublicRef(bundledSkill, agentContext)).toBe("rudder/build-advisor");
  });

  it("resolves public refs and legacy refs to the canonical internal key", () => {
    expect(resolveOrganizationSkillReference([organizationSkill, bundledSkill], "alpha-test", organizationContext)).toEqual({
      skill: organizationSkill,
      ambiguous: false,
    });
    expect(resolveOrganizationSkillReference([organizationSkill, bundledSkill], "org/acme/alpha-test", agentContext)).toEqual({
      skill: organizationSkill,
      ambiguous: false,
    });
    expect(resolveOrganizationSkillReference([organizationSkill, bundledSkill], "org/acme/builder/alpha-test", agentContext)).toEqual({
      skill: organizationSkill,
      ambiguous: false,
    });
    expect(resolveOrganizationSkillReference([organizationSkill, bundledSkill], "organization/org-123/alpha-test", organizationContext)).toEqual({
      skill: organizationSkill,
      ambiguous: false,
    });
    expect(resolveOrganizationSkillReference([organizationSkill, bundledSkill], "rudder/build-advisor", organizationContext)).toEqual({
      skill: bundledSkill,
      ambiguous: false,
    });
    expect(resolveOrganizationSkillReference([organizationSkill, bundledSkill], "rudder/rudder/build-advisor", organizationContext)).toEqual({
      skill: bundledSkill,
      ambiguous: false,
    });
    expect(normalizeOrganizationSkillKey("org/acme/builder/alpha-test")).toBe(
      "org/acme/builder/alpha-test",
    );
    expect(normalizeOrganizationSkillKey("rudder/build-advisor")).toBe(
      "rudder/build-advisor",
    );
    expect(toBundledRudderSkillKey("build-advisor")).toBe("rudder/build-advisor");
    expect(getBundledRudderSkillSlug("rudder/rudder/build-advisor")).toBe("build-advisor");
  });

  it("builds searchable text from the public ref and source metadata", () => {
    const searchText = buildOrganizationSkillSearchText(organizationSkill, agentContext);
    expect(searchText).toContain("org/acme/builder/alpha-test");
    expect(searchText).toContain("alpha test");
    expect(searchText).toContain("rudder workspace");
    expect(searchText).toContain("/workspace/skills/alpha-test/skill.md");
    expect(searchText).not.toContain("organization/org-123/alpha-test");
  });
});
