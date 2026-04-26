import { expect, test, type Page } from "@playwright/test";

import { E2E_BASE_URL } from "./support/e2e-env";

async function selectOrganization(page: Page, orgId: string) {
  await page.goto(E2E_BASE_URL);
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

test.describe("Automations index layout", () => {
  test("places the create action in the workspace header", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `Automations-Index-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = (await orgRes.json()) as { id: string; issuePrefix: string };

    await selectOrganization(page, organization.id);
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/automations`);

    const headerActions = page.getByTestId("workspace-main-header-actions");
    const createButton = headerActions.getByRole("button", { name: "Create automation" });
    const emptyState = page.getByText("No automations yet. Use Create automation to define the first recurring workflow.");

    await expect(headerActions).toBeVisible();
    await expect(createButton).toBeVisible();
    await expect(emptyState).toBeVisible();

    const headerActionsBox = await headerActions.boundingBox();
    const createButtonBox = await createButton.boundingBox();
    const emptyStateBox = await emptyState.boundingBox();

    expect(headerActionsBox).not.toBeNull();
    expect(createButtonBox).not.toBeNull();
    expect(emptyStateBox).not.toBeNull();
    expect(createButtonBox!.x).toBeGreaterThanOrEqual(headerActionsBox!.x - 2);
    expect(createButtonBox!.y).toBeGreaterThanOrEqual(headerActionsBox!.y - 2);
    expect(createButtonBox!.y + createButtonBox!.height).toBeLessThanOrEqual(headerActionsBox!.y + headerActionsBox!.height + 2);
    expect(createButtonBox!.y + createButtonBox!.height).toBeLessThan(emptyStateBox!.y);

    await createButton.click();
    await expect(page.getByPlaceholder("Automation title")).toBeVisible();

    await page.screenshot({
      path: testInfo.outputPath("automations-index-layout.png"),
      fullPage: true,
    });
  });
});
