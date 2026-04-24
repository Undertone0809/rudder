import { describe, expect, it } from "vitest";
import type { OrganizationSkillListItem } from "@rudderhq/shared";
import {
  appendSkillReferencesToDraft,
  buildOrganizationSkillPickerItems,
  filterSelectableNewAgentOrganizationSkillItems,
  filterOrganizationSkillPickerItems,
  organizationSkillMarkdownTarget,
} from "./organization-skill-picker.js";

const now = new Date("2026-04-06T00:00:00.000Z");

function makeSkill(overrides: Partial<OrganizationSkillListItem> & Pick<OrganizationSkillListItem, "id" | "key" | "slug" | "name" | "sourceType">) {
  return {
    orgId: "org-1",
    description: null,
    sourceLocator: null,
    sourceRef: null,
    trustLevel: "markdown_only" as const,
    compatibility: "compatible" as const,
    fileInventory: [{ path: "SKILL.md", kind: "skill" as const }],
    createdAt: now,
    updatedAt: now,
    attachedAgentCount: 0,
    editable: true,
    editableReason: null,
    sourceBadge: "local" as const,
    sourceLabel: null,
    sourcePath: null,
    ...overrides,
  } as OrganizationSkillListItem;
}

describe("organization-skill-picker", () => {
  it("builds readable public refs and markdown targets", () => {
    const items = buildOrganizationSkillPickerItems(
      [
        makeSkill({
          id: "bundle",
          key: "rudder/build-advisor",
          slug: "build-advisor",
          name: "Build Advisor",
          sourceType: "local_path",
          sourceLocator: "/workspace/.agents/skills/build-advisor",
          sourceBadge: "rudder",
          sourceLabel: "Rudder bundled",
          sourcePath: "/workspace/.agents/skills/build-advisor/SKILL.md",
        }),
        makeSkill({
          id: "alpha",
          key: "organization/org-1/alpha-test",
          slug: "alpha-test",
          name: "Alpha Test",
          sourceType: "local_path",
          sourceLocator: "/workspace/skills/alpha-test",
          sourceBadge: "local",
          sourceLabel: "Rudder workspace",
          sourcePath: "/workspace/skills/alpha-test/SKILL.md",
        }),
        makeSkill({
          id: "beta",
          key: "organization/org-1/beta-test",
          slug: "beta-test",
          name: "Beta Search",
          sourceType: "github",
          sourceLocator: "https://github.com/acme/repo",
          sourceBadge: "github",
          sourceLabel: "acme/repo",
          sourcePath: "https://github.com/acme/repo/blob/main/skills/beta-test/SKILL.md",
        }),
      ],
      {
        orgUrlKey: "acme",
        agentUrlKey: "builder",
        scope: "agent",
      },
    );

    expect(items.map((item) => item.publicRef)).toEqual([
      "org/acme/builder/alpha-test",
      "org/acme/builder/beta-test",
      "rudder/build-advisor",
    ]);
    expect(items.map((item) => item.markdownTarget)).toEqual([
      "/workspace/skills/alpha-test/SKILL.md",
      "https://github.com/acme/repo/blob/main/skills/beta-test/SKILL.md",
      "/workspace/.agents/skills/build-advisor/SKILL.md",
    ]);
    expect(organizationSkillMarkdownTarget(items[0]!)).toBe("/workspace/skills/alpha-test/SKILL.md");
  });

  it("prefers the real source locator over managed root display paths", () => {
    const item = makeSkill({
      id: "managed-alpha",
      key: "organization/org-1/alpha-test",
      slug: "alpha-test",
      name: "Alpha Test",
      sourceType: "local_path",
      sourceLocator: "/workspace/skills/alpha-test",
      sourceBadge: "rudder",
      sourceLabel: "Rudder workspace",
      sourcePath: "/workspace/skills",
    });

    expect(organizationSkillMarkdownTarget(item)).toBe("/workspace/skills/alpha-test/SKILL.md");
  });

  it("filters by public ref, name, slug, and source metadata", () => {
    const items = buildOrganizationSkillPickerItems(
      [
        makeSkill({
          id: "alpha",
          key: "organization/org-1/alpha-test",
          slug: "alpha-test",
          name: "Alpha Test",
          sourceType: "local_path",
          sourceLocator: "/workspace/skills/alpha-test",
          sourceBadge: "local",
          sourceLabel: "Rudder workspace",
          sourcePath: "/workspace/skills/alpha-test/SKILL.md",
        }),
        makeSkill({
          id: "beta",
          key: "organization/org-1/beta-test",
          slug: "beta-test",
          name: "Beta Search",
          sourceType: "github",
          sourceLocator: "https://github.com/acme/repo",
          sourceBadge: "github",
          sourceLabel: "acme/repo",
          sourcePath: "https://github.com/acme/repo/blob/main/skills/beta-test/SKILL.md",
        }),
      ],
      {
        orgUrlKey: "acme",
        agentUrlKey: "builder",
        scope: "agent",
      },
    );

    expect(filterOrganizationSkillPickerItems(items, "alpha").map((item) => item.id)).toEqual(["alpha"]);
    expect(filterOrganizationSkillPickerItems(items, "github").map((item) => item.id)).toEqual(["beta"]);
    expect(filterOrganizationSkillPickerItems(items, "workspace").map((item) => item.id)).toEqual(["alpha"]);
    expect(filterOrganizationSkillPickerItems(items, "org/acme/builder/beta-test").map((item) => item.id)).toEqual(["beta"]);
  });

  it("omits the bundled Rudder defaults from the new-agent optional picker", () => {
    const items = buildOrganizationSkillPickerItems(
      [
        makeSkill({
          id: "bundle-rudder",
          key: "rudder/rudder",
          slug: "rudder",
          name: "rudder",
          sourceType: "local_path",
          sourceBadge: "rudder",
          sourceLabel: "Bundled by Rudder",
        }),
        makeSkill({
          id: "bundle-memory",
          key: "rudder/para-memory-files",
          slug: "para-memory-files",
          name: "para-memory-files",
          sourceType: "local_path",
          sourceBadge: "rudder",
          sourceLabel: "Bundled by Rudder",
        }),
        makeSkill({
          id: "community",
          key: "organization/org-1/deep-research",
          slug: "deep-research",
          name: "deep-research",
          sourceType: "local_path",
          sourceLocator: "/workspace/community/deep-research",
          sourceBadge: "community",
          sourceLabel: "Community preset",
          sourcePath: "/workspace/community/deep-research/SKILL.md",
        }),
        makeSkill({
          id: "alpha",
          key: "organization/org-1/alpha-test",
          slug: "alpha-test",
          name: "Alpha Test",
          sourceType: "local_path",
          sourceLocator: "/workspace/skills/alpha-test",
          sourceBadge: "local",
          sourceLabel: "Rudder workspace",
          sourcePath: "/workspace/skills/alpha-test/SKILL.md",
        }),
      ],
      {
        orgUrlKey: "acme",
        agentUrlKey: "builder",
        scope: "agent",
      },
    );

    expect(filterSelectableNewAgentOrganizationSkillItems(items).map((item) => item.id)).toEqual([
      "alpha",
      "community",
    ]);
  });

  it("appends unique skill references to the draft", () => {
    const alpha = "[org/acme/builder/alpha-test](/workspace/skills/alpha-test/SKILL.md)";
    const beta = "[rudder/build-advisor](/workspace/.agents/skills/build-advisor/SKILL.md)";

    expect(
      appendSkillReferencesToDraft("Use these skills", [alpha, beta, alpha, ""]),
    ).toBe("Use these skills [org/acme/builder/alpha-test](/workspace/skills/alpha-test/SKILL.md) [rudder/build-advisor](/workspace/.agents/skills/build-advisor/SKILL.md)\u00A0");
  });
});
