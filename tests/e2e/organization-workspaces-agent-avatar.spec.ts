import { expect, test } from "@playwright/test";

test.describe("Organization workspaces agent avatar", () => {
  test("shows each agent workspace with the agent's generated avatar", async ({ page, request }) => {
    const organizationRes = await request.post("/api/orgs", {
      data: {
        name: `Organization-Workspaces-Agent-Avatar-${Date.now()}`,
      },
    });
    expect(organizationRes.ok()).toBe(true);
    const organization = await organizationRes.json() as { id: string; issuePrefix: string };

    const agentRes = await request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Avatar Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
        runtimeConfig: {},
      },
    });
    expect(agentRes.ok()).toBe(true);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/workspaces`);

    await page.getByRole("button", { name: /^agents$/i }).click();

    const agentWorkspaceRow = page.getByRole("button", { name: /Avatar Agent/i });
    await expect(agentWorkspaceRow).toBeVisible();
    await expect(
      agentWorkspaceRow.getByTestId("org-workspaces-agent-icon").locator('img[src^="data:image/svg+xml"]'),
    ).toBeVisible();
    await expect(agentWorkspaceRow.getByTestId("org-workspaces-agent-badge")).toHaveText("Agent");
  });
});
