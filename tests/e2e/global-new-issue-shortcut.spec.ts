import { expect, test } from "@playwright/test";

test.describe("Global new issue shortcut", () => {
  test("opens the new issue dialog with Command+N", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `New Issue Shortcut ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.keyboard.press("Meta+N");

    const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByPlaceholder("Issue title")).toBeFocused();
  });

  test("persists disabling the single-key C shortcut while keeping Command+N", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Shortcut Settings ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();
    const modal = page.getByTestId("settings-modal-shell");
    await modal.locator('a[href$="/instance/settings/shortcuts"]').click();
    await expect(page).toHaveURL(/\/instance\/settings\/shortcuts$/);

    await modal.getByRole("button", { name: "Disable C" }).click();
    const saveResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().includes("/api/instance/settings/shortcuts")
      && response.ok(),
    );
    await modal.getByRole("button", { name: "Save shortcuts" }).click();
    await saveResponse;

    await page.reload();
    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.keyboard.press("c");
    await expect(page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") })).toHaveCount(0);

    await page.keyboard.press("Meta+N");
    const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await expect(dialog).toBeVisible();
  });
});
