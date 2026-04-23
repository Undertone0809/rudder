import { describe, expect, it } from "vitest";
import type {
  AgentSkillSnapshot,
  OrganizationSkillListItem,
} from "@rudder/shared";
import {
  buildChatSkillOptions,
  filterChatSkillOptions,
} from "./chat-skill-options";

const now = new Date("2026-04-20T00:00:00.000Z");

function makeSkill(
  overrides: Partial<OrganizationSkillListItem> & Pick<OrganizationSkillListItem, "id" | "key" | "slug" | "name" | "sourceType">,
) {
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
    workspaceEditPath: null,
    ...overrides,
  } as OrganizationSkillListItem;
}

describe("chat-skill-options", () => {
  it("only exposes enabled skills for the active agent", () => {
    const organizationSkills = [
      makeSkill({
        id: "bundle-build-advisor",
        key: "rudder/build-advisor",
        slug: "build-advisor",
        name: "Build Advisor",
        sourceType: "local_path",
        sourceBadge: "rudder",
        sourceLocator: "/workspace/.agents/skills/build-advisor",
        sourcePath: "/workspace/.agents/skills/build-advisor/SKILL.md",
      }),
      makeSkill({
        id: "org-alpha-test",
        key: "organization/org-1/alpha-test",
        slug: "alpha-test",
        name: "Alpha Test",
        sourceType: "local_path",
        sourceBadge: "local",
        sourceLocator: "/workspace/skills/alpha-test",
        sourcePath: "/workspace/skills/alpha-test/SKILL.md",
      }),
    ];

    const snapshot: AgentSkillSnapshot = {
      agentRuntimeType: "codex_local",
      supported: true,
      mode: "persistent",
      desiredSkills: ["bundled:rudder/build-advisor"],
      entries: [
        {
          key: "build-advisor",
          selectionKey: "bundled:rudder/build-advisor",
          runtimeName: "build-advisor",
          desired: true,
          configurable: false,
          alwaysEnabled: true,
          managed: true,
          state: "configured",
          sourceClass: "bundled",
          sourcePath: "/workspace/.agents/skills/build-advisor",
        },
        {
          key: "alpha-test",
          selectionKey: "org:organization/org-1/alpha-test",
          runtimeName: "alpha-test",
          desired: false,
          configurable: true,
          alwaysEnabled: false,
          managed: true,
          state: "available",
          sourceClass: "organization",
          sourcePath: "/workspace/skills/alpha-test",
        },
      ],
      warnings: [],
    };

    const options = buildChatSkillOptions({
      agent: {
        id: "agent-1",
        urlKey: "nia",
      },
      orgUrlKey: "acme",
      organizationSkills,
      skillSnapshot: snapshot,
    });

    expect(options.map((option) => option.name)).toEqual([
      "rudder/build-advisor",
    ]);
  });

  it("filters enabled skills by search text", () => {
    const filtered = filterChatSkillOptions(
      [
        {
          id: "skill:bundled:rudder/build-advisor",
          name: "rudder/build-advisor",
          kind: "skill",
          searchText: "rudder/build-advisor build advisor",
          skillRefLabel: "rudder/build-advisor",
          skillMarkdownTarget: "/workspace/.agents/skills/build-advisor/SKILL.md",
          skillDisplayName: "Build Advisor",
        },
      ],
      "advisor",
    );

    expect(filtered).toHaveLength(1);
  });
});
