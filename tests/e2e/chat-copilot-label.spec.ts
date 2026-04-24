import { expect, test } from "@playwright/test";
import { E2E_CODEX_STUB } from "./support/e2e-env";

test.describe("Chat copilot naming", () => {
  test("shows Rudder Copilot as the default chat assistant and explains it in the picker", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Copilot-Chat-${Date.now()}`,
        defaultChatAgentRuntimeType: "codex_local",
        defaultChatAgentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/chat");

    const copilotButton = page.getByRole("button", { name: "Rudder Copilot", exact: true });
    await expect(copilotButton).toBeVisible({ timeout: 15_000 });

    await copilotButton.click();
    const copilotMenuItem = page.getByRole("menuitemradio", { name: "Rudder Copilot", exact: true });
    await expect(copilotMenuItem).toBeVisible();
    await copilotMenuItem.hover();
    await expect(page.getByText("Uses your organization's Copilot runtime to clarify requests and shape chat proposals when no specific agent is selected.")).toBeVisible();
    await copilotMenuItem.click();

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible();
    await composer.fill("Route this through Copilot");
    await page.getByRole("button", { name: "Send" }).click();

    const assistantMessage = page.getByTestId("chat-assistant-message").last();
    await expect(assistantMessage).toContainText("Rudder Copilot", { timeout: 15_000 });
  });
});
