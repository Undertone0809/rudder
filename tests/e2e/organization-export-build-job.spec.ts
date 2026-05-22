import { expect, test } from "@playwright/test";
import { E2E_BASE_URL } from "./support/e2e-env";

test.describe("Organization export build job", () => {
  test("builds an export through a visible job panel before download", async ({ page }) => {
    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `Export Job ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = (await orgRes.json()) as { id: string; issuePrefix: string };

    const agentRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Export Agent",
        role: "ceo",
        title: "Export Owner",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
        },
      },
    });
    expect(agentRes.ok()).toBe(true);

    await page.goto(E2E_BASE_URL);
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/organization/export`);

    const buildButton = page.getByRole("button", { name: /Build \d+ files?/ });
    await expect(buildButton).toBeVisible();
    await buildButton.click();

    await expect(page.getByText(/Building export package|Export ready/)).toBeVisible();
    await expect(page.getByText("Export ready")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Download .zip" })).toHaveCount(1);
  });
});
