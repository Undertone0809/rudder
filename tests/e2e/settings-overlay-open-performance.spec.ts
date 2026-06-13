import { expect, test } from "@playwright/test";

test.describe("Settings overlay open performance", () => {
  test("opens the modal shell before settings data and the large org list finish loading", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      window.localStorage.setItem("rudder.lastInstanceSettingsPath", "/instance/settings/general");
      window.localStorage.setItem("rudder.productTour.completed.v1", "true");
      window.localStorage.removeItem("rudder.productTour.pendingAfterSetup.v1");
    });

    const createdOrganizations = await Promise.all(
      Array.from({ length: 72 }, async (_, index) => {
        const orgRes = await page.request.post("/api/orgs", {
          data: { name: `Settings Open ${Date.now()} ${index.toString().padStart(2, "0")}` },
        });
        expect(orgRes.ok()).toBe(true);
        return await orgRes.json() as { id: string; issuePrefix: string; name: string };
      }),
    );
    const organization = createdOrganizations[0];
    await page.addInitScript((organizationIds) => {
      window.localStorage.setItem("rudder.companyOrder", JSON.stringify(organizationIds));
    }, createdOrganizations.map((created) => created.id));

    let releaseGeneralSettingsResponse!: () => void;
    let generalSettingsResponseFulfilled = false;
    const generalSettingsResponseHold = new Promise<void>((resolve) => {
      releaseGeneralSettingsResponse = resolve;
    });
    const generalSettingsRequestSeen = new Promise<void>((resolve) => {
      void page.route("**/api/instance/settings/general", async (route) => {
        resolve();
        await generalSettingsResponseHold;
        generalSettingsResponseFulfilled = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            censorUsernameInLogs: false,
            showDeveloperDiagnostics: false,
            locale: "en",
          }),
        });
      });
    });

    await page.goto(`/${organization.issuePrefix}/messenger`);

    const startedAt = Date.now();
    await page.getByRole("button", { name: "System settings" }).click();
    await expect(page.getByTestId("settings-modal-shell")).toBeVisible({ timeout: 500 });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(generalSettingsResponseFulfilled).toBe(false);

    await generalSettingsRequestSeen;
    releaseGeneralSettingsResponse();
    await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: createdOrganizations.at(-1)!.name })).toBeVisible();
  });
});
