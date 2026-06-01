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

async function createQueuedFollowUp(page: Page, chatId: string, body: string, index: number) {
  const res = await page.request.post(`/api/chats/${chatId}/queue`, {
    data: {
      clientMutationId: `e2e:${Date.now()}:${index}`,
      expectedGenerationId: null,
      payload: {
        body,
        attachmentIds: [],
        projectId: null,
        skillRefs: [],
        accessMode: null,
        model: null,
        effort: null,
        metadata: {
          source: "e2e",
        },
      },
    },
  });
  expect(res.ok()).toBe(true);
}

test("allows sending a new chat while another chat is still streaming", async ({ page }) => {
  const organization = await createStreamingOrg(page, `Concurrent-Chat-${Date.now()}`);

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.urlKey}/messenger/chat?agentId=${organization.chatAgent.id}`);

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

test("queues a follow-up by default while the current chat is streaming", async ({ page }) => {
  const organization = await createStreamingOrg(page, `Running-Queue-${Date.now()}`);

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.urlKey}/messenger/chat?agentId=${organization.chatAgent.id}`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("Start a long running reply");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page).toHaveURL(/\/messenger\/chat\/[^/]+$/i, { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Stop streaming" })).toBeVisible({ timeout: 15_000 });
  const chatId = currentChatId(page.url());

  await composer.fill("This should be queued, not sent concurrently");
  await composer.press("Enter");
  await expect(page.getByTestId("chat-running-queue")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("chat-running-queue-item").first()).toContainText("Up next");
  await expect(page.getByTestId("chat-running-queue-item").first()).toContainText("This should be queued");

  const queueRes = await page.request.get(`/api/chats/${chatId}/queue`);
  expect(queueRes.ok()).toBe(true);
  const queue = await queueRes.json();
  expect(queue.items).toHaveLength(1);
  expect(queue.items[0].payload.body).toBe("This should be queued, not sent concurrently");

  await page.getByTestId("chat-running-queue-item").first().getByRole("button", { name: "Edit queued message" }).click();
  await page.getByTestId("chat-running-queue-edit").fill("This queued follow-up was edited in place");
  await page.getByTestId("chat-running-queue-item").first().getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("chat-running-queue-item").first()).toContainText("This queued follow-up was edited in place", {
    timeout: 15_000,
  });

  const editedQueueRes = await page.request.get(`/api/chats/${chatId}/queue`);
  expect(editedQueueRes.ok()).toBe(true);
  const editedQueue = await editedQueueRes.json();
  expect(editedQueue.items).toHaveLength(1);
  expect(editedQueue.items[0].id).toBe(queue.items[0].id);
  expect(editedQueue.items[0].payload.body).toBe("This queued follow-up was edited in place");

  await page.getByTestId("chat-running-queue-item").first().getByRole("button", { name: "Steer" }).click();
  await expect(page.getByTestId("chat-running-queue-item").first()).toContainText("Still queued", { timeout: 15_000 });

  const steeredQueueRes = await page.request.get(`/api/chats/${chatId}/queue`);
  expect(steeredQueueRes.ok()).toBe(true);
  const steeredQueue = await steeredQueueRes.json();
  expect(steeredQueue.items[0].lastDeliveryReason).toBe("unsupported");

  await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: "This queued follow-up was edited in place" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("chat-running-queue")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("chat-assistant-message").filter({ hasText: "Streaming reply for chat." })).toHaveCount(2, {
    timeout: 30_000,
  });

  const finalQueueRes = await page.request.get(`/api/chats/${chatId}/queue`);
  expect(finalQueueRes.ok()).toBe(true);
  const finalQueue = await finalQueueRes.json();
  expect(finalQueue.items).toHaveLength(0);
});

test("keeps queued follow-ups parked after stopping the running reply", async ({ page }) => {
  const organization = await createStreamingOrg(page, `Running-Queue-Stop-${Date.now()}`);

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.urlKey}/messenger/chat?agentId=${organization.chatAgent.id}`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("Start a reply that will be stopped");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page).toHaveURL(/\/messenger\/chat\/[^/]+$/i, { timeout: 15_000 });
  const chatId = currentChatId(page.url());
  await expect(page.getByRole("button", { name: "Stop streaming" })).toBeVisible({ timeout: 15_000 });

  await createQueuedFollowUp(page, chatId, "This should stay parked after stop", 1);
  await createQueuedFollowUp(page, chatId, "Second parked follow-up", 2);
  await createQueuedFollowUp(page, chatId, "Third parked follow-up", 3);
  await expect(page.getByTestId("chat-running-queue")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("chat-running-queue-item")).toHaveCount(3, { timeout: 15_000 });
  await expect(page.getByTestId("chat-running-queue")).not.toContainText("more queued follow-ups");
  await expect(page.getByTestId("chat-running-queue-item").nth(0)).toContainText("Up next");
  await expect(page.getByTestId("chat-running-queue-item").nth(1)).toContainText("#2");
  await expect(page.getByTestId("chat-running-queue-item").nth(2)).toContainText("#3");
  await expect(page.getByTestId("chat-running-queue-item").nth(2)).toContainText("Third parked follow-up");

  await page.getByRole("button", { name: "Stop streaming" }).click();
  await expect(page.getByRole("button", { name: "Stop streaming" })).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId("chat-running-queue")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("chat-running-queue")).toContainText("Queued follow-ups retained");
  await expect(page.getByTestId("chat-running-queue-item").first()).toContainText("This should stay parked after stop");
  await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: "This should stay parked after stop" })).toHaveCount(0);

  const queueRes = await page.request.get(`/api/chats/${chatId}/queue`);
  expect(queueRes.ok()).toBe(true);
  const queue = await queueRes.json();
  expect(queue.items).toHaveLength(3);
  expect(queue.items[0].payload.body).toBe("This should stay parked after stop");
  expect(queue.items[1].payload.body).toBe("Second parked follow-up");
  expect(queue.items[2].payload.body).toBe("Third parked follow-up");
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

  await page.goto(`/${organization.urlKey}/messenger/chat?agentId=${organization.chatAgent.id}`);

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
  await expect(page.getByTestId("chat-assistant-message").last()).toContainText("Streaming reply", {
    timeout: 15_000,
  });
});
