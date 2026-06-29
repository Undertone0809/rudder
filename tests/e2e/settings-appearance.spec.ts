import { expect, test } from "@playwright/test";

test.describe("Settings appearance", () => {
  test("moves color mode from General into Appearance", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Appearance Settings ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();

    const modal = page.getByTestId("settings-modal-shell");
    const sidebar = modal.getByTestId("workspace-sidebar");

    await expect(sidebar.locator('a[href$="/instance/settings/appearance"]')).toBeVisible();

    await sidebar.locator('a[href$="/instance/settings/general"]').click();
    await expect(page).toHaveURL(/\/instance\/settings\/general$/);
    await expect(modal.getByRole("heading", { name: "General" })).toBeVisible();
    await expect(modal.getByText("Color mode")).toHaveCount(0);

    await sidebar.locator('a[href$="/instance/settings/appearance"]').click();
    await expect(page).toHaveURL(/\/instance\/settings\/appearance$/);
    await expect(modal.getByRole("heading", { name: "Appearance" })).toBeVisible();
    await expect(modal.getByText("Color mode")).toBeVisible();
    await expect(modal.getByRole("button", { name: "Light" })).toBeVisible();
    await expect(modal.getByRole("button", { name: "Auto" })).toBeVisible();
    await expect(modal.getByRole("button", { name: "Dark" })).toBeVisible();
  });
});
