import { describe, expect, it } from "vitest";
import type {
  AgentSkillSnapshot,
  OrganizationSkillListItem,
} from "@rudderhq/shared";
import { buildAgentSkillMentionOptions } from "./agent-skill-mentions";

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

describe("buildAgentSkillMentionOptions", () => {
  it("builds agent-scoped skill mention options for enabled organization and external skills", () => {
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
      desiredSkills: [
        "org:organization/org-1/alpha-test",
        "agent:agent-helper",
        "global:global-helper",
        "adapter:codex_local:adapter-helper",
      ],
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
          desired: true,
          configurable: true,
          alwaysEnabled: false,
          managed: true,
          state: "configured",
          sourceClass: "organization",
          sourcePath: "/workspace/skills/alpha-test",
        },
        {
          key: "agent-helper",
          selectionKey: "agent:agent-helper",
          runtimeName: "agent-helper",
          desired: true,
          configurable: true,
          alwaysEnabled: false,
          managed: false,
          state: "configured",
          sourceClass: "agent_home",
          originLabel: "Agent skill",
          locationLabel: "AGENT_HOME/skills",
          sourcePath: "/workspace/agents/ella/skills/agent-helper",
        },
        {
          key: "global-helper",
          selectionKey: "global:global-helper",
          runtimeName: "global-helper",
          desired: true,
          configurable: true,
          alwaysEnabled: false,
          managed: false,
          state: "configured",
          sourceClass: "global",
          originLabel: "Global skill",
          locationLabel: "~/.agents/skills",
          sourcePath: "/Users/test/.agents/skills/global-helper",
        },
        {
          key: "adapter-helper",
          selectionKey: "adapter:codex_local:adapter-helper",
          runtimeName: "adapter-helper",
          desired: true,
          configurable: true,
          alwaysEnabled: false,
          managed: false,
          state: "external",
          sourceClass: "adapter_home",
          originLabel: "Adapter skill",
          locationLabel: "~/.codex/skills",
          sourcePath: "/Users/test/.codex/skills/adapter-helper",
        },
        {
          key: "disabled-helper",
          selectionKey: "agent:disabled-helper",
          runtimeName: "disabled-helper",
          desired: false,
          configurable: true,
          alwaysEnabled: false,
          managed: false,
          state: "available",
          sourceClass: "agent_home",
          sourcePath: "/workspace/agents/ella/skills/disabled-helper",
        },
        {
          key: "missing-helper",
          selectionKey: "agent:missing-helper",
          runtimeName: "missing-helper",
          desired: true,
          configurable: true,
          alwaysEnabled: false,
          managed: false,
          state: "missing",
          sourceClass: "agent_home",
          sourcePath: null,
        },
      ],
      warnings: [],
    };

    const options = buildAgentSkillMentionOptions({
      agent: {
        id: "agent-1",
        urlKey: "ella",
      },
      orgUrlKey: "acme",
      organizationSkills,
      skillSnapshot: snapshot,
    });

    expect(options.map((option) => option.name)).toEqual([
      "agent/ella/adapter-helper",
      "agent/ella/agent-helper",
      "agent/ella/global-helper",
      "org/acme/ella/alpha-test",
      "rudder/build-advisor",
    ]);

    expect(options.find((option) => option.name === "org/acme/ella/alpha-test")).toMatchObject({
      skillMarkdownTarget: "/workspace/skills/alpha-test/SKILL.md",
      skillDisplayName: "Alpha Test",
    });
    expect(options.find((option) => option.name === "agent/ella/agent-helper")).toMatchObject({
      skillMarkdownTarget: "/workspace/agents/ella/skills/agent-helper/SKILL.md",
      skillDisplayName: "Agent skill · AGENT_HOME/skills",
    });
    expect(options.find((option) => option.name === "agent/ella/global-helper")?.searchText).toContain("global skill");
    expect(options.find((option) => option.name === "agent/ella/adapter-helper")?.searchText).toContain("adapter:codex_local:adapter-helper");
  });

  it("falls back to the selection key when the organization skill catalog is not loaded yet", () => {
    const options = buildAgentSkillMentionOptions({
      agent: {
        id: "agent-1",
        urlKey: "ella",
      },
      orgUrlKey: "acme",
      organizationSkills: [],
      skillSnapshot: {
        agentRuntimeType: "codex_local",
        supported: true,
        mode: "persistent",
        desiredSkills: ["org:organization/org-1/alpha-test"],
        entries: [
          {
            key: "alpha-test",
            selectionKey: "org:organization/org-1/alpha-test",
            runtimeName: "alpha-test",
            desired: true,
            configurable: true,
            alwaysEnabled: false,
            managed: true,
            state: "configured",
            sourceClass: "organization",
            sourcePath: "/workspace/skills/alpha-test",
          },
        ],
        warnings: [],
      },
    });

    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      name: "organization/org-1/alpha-test",
      skillMarkdownTarget: "/workspace/skills/alpha-test/SKILL.md",
    });
  });
});
