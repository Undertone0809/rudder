import { expect, test } from "@playwright/test";

test.describe("Agent budget configuration", () => {
  test("keeps the budget control on Agent Detail and persists changes", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Agent Budget Config ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string; urlKey?: string | null };

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Budget Config Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string; urlKey?: string | null };
    const organizationRouteKey = organization.urlKey ?? organization.issuePrefix;
    const agentRouteKey = agent.urlKey ?? agent.id;

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organizationRouteKey}/agents/${agentRouteKey}/configuration`, {
      waitUntil: "domcontentloaded",
    });

    const mainContent = page.locator("#main-content");
    await expect(mainContent.getByRole("heading", { name: "Budget Config Agent", exact: true })).toBeVisible({
      timeout: 60_000,
    });
    const budgetTab = mainContent.getByRole("tab", { name: "Budget", exact: true });
    await expect(budgetTab).toBeVisible();
    await budgetTab.click();
    await expect(page).toHaveURL(new RegExp(`/${organizationRouteKey}/agents/${agentRouteKey}/budget$`));
    await expect(mainContent.getByText("Monthly UTC budget", { exact: true })).toBeVisible();
    await expect(mainContent.getByText("No cap configured", { exact: true })).toBeVisible();

    await mainContent.getByPlaceholder("0.00").fill("125.50");
    const saveResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/orgs/${organization.id}/budgets/policies`),
    );
    await mainContent.getByRole("button", { name: "Set budget", exact: true }).click();
    expect((await saveResponse).ok()).toBe(true);

    await expect(mainContent.getByText("$125.50", { exact: true }).first()).toBeVisible();
    const overviewRes = await page.request.get(`/api/orgs/${organization.id}/budgets/overview`);
    expect(overviewRes.ok()).toBe(true);
    const overview = await overviewRes.json() as {
      policies: Array<{ scopeType: string; scopeId: string; amount: number }>;
    };
    expect(overview.policies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scopeType: "agent",
        scopeId: agent.id,
        amount: 12_550,
      }),
    ]));
  });
});
