import { expect, test } from "@playwright/test";

test.describe("Codex model order", () => {
  test("shows newest Codex models first in New Issue overrides", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Codex-Model-Order-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Newest First Agent",
        role: "general",
        title: "Coding Agent",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          command: "codex",
          model: "gpt-5.5",
        },
      },
    });
    expect(agentRes.ok()).toBe(true);

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/issues`, { waitUntil: "domcontentloaded" });

    await page.getByTestId("workspace-main-header")
      .getByRole("button", { name: "Create Issue" })
      .click();
    const dialog = page.locator('[data-slot="dialog-content"]')
      .filter({ has: page.getByText("New issue") })
      .first();
    await expect(dialog).toBeVisible();

    await dialog.getByRole("button", { name: "No assignee", exact: true }).click();
    await page.getByRole("button", { name: /Newest First Agent/ }).click();
    await dialog.getByRole("button", { name: "Codex options", exact: true }).click();
    await dialog.getByRole("button", { name: "Default model", exact: true }).click();

    const modelOptions = page.locator(
      '[data-slot="popover-content"][data-state="open"] [data-inline-entity-option]',
    );
    await expect(modelOptions).toHaveCount(8);
    expect(await modelOptions.allTextContents()).toEqual([
      "Default model",
      "GPT-5.6-sol",
      "GPT-5.6-terra",
      "GPT-5.6-luna",
      "GPT-5.5",
      "GPT-5.4",
      "GPT-5.4 Mini",
      "GPT-5.2",
    ]);
  });
});
