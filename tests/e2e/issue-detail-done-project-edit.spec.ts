import { expect, test } from "@playwright/test";

test.describe("Done issue project editing", () => {
  test("allows an operator to change the project on a done issue", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Done-Issue-Project-Edit-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const sourceProjectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: { name: "Done source project" },
    });
    expect(sourceProjectRes.ok()).toBe(true);
    const sourceProject = await sourceProjectRes.json() as { id: string; name: string };

    const targetProjectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: { name: "Done target project" },
    });
    expect(targetProjectRes.ok()).toBe(true);
    const targetProject = await targetProjectRes.json() as { id: string; name: string };

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Done issue should keep project editable",
        status: "done",
        priority: "medium",
        projectId: sourceProject.id,
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json() as {
      id: string;
      identifier?: string | null;
      projectId: string | null;
      status: string;
    };
    expect(issue.status).toBe("done");
    expect(issue.projectId).toBe(sourceProject.id);

    await page.addInitScript((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`);

    const propertiesPanel = page.getByRole("region", { name: "Issue properties" });
    await expect(propertiesPanel).toBeVisible({ timeout: 15_000 });
    await expect(propertiesPanel.getByText("Done", { exact: true })).toBeVisible();
    await expect(propertiesPanel.getByRole("button", { name: `Change project: ${sourceProject.name}` })).toBeVisible();

    await propertiesPanel.getByRole("button", { name: `Change project: ${sourceProject.name}` }).click();
    await expect(page.getByPlaceholder("Search projects...")).toBeVisible();
    await page.getByRole("button", { name: targetProject.name }).click();

    await expect(propertiesPanel.getByRole("button", { name: `Change project: ${targetProject.name}` })).toBeVisible({
      timeout: 10_000,
    });
    await expect(propertiesPanel.getByText(sourceProject.name, { exact: true })).toHaveCount(0);

    const updatedIssueRes = await page.request.get(`/api/issues/${issue.id}`);
    expect(updatedIssueRes.ok()).toBe(true);
    const updatedIssue = await updatedIssueRes.json() as {
      projectId: string | null;
      status: string;
      completedAt: string | null;
    };
    expect(updatedIssue.status).toBe("done");
    expect(updatedIssue.completedAt).toBeTruthy();
    expect(updatedIssue.projectId).toBe(targetProject.id);
  });
});
