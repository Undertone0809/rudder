import type { OrganizationSkillListItem } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import {
  resolveSkillReferenceSidePanelTarget,
  resolveTranscriptSkillSidePanelTarget,
} from "./transcript-skill-targets";

function skill(
  overrides: Partial<OrganizationSkillListItem> = {},
): OrganizationSkillListItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    orgId: "organization-1",
    key: "rudder/browser",
    slug: "browser",
    name: "Browser",
    description: null,
    sourceType: "local_path",
    sourceLocator: null,
    sourceRef: null,
    trustLevel: "markdown_only",
    compatibility: "compatible",
    fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    createdAt: new Date("2026-07-27T00:00:00.000Z"),
    updatedAt: new Date("2026-07-27T00:00:00.000Z"),
    attachedAgentCount: 1,
    editable: false,
    editableReason: "Bundled skills are read only.",
    sourceLabel: "Rudder",
    sourceBadge: "rudder",
    sourcePath: "/workspace/skills/browser",
    workspaceEditPath: null,
    ...overrides,
  };
}

describe("resolveTranscriptSkillSidePanelTarget", () => {
  it("prefers an exact organization skill source path", () => {
    expect(resolveTranscriptSkillSidePanelTarget(
      { name: "renamed-browser", path: "/workspace/skills/browser/SKILL.md" },
      [
        skill(),
        skill({
          id: "22222222-2222-4222-8222-222222222222",
          sourcePath: "/workspace/other/browser",
        }),
      ],
    )).toEqual({
      kind: "organization_skill_file",
      skillId: "11111111-1111-4111-8111-111111111111",
      filePath: "SKILL.md",
      label: "browser",
    });
  });

  it("does not map an external absolute path through an unrooted workspace suffix", () => {
    expect(resolveTranscriptSkillSidePanelTarget(
      {
        name: "renamed-browser",
        path: "/tmp/skills/browser/SKILL.md",
      },
      [
        skill({
          sourcePath: null,
          workspaceEditPath: "skills/browser/SKILL.md",
        }),
      ],
    )).toEqual({
      kind: "local_file",
      filePath: "/tmp/skills/browser/SKILL.md",
      label: "renamed-browser",
    });
  });

  it("resolves a unique normalized skill identity", () => {
    expect(resolveTranscriptSkillSidePanelTarget(
      { name: "rudder/browser", path: null },
      [skill()],
    )?.kind).toBe("organization_skill_file");
  });

  it("does not guess an ambiguous identity", () => {
    expect(resolveTranscriptSkillSidePanelTarget(
      { name: "browser", path: null },
      [
        skill(),
        skill({
          id: "22222222-2222-4222-8222-222222222222",
          key: "organization/browser",
        }),
      ],
    )).toBeNull();
  });

  it("falls back to an exact trusted local path", () => {
    expect(resolveTranscriptSkillSidePanelTarget(
      { name: "local-helper", path: "/tmp/skills/local-helper/SKILL.md" },
      [],
    )).toEqual({
      kind: "local_file",
      filePath: "/tmp/skills/local-helper/SKILL.md",
      label: "local-helper",
    });
  });
});

describe("resolveSkillReferenceSidePanelTarget", () => {
  it("opens a canonical organization skill reference without preview metadata", () => {
    expect(resolveSkillReferenceSidePanelTarget(
      "skill://org/11111111-1111-4111-8111-111111111111?ref=browser",
      "browser",
      null,
    )).toEqual({
      kind: "organization_skill_file",
      skillId: "11111111-1111-4111-8111-111111111111",
      filePath: "SKILL.md",
      label: "browser",
    });
  });

  it("resolves a short runtime skill reference through the organization skill list", () => {
    expect(resolveSkillReferenceSidePanelTarget(
      "skill://visualize",
      "visualize",
      [skill({ slug: "visualize", key: "rudder/visualize", name: "Visualize" })],
    )).toEqual({
      kind: "organization_skill_file",
      skillId: "11111111-1111-4111-8111-111111111111",
      filePath: "SKILL.md",
      label: "visualize",
    });
  });

  it("does not guess an organization skill for an agent-owned reference", () => {
    expect(resolveSkillReferenceSidePanelTarget(
      "skill://agent/agent-1/agent%3Avisualize?ref=visualize",
      "visualize",
      [skill({ slug: "visualize", key: "rudder/visualize", name: "Visualize" })],
    )).toBeNull();
  });

  it("keeps an explicit local Skill path local when an organization skill shares its label", () => {
    expect(resolveSkillReferenceSidePanelTarget(
      "/workspace/.agents/skills/visualize/SKILL.md",
      "visualize",
      [skill({
        slug: "visualize",
        key: "rudder/visualize",
        name: "Visualize",
        sourcePath: "/workspace/organization-skills/visualize",
      })],
    )).toEqual({
      kind: "local_file",
      filePath: "/workspace/.agents/skills/visualize/SKILL.md",
      label: "visualize",
    });
  });
});
