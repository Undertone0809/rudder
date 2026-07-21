import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  agentIntegrationChatBindings,
  agentIntegrations,
  chatConversations,
  chatMessages,
  createDb,
  organizationSecrets,
} from "../../packages/db/src/index.ts";
import { E2E_CODEX_STUB, E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

async function createOrganization(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json() as Promise<{ id: string; issuePrefix: string }>;
}

async function createChatAgent(page: Page, orgId: string) {
  const agentRes = await page.request.post(`/api/orgs/${orgId}/agents`, {
    data: {
      name: "Messenger Chat Agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        model: "gpt-5.4",
        command: E2E_CODEX_STUB,
      },
    },
  });
  expect(agentRes.ok()).toBe(true);
  return agentRes.json() as Promise<{ id: string }>;
}

async function createChat(_page: Page, orgId: string, title: string, preferredAgentId?: string) {
  const id = randomUUID();
  await e2eDb.insert(chatConversations).values({
    id,
    orgId,
    title,
    preferredAgentId: preferredAgentId ?? null,
    issueCreationMode: "manual_approval",
    planMode: false,
  });
  return { id, title };
}

async function createDefaultTitleChat(page: Page, orgId: string, preferredAgentId: string) {
  return createChat(page, orgId, "New chat", preferredAgentId);
}

async function configureFastTitleProfile(page: Page, orgId: string, title = "Generated sidebar title") {
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

test.describe("Messenger chat title regeneration", () => {
  test("uses the first user message as the visible default title", async ({ page }) => {
    const organization = await createOrganization(page, `Chat-Title-Default-${Date.now()}`);
    const agent = await createChatAgent(page, organization.id);
    const chat = await createDefaultTitleChat(page, organization.id, agent.id);
    const firstUserMessage = "Plan the release checklist from this chat";

    const sendRes = await page.request.post(`/api/chats/${chat.id}/messages`, {
      data: { body: firstUserMessage },
    });
    expect(sendRes.ok()).toBe(true);

    await expect.poll(async () => {
      const chatRes = await page.request.get(`/api/chats/${chat.id}`);
      expect(chatRes.ok()).toBe(true);
      return (await chatRes.json() as { title: string }).title;
    }).toBe(firstUserMessage);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);
    const threadRow = page.getByTestId(`messenger-thread-chat-${chat.id}`);
    await expect(threadRow).toContainText(firstUserMessage, { timeout: 15_000 });
    await expect(threadRow).not.toContainText("New chat");
  });

  test("shows title regeneration only when Fast Intelligence is configured", async ({ page }) => {
    const organization = await createOrganization(page, `Chat-Title-Regenerate-${Date.now()}`);
    const chat = await createChat(page, organization.id, "Old planning title");

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);
    const threadRow = page.getByTestId(`messenger-thread-chat-${chat.id}`);
    await expect(threadRow).toBeVisible({ timeout: 15_000 });
    await threadRow.hover();
    await threadRow.getByRole("button", { name: "Chat actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Regenerate title" })).toBeHidden();

    await configureFastTitleProfile(page, organization.id);

    await page.reload();
    await expect(threadRow).toBeVisible({ timeout: 15_000 });
    await threadRow.hover();
    await threadRow.getByRole("button", { name: "Chat actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Regenerate title" })).toBeVisible();
  });

  test("regenerates the visible title from a long chat with more than five user messages", async ({ page }) => {
    const organization = await createOrganization(page, `Chat-Title-Regenerate-Click-${Date.now()}`);
    const agent = await createChatAgent(page, organization.id);
    const chat = await createChat(page, organization.id, "Old sidebar title", agent.id);
    const startedAt = new Date("2026-07-21T08:00:00.000Z").getTime();
    await e2eDb.insert(chatMessages).values([
      ...Array.from({ length: 7 }, (_, index) => ({
        id: randomUUID(),
        orgId: organization.id,
        conversationId: chat.id,
        role: "user" as const,
        kind: "message" as const,
        status: "completed" as const,
        body: index === 6
          ? `LATEST_USER_BEGIN <|fim_prefix|> <|endoftext|> <|endofprompt|> ${"发布计划与回归检查 ".repeat(500)} LATEST_USER_END`
          : `User title context ${index + 1}`,
        createdAt: new Date(startedAt + index * 1_000),
        updatedAt: new Date(startedAt + index * 1_000),
      })),
      {
        id: randomUUID(),
        orgId: organization.id,
        conversationId: chat.id,
        role: "assistant",
        kind: "message",
        status: "completed",
        body: "Assistant title noise must not be selected.",
        createdAt: new Date(startedAt + 8_000),
        updatedAt: new Date(startedAt + 8_000),
      },
    ]);
    await configureFastTitleProfile(page, organization.id);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);
    const threadRow = page.getByTestId(`messenger-thread-chat-${chat.id}`);
    await expect(threadRow).toContainText("Old sidebar title", { timeout: 15_000 });
    await threadRow.hover();
    await threadRow.getByRole("button", { name: "Chat actions" }).click();
    const regenerateResponse = page.waitForResponse((response) =>
      response.url().includes(`/api/chats/${chat.id}/title/regenerate`)
        && response.request().method() === "POST",
    );
    await page.getByRole("menuitem", { name: "Regenerate title" }).click();
    expect((await regenerateResponse).ok()).toBe(true);

    await expect(threadRow).toContainText("Generated sidebar title", { timeout: 15_000 });
  });

  test("supports Feishu-bound chat title actions while keeping destructive local actions hidden", async ({ page }) => {
    const organization = await createOrganization(page, `Feishu-Title-Regenerate-${Date.now()}`);
    const agent = await createChatAgent(page, organization.id);
    await configureFastTitleProfile(page, organization.id, "Generated Feishu sidebar title");

    const conversationId = randomUUID();
    const integrationId = randomUUID();
    const secretId = randomUUID();
    const externalChatId = `oc_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    await e2eDb.insert(organizationSecrets).values({
      id: secretId,
      orgId: organization.id,
      name: `Feishu credentials ${secretId}`,
      provider: "local_encrypted",
    });
    await e2eDb.insert(agentIntegrations).values({
      id: integrationId,
      orgId: organization.id,
      agentId: agent.id,
      provider: "feishu",
      status: "active",
      transport: "long_connection",
      providerRegion: "feishu_cn",
      appCredentialSecretId: secretId,
      externalAppId: `cli_${randomUUID().replace(/-/g, "")}`,
      externalBotOpenId: "ou_feishu_title_bot",
    });
    await e2eDb.insert(chatConversations).values({
      id: conversationId,
      orgId: organization.id,
      title: "hi",
      summary: "A Feishu-origin chat that should be locally read-only except for Rudder title generation.",
      issueCreationMode: "manual_approval",
      planMode: false,
      preferredAgentId: agent.id,
      lastMessageAt: new Date("2026-07-09T08:30:00.000Z"),
      createdAt: new Date("2026-07-09T08:00:00.000Z"),
      updatedAt: new Date("2026-07-09T08:30:00.000Z"),
    });
    await e2eDb.insert(chatMessages).values({
      id: randomUUID(),
      orgId: organization.id,
      conversationId,
      role: "user",
      kind: "message",
      status: "completed",
      body: "hi, what skill do you have?",
      createdAt: new Date("2026-07-09T08:30:00.000Z"),
      updatedAt: new Date("2026-07-09T08:30:00.000Z"),
    });
    await e2eDb.insert(agentIntegrationChatBindings).values({
      orgId: organization.id,
      integrationId,
      conversationId,
      externalChatId,
      externalChatType: "p2p",
    });

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat/${conversationId}`, { waitUntil: "domcontentloaded" });
    const threadRow = page.getByTestId(`messenger-thread-chat-${conversationId}`);
    await expect(threadRow).toContainText("hi", { timeout: 15_000 });
    await expect(threadRow.getByTestId(`messenger-source-badge-chat-${conversationId}`)).toHaveText("Feishu");

    await threadRow.hover();
    await threadRow.getByRole("button", { name: "Chat actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Archive" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Delete" })).toHaveCount(0);
    const renameResponse = page.waitForResponse((response) =>
      response.url().includes(`/api/chats/${conversationId}`)
        && !response.url().includes("/title/regenerate")
        && response.request().method() === "PATCH",
    );
    await page.getByRole("menuitem", { name: "Rename" }).click();
    const renameInput = threadRow.locator("input");
    await expect(renameInput).toBeVisible();
    await renameInput.fill("Renamed Feishu sidebar title");
    await renameInput.press("Enter");
    expect((await renameResponse).ok()).toBe(true);
    await expect(threadRow).toContainText("Renamed Feishu sidebar title", { timeout: 15_000 });

    await threadRow.hover();
    await threadRow.getByRole("button", { name: "Chat actions" }).click();
    const regenerateResponse = page.waitForResponse((response) =>
      response.url().includes(`/api/chats/${conversationId}/title/regenerate`)
        && response.request().method() === "POST",
    );
    await page.getByRole("menuitem", { name: "Regenerate title" }).click();
    expect((await regenerateResponse).ok()).toBe(true);

    await expect(threadRow).toContainText("Generated Feishu sidebar title", { timeout: 15_000 });
    const chatRes = await page.request.get(`/api/chats/${conversationId}`);
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json() as { title: string; mutability: string; sourceMetadata: unknown | null };
    expect(chat.title).toBe("Generated Feishu sidebar title");
    expect(chat.mutability).toBe("external_bound_chat");
    expect(chat.sourceMetadata).toMatchObject({ source: "agent_integration", provider: "feishu" });
  });
});
