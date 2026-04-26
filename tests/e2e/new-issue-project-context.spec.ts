import { expect, test } from "@playwright/test";
import { E2E_BASE_URL } from "./support/e2e-env";

test.describe("New issue project context", () => {
  test("prefills the selected project when opening the dialog from a project-filtered issues view", async ({ page }) => {
    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `New-Issue-Project-Context-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const projectRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Launch Context Project",
        status: "planned",
      },
    });
    expect(projectRes.ok()).toBe(true);
    const project = await projectRes.json() as { id: string; name: string };

    await page.goto(E2E_BASE_URL);
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues?projectId=${project.id}`);

    await page.getByTestId("workspace-main-header").getByRole("button", { name: "Create Issue" }).click();

    const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: project.name })).toBeVisible();
  });

  test("prefills project and lane status when creating from a project-scoped board column", async ({ page }) => {
    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `New-Issue-Board-Context-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const projectRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Board Context Project",
        status: "planned",
      },
    });
    expect(projectRes.ok()).toBe(true);
    const project = await projectRes.json() as { id: string; name: string };

    await page.goto(E2E_BASE_URL);
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues?projectId=${project.id}`);
    await page.getByTitle("Board view").click();
    await page.evaluate(() => {
      window.localStorage.setItem("rudder:issue-autosave", JSON.stringify({
        title: "Saved draft",
        description: "",
        status: "blocked",
        priority: "low",
        labelIds: [],
        assigneeValue: "",
        projectId: "",
        projectWorkspaceId: "",
        assigneeModelOverride: "",
        assigneeThinkingEffort: "",
        assigneeChrome: false,
      }));
    });
    await page.getByTestId("kanban-column-add-todo").click();

    const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: project.name })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /todo/i })).toBeVisible();
  });

  test("shows a saved issue draft in the issues sidebar and reopens it", async ({ page }) => {
    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `New-Issue-Draft-Recovery-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    await page.goto(E2E_BASE_URL);
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
      window.localStorage.setItem("rudder:issue-drafts", JSON.stringify([{
        id: "draft-recovery-e2e",
        orgId,
        title: "Recovered draft issue",
        description: "This draft should be findable from the issues sidebar.",
        status: "backlog",
        priority: "high",
        labelIds: [],
        assigneeValue: "",
        projectId: "",
        projectWorkspaceId: "",
        assigneeModelOverride: "",
        assigneeThinkingEffort: "",
        assigneeChrome: false,
        executionWorkspaceMode: "shared_workspace",
        selectedExecutionWorkspaceId: "",
        createdAt: "2026-04-26T10:00:00.000Z",
        updatedAt: "2026-04-26T10:00:00.000Z",
      }]));
    }, organization.id);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues`);

    await expect(page.getByTestId("issue-draft-sidebar-entry")).toContainText("Recovered draft issue");
    await page.getByTestId("issue-draft-sidebar-entry").click();

    const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByPlaceholder("Issue title")).toHaveValue("Recovered draft issue");
  });
});
