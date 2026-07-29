import { expect, test } from "@playwright/test";

test.describe("Organization route aliases", () => {
  test("accepts urlKey organization routes and redirects them to the canonical issuePrefix route", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Rudder Route Alias ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string; urlKey: string };

    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.urlKey}/dashboard`);

    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/dashboard$`));
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByText("Organization not found")).toHaveCount(0);
  });

  test("offers one primary home action for an unknown organization route", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Rudder Not Found Home ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; urlKey: string };

    await page.addInitScript((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/missing-organization/messenger");

    await expect(page.getByRole("heading", { name: "Organization not found" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Go home", exact: true })).toHaveCount(1);
    await expect(page.getByRole("link", { name: "Open home", exact: true })).toHaveCount(0);

    await page.getByRole("link", { name: "Go home", exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/messenger/chat(?:/[^/]+)?$`));
  });
});
