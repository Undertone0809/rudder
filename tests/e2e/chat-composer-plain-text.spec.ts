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

test("chat composer keeps normal Markdown literal while tokenizing Rudder references", async ({ page, baseURL }) => {
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

  if (baseURL) {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
  }
  await composer.press("ControlOrMeta+A");
  await composer.press("ControlOrMeta+C");
  await expect
    .poll(async () => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(`**bold** # title [plain](https://example.com) ${canonicalReference}`);

  await page.getByRole("button", { name: "Send" }).click();

  const messagesRes = await page.request.get(`/api/chats/${chat.id}/messages`);
  expect(messagesRes.ok()).toBe(true);
  const messages = await messagesRes.json() as Array<{ role: string; body: string }>;
  const userMessage = messages.find((message) => message.role === "user");
  expect(userMessage?.body).toBe(draft);
});
