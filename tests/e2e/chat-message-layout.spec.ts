import { expect, test } from "@playwright/test";
import { E2E_CODEX_STUB } from "./support/e2e-env";

test.describe("Chat message layout", () => {
  test("keeps the user bubble compact and places message actions below it", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Layout-Chat-${Date.now()}`,
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

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("你好");
    await page.getByRole("button", { name: "Send" }).click();

    const bubble = page.getByTestId("chat-user-message-bubble").filter({ hasText: "你好" }).last();
    await expect(bubble).toBeVisible({ timeout: 15_000 });
    await bubble.hover();

    const toolbar = page.getByTestId("chat-user-message-toolbar").last();
    await expect(toolbar).toBeVisible();
    await expect(toolbar).not.toContainText("ago");
    await expect(toolbar).toContainText(/[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M/);

    const bubbleBox = await bubble.boundingBox();
    const toolbarBox = await toolbar.boundingBox();

    expect(bubbleBox).not.toBeNull();
    expect(toolbarBox).not.toBeNull();
    expect(bubbleBox!.width).toBeLessThan(160);
    expect(toolbarBox!.y).toBeGreaterThanOrEqual(bubbleBox!.y + bubbleBox!.height - 1);
  });
});
