import { expect, test } from "@playwright/test";

test.describe("Agent detail terminate confirmation", () => {
  test("requires confirmation before terminating an agent", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Agent-Terminate-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Blake",
        role: "designer",
        title: "Design Lead",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json();

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto("/");
    await page.getByRole("link", { name: "Agents", exact: true }).click();
    await page.getByText("Blake (Design Lead)", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "Blake", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Agent actions" }).click();
    await page.getByRole("button", { name: "Terminate", exact: true }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Terminate agent" })).toBeVisible();
    await expect(dialog).toContainText("will be marked as terminated and can no longer run or resume");

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("terminated", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Agent actions" }).click();
    await page.getByRole("button", { name: "Terminate", exact: true }).click();

    const terminateResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST" && response.url().includes("/terminate"),
    );
    await dialog.getByRole("button", { name: "Terminate", exact: true }).click();
    const terminateResponse = await terminateResponsePromise;

    await expect(dialog).toBeHidden();
    expect(terminateResponse.ok()).toBe(true);
  });
});
