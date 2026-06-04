import { expect, test } from "@playwright/test";

const editCases = [
  {
    status: "done",
    label: "Done",
    titlePrefix: "Done",
    sourceProjectName: "Done source project",
    targetProjectName: "Done target project",
    expectedCompleted: true,
  },
  {
    status: "blocked",
    label: "Blocked",
    titlePrefix: "Blocked",
    sourceProjectName: "Blocked source project",
    targetProjectName: "Blocked target project",
    expectedCompleted: false,
  },
] as const;

test.describe("Terminal issue project editing", () => {
  for (const editCase of editCases) {
    test(`allows an operator to change the project on a ${editCase.status} issue`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });

      const orgRes = await page.request.post("/api/orgs", {
        data: { name: `${editCase.titlePrefix}-Issue-Project-Edit-${Date.now()}` },
      });
      expect(orgRes.ok()).toBe(true);
      const organization = await orgRes.json() as { id: string; issuePrefix: string };

      const sourceProjectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
        data: { name: editCase.sourceProjectName },
      });
      expect(sourceProjectRes.ok()).toBe(true);
      const sourceProject = await sourceProjectRes.json() as { id: string; name: string };

      const targetProjectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
        data: { name: editCase.targetProjectName },
      });
      expect(targetProjectRes.ok()).toBe(true);
      const targetProject = await targetProjectRes.json() as { id: string; name: string };

      const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
        data: {
          title: `${editCase.titlePrefix} issue should keep project editable`,
          status: editCase.status,
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
      expect(issue.status).toBe(editCase.status);
      expect(issue.projectId).toBe(sourceProject.id);

      await page.addInitScript((orgId) => {
        window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
      }, organization.id);

      await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`);

      const propertiesPanel = page.getByRole("region", { name: "Issue properties" });
      await expect(propertiesPanel).toBeVisible({ timeout: 15_000 });
      await expect(propertiesPanel.getByText(editCase.label, { exact: true })).toBeVisible();
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
      expect(updatedIssue.status).toBe(editCase.status);
      if (editCase.expectedCompleted) {
        expect(updatedIssue.completedAt).toBeTruthy();
      } else {
        expect(updatedIssue.completedAt).toBeNull();
      }
      expect(updatedIssue.projectId).toBe(targetProject.id);
    });
  }
});
