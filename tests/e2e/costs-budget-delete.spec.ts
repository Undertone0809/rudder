import { expect, test } from "@playwright/test";

test.describe("Costs budget controls", () => {
  test("lets the board delete an existing agent budget", async ({ page }) => {
    test.setTimeout(180_000);

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Budget Delete ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Budget Delete Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    const policyRes = await page.request.post(`/api/orgs/${organization.id}/budgets/policies`, {
      data: {
        scopeType: "agent",
        scopeId: agent.id,
        amount: 20_000,
        windowKind: "calendar_month_utc",
      },
    });
    expect(policyRes.ok()).toBe(true);
    const policy = await policyRes.json() as { policyId: string };

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/costs`, {
      waitUntil: "commit",
    });

    const mainContent = page.locator("#main-content");
    await expect(mainContent.getByRole("heading", { name: "Costs", exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await mainContent.getByRole("tab", { name: "Budgets" }).click();
    await expect(mainContent.getByRole("heading", { name: "Agent budgets" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(mainContent.getByText("Budget Delete Agent")).toBeVisible();
    await expect(mainContent.getByText("$200.00", { exact: true }).first()).toBeVisible();

    await mainContent.getByRole("button", { name: "Delete budget" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Delete Budget Delete Agent budget?")).toBeVisible();
    await dialog.getByRole("button", { name: "Delete budget" }).click();

    await expect(mainContent.getByText("Budget Delete Agent")).toBeHidden();
    const overviewRes = await page.request.get(`/api/orgs/${organization.id}/budgets/overview`);
    expect(overviewRes.ok()).toBe(true);
    const overview = await overviewRes.json() as { policies: Array<{ policyId: string }> };
    expect(overview.policies.some((item) => item.policyId === policy.policyId)).toBe(false);
  });
});
