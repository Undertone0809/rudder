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

async function installDesktopShellWorkspaceIdeStub(page: Page) {
  await page.addInitScript(() => {
    const ideCalls: Array<{ rootPath: string; filePath: string; ideId?: string }> = [];
    const workspaceCalls: Array<{ rootPath: string; targetId?: string }> = [];
    const pathCalls: string[] = [];
    const externalCalls: string[] = [];
    Object.defineProperty(window, "__rudderWorkspaceIdeCalls", {
      configurable: true,
      value: ideCalls,
      writable: false,
    });
    Object.defineProperty(window, "__rudderWorkspaceOpenCalls", {
      configurable: true,
      value: workspaceCalls,
      writable: false,
    });
    Object.defineProperty(window, "__rudderPathOpenCalls", {
      configurable: true,
      value: pathCalls,
      writable: false,
    });
    Object.defineProperty(window, "__rudderExternalOpenCalls", {
      configurable: true,
      value: externalCalls,
      writable: false,
    });

    const desktopShell = {
      getBootState: async () => ({}),
      onBootState: () => () => {},
      openPath: async (targetPath: string) => {
        pathCalls.push(targetPath);
      },
      listAvailableIdes: async () => [{ id: "cursor", label: "Cursor" }],
      listWorkspaceLaunchTargets: async () => [
        { id: "cursor", label: "Cursor", kind: "ide" },
        { id: "terminal", label: "Terminal", kind: "terminal" },
        { id: "finder", label: "Finder", kind: "folder" },
      ],
      openWorkspace: async (rootPath: string, targetId?: string) => {
        workspaceCalls.push({ rootPath, targetId });
      },
      openWorkspaceFileInIde: async (rootPath: string, filePath: string, ideId?: string) => {
        ideCalls.push({ rootPath, filePath, ideId });
      },
      copyText: async () => {},
      setAppearance: async () => {},
      restart: async () => {},
      getAppVersion: async () => "0.0.0-test",
      checkForUpdates: async () => ({
        status: "unavailable",
        currentVersion: "0.0.0-test",
        checkedAt: "1970-01-01T00:00:00.000Z",
      }),
      getSystemPermissions: async () => ({}),
      sendFeedback: async () => {},
      openExternal: async (target: string) => {
        externalCalls.push(target);
      },
      openNotificationSettings: async () => ({ opened: false, platform: "darwin" }),
      setBadgeCount: async () => {},
      showNotification: async () => {},
      pickPath: async () => ({ canceled: true, path: null }),
    };

    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: desktopShell,
    });
  });
}

test.describe("Workspace shell", () => {
  test("starts new organization Library roots without legacy plans or artifacts folders", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Workspace-Shell-Library-Roots-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(organization.id);

    await expect(async () => fs.stat(path.join(workspaceRoot, "agents"))).toPass();
    await expect(async () => fs.stat(path.join(workspaceRoot, "skills"))).toPass();
    await expect(async () => fs.stat(path.join(workspaceRoot, "projects"))).toPass();
    await expect(fs.stat(path.join(workspaceRoot, "plans"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(workspaceRoot, "artifacts"))).rejects.toMatchObject({ code: "ENOENT" });

    await installDesktopShellWorkspaceIdeStub(page);
    await gotoOrganizationPath(page, organization, "/library");
    const filesCard = page.getByTestId("org-workspaces-files-card");
    await expect(filesCard.getByRole("button", { name: "agents", exact: true })).toBeVisible();
    await expect(filesCard.getByRole("button", { name: "skills", exact: true })).toBeVisible();
    await expect(filesCard.getByRole("button", { name: "projects", exact: true })).toBeVisible();
    await expect(filesCard.getByRole("button", { name: "plans", exact: true })).toHaveCount(0);
    await expect(filesCard.getByRole("button", { name: "artifacts", exact: true })).toHaveCount(0);

    await filesCard.getByRole("button", { name: "agents", exact: true }).hover();
    await page.getByTestId("org-workspaces-entry-more-agents").click();
    const copyAbsolutePathItem = page.getByRole("menuitem", { name: "Copy absolute path" });
    await expect(copyAbsolutePathItem).toBeVisible();
    const menuBox = await page.locator('[data-slot="dropdown-menu-content"]').boundingBox();
    const copyItemMetrics = await copyAbsolutePathItem.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(menuBox?.width).toBeGreaterThanOrEqual(230);
    expect(copyItemMetrics.height).toBeLessThan(36);
    expect(copyItemMetrics.scrollWidth).toBeLessThanOrEqual(copyItemMetrics.clientWidth + 1);
  });

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

  test("collapses and reopens the desktop workspace context sidebar", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Workspace-Shell-Collapse-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Collapsible Sidebar Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string; urlKey?: string | null };

    await gotoOrganizationPath(page, organization, `/agents/${agent.urlKey ?? agent.id}/dashboard`);

    const contextCard = page.getByTestId("workspace-context-card");
    const collapseButton = page.getByRole("button", { name: "Collapse workspace sidebar" });
    await expect(contextCard).toBeVisible();
    await expect(collapseButton).toBeVisible();

    await collapseButton.click();

    await expect(contextCard).toHaveAttribute("aria-hidden", "true");
    await expect(contextCard).toHaveCSS("opacity", "0");
    await expect(contextCard).toHaveJSProperty("offsetWidth", 0);
    const resizer = page.getByTestId("workspace-column-resizer");
    await expect(resizer).toHaveCSS("opacity", "0");
    await expect(resizer).toHaveJSProperty("offsetWidth", 0);
    const openButton = page.getByRole("button", { name: "Open workspace sidebar" });
    await expect(openButton).toBeVisible();

    await openButton.click();

    await expect(contextCard).toBeVisible();
    await expect(contextCard).toHaveAttribute("aria-hidden", "false");
    await expect(contextCard).toHaveCSS("opacity", "1");
    await expect(collapseButton).toBeVisible();
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
      "Context",
      "Budget",
      "Issues",
    ]);
    await expect(page.getByRole("tab", { name: "Overview" })).toHaveCount(0);
    await expect(page.locator("#main-content").getByText("Description", { exact: true })).toBeVisible();
    await expect(page.locator("#main-content").getByText("Status", { exact: true })).toBeVisible();
    await expect(page.locator("#main-content").getByText("Execution Workspaces", { exact: true })).toHaveCount(0);
    await expect(page.locator("#main-content").getByText("Enable isolated issue checkouts", { exact: true })).toHaveCount(0);

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

  test("keeps project context in a dedicated project tab and Library", async ({ page }, testInfo) => {
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
    const repoAttachment = await attachRepoRes.json() as { id: string };

    await gotoOrganizationPath(page, organization, `/projects/${project.urlKey ?? project.id}/resources`);

    const mainContent = page.locator("#main-content");
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/projects/[^/]+/resources$`));
    await expect(page.getByRole("tab", { name: "Context" })).toBeVisible();
    await expect(mainContent.getByText("Project Context", { exact: true })).toHaveCount(1);
    await expect(mainContent.getByRole("button", { name: "Add resources" })).toBeVisible();
    await expect(mainContent.getByText("Rudder repo", { exact: true })).toBeVisible();
    await expect(mainContent.getByText("Attached context", { exact: true })).toHaveCount(0);
    await expect(mainContent.getByText("Shared context visible from this project.", { exact: true })).toHaveCount(0);
    await expect(mainContent.getByText("Project role", { exact: true })).toHaveCount(0);
    await expect(mainContent.getByText("Working Set", { exact: true })).toHaveCount(0);
    await expect(mainContent.getByText("Reference", { exact: true })).toHaveCount(0);
    await expect(
      mainContent.getByRole("textbox", { name: "Optional project-specific guidance for agents" }),
    ).toHaveValue("Primary codebase for shipping changes.");

    await mainContent.getByRole("button", { name: "Edit Rudder repo" }).click();
    const editForm = mainContent.getByTestId("project-resource-edit-form");
    await expect(editForm).toBeVisible();
    await editForm.getByLabel("Name").fill("Rudder codebase");
    await editForm.getByLabel("Locator").fill("~/projects/rudder-oss");
    await editForm.getByLabel("Description").fill("Canonical monorepo for implementation work.");
    await editForm.getByLabel("Project note").fill("Main project checkout.");
    const updateResourceResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().includes(`/api/orgs/${organization.id}/resources/${repoResource.id}`)
      && response.ok(),
    );
    const updateAttachmentResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().includes(`/api/projects/${project.id}/resources/${repoAttachment.id}`)
      && response.ok(),
    );
    await editForm.getByRole("button", { name: "Save" }).click();
    await Promise.all([updateResourceResponse, updateAttachmentResponse]);
    await expect(mainContent.getByText("Rudder codebase", { exact: true })).toBeVisible();
    await expect(mainContent.getByText("~/projects/rudder-oss", { exact: true })).toBeVisible();
    await expect(
      mainContent.getByRole("textbox", { name: "Optional project-specific guidance for agents" }),
    ).toHaveValue("Main project checkout.");

    const attachResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/api/projects/${project.id}/resources?orgId=${organization.id}`)
      && response.ok(),
    );
    const addResourcesButton = mainContent.getByRole("button", { name: "Add resources" });
    const createExternalResourceAction = page.getByRole("button", { name: /Create external resource/ });
    await expect(async () => {
      await addResourcesButton.click({ force: true });
      await expect(createExternalResourceAction).toBeVisible({ timeout: 1_000 });
    }).toPass();
    await expect(page.getByText("Existing resources", { exact: true })).toBeVisible();
    await createExternalResourceAction.click();
    const createExternalDialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("Create external resource") }).first();
    await expect(createExternalDialog.getByLabel("Project role")).toHaveCount(0);
    await expect(createExternalDialog.getByText("Project note", { exact: true })).toBeVisible();
    await createExternalDialog.getByRole("button", { name: "Cancel" }).click();

    await expect(async () => {
      await addResourcesButton.click({ force: true });
      await expect(page.getByRole("button", { name: /SPEC doc/i })).toBeVisible({ timeout: 1_000 });
    }).toPass();
    await page.getByRole("button", { name: /SPEC doc/i }).click();
    await attachResponse;
    await expect(mainContent.getByText("SPEC doc", { exact: true })).toBeVisible();

    await page.screenshot({
      path: testInfo.outputPath("workspace-shell-project-resources.png"),
      fullPage: true,
    });

    await gotoOrganizationPath(page, organization, "/library");
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/library$`));
    await expect(page.getByTestId("workspace-main-header")).toHaveCount(0);
    await expect(page.getByTestId("workspace-context-header").getByRole("heading", { name: "Library", exact: true })).toBeVisible();
  });

  test("surfaces project resources as virtual entries in the Library tree", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Workspace-Shell-Library-Resources-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const repoResourceRes = await page.request.post(`/api/orgs/${organization.id}/resources`, {
      data: {
        name: "New Zealand repo",
        kind: "directory",
        sourceType: "external",
        locator: "~/projects/new-zealand",
        description: "Local checkout for project implementation.",
      },
    });
    expect(repoResourceRes.ok()).toBe(true);
    const repoResource = await repoResourceRes.json() as { id: string };

    const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: "New Zealand launch",
        description: "Verifies project resources appear in Library.",
      },
    });
    expect(projectRes.ok()).toBe(true);
    const project = await projectRes.json() as { id: string; urlKey: string };

    const attachRepoRes = await page.request.post(`/api/projects/${project.id}/resources?orgId=${organization.id}`, {
      data: {
        resourceId: repoResource.id,
        role: "working_set",
        note: "Primary implementation checkout.",
        sortOrder: 0,
      },
    });
    expect(attachRepoRes.ok()).toBe(true);
    const attachment = await attachRepoRes.json() as { id: string };

    const virtualFileRes = await page.request.get(
      `/api/orgs/${organization.id}/workspace/file?path=projects/${project.urlKey}/resources/${attachment.id}`,
    );
    expect(virtualFileRes.ok()).toBe(false);

    await installDesktopShellWorkspaceIdeStub(page);
    await gotoOrganizationPath(page, organization, `/library?resource=${attachment.id}`);

    await expect(page.getByTestId(`org-workspaces-project-resources-folder-${project.id}`)).toBeVisible();
    await expect(page.getByTestId(`org-workspaces-project-resource-${attachment.id}`)).toBeVisible();
    const resourceDetail = page.getByTestId("org-workspaces-resource-detail");
    await expect(resourceDetail).toBeVisible();
    await expect(resourceDetail.getByText("New Zealand repo", { exact: true })).toBeVisible();
    await expect(resourceDetail.getByText("~/projects/new-zealand", { exact: true }).first()).toBeVisible();
    await expect(resourceDetail.getByText("Primary implementation checkout.", { exact: true })).toBeVisible();
    await expect(resourceDetail.getByText("Role", { exact: true })).toHaveCount(0);
    await expect(resourceDetail.getByText("Reference", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("org-workspaces-resource-launcher").getByRole("button", { name: "Open resource in Cursor" })).toBeVisible();
    await expect(page.getByText("No file open")).toHaveCount(0);
    await expect(page.getByTestId("org-workspaces-editor-launcher")).toHaveCount(0);
    await expect(resourceDetail.getByTestId("org-workspaces-resource-open-path")).toHaveCount(0);

    await resourceDetail.getByTestId("org-workspaces-resource-edit").click();
    const resourceEditForm = resourceDetail.getByTestId("org-workspaces-resource-edit-form");
    await expect(resourceEditForm).toBeVisible();
    await resourceEditForm.getByLabel("Name").fill("New Zealand codebase");
    await resourceEditForm.getByLabel("Locator").fill("~/projects/new-zealand-main");
    await resourceEditForm.getByLabel("Description").fill("Updated local checkout for project implementation.");
    await resourceEditForm.getByLabel("Project note").fill("Primary local checkout.");
    const updateLibraryResourceResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().includes(`/api/orgs/${organization.id}/resources/${repoResource.id}`)
      && response.ok(),
    );
    const updateLibraryAttachmentResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().includes(`/api/projects/${project.id}/resources/${attachment.id}`)
      && response.ok(),
    );
    await resourceEditForm.getByRole("button", { name: "Save" }).click();
    await Promise.all([updateLibraryResourceResponse, updateLibraryAttachmentResponse]);
    await expect(resourceDetail.getByText("New Zealand codebase", { exact: true })).toBeVisible();
    await expect(resourceDetail.getByText("~/projects/new-zealand-main", { exact: true }).first()).toBeVisible();
    await expect(resourceDetail.getByText("Primary local checkout.", { exact: true })).toBeVisible();

    const projectFolderRow = page.locator(`[data-workspace-entry-path="projects/${project.urlKey}"]`);
    await projectFolderRow.hover();
    await page.getByTestId(`org-workspaces-entry-more-projects/${project.urlKey}`).click();
    let treeMenu = page.getByRole("menu");
    await expect(treeMenu.getByRole("menuitem", { name: "Copy absolute path" })).toBeVisible();
    await expect(treeMenu.getByRole("menuitem", { name: "Delete" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    const resourcesFolder = page.getByTestId(`org-workspaces-project-resources-folder-${project.id}`);
    await resourcesFolder.hover();
    await page.getByTestId(`org-workspaces-project-resources-more-${project.id}`).click();
    treeMenu = page.getByRole("menu");
    await expect(treeMenu.getByRole("menuitem", { name: "Add resources" })).toBeVisible();
    await treeMenu.getByRole("menuitem", { name: "Add resources" }).click();
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/projects/${project.urlKey}/resources$`));

    await gotoOrganizationPath(page, organization, `/library?resource=${attachment.id}`);
    await expect(page.getByTestId(`org-workspaces-project-resource-${attachment.id}`)).toBeVisible();

    const resourceLauncher = page.getByTestId("org-workspaces-resource-launcher");
    await resourceLauncher.getByRole("button", { name: "Open resource menu" }).click();
    await page.getByRole("menuitemradio", { name: "Terminal" }).click();
    await expect(resourceLauncher.getByRole("button", { name: "Open resource in Terminal" })).toBeVisible();
    await resourceLauncher.getByRole("button", { name: "Open resource in Terminal" }).click();
    await expect(page.getByText("Opened resource in Terminal")).toBeVisible();

    const workspaceCalls = await page.evaluate(() =>
      (window as typeof window & {
        __rudderWorkspaceOpenCalls?: Array<{ rootPath: string; targetId?: string }>;
      }).__rudderWorkspaceOpenCalls ?? [],
    );
    expect(workspaceCalls).toEqual([
      {
        rootPath: "~/projects/new-zealand-main",
        targetId: "terminal",
      },
    ]);

    const resourceRow = page.getByTestId(`org-workspaces-project-resource-${attachment.id}`);
    await resourceRow.hover();
    await page.getByTestId(`org-workspaces-project-resource-more-${attachment.id}`).click();
    const resourceMenu = page.getByRole("menu");
    await expect(resourceMenu.getByRole("menuitem", { name: "Open resource" })).toBeVisible();
    await expect(resourceMenu.getByRole("menuitem", { name: "Copy locator" })).toBeVisible();
    await resourceMenu.getByRole("menuitem", { name: "Unlink resource" }).click();
    await expect(page.getByText("Resource unlinked")).toBeVisible();
    await expect(page.getByTestId(`org-workspaces-project-resource-${attachment.id}`)).toHaveCount(0);
    await expect.poll(async () => {
      const resourcesRes = await page.request.get(`/api/projects/${project.id}/resources?orgId=${organization.id}`);
      const resources = await resourcesRes.json() as Array<unknown>;
      return resources.length;
    }).toBe(0);
  });

  test("surfaces Library in the shared three-column shell", async ({ page }, testInfo) => {
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
    await expect(sidebar.getByRole("link", { name: "Library" })).toHaveCount(0);
    await expect(sidebar.getByRole("link", { name: "Heartbeats" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Workspaces" })).toHaveCount(0);
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

  test("shows Library Markdown sections only for files with headings", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Workspace-Shell-Outline-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    const workspaceRoot = resolveOrganizationWorkspaceRoot(organization.id);
    const longIntro = Array.from(
      { length: 36 },
      (_, index) => `Intro detail ${index + 1}: keep this plan scannable from the outline.`,
    ).join("\n\n");

    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "heading-doc.md"),
      `# Launch Plan\n\n${longIntro}\n\n## Tasks\n\nKeep the rollout checklist nearby.\n`,
      "utf8",
    );
    await fs.writeFile(path.join(workspaceRoot, "plain-doc.md"), "Keep this note intentionally flat.\n", "utf8");

    await page.setViewportSize({ width: 1491, height: 926 });
    await gotoOrganizationPath(page, organization, "/library?path=heading-doc.md");

    const markdownEditor = page.getByTestId("org-workspaces-markdown-editor").locator(".ProseMirror");
    await expect(markdownEditor.locator("h1", { hasText: "Launch Plan" })).toBeVisible();
    const documentOutline = page.getByTestId("org-workspaces-document-outline");
    await expect(documentOutline).toBeVisible();
    await expect(documentOutline.getByRole("button", { name: "Launch Plan", exact: true })).toBeVisible();
    const tasksOutlineButton = documentOutline.getByRole("button", { name: "Tasks", exact: true });
    await expect(tasksOutlineButton).toBeVisible();

    await page.screenshot({
      path: testInfo.outputPath("workspace-shell-library-outline.png"),
      fullPage: true,
    });

    const markdownEditorScroll = page.getByTestId("org-workspaces-markdown-editor");
    const beforeOutlineClickScrollTop = await markdownEditorScroll.evaluate((element) => element.scrollTop);
    await tasksOutlineButton.click();
    await expect.poll(async () => markdownEditorScroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(
      beforeOutlineClickScrollTop,
    );
    await expect(markdownEditor.locator("h2", { hasText: "Tasks" })).toBeInViewport();

    await gotoOrganizationPath(page, organization, "/library?path=plain-doc.md");
    await expect(markdownEditor).toContainText("Keep this note intentionally flat.");
    await expect(page.getByTestId("org-workspaces-document-outline")).toHaveCount(0);
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

  test("shows the Library file browser inside the organization shell", async ({ page }, testInfo) => {
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
    await fs.mkdir(path.join(resolveOrganizationWorkspaceRoot(organization.id), "docs"), { recursive: true });
    await fs.mkdir(path.join(resolveOrganizationWorkspaceRoot(organization.id), "artifacts"), { recursive: true });
    await fs.writeFile(
      path.join(resolveOrganizationWorkspaceRoot(organization.id), "docs", "product.md"),
      "# Product\n",
      "utf8",
    );
    await fs.writeFile(path.join(resolveOrganizationWorkspaceRoot(organization.id), "notes.md"), "# Shared Notes\n", "utf8");
    await fs.writeFile(path.join(resolveOrganizationWorkspaceRoot(organization.id), "draft.md"), "# Draft\n", "utf8");
    await fs.writeFile(
      path.join(resolveOrganizationWorkspaceRoot(organization.id), "frontmatter.md"),
      "---\ntitle: Frontmatter doc\n---\n# Frontmatter Heading\n\nEditable body.\n",
      "utf8",
    );
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
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/library$`));

    const mainContent = page.locator("#main-content");
    await expect(page.getByTestId("workspace-context-card")).toBeVisible();
    await expect(page.getByTestId("workspace-sidebar")).toBeVisible();
    await expect(page.getByTestId("workspace-context-card")).toHaveClass(/workspace-context-card/);
    await expect(page.getByTestId("workspace-main-card")).toHaveClass(/workspace-main-card/);
    await expect(page.getByTestId("workspace-main-header")).toHaveCount(0);
    await expect(page.getByTestId("workspace-context-header").getByRole("heading", { name: "Library", exact: true })).toBeVisible();
    await expect(page.getByText("File tree", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("org-workspaces-new-file-button")).toBeVisible();
    await expect(page.getByTestId("org-workspaces-new-folder-button")).toBeVisible();
    await expect(mainContent.getByRole("link", { name: "Browse workspaces" })).toHaveCount(0);
    await expect(page.getByTestId("org-workspaces-files-card")).toBeVisible();
    await expect(page.getByTestId("org-workspaces-editor-card")).toBeVisible();
    await expect(page.getByTestId("org-workspaces-editor-tabs")).toBeVisible();
    await expect(page.getByTestId("org-library-context-panel")).toHaveCount(0);
    await expect(page.getByTestId("org-library-resources-panel")).toHaveCount(0);
    await page.setViewportSize({ width: 700, height: 900 });
    await expect(page.getByText("File tree", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("org-workspaces-inline-new-file-button")).toBeVisible();
    await expect(page.getByTestId("org-workspaces-inline-new-folder-button")).toBeVisible();
    await page.setViewportSize({ width: 1491, height: 926 });

    await gotoOrganizationPath(page, organization, "/workspaces");
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/library$`));

    const filesCard = page.getByTestId("org-workspaces-files-card");
    const editorCard = page.getByTestId("org-workspaces-editor-card");
    await expect(page.getByTestId("workspace-context-card")).toBeVisible();
    await expect(page.getByTestId("workspace-sidebar")).toBeVisible();
    await expect(page.getByTestId("workspace-context-card")).toHaveClass(/workspace-context-card/);
    await expect(page.getByTestId("workspace-main-card")).toHaveClass(/workspace-main-card/);
    await expect(page.getByTestId("workspace-main-header")).toHaveCount(0);
    await expect(page.getByTestId("workspace-context-header").getByRole("heading", { name: "Library", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh" })).toHaveCount(0);
    await expect(page.getByTestId("org-workspaces-files-scroll")).toBeVisible();
    await expect(filesCard.getByRole("button", { name: "notes.md", exact: true })).toBeVisible();
    await page.getByTestId("org-workspaces-new-file-button").click();
    const rootCreateFileDialog = page.getByRole("dialog", { name: "New file" });
    await rootCreateFileDialog.getByLabel("Name").fill("root-created.md");
    await rootCreateFileDialog.getByRole("button", { name: "Create file" }).click();
    await expect(page.getByText("File created")).toBeVisible();
    await expect(page.getByTestId("org-workspaces-editor-tabs").getByRole("tab", { name: "root-created.md" })).toBeVisible();
    const markdownEditor = page.getByTestId("org-workspaces-markdown-editor").locator(".ProseMirror");
    await expect(markdownEditor).toBeVisible();
    await expect(page.getByTestId("org-workspaces-path-breadcrumb").getByRole("button", { name: "root-created.md" })).toBeVisible();

    await filesCard.getByRole("button", { name: "docs", exact: true }).click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Copy file path" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "New file" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "New folder" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByTestId("org-workspaces-entry-more-draft.md").click();
    await expect(page.locator('[data-slot="dropdown-menu-content"]')).toHaveClass(/will-change/);
    await expect(page.getByRole("menuitem", { name: "Copy file path" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "New file" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "New folder" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    const renameDialog = page.getByRole("dialog", { name: "Rename entry" });
    await renameDialog.getByLabel("Name").fill("renamed-draft.md");
    await renameDialog.getByRole("button", { name: "Rename" }).click();
    await expect(page.getByText("Workspace entry renamed")).toBeVisible();
    await expect(filesCard.getByRole("button", { name: "renamed-draft.md", exact: true })).toBeVisible();
    await expect(filesCard.getByRole("button", { name: "draft.md", exact: true })).toHaveCount(0);
    await page.getByTestId("org-workspaces-entry-more-renamed-draft.md").click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    const deleteDialog = page.getByRole("dialog", { name: "Delete entry" });
    await deleteDialog.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("Workspace entry deleted")).toBeVisible();
    await expect(filesCard.getByRole("button", { name: "renamed-draft.md", exact: true })).toHaveCount(0);

    await page.getByTestId("org-workspaces-entry-more-artifacts").click();
    await expect(page.getByRole("menuitem", { name: "Copy file path" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "New file" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "New folder" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
    await page.getByRole("menuitem", { name: "New file" }).click();
    const createFileDialog = page.getByRole("dialog", { name: "New file" });
    await createFileDialog.getByLabel("Name").fill("menu-created.md");
    await createFileDialog.getByRole("button", { name: "Create file" }).click();
    await expect(page.getByText("File created")).toBeVisible();
    await expect(page.getByTestId("org-workspaces-editor-tabs").getByRole("tab", { name: "menu-created.md" })).toBeVisible();
    await expect(page.getByTestId("org-workspaces-markdown-editor").locator(".ProseMirror")).toBeVisible();
    await page.getByTestId("org-workspaces-entry-more-artifacts").click();
    await page.getByRole("menuitem", { name: "New folder" }).click();
    const createFolderDialog = page.getByRole("dialog", { name: "New folder" });
    await createFolderDialog.getByLabel("Name").fill("menu-folder");
    await createFolderDialog.getByRole("button", { name: "Create folder" }).click();
    await expect(page.getByText("Folder created")).toBeVisible();
    await expect(filesCard.getByRole("button", { name: "menu-folder", exact: true })).toBeVisible();

    await page.getByTestId("org-workspaces-entry-more-agents").click();
    await expect(page.getByRole("menuitem", { name: "Copy file path" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "New file" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "New folder" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Rename" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Delete" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await filesCard.getByRole("button", { name: "agents", exact: true }).click();
    const jadeWorkspaceButton = filesCard.getByRole("button", { name: "Jade", exact: true });
    await expect(jadeWorkspaceButton).toBeVisible();
    await page.getByTestId(`org-workspaces-entry-more-agents/${originalWorkspaceKey}`).click();
    await expect(page.getByRole("menuitem", { name: "Copy file path" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "New file" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "New folder" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Rename" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Delete" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(filesCard.getByRole("button", { name: originalWorkspaceKey, exact: true })).toHaveCount(0);
    await expect(filesCard.getByText(originalWorkspaceKey, { exact: true })).toHaveCount(0);
    await expect(jadeWorkspaceButton.getByTestId("org-workspaces-agent-icon")).toBeVisible();
    const agentBadge = jadeWorkspaceButton.getByTestId("org-workspaces-agent-badge");
    await expect(agentBadge).toHaveText("Agent");
    await expect(agentBadge.locator("svg,img")).toHaveCount(0);
    await jadeWorkspaceButton.click();
    await expect(filesCard.getByRole("button", { name: "instructions", exact: true })).toBeVisible();
    await page.getByTestId(`org-workspaces-entry-more-agents/${originalWorkspaceKey}/instructions`).click();
    await expect(page.getByRole("menuitem", { name: "Copy file path" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "New file" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "New folder" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
    await page.keyboard.press("Escape");
    await filesCard.getByRole("button", { name: "instructions", exact: true }).click();
    await filesCard.getByRole("button", { name: "HEARTBEAT.md", exact: true }).click();
    const agentPathBreadcrumb = page.getByTestId("org-workspaces-path-breadcrumb");
    await expect(agentPathBreadcrumb.getByRole("button", { name: "Jade", exact: true })).toBeVisible();
    await expect(agentPathBreadcrumb.getByText(originalWorkspaceKey, { exact: true })).toHaveCount(0);
    await expect(agentPathBreadcrumb.getByTestId("org-workspaces-path-breadcrumb-agent-icon")).toBeVisible();
    await expect(filesCard.getByRole("button", { name: ".DS_Store", exact: true })).toHaveCount(0);
    await expect(filesCard.getByRole("button", { name: ".cache", exact: true })).toHaveCount(0);
    await expect(filesCard.getByRole("button", { name: ".npm", exact: true })).toHaveCount(0);
    await expect(filesCard.getByRole("button", { name: ".nvm", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
    await expect(page.getByTestId("org-workspaces-open-in-ide-button")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Activate for agents" })).toHaveCount(0);

    await filesCard.getByRole("button", { name: "notes.md", exact: true }).click();
    await expect(markdownEditor).toContainText("Shared Notes");

    await page.getByTestId("org-workspaces-editor-tab-notes.md").click({ button: "right" });
    const tabMenu = page.getByTestId("org-workspaces-tab-context-menu");
    await expect(tabMenu).toBeVisible();
    await expect(tabMenu).toHaveClass(/motion-chat-composer-menu-pop/);
    await expect(tabMenu.getByRole("menuitem", { name: "Copy file path" })).toBeVisible();
    await expect(tabMenu.getByRole("menuitem", { name: /Open in IDE|Open in Cursor/ })).toBeVisible();
    await expect(tabMenu.getByRole("menuitem", { name: "Close", exact: true })).toBeVisible();
    await expect(tabMenu.getByRole("menuitem", { name: "Close others" })).toBeVisible();
    await expect(tabMenu.getByRole("menuitem", { name: "Close tabs to the right" })).toBeVisible();
    await expect(tabMenu.getByRole("menuitem", { name: "Close all" })).toBeVisible();
    await page.keyboard.press("Escape");
    await filesCard.getByRole("button", { name: "notes.md", exact: true }).click();
    await expect(markdownEditor).toContainText("Shared Notes");
    await expect(markdownEditor.locator("h1", { hasText: "Shared Notes" })).toBeVisible();

    await markdownEditor.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.type("# Shared Notes\n\n- Keep project setup docs nearby.\n");
    await expect(markdownEditor.locator("h1", { hasText: "Shared Notes" })).toBeVisible();
    await expect.poll(async () => fs.readFile(path.join(resolveOrganizationWorkspaceRoot(organization.id), "notes.md"), "utf8"))
      .toContain("Keep project setup docs nearby.");
    await expect(page.getByTestId("org-workspaces-autosave-status")).toHaveCount(0);

    await filesCard.getByRole("button", { name: "frontmatter.md", exact: true }).click();
    const frontmatterEditor = page.getByTestId("org-workspaces-frontmatter-editor");
    const frontmatterMarkdownEditor = page.getByTestId("org-workspaces-markdown-editor").locator(".ProseMirror");
    await expect(frontmatterEditor).toBeVisible();
    await expect(frontmatterMarkdownEditor.locator("h1", { hasText: "Frontmatter Heading" })).toBeVisible();

    await page.getByTestId("org-workspaces-new-folder-button").click();
    const rootCreateFolderDialog = page.getByRole("dialog", { name: "New folder" });
    await rootCreateFolderDialog.getByLabel("Name").fill("root-folder");
    await rootCreateFolderDialog.getByRole("button", { name: "Create folder" }).click();
    await expect(page.getByText("Folder created")).toBeVisible();
    await expect(filesCard.getByRole("button", { name: "root-folder", exact: true })).toBeVisible();

    const [mainCardBox, filesCardBox, editorCardBox, editorTextareaBox] = await Promise.all([
      page.getByTestId("workspace-main-card").boundingBox(),
      filesCard.boundingBox(),
      editorCard.boundingBox(),
      page.getByTestId("org-workspaces-markdown-editor").boundingBox(),
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

  test("shows an IDE open action in workspaces when the desktop shell exposes a local editor", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Workspace-Shell-Desktop-IDE-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    await fs.writeFile(path.join(resolveOrganizationWorkspaceRoot(organization.id), "notes.md"), "# Shared Notes\n", "utf8");
    await installDesktopShellWorkspaceIdeStub(page);
    await gotoOrganizationPath(page, organization, "/workspaces");

    await page.getByRole("button", { name: "notes.md", exact: true }).click();
    const openInIdeButton = page.getByTestId("org-workspaces-open-in-ide-button");
    await expect(openInIdeButton).toBeVisible();
    await expect(openInIdeButton).toHaveAttribute("aria-label", "Open in Cursor");

    await openInIdeButton.click();
    await expect(page.getByText("Opened in IDE")).toBeVisible();

    const ideCalls = await page.evaluate(() =>
      (window as typeof window & {
        __rudderWorkspaceIdeCalls?: Array<{ rootPath: string; filePath: string; ideId?: string }>;
      }).__rudderWorkspaceIdeCalls ?? [],
    );
    expect(ideCalls).toEqual([
      {
        rootPath: resolveOrganizationWorkspaceRoot(organization.id),
        filePath: "notes.md",
        ideId: "cursor",
      },
    ]);
  });

  test("shows the desktop workspace launcher for IDE, terminal, and folder targets", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Workspace-Shell-Desktop-Launcher-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    await fs.writeFile(path.join(resolveOrganizationWorkspaceRoot(organization.id), "notes.md"), "# Shared Notes\n", "utf8");
    await installDesktopShellWorkspaceIdeStub(page);
    await gotoOrganizationPath(page, organization, "/workspaces");

    const launcher = page.getByTestId("org-workspaces-editor-launcher");
    await expect(launcher.getByRole("button", { name: "Open workspace in Cursor" })).toBeVisible();

    await launcher.getByRole("button", { name: "Open workspace menu" }).click();
    await expect(page.getByRole("menuitemradio", { name: "Cursor" })).toBeVisible();
    await expect(page.getByRole("menuitemradio", { name: "Terminal" })).toBeVisible();
    await expect(page.getByRole("menuitemradio", { name: "Finder" })).toBeVisible();

    await page.getByRole("menuitemradio", { name: "Terminal" }).click();
    await expect(launcher.getByRole("button", { name: "Open workspace in Terminal" })).toBeVisible();
    await launcher.getByRole("button", { name: "Open workspace in Terminal" }).click();
    await expect(page.getByText("Opened workspace in Terminal")).toBeVisible();

    await launcher.getByRole("button", { name: "Open workspace menu" }).click();
    await page.getByRole("menuitemradio", { name: "Finder" }).click();
    await expect(launcher.getByRole("button", { name: "Open workspace in Finder" })).toBeVisible();
    await launcher.getByRole("button", { name: "Open workspace in Finder" }).click();
    await expect(page.getByText("Opened workspace in Finder")).toBeVisible();

    const workspaceCalls = await page.evaluate(() =>
      (window as typeof window & {
        __rudderWorkspaceOpenCalls?: Array<{ rootPath: string; targetId?: string }>;
      }).__rudderWorkspaceOpenCalls ?? [],
    );
    expect(workspaceCalls).toEqual([
      {
        rootPath: resolveOrganizationWorkspaceRoot(organization.id),
        targetId: "terminal",
      },
      {
        rootPath: resolveOrganizationWorkspaceRoot(organization.id),
        targetId: "finder",
      },
    ]);
  });

  test("does not show the IDE action for workspace paths that fail file loading", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Workspace-Shell-Desktop-IDE-Guard-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    await fs.writeFile(path.join(resolveOrganizationWorkspaceRoot(organization.id), "notes.md"), "# Shared Notes\n", "utf8");
    await installDesktopShellWorkspaceIdeStub(page);
    await gotoOrganizationPath(page, organization, "/workspaces?path=../outside.md");

    await expect(page.getByText("../outside.md")).toBeVisible();
    await expect(page.getByText("Loading file…")).toBeVisible();
    await expect(page.getByTestId("org-workspaces-open-in-ide-button")).toHaveCount(0);
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
