import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

async function createOrganization(page: Page, namePrefix: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name: `${namePrefix}-${Date.now()}`,
    },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json() as Promise<{ id: string; issuePrefix: string }>;
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

  test("returns to the previous page while an editable field has focus", async ({ page }) => {
    const organization = await createOrganization(page, "Escape-Input");
    await selectOrganization(page, organization.id);

    await page.goto("/dashboard");
    await page.getByRole("link", { name: "Issue" }).click();
    await expect(page).toHaveURL(/\/issues$/);

    await page.getByRole("textbox", { name: "Search issues" }).fill("deployment");
    await page.keyboard.press("Escape");

    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test("does not leave dirty Agent configuration on Escape", async ({ page }) => {
    const organization = await createOrganization(page, "Escape-Dirty-Agent");
    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Asher",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { model: "gpt-5.5" },
        runtimeConfig: {},
      },
    });
    expect(agentRes.ok()).toBe(true);

    await selectOrganization(page, organization.id);
    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByTestId("primary-rail").getByRole("link", { name: "Agents" }).click();
    await page.getByRole("link", { name: "Asher (Engineer)" }).click();
    await page.getByRole("tab", { name: "Configuration" }).click();
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/agents/[^/]+/configuration$`));

    await page.getByRole("spinbutton", { name: "Agent run concurrency" }).fill("4");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");

    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/agents/[^/]+/configuration$`));
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  });
});
