import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq } from "../../packages/db/node_modules/drizzle-orm/index.js";
import {
  chatConversations,
  chatMessages,
  createDb,
  messengerCustomGroupEntries,
  messengerCustomGroups,
} from "../../packages/db/src/index.ts";
import { MESSENGER_FORK_GROUP_DEFAULT_ICON } from "../../packages/shared/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB, E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

function threadTestId(threadKey: string) {
  return `messenger-thread-${threadKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

async function seedSideChatSource(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", { data: { name } });
  expect(orgRes.ok(), await orgRes.text()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: "Sidekick",
    command: E2E_CODEX_STUB,
  }) as { id: string };
  const alternateAgent = await createE2EChatAgent(page.request, organization.id, {
    name: "Analyst",
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
  return { organization, agent, alternateAgent, conversationId, assistantMessageId };
}

async function openFromAssistantAction(page: Page, assistantMessageId: string) {
  const assistant = page.locator(`[data-testid="chat-assistant-message"][data-message-id="${assistantMessageId}"]`);
  await assistant.hover();
  await assistant.getByRole("button", { name: "Open Side Chat" }).click();
  const panel = page.getByTestId("chat-side-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("side-chat-anchor-preview")).toHaveCount(0);
  await expect(panel).not.toContainText("From the main chat");
  return panel;
}

function sideComposerEditor(panel: Locator) {
  return panel.getByTestId("side-chat-composer").locator(".rudder-mdxeditor-content").first();
}

async function openSideChatTabContextMenu(page: Page, panel: Locator) {
  const sideChatTab = panel.locator('[data-side-panel-tab-key^="side-chat:"]');
  await sideChatTab.click({ button: "right" });
  const menu = page.getByTestId("chat-side-panel-tab-context-menu");
  await expect(menu).toBeVisible();
  return { menu, sideChatTab };
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
  const creationPayload = createResponse.request().postDataJSON() as {
    preferredAgentId?: string;
    modelOverride?: string | null;
    effortOverride?: string | null;
  };
  await expect(panel.getByTestId("side-chat-messages")).toContainText("What is the rollback trigger?", { timeout: 15_000 });
  await expect(panel.getByTestId("side-chat-streaming-reply")).toContainText("Streaming reply", { timeout: 15_000 });
  await expect(panel.getByTestId("side-chat-messages").getByTestId("chat-transcript-item")).toHaveCount(1);
  await expect(panel.getByTestId("chat-assistant-message").filter({ hasText: "Streaming reply for chat." })).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByRole("button", { name: "Done & return" })).toHaveCount(0);
  return { ...sideChat, creationPayload };
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
  const agentSelector = panel.getByTestId("side-chat-composer").getByTestId("chat-agent-selector");
  await expect(agentSelector).toContainText("Sidekick");
  await expect(panel).not.toContainText("Enter to send · Shift+Enter for a new line");
  await expect(panel.getByTestId("side-chat-anchor-preview")).toHaveCount(0);
  await expect(panel).not.toContainText("From the main chat");
  await agentSelector.click();
  const analystRow = panel.getByTestId(`chat-agent-option-${source.alternateAgent.id}`);
  await expect(analystRow.getByRole("menuitemradio")).toBeEnabled();
  await analystRow.getByRole("menuitemradio").click();
  await expect(agentSelector).toContainText("Analyst");
  const runtimeSelector = analystRow.getByTestId("chat-agent-runtime-selector");
  await expect(runtimeSelector).toBeVisible();
  await runtimeSelector.click();
  await expect(page.getByTestId("chat-agent-runtime-panel")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("side-chat-agent-runtime-draft.png"),
    fullPage: true,
  });
  await page.getByTestId("chat-model-selector").click();
  await page.getByTestId("chat-model-option-gpt-5.6-terra").click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  const sideChat = await sendFirstSideChatMessage(page, panel, source.conversationId);
  expect(sideChat.creationPayload).toMatchObject({
    preferredAgentId: source.alternateAgent.id,
    modelOverride: "gpt-5.6-terra",
    effortOverride: null,
  });

  await agentSelector.click();
  await expect(panel.getByTestId("chat-agent-lock-state")).toContainText("Bound to chat");
  await expect(
    panel
      .getByTestId(`chat-agent-option-${source.agent.id}`)
      .getByRole("menuitemradio"),
  ).toBeDisabled();
  await expect(
    panel
      .getByTestId(`chat-agent-option-${source.alternateAgent.id}`)
      .getByTestId("chat-agent-runtime-selector"),
  ).toBeVisible();
  await expect(panel.getByTestId("side-chat-agent-menu")).toBeVisible();
  await page.waitForTimeout(250);
  await page.screenshot({
    path: testInfo.outputPath(
      "side-chat-agent-locked-runtime-available.png",
    ),
    fullPage: true,
  });
  await page.keyboard.press("Escape");

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

  await page.screenshot({ path: testInfo.outputPath("04-side-chat-active.png"), fullPage: true });
  const destroyResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "DELETE"
    && response.url().includes(`/api/chats/${sideChat.id}/side-chat`)
  ));
  const { menu } = await openSideChatTabContextMenu(page, panel);
  await menu.getByRole("menuitem", { name: "Close" }).click();
  const destroyResponse = await destroyResponsePromise;
  expect(destroyResponse.ok(), await destroyResponse.text()).toBe(true);
  await expect(panel).toBeHidden();
  expect((await page.request.get(`/api/chats/${sideChat.id}`)).status()).toBe(404);
  await expect(mainComposer).toContainText("Keep this unfinished main-chat draft");
  await page.screenshot({ path: testInfo.outputPath("05-side-chat-destroyed.png"), fullPage: true });
});

test("the /side menu matches composer popovers and can move the same Side Chat to Messenger", async ({ page }, testInfo) => {
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

  const draftTab = panel.locator('[data-side-panel-tab-key^="side-chat:"]');
  await draftTab.getByRole("tab").focus();
  await page.keyboard.press("Shift+F10");
  const keyboardMenu = page.getByTestId("chat-side-panel-tab-context-menu");
  await expect(keyboardMenu).toBeVisible();
  await expect(keyboardMenu.getByRole("menuitem", { name: "Move to Messenger" })).toBeFocused();
  await expect(page.getByRole("tooltip")).toContainText("Send a message first to create this Side Chat.");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("ContextMenu");
  await expect(page.getByTestId("chat-side-panel-tab-context-menu")).toBeVisible();
  await page.keyboard.press("Escape");

  const draftTabBox = await draftTab.boundingBox();
  expect(draftTabBox).not.toBeNull();
  await draftTab.dispatchEvent("pointerdown", {
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    clientX: draftTabBox!.x + draftTabBox!.width / 2,
    clientY: draftTabBox!.y + draftTabBox!.height / 2,
  });
  await page.waitForTimeout(750);
  await expect(page.getByTestId("chat-side-panel-tab-context-menu")).toBeVisible();
  await draftTab.dispatchEvent("pointerup", { pointerType: "touch", isPrimary: true, button: 0 });
  await page.keyboard.press("Escape");

  const { menu: draftMenu } = await openSideChatTabContextMenu(page, panel);
  const disabledDraftMove = draftMenu.getByRole("menuitem", { name: "Move to Messenger" });
  await expect(disabledDraftMove).toHaveAttribute("aria-disabled", "true");
  await disabledDraftMove.hover();
  await expect(page.getByRole("tooltip")).toContainText("Send a message first to create this Side Chat.");
  await page.screenshot({ path: testInfo.outputPath("07-side-chat-draft-menu.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(draftMenu).toBeHidden();

  const sideChat = await sendFirstSideChatMessage(page, panel, source.conversationId);
  const keepResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && response.url().includes(`/api/chats/${sideChat.id}/side-chat/keep`)
  ));
  const { menu: activeMenu } = await openSideChatTabContextMenu(page, panel);
  const moveItem = activeMenu.getByRole("menuitem", { name: "Move to Messenger" });
  await expect(moveItem).not.toHaveAttribute("aria-disabled", "true");
  await moveItem.hover();
  await expect(page.getByRole("tooltip")).toContainText("Make this Side Chat a regular Messenger chat. This tab will close.");
  await page.screenshot({ path: testInfo.outputPath("08-side-chat-active-menu.png"), fullPage: true });
  await moveItem.click();
  const keepResponse = await keepResponsePromise;
  expect(keepResponse.ok(), await keepResponse.text()).toBe(true);
  expect(await keepResponse.json()).toMatchObject({
    id: sideChat.id,
    title: "Side chat from: Main strategy chat",
    messengerVisible: true,
    sideChatState: "kept",
  });
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
    conversation: {
      id: sideChat.id,
      title: "Side chat from: Main strategy chat",
      messengerVisible: true,
      sideChatState: "kept",
    },
  });

  const groups = await e2eDb
    .select()
    .from(messengerCustomGroups)
    .where(eq(messengerCustomGroups.orgId, source.organization.id));
  expect(groups).toHaveLength(1);
  expect(groups[0]).toMatchObject({
    name: "Main strategy chat",
    icon: MESSENGER_FORK_GROUP_DEFAULT_ICON,
  });
  const groupEntries = await e2eDb
    .select()
    .from(messengerCustomGroupEntries)
    .where(eq(messengerCustomGroupEntries.groupId, groups[0]!.id));
  expect(new Set(groupEntries.map((entry) => entry.threadKey))).toEqual(new Set([
    `chat:${source.conversationId}`,
    `chat:${sideChat.id}`,
  ]));
  const groupSection = page.getByTestId(`messenger-thread-section-custom-group-${groups[0]!.id}`);
  await expect(groupSection).toContainText("Main strategy chat", { timeout: 15_000 });
  await expect(groupSection).toContainText(MESSENGER_FORK_GROUP_DEFAULT_ICON);
  await expect(groupSection.getByTestId(threadTestId(`chat:${source.conversationId}`))).toBeVisible();
  await expect(groupSection.getByTestId(threadTestId(`chat:${sideChat.id}`))).toContainText(
    "Side chat from: Main strategy chat",
  );
  await page.screenshot({ path: "/tmp/rudder-side-chat-title-grouping.png", fullPage: true });

  await page.goto(`/${source.organization.issuePrefix}/messenger/chat/${sideChat.id}`);
  const sourceChatLink = page.getByRole("link", { name: "Open source chat Main strategy chat" });
  await expect(sourceChatLink).toBeVisible({ timeout: 15_000 });
  await sourceChatLink.click();
  await expect(page).toHaveURL(new RegExp(`/messenger/chat/${source.conversationId}$`));
  await expect(page.getByTestId("chat-side-panel")).toBeHidden();
  await expect(page.getByTestId("chat-assistant-message").filter({ hasText: "narrow cohort" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("10-source-chat-direct-navigation.png"), fullPage: true });
});

test("the Side Panel empty state opens the same provisional Side Chat flow", async ({ page }, testInfo) => {
  await seedSideChatSource(page, `Side-Chat-Panel-${Date.now()}`);
  await page.getByTestId("workspace-main-card").getByTestId("chat-side-panel-trigger").click();
  const panel = page.getByTestId("chat-side-panel");
  await expect(panel.getByTestId("chat-side-panel-empty-state")).toBeVisible();
  await expect(panel.getByTestId("chat-side-panel-empty-side-chat-target")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("08-side-panel-empty-state.png"), fullPage: true });

  await panel.getByTestId("chat-side-panel-empty-side-chat-target").click();
  await expect(panel.getByTestId("side-chat-panel-view")).toBeVisible();
  await expect(panel.getByTestId("side-chat-anchor-preview")).toHaveCount(0);
  await expect(panel).not.toContainText("From the main chat");
  await expect(sideComposerEditor(panel)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("09-side-panel-entry-draft.png"), fullPage: true });

  const sideChatTab = panel.locator('[data-side-panel-tab-key^="side-chat:"]');
  await sideChatTab.hover();
  await sideChatTab.getByRole("button", { name: "Close Side Chat tab" }).click();
  await expect(panel).toBeHidden();
});

test("the Side Chat tab menu and disabled explanation fit a narrow viewport", async ({ page }, testInfo) => {
  const source = await seedSideChatSource(page, `Side-Chat-Narrow-${Date.now()}`);
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = await openFromAssistantAction(page, source.assistantMessageId);
  const { menu } = await openSideChatTabContextMenu(page, panel);
  const moveItem = menu.getByRole("menuitem", { name: "Move to Messenger" });
  await expect(moveItem).toHaveAttribute("aria-disabled", "true");
  await moveItem.focus();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText("Send a message first to create this Side Chat.");
  const [menuBox, tooltipBox] = await Promise.all([menu.boundingBox(), tooltip.boundingBox()]);
  expect(menuBox).not.toBeNull();
  expect(tooltipBox).not.toBeNull();
  expect(menuBox!.x).toBeGreaterThanOrEqual(0);
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(390);
  expect(tooltipBox!.x).toBeGreaterThanOrEqual(0);
  expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("12-side-chat-narrow-menu.png"), fullPage: true });
});

test("a failed Move to Messenger keeps the Side Chat tab and can be retried", async ({ page }) => {
  const source = await seedSideChatSource(page, `Side-Chat-Move-Retry-${Date.now()}`);
  const panel = await openFromAssistantAction(page, source.assistantMessageId);
  const sideChat = await sendFirstSideChatMessage(page, panel, source.conversationId);
  let moveAttempts = 0;
  await page.route(`**/api/chats/${sideChat.id}/side-chat/keep`, async (route) => {
    moveAttempts += 1;
    if (moveAttempts === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Promotion temporarily unavailable." }),
      });
      return;
    }
    await route.continue();
  });

  const firstMenu = (await openSideChatTabContextMenu(page, panel)).menu;
  await firstMenu.getByRole("menuitem", { name: "Move to Messenger" }).click();
  await expect(page.getByText("Could not move Side Chat", { exact: true })).toBeVisible();
  await expect(page.getByText("Promotion temporarily unavailable.", { exact: true })).toBeVisible();
  await expect(panel.locator('[data-side-panel-tab-key^="side-chat:"]')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/messenger/chat/${source.conversationId}$`));

  const retryResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && response.url().includes(`/api/chats/${sideChat.id}/side-chat/keep`)
    && response.status() < 500
  ));
  const retryMenu = (await openSideChatTabContextMenu(page, panel)).menu;
  await retryMenu.getByRole("menuitem", { name: "Move to Messenger" }).click();
  const retryResponse = await retryResponsePromise;
  expect(retryResponse.ok(), await retryResponse.text()).toBe(true);
  expect(moveAttempts).toBe(2);
  await expect(page).toHaveURL(new RegExp(`/messenger/chat/${sideChat.id}$`));
  await expect(page.getByTestId("side-chat-panel-view")).toHaveCount(0);
});

test("a Side Chat expiring after its menu opens stays in place and disables Move on refresh", async ({ page }) => {
  const source = await seedSideChatSource(page, `Side-Chat-Move-Race-${Date.now()}`);
  const panel = await openFromAssistantAction(page, source.assistantMessageId);
  const sideChat = await sendFirstSideChatMessage(page, panel, source.conversationId);
  const firstMenu = (await openSideChatTabContextMenu(page, panel)).menu;
  const firstMove = firstMenu.getByRole("menuitem", { name: "Move to Messenger" });
  await expect(firstMove).not.toHaveAttribute("aria-disabled", "true");

  await e2eDb
    .update(chatConversations)
    // This test database is isolated to the Playwright run; preceding Side
    // Chats are already kept, expired, or destroyed before this active row.
    .set({ sideChatExpiresAt: new Date(Date.now() - 1_000) });
  const raceResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && response.url().includes(`/api/chats/${sideChat.id}/side-chat/keep`)
  ));
  await firstMove.click();
  const raceResponse = await raceResponsePromise;
  expect(raceResponse.status()).toBe(409);
  await expect(page.getByText("Could not move Side Chat", { exact: true })).toBeVisible();
  await expect(page.getByText("Side Chat expired", { exact: true })).toBeVisible();
  await expect(panel.locator('[data-side-panel-tab-key^="side-chat:"]')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/messenger/chat/${source.conversationId}$`));

  const refreshedMenu = (await openSideChatTabContextMenu(page, panel)).menu;
  const refreshedMove = refreshedMenu.getByRole("menuitem", { name: "Move to Messenger" });
  await expect(refreshedMove).toHaveAttribute("aria-disabled", "true");
  await refreshedMove.hover();
  await expect(page.getByRole("tooltip")).toContainText(
    "This Side Chat can no longer be moved. Close it instead.",
  );
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

  const { menu } = await openSideChatTabContextMenu(page, panel);
  const expiredMove = menu.getByRole("menuitem", { name: "Move to Messenger" });
  await expect(expiredMove).toHaveAttribute("aria-disabled", "true");
  await expiredMove.hover();
  await expect(page.getByRole("tooltip")).toContainText("This Side Chat can no longer be moved. Close it instead.");
  await page.screenshot({ path: testInfo.outputPath("11-side-chat-expired-menu.png"), fullPage: true });

  const destroyResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "DELETE"
    && response.url().includes(`/api/chats/${sideChat.id}/side-chat`)
  ));
  await menu.getByRole("menuitem", { name: "Close" }).click();
  expect((await destroyResponsePromise).ok()).toBe(true);
  expect((await page.request.get(`/api/chats/${sideChat.id}`)).status()).toBe(404);
});
