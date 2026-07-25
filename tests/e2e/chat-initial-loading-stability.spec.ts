import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

test("keeps prefetched messages behind the loading skeleton until conversation detail resolves", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 760 });

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Chat-Initial-Loading-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; urlKey: string };
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: "Initial Loading Agent",
  });
  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Initial loading stability",
      preferredAgentId: agent.id,
      issueCreationMode: "manual_approval",
      planMode: false,
      initialMessage: { body: "Seed the initial loading regression conversation." },
    },
  });
  const chat = await chatRes.json() as { id: string; error?: string };
  expect(chatRes.ok(), JSON.stringify(chat)).toBe(true);
  const latestBody = "**Raw markdown must stay hidden**\n\n- Final rendered item";
  const now = Date.now();

  await e2eDb.insert(chatMessages).values(
    Array.from({ length: 18 }, (_, index) => {
      const isLatest = index === 17;
      const createdAt = new Date(now + index * 1000);
      return {
        id: randomUUID(),
        orgId: organization.id,
        conversationId: chat.id,
        role: index % 2 === 0 ? "user" : "assistant",
        kind: "message",
        status: "completed",
        body: isLatest
          ? latestBody
          : `Historical message ${index + 1}. ${"Adds transcript height. ".repeat(10)}`,
        structuredPayload: null,
        replyingAgentId: index % 2 === 0 ? null : agent.id,
        chatTurnId: randomUUID(),
        turnVariant: 0,
        createdAt,
        updatedAt: createdAt,
      };
    }),
  );

  let releaseConversationDetail!: () => void;
  const conversationDetailGate = new Promise<void>((resolve) => {
    releaseConversationDetail = resolve;
  });
  await page.route(`**/api/chats/${chat.id}`, async (route) => {
    await conversationDetailGate;
    await route.continue();
  });

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  const messagesResponse = page.waitForResponse((response) => (
    response.request().method() === "GET"
    && new URL(response.url()).pathname === `/api/chats/${chat.id}/messages`
  ));
  await page.goto(`/${organization.urlKey}/messenger/chat/${chat.id}`, {
    waitUntil: "domcontentloaded",
  });
  await messagesResponse;

  const loadingState = page.getByRole("status", { name: "Chat messages loading" });
  await expect(loadingState).toBeVisible();
  await expect(page.getByText("**Raw markdown must stay hidden**", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("chat-composer-toolbar")).toHaveCount(0);
  await expect(page.getByTestId("chat-empty-state-tabs")).toHaveCount(0);

  const conversationDetailResponse = page.waitForResponse((response) => (
    response.request().method() === "GET"
    && new URL(response.url()).pathname === `/api/chats/${chat.id}`
  ));
  releaseConversationDetail();
  await conversationDetailResponse;

  const scrollRegion = page.getByTestId("chat-messages-scroll-region");
  await expect(loadingState).toHaveCount(0);
  await expect(page.locator("strong").filter({ hasText: "Raw markdown must stay hidden" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Final rendered item" })).toBeVisible();
  await expect(page.getByTestId("chat-composer-toolbar")).toBeVisible();
  await expect.poll(async () => (
    scrollRegion.evaluate((node) =>
      Math.round(node.scrollHeight - node.scrollTop - node.clientHeight)
    )
  )).toBeLessThanOrEqual(4);
});
