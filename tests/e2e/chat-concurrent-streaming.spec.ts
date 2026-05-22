import { expect, test, type Page } from "@playwright/test";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB } from "./support/e2e-env";

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

function currentChatId(pageUrl: string) {
  const pathname = new URL(pageUrl).pathname;
  const chatId = pathname.split("/").pop();
  expect(chatId).toBeTruthy();
  return chatId!;
}

function currentOrgRoutePath(pageUrl: string, relativePath: string) {
  const segments = new URL(pageUrl).pathname.split("/").filter(Boolean);
  const first = segments[0] ?? "";
  const prefix = first && !["messenger", "issues", "chat"].includes(first) ? `/${first}` : "";
  return `${prefix}${relativePath}`;
}

async function pushSpaRoute(page: Page, path: string) {
  await page.evaluate((nextPath) => {
    window.history.pushState({}, "", nextPath);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

test("allows sending a new chat while another chat is still streaming", async ({ page }) => {
  const organization = await createStreamingOrg(page, `Concurrent-Chat-${Date.now()}`);

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/messenger/chat?agentId=${organization.chatAgent.id}`);

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

test("keeps a streaming chat visible after navigating to issue detail and back", async ({ page }) => {
  const organization = await createStreamingOrg(page, `Streaming-Route-Persistence-${Date.now()}`);
  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Issue detail route used while chat streams",
      description: "Navigating here should not drop the active chat stream.",
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json();

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/messenger/chat?agentId=${organization.chatAgent.id}`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("Keep streaming across route changes");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page).toHaveURL(/\/messenger\/chat\/[^/]+$/i, { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Stop streaming" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("chat-assistant-message").last()).toContainText("Streaming reply", {
    timeout: 15_000,
  });
  const chatId = currentChatId(page.url());
  const issuePath = currentOrgRoutePath(page.url(), `/issues/${issue.identifier ?? issue.id}`);
  const chatPath = currentOrgRoutePath(page.url(), `/messenger/chat/${chatId}`);

  await pushSpaRoute(page, issuePath);
  await expect(page).toHaveURL(new RegExp(`/issues/${issue.identifier ?? issue.id}$`, "i"), { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: issue.title })).toBeVisible({ timeout: 15_000 });

  await pushSpaRoute(page, chatPath);
  await expect(page).toHaveURL(new RegExp(`/messenger/chat/${chatId}$`, "i"), { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Stop streaming" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("chat-assistant-message").last()).toContainText("Streaming reply", {
    timeout: 15_000,
  });
});
