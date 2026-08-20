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

test("deduplicates rapid send clicks when starting a new chat", async ({ page }) => {
  const organization = await createStreamingOrg(page, `Dedup-Chat-${Date.now()}`);

  await page.route(`**/api/orgs/${organization.id}/chats`, async (route, request) => {
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/chat?agentId=${organization.chatAgent.id}`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("No duplicates please");

  await page.getByRole("button", { name: "Send" }).dblclick();
  await expect(page.getByRole("button", { name: "Sending" })).toBeVisible({ timeout: 15_000 });

  await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: "No duplicates please" })).toHaveCount(1, {
    timeout: 15_000,
  });
  await expect(page.getByTestId("chat-assistant-message").last()).toContainText("Streaming reply for chat.", {
    timeout: 30_000,
  });

  const chatsRes = await page.request.get(`/api/orgs/${organization.id}/chats?status=all`);
  expect(chatsRes.ok()).toBe(true);
  const chats = await chatsRes.json();
  expect(chats).toHaveLength(1);

  const messagesRes = await page.request.get(`/api/chats/${chats[0].id}/messages`);
  expect(messagesRes.ok()).toBe(true);
  const messages = await messagesRes.json();
  const userMessages = messages.filter((message: { role: string; body: string }) =>
    message.role === "user" && message.body.includes("No duplicates please"));
  expect(userMessages).toHaveLength(1);
});

async function exerciseOptimisticFirstTurn(page: Page, viewport: { width: number; height: number }, suffix: string) {
  await page.setViewportSize(viewport);
  const organization = await createStreamingOrg(page, `Optimistic-first-turn-${suffix}-${Date.now()}`);
  let releaseStream!: () => void;
  const streamGate = new Promise<void>((resolve) => {
    releaseStream = resolve;
  });
  let streamRouteReached = false;
  const streamRoute = `**/api/orgs/${organization.id}/chats/messages/stream`;
  await page.route(streamRoute, async (route) => {
    streamRouteReached = true;
    await streamGate;
    await route.continue();
  });

  try {
    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/chat?agentId=${organization.chatAgent.id}`);

    const composer = page.locator(".rudder-mdxeditor-content").first();
    const body = `Immediate first-turn feedback ${suffix}`;
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill(body);
    await page.getByRole("button", { name: "Send" }).click();

    await expect.poll(() => streamRouteReached).toBe(true);
    await expect(page.getByTestId("chat-pending-first-turn")).toContainText(body);
    await expect(page.getByTestId("chat-pending-first-turn-status")).toContainText("Sending message...");
    await expect(composer).toHaveText("");
    await expect(page.getByRole("button", { name: "Sending" })).toBeDisabled();

    releaseStream();
    releaseStream = () => undefined;
    await expect(page.getByTestId("chat-pending-first-turn")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: body })).toHaveCount(1, {
      timeout: 15_000,
    });
    await expect(page.getByTestId("chat-assistant-message").last()).toContainText("Streaming reply for chat.", {
      timeout: 30_000,
    });
  } finally {
    releaseStream();
    await page.unroute(streamRoute);
  }
}

test("shows first-turn sending feedback on desktop and mobile before acknowledgement", async ({ page }) => {
  await exerciseOptimisticFirstTurn(page, { width: 1440, height: 960 }, "desktop");
  await exerciseOptimisticFirstTurn(page, { width: 390, height: 844 }, "mobile");
});

test("restores a failed first-turn draft and clears the sending state", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const organization = await createStreamingOrg(page, `First-turn-failure-${Date.now()}`);
  let streamRouteReached = false;
  let releaseFailure!: () => void;
  const failureGate = new Promise<void>((resolve) => {
    releaseFailure = resolve;
  });
  const streamRoute = `**/api/orgs/${organization.id}/chats/messages/stream`;
  await page.route(streamRoute, async (route) => {
    streamRouteReached = true;
    await failureGate;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "provider stack trace" }),
    });
  });

  try {
    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/chat?agentId=${organization.chatAgent.id}`);

    const composer = page.locator(".rudder-mdxeditor-content").first();
    const body = "Keep this first-turn draft after failure";
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill(body);
    await page.getByRole("button", { name: "Send" }).click();

    await expect.poll(() => streamRouteReached).toBe(true);
    await expect(page.getByTestId("chat-pending-first-turn")).toContainText(body);
    releaseFailure();
    await expect(page.getByText("Could not send message", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("chat-pending-first-turn")).toHaveCount(0);
    await expect(composer).toContainText(body);
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
    await expect(page.getByText("provider stack trace", { exact: false })).toHaveCount(0);
  } finally {
    releaseFailure();
    await page.unroute(streamRoute);
  }
});
