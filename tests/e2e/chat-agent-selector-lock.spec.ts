import { expect, test } from "@playwright/test";
import { E2E_CODEX_STUB } from "./support/e2e-env";

test.describe("Chat runtime selector availability", () => {
  test("keeps model and reasoning controls available after conversation start", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Runtime-Control-Chat-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Internal Runtime Agent",
        role: "engineer",
        title: "Engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          modelReasoningEffort: "high",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
      window.localStorage.setItem("rudder.theme", "dark");
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat?agentId=${agent.id}`);
    await expect(page.locator("html")).toHaveClass(/dark/);

    const runtimeSelector = page.getByTestId("chat-runtime-selector");
    await expect(runtimeSelector).toContainText("gpt-5.4 · High", { timeout: 15_000 });

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await composer.fill("Start the runtime-controlled conversation");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(runtimeSelector).toBeEnabled({ timeout: 15_000 });
    await runtimeSelector.click();
    const runtimeMenu = page.getByTestId("chat-runtime-menu");
    await expect(runtimeMenu).toBeVisible();
    await expect(runtimeMenu).not.toContainText("Internal Runtime Agent");
    await expect(page.getByRole("menuitemradio")).toHaveCount(0);
    await expect(page.getByTestId("chat-model-selector")).toBeEnabled();
    await expect(page.getByTestId("chat-effort-selector")).toBeEnabled();

    await expect(page.getByRole("button", { name: "Stop streaming" }))
      .toBeVisible({ timeout: 15_000 });
  });
});
