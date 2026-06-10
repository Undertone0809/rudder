import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.describe("Global search results", () => {
  test("finds a chat by message body and opens the conversation", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Search Chats ${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Messenger search target",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json();

    await e2eDb.insert(chatMessages).values({
      id: randomUUID(),
      orgId: organization.id,
      conversationId: chat.id,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Need to preserve the rare-chat-search-token in global search.",
      structuredPayload: null,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/messenger`);

    await page.getByRole("button", { name: "Search" }).click();
    const searchInput = page.getByPlaceholder("Search issues, chats, agents, projects...");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("rare-chat-search-token");

    const chatResult = page.getByRole("option", { name: /Messenger search target/i });
    await expect(chatResult).toBeVisible({ timeout: 15_000 });
    await expect(chatResult).toContainText("rare-chat-search-token");
    await chatResult.click();

    await expect(page).toHaveURL(new RegExp(`/messenger/chat/${chat.id}$`));
  });

  test("finds an issue by description text from the command palette", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Search Issues ${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Description-only global search target",
        description: "Only this description contains rare-issue-description-token.",
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
    await page.goto(`/${organization.issuePrefix}/messenger`);

    await page.getByRole("button", { name: "Search" }).click();
    const searchInput = page.getByPlaceholder("Search issues, chats, agents, projects...");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("rare-issue-description-token");

    const issueResult = page.getByRole("option", { name: /Description-only global search target/i });
    await expect(issueResult).toBeVisible({ timeout: 15_000 });
    await issueResult.click();

    await expect(page).toHaveURL(new RegExp(`/issues/${issue.identifier ?? issue.id}$`));
  });
});
