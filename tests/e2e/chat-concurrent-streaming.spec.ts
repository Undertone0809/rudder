import { expect, test, type Page } from "@playwright/test";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_APP_SERVER_STUB, E2E_CODEX_STUB } from "./support/e2e-env";

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

async function createQueuedMessage(page: Page, chatId: string, body: string, index: number) {
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

async function setPlanMode(page: Page, enabled: boolean) {
  const menuButton = page.getByRole("button", { name: "Add files and options" });
  await menuButton.click();
  const toggle = page.getByRole("switch", { name: "Plan mode" });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", String(!enabled));
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(enabled));
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveCount(0);
}

function assertForbiddenQueueCopy(page: Page) {
  return Promise.all([
    expect(page.getByText("Needs attention", { exact: true })).toHaveCount(0),
    expect(page.getByText("Restarting with feedback", { exact: true })).toHaveCount(0),
    expect(page.getByText("Running feedback", { exact: true })).toHaveCount(0),
    expect(page.getByText("Delivery unconfirmed", { exact: true })).toHaveCount(0),
    expect(page.getByText("Added to Queue.", { exact: true })).toHaveCount(0),
  ]);
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

test("adds a composer message to Queue while the current chat is streaming", async ({ page }) => {
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
  await expect(page.getByTestId("chat-running-queue-item").first()).toContainText("Queued");
  await expect(page.getByTestId("chat-running-queue-item").first()).toContainText("This should be queued");

  const queueRes = await page.request.get(`/api/chats/${chatId}/queue`);
  expect(queueRes.ok()).toBe(true);
  const queue = await queueRes.json();
  expect(queue.items).toHaveLength(1);
  expect(queue.items[0].payload.body).toBe("This should be queued, not sent concurrently");

  await page.getByTestId("chat-running-queue-item").first().getByRole("button", { name: "Edit queued message" }).click();
  await page.getByTestId("chat-running-queue-edit").fill("This Queue message was edited in place");
  await page.getByTestId("chat-running-queue-item").first().getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("chat-running-queue-item").first()).toContainText("This Queue message was edited in place", {
    timeout: 15_000,
  });

  const editedQueueRes = await page.request.get(`/api/chats/${chatId}/queue`);
  expect(editedQueueRes.ok()).toBe(true);
  const editedQueue = await editedQueueRes.json();
  expect(editedQueue.items).toHaveLength(1);
  expect(editedQueue.items[0].id).toBe(queue.items[0].id);
  expect(editedQueue.items[0].payload.body).toBe("This Queue message was edited in place");

  await page.getByTestId("chat-running-queue-item").first().getByRole("button", { name: "Steer" }).click();
  await expect.poll(async () => {
    const response = await page.request.get(`/api/chats/${chatId}/queue`);
    expect(response.ok()).toBe(true);
    const snapshot = await response.json();
    return snapshot.items[0]?.status ?? "delivered";
  }, { timeout: 30_000 }).toMatch(/continuation_pending|running_next|delivered/);

  await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: "This Queue message was edited in place" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("chat-running-queue")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("chat-assistant-message").filter({ hasText: "Streaming reply for chat." })).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(
    page.getByTestId("chat-assistant-message").filter({ hasText: "Chat run stopped before a final reply" }),
  ).toHaveCount(0, { timeout: 30_000 });

  const finalQueueRes = await page.request.get(`/api/chats/${chatId}/queue`);
  expect(finalQueueRes.ok()).toBe(true);
  const finalQueue = await finalQueueRes.json();
  expect(finalQueue.items).toHaveLength(0);
});

for (const planMode of [false, true]) {
test(`auto-delivers a queued message in Plan mode ${planMode ? "ON" : "OFF"} without resurrecting it after Stop`, async ({ page }) => {
  const organization = await createStreamingOrg(page, `Queue-Delivery-${Date.now()}`);

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.urlKey}/messenger/chat?agentId=${organization.chatAgent.id}`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  if (planMode) await setPlanMode(page, true);
  await composer.fill("Start the first reply");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/messenger\/chat\/[^/]+$/i, { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Stop streaming" })).toBeVisible({ timeout: 15_000 });

  await composer.fill("Run this immediately after the first reply");
  await composer.press("Enter");
  const queueItem = page.getByTestId("chat-running-queue-item");
  await expect(queueItem).toContainText("Queued");
  await expect(queueItem).toContainText(
    "Run this immediately after the first reply",
    { timeout: 15_000 },
  );
  await assertForbiddenQueueCopy(page);

  const deliveredBubble = page.getByTestId("chat-user-message-bubble").filter({
    hasText: "Run this immediately after the first reply",
  });
  await expect(deliveredBubble).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Stop streaming" })).toBeVisible();
  await expect(page.getByTestId("chat-running-queue")).toHaveCount(0);
  const deliveredChatId = currentChatId(page.url());
  await expect.poll(async () => {
    const response = await page.request.get(`/api/chats/${deliveredChatId}/queue`);
    expect(response.ok()).toBe(true);
    return (await response.json()).items.length;
  }, { timeout: 30_000 }).toBe(0);
  await page.getByRole("button", { name: "Stop streaming" }).click();
  await expect(page.getByRole("button", { name: "Stop streaming" })).toHaveCount(0, { timeout: 15_000 });
  await expect(deliveredBubble).toHaveCount(1);
  await expect(page.getByTestId("chat-running-queue")).toHaveCount(0);
  const queueRes = await page.request.get(`/api/chats/${deliveredChatId}/queue`);
  expect(queueRes.ok()).toBe(true);
  expect((await queueRes.json()).items).toHaveLength(0);
  await assertForbiddenQueueCopy(page);
});
}

for (const planMode of [false, true]) {
test(`delivers native Codex Steer into the active App Server turn in Plan mode ${planMode ? "ON" : "OFF"}`, async ({ page }) => {
  test.setTimeout(120_000);
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Native-Steer-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json();
  const chatAgent = await createE2EChatAgent(page.request, organization.id, {
    name: "Native Steer Agent",
    agentRuntimeConfig: {
      model: "gpt-5.4",
      command: E2E_CODEX_APP_SERVER_STUB,
      chatAppServerEnabled: true,
    },
  });

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.urlKey}/messenger/chat?agentId=${chatAgent.id}`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  if (planMode) await setPlanMode(page, true);
  await composer.fill("Keep Steer message position stable");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/messenger\/chat\/[^/]+$/i, { timeout: 15_000 });
  const chatId = currentChatId(page.url());
  await expect.poll(async () => {
    const response = await page.request.get(`/api/chats/${chatId}/queue`);
    expect(response.ok()).toBe(true);
    return (await response.json()).activeGenerationStatus;
  }, { timeout: 30_000 }).toBe("running");

  await composer.fill("Use the revised direction");
  await composer.press("Enter");
  const queueItem = page.getByTestId("chat-running-queue-item").first();
  await expect(queueItem).toContainText("Use the revised direction", { timeout: 15_000 });
  await queueItem.getByRole("button", { name: "Steer" }).click();

  const steerMessage = page.getByTestId("chat-transcript-steer-message").filter({ hasText: "Use the revised direction" });
  await expect(steerMessage).toHaveCount(1, { timeout: 20_000 });
  const originalMessageBubble = page.getByTestId("chat-user-message-bubble").filter({
    hasText: "Keep Steer message position stable",
  });
  const steerMessageBubble = steerMessage.getByTestId("chat-user-message-bubble");
  const [originalBox, steerBox] = await Promise.all([
    originalMessageBubble.boundingBox(),
    steerMessageBubble.boundingBox(),
  ]);
  expect(originalBox).not.toBeNull();
  expect(steerBox).not.toBeNull();
  expect(Math.abs(
    (originalBox?.x ?? 0) + (originalBox?.width ?? 0)
      - ((steerBox?.x ?? 0) + (steerBox?.width ?? 0)),
  )).toBeLessThanOrEqual(2);
  const alignmentScreenshot = process.env.RUDDER_E2E_ALIGNMENT_SCREENSHOT?.trim();
  if (alignmentScreenshot) {
    await page.screenshot({ path: alignmentScreenshot, fullPage: true });
  }

  const finalAssistant = page.getByTestId("chat-assistant-message").last();
  await expect(finalAssistant).toContainText(
    "Native steer applied: Use the revised direction",
    { timeout: 20_000 },
  );
  const queueRes = await page.request.get(`/api/chats/${chatId}/queue`);
  expect(queueRes.ok()).toBe(true);
  expect((await queueRes.json()).items).toHaveLength(0);
  await expect(page.getByText("Chat run stopped before a final reply", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Stopped", { exact: true })).toHaveCount(0);
  await assertForbiddenQueueCopy(page);

  await page.reload();
  await expect(page.getByTestId("chat-transcript-steer-message").filter({ hasText: "Use the revised direction" })).toHaveCount(1, {
    timeout: 20_000,
  });
  await expect(page.getByTestId("chat-assistant-message").last()).toContainText(
    "Native steer applied: Use the revised direction",
    { timeout: 20_000 },
  );
});
}

test("keeps accepted Steer visible and ordered while an edited response is active", async ({ page }) => {
  test.setTimeout(90_000);
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Edited-Native-Steer-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json();
  const chatAgent = await createE2EChatAgent(page.request, organization.id, {
    name: "Edited Native Steer Agent",
    command: E2E_CODEX_STUB,
  });

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.urlKey}/messenger/chat?agentId=${chatAgent.id}`);

  const composer = page.getByTestId("chat-composer-editor-scroll").locator(".rudder-mdxeditor-content").first();
  await composer.fill("Create Steer edit baseline");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("chat-assistant-message").last()).toContainText(
    "Streaming reply for chat.",
    { timeout: 20_000 },
  );

  const runtimeUpdateRes = await page.request.patch(`/api/agents/${chatAgent.id}`, {
    data: {
      agentRuntimeConfig: {
        model: "gpt-5.4",
        command: E2E_CODEX_APP_SERVER_STUB,
        chatAppServerEnabled: true,
      },
      replaceAgentRuntimeConfig: true,
    },
  });
  expect(runtimeUpdateRes.ok()).toBe(true);

  const originalBubble = page.getByTestId("chat-user-message-bubble").filter({
    hasText: "Create Steer edit baseline",
  });
  await originalBubble.hover();
  await page.getByRole("button", { name: "Edit message" }).last().click();
  const inlineEditor = page.getByTestId("chat-inline-message-editor");
  await inlineEditor.locator(".rudder-mdxeditor-content").fill("Keep Steer message position stable");
  await inlineEditor.getByRole("button", { name: "Send" }).click();

  const chatId = currentChatId(page.url());
  await expect.poll(async () => {
    const response = await page.request.get(`/api/chats/${chatId}/queue`);
    expect(response.ok()).toBe(true);
    return (await response.json()).activeGenerationStatus;
  }, { timeout: 15_000 }).toBe("running");

  await composer.fill("Steer must stay visible after edit");
  await composer.press("Enter");
  const queueItem = page.getByTestId("chat-running-queue-item").first();
  await expect(queueItem).toContainText("Steer must stay visible after edit", { timeout: 15_000 });
  await queueItem.getByRole("button", { name: "Steer" }).click();

  const steerMessage = page.getByTestId("chat-transcript-steer-message").filter({
    hasText: "Steer must stay visible after edit",
  });
  await expect(steerMessage).toBeVisible({ timeout: 20_000 });

  const finalAssistant = page.getByTestId("chat-assistant-message").last();
  await expect(finalAssistant).toContainText(
    "Native steer applied: Steer must stay visible after edit",
    { timeout: 20_000 },
  );
  expect(await finalAssistant.evaluate((assistant, feedbackText) => {
    const feedback = [...document.querySelectorAll<HTMLElement>("[data-testid='chat-transcript-steer-message']")]
      .find((element) => element.textContent?.includes(feedbackText));
    return Boolean(feedback && (feedback.compareDocumentPosition(assistant) & Node.DOCUMENT_POSITION_FOLLOWING));
  }, "Steer must stay visible after edit")).toBe(true);
});

test("renders one readable reasoning stream when App Server emits summary and raw deltas", async ({ page }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Reasoning-Stream-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json();
  const chatAgent = await createE2EChatAgent(page.request, organization.id, {
    name: "Reasoning Stream Agent",
    agentRuntimeConfig: {
      model: "gpt-5.4",
      command: E2E_CODEX_APP_SERVER_STUB,
      chatAppServerEnabled: true,
    },
  });

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.urlKey}/messenger/chat?agentId=${chatAgent.id}`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await composer.fill("Render dual reasoning streams");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("chat-assistant-message").last()).toContainText(
    "Initial App Server reply",
    { timeout: 20_000 },
  );

  const transcriptToggle = page.getByRole("button", { name: /Worked for/ }).last();
  await expect(transcriptToggle).toBeVisible({ timeout: 15_000 });
  await transcriptToggle.click();
  const transcriptItem = page.getByTestId("chat-transcript-item").last();
  await expect(transcriptItem.getByText("I will use visualize once.", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(transcriptItem).not.toContainText("I will use I will use");
  await expect(transcriptItem).not.toContainText("visualize once.visualize once.");
});

test("keeps phased App Server commentary in Process after Stop and reload", async ({ page }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Commentary-Process-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json();
  const chatAgent = await createE2EChatAgent(page.request, organization.id, {
    name: "Commentary Process Agent",
    agentRuntimeConfig: {
      model: "gpt-5.4",
      command: E2E_CODEX_APP_SERVER_STUB,
      chatAppServerEnabled: true,
    },
  });

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.urlKey}/messenger/chat?agentId=${chatAgent.id}`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await composer.fill("Keep commentary in Process");
  await page.getByRole("button", { name: "Send" }).click();

  const commentary = "Checking the timeline before the final answer.";
  const activeTranscript = page.getByTestId("chat-transcript-item").last();
  await expect(activeTranscript.getByText(commentary, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("chat-assistant-message").filter({ hasText: commentary })).toHaveCount(0);

  await page.getByRole("button", { name: "Stop streaming" }).click();
  const stoppedToggle = page.getByRole("button", { name: /Worked for .*Stopped/ }).last();
  await expect(stoppedToggle).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("chat-assistant-message").filter({ hasText: commentary })).toHaveCount(0);

  await page.reload();
  const reloadedToggle = page.getByRole("button", { name: /Worked for .*Stopped/ }).last();
  await expect(reloadedToggle).toBeVisible({ timeout: 15_000 });
  await reloadedToggle.click();
  const reloadedTranscript = page.getByTestId("chat-transcript-item").last();
  await expect(reloadedTranscript.getByText(commentary, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("chat-assistant-message").filter({ hasText: commentary })).toHaveCount(0);
  const screenshotPath = process.env.RUDDER_E2E_COMMENTARY_SCREENSHOT?.trim();
  if (screenshotPath) {
    await page.screenshot({ path: screenshotPath, fullPage: true });
  }
});

test("automatically runs queued messages after an operator Stop", async ({ page }) => {
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

  await createQueuedMessage(page, chatId, "This should run automatically after stop", 1);
  await createQueuedMessage(page, chatId, "Second automatic Queue message", 2);
  await createQueuedMessage(page, chatId, "Third automatic Queue message", 3);
  await createQueuedMessage(page, chatId, "Cancelled Queue message must never run", 4);
  await expect(page.getByTestId("chat-running-queue")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("chat-running-queue-item")).toHaveCount(4, { timeout: 15_000 });
  await page
    .getByTestId("chat-running-queue-item")
    .nth(3)
    .getByRole("button", { name: "Delete queued message" })
    .click();
  await expect(page.getByTestId("chat-running-queue-item")).toHaveCount(3, { timeout: 15_000 });
  await expect(page.getByTestId("chat-running-queue")).toContainText("3 queued");
  await expect(page.getByTestId("chat-running-queue-item").nth(0)).toContainText("Queued");
  await expect(page.getByTestId("chat-running-queue-item").nth(1)).toContainText("#2");
  await expect(page.getByTestId("chat-running-queue-item").nth(2)).toContainText("#3");
  await expect(page.getByTestId("chat-running-queue-item").nth(2)).toContainText("Third automatic Queue message");

  await page.getByRole("button", { name: "Stop streaming" }).click();
  await expect(page.getByRole("button", { name: "Stop streaming" })).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText("Stopped", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: "This should run automatically after stop" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: "Second automatic Queue message" })).toBeVisible({
    timeout: 45_000,
  });
  await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: "Third automatic Queue message" })).toBeVisible({
    timeout: 45_000,
  });
  await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: "Cancelled Queue message must never run" })).toHaveCount(0);
  await expect(page.getByTestId("chat-running-queue")).toHaveCount(0, { timeout: 45_000 });

  await expect.poll(async () => {
    const finalQueueRes = await page.request.get(`/api/chats/${chatId}/queue`);
    expect(finalQueueRes.ok()).toBe(true);
    return (await finalQueueRes.json()).items.length;
  }, { timeout: 30_000 }).toBe(0);
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
