import type { OrganizationSkillListItem, OrganizationWorkspaceFileEntry, Project } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import {
  applyMovedWorkspacePath,
  buildProjectResourceTreeGroups,
  buildVirtualOrganizationSkillEntries,
  canCreateInsideWorkspaceDirectory,
  canDeleteWorkspaceEntry,
  canDropWorkspaceEntryIntoDirectory,
  canMoveWorkspaceEntry,
  isProtectedAgentInstructionsEntryPath,
  isProtectedAgentManagedEntryPath,
  mergeWorkspaceAndVirtualSkillEntries,
  workspacePathBreadcrumb,
} from "./workspace-tree-policy";

function skill(overrides: Partial<OrganizationSkillListItem> = {}): OrganizationSkillListItem {
  return {
    id: "skill-1",
    slug: "reviewer",
    name: "Reviewer",
    fileInventory: [{ path: "SKILL.md" }, { path: "references/checklist.md" }],
    workspaceEditPath: null,
    editableReason: "Read only",
    sourceLabel: "Bundled",
    ...overrides,
  } as OrganizationSkillListItem;
}

describe("workspace tree policy", () => {
  it("adds virtual skills without shadowing workspace-backed entries", () => {
    const rootEntry = {
      name: "docs",
      path: "docs",
      isDirectory: true,
    } as OrganizationWorkspaceFileEntry;
    expect(mergeWorkspaceAndVirtualSkillEntries("", [rootEntry], [skill()]).map((entry) => entry.path))
      .toEqual(["docs", "skills"]);

    const entries = buildVirtualOrganizationSkillEntries("skills/reviewer", [], [skill()]);
    expect(entries.map((entry) => [entry.path, entry.isDirectory])).toEqual([
      ["skills/reviewer/references", true],
      ["skills/reviewer/SKILL.md", false],
    ]);
    expect(buildVirtualOrganizationSkillEntries("skills", [], [
      skill({ workspaceEditPath: "skills/reviewer/SKILL.md" }),
    ])).toEqual([]);
  });

  it("preserves protected agent and organization skill paths", () => {
    expect(isProtectedAgentInstructionsEntryPath("agents/ada/instructions/HEARTBEAT.md")).toBe(true);
    expect(isProtectedAgentInstructionsEntryPath("agents/ada/instructions/notes.md")).toBe(false);
    expect(isProtectedAgentManagedEntryPath("agents/ada/memory/notes.md")).toBe(true);
    expect(canCreateInsideWorkspaceDirectory("agents/ada/memory")).toBe(true);
    expect(canMoveWorkspaceEntry({ path: "agents/ada/memory/notes.md" })).toBe(false);
    expect(canDeleteWorkspaceEntry({ path: "skills/reviewer" })).toBe(false);
    expect(canDeleteWorkspaceEntry({
      path: "agents/removed-agent",
      entityType: "orphaned_agent_workspace",
    })).toBe(true);
    expect(canDeleteWorkspaceEntry({
      path: "agents",
      entityType: "orphaned_agent_workspace",
    })).toBe(false);
  });

  it("rejects no-op, recursive, and protected moves", () => {
    const source = { path: "docs/guides", isDirectory: true };
    expect(canDropWorkspaceEntryIntoDirectory(source, "docs/guides/archive")).toBe(false);
    expect(canDropWorkspaceEntryIntoDirectory(source, "docs")).toBe(false);
    expect(canDropWorkspaceEntryIntoDirectory(source, "artifacts")).toBe(true);
    expect(applyMovedWorkspacePath("docs/guides/a.md", "docs/guides", "artifacts/guides"))
      .toBe("artifacts/guides/a.md");
  });

  it("sorts project resources and keeps project identity in the group", () => {
    const project = {
      id: "project-1",
      urlKey: "alpha",
      resources: [
        { id: "b", sortOrder: 2, resource: { name: "B" } },
        { id: "a", sortOrder: 1, resource: { name: "A" } },
      ],
    } as Project;
    const groups = buildProjectResourceTreeGroups([project]);
    expect(groups.get("projects/alpha")?.project).toBe(project);
    expect(groups.get("projects/alpha")?.resources.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("builds agent-aware breadcrumbs without changing path identity", () => {
    const agentEntry = {
      name: "ada",
      displayLabel: "Ada",
      path: "agents/ada",
      isDirectory: true,
      agentRole: "engineer",
    } as OrganizationWorkspaceFileEntry;
    const parts = workspacePathBreadcrumb(
      "agents/ada/instructions/SOUL.md",
      new Map([["ada", agentEntry]]),
      "file",
      "Library",
    );
    expect(parts.map((part) => [part.label, part.path, part.kind])).toEqual([
      ["Library", "", "folder"],
      ["agents", "agents", "agents_root"],
      ["Ada", "agents/ada", "agent_workspace"],
      ["instructions", "agents/ada/instructions", "folder"],
      ["SOUL.md", "agents/ada/instructions/SOUL.md", "file"],
    ]);
  });
});
