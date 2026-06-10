import { expect, test } from "@playwright/test";
import { E2E_BASE_URL } from "./support/e2e-env";

test.describe("Issue detail project switching", () => {
  test("clears execution workspace state when switching project from the properties panel", async ({ page }) => {
    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `Issue-Project-Switch-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const oldProjectRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Old issue project",
        status: "planned",
      },
    });
    expect(oldProjectRes.ok()).toBe(true);
    const oldProject = await oldProjectRes.json() as { id: string; name: string };

    const newProjectRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/projects`, {
      data: {
        name: "New issue project",
        status: "planned",
      },
    });
    expect(newProjectRes.ok()).toBe(true);
    const newProject = await newProjectRes.json() as { id: string; name: string };

    const issueRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/issues`, {
      data: {
        projectId: oldProject.id,
        title: "Switch project from detail",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json() as { id: string; identifier: string | null; projectId: string | null };
    expect(issue.projectId).toBe(oldProject.id);

    await page.goto(E2E_BASE_URL);
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
    await expect(page.getByRole("heading", { name: "Switch project from detail" })).toBeVisible();

    const patchResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && /\/api\/issues\/[^/]+$/.test(new URL(response.url()).pathname)
      && response.ok(),
    );
    await page.getByRole("button", { name: oldProject.name }).last().click();
    await page.getByRole("button", { name: newProject.name }).last().click();
    const response = await patchResponse;
    const requestBody = response.request().postDataJSON() as {
      projectId?: string | null;
      executionWorkspaceId?: string | null;
    };
    expect(requestBody.projectId).toBe(newProject.id);
    expect(requestBody.executionWorkspaceId).toBeNull();

    await expect(page.getByRole("button", { name: newProject.name }).last()).toBeVisible();
    const updatedIssueRes = await page.request.get(`${E2E_BASE_URL}/api/issues/${issue.id}`);
    expect(updatedIssueRes.ok()).toBe(true);
    const updatedIssue = await updatedIssueRes.json() as { projectId: string | null; executionWorkspaceId: string | null };
    expect(updatedIssue.projectId).toBe(newProject.id);
    expect(updatedIssue.executionWorkspaceId).toBeNull();
  });
});
