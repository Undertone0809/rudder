import { expect, test } from "@playwright/test";

test.describe("Heartbeat settings interval-zero state", () => {
  test("shows configured inactive interval-zero heartbeats as off in both settings surfaces", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Heartbeat Configured Inactive ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const agentName = `Heartbeat Interval Zero ${Date.now()}`;
    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: agentName,
        role: "designer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
        },
        runtimeConfig: {
          heartbeat: {
            enabled: true,
            intervalSec: 0,
          },
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();
    await page.locator('a[href$="/instance/settings/heartbeats"]').click();

    const settingsRow = page.locator('[data-testid="heartbeat-agent-row"]').filter({
      has: page.getByRole("link", { name: agentName }),
    });
    await expect(settingsRow).toBeVisible();
    await expect(settingsRow.getByText("Configured, inactive")).toBeVisible();
    await expect(settingsRow.getByRole("button", { name: "On" })).toHaveAttribute("aria-pressed", "false");
    await expect(settingsRow.getByRole("button", { name: "Off" })).toHaveAttribute("aria-pressed", "true");

    const disableResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().includes(`/api/agents/${agent.id}`)
      && response.ok(),
    );
    await settingsRow.getByRole("button", { name: "Off" }).click();
    await disableResponse;
    await expect(settingsRow.getByText("Disabled")).toBeVisible();

    await page.goto(`/${organization.issuePrefix}/heartbeats`);
    const orgRow = page.getByTestId("org-heartbeat-row").filter({
      has: page.getByRole("link", { name: agentName }),
    });
    await expect(orgRow).toBeVisible();
    await expect(orgRow.getByText("Disabled")).toBeVisible();
    await expect(orgRow.getByRole("button", { name: "On" })).toHaveAttribute("aria-pressed", "false");
    await expect(orgRow.getByRole("button", { name: "Off" })).toHaveAttribute("aria-pressed", "true");
  });
});
