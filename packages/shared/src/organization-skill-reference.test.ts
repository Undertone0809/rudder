import { describe, expect, it } from "vitest";
import {
  RUDDER_BUNDLED_SKILL_SLUGS,
  buildOrganizationSkillSearchText,
  formatOrganizationSkillPublicRef,
  getActiveRudderBundledSkillSlugs,
  getBundledRudderSkillSlug,
  isCanonicalBundledRudderSkillKey,
  isRetiredRudderCreationSkillReference,
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
  sourceLabel: "Organization library",
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
  it("keeps App Builder and Visualize active while Browser remains capability-gated", () => {
    expect(RUDDER_BUNDLED_SKILL_SLUGS).toContain("app-builder");
    expect(RUDDER_BUNDLED_SKILL_SLUGS).toContain("browser");
    expect(RUDDER_BUNDLED_SKILL_SLUGS).toContain("visualize");
    expect(getActiveRudderBundledSkillSlugs(false, false)).not.toContain("browser");
    expect(getActiveRudderBundledSkillSlugs(false, false)).not.toContain("app-builder");
    expect(getActiveRudderBundledSkillSlugs(false, false)).toContain("visualize");
    expect(getActiveRudderBundledSkillSlugs(true, true)).toEqual([
      "app-builder",
      "para-memory-files",
      "rudder-docs",
      "skill-creator",
      "visualize",
      "browser",
    ]);
  });

  it("formats scope-aware public refs", () => {
    expect(formatOrganizationSkillPublicRef(organizationSkill, organizationContext)).toBe("org/acme/alpha-test");
    expect(formatOrganizationSkillPublicRef(organizationSkill, agentContext)).toBe("org/acme/builder/alpha-test");
    expect(formatOrganizationSkillPublicRef({
      ...organizationSkill,
      sourceBadge: "rudder",
      sourceLabel: "Organization library",
    }, organizationContext)).toBe("org/acme/alpha-test");
    expect(formatOrganizationSkillPublicRef(bundledSkill, agentContext)).toBe("rudder/build-advisor");
  });

  it("resolves public refs and legacy refs to the canonical internal key", () => {
    const managedOrganizationSkill = {
      ...organizationSkill,
      sourceBadge: "rudder" as const,
      sourceLabel: "Organization library",
    };
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
    expect(resolveOrganizationSkillReference([managedOrganizationSkill, bundledSkill], "rudder/alpha-test", organizationContext)).toEqual({
      skill: managedOrganizationSkill,
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

  it("normalizes every legacy Rudder Docs identity to the canonical slug", () => {
    for (const reference of [
      "rudder",
      "rudder/rudder",
      "bundled:rudder/rudder",
      "rudder/rudder-docs",
      "bundled:rudder/rudder-docs",
    ]) {
      expect(getBundledRudderSkillSlug(reference), reference).toBe("rudder-docs");
    }

    expect(toBundledRudderSkillKey(getBundledRudderSkillSlug("rudder"))).toBe(
      "rudder/rudder-docs",
    );
  });

  it("keeps retired creation skill references missing instead of aliasing them to Rudder Docs", () => {
    const rudderDocs = {
      ...bundledSkill,
      id: "skill-rudder-docs",
      key: "rudder/rudder-docs",
      slug: "rudder-docs",
      name: "Rudder Docs",
    };

    for (const reference of [
      "rudder/rudder-create-agent",
      "bundled:rudder/rudder-create-agent",
      "rudder/rudder-create-plugin",
      "bundled:rudder/rudder-create-plugin",
    ]) {
      expect(getBundledRudderSkillSlug(reference), reference).not.toBe("rudder-docs");
      expect(toBundledRudderSkillKey(reference), reference).not.toBe("rudder/rudder-docs");
      expect(isCanonicalBundledRudderSkillKey(toBundledRudderSkillKey(reference))).toBe(false);
      expect(resolveOrganizationSkillReference([rudderDocs], reference, organizationContext)).toEqual({
        skill: null,
        ambiguous: false,
      });
    }
  });

  it("rejects retired creation identities even when a preserved user-owned row has the same key", () => {
    const retiredUserOwnedAgentSkill = {
      ...organizationSkill,
      id: "skill-user-owned-retired-agent-name",
      key: "rudder/rudder-create-agent",
      slug: "rudder-create-agent",
      name: "User-owned Agent Helper",
    };
    const retiredUserOwnedPluginSkill = {
      ...organizationSkill,
      id: "skill-user-owned-retired-plugin-name",
      key: "rudder/rudder-create-plugin",
      slug: "rudder-create-plugin",
      name: "User-owned Plugin Helper",
    };
    const skills = [retiredUserOwnedAgentSkill, retiredUserOwnedPluginSkill];

    for (const reference of [
      "rudder-create-agent",
      "rudder/rudder-create-agent",
      "rudder/rudder/rudder-create-agent",
      "bundled:rudder/rudder-create-agent",
      "rudder-create-plugin",
      "rudder/rudder-create-plugin",
      "rudder/rudder/rudder-create-plugin",
      "bundled:rudder/rudder-create-plugin",
    ]) {
      expect(isRetiredRudderCreationSkillReference(reference), reference).toBe(true);
      expect(resolveOrganizationSkillReference(skills, reference, organizationContext), reference).toEqual({
        skill: null,
        ambiguous: false,
      });
    }
  });

  it("builds searchable text from the public ref and source metadata", () => {
    const searchText = buildOrganizationSkillSearchText(organizationSkill, agentContext);
    expect(searchText).toContain("org/acme/builder/alpha-test");
    expect(searchText).toContain("alpha test");
    expect(searchText).toContain("organization library");
    expect(searchText).toContain("/workspace/skills/alpha-test/skill.md");
    expect(searchText).not.toContain("organization/org-123/alpha-test");
  });
});
