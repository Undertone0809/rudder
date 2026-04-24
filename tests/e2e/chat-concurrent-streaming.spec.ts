import { expect, test, type Page } from "@playwright/test";
import { E2E_CODEX_STUB } from "./support/e2e-env";

async function createStreamingOrg(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name,
      defaultChatAgentRuntimeType: "codex_local",
      defaultChatAgentRuntimeConfig: {
        model: "gpt-5.4",
        command: E2E_CODEX_STUB,
      },
    },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json();
}

function currentChatId(pageUrl: string) {
  const pathname = new URL(pageUrl).pathname;
  const chatId = pathname.split("/").pop();
  expect(chatId).toBeTruthy();
  return chatId!;
}

test("allows sending a new chat while another chat is still streaming", async ({ page }) => {
  const organization = await createStreamingOrg(page, `Concurrent-Chat-${Date.now()}`);

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto("/messenger");

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("First concurrent chat");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page).toHaveURL(/\/messenger\/chat\/[^/]+$/i, { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Stop streaming" })).toBeVisible({ timeout: 15_000 });
  const firstChatId = currentChatId(page.url());
  await expect(page.getByTestId(`messenger-thread-chat-${firstChatId}`)).toBeVisible({ timeout: 15_000 });

  await page.locator('[data-testid="workspace-sidebar"]').getByRole("link", { name: "New chat" }).first().click();

  await expect(page).toHaveURL(/\/messenger\/chat$/i, { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Stop streaming" })).toHaveCount(0);

  const secondComposer = page.locator(".rudder-mdxeditor-content").first();
  await secondComposer.fill("Second concurrent chat");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page).toHaveURL(/\/messenger\/chat\/[^/]+$/i, { timeout: 15_000 });
  const secondChatId = currentChatId(page.url());
  expect(secondChatId).not.toBe(firstChatId);

  const assistantReply = page.getByTestId("chat-assistant-message").last();
  await expect(assistantReply).toContainText("Streaming reply for chat.", { timeout: 15_000 });
  await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: "Second concurrent chat" })).toBeVisible({
    timeout: 15_000,
  });

  await page.getByTestId(`messenger-thread-chat-${firstChatId}`).click();
  await expect(page).toHaveURL(new RegExp(`/messenger/chat/${firstChatId}$`, "i"), { timeout: 15_000 });
  await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: "First concurrent chat" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("chat-assistant-message").last()).toContainText("Streaming reply for chat.", {
    timeout: 15_000,
  });
});
