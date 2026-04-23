import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const E2E_HOME = path.resolve(THIS_DIR, ".tmp/rudder-e2e-home");
const E2E_CODEX_STUB = path.join(E2E_HOME, "bin", "codex");

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

test("deduplicates rapid send clicks when starting a new chat", async ({ page }) => {
  const organization = await createStreamingOrg(page, `Dedup-Chat-${Date.now()}`);

  await page.route(`**/api/orgs/${organization.id}/chats`, async (route, request) => {
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto("/chat");

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("No duplicates please");

  await page.getByRole("button", { name: "Send" }).dblclick();
  await expect(page.getByRole("button", { name: "Sending" })).toBeVisible({ timeout: 15_000 });

  await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: "No duplicates please" })).toHaveCount(1, {
    timeout: 15_000,
  });
  await expect(page.getByTestId("chat-assistant-message").last()).toContainText("Streaming reply for chat.", {
    timeout: 15_000,
  });

  const chatsRes = await page.request.get(`/api/orgs/${organization.id}/chats?status=all`);
  expect(chatsRes.ok()).toBe(true);
  const chats = await chatsRes.json();
  expect(chats).toHaveLength(1);

  const messagesRes = await page.request.get(`/api/chats/${chats[0].id}/messages`);
  expect(messagesRes.ok()).toBe(true);
  const messages = await messagesRes.json();
  const userMessages = messages.filter((message: { role: string; body: string }) =>
    message.role === "user" && message.body.includes("No duplicates please"));
  expect(userMessages).toHaveLength(1);
});
