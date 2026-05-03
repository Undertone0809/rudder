import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function createOrganization(page: Page, namePrefix: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name: `${namePrefix}-${Date.now()}`,
    },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json() as Promise<{ id: string }>;
}

async function selectOrganization(page: Page, orgId: string) {
  await page.goto("/");
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

test.describe("Global Escape navigation", () => {
  test("returns to the previous page from a normal workspace route", async ({ page }) => {
    const organization = await createOrganization(page, "Escape-Back");
    await selectOrganization(page, organization.id);

    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/dashboard$/);

    await page.getByRole("link", { name: "Issue" }).click();
    await expect(page).toHaveURL(/\/issues$/);

    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test("does not navigate back while an editable field has focus", async ({ page }) => {
    const organization = await createOrganization(page, "Escape-Input");
    await selectOrganization(page, organization.id);

    await page.goto("/dashboard");
    await page.getByRole("link", { name: "Issue" }).click();
    await expect(page).toHaveURL(/\/issues$/);

    await page.getByRole("textbox", { name: "Search issues" }).fill("deployment");
    await page.keyboard.press("Escape");

    await expect(page).toHaveURL(/\/issues$/);
  });
});
