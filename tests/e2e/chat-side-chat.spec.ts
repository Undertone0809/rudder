import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  chatConversations,
  chatMessages,
  createDb,
} from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB, E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

async function seedSideChatSource(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", { data: { name } });
  expect(orgRes.ok(), await orgRes.text()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: "Sidekick",
    command: E2E_CODEX_STUB,
  }) as { id: string };
  const conversationId = randomUUID();
  const assistantMessageId = randomUUID();
  await e2eDb.insert(chatConversations).values({
    id: conversationId,
    orgId: organization.id,
    title: "Main strategy chat",
    preferredAgentId: agent.id,
    issueCreationMode: "manual_approval",
    planMode: false,
    createdByUserId: "local-board",
    lastMessageAt: new Date(),
  });
  await e2eDb.insert(chatMessages).values([
    {
      id: randomUUID(),
      orgId: organization.id,
      conversationId,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Give me the launch recommendation.",
    },
    {
      id: assistantMessageId,
      orgId: organization.id,
      conversationId,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Launch with a narrow cohort and keep a rollback path.",
      replyingAgentId: agent.id,
    },
  ]);
  await page.goto("/");
  await page.evaluate((orgId) => localStorage.setItem("rudder.selectedOrganizationId", orgId), organization.id);
  await page.setViewportSize({ width: 1500, height: 940 });
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${conversationId}`);
  await expect(page.getByTestId("chat-assistant-message").filter({ hasText: "narrow cohort" })).toBeVisible({ timeout: 15_000 });
  return { organization, conversationId, assistantMessageId };
}

async function openFromAssistantAction(page: Page, assistantMessageId: string) {
  const assistant = page.locator(`[data-testid="chat-assistant-message"][data-message-id="${assistantMessageId}"]`);
  await assistant.hover();
  await assistant.getByRole("button", { name: "Open Side Chat" }).click();
  const panel = page.getByTestId("chat-side-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("side-chat-anchor-preview")).toContainText("narrow cohort");
  return panel;
}

async function sendFirstSideChatMessage(page: Page, panel: Locator, sourceConversationId: string) {
  const createResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && response.url().includes(`/api/chats/${sourceConversationId}/side-chats`)
  ));
  await panel.getByPlaceholder("Ask a focused follow-up…").fill("What is the rollback trigger?");
  await panel.getByRole("button", { name: "Send" }).click();
  const createResponse = await createResponsePromise;
  expect(createResponse.ok(), await createResponse.text()).toBe(true);
  const sideChat = await createResponse.json() as { id: string };
  await expect(panel.getByTestId("side-chat-messages")).toContainText("What is the rollback trigger?", { timeout: 15_000 });
  await expect(panel.getByRole("button", { name: "Done & return" })).toBeEnabled({ timeout: 20_000 });
  return sideChat;
}

test("Side Chat preserves the main draft, becomes read-only on Done, and disappears when closed", async ({ page }, testInfo) => {
  const source = await seedSideChatSource(page, `Side-Chat-Done-${Date.now()}`);
  const mainComposer = page.getByTestId("chat-composer-editor-scroll").locator(".rudder-mdxeditor-content").first();
  await mainComposer.click();
  await page.keyboard.insertText("Keep this unfinished main-chat draft");

  const panel = await openFromAssistantAction(page, source.assistantMessageId);
  await expect(mainComposer).toContainText("Keep this unfinished main-chat draft");
  const sideChat = await sendFirstSideChatMessage(page, panel, source.conversationId);

  const listBeforeDone = await page.request.get(`/api/orgs/${source.organization.id}/chats?status=all`);
  expect(listBeforeDone.ok()).toBe(true);
  expect((await listBeforeDone.json() as Array<{ id: string }>).some((chat) => chat.id === sideChat.id)).toBe(false);
  const messengerBeforeDone = await page.request.get(
    `/api/orgs/${source.organization.id}/messenger/threads?limit=40&splitIssues=true`,
  );
  expect(messengerBeforeDone.ok()).toBe(true);
  expect((await messengerBeforeDone.json() as { items: Array<{ threadKey: string }> }).items
    .some((thread) => thread.threadKey === `chat:${sideChat.id}`)).toBe(false);

  await page.screenshot({ path: testInfo.outputPath("side-chat-active.png"), fullPage: true });
  await panel.getByRole("button", { name: "Done & return" }).click();
  await expect(panel.getByTestId("side-chat-read-only")).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByTestId("side-chat-state")).toContainText("Completed · read-only");
  await expect(panel.getByTestId("side-chat-composer")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("side-chat-read-only.png"), fullPage: true });

  const sideChatTab = panel.locator('[data-side-panel-tab-key^="side-chat:"]');
  await sideChatTab.hover();
  await sideChatTab.getByRole("button", { name: "Close Side Chat tab" }).click();
  await expect(panel).toBeHidden();
  const auditRecordRes = await page.request.get(`/api/chats/${sideChat.id}`);
  expect(auditRecordRes.ok()).toBe(true);
  expect(await auditRecordRes.json()).toMatchObject({
    id: sideChat.id,
    messengerVisible: false,
    sideChatState: "completed",
  });
});

test("the /side entry can keep the same Side Chat in Messenger", async ({ page }) => {
  const source = await seedSideChatSource(page, `Side-Chat-Keep-${Date.now()}`);
  const mainComposer = page.getByTestId("chat-composer-editor-scroll").locator(".rudder-mdxeditor-content").first();
  await mainComposer.click();
  await page.keyboard.insertText("/");
  const slashMenu = page.getByTestId("chat-slash-command-menu");
  await expect(slashMenu).toBeVisible();
  await slashMenu.getByTestId("chat-slash-side-chat").click();
  const panel = page.getByTestId("chat-side-panel");
  await expect(panel.getByTestId("side-chat-panel-view")).toBeVisible();

  const sideChat = await sendFirstSideChatMessage(page, panel, source.conversationId);
  const keepResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && response.url().includes(`/api/chats/${sideChat.id}/side-chat/keep`)
  ));
  await panel.getByRole("button", { name: "Keep in Messenger" }).click();
  const keepResponse = await keepResponsePromise;
  expect(keepResponse.ok(), await keepResponse.text()).toBe(true);
  expect(await keepResponse.json()).toMatchObject({ id: sideChat.id, messengerVisible: true, sideChatState: "kept" });
  await expect(panel.getByTestId("side-chat-state")).toContainText("Kept in Messenger");

  const listAfterKeep = await page.request.get(`/api/orgs/${source.organization.id}/chats?status=active`);
  expect(listAfterKeep.ok()).toBe(true);
  expect((await listAfterKeep.json() as Array<{ id: string }>).some((chat) => chat.id === sideChat.id)).toBe(true);
});
