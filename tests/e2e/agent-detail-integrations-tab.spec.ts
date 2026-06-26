import { expect, test } from "@playwright/test";
import { E2E_BASE_URL } from "./support/e2e-env";

test.describe("Agent detail integrations tab", () => {
  test("shows Feishu setup plus planned tool integrations", async ({ page }) => {
    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `Agent-Integrations-Tab-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const agentRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Integration Scout",
        role: "engineer",
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    await page.addInitScript(({ orgId }) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, { orgId: organization.id });

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/agents/${agent.id}/integrations`, {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByRole("heading", { name: "Integration Scout", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Integrations", exact: true })).toBeVisible();
    await expect(page.getByText("Connect the external tools this agent can use during work loops.")).toBeVisible();
    await expect(page.getByText("0 of 8 connected")).toBeVisible();
    await expect(page.getByText("Feishu / Lark Not configured")).toBeVisible();
    await expect(page.getByText("Create a Feishu bot named Integration Scout - Rudder")).toBeVisible();

    for (const name of [
      "Gmail",
      "Google Calendar",
      "Google Drive",
      "Notion",
      "Feishu Workspace",
      "GitHub",
      "Linear",
    ]) {
      await expect(page.getByText(name, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: `${name} setup coming soon` })).toBeDisabled();
    }

    await expect(page.getByText("Coming soon")).toHaveCount(7);
  });
});
