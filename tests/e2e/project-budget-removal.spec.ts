import { expect, test } from "@playwright/test";

test.describe("Project budget removal", () => {
  test("removes project budget controls and rejects new project budget policies", async ({ page }) => {
    test.setTimeout(180_000);

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Project Budget Removal ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as {
      id: string;
      issuePrefix: string;
      urlKey: string | null;
    };
    const organizationRef = organization.urlKey ?? organization.issuePrefix;

    const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: "No Project Budget",
      },
    });
    expect(projectRes.ok()).toBe(true);
    const project = await projectRes.json() as {
      id: string;
      urlKey: string | null;
    };
    const projectRef = project.urlKey ?? project.id;

    const policyRes = await page.request.post(`/api/orgs/${organization.id}/budgets/policies`, {
      data: {
        scopeType: "project",
        scopeId: project.id,
        amount: 20_000,
        windowKind: "lifetime",
      },
    });
    expect(policyRes.status()).toBe(400);

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organizationRef}/projects/${projectRef}/configuration`, {
      waitUntil: "commit",
    });

    const mainContent = page.locator("#main-content");
    await expect(mainContent.getByRole("heading", { name: "No Project Budget" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(mainContent.getByRole("tab", { name: "Configuration" })).toBeVisible();
    await expect(mainContent.getByRole("tab", { name: "Context" })).toBeVisible();
    await expect(mainContent.getByRole("tab", { name: "Issues" })).toBeVisible();
    await expect(mainContent.getByRole("tab", { name: "Budget" })).toHaveCount(0);

    await page.goto(`/${organizationRef}/projects/${projectRef}/budget`, {
      waitUntil: "commit",
    });
    await expect(page).toHaveURL(
      new RegExp(`/${organizationRef}/projects/${projectRef}/configuration$`),
      { timeout: 60_000 },
    );
    await expect(mainContent.getByRole("tab", { name: "Budget" })).toHaveCount(0);
  });
});
