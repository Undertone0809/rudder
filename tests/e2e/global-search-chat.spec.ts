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
    const searchInput = page.getByPlaceholder("Search issues, chats, agents, projects, library...");
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
    const searchInput = page.getByPlaceholder("Search issues, chats, agents, projects, library...");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("rare-issue-description-token");

    const issueResult = page.getByRole("option", { name: /Description-only global search target/i });
    await expect(issueResult).toBeVisible({ timeout: 15_000 });
    await issueResult.click();

    await expect(page).toHaveURL(new RegExp(`/issues/${issue.identifier ?? issue.id}$`));
  });

  test("scopes search to issues and opens the selected issue", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Scoped Issues ${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Scoped issue search target",
        description: "Only this issue should appear for rare-scoped-issue-token.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Scoped chat decoy",
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
      body: "This chat also contains rare-scoped-issue-token but should not show in issue scope.",
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
    let searchInput = page.getByPlaceholder("Search issues, chats, agents, projects, library...");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("iss");
    await expect(page.getByRole("option", { name: /Search in Issues/i })).toBeVisible();
    await expect(page.getByPlaceholder("Search issues, chats, agents, projects, library...")).toBeVisible();

    await searchInput.fill("issue ");
    searchInput = page.getByPlaceholder("Search Issues...");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("rare-scoped-issue-token");

    const issueResult = page.getByRole("option", { name: /Scoped issue search target/i });
    await expect(issueResult).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("option", { name: /Scoped chat decoy/i })).toHaveCount(0);
    await issueResult.click();

    await expect(page).toHaveURL(new RegExp(`/issues/${issue.identifier ?? issue.id}$`));
  });

  test("scopes search to Library and exits scope from an empty query", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Scoped Library ${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const filePath = `docs/scoped-library-${Date.now()}.md`;
    const fileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: {
        filePath,
        content: "# Scoped Library\n\nrare-scoped-library-token lives in the filename boundary test.",
      },
    });
    expect(fileRes.ok()).toBe(true);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/messenger`);

    await page.getByRole("button", { name: "Search" }).click();
    let searchInput = page.getByPlaceholder("Search issues, chats, agents, projects, library...");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("library ");

    searchInput = page.getByPlaceholder("Search Library...");
    await expect(searchInput).toBeVisible();
    await expect(page.getByText("Type to search Library")).toBeVisible();

    await searchInput.press("Backspace");
    searchInput = page.getByPlaceholder("Search issues, chats, agents, projects, library...");
    await expect(searchInput).toBeVisible();

    await searchInput.fill("library ");
    searchInput = page.getByPlaceholder("Search Library...");
    await searchInput.fill("scoped-library");

    const libraryResult = page.getByRole("option", { name: new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    await expect(libraryResult).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("option", { name: /Scoped issue search target/i })).toHaveCount(0);
    await libraryResult.click();

    await expect(page).toHaveURL(new RegExp(`/library\\?path=${encodeURIComponent(filePath)}$`));
  });
});
