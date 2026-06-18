import { expect, test, type Page } from "@playwright/test";
import { E2E_CODEX_STUB } from "./support/e2e-env";

async function createOrganization(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `${name}-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json() as Promise<{ id: string; issuePrefix: string }>;
}

async function createChatAgent(page: Page, orgId: string, name: string) {
  const agentRes = await page.request.post(`/api/orgs/${orgId}/agents`, {
    data: {
      name,
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        model: "gpt-5.4",
        command: E2E_CODEX_STUB,
      },
    },
  });
  expect(agentRes.ok()).toBe(true);
  return agentRes.json() as Promise<{ id: string; name: string }>;
}

test("chat composer keeps normal Markdown literal while tokenizing Rudder references", async ({ page }) => {
  const organization = await createOrganization(page, "Chat-Plain-Text");
  const agent = await createChatAgent(page, organization.id, "Copy Agent");

  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Plain composer",
      preferredAgentId: agent.id,
    },
  });
  expect(chatRes.ok()).toBe(true);
  const chat = await chatRes.json() as { id: string };

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });

  const canonicalReference = `[${agent.name}](agent://${agent.id})`;
  const draft = `**bold** # title [plain](https://example.com) ${canonicalReference}`;
  await composer.fill(draft);

  await expect(composer).toContainText("**bold** # title [plain](https://example.com)");
  await expect(composer.locator("strong")).toHaveCount(0);
  await expect(composer.locator("h1, h2, h3, h4, h5, h6")).toHaveCount(0);
  await expect(composer.locator('a[href="https://example.com"]')).toHaveCount(0);
  const token = composer.locator("[data-mention-kind='agent']").filter({ hasText: agent.name }).first();
  await expect(token).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Send" }).click();

  const userBubble = page.getByTestId("chat-user-message-bubble").last();
  await expect(userBubble).toContainText("**bold** # title plain", { timeout: 15_000 });
  await expect(userBubble.locator("strong")).toHaveCount(0);
  await expect(userBubble.locator("h1, h2, h3, h4, h5, h6")).toHaveCount(0);
  await expect(userBubble.locator('a[href="https://example.com"]')).toHaveCount(1);
  await expect(userBubble).toContainText(agent.name);

  const messagesRes = await page.request.get(`/api/chats/${chat.id}/messages`);
  expect(messagesRes.ok()).toBe(true);
  const messages = await messagesRes.json() as Array<{ role: string; body: string }>;
  const userMessage = messages.find((message) => message.role === "user");
  expect(userMessage?.body).toBe(draft);
});

test("chat composer keeps the caret outside Rudder reference tokens", async ({ page }) => {
  const organization = await createOrganization(page, "Chat-Reference-Caret");
  const agent = await createChatAgent(page, organization.id, "原则");

  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Reference caret",
      preferredAgentId: agent.id,
    },
  });
  expect(chatRes.ok()).toBe(true);
  const chat = await chatRes.json() as { id: string };

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });

  const canonicalReference = `[${agent.name}](agent://${agent.id})`;
  await composer.fill(`请参考 ${canonicalReference} 后续计划`);

  const token = composer.locator("[data-mention-kind='agent']").filter({ hasText: agent.name }).first();
  await expect(token).toBeVisible({ timeout: 15_000 });

  const selectionState = await token.evaluate((element) => {
    const textNode = Array.from(element.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
    if (!textNode) return { ok: false, reason: "missing token text" };

    const range = document.createRange();
    range.setStart(textNode, 1);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));

    const parent = element.parentNode;
    const tokenIndex = parent ? Array.prototype.indexOf.call(parent.childNodes, element) : -1;
    return {
      ok: selection?.anchorNode === parent && selection.anchorOffset === tokenIndex + 1,
      anchorInsideToken: selection?.anchorNode ? element.contains(selection.anchorNode) : null,
      anchorOffset: selection?.anchorOffset ?? null,
      tokenIndex,
    };
  });

  expect(selectionState).toMatchObject({
    ok: true,
    anchorInsideToken: false,
  });
});

test("chat composer keeps text after Rudder reference tokens when sending", async ({ page }) => {
  const organization = await createOrganization(page, "Chat-Reference-Tail");
  const agent = await createChatAgent(page, organization.id, "Mira");

  const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
    data: {
      name: "Rudder Release",
      description: "Release planning context",
    },
  });
  expect(projectRes.ok()).toBe(true);
  const project = await projectRes.json() as { id: string; name: string };

  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Reference tail",
      preferredAgentId: agent.id,
    },
  });
  expect(chatRes.ok()).toBe(true);
  const chat = await chatRes.json() as { id: string };

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });

  const projectReference = `[${project.name}](project://${project.id})`;
  const agentReference = `[${agent.name}](agent://${agent.id})`;
  const draft = `你需要结合 ${projectReference} 项目中的 issue 发版计划，优化一下 PRD roadmap，并让 ${agentReference} 继续跟进。`;
  await composer.fill(draft);

  await expect(composer).toContainText("你需要结合");
  await expect(composer.locator("[data-mention-kind='project']").filter({ hasText: project.name })).toBeVisible();
  await expect(composer.locator("[data-mention-kind='agent']").filter({ hasText: agent.name })).toBeVisible();
  await expect(composer).toContainText("项目中的 issue 发版计划，优化一下 PRD roadmap，并让");
  await expect(composer).toContainText("继续跟进。");

  await page.getByRole("button", { name: "Send" }).click();

  const userBubble = page.getByTestId("chat-user-message-bubble").last();
  await expect(userBubble).toContainText("你需要结合", { timeout: 15_000 });
  await expect(userBubble).toContainText(project.name);
  await expect(userBubble).toContainText("项目中的 issue 发版计划，优化一下 PRD roadmap，并让");
  await expect(userBubble).toContainText(agent.name);
  await expect(userBubble).toContainText("继续跟进。");

  const messagesRes = await page.request.get(`/api/chats/${chat.id}/messages`);
  expect(messagesRes.ok()).toBe(true);
  const messages = await messagesRes.json() as Array<{ role: string; body: string }>;
  const userMessage = messages.find((message) => message.role === "user");
  expect(userMessage?.body).toBe(draft);
});
