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

function sideComposerEditor(panel: Locator) {
  return panel.getByTestId("side-chat-composer").locator(".rudder-mdxeditor-content").first();
}

async function sendFirstSideChatMessage(page: Page, panel: Locator, sourceConversationId: string) {
  const createResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && response.url().includes(`/api/chats/${sourceConversationId}/side-chats`)
  ));
  await sideComposerEditor(panel).fill("What is the rollback trigger?");
  await panel.getByRole("button", { name: "Send Side Chat message" }).click();
  const createResponse = await createResponsePromise;
  expect(createResponse.ok(), await createResponse.text()).toBe(true);
  const sideChat = await createResponse.json() as { id: string };
  await expect(panel.getByTestId("side-chat-messages")).toContainText("What is the rollback trigger?", { timeout: 15_000 });
  await expect(panel.getByTestId("side-chat-streaming-reply")).toContainText("Streaming reply", { timeout: 15_000 });
  await expect(panel.getByTestId("chat-assistant-message").filter({ hasText: "Streaming reply for chat." })).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByRole("button", { name: "Done & return" })).toHaveCount(0);
  return sideChat;
}

test("Side Chat preserves the main draft, streams like Chat, and is destroyed when closed", async ({ page }, testInfo) => {
  const source = await seedSideChatSource(page, `Side-Chat-Close-${Date.now()}`);
  const mainComposer = page.getByTestId("chat-composer-editor-scroll").locator(".rudder-mdxeditor-content").first();
  await mainComposer.click();
  await page.keyboard.insertText("Keep this unfinished main-chat draft");

  const panel = await openFromAssistantAction(page, source.assistantMessageId);
  await expect(mainComposer).toContainText("Keep this unfinished main-chat draft");
  await page.screenshot({ path: testInfo.outputPath("01-assistant-action-draft.png"), fullPage: true });
  await expect(panel.locator(".chat-composer")).toBeVisible();
  await expect(panel.getByTestId("side-chat-project-chip")).toBeVisible();
  await expect(panel.getByTestId("side-chat-agent-chip")).toContainText("Sidekick");
  await expect(panel).not.toContainText("Enter to send · Shift+Enter for a new line");
  await expect(panel.getByTestId("side-chat-icon")).toHaveClass(/lucide-circle-plus/);
  const sideChat = await sendFirstSideChatMessage(page, panel, source.conversationId);

  const hiddenList = await page.request.get(`/api/orgs/${source.organization.id}/chats?status=all`);
  expect(hiddenList.ok()).toBe(true);
  expect((await hiddenList.json() as Array<{ id: string }>).some((chat) => chat.id === sideChat.id)).toBe(false);
  const hiddenMessenger = await page.request.get(
    `/api/orgs/${source.organization.id}/messenger/threads?limit=40&splitIssues=true`,
  );
  expect(hiddenMessenger.ok()).toBe(true);
  expect((await hiddenMessenger.json() as { items: Array<{ threadKey: string }> }).items
    .some((thread) => thread.threadKey === `chat:${sideChat.id}`)).toBe(false);
  const hiddenMessengerThread = await page.request.get(
    `/api/orgs/${source.organization.id}/messenger/chat/${sideChat.id}`,
  );
  expect(hiddenMessengerThread.status()).toBe(404);

  await page.screenshot({ path: testInfo.outputPath("02-side-chat-active.png"), fullPage: true });
  const destroyResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "DELETE"
    && response.url().includes(`/api/chats/${sideChat.id}/side-chat`)
  ));
  const sideChatTab = panel.locator('[data-side-panel-tab-key^="side-chat:"]');
  await sideChatTab.hover();
  await sideChatTab.getByRole("button", { name: "Close Side Chat tab" }).click();
  const destroyResponse = await destroyResponsePromise;
  expect(destroyResponse.ok(), await destroyResponse.text()).toBe(true);
  await expect(panel).toBeHidden();
  expect((await page.request.get(`/api/chats/${sideChat.id}`)).status()).toBe(404);
  await expect(mainComposer).toContainText("Keep this unfinished main-chat draft");
  await page.screenshot({ path: testInfo.outputPath("03-side-chat-destroyed.png"), fullPage: true });
});

test("the /side menu matches composer popovers and can keep the same Side Chat in Messenger", async ({ page }, testInfo) => {
  const source = await seedSideChatSource(page, `Side-Chat-Keep-${Date.now()}`);
  const mainComposer = page.getByTestId("chat-composer-editor-scroll").locator(".rudder-mdxeditor-content").first();
  await mainComposer.click();
  await page.keyboard.insertText("/");
  const slashMenu = page.getByTestId("chat-slash-command-menu");
  await expect(slashMenu).toBeVisible();
  await expect(slashMenu).toHaveAttribute("role", "menu");
  await expect(slashMenu.getByTestId("chat-slash-side-chat")).toHaveAttribute("role", "menuitem");
  await page.waitForTimeout(400);
  const [menuBox, composerBox] = await Promise.all([slashMenu.boundingBox(), page.locator(".chat-composer").boundingBox()]);
  expect(menuBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(composerBox!.y - 8);
  expect(Math.abs(menuBox!.width - composerBox!.width)).toBeLessThanOrEqual(2);
  await page.screenshot({ path: testInfo.outputPath("05-side-slash-menu.png"), fullPage: true });
  await page.keyboard.press("Enter");
  const panel = page.getByTestId("chat-side-panel");
  await expect(panel.getByTestId("side-chat-panel-view")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("06-side-slash-draft.png"), fullPage: true });

  const sideChat = await sendFirstSideChatMessage(page, panel, source.conversationId);
  const keepResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && response.url().includes(`/api/chats/${sideChat.id}/side-chat/keep`)
  ));
  await panel.getByRole("button", { name: "Keep in Messenger" }).click();
  const keepResponse = await keepResponsePromise;
  expect(keepResponse.ok(), await keepResponse.text()).toBe(true);
  expect(await keepResponse.json()).toMatchObject({ id: sideChat.id, messengerVisible: true, sideChatState: "kept" });
  await expect(page).toHaveURL(new RegExp(`/messenger/chat/${sideChat.id}$`));
  await expect(page.getByTestId("side-chat-panel-view")).toHaveCount(0);
  await expect(page.getByTestId("chat-composer-layout")).toBeVisible();
  await expect(page.getByTestId("chat-assistant-message").filter({ hasText: "Streaming reply for chat." })).toBeVisible();

  const listAfterKeep = await page.request.get(`/api/orgs/${source.organization.id}/chats?status=active`);
  expect(listAfterKeep.ok()).toBe(true);
  expect((await listAfterKeep.json() as Array<{ id: string }>).some((chat) => chat.id === sideChat.id)).toBe(true);
  const visibleMessengerThread = await page.request.get(
    `/api/orgs/${source.organization.id}/messenger/chat/${sideChat.id}`,
  );
  expect(visibleMessengerThread.ok(), await visibleMessengerThread.text()).toBe(true);
  expect(await visibleMessengerThread.json()).toMatchObject({
    conversation: { id: sideChat.id, messengerVisible: true, sideChatState: "kept" },
  });
  await page.screenshot({ path: testInfo.outputPath("07-kept-in-messenger.png"), fullPage: true });
});

test("the Side Panel empty state opens the same provisional Side Chat flow", async ({ page }, testInfo) => {
  await seedSideChatSource(page, `Side-Chat-Panel-${Date.now()}`);
  await page.getByTestId("workspace-main-card").getByTestId("chat-side-panel-trigger").click();
  const panel = page.getByTestId("chat-side-panel");
  await expect(panel.getByTestId("chat-side-panel-empty-state")).toBeVisible();
  await expect(panel.getByTestId("chat-side-panel-empty-side chat-target")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("08-side-panel-empty-state.png"), fullPage: true });

  await panel.getByTestId("chat-side-panel-empty-side chat-target").click();
  await expect(panel.getByTestId("side-chat-panel-view")).toBeVisible();
  await expect(panel.getByTestId("side-chat-anchor-preview")).toContainText("narrow cohort");
  await expect(sideComposerEditor(panel)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("09-side-panel-entry-draft.png"), fullPage: true });

  const sideChatTab = panel.locator('[data-side-panel-tab-key^="side-chat:"]');
  await sideChatTab.hover();
  await sideChatTab.getByRole("button", { name: "Close Side Chat tab" }).click();
  await expect(panel).toBeHidden();
});

test("an elapsed Side Chat becomes non-editable and can still be destroyed", async ({ page }, testInfo) => {
  const source = await seedSideChatSource(page, `Side-Chat-Expiry-${Date.now()}`);
  const panel = await openFromAssistantAction(page, source.assistantMessageId);
  const createResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && response.url().includes(`/api/chats/${source.conversationId}/side-chats`)
  ));
  await sideComposerEditor(panel).fill("Expire this focused exploration.");
  await panel.getByRole("button", { name: "Send Side Chat message" }).click();
  const createResponse = await createResponsePromise;
  expect(createResponse.ok(), await createResponse.text()).toBe(true);
  const sideChat = await createResponse.json() as { id: string };
  await expect(panel.getByTestId("side-chat-messages")).toContainText("Expire this focused exploration.");
  await e2eDb
    .update(chatConversations)
    // This Playwright database is isolated to this run. Normal/kept rows ignore
    // this field, while the active Side Chat under test observes the deadline.
    .set({ sideChatExpiresAt: new Date(Date.now() + 1_000) });
  await expect(panel.getByTestId("side-chat-read-only")).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByTestId("side-chat-state")).toContainText("Expired · read-only");
  await expect(panel.getByTestId("side-chat-composer")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("10-side-chat-expired-read-only.png"), fullPage: true });

  const destroyResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "DELETE"
    && response.url().includes(`/api/chats/${sideChat.id}/side-chat`)
  ));
  const sideChatTab = panel.locator('[data-side-panel-tab-key^="side-chat:"]');
  await sideChatTab.hover();
  await sideChatTab.getByRole("button", { name: "Close Side Chat tab" }).click();
  expect((await destroyResponsePromise).ok()).toBe(true);
  expect((await page.request.get(`/api/chats/${sideChat.id}`)).status()).toBe(404);
});
