import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";

type Organization = {
  id: string;
  issuePrefix: string;
};

type Project = {
  id: string;
  name: string;
};

type PluginRecord = {
  id: string;
  pluginKey: string;
  status: string;
};

type SecretRecord = {
  id: string;
};

type IssueRecord = {
  id: string;
  title: string;
  status: string;
  projectId: string | null;
};

type LinearIssueRow = {
  id: string;
  identifier: string;
  title: string;
  imported: boolean;
  importedRudderIssueId: string | null;
};

type ImportResult = {
  importedCount: number;
  duplicateCount: number;
  fallbackCount: number;
  adjustedCount: number;
  importedIssues: Array<{
    linearId: string;
    rudderIssueId: string;
    fallbackStatus: boolean;
    adjustedStatus: boolean;
    finalStatus: string;
  }>;
};

const LINEAR_PLUGIN_KEY = "rudder.linear";
const LINEAR_PLUGIN_PATH = path.resolve(process.cwd(), "packages/plugins/examples/plugin-linear");

async function createLinearFixtureOrg(request: APIRequestContext) {
  const orgRes = await request.post("/api/orgs", {
    data: {
      name: `Linear Plugin Import ${Date.now()}`,
    },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as Organization;

  const projectRes = await request.post(`/api/orgs/${organization.id}/projects`, {
    data: {
      name: "Imported Work",
      status: "planned",
    },
  });
  expect(projectRes.ok()).toBe(true);
  const project = await projectRes.json() as Project;

  const secretRes = await request.post(`/api/orgs/${organization.id}/secrets`, {
    data: {
      name: "Linear token",
      value: "linear-fixture-token",
    },
  });
  expect(secretRes.ok()).toBe(true);
  const secret = await secretRes.json() as SecretRecord;

  return { organization, project, secret };
}

async function findLinearPlugin(request: APIRequestContext): Promise<PluginRecord | null> {
  const pluginsRes = await request.get("/api/plugins");
  expect(pluginsRes.ok()).toBe(true);
  const plugins = await pluginsRes.json() as PluginRecord[];
  return plugins.find((plugin) => plugin.pluginKey === LINEAR_PLUGIN_KEY) ?? null;
}

async function installLinearPlugin(request: APIRequestContext): Promise<PluginRecord> {
  const existing = await findLinearPlugin(request);
  if (existing) return existing;

  const installRes = await request.post("/api/plugins/install", {
    data: {
      packageName: LINEAR_PLUGIN_PATH,
      isLocalPath: true,
    },
    timeout: 30_000,
  });

  if (installRes.ok()) {
    return await installRes.json() as PluginRecord;
  }

  const message = await installRes.text();
  if (/already installed/i.test(message)) {
    const installed = await findLinearPlugin(request);
    if (installed) return installed;
  }

  throw new Error(`Failed to install Linear plugin: ${installRes.status()} ${message}`);
}

async function configureLinearPlugin(
  request: APIRequestContext,
  plugin: PluginRecord,
  organization: Organization,
  secret: SecretRecord,
) {
  const configRes = await request.post(`/api/plugins/${plugin.id}/config`, {
    data: {
      configJson: {
        apiTokenSecretRef: secret.id,
        fixtureMode: true,
        organizationMappings: [
          {
            orgId: organization.id,
            teamMappings: [
              {
                teamId: "team-eng",
                teamName: "Engineering",
                stateMappings: [
                  {
                    linearStateId: "state-backlog",
                    linearStateName: "Backlog",
                    rudderStatus: "backlog",
                  },
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
      },
    },
  });
  expect(configRes.ok()).toBe(true);
}

async function configureLinearTokenOnly(
  request: APIRequestContext,
  plugin: PluginRecord,
  secret: SecretRecord,
) {
  const configRes = await request.post(`/api/plugins/${plugin.id}/config`, {
    data: {
      configJson: {
        apiTokenSecretRef: secret.id,
        fixtureMode: true,
        organizationMappings: [],
      },
    },
  });
  expect(configRes.ok()).toBe(true);
}

async function pluginData<T>(
  request: APIRequestContext,
  plugin: PluginRecord,
  key: string,
  organization: Organization,
  params: Record<string, unknown> = {},
): Promise<T> {
  const res = await request.post(`/api/plugins/${plugin.id}/data/${key}`, {
    data: {
      orgId: organization.id,
      params: {
        orgId: organization.id,
        ...params,
      },
    },
  });
  expect(res.ok()).toBe(true);
  const payload = await res.json() as { data: T };
  return payload.data;
}

async function importLinearIssues(
  request: APIRequestContext,
  plugin: PluginRecord,
  organization: Organization,
  params: Record<string, unknown>,
) {
  const res = await request.post(`/api/plugins/${plugin.id}/actions/import-linear-issues`, {
    data: {
      orgId: organization.id,
      params: {
        orgId: organization.id,
        ...params,
      },
    },
  });
  expect(res.ok()).toBe(true);
  const payload = await res.json() as { data: ImportResult };
  return payload.data;
}

async function waitForLinearPageData(
  request: APIRequestContext,
  plugin: PluginRecord,
  organization: Organization,
) {
  await expect.poll(async () => {
    const data = await pluginData<{ configured?: boolean }>(
      request,
      plugin,
      "page-bootstrap",
      organization,
    );
    return data.configured === true ? "ready" : "not-ready";
  }, { timeout: 15_000 }).toBe("ready");
}

async function findIssueByTitle(request: APIRequestContext, organization: Organization, title: string) {
  const issuesRes = await request.get(
    `/api/orgs/${organization.id}/issues?q=${encodeURIComponent(title)}`,
  );
  expect(issuesRes.ok()).toBe(true);
  const issues = await issuesRes.json() as IssueRecord[];
  return issues.find((issue) => issue.title === title) ?? null;
}

test.describe("Linear plugin import workflow", () => {
  test("imports Linear issues through the host/plugin bridge", async ({ request }) => {
    const { organization, project, secret } = await createLinearFixtureOrg(request);
    const plugin = await installLinearPlugin(request);
    await configureLinearTokenOnly(request, plugin, secret);

    const settingsCatalog = await pluginData<{
      teams: Array<{ id: string; name: string }>;
      projects: Array<{ id: string; name: string }>;
      users: Array<{ id: string; name: string }>;
    }>(request, plugin, "settings-catalog", organization);
    expect(settingsCatalog.teams).toContainEqual(expect.objectContaining({ id: "team-eng", name: "Engineering" }));
    expect(settingsCatalog.projects).toContainEqual(expect.objectContaining({ id: "proj-roadmap", name: "Roadmap" }));

    await configureLinearPlugin(request, plugin, organization, secret);
    await waitForLinearPageData(request, plugin, organization);

    const settings = await pluginData<{
      config: { apiTokenSecretRef: string };
      fixtureMode: boolean;
    }>(request, plugin, "settings-bootstrap", organization);
    expect(settings.config.apiTokenSecretRef).toBe(secret.id);
    expect(settings.fixtureMode).toBe(true);

    const bootstrap = await pluginData<{
      configured: boolean;
      projects: Project[];
    }>(request, plugin, "page-bootstrap", organization);
    expect(bootstrap.configured).toBe(true);
    expect(bootstrap.projects.map((entry) => entry.id)).toContain(project.id);

    const catalog = await pluginData<{
      teams: Array<{ id: string; name: string }>;
      projects: Array<{ id: string; name: string }>;
      users: Array<{ id: string; name: string }>;
    }>(request, plugin, "linear-catalog", organization);
    expect(catalog.teams).toContainEqual(expect.objectContaining({ id: "team-eng", name: "Engineering" }));
    expect(catalog.projects).toContainEqual(expect.objectContaining({ id: "proj-roadmap", name: "Roadmap" }));
    expect(catalog.users).toContainEqual(expect.objectContaining({ id: "user-amy", name: "Amy Zhang" }));

    const filtered = await pluginData<{
      rows: LinearIssueRow[];
    }>(request, plugin, "linear-issues", organization, {
      query: "Status mapped",
      limit: 25,
    });
    expect(filtered.rows.map((row) => row.identifier)).toEqual(["ENG-102"]);

    const missingTarget = await request.post(`/api/plugins/${plugin.id}/actions/import-linear-issues`, {
      data: {
        orgId: organization.id,
        params: {
          orgId: organization.id,
          mode: "selected",
          issueIds: ["lin-1"],
        },
      },
    });
    expect(missingTarget.ok()).toBe(false);
    expect(await missingTarget.text()).toContain("Choose a target project");

    const singleImport = await importLinearIssues(request, plugin, organization, {
      targetProjectId: project.id,
      mode: "selected",
      issueIds: ["lin-1"],
    });
    expect(singleImport).toMatchObject({
      importedCount: 1,
      duplicateCount: 0,
      fallbackCount: 0,
    });

    const afterSingleImport = await pluginData<{
      rows: LinearIssueRow[];
    }>(request, plugin, "linear-issues", organization, {
      query: "Backlog intake",
      limit: 25,
    });
    expect(afterSingleImport.rows[0]).toMatchObject({
      identifier: "ENG-101",
      imported: true,
      importedRudderIssueId: singleImport.importedIssues[0]?.rudderIssueId,
    });

    const linkedIssueId = singleImport.importedIssues[0]!.rudderIssueId;
    const linkedTabData = await pluginData<{
      linked: boolean;
      latestIssue: { identifier: string; title: string } | null;
      link: { externalId: string; linearIdentifier: string };
    }>(request, plugin, "issue-link", organization, {
      issueId: linkedIssueId,
    });
    expect(linkedTabData).toMatchObject({
      linked: true,
      latestIssue: {
        identifier: "ENG-101",
        title: "Backlog intake issue",
      },
      link: {
        externalId: "lin-1",
        linearIdentifier: "ENG-101",
      },
    });

    const duplicate = await importLinearIssues(request, plugin, organization, {
      targetProjectId: project.id,
      mode: "selected",
      issueIds: ["lin-1"],
    });
    expect(duplicate).toMatchObject({
      importedCount: 0,
      duplicateCount: 1,
    });

    const selectedImport = await importLinearIssues(request, plugin, organization, {
      targetProjectId: project.id,
      mode: "selected",
      issueIds: ["lin-2"],
    });
    expect(selectedImport).toMatchObject({
      importedCount: 1,
      adjustedCount: 1,
    });
    expect(selectedImport.importedIssues[0]).toMatchObject({
      linearId: "lin-2",
      adjustedStatus: true,
      finalStatus: "todo",
    });
    const adjustedIssue = await findIssueByTitle(request, organization, "Status mapped issue");
    expect(adjustedIssue).toMatchObject({
      status: "todo",
      projectId: project.id,
    });

    const allMatchingImport = await importLinearIssues(request, plugin, organization, {
      targetProjectId: project.id,
      mode: "allMatching",
      filters: {
        query: "Unmapped state fallback",
      },
    });
    expect(allMatchingImport).toMatchObject({
      importedCount: 1,
      fallbackCount: 1,
    });
    expect(allMatchingImport.importedIssues[0]).toMatchObject({
      linearId: "lin-3",
      fallbackStatus: true,
      finalStatus: "backlog",
    });
    const fallbackIssue = await findIssueByTitle(request, organization, "Unmapped state fallback issue");
    expect(fallbackIssue).toMatchObject({
      status: "backlog",
      projectId: project.id,
    });

    const manualIssueRes = await request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Manual issue without Linear link",
        status: "todo",
        priority: "medium",
      },
    });
    expect(manualIssueRes.ok()).toBe(true);
    const manualIssue = await manualIssueRes.json() as IssueRecord;
    const unlinkedTabData = await pluginData<{
      linked: boolean;
      issueTitle: string;
      searchQuery: string;
    }>(request, plugin, "issue-link", organization, {
      issueId: manualIssue.id,
    });
    expect(unlinkedTabData).toEqual({
      linked: false,
      issueTitle: "Manual issue without Linear link",
      searchQuery: "Manual issue without Linear link",
    });
  });
});
