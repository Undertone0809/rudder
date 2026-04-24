import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { E2E_HOME, E2E_INSTANCE_ID } from "./support/e2e-env";

test.use({ serviceWorkers: "block" });

function resolveOrganizationWorkspaceRoot(orgId: string) {
  return path.join(
    E2E_HOME,
    "instances",
    E2E_INSTANCE_ID,
    "organizations",
    orgId,
    "workspaces",
  );
}

function normalizeAgentSlug(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "agent";
}

function buildWorkspaceKey(name: string, agentId: string) {
  return `${normalizeAgentSlug(name)}--${agentId.replace(/-/g, "").toLowerCase().slice(0, 8)}`;
}

async function selectOrganization(page: Page, orgId: string) {
  await page.goto("/");
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

async function gotoOrganizationPath(page: Page, organization: { id: string; issuePrefix: string }, path: string) {
  await selectOrganization(page, organization.id);
  await page.goto(`/${organization.issuePrefix}${path}`);
}

async function expectBackdropOnlyShell(page: Page) {
  const shell = page.getByTestId("workspace-shell");
  await expect(shell).toBeVisible();

  const shellStyles = await shell.evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      backgroundColor: styles.backgroundColor,
      borderTopWidth: styles.borderTopWidth,
      boxShadow: styles.boxShadow,
    };
  });

  expect(shellStyles.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(shellStyles.borderTopWidth).toBe("0px");
  expect(shellStyles.boxShadow).toBe("none");
}

async function expectDualCardWorkspace(page: Page) {
  const shell = page.getByTestId("workspace-shell");
  const contextCard = page.getByTestId("workspace-context-card");
  const mainCard = page.getByTestId("workspace-main-card");

  await expectBackdropOnlyShell(page);
  await expect(contextCard).toBeVisible();
  await expect(mainCard).toBeVisible();

  const cardStyles = await Promise.all([
    contextCard.evaluate((element) => {
      const styles = getComputedStyle(element);
      return {
        backgroundColor: styles.backgroundColor,
        borderTopColor: styles.borderTopColor,
      };
    }),
    mainCard.evaluate((element) => {
      const styles = getComputedStyle(element);
      return {
        backgroundColor: styles.backgroundColor,
        borderTopColor: styles.borderTopColor,
      };
    }),
  ]);

  expect(cardStyles[0].backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(cardStyles[1].backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(cardStyles[0].borderTopColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(cardStyles[1].borderTopColor).not.toBe("rgba(0, 0, 0, 0)");

  const shellBox = await shell.boundingBox();
  const contextCardBox = await contextCard.boundingBox();
  const mainCardBox = await mainCard.boundingBox();

  expect(shellBox).not.toBeNull();
  expect(contextCardBox).not.toBeNull();
  expect(mainCardBox).not.toBeNull();

  const topInset = contextCardBox!.y - shellBox!.y;
  const gutter = mainCardBox!.x - (contextCardBox!.x + contextCardBox!.width);

  expect(topInset).toBeLessThanOrEqual(10);
  expect(gutter).toBeLessThanOrEqual(14);
}

test.describe("Workspace shell", () => {
  test("keeps the shared desktop wrapper visually neutral", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Workspace-Shell-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    await selectOrganization(page, organization.id);
    await page.goto("/inbox/recent");

    const shell = page.getByTestId("workspace-shell");
    const mainCard = page.getByTestId("workspace-main-card");
    await expect(shell).toBeVisible();
    await expect(mainCard).toBeVisible();
    await expect(page.getByTestId("workspace-context-header").getByRole("heading", { name: "Messenger", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Goals" })).toHaveCount(0);
    await expect(page.locator("#main-content")).toHaveClass(/scrollbar-auto-hide/);

    const shellBox = await shell.boundingBox();
    const mainBox = await page.locator("#main-content").boundingBox();
    const viewport = page.viewportSize();

    expect(shellBox).not.toBeNull();
    expect(mainBox).not.toBeNull();
    expect(viewport).not.toBeNull();

    expect(shellBox!.x).toBeGreaterThan(48);
    expect(shellBox!.y).toBeGreaterThan(2);
    expect(shellBox!.width).toBeLessThan(viewport!.width - 16);
    expect(mainBox!.x).toBeGreaterThanOrEqual(shellBox!.x);
    expect(mainBox!.y).toBeGreaterThan(shellBox!.y);

    await expectBackdropOnlyShell(page);

    await page.screenshot({
      path: testInfo.outputPath("workspace-shell-inbox.png"),
      fullPage: true,
    });
  });

  test("keeps the issues context sidebar inside the workspace shell", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Workspace-Shell-Issues-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    await gotoOrganizationPath(page, organization, "/issues?scope=assigned");

    const shell = page.getByTestId("workspace-shell");
    const sidebar = page.getByTestId("workspace-sidebar");
    const contextHeader = page.getByTestId("workspace-context-header");
    const contextCard = page.getByTestId("workspace-context-card");
    const resizer = page.getByTestId("workspace-column-resizer");
    const mainHeader = page.getByTestId("workspace-main-header");
    const mainCard = page.getByTestId("workspace-main-card");
    const main = page.locator("#main-content");

    await expect(shell).toBeVisible();
    await expect(sidebar).toBeVisible();
    await expect(contextHeader).toBeVisible();
    await expect(contextCard).toBeVisible();
    await expect(resizer).toBeVisible();
    await expect(mainHeader).toBeVisible();
    await expect(mainCard).toBeVisible();
    await expect(main).toBeVisible();
    await expectDualCardWorkspace(page);

    const shellBox = await shell.boundingBox();
    const sidebarBox = await sidebar.boundingBox();
    const contextCardBox = await contextCard.boundingBox();
    const mainCardBox = await mainCard.boundingBox();
    const mainBox = await main.boundingBox();

    expect(shellBox).not.toBeNull();
    expect(sidebarBox).not.toBeNull();
    expect(contextCardBox).not.toBeNull();
    expect(mainCardBox).not.toBeNull();
    expect(mainBox).not.toBeNull();

    expect(contextCardBox!.x).toBeGreaterThanOrEqual(shellBox!.x);
    expect(sidebarBox!.x).toBeGreaterThanOrEqual(contextCardBox!.x);
    expect(sidebarBox!.x + sidebarBox!.width).toBeLessThanOrEqual(contextCardBox!.x + contextCardBox!.width);
    expect(mainCardBox!.x).toBeGreaterThan(contextCardBox!.x + contextCardBox!.width - 4);
    expect(mainBox!.x).toBeGreaterThanOrEqual(mainCardBox!.x);

    const widthBeforeResize = contextCardBox!.width;
    const resizerBox = await resizer.boundingBox();
    expect(resizerBox).not.toBeNull();
    await page.mouse.move(resizerBox!.x + resizerBox!.width / 2, resizerBox!.y + resizerBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(resizerBox!.x + resizerBox!.width / 2 + 36, resizerBox!.y + resizerBox!.height / 2);
    await page.mouse.up();

    const resizedContextBox = await contextCard.boundingBox();
    expect(resizedContextBox).not.toBeNull();
    expect(resizedContextBox!.width).toBeGreaterThan(widthBeforeResize);

    await page.screenshot({
      path: testInfo.outputPath("workspace-shell-issues.png"),
      fullPage: true,
    });
  });

  test("renders agents as a rail plus dual workspace cards", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Workspace-Shell-Agents-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Surface Hierarchy Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json();

    await page.route(`**/api/orgs/${organization.id}/live-runs`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "run-live-1",
            status: "running",
            invocationSource: "manual",
            triggerDetail: "Manual wakeup",
            startedAt: "2026-04-18T10:00:00.000Z",
            finishedAt: null,
            createdAt: "2026-04-18T10:00:00.000Z",
            agentId: agent.id,
            agentName: agent.name,
            agentRuntimeType: agent.agentRuntimeType,
            issueId: null,
          },
        ]),
      });
    });

    await gotoOrganizationPath(page, organization, "/agents/all");

    await expect(page.getByTestId("workspace-context-header").getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Filters" })).toBeVisible();
    const sidebarAgentRow = page.getByTestId("workspace-sidebar").getByRole("link", { name: /Surface Hierarchy Agent/i });
    await expect(sidebarAgentRow).toBeVisible();
    await expect(sidebarAgentRow.getByText("1 live", { exact: true })).toBeVisible();
    await expectDualCardWorkspace(page);

    await page.screenshot({
      path: testInfo.outputPath("workspace-shell-agents.png"),
      fullPage: true,
    });
  });

  test("renders projects inside the org workspace shell", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Workspace-Shell-Projects-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Surface hierarchy project",
        description: "Used to verify the compact dual-card project shell.",
      },
    });
    expect(projectRes.ok()).toBe(true);

    await gotoOrganizationPath(page, organization, "/projects");

    const primaryRail = page.getByTestId("primary-rail");
    const sidebar = page.getByTestId("workspace-sidebar");

    await expect(primaryRail.getByRole("link", { name: "Projects" })).toHaveCount(0);
    await expect(page.getByTestId("workspace-context-header").getByRole("heading", { name: "Org", exact: true })).toBeVisible();
    await expect(page.getByTestId("workspace-main-header").getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add Project" })).toBeVisible();
    await expect(sidebar.getByText("Projects", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("Surface hierarchy project", { exact: true })).toBeVisible();
    const projectSectionHeader = sidebar.getByTestId("workspace-projects-section");
    const sidebarCreateProjectButton = sidebar.getByRole("button", { name: "New project" });
    await expect(sidebarCreateProjectButton).toHaveCSS("opacity", "0");
    await projectSectionHeader.hover();
    await expect(sidebarCreateProjectButton).toHaveCSS("opacity", "1");
    await sidebarCreateProjectButton.click();
    await expect(page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New project") }).first()).toBeVisible();
    await expectDualCardWorkspace(page);

    await page.mouse.move(0, 0);
    await page.screenshot({
      path: testInfo.outputPath("workspace-shell-projects-sidebar-hover.png"),
      fullPage: true,
    });
  });

  test("opens project detail on configuration without an overview tab", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Workspace-Shell-Project-Detail-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Project detail routing",
        description: "Verifies project detail defaults to configuration.",
      },
    });
    expect(projectRes.ok()).toBe(true);
    const project = await projectRes.json() as { id: string; urlKey?: string | null };

    await gotoOrganizationPath(page, organization, `/projects/${project.urlKey ?? project.id}`);

    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/projects/[^/]+/configuration$`));
    await expect(page.locator('[role="tablist"] [role="tab"]')).toHaveText([
      "Configuration",
      "Resources",
      "Budget",
      "Issues",
    ]);
    await expect(page.getByRole("tab", { name: "Overview" })).toHaveCount(0);
    await expect(page.locator("#main-content").getByText("Description", { exact: true })).toBeVisible();
    await expect(page.locator("#main-content").getByText("Status", { exact: true })).toBeVisible();

    await page.screenshot({
      path: testInfo.outputPath("workspace-shell-project-detail-configuration.png"),
      fullPage: true,
    });
  });

  test("routes the project issues tab to the filtered issue tracker", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Workspace-Shell-Project-Issues-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Project issues tab",
        description: "Verifies the project tab routes to the issue tracker.",
      },
    });
    expect(projectRes.ok()).toBe(true);
    const project = await projectRes.json() as { id: string; urlKey?: string | null };

    await gotoOrganizationPath(page, organization, `/projects/${project.urlKey ?? project.id}/configuration`);

    await page.getByRole("tab", { name: "Issues" }).click();

    await expect(page).toHaveURL(
      new RegExp(`/${organization.issuePrefix}/issues\\?projectId=${project.id.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}$`),
    );
    await expect(page.getByTestId("workspace-main-header").getByRole("heading", { name: "Issue Tracker", exact: true })).toBeVisible();

    await page.screenshot({
      path: testInfo.outputPath("workspace-shell-project-issues-tab.png"),
      fullPage: true,
    });
  });

  test("keeps project resources in a dedicated project tab and org catalog", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Workspace-Shell-Project-Resources-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const repoResourceRes = await page.request.post(`/api/orgs/${organization.id}/resources`, {
      data: {
        name: "Rudder repo",
        kind: "directory",
        locator: "~/projects/rudder",
        description: "Main monorepo for implementation work.",
      },
    });
    expect(repoResourceRes.ok()).toBe(true);
    const repoResource = await repoResourceRes.json() as { id: string };

    const specResourceRes = await page.request.post(`/api/orgs/${organization.id}/resources`, {
      data: {
        name: "SPEC doc",
        kind: "file",
        locator: "~/projects/rudder/doc/SPEC-implementation.md",
        description: "Concrete implementation contract for the product.",
      },
    });
    expect(specResourceRes.ok()).toBe(true);

    const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Project resource separation",
        description: "Verifies project resources stay separate from workspaces.",
      },
    });
    expect(projectRes.ok()).toBe(true);
    const project = await projectRes.json() as { id: string; urlKey?: string | null };

    const attachRepoRes = await page.request.post(`/api/projects/${project.id}/resources?orgId=${organization.id}`, {
      data: {
        resourceId: repoResource.id,
        role: "working_set",
        note: "Primary codebase for shipping changes.",
        sortOrder: 0,
      },
    });
    expect(attachRepoRes.ok()).toBe(true);

    await gotoOrganizationPath(page, organization, `/projects/${project.urlKey ?? project.id}/resources`);

    const mainContent = page.locator("#main-content");
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/projects/[^/]+/resources$`));
    await expect(page.getByRole("tab", { name: "Resources" })).toBeVisible();
    await expect(mainContent.getByText("Project Context", { exact: true })).toBeVisible();
    await expect(mainContent.getByRole("button", { name: "Attach existing" })).toBeVisible();
    await expect(mainContent.getByRole("button", { name: "Add resource" })).toBeVisible();
    await expect(mainContent.getByRole("link", { name: "Org catalog" })).toBeVisible();
    await expect(mainContent.getByText("Rudder repo", { exact: true })).toBeVisible();
    await expect(
      mainContent.getByRole("textbox", { name: "Optional project-specific guidance for agents" }),
    ).toHaveValue("Primary codebase for shipping changes.");

    const attachResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/api/projects/${project.id}/resources?orgId=${organization.id}`)
      && response.ok(),
    );
    await mainContent.getByRole("button", { name: "Attach existing" }).click();
    await expect(page.getByText("Attach from org catalog", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /SPEC doc/i }).click();
    await attachResponse;
    await expect(mainContent.getByText("SPEC doc", { exact: true })).toBeVisible();

    await page.screenshot({
      path: testInfo.outputPath("workspace-shell-project-resources.png"),
      fullPage: true,
    });

    await mainContent.getByRole("link", { name: "Org catalog" }).click();
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/resources$`));
    await expect(page.getByTestId("workspace-main-header").getByRole("heading", { name: "Resources", exact: true })).toBeVisible();
  });

  test("surfaces org workspaces in the shared three-column shell", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Workspace-Shell-Org-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    await gotoOrganizationPath(page, organization, "/org");

    const shell = page.getByTestId("workspace-shell");
    const sidebar = page.getByTestId("workspace-sidebar");
    const contextHeader = page.getByTestId("workspace-context-header");
    const contextCard = page.getByTestId("workspace-context-card");
    const mainHeader = page.getByTestId("workspace-main-header");
    const mainCard = page.getByTestId("workspace-main-card");

    await expect(shell).toBeVisible();
    await expect(sidebar).toBeVisible();
    await expect(contextHeader).toBeVisible();
    await expect(contextCard).toBeVisible();
    await expect(mainHeader).toBeVisible();
    await expect(mainCard).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Structure" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Resources" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Heartbeats" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Workspaces" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Goals" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Skills" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Costs" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Activity" })).toBeVisible();
    await expectDualCardWorkspace(page);

    const shellBox = await shell.boundingBox();
    const sidebarBox = await sidebar.boundingBox();
    const contextCardBox = await contextCard.boundingBox();
    const mainCardBox = await mainCard.boundingBox();
    expect(shellBox).not.toBeNull();
    expect(sidebarBox).not.toBeNull();
    expect(contextCardBox).not.toBeNull();
    expect(mainCardBox).not.toBeNull();
    expect(contextCardBox!.x).toBeGreaterThanOrEqual(shellBox!.x);
    expect(sidebarBox!.x).toBeGreaterThanOrEqual(contextCardBox!.x);
    expect(sidebarBox!.x + sidebarBox!.width).toBeLessThanOrEqual(contextCardBox!.x + contextCardBox!.width);
    expect(mainCardBox!.x).toBeGreaterThan(contextCardBox!.x + contextCardBox!.width - 4);

    await page.screenshot({
      path: testInfo.outputPath("workspace-shell-org.png"),
      fullPage: true,
    });
  });

  test("renders org heartbeats as an org-scoped runtime control page", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Workspace-Shell-Heartbeats-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const scheduledAgentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Nia",
        role: "ceo",
        title: "CEO",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
        },
        runtimeConfig: {
          heartbeat: {
            enabled: true,
            intervalSec: 300,
          },
        },
      },
    });
    expect(scheduledAgentRes.ok()).toBe(true);

    const disabledAgentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Rosalie",
        role: "engineer",
        title: "Founding Engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
        },
        runtimeConfig: {
          heartbeat: {
            enabled: false,
            intervalSec: 0,
          },
        },
      },
    });
    expect(disabledAgentRes.ok()).toBe(true);

    await gotoOrganizationPath(page, organization, "/heartbeats");

    const sidebar = page.getByTestId("workspace-sidebar");
    const mainHeader = page.getByTestId("workspace-main-header");
    const niaRow = page.getByTestId("org-heartbeat-row").filter({
      has: page.getByRole("link", { name: "Nia", exact: true }),
    });

    await expect(sidebar.getByRole("link", { name: "Heartbeats" })).toHaveClass(/font-medium/);
    await expect(mainHeader.getByRole("heading", { name: "Heartbeats", exact: true })).toBeVisible();
    await expect(page.getByTestId("workspace-main-card").getByText("Agents", { exact: true })).toBeVisible();
    await expect(page.getByText("Recent activity", { exact: true })).toBeVisible();
    await expect(page.getByTestId("org-heartbeat-row")).toHaveCount(2);
    await expect(niaRow.getByText("Scheduled", { exact: true })).toBeVisible();
    await expect(niaRow.getByRole("button", { name: "Run now" })).toBeVisible();

    const toggleResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().includes("/api/agents/")
      && response.ok(),
    );
    await niaRow.getByRole("button", { name: "Off", exact: true }).click();
    await toggleResponse;
    await expect(niaRow.getByText("Disabled", { exact: true })).toBeVisible();

    await page.screenshot({
      path: testInfo.outputPath("workspace-shell-org-heartbeats.png"),
      fullPage: true,
    });
  });

  test("shows the org workspace file browser inside the organization shell", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Workspace-Shell-Files-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Nia",
        icon: "sparkles",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    const originalWorkspaceKey = buildWorkspaceKey("Nia", agent.id);
    const agentWorkspaceRoot = path.join(
      resolveOrganizationWorkspaceRoot(organization.id),
      "agents",
      originalWorkspaceKey,
    );
    await fs.writeFile(path.join(resolveOrganizationWorkspaceRoot(organization.id), "notes.md"), "# Shared Notes\n", "utf8");
    await fs.mkdir(path.join(agentWorkspaceRoot, ".cache"), { recursive: true });
    await fs.mkdir(path.join(agentWorkspaceRoot, ".npm"), { recursive: true });
    await fs.mkdir(path.join(agentWorkspaceRoot, ".nvm"), { recursive: true });
    await fs.writeFile(path.join(agentWorkspaceRoot, ".DS_Store"), "", "utf8");
    await fs.mkdir(path.join(agentWorkspaceRoot, "instructions"), { recursive: true });
    await fs.writeFile(path.join(agentWorkspaceRoot, "instructions", "HEARTBEAT.md"), "# Heartbeat\n", "utf8");

    const renameRes = await page.request.patch(`/api/agents/${agent.id}`, {
      data: {
        name: "Jade",
      },
    });
    expect(renameRes.ok()).toBe(true);

    await gotoOrganizationPath(page, organization, "/resources");

    const sidebar = page.getByTestId("workspace-sidebar");
    const mainContent = page.locator("#main-content");
    const mainHeader = page.getByTestId("workspace-main-header");
    const workspacesHelp = mainHeader.getByRole("button", { name: "About organization resources" });
    await expect(sidebar.getByRole("link", { name: "Resources" })).toHaveClass(/font-medium/);
    await expect(sidebar.getByRole("link", { name: "Workspaces" })).toBeVisible();
    await expect(mainHeader.getByRole("heading", { name: "Resources", exact: true })).toBeVisible();
    await expect(mainContent.getByRole("button", { name: "Add resource" })).toBeVisible();
    await expect(mainContent.getByRole("link", { name: "Browse workspaces" })).toBeVisible();
    await expect(workspacesHelp).toBeVisible();
    await workspacesHelp.hover();
    await expect(page.getByText(/shared resource catalog for repos, docs, urls, and connector objects/i)).toBeVisible();
    await expect(mainContent.getByText("Catalog", { exact: true })).toBeVisible();
    await expect(mainContent.getByText("Agent Run Context")).toBeVisible();
    await expect(page.getByTestId("org-workspaces-files-card")).toHaveCount(0);

    await mainContent.getByRole("link", { name: "Browse workspaces" }).click();
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/workspaces$`));

    const filesCard = page.getByTestId("org-workspaces-files-card");
    const editorCard = page.getByTestId("org-workspaces-editor-card");
    const workspacesHeader = page.getByTestId("workspace-main-header");
    const workspaceHelp = workspacesHeader.getByRole("button", { name: "About organization workspaces" });
    await expect(sidebar.getByRole("link", { name: "Workspaces" })).toHaveClass(/font-medium/);
    await expect(workspacesHeader.getByRole("heading", { name: "Workspaces", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();
    await expect(filesCard.getByText("/", { exact: true })).toBeVisible();
    await workspaceHelp.hover();
    await expect(page.getByText(/shared workspace files, plans, and skill packages/i)).toBeVisible();
    await expect(filesCard.getByRole("button", { name: "notes.md", exact: true })).toBeVisible();
    await mainContent.getByRole("button", { name: "agents", exact: true }).click();
    await expect(mainContent.getByRole("button", { name: "Jade", exact: true })).toBeVisible();
    await expect(mainContent.getByRole("button", { name: originalWorkspaceKey, exact: true })).toHaveCount(0);
    await expect(filesCard.getByText(originalWorkspaceKey, { exact: true })).toHaveCount(0);
    await expect(
      mainContent
        .getByRole("button", { name: "Jade", exact: true })
        .locator('[aria-hidden="true"] svg'),
    ).toBeVisible();
    await mainContent.getByRole("button", { name: "Jade", exact: true }).click();
    await expect(mainContent.getByRole("button", { name: "instructions", exact: true })).toBeVisible();
    await expect(mainContent.getByRole("button", { name: ".DS_Store", exact: true })).toHaveCount(0);
    await expect(mainContent.getByRole("button", { name: ".cache", exact: true })).toHaveCount(0);
    await expect(mainContent.getByRole("button", { name: ".npm", exact: true })).toHaveCount(0);
    await expect(mainContent.getByRole("button", { name: ".nvm", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Activate for agents" })).toHaveCount(0);

    await page.getByRole("button", { name: "notes.md", exact: true }).click();
    await expect(page.locator("textarea")).toHaveValue("# Shared Notes\n");

    await page.locator("textarea").fill("# Shared Notes\n\n- Keep project setup docs nearby.\n");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Workspace file saved")).toBeVisible();

    const [mainCardBox, filesCardBox, editorCardBox, editorTextareaBox] = await Promise.all([
      page.getByTestId("workspace-main-card").boundingBox(),
      filesCard.boundingBox(),
      editorCard.boundingBox(),
      page.getByTestId("org-workspaces-editor-textarea").boundingBox(),
    ]);
    expect(mainCardBox).not.toBeNull();
    expect(filesCardBox).not.toBeNull();
    expect(editorCardBox).not.toBeNull();
    expect(editorTextareaBox).not.toBeNull();
    expect(mainCardBox!.y + mainCardBox!.height - (filesCardBox!.y + filesCardBox!.height)).toBeLessThanOrEqual(40);
    expect(mainCardBox!.y + mainCardBox!.height - (editorCardBox!.y + editorCardBox!.height)).toBeLessThanOrEqual(40);
    expect(editorCardBox!.y + editorCardBox!.height - (editorTextareaBox!.y + editorTextareaBox!.height)).toBeLessThanOrEqual(24);

    await page.screenshot({
      path: testInfo.outputPath("workspace-shell-org-files.png"),
      fullPage: true,
    });
  });

  test("renders goals inside the org workspace shell", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Workspace-Shell-Goals-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    await gotoOrganizationPath(page, organization, "/goals");

    const shell = page.getByTestId("workspace-shell");
    const sidebar = page.getByTestId("workspace-sidebar");
    const contextCard = page.getByTestId("workspace-context-card");
    const mainCard = page.getByTestId("workspace-main-card");

    await expect(shell).toBeVisible();
    await expect(sidebar).toBeVisible();
    await expect(contextCard).toBeVisible();
    await expect(mainCard).toBeVisible();
    await expect(page.getByRole("heading", { name: "Goals" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Goals" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Goals" })).toHaveClass(/font-medium/);
    await expectDualCardWorkspace(page);

    await page.screenshot({
      path: testInfo.outputPath("workspace-shell-goals.png"),
      fullPage: true,
    });
  });

  test("renders compact, status-tinted issue board lanes", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Workspace-Shell-Issue-Board-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const backlogRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Backlog lane issue",
        description: "Used to verify backlog styling.",
        status: "backlog",
        priority: "medium",
      },
    });
    expect(backlogRes.ok()).toBe(true);

    const todoRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Todo lane issue",
        description: "Used to verify todo styling.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(todoRes.ok()).toBe(true);

    await selectOrganization(page, organization.id);
    await page.goto("/issues");
    await page.getByTitle("Board view").click();

    const toolbar = page.getByTestId("issues-view-toolbar");
    const backlogColumn = page.getByTestId("kanban-column-backlog");
    const todoColumn = page.getByTestId("kanban-column-todo");
    const hiddenColumns = page.getByTestId("kanban-hidden-columns");
    const hiddenInProgress = page.getByTestId("kanban-hidden-column-in_progress");
    const hiddenDone = page.getByTestId("kanban-hidden-column-done");
    const boardMain = page.locator("#main-content");

    await expect(toolbar).toBeVisible();
    await expect(backlogColumn).toBeVisible();
    await expect(todoColumn).toBeVisible();
    await expect(hiddenColumns).toBeVisible();
    await expect(hiddenInProgress).toBeVisible();
    await expect(hiddenDone).toBeVisible();
    await expect(page.getByTestId("kanban-column-in_progress")).toHaveCount(0);
    await expect(boardMain).toBeVisible();
    await expect(page.getByText("Backlog lane issue", { exact: true })).toBeVisible();
    await expect(page.getByText("Todo lane issue", { exact: true })).toBeVisible();
    await expect(hiddenColumns.getByText("Hidden columns", { exact: true })).toBeVisible();

    const toolbarStyles = await toolbar.evaluate((element) => {
      const styles = getComputedStyle(element);
      return {
        radius: Number.parseFloat(styles.borderTopLeftRadius),
      };
    });

    const backlogStyles = await backlogColumn.evaluate((element) => {
      const styles = getComputedStyle(element);
      return {
        background: styles.backgroundColor,
        border: styles.borderTopColor,
        radius: Number.parseFloat(styles.borderTopLeftRadius),
      };
    });

    const todoStyles = await todoColumn.evaluate((element) => {
      const styles = getComputedStyle(element);
      return {
        background: styles.backgroundColor,
        border: styles.borderTopColor,
        radius: Number.parseFloat(styles.borderTopLeftRadius),
      };
    });

    const backlogBox = await backlogColumn.boundingBox();
    const todoBox = await todoColumn.boundingBox();
    const hiddenColumnsBox = await hiddenColumns.boundingBox();
    const boardMainBox = await boardMain.boundingBox();

    expect(toolbarStyles.radius).toBeGreaterThan(0);
    expect(toolbarStyles.radius).toBeLessThan(12);
    expect(backlogStyles.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(todoStyles.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(backlogStyles.background).not.toBe(todoStyles.background);
    expect(backlogStyles.border).not.toBe(todoStyles.border);
    expect(backlogStyles.radius).toBeLessThan(12);
    expect(todoStyles.radius).toBeLessThan(12);
    expect(backlogBox).not.toBeNull();
    expect(todoBox).not.toBeNull();
    expect(hiddenColumnsBox).not.toBeNull();
    expect(boardMainBox).not.toBeNull();
    expect(backlogBox!.height).toBeGreaterThan(420);
    expect(todoBox!.height).toBeGreaterThan(420);
    expect(Math.abs(backlogBox!.height - todoBox!.height)).toBeLessThanOrEqual(2);
    expect(backlogBox!.height).toBeLessThanOrEqual(boardMainBox!.height);
    expect(hiddenColumnsBox!.width).toBeLessThan(backlogBox!.width);

    await page.screenshot({
      path: testInfo.outputPath("workspace-shell-issues-board.png"),
      fullPage: true,
    });
  });

  test("renders desktop settings as a centered modal shell and applies locale changes immediately", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Workspace-Shell-Settings-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    await selectOrganization(page, organization.id);
    await page.goto("/instance/settings/general");

    const modal = page.getByTestId("settings-modal-shell");
    const modalSidebar = modal.getByTestId("workspace-sidebar");
    const viewport = page.viewportSize();

    await expect(modal).toBeVisible();
    await expect(modalSidebar).toBeVisible();
    await expect(page.getByText("Choose the language used across the board UI for this Rudder instance.")).toBeVisible();
    await expect(
      page.getByText(
        "This is an instance-wide UI language. It applies to the board shell and settings pages for everyone using this instance.",
      ),
    ).toHaveCount(0);
    await expect(page.getByTestId("workspace-shell")).toHaveCount(0);
    await expect(modal.getByText("System settings")).toHaveCount(0);
    await expect(modal.locator('[aria-label="Organization menu"]')).toHaveCount(0);

    const modalBox = await modal.boundingBox();
    const modalSidebarBox = await modalSidebar.boundingBox();
    expect(modalBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(modalSidebarBox).not.toBeNull();
    expect(modalBox!.width).toBeGreaterThan(940);
    expect(modalBox!.width).toBeLessThan(viewport!.width - 120);
    expect(modalBox!.y).toBeGreaterThan(8);
    expect(modalSidebarBox!.width).toBeLessThan(260);

    const updateLocaleResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().includes("/api/instance/settings/general")
      && response.ok(),
    );
    await modal.getByText("简体中文", { exact: true }).click();
    await updateLocaleResponse;

    await expect(modal.getByRole("heading", { name: "通用", exact: true })).toBeVisible();
    await expect(modal.getByText("这些系统偏好会应用到当前设备上的控制台界面和开发者工具。")).toBeVisible();
    await expect(modal.getByText("Choose the language used across the board UI for this Rudder instance.")).toHaveCount(0);
    await expect(
      modal.getByText("这是实例级界面语言，会影响所有使用这个实例的用户看到的控制台外壳和设置页面。"),
    ).toHaveCount(0);

    await page.screenshot({
      path: testInfo.outputPath("workspace-shell-settings-modal.png"),
      fullPage: true,
    });
  });
});
