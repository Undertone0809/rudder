import { expect, test } from "@playwright/test";
import { E2E_CODEX_STUB } from "./support/e2e-env";

test.describe("Chat agent selector lock", () => {
  test("locks the selected agent after the first message starts", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Agent-Lock-Chat-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Lock Agent",
        role: "engineer",
        title: "Engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(agentRes.ok()).toBe(true);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/chat");

    const agentSelector = page.getByTestId("chat-agent-selector");
    await expect(agentSelector).toBeVisible({ timeout: 15_000 });
    await agentSelector.click();
    await page.getByRole("menuitemradio", { name: /Lock Agent/ }).click();
    await expect(agentSelector).toContainText("Lock Agent");

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible();
    await composer.fill("Start the locked-agent conversation");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(agentSelector).toBeDisabled({ timeout: 15_000 });
    await expect(agentSelector.locator("svg")).toHaveCount(0);

    const backgroundBeforeHover = await agentSelector.evaluate((element) => getComputedStyle(element).backgroundColor);
    await agentSelector.hover({ force: true });
    await expect.poll(async () => agentSelector.evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe(backgroundBeforeHover);

    await agentSelector.evaluate((element) => (element as HTMLButtonElement).click());
    await expect(page.getByTestId("chat-agent-menu")).toHaveCount(0);

    await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 15_000 });
    await expect(agentSelector).toBeDisabled();
  });
});
