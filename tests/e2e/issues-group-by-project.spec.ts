import { expect, test, type Page } from "@playwright/test";

async function selectOrganization(page: Page, orgId: string) {
  await page.goto("/");
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

test.describe("Issues grouped by project", () => {
  test("groups cross-project issues under project headings from a shareable URL", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Issues-Group-By-Project-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const launchProjectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: "public-beta-launch",
        status: "in_progress",
      },
    });
    expect(launchProjectRes.ok()).toBe(true);
    const launchProject = await launchProjectRes.json() as { id: string; name: string };

    const enterpriseProjectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: "enterprise-readiness",
        status: "planned",
      },
    });
    expect(enterpriseProjectRes.ok()).toBe(true);
    const enterpriseProject = await enterpriseProjectRes.json() as { id: string; name: string };

    const launchIssueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        projectId: launchProject.id,
        title: "Refresh launch comparison page",
        description: "Cross-project grouping should keep launch work legible.",
        status: "in_progress",
        priority: "high",
      },
    });
    expect(launchIssueRes.ok()).toBe(true);

    const enterpriseIssueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        projectId: enterpriseProject.id,
        title: "Add audit export for approval history",
        description: "Cross-project grouping should keep enterprise work distinct.",
        status: "todo",
        priority: "high",
      },
    });
    expect(enterpriseIssueRes.ok()).toBe(true);

    await selectOrganization(page, organization.id);
    await page.goto(`/${organization.issuePrefix}/issues?groupBy=project`);

    await expect(page.getByText("Refresh launch comparison page", { exact: true })).toBeVisible();

    await expect(page.getByText("PUBLIC-BETA-LAUNCH", { exact: true })).toBeVisible();
    await expect(page.getByText("ENTERPRISE-READINESS", { exact: true })).toBeVisible();
    await expect(page.getByText("Refresh launch comparison page", { exact: true })).toBeVisible();
    await expect(page.getByText("Add audit export for approval history", { exact: true })).toBeVisible();
  });
});
