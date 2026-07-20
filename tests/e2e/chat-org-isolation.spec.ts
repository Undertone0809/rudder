import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_BASE_URL, E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

type TestOrganization = {
  id: string;
  issuePrefix: string;
};

async function createOrganization(page: Page, name: string): Promise<TestOrganization> {
  const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
    data: { name },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json() as Promise<TestOrganization>;
}

function chatThreadTestId(chatId: string) {
  return `messenger-thread-chat-${chatId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

test("keeps old organization chat messages out of the current organization route", async ({ page }) => {
  const unique = Date.now();
  const organizationA = await createOrganization(page, `Chat-Isolation-A-${unique}`);
  const organizationB = await createOrganization(page, `Chat-Isolation-B-${unique}`);
  await createE2EChatAgent(page.request, organizationA.id, { name: "Isolation Agent" });

  const chatRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organizationA.id}/chats`, {
    data: {
      title: "Old organization chat",
      summary: "This chat belongs only to organization A.",
      issueCreationMode: "manual_approval",
      planMode: false,
    },
  });
  expect(chatRes.ok()).toBe(true);
  const chat = await chatRes.json() as { id: string };
  const oldOrgMessage = `Old org message ${randomUUID()}`;

  await e2eDb.insert(chatMessages).values({
    id: randomUUID(),
    orgId: organizationA.id,
    conversationId: chat.id,
    role: "assistant",
    kind: "message",
    status: "completed",
    body: oldOrgMessage,
    structuredPayload: null,
    replyingAgentId: null,
    chatTurnId: randomUUID(),
    turnVariant: 0,
  });

  const messageRequests: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "GET"
      && request.url().includes(`/api/chats/${chat.id}/messages`)
    ) {
      messageRequests.push(request.url());
    }
  });

  await page.goto(E2E_BASE_URL);
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organizationB.id);

  await page.goto(`${E2E_BASE_URL}/${organizationB.issuePrefix}/messenger/chat/${chat.id}`, {
    waitUntil: "domcontentloaded",
  });

  await expect(page).toHaveURL(new RegExp(`/${organizationB.issuePrefix}/messenger/chat(?:\\?.*)?$`), {
    timeout: 15_000,
  });
  await expect(page.getByText(oldOrgMessage)).toHaveCount(0);
  await expect(page.getByTestId(chatThreadTestId(chat.id))).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "What can I help with?" })).toBeVisible();
  expect(messageRequests).toEqual([]);
});
