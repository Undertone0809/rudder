import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@rudder/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin, { buildIssueDescription, normalizeConfig, resolveMappedStatus } from "../src/worker.js";
import { ACTION_KEYS, DATA_KEYS, ENTITY_TYPE_LINEAR_ISSUE_LINK } from "../src/constants.js";
import { buildLinearIssuesFilter } from "../src/linear-api.js";
import type { ImportLinearIssuesActionResult, LinearOrganizationMapping, SettingsCatalogData } from "../src/types.js";

const orgId = "org-linear";
const projectId = "project-linear";

function makeJsonResponse(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("@rudder/plugin-linear worker", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string; variables?: Record<string, unknown> };
      if (body.query?.includes("LinearViewer")) {
        return makeJsonResponse({
          data: {
            viewer: { id: "viewer-1", name: "Test Viewer", email: "viewer@example.com" },
          },
        });
      }
      if (body.query?.includes("LinearCatalog")) {
        return makeJsonResponse({
          data: {
            teams: {
              nodes: [
                {
                  id: "team-eng",
                  key: "ENG",
                  name: "Engineering",
                  states: {
                    nodes: [
                      { id: "state-backlog", name: "Backlog", type: "backlog" },
                      { id: "state-done", name: "Done", type: "completed" },
                    ],
                  },
                },
              ],
            },
            projects: { nodes: [{ id: "linear-project", name: "Roadmap" }] },
            users: { nodes: [{ id: "user-1", name: "Amy Zhang", email: "amy@example.com", active: true }] },
          },
        });
      }
      if (body.query?.includes("query LinearIssue")) {
        const id = String(body.variables?.id ?? "");
        if (id === "lin-2") {
          return makeJsonResponse({
            data: {
              issue: {
                id,
                identifier: "ENG-102",
                title: "Status mapped issue",
                description: "Imported status should map.",
                url: "https://linear.app/example/issue/ENG-102",
                updatedAt: "2026-04-22T00:00:00.000Z",
                createdAt: "2026-04-20T00:00:00.000Z",
                team: {
                  id: "team-eng",
                  key: "ENG",
                  name: "Engineering",
                  states: { nodes: [{ id: "state-progress", name: "In Progress", type: "started" }] },
                },
                state: { id: "state-progress", name: "In Progress", type: "started" },
                project: { id: "linear-project", name: "Roadmap" },
                assignee: { id: "user-1", name: "Amy Zhang", email: "amy@example.com" },
              },
            },
          });
        }
        if (id === "lin-3") {
          return makeJsonResponse({
            data: {
              issue: {
                id,
                identifier: "ENG-103",
                title: "Fallback issue",
                description: "State should fall back to backlog.",
                url: "https://linear.app/example/issue/ENG-103",
                updatedAt: "2026-04-22T01:00:00.000Z",
                createdAt: "2026-04-20T01:00:00.000Z",
                team: {
                  id: "team-eng",
                  key: "ENG",
                  name: "Engineering",
                  states: { nodes: [{ id: "state-triage", name: "Triage", type: "unstarted" }] },
                },
                state: { id: "state-triage", name: "Triage", type: "unstarted" },
                project: { id: "linear-project", name: "Roadmap" },
                assignee: null,
              },
            },
          });
        }
        if (id === "lin-4") {
          return makeJsonResponse({
            data: {
              issue: {
                id,
                identifier: "OPS-104",
                title: "Disallowed team issue",
                description: "This issue belongs to a team that is not mapped.",
                url: "https://linear.app/example/issue/OPS-104",
                updatedAt: "2026-04-22T02:00:00.000Z",
                createdAt: "2026-04-20T02:00:00.000Z",
                team: {
                  id: "team-ops",
                  key: "OPS",
                  name: "Operations",
                  states: { nodes: [{ id: "state-backlog", name: "Backlog", type: "backlog" }] },
                },
                state: { id: "state-backlog", name: "Backlog", type: "backlog" },
                project: null,
                assignee: null,
              },
            },
          });
        }
      }
      throw new Error(`Unexpected Linear GraphQL query: ${body.query}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("translates page filters into the expected Linear filter object", () => {
    expect(
      buildLinearIssuesFilter({
        allowedTeamIds: ["team-eng", "team-product"],
        teamId: "team-eng",
        stateId: "state-backlog",
        projectId: "project-roadmap",
        assigneeId: "user-amy",
        query: "Import me",
      }),
    ).toEqual({
      and: [
        { team: { id: { in: ["team-eng", "team-product"] } } },
        { team: { id: { eq: "team-eng" } } },
        { state: { id: { eq: "state-backlog" } } },
        { project: { id: { eq: "project-roadmap" } } },
        { assignee: { id: { eq: "user-amy" } } },
        {
          or: [
            { title: { containsIgnoreCase: "Import me" } },
            { description: { containsIgnoreCase: "Import me" } },
            { identifier: { eqIgnoreCase: "Import me" } },
          ],
        },
      ],
    });
  });

  it("builds the Linear source block and status fallback decisions", () => {
    const mapping: LinearOrganizationMapping = {
      orgId,
      teamMappings: [
        {
          teamId: "team-eng",
          teamName: "Engineering",
          stateMappings: [{ linearStateId: "state-progress", linearStateName: "In Progress", rudderStatus: "in_progress" }],
        },
      ],
    };
    const issue = {
      id: "lin-9",
      identifier: "ENG-109",
      title: "Import this",
      description: "Original description",
      url: "https://linear.app/example/issue/ENG-109",
      updatedAt: "2026-04-22T00:00:00.000Z",
      createdAt: "2026-04-21T00:00:00.000Z",
      team: { id: "team-eng", key: "ENG", name: "Engineering", states: [] },
      state: { id: "state-progress", name: "In Progress", type: "started" },
      project: null,
      assignee: null,
    };

    expect(resolveMappedStatus(mapping, issue)).toEqual({
      status: "in_progress",
      fallback: false,
    });
    expect(
      resolveMappedStatus(
        { ...mapping, teamMappings: [{ ...mapping.teamMappings[0]!, stateMappings: [] }] },
        issue,
      ),
    ).toEqual({
      status: "backlog",
      fallback: true,
    });
    expect(buildIssueDescription(issue)).toContain("Linear URL: https://linear.app/example/issue/ENG-109");
  });

  it("loads the Linear catalog for token-first settings before mappings exist", async () => {
    const harness = createTestHarness({
      manifest,
      config: normalizeConfig({
        apiTokenSecretRef: "linear-token",
        organizationMappings: [],
      }),
    });

    await plugin.definition.setup(harness.ctx);

    const catalog = await harness.getData<SettingsCatalogData>(DATA_KEYS.settingsCatalog, { orgId });
    expect(catalog.teams).toEqual([
      expect.objectContaining({
        id: "team-eng",
        name: "Engineering",
      }),
    ]);
    expect(catalog.projects).toContainEqual(expect.objectContaining({ id: "linear-project" }));
  });

  it("imports selected issues, skips duplicates, and reports fallback statuses", async () => {
    const harness = createTestHarness({
      manifest,
      config: normalizeConfig({
        apiTokenSecretRef: "linear-token",
        organizationMappings: [
          {
            orgId,
            teamMappings: [
              {
                teamId: "team-eng",
                teamName: "Engineering",
                stateMappings: [
                  {
                    linearStateId: "state-progress",
                    linearStateName: "In Progress",
                    rudderStatus: "in_progress",
                  },
                ],
              },
            ],
          },
        ],
      }),
    });

    harness.seed({
      organizations: [
        {
          id: orgId,
          name: "Linear Org",
          issuePrefix: "LIN",
          issueCounter: 1,
          description: null,
          status: "active",
          urlKey: "linear-org",
          pauseReason: null,
          pausedAt: null,
          budgetMonthlyCents: 0,
          spentMonthlyCents: 0,
          requireBoardApprovalForNewAgents: false,
          defaultChatIssueCreationMode: "manual_approval",
          defaultChatAgentRuntimeType: "codex_local",
          defaultChatAgentRuntimeConfig: null,
          workspace: null,
          brandColor: null,
          logoAssetId: null,
          logoUrl: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      projects: [
        {
          id: projectId,
          orgId,
          urlKey: "imported-work",
          goalId: null,
          goalIds: [],
          goals: [],
          name: "Imported Work",
          description: null,
          status: "planned",
          leadAgentId: null,
          targetDate: null,
          color: null,
          pauseReason: null,
          pausedAt: null,
          executionWorkspacePolicy: null,
          codebase: {
            configured: false,
            scope: "none",
            workspaceId: null,
            repoUrl: null,
            repoRef: null,
            defaultRef: null,
            repoName: null,
            localFolder: null,
            managedFolder: "",
            effectiveLocalFolder: "",
            origin: "local_folder",
          },
          resources: [],
          workspaces: [],
          primaryWorkspace: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          archivedAt: null,
        },
      ],
    });

    await plugin.definition.setup(harness.ctx);
    await harness.ctx.entities.upsert({
      entityType: ENTITY_TYPE_LINEAR_ISSUE_LINK,
      scopeKind: "issue",
      scopeId: "existing-rudder-issue",
      externalId: "lin-2",
      title: "ENG-102 Status mapped issue",
      status: "In Progress",
      data: {
        externalId: "lin-2",
        rudderIssueId: "existing-rudder-issue",
        rudderIssueIdentifier: "LIN-1",
        orgId,
        linearIdentifier: "ENG-102",
        linearTitle: "Status mapped issue",
        linearUrl: "https://linear.app/example/issue/ENG-102",
        teamId: "team-eng",
        teamName: "Engineering",
        projectId: "linear-project",
        projectName: "Roadmap",
        stateId: "state-progress",
        stateName: "In Progress",
        importedAt: "2026-04-22T00:00:00.000Z",
        updatedAt: "2026-04-22T00:00:00.000Z",
      },
    });

    const result = await harness.performAction<ImportLinearIssuesActionResult>(ACTION_KEYS.importIssues, {
      orgId,
      targetProjectId: projectId,
      mode: "selected",
      issueIds: ["lin-2", "lin-3"],
    });

    expect(result.importedCount).toBe(1);
    expect(result.duplicateCount).toBe(1);
    expect(result.fallbackCount).toBe(1);
    expect(result.adjustedCount).toBe(0);
    expect(result.duplicateIssueIds).toEqual(["lin-2"]);

    const issues = await harness.ctx.issues.list({ orgId, limit: 10, offset: 0 });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.title).toBe("Fallback issue");
    expect(issues[0]?.projectId).toBe(projectId);
    expect(issues[0]?.description).toContain("Source: Linear");

    const storedLink = harness.getState({
      scopeKind: "issue",
      scopeId: issues[0]!.id,
      stateKey: "linear-link",
    }) as { externalId: string; linearIdentifier: string };
    expect(storedLink).toMatchObject({
      externalId: "lin-3",
      linearIdentifier: "ENG-103",
    });
    expect(harness.activity).toHaveLength(1);

    await expect(
      harness.performAction<ImportLinearIssuesActionResult>(ACTION_KEYS.importIssues, {
        orgId,
        targetProjectId: projectId,
        mode: "selected",
        issueIds: ["lin-4"],
      }),
    ).rejects.toThrow("which is not allowed for this Rudder organization");
  });

  it("downgrades mapped in-progress imports to todo when imports stay unassigned", async () => {
    const harness = createTestHarness({
      manifest,
      config: normalizeConfig({
        apiTokenSecretRef: "linear-token",
        organizationMappings: [
          {
            orgId,
            teamMappings: [
              {
                teamId: "team-eng",
                teamName: "Engineering",
                stateMappings: [
                  {
                    linearStateId: "state-progress",
                    linearStateName: "In Progress",
                    rudderStatus: "in_progress",
                  },
                ],
              },
            ],
          },
        ],
      }),
    });

    harness.seed({
      organizations: [
        {
          id: orgId,
          name: "Linear Org",
          issuePrefix: "LIN",
          issueCounter: 1,
          description: null,
          status: "active",
          urlKey: "linear-org",
          pauseReason: null,
          pausedAt: null,
          budgetMonthlyCents: 0,
          spentMonthlyCents: 0,
          requireBoardApprovalForNewAgents: false,
          defaultChatIssueCreationMode: "manual_approval",
          defaultChatAgentRuntimeType: "codex_local",
          defaultChatAgentRuntimeConfig: null,
          workspace: null,
          brandColor: null,
          logoAssetId: null,
          logoUrl: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      projects: [
        {
          id: projectId,
          orgId,
          urlKey: "imported-work",
          goalId: null,
          goalIds: [],
          goals: [],
          name: "Imported Work",
          description: null,
          status: "planned",
          leadAgentId: null,
          targetDate: null,
          color: null,
          pauseReason: null,
          pausedAt: null,
          executionWorkspacePolicy: null,
          codebase: {
            configured: false,
            scope: "none",
            workspaceId: null,
            repoUrl: null,
            repoRef: null,
            defaultRef: null,
            repoName: null,
            localFolder: null,
            managedFolder: "",
            effectiveLocalFolder: "",
            origin: "local_folder",
          },
          resources: [],
          workspaces: [],
          primaryWorkspace: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          archivedAt: null,
        },
      ],
    });

    await plugin.definition.setup(harness.ctx);

    const result = await harness.performAction<ImportLinearIssuesActionResult>(ACTION_KEYS.importIssues, {
      orgId,
      targetProjectId: projectId,
      mode: "selected",
      issueIds: ["lin-2"],
    });

    expect(result.importedCount).toBe(1);
    expect(result.adjustedCount).toBe(1);
    expect(result.importedIssues[0]?.finalStatus).toBe("todo");

    const issues = await harness.ctx.issues.list({ orgId, limit: 10, offset: 0 });
    expect(issues[0]?.title).toBe("Status mapped issue");
    expect(issues[0]?.status).toBe("todo");
  });
});
