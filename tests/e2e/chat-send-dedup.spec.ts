import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatConversations, createDb } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB, E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

async function createStreamingOrg(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name,
    },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json();
  const chatAgent = await createE2EChatAgent(page.request, organization.id, {
    name: "Chat Agent",
    command: E2E_CODEX_STUB,
  });
  return { ...organization, chatAgent };
}

async function seedLegacyChat(orgId: string) {
  const id = randomUUID();
  await e2eDb.insert(chatConversations).values({
    id,
    orgId,
    title: "Legacy chat without an agent",
    preferredAgentId: null,
    issueCreationMode: "manual_approval",
    planMode: false,
  });
  return id;
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

  await page.goto(`/chat?agentId=${organization.chatAgent.id}`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("No duplicates please");

  await page.getByRole("button", { name: "Send" }).dblclick();
  await expect(page.getByRole("button", { name: "Sending" })).toBeVisible({ timeout: 15_000 });

  await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: "No duplicates please" })).toHaveCount(1, {
    timeout: 15_000,
  });
  await expect(page.getByTestId("chat-assistant-message").last()).toContainText("Streaming reply for chat.", {
    timeout: 30_000,
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

test("shows sending feedback while binding a legacy chat agent", async ({ page }) => {
  const organization = await createStreamingOrg(page, `Legacy-Chat-${Date.now()}`);
  const chatId = await seedLegacyChat(organization.id);
  let releaseAgentBinding = () => {};
  let markAgentBindingStarted = () => {};
  const agentBindingStarted = new Promise<void>((resolve) => {
    markAgentBindingStarted = () => resolve();
  });
  const agentBindingReleased = new Promise<void>((resolve) => {
    releaseAgentBinding = () => resolve();
  });

  await page.route(`**/api/chats/${chatId}`, async (route, request) => {
    if (request.method() !== "PATCH") {
      await route.continue();
      return;
    }
    markAgentBindingStarted();
    await agentBindingReleased;
    await route.continue();
  });

  try {
    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chatId}`);

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("Send from a legacy chat");
    const sendButton = page.getByRole("button", { name: "Send" });
    await expect(sendButton).toBeEnabled({ timeout: 15_000 });
    await sendButton.click();

    await agentBindingStarted;
    const sendingButton = page.getByRole("button", { name: "Sending" });
    await expect(sendingButton).toBeVisible({ timeout: 1_500 });
    await expect(sendingButton).toBeDisabled();

    releaseAgentBinding();
    await expect(page.getByTestId("chat-assistant-message").last()).toContainText("Streaming reply for chat.", {
      timeout: 15_000,
    });
  } finally {
    releaseAgentBinding();
    await page.unroute(`**/api/chats/${chatId}`);
  }
});
