import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq } from "../../packages/db/node_modules/drizzle-orm/index.js";
import {
  agents,
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

async function createOrganization(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json() as Promise<{ id: string; issuePrefix: string }>;
}

async function configureFastTitleProfile(page: Page, orgId: string, title: string) {
  const profileRes = await page.request.put(`/api/orgs/${orgId}/intelligence-profiles/lightweight`, {
    data: {
      agentRuntimeType: "process",
      agentRuntimeConfig: {
        command: "node",
        args: ["-e", `process.stdout.write(${JSON.stringify(title)})`],
      },
      status: "configured",
    },
  });
  expect(profileRes.ok()).toBe(true);
}

function threadTestId(threadKey: string) {
  return `messenger-thread-${threadKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

async function seedForkableChatSource(page: Page, input: {
  orgId: string;
  title: string;
  agentName: string;
  userBody: string;
  assistantBody: string;
}) {
  const agent = await createE2EChatAgent(page.request, input.orgId, {
    name: input.agentName,
    command: E2E_CODEX_STUB,
  }) as { id: string };
  const sourceConversationId = randomUUID();
  const sourceMessageIds = [randomUUID(), randomUUID()];
  await e2eDb.insert(chatConversations).values({
    id: sourceConversationId,
    orgId: input.orgId,
    title: input.title,
    preferredAgentId: agent.id,
    issueCreationMode: "manual_approval",
    planMode: false,
    createdByUserId: "local-board",
    lastMessageAt: new Date("2026-06-22T10:02:00.000Z"),
    createdAt: new Date("2026-06-22T10:00:00.000Z"),
    updatedAt: new Date("2026-06-22T10:02:00.000Z"),
  });
  await e2eDb.insert(chatMessages).values([
    {
      id: sourceMessageIds[0],
      orgId: input.orgId,
      conversationId: sourceConversationId,
      role: "user",
      kind: "message",
      status: "completed",
      body: input.userBody,
      createdAt: new Date("2026-06-22T10:01:00.000Z"),
      updatedAt: new Date("2026-06-22T10:01:00.000Z"),
    },
    {
      id: sourceMessageIds[1],
      orgId: input.orgId,
      conversationId: sourceConversationId,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: input.assistantBody,
      replyingAgentId: agent.id,
      createdAt: new Date("2026-06-22T10:02:00.000Z"),
      updatedAt: new Date("2026-06-22T10:02:00.000Z"),
    },
  ]);
  return { sourceConversationId, sourceMessageIds };
}

async function openOrganizationChat(page: Page, organization: { id: string; issuePrefix: string }, conversationId: string) {
  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${conversationId}`);
}

async function forkFromAssistantMessage(page: Page, conversationId: string, messageId: string) {
  const sourceAssistant = page.locator(`[data-testid="chat-assistant-message"][data-message-id="${messageId}"]`);
  await expect(sourceAssistant).toBeVisible({ timeout: 15_000 });
  await sourceAssistant.hover();
  await expect(sourceAssistant.getByRole("button", { name: "Fork from here" })).toBeVisible();
  const forkResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().includes(`/api/chats/${conversationId}/fork`),
  );
  await sourceAssistant.getByRole("button", { name: "Fork from here" }).click();
  const forkResponse = await forkResponsePromise;
  expect(forkResponse.ok()).toBe(true);
  const forkedConversation = await forkResponse.json() as { id: string };
  await expect(page).toHaveURL(new RegExp(`/messenger/chat/${forkedConversation.id}$`));
  return forkedConversation;
}

async function sendFirstForkMessage(page: Page, message: string) {
  const composer = page.getByTestId("chat-composer-editor-scroll").locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.click();
  await page.keyboard.insertText(message);
  const sendButton = page.getByRole("button", { name: "Send" });
  await expect(sendButton).toBeEnabled({ timeout: 15_000 });
  await sendButton.click();
}

async function expectChatTitle(page: Page, chatId: string, title: string) {
  await expect.poll(async () => {
    const chatRes = await page.request.get(`/api/chats/${chatId}`);
    expect(chatRes.ok()).toBe(true);
    return (await chatRes.json() as { title: string }).title;
  }, {
    timeout: 20_000,
  }).toBe(title);
  await expect(page.getByTestId(threadTestId(`chat:${chatId}`))).toContainText(title, { timeout: 15_000 });
}

test("forks a chat from a selected message and groups the fork family in Messenger", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("rudder.theme", "dark");
  });

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Chat-Fork-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const sourceConversationId = randomUUID();
  const sourceMessageIds = [randomUUID(), randomUUID(), randomUUID()];
  const agentId = randomUUID();
  await e2eDb.insert(agents).values({
    id: agentId,
    orgId: organization.id,
    name: "Autumn",
    role: "operator_assistant",
    icon: "notionists-neutral",
    status: "idle",
  });
  await e2eDb.insert(chatConversations).values({
    id: sourceConversationId,
    orgId: organization.id,
    title: "Forkable strategy chat",
    issueCreationMode: "manual_approval",
    planMode: false,
    createdByUserId: "local-board",
    lastMessageAt: new Date("2026-06-22T08:03:00.000Z"),
    createdAt: new Date("2026-06-22T08:00:00.000Z"),
    updatedAt: new Date("2026-06-22T08:03:00.000Z"),
  });
  await e2eDb.insert(chatMessages).values([
    {
      id: sourceMessageIds[0],
      orgId: organization.id,
      conversationId: sourceConversationId,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Original premise",
      createdAt: new Date("2026-06-22T08:01:00.000Z"),
      updatedAt: new Date("2026-06-22T08:01:00.000Z"),
    },
    {
      id: sourceMessageIds[1],
      orgId: organization.id,
      conversationId: sourceConversationId,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Middle branch point",
      replyingAgentId: agentId,
      createdAt: new Date("2026-06-22T08:02:00.000Z"),
      updatedAt: new Date("2026-06-22T08:02:00.000Z"),
    },
    {
      id: sourceMessageIds[2],
      orgId: organization.id,
      conversationId: sourceConversationId,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Later context that should stay out",
      createdAt: new Date("2026-06-22T08:03:00.000Z"),
      updatedAt: new Date("2026-06-22T08:03:00.000Z"),
    },
  ]);

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${sourceConversationId}`);

  const sourceUser = page.locator(`[data-testid="chat-user-message"][data-message-id="${sourceMessageIds[0]}"]`);
  await expect(sourceUser).toContainText("Original premise", { timeout: 15_000 });
  await sourceUser.hover();
  await expect(sourceUser.getByRole("button", { name: "Fork from here" })).toHaveCount(0);

  const sourceAssistant = page.locator(`[data-testid="chat-assistant-message"][data-message-id="${sourceMessageIds[1]}"]`);
  await expect(sourceAssistant).toContainText("Middle branch point", { timeout: 15_000 });
  await sourceAssistant.hover();
  await expect(sourceAssistant.getByRole("button", { name: "Fork from here" })).toBeVisible();
  const forkResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().includes(`/api/chats/${sourceConversationId}/fork`),
  );
  await sourceAssistant.getByRole("button", { name: "Fork from here" }).click();
  const forkResponse = await forkResponsePromise;
  expect(forkResponse.ok()).toBe(true);
  const forkedConversation = await forkResponse.json() as {
    id: string;
    lastMessageAt: string | null;
    forkedFromConversationId: string | null;
    forkedFromMessageId: string | null;
    forkRootConversationId: string | null;
  };

  expect(forkedConversation.forkedFromConversationId).toBe(sourceConversationId);
  expect(forkedConversation.forkedFromMessageId).toBe(sourceMessageIds[1]);
  expect(forkedConversation.forkRootConversationId).toBe(sourceConversationId);
  expect(Date.parse(forkedConversation.lastMessageAt ?? "")).toBeGreaterThan(Date.parse("2026-06-22T08:03:00.000Z"));
  await expect(page).toHaveURL(new RegExp(`/messenger/chat/${forkedConversation.id}$`));
  await expect(page.getByTestId("chat-messages-content")).toContainText("Original premise");
  await expect(page.getByTestId("chat-messages-content")).toContainText("Middle branch point");
  await expect(page.getByTestId("chat-assistant-message").filter({ hasText: "Middle branch point" })).toContainText("Autumn");
  await expect(page.getByTestId("chat-messages-content")).not.toContainText("Later context that should stay out");

  const messagesRes = await page.request.get(`/api/chats/${forkedConversation.id}/messages`);
  expect(messagesRes.ok()).toBe(true);
  const forkMessages = await messagesRes.json() as Array<{ role: string; body: string }>;
  expect(forkMessages.map((message) => message.body).slice(0, 2)).toEqual([
    "Original premise",
    "Middle branch point",
  ]);
  expect(forkMessages[2]?.body).toContain("[Forkable strategy chat]");
  expect(forkMessages[2]?.body).toContain(`message ${sourceMessageIds[1]}`);

  await page.goto(`/${organization.issuePrefix}/messenger`);
  await expect(page.getByTestId(threadTestId(`chat:${sourceConversationId}`))).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId(threadTestId(`chat:${forkedConversation.id}`))).toBeVisible({ timeout: 15_000 });

  const groups = await e2eDb
    .select()
    .from(messengerCustomGroups)
    .where(eq(messengerCustomGroups.orgId, organization.id));
  expect(groups).toHaveLength(1);
  expect(groups[0]?.name).toContain("Forkable strategy chat");
  expect(groups[0]?.icon).toBe(MESSENGER_FORK_GROUP_DEFAULT_ICON);
  await expect(page.getByTestId(`messenger-thread-section-custom-group-${groups[0]!.id}`)).toContainText(MESSENGER_FORK_GROUP_DEFAULT_ICON);
  const groupEntries = await e2eDb
    .select()
    .from(messengerCustomGroupEntries)
    .where(eq(messengerCustomGroupEntries.groupId, groups[0]!.id));
  expect(new Set(groupEntries.map((entry) => entry.threadKey))).toEqual(new Set([
    `chat:${forkedConversation.id}`,
    `chat:${sourceConversationId}`,
  ]));
});

test("forks from an earlier assistant message while a later reply is streaming", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("rudder.theme", "dark");
  });

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Chat-Fork-Streaming-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };
  const chatAgent = await createE2EChatAgent(page.request, organization.id, {
    name: "Autumn",
    command: E2E_CODEX_STUB,
  });

  const sourceConversationId = randomUUID();
  const sourceMessageIds = [randomUUID(), randomUUID()];
  await e2eDb.insert(chatConversations).values({
    id: sourceConversationId,
    orgId: organization.id,
    title: "Forkable streaming chat",
    preferredAgentId: chatAgent.id,
    issueCreationMode: "manual_approval",
    planMode: false,
    createdByUserId: "local-board",
    lastMessageAt: new Date("2026-06-22T09:02:00.000Z"),
    createdAt: new Date("2026-06-22T09:00:00.000Z"),
    updatedAt: new Date("2026-06-22T09:02:00.000Z"),
  });
  await e2eDb.insert(chatMessages).values([
    {
      id: sourceMessageIds[0],
      orgId: organization.id,
      conversationId: sourceConversationId,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Stable premise before streaming",
      createdAt: new Date("2026-06-22T09:01:00.000Z"),
      updatedAt: new Date("2026-06-22T09:01:00.000Z"),
    },
    {
      id: sourceMessageIds[1],
      orgId: organization.id,
      conversationId: sourceConversationId,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Earlier completed branch point",
      replyingAgentId: chatAgent.id,
      createdAt: new Date("2026-06-22T09:02:00.000Z"),
      updatedAt: new Date("2026-06-22T09:02:00.000Z"),
    },
  ]);

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${sourceConversationId}`);

  const sourceAssistant = page.locator(`[data-testid="chat-assistant-message"][data-message-id="${sourceMessageIds[1]}"]`);
  await expect(sourceAssistant).toContainText("Earlier completed branch point", { timeout: 15_000 });

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("Later prompt that is still running");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Stop streaming" })).toBeVisible({ timeout: 15_000 });

  await sourceAssistant.scrollIntoViewIfNeeded();
  await sourceAssistant.hover();
  await expect(sourceAssistant.getByRole("button", { name: "Fork from here" })).toBeVisible();
  const forkResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().includes(`/api/chats/${sourceConversationId}/fork`),
  );
  await sourceAssistant.getByRole("button", { name: "Fork from here" }).click();
  const forkResponse = await forkResponsePromise;
  expect(forkResponse.ok()).toBe(true);
  const forkedConversation = await forkResponse.json() as {
    id: string;
    forkedFromConversationId: string | null;
    forkedFromMessageId: string | null;
    forkRootConversationId: string | null;
  };

  expect(forkedConversation.forkedFromConversationId).toBe(sourceConversationId);
  expect(forkedConversation.forkedFromMessageId).toBe(sourceMessageIds[1]);
  expect(forkedConversation.forkRootConversationId).toBe(sourceConversationId);
  await expect(page).toHaveURL(new RegExp(`/messenger/chat/${forkedConversation.id}$`));
  await expect(page.getByTestId("chat-messages-content")).toContainText("Stable premise before streaming");
  await expect(page.getByTestId("chat-messages-content")).toContainText("Earlier completed branch point");
  await expect(page.getByTestId("chat-messages-content")).not.toContainText("Later prompt that is still running");
  await expect(page.getByTestId("chat-messages-content")).not.toContainText("Streaming reply for chat.");

  const messagesRes = await page.request.get(`/api/chats/${forkedConversation.id}/messages`);
  expect(messagesRes.ok()).toBe(true);
  const forkMessages = await messagesRes.json() as Array<{ role: string; body: string }>;
  expect(forkMessages.map((message) => message.body).slice(0, 2)).toEqual([
    "Stable premise before streaming",
    "Earlier completed branch point",
  ]);
  expect(forkMessages.some((message) => message.body.includes("Later prompt that is still running"))).toBe(false);
  expect(forkMessages.some((message) => message.body.includes("Streaming reply for chat."))).toBe(false);
});

test("retitles a forked chat from the first new user message when Fast Intelligence is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("rudder.theme", "dark");
  });

  const organization = await createOrganization(page, `Chat-Fork-Title-Fallback-${Date.now()}`);
  const source = await seedForkableChatSource(page, {
    orgId: organization.id,
    title: "Inherited fallback source title",
    agentName: "Fork Title Fallback Agent",
    userBody: "Original fallback fork premise",
    assistantBody: "Use this fallback branch point",
  });

  await openOrganizationChat(page, organization, source.sourceConversationId);
  await expect(page.getByTestId("chat-messages-content")).toContainText("Use this fallback branch point", { timeout: 15_000 });
  const forkedConversation = await forkFromAssistantMessage(page, source.sourceConversationId, source.sourceMessageIds[1]!);
  await expect(page.getByTestId(threadTestId(`chat:${forkedConversation.id}`))).toContainText("Inherited fallback source title", { timeout: 15_000 });

  const firstForkMessage = "Draft a branch-specific launch checklist";
  await sendFirstForkMessage(page, firstForkMessage);

  await expectChatTitle(page, forkedConversation.id, firstForkMessage);
});

test("uses Fast Intelligence to retitle a forked chat from the first new user message", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("rudder.theme", "dark");
  });

  const organization = await createOrganization(page, `Chat-Fork-Title-AI-${Date.now()}`);
  await configureFastTitleProfile(page, organization.id, "AI fork pricing title");
  const source = await seedForkableChatSource(page, {
    orgId: organization.id,
    title: "Inherited AI source title",
    agentName: "Fork Title AI Agent",
    userBody: "Original AI fork premise",
    assistantBody: "Use this AI branch point",
  });

  await openOrganizationChat(page, organization, source.sourceConversationId);
  await expect(page.getByTestId("chat-messages-content")).toContainText("Use this AI branch point", { timeout: 15_000 });
  const forkedConversation = await forkFromAssistantMessage(page, source.sourceConversationId, source.sourceMessageIds[1]!);
  await expect(page.getByTestId(threadTestId(`chat:${forkedConversation.id}`))).toContainText("Inherited AI source title", { timeout: 15_000 });

  await sendFirstForkMessage(page, "Explore a pricing branch for agency teams");

  await expectChatTitle(page, forkedConversation.id, "AI fork pricing title");
});
