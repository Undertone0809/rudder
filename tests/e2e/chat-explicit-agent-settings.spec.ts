import { expect, test } from "@playwright/test";

test.describe("Explicit chat agent settings", () => {
  test("omits Copilot runtime controls from organization settings", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Explicit-Agent-Settings-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/organization/settings");

    await expect(page.getByText("Chat assistant", { exact: true })).toBeVisible();
    await expect(page.getByText("Default issue creation mode", { exact: true })).toBeVisible();
    await expect(page.getByText("Rudder Copilot", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Copilot runtime chain", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Test Copilot runtime chain", exact: true })).toHaveCount(0);
  });

  test("asks the operator to create an agent when no chat agent is available", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Explicit-Agent-Warning-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat`);

    await expect(page.getByRole("button", { name: "No agents available", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Create or activate an agent before sending messages.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  });
});
