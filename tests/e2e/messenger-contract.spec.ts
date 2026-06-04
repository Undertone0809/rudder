import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq } from "../../packages/db/node_modules/drizzle-orm/index.js";
import {
  activityLog,
  chatConversationUserStates,
  chatConversations,
  chatMessages,
  createDb,
  heartbeatRuns,
  issues,
} from "../../packages/db/src/index.ts";
import { E2E_CODEX_STUB, E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);
const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X5p1sAAAAASUVORK5CYII=",
  "base64",
);

async function createOrganization(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json();
}

async function createConfiguredOrganization(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name,
    },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json();
  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Messenger Chat Agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        model: "gpt-5.4",
        command: E2E_CODEX_STUB,
      },
    },
  });
  expect(agentRes.ok()).toBe(true);
  const chatAgent = await agentRes.json();
  return { ...organization, chatAgent };
}

function threadTestId(threadKey: string) {
  return `messenger-thread-${threadKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function chatUnreadBadgeTestId(chatId: string) {
  return `${`chat:${chatId}`.replace(/[^a-zA-Z0-9_-]/g, "-")}-unread-badge`;
}

async function isInElementViewport(page: Page, containerTestId: string, rowTestId: string) {
  return page.evaluate(({ containerTestId, rowTestId }) => {
    const container = document.querySelector(`[data-testid="${containerTestId}"] nav`);
    const row = document.querySelector(`[data-testid="${rowTestId}"]`);
    if (!container || !row) return false;

    const containerRect = container.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    return rowRect.top >= containerRect.top && rowRect.bottom <= containerRect.bottom;
  }, { containerTestId, rowTestId });
}

function exactTimestampPattern() {
  return /[A-Z][a-z]{2} \d{1,2}(?:, \d{4})?, \d{1,2}:\d{2} [AP]M/;
}

async function expectMessengerThreadStartsAtBottom(page: Page, heading: string) {
  const mainContent = page.locator("#main-content");
  await expect(mainContent.getByRole("heading", { name: heading })).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => {
    return await mainContent.evaluate((node) => node.scrollHeight > node.clientHeight + 24);
  }).toBe(true);
  await expect.poll(async () => {
    return await mainContent.evaluate((node) => Math.round(node.scrollTop));
  }).toBeGreaterThan(0);
  await expect.poll(async () => {
    return await mainContent.evaluate((node) => Math.round(node.scrollHeight - node.scrollTop - node.clientHeight));
  }).toBeLessThanOrEqual(8);
}

async function clickMessengerViewCheckbox(page: Page, name: string) {
  const item = page.getByRole("menuitemcheckbox", { name });
  if (!await item.isVisible().catch(() => false)) {
    await page.getByTestId("messenger-thread-organization-trigger").click();
  }
  await item.click();
}

test.describe("Messenger unified threads contract", () => {
  test("loads additional chat sessions in the Messenger sidebar without fetching every thread up front", async ({ page }) => {
    const organization = await createOrganization(page, `Messenger-Paged-Sessions-${Date.now()}`);
    const baseTime = Date.parse("2026-05-15T12:00:00.000Z");
    const rows = Array.from({ length: 55 }).map((_, index) => {
      const activityAt = new Date(baseTime - index * 60_000);
      return {
        id: randomUUID(),
        orgId: organization.id,
        title: `Paged session ${String(index + 1).padStart(2, "0")}`,
        summary: `Paged session preview ${index + 1}`,
        issueCreationMode: "manual_approval" as const,
        planMode: false,
        createdByUserId: "local-board",
        lastMessageAt: activityAt,
        createdAt: activityAt,
        updatedAt: activityAt,
      };
    });
    await e2eDb.insert(chatConversations).values(rows);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    const unpagedThreadRequests: string[] = [];
    const fullChatListRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        request.method() === "GET"
        && url.pathname === `/api/orgs/${organization.id}/messenger/threads`
        && url.search === ""
      ) {
        unpagedThreadRequests.push(request.url());
      }
      if (
        request.method() === "GET"
        && url.pathname === `/api/orgs/${organization.id}/chats`
        && url.searchParams.get("status") === "active"
      ) {
        fullChatListRequests.push(request.url());
      }
    });

    const firstPageResponse = page.waitForResponse((response) =>
      response.request().method() === "GET"
      && response.url().includes(`/api/orgs/${organization.id}/messenger/threads?limit=40`),
    );
    await page.goto(`/${organization.issuePrefix}/messenger`, { waitUntil: "commit" });
    const firstPage = await (await firstPageResponse).json();
    expect(firstPage.items).toHaveLength(40);
    expect(firstPage.pageInfo.hasMore).toBe(true);
    expect(firstPage.items.some((item: { title: string }) => item.title === "Paged session 55")).toBe(false);
    expect(unpagedThreadRequests).toEqual([]);
    expect(fullChatListRequests).toEqual([]);

    const nextPageResponse = page.waitForResponse((response) =>
      response.request().method() === "GET"
      && response.url().includes(`/api/orgs/${organization.id}/messenger/threads?cursor=`)
      && response.url().includes("limit=40"),
    );
    await page.getByTestId("workspace-sidebar").locator("nav").evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const nextPage = await (await nextPageResponse).json();
    expect(nextPage.items.some((item: { title: string }) => item.title === "Paged session 55")).toBe(true);
    await expect(page.getByTestId(threadTestId(`chat:${rows[54]!.id}`))).toBeVisible({ timeout: 15_000 });
    expect(unpagedThreadRequests).toEqual([]);
    expect(fullChatListRequests).toEqual([]);
  });

  test("keeps pinned Messenger chats visible when they are older than the first activity page", async ({ page }) => {
    const sessionRes = await page.request.get("/api/auth/get-session");
    expect(sessionRes.ok()).toBe(true);
    const session = await sessionRes.json();
    const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
    expect(currentUserId).toBeTruthy();

    const organization = await createOrganization(page, `Messenger-Pinned-Older-Page-${Date.now()}`);
    const baseTime = Date.parse("2026-05-16T12:00:00.000Z");
    const rows = Array.from({ length: 45 }).map((_, index) => {
      const activityAt = new Date(baseTime - index * 60_000);
      return {
        id: randomUUID(),
        orgId: organization.id,
        title: `Pinned page session ${String(index + 1).padStart(2, "0")}`,
        summary: `Pinned page session preview ${index + 1}`,
        issueCreationMode: "manual_approval" as const,
        planMode: false,
        createdByUserId: currentUserId,
        lastMessageAt: activityAt,
        createdAt: activityAt,
        updatedAt: activityAt,
      };
    });
    await e2eDb.insert(chatConversations).values(rows);
    const pinnedOlderChat = rows[44]!;
    await e2eDb.insert(chatConversationUserStates).values({
      orgId: organization.id,
      conversationId: pinnedOlderChat.id,
      userId: currentUserId,
      lastReadAt: pinnedOlderChat.lastMessageAt,
      pinnedAt: new Date("2026-05-16T13:00:00.000Z"),
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    const firstPageResponse = page.waitForResponse((response) =>
      response.request().method() === "GET"
      && response.url().includes(`/api/orgs/${organization.id}/messenger/threads?limit=40`),
    );
    await page.goto(`/${organization.issuePrefix}/messenger`, { waitUntil: "commit" });
    const firstPage = await (await firstPageResponse).json();
    expect(firstPage.items.some((item: { title: string }) => item.title === "Pinned page session 45")).toBe(true);
    const legacyThreadsRes = await page.request.get(`/api/orgs/${organization.id}/messenger/threads`);
    expect(legacyThreadsRes.ok()).toBe(true);
    const legacyThreads = await legacyThreadsRes.json() as Array<{ threadKey: string; isPinned?: boolean }>;
    expect(legacyThreads.slice(0, 1)).toEqual([
      expect.objectContaining({
        threadKey: `chat:${pinnedOlderChat.id}`,
        isPinned: true,
      }),
    ]);

    await expect(page.getByTestId("messenger-thread-section-pinned")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(threadTestId(`chat:${pinnedOlderChat.id}`))).toContainText("Pinned page session 45");
  });

  test("double-clicking primary rail Messenger scrolls the sidebar to unread threads", async ({ page }) => {
    const sessionRes = await page.request.get("/api/auth/get-session");
    expect(sessionRes.ok()).toBe(true);
    const session = await sessionRes.json();
    const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
    expect(currentUserId).toBeTruthy();

    const organization = await createOrganization(page, `Messenger-Unread-Scroll-${Date.now()}`);
    const targetChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Unread thread below the fold",
        summary: "Double-clicking Messenger should reveal this unread thread.",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(targetChatRes.ok()).toBe(true);
    const targetChat = await targetChatRes.json();

    const readAt = new Date("2026-01-01T00:00:00.000Z");
    const messageAt = new Date("2026-01-01T00:01:00.000Z");
    await e2eDb.insert(chatConversationUserStates).values({
      orgId: organization.id,
      conversationId: targetChat.id,
      userId: currentUserId,
      lastReadAt: readAt,
      updatedAt: readAt,
    });
    await e2eDb.insert(chatMessages).values({
      id: randomUUID(),
      orgId: organization.id,
      conversationId: targetChat.id,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Unread assistant reply",
      createdAt: messageAt,
      updatedAt: messageAt,
    });
    await e2eDb
      .update(chatConversations)
      .set({ lastMessageAt: messageAt, updatedAt: messageAt })
      .where(eq(chatConversations.id, targetChat.id));

    for (let index = 0; index < 18; index += 1) {
      const fillerRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
        data: {
          title: `Read filler chat ${String(index + 1).padStart(2, "0")}`,
          summary: "This read chat keeps the unread target below the visible sidebar area.",
          issueCreationMode: "manual_approval",
          planMode: false,
        },
      });
      expect(fillerRes.ok()).toBe(true);
    }

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/messenger/chat`, { waitUntil: "commit" });

    const targetThreadTestId = threadTestId(`chat:${targetChat.id}`);
    await expect(page.getByTestId(targetThreadTestId)).toContainText("Unread thread below the fold", { timeout: 15_000 });
    await expect(page.getByTestId(chatUnreadBadgeTestId(targetChat.id))).toHaveText("1");
    await expect(page.getByTestId("rail-badge-messenger")).toHaveText("1");

    const sidebarNav = page.getByTestId("workspace-sidebar").locator("nav").first();
    await sidebarNav.evaluate((node) => {
      node.scrollTop = 0;
    });
    await expect.poll(() => isInElementViewport(page, "workspace-sidebar", targetThreadTestId)).toBe(false);

    await page.getByTestId("primary-rail").getByRole("link", { name: "Messenger" }).dblclick();

    await expect.poll(() => isInElementViewport(page, "workspace-sidebar", targetThreadTestId)).toBe(true);
  });

  test("archives a Messenger chat from the sidebar and removes it from the thread list", async ({ page }) => {
    const organization = await createOrganization(page, `Messenger-Archive-${Date.now()}`);

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Archive me",
        summary: "This chat should disappear from Messenger after archiving.",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json();

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`, { waitUntil: "commit" });

    const threadRow = page.getByTestId(threadTestId(`chat:${chat.id}`));
    await expect(threadRow).toBeVisible({ timeout: 15_000 });

    await threadRow.hover();
    await threadRow.getByRole("button", { name: "Chat actions" }).click();
    await page.getByRole("menuitem", { name: "Archive" }).click();

    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/messenger/chat(?:\\?[^#]*)?$`), {
      timeout: 15_000,
    });
    await expect(page.getByTestId(threadTestId(`chat:${chat.id}`))).toHaveCount(0);
    await expect(page.locator('[data-testid="workspace-sidebar"] [data-testid^="messenger-thread-"]')).toHaveCount(0);
    await expect(page.locator("#main-content").locator(".chat-composer")).toBeVisible({ timeout: 15_000 });

    await expect.poll(async () => {
      const archivedChatRes = await page.request.get(`/api/chats/${chat.id}`);
      expect(archivedChatRes.ok()).toBe(true);
      const archivedChat = await archivedChatRes.json();
      return archivedChat.status;
    }).toBe("archived");
  });

  test("loads older issue messages on demand instead of rendering the full issue feed", async ({ page }) => {
    const sessionRes = await page.request.get("/api/auth/get-session");
    expect(sessionRes.ok()).toBe(true);
    const session = await sessionRes.json();
    const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
    expect(currentUserId).toBeTruthy();

    const organization = await createOrganization(page, `Messenger-Issue-Pagination-${Date.now()}`);
    const baseTime = new Date("2026-04-20T10:00:00.000Z").getTime();
    const issueRows = Array.from({ length: 52 }, (_, index) => {
      const activityAt = new Date(baseTime + index * 60_000);
      return {
        id: randomUUID(),
        orgId: organization.id,
        title: `Messenger paged issue ${String(index + 1).padStart(2, "0")}`,
        status: "todo" as const,
        priority: "medium" as const,
        assigneeUserId: currentUserId,
        createdAt: activityAt,
        updatedAt: activityAt,
      };
    });
    await e2eDb.insert(issues).values(issueRows);

    const oldestIssue = issueRows[0]!;
    const newestIssue = issueRows.at(-1)!;

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/messenger/issues`, { waitUntil: "commit" });

    await expect(page.getByTestId(`messenger-issue-card-${newestIssue.id}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`messenger-issue-card-${oldestIssue.id}`)).toHaveCount(0);

    await page.getByRole("button", { name: "Load older issues" }).click();

    await expect(page.getByTestId(`messenger-issue-card-${oldestIssue.id}`)).toBeVisible({ timeout: 15_000 });
  });

  test("pins a Messenger chat from the sidebar and promotes it above recent threads", async ({ page }) => {
    const organization = await createOrganization(page, `Messenger-Pin-${Date.now()}`);

    const olderChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Pinned older chat",
        summary: "This chat should move above newer activity after pinning.",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(olderChatRes.ok()).toBe(true);
    const olderChat = await olderChatRes.json();
    await page.waitForTimeout(25);

    const newerChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Recent unpinned chat",
        summary: "This chat is newer but not pinned.",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(newerChatRes.ok()).toBe(true);
    const newerChat = await newerChatRes.json();

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat/${olderChat.id}`, { waitUntil: "commit" });

    const olderRow = page.getByTestId(threadTestId(`chat:${olderChat.id}`));
    const newerRow = page.getByTestId(threadTestId(`chat:${newerChat.id}`));
    await expect(olderRow).toBeVisible({ timeout: 15_000 });
    await expect(newerRow).toBeVisible({ timeout: 15_000 });
    await expect(newerRow).toContainText("Recent unpinned chat");

    await olderRow.hover();
    await olderRow.getByRole("button", { name: "Chat actions" }).click();
    await page.getByRole("menuitem", { name: "Pin" }).click();

    await expect(page.getByTestId("messenger-thread-section-pinned")).toBeVisible({ timeout: 15_000 });
    const chatRows = page.locator(
      `[data-testid="${threadTestId(`chat:${olderChat.id}`)}"], [data-testid="${threadTestId(`chat:${newerChat.id}`)}"]`,
    );
    await expect.poll(async () => {
      return await chatRows.evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-testid")),
      );
    }).toEqual([
      threadTestId(`chat:${olderChat.id}`),
      threadTestId(`chat:${newerChat.id}`),
    ]);
  });

  test("renders pinned Messenger chats from thread summaries before the full chat list responds", async ({ page }) => {
    const organization = await createOrganization(page, `Messenger-Pin-Cold-${Date.now()}`);

    const olderChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Pinned summary chat",
        summary: "Pinned should render from the Messenger thread summary payload.",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(olderChatRes.ok()).toBe(true);
    const olderChat = await olderChatRes.json();
    await page.waitForTimeout(25);

    const newerChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Recent unpinned summary chat",
        summary: "This chat is newer but should stay in Recent.",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(newerChatRes.ok()).toBe(true);
    const newerChat = await newerChatRes.json();

    const pinRes = await page.request.post(`/api/chats/${olderChat.id}/user-state`, {
      data: { pinned: true },
    });
    expect(pinRes.ok()).toBe(true);

    let releaseFullChatList!: () => void;
    const fullChatListBlocked = new Promise<void>((resolve) => {
      releaseFullChatList = resolve;
    });
    await page.route((url) => {
      return url.pathname === `/api/orgs/${organization.id}/chats` && url.searchParams.get("status") === "all";
    }, async (route) => {
      await fullChatListBlocked;
      await route.continue();
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat/${newerChat.id}`, { waitUntil: "commit" });

    await expect(page.getByTestId("messenger-thread-section-pinned")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(threadTestId(`chat:${olderChat.id}`))).toContainText("Pinned summary chat");
    await expect(page.getByTestId(threadTestId(`chat:${newerChat.id}`))).toContainText("Recent unpinned summary chat");

    releaseFullChatList();
  });

  test("renders the mixed Messenger directory and supports issue + approval actions", async ({ page }, testInfo) => {
    const sessionRes = await page.request.get("/api/auth/get-session");
    expect(sessionRes.ok()).toBe(true);
    const session = await sessionRes.json();
    const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
    expect(currentUserId).toBeTruthy();

    const organization = await createOrganization(page, `Messenger-${Date.now()}`);

    const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Project Atlas",
        status: "in_progress",
      },
    });
    expect(projectRes.ok()).toBe(true);
    const project = await projectRes.json();

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Messenger intake",
        summary: "Clarify, route, and keep the conversation lightweight.",
        issueCreationMode: "manual_approval",
        planMode: false,
        contextLinks: [{ entityType: "project", entityId: project.id }],
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json();

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Messenger issue follow",
        description: "This issue is watched from Messenger.",
        status: "todo",
        priority: "medium",
        assigneeUserId: currentUserId,
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    const followRes = await page.request.post(`/api/issues/${issue.id}/follow`);
    expect(followRes.ok()).toBe(true);

    const approvalImageRes = await page.request.post(`/api/orgs/${organization.id}/assets/images`, {
      multipart: {
        namespace: "approval-test",
        file: {
          name: "approval-screenshot.png",
          mimeType: "image/png",
          buffer: ONE_BY_ONE_PNG,
        },
      },
    });
    expect(approvalImageRes.ok()).toBe(true);
    const approvalImage = await approvalImageRes.json() as { contentPath: string };

    const approvalRes = await page.request.post(`/api/orgs/${organization.id}/approvals`, {
      data: {
        type: "chat_issue_creation",
        payload: {
          chatConversationId: chat.id,
          proposedIssue: {
            title: "Messenger contract test",
            description: [
              "## Approval Markdown",
              "",
              "- Render **markdown** in the approval preview.",
              "- Preserve inline images.",
              "",
              `![](${approvalImage.contentPath})`,
            ].join("\n"),
            priority: "medium",
            projectId: project.id,
            assigneeUserId: currentUserId,
          },
        },
        issueIds: [issue.id],
      },
    });
    expect(approvalRes.ok()).toBe(true);
    const approval = await approvalRes.json();

    await page.goto("/");
    await page.evaluate(({ orgId }) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, { orgId: organization.id });

    await page.goto("/messenger");

    const mainContent = page.locator("#main-content");
    await expect(page).toHaveURL(/\/messenger\/chat$/, { timeout: 15_000 });
    await expect(mainContent.locator(".chat-composer")).toBeVisible({ timeout: 15_000 });
    const organizationPrefix = organization.issuePrefix;

    const sidebarThreads = page.locator('[data-testid="workspace-sidebar"] [data-testid^="messenger-thread-"]:not([data-testid="messenger-thread-organization-trigger"])');
    await expect(sidebarThreads).toHaveCount(3, { timeout: 15_000 });
    await expect(page.getByTestId(threadTestId("approvals"))).toContainText("Approvals");
    await expect(page.getByTestId(threadTestId("issues"))).toContainText("Messenger issue follow");
    await expect(page.getByTestId(threadTestId(`chat:${chat.id}`))).toContainText("Messenger intake");
    await expect(sidebarThreads.nth(0)).toContainText("Approvals");
    await expect(sidebarThreads.nth(1)).toContainText("Issues");
    await expect(sidebarThreads.nth(2)).toContainText("Messenger intake");
    await expect(page.getByTestId("approvals-unread-badge")).toHaveText("1");
    await expect(page.getByTestId("issues-unread-badge")).toHaveText("1");
    await expect(page.getByTestId("rail-badge-messenger")).toHaveText("2");
    await expect(page.getByTestId("rail-badge-messenger")).toHaveClass(/bg-red-500/);

    await page.getByTestId("messenger-thread-organization-trigger").click();
    await page.getByRole("menuitemradio", { name: "Project" }).click();
    await expect(page.getByTestId("workspace-context-header")).toContainText("Threads organized by project");
    await expect(page.getByText("Threads · Project")).toBeVisible();
    await expect(page.getByTestId("messenger-thread-section-Project-Atlas")).toBeVisible();
    await expect(page.getByTestId("messenger-thread-section-System")).toBeVisible();
    await expect(page.getByTestId(threadTestId(`chat:${chat.id}`))).toContainText("Messenger intake");

    await page.goto(`/${organizationPrefix}/messenger/issues`, { waitUntil: "commit" });
    await expect(mainContent.getByRole("heading", { name: "Issues" })).toBeVisible({ timeout: 15_000 });
    await expect(mainContent.getByTestId("messenger-panel-header")).not.toContainText(/\b\d+\s+unread\b/i);
    const issueCard = page.locator(`[data-testid="messenger-issue-card-${issue.id}"]`);
    const longIssueComment = [
      "## Review Summary",
      "",
      "- Messenger should render the comment as **markdown**.",
      "- The card should show enough context before collapsing.",
      "- Line 3 keeps the preview dense but readable.",
      "- Line 4 validates multiline rendering.",
      "- Line 5 validates the measured height.",
      "- Line 6 keeps us below modal territory.",
      "- Line 7 is still useful operational context.",
      "- Line 8 should remain visible in the collapsed area.",
      "- Line 9 is close to the limit.",
      "- Line 10 is the target preview depth.",
      "- Line 11 should require expansion.",
      "- Line 12 proves the full comment is still available.",
    ].join("\n");

    await issueCard.getByRole("button", { name: "Quick comment" }).click();
    await issueCard.getByPlaceholder("Add a quick comment").fill(longIssueComment);
    await issueCard.getByTestId(`messenger-quick-comment-submit-${issue.id}`).click();

    let createdCommentId = "";
    await expect.poll(async () => {
      const commentsRes = await page.request.get(`/api/issues/${issue.id}/comments`);
      const comments = await commentsRes.json();
      createdCommentId = comments.find((comment: { id: string; body: string }) => comment.body === longIssueComment)?.id ?? "";
      return createdCommentId;
    }).not.toBe("");

    const commentPreview = issueCard.getByTestId(`messenger-issue-comment-preview-${issue.id}`);
    const commentPreviewBody = issueCard.getByTestId(`messenger-issue-comment-preview-${issue.id}-body`);
    await expect(commentPreview).toContainText("Review Summary");
    await expect(commentPreview.locator("h2", { hasText: "Review Summary" })).toBeVisible();
    await expect(commentPreview.locator("strong", { hasText: "markdown" })).toBeVisible();
    await expect(commentPreview.getByRole("button", { name: "Show full comment" })).toBeVisible();
    const collapsedMetrics = await commentPreviewBody.evaluate((node) => ({
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
    }));
    expect(collapsedMetrics.scrollHeight).toBeGreaterThan(collapsedMetrics.clientHeight + 8);

    await commentPreview.getByRole("button", { name: "Show full comment" }).click();
    await expect(commentPreview.getByRole("button", { name: "Show less" })).toBeVisible();
    await expect.poll(async () => {
      return await commentPreviewBody.evaluate((node) => node.clientHeight);
    }).toBeGreaterThan(collapsedMetrics.clientHeight + 8);

    const openIssueLink = issueCard.getByRole("link", { name: "Open issue" });
    await expect(openIssueLink).toHaveAttribute(
      "href",
      new RegExp(`/issues/${issue.identifier ?? issue.id}#comment-${createdCommentId}$`),
    );
    await expect(issueCard.getByRole("button", { name: "Assign to me" })).toHaveCount(0);
    await expect(issueCard.getByRole("button", { name: "Unassign me" })).toHaveCount(0);

    await openIssueLink.click();
    await expect(page).toHaveURL(new RegExp(`/${organizationPrefix}/issues/${issue.identifier ?? issue.id}#comment-${createdCommentId}$`));
    const highlightedComment = page.locator(`#comment-${createdCommentId}`);
    await expect(highlightedComment).toBeVisible({ timeout: 15_000 });
    await expect(highlightedComment).toHaveClass(/bg-primary\/5/);

    await page.goto(`/${organizationPrefix}/messenger/approvals`, { waitUntil: "commit" });
    await expect(mainContent.getByRole("heading", { name: "Approvals" })).toBeVisible({ timeout: 15_000 });
    await expect(mainContent.getByTestId("messenger-panel-header")).not.toContainText(/\b\d+\s+(?:pending|total)\b/i);
    const approvalCard = page.locator('[data-testid^="messenger-approval-card-"]').first();
    await expect(approvalCard).toContainText("Messenger contract test");
    await expect(approvalCard).toContainText("Agent proposed a new issue from chat");
    await expect(approvalCard).toContainText("Messenger intake");
    await expect(approvalCard).toContainText("Project Atlas");
    await expect(approvalCard).toContainText("Me");
    await expect(approvalCard.locator("h2", { hasText: "Approval Markdown" })).toBeVisible();
    await expect(approvalCard.locator("strong", { hasText: "markdown" })).toBeVisible();
    await expect(approvalCard.locator(`img[src="${approvalImage.contentPath}"]`)).toBeVisible();
    await expect(approvalCard).not.toContainText(chat.id);
    await expect(approvalCard).not.toContainText(project.id);
    await expect(approvalCard).not.toContainText(currentUserId);
    await page.getByRole("link", { name: "Open full approval" }).click();
    await expect(page).toHaveURL(new RegExp(`/${organizationPrefix}/messenger/approvals/${approval.id}(?:\\?[^#]*)?$`));
    const approvalDialog = page.getByTestId("approval-detail-dialog");
    await expect(approvalDialog).toBeVisible();
    await expect(approvalDialog).toContainText("Messenger contract test");
    await expect(approvalDialog).toContainText("Agent proposed a new issue from chat");
    await expect(approvalDialog).toContainText("Messenger intake");
    await expect(approvalDialog).toContainText("Project Atlas");
    await expect(approvalDialog).toContainText("Me");
    await expect(approvalDialog.locator("h2", { hasText: "Approval Markdown" })).toBeVisible();
    await expect(approvalDialog.locator("strong", { hasText: "markdown" })).toBeVisible();
    await expect(approvalDialog.locator(`img[src="${approvalImage.contentPath}"]`)).toBeVisible();
    await expect(approvalDialog).not.toContainText(chat.id);
    await expect(approvalDialog).not.toContainText(project.id);
    await expect(approvalDialog).not.toContainText(currentUserId);
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page).toHaveURL(new RegExp(`/${organizationPrefix}/messenger/approvals(?:\\?[^#]*)?$`));

    await page.getByRole("button", { name: "Approve" }).click();

    await expect.poll(async () => {
      const approvalStateRes = await page.request.get(`/api/approvals/${approval.id}`);
      const approvalState = await approvalStateRes.json();
      return approvalState.status;
    }).toBe("approved");

    await page.screenshot({
      path: testInfo.outputPath("messenger-shell.png"),
      fullPage: true,
    });
  });

  test("splits issue notifications into mixed Messenger sidebar rows", async ({ page }, testInfo) => {
    const sessionRes = await page.request.get("/api/auth/get-session");
    expect(sessionRes.ok()).toBe(true);
    const session = await sessionRes.json();
    const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
    expect(currentUserId).toBeTruthy();

    const organization = await createOrganization(page, `Messenger-Split-Issues-${Date.now()}`);
    const newerChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Split newer chat",
        summary: "This chat should stay above the split issue.",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(newerChatRes.ok()).toBe(true);
    const newerChat = await newerChatRes.json();

    const olderChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Split older chat",
        summary: "This chat should stay below the split issue.",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(olderChatRes.ok()).toBe(true);
    const olderChat = await olderChatRes.json();

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Split sidebar issue",
        description: "This issue should become its own Messenger sidebar row.",
        status: "todo",
        priority: "medium",
        assigneeUserId: currentUserId,
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json() as { id: string; identifier?: string | null; title: string };
    const issueRef = issue.identifier ?? issue.id;

    const baseTime = Date.parse("2026-05-04T12:00:00.000Z");
    await e2eDb.update(chatConversations)
      .set({
        lastMessageAt: new Date(baseTime + 10 * 60_000),
        updatedAt: new Date(baseTime + 10 * 60_000),
      })
      .where(eq(chatConversations.id, newerChat.id));
    await e2eDb.update(issues)
      .set({
        updatedAt: new Date(baseTime + 5 * 60_000),
      })
      .where(eq(issues.id, issue.id));
    await e2eDb.update(chatConversations)
      .set({
        lastMessageAt: new Date(baseTime),
        updatedAt: new Date(baseTime),
      })
      .where(eq(chatConversations.id, olderChat.id));

    await page.goto("/");
    await page.evaluate(({ orgId }) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, { orgId: organization.id });

    await page.goto(`/${organization.issuePrefix}/messenger`, { waitUntil: "commit" });
    const aggregateIssueRow = page.getByTestId(threadTestId("issues"));
    const splitIssueRow = page.getByTestId(threadTestId(`issue:${issue.id}`));
    const newerChatRow = page.getByTestId(threadTestId(`chat:${newerChat.id}`));
    const olderChatRow = page.getByTestId(threadTestId(`chat:${olderChat.id}`));

    await expect(aggregateIssueRow).toContainText("Issues", { timeout: 15_000 });
    await expect(splitIssueRow).toHaveCount(0);

    await clickMessengerViewCheckbox(page, "Split issue notifications");
    await expect(page.getByText("Threads · Split issues")).toBeVisible({ timeout: 15_000 });
    await expect(aggregateIssueRow).toHaveCount(0);
    await expect(splitIssueRow).toContainText("Split sidebar issue", { timeout: 15_000 });
    await expect(splitIssueRow).toContainText(issueRef);
    await expect(splitIssueRow).toContainText("assigned to me");

    const sidebarThreads = page.locator('[data-testid="workspace-sidebar"] [data-testid^="messenger-thread-"]:not([data-testid="messenger-thread-organization-trigger"])');
    await expect(sidebarThreads).toHaveCount(3);
    await expect(sidebarThreads.nth(0)).toContainText("Split newer chat");
    await expect(sidebarThreads.nth(1)).toContainText("Split sidebar issue");
    await expect(sidebarThreads.nth(2)).toContainText("Split older chat");

    await splitIssueRow.click();
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/issues/${issueRef}$`));
    await page.goto(`/${organization.issuePrefix}/messenger`, { waitUntil: "commit" });
    await expect(splitIssueRow).toBeVisible({ timeout: 15_000 });

    await clickMessengerViewCheckbox(page, "Compact mode");
    await expect(page.getByText("Threads · Compact · Split issues")).toBeVisible({ timeout: 15_000 });
    await expect(splitIssueRow).toContainText("Split sidebar issue");
    await expect(splitIssueRow).not.toContainText("assigned to me");

    await page.screenshot({ path: testInfo.outputPath("messenger-split-issues-desktop.png"), fullPage: true });

    await page.setViewportSize({ width: 768, height: 900 });
    await expect(splitIssueRow).toBeVisible();
    await expect(splitIssueRow).toContainText("Split sidebar issue");
    await expect(splitIssueRow).not.toContainText("assigned to me");
    await page.screenshot({ path: testInfo.outputPath("messenger-split-issues-narrow.png"), fullPage: true });

    await clickMessengerViewCheckbox(page, "Split issue notifications");
    await expect(page.getByText("Threads · Compact")).toBeVisible({ timeout: 15_000 });
    await expect(splitIssueRow).toHaveCount(0);
    await expect(aggregateIssueRow).toContainText("Issues", { timeout: 15_000 });
  });

  test("lets operators label agent-proposed chat issue approvals before approval", async ({ page }) => {
    const organization = await createOrganization(page, `Messenger-Approval-Labels-${Date.now()}`);
    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Labeling Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json();

    const labels = [];
    for (const name of ["Engineering", "Design", "Support", "Docs", "Ops"]) {
      const labelRes = await page.request.post(`/api/orgs/${organization.id}/labels`, {
        data: { name, color: "#2563eb" },
      });
      expect(labelRes.ok()).toBe(true);
      labels.push(await labelRes.json());
    }

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Label approval intake",
        issueCreationMode: "manual_approval",
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json();

    const approvalRes = await page.request.post(`/api/orgs/${organization.id}/approvals`, {
      data: {
        type: "chat_issue_creation",
        payload: {
          chatConversationId: chat.id,
          proposedByAgentId: agent.id,
          proposedIssue: {
            title: "Classify proposed work",
            description: "This agent-created issue needs an operator-selected label.",
            priority: "medium",
          },
        },
      },
    });
    expect(approvalRes.ok()).toBe(true);
    const approval = await approvalRes.json();

    await page.goto(`/${organization.issuePrefix}/messenger/approvals`, { waitUntil: "commit" });
    const approvalCard = page.getByTestId(`messenger-approval-card-${approval.id}`);
    await expect(approvalCard).toContainText("Classify proposed work");
    await expect(approvalCard).toContainText("Required before approval");
    await expect(approvalCard.getByRole("button", { name: "Approve" })).toBeDisabled();
    await expect(approvalCard.getByTestId("chat-issue-approval-label-picker")).toHaveCount(0);

    await approvalCard.getByTestId("chat-issue-label-popover-trigger").click();
    await expect(page.getByText("Issue labels")).toBeVisible();
    await page.getByRole("button", { name: "Engineering" }).click();
    await expect(approvalCard).toContainText("Engineering");
    await expect(approvalCard.getByRole("button", { name: "Approve" })).toBeEnabled();
    await approvalCard.getByRole("button", { name: "Approve" }).click();

    await expect.poll(async () => {
      const approvalStateRes = await page.request.get(`/api/approvals/${approval.id}`);
      const approvalState = await approvalStateRes.json();
      return approvalState.status;
    }).toBe("approved");

    await expect.poll(async () => {
      const linkedRes = await page.request.get(`/api/approvals/${approval.id}/issues`);
      const linkedIssues = await linkedRes.json();
      return linkedIssues[0]?.labelIds ?? [];
    }).toContain(labels[0].id);
  });

  test("keeps approval decision note in the modal review flow and scrolls long approval threads", async ({ page }, testInfo) => {
    const organization = await createOrganization(page, `Messenger-Approval-Modal-${Date.now()}`);

    const approvalRes = await page.request.post(`/api/orgs/${organization.id}/approvals`, {
      data: {
        type: "hire_agent",
        payload: {
          name: "Scrollable approval candidate",
          role: "engineer",
          title: "Founding Engineer",
          capabilities:
            "Own the first wave of delivery while tightening code quality, workflow discipline, and review clarity across the team.",
        },
      },
    });
    expect(approvalRes.ok()).toBe(true);
    const approval = await approvalRes.json();

    for (let index = 0; index < 10; index += 1) {
      const commentRes = await page.request.post(`/api/approvals/${approval.id}/comments`, {
        data: {
          body: `Scrollable approval comment ${index + 1}\n\n- keep the hiring plan concrete\n- explain what should change before approval`,
        },
      });
      expect(commentRes.ok()).toBe(true);
    }

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/approvals/${approval.id}`, { waitUntil: "commit" });

    const dialog = page.getByTestId("approval-detail-dialog");
    const scrollArea = page.getByTestId("approval-detail-scroll-area");

    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("approval-decision-note")).toBeVisible();

    const scrollMetrics = await scrollArea.evaluate((node) => ({
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    }));
    expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);

    await scrollArea.evaluate((node) => {
      node.scrollTo({ top: node.scrollHeight, behavior: "auto" });
    });

    await expect.poll(async () => {
      return await scrollArea.evaluate((node) => node.scrollTop);
    }).toBeGreaterThan(0);

    await expect(page.getByPlaceholder("Add a comment...")).toBeVisible();

    await scrollArea.evaluate((node) => {
      node.scrollTo({ top: 0, behavior: "auto" });
    });
    await expect(page.getByTestId("approval-decision-note")).toBeVisible();

    await page.getByTestId("approval-decision-note").fill("Please tighten the execution scope before resubmitting.");
    await page.getByRole("button", { name: "Request revision" }).click();

    await expect.poll(async () => {
      const approvalStateRes = await page.request.get(`/api/approvals/${approval.id}`);
      const approvalState = await approvalStateRes.json();
      return JSON.stringify({
        status: approvalState.status,
        decisionNote: approvalState.decisionNote,
      });
    }).toBe(JSON.stringify({
      status: "revision_requested",
      decisionNote: "Please tighten the execution scope before resubmitting.",
    }));

    await expect(dialog).toContainText("Please tighten the execution scope before resubmitting.");
    await page.screenshot({
      path: testInfo.outputPath("approval-detail-dialog.png"),
      fullPage: true,
    });
  });

  test("renders issue and approval aggregate threads in chronological order with the latest item at the bottom", async ({ page }) => {
    const organization = await createOrganization(page, `Messenger-Order-${Date.now()}`);

    const olderIssueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Older issue update",
        description: "This should appear above the newer issue in Messenger.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(olderIssueRes.ok()).toBe(true);
    const olderIssue = await olderIssueRes.json();
    await page.waitForTimeout(25);

    const newerIssueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Newer issue update",
        description: "This should appear at the bottom of the issue thread.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(newerIssueRes.ok()).toBe(true);
    const newerIssue = await newerIssueRes.json();

    const olderApprovalRes = await page.request.post(`/api/orgs/${organization.id}/approvals`, {
      data: {
        type: "hire_agent",
        payload: {
          name: "Older approval",
          role: "engineer",
        },
      },
    });
    expect(olderApprovalRes.ok()).toBe(true);
    const olderApproval = await olderApprovalRes.json();
    await page.waitForTimeout(25);

    const newerApprovalRes = await page.request.post(`/api/orgs/${organization.id}/approvals`, {
      data: {
        type: "hire_agent",
        payload: {
          name: "Newer approval",
          role: "engineer",
        },
      },
    });
    expect(newerApprovalRes.ok()).toBe(true);
    const newerApproval = await newerApprovalRes.json();

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/issues`, { waitUntil: "commit" });
    await expect(page.locator("#main-content").getByRole("heading", { name: "Issues" })).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => {
      return await page.locator('[data-testid^="messenger-issue-card-"]').evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-testid")),
      );
    }).toEqual([
      `messenger-issue-card-${olderIssue.id}`,
      `messenger-issue-card-${newerIssue.id}`,
    ]);

    await page.goto(`/${organization.issuePrefix}/messenger/approvals`, { waitUntil: "commit" });
    await expect(page.locator("#main-content").getByRole("heading", { name: "Approvals" })).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => {
      return await page.locator('[data-testid^="messenger-approval-card-"]').evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-testid")),
      );
    }).toEqual([
      `messenger-approval-card-${olderApproval.id}`,
      `messenger-approval-card-${newerApproval.id}`,
    ]);
  });

  test("opens long Messenger issue and approval threads already scrolled to the latest message", async ({ page }) => {
    const organization = await createOrganization(page, `Messenger-Scroll-${Date.now()}`);

    for (let index = 0; index < 10; index += 1) {
      const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
        data: {
          title: `Scrollable issue ${index + 1}`,
          description: `Messenger should open this issue thread at the bottom.\n\n${"More context. ".repeat(20)}`,
          status: "todo",
          priority: "medium",
        },
      });
      expect(issueRes.ok()).toBe(true);
      await page.waitForTimeout(15);
    }

    for (let index = 0; index < 10; index += 1) {
      const approvalRes = await page.request.post(`/api/orgs/${organization.id}/approvals`, {
        data: {
          type: "hire_agent",
          payload: {
            name: `Scrollable approval ${index + 1}`,
            role: "engineer",
            title: `Approval ${index + 1}`,
            capabilities: "Keep Messenger pinned to the latest object update.",
          },
        },
      });
      expect(approvalRes.ok()).toBe(true);
      await page.waitForTimeout(15);
    }

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/issues`, { waitUntil: "commit" });
    await expectMessengerThreadStartsAtBottom(page, "Issues");

    await page.goto(`/${organization.issuePrefix}/messenger/approvals`, { waitUntil: "commit" });
    await expectMessengerThreadStartsAtBottom(page, "Approvals");
  });

  test("tracks created issues in Messenger without requiring a follow", async ({ page }) => {
    const sessionRes = await page.request.get("/api/auth/get-session");
    expect(sessionRes.ok()).toBe(true);
    const session = await sessionRes.json();
    const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
    expect(currentUserId).toBeTruthy();

    const organization = await createOrganization(page, `Messenger-Created-${Date.now()}`);

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Created issue appears in Messenger",
        description: "Creator-owned issues should surface without a manual follow.",
        status: "todo",
        priority: "medium",
        assigneeUserId: currentUserId,
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    const updateRes = await page.request.patch(`/api/issues/${issue.id}`, {
      data: {
        status: "blocked",
      },
    });
    expect(updateRes.ok()).toBe(true);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/issues`, { waitUntil: "commit" });

    const mainContent = page.locator("#main-content");
    await expect(mainContent.getByRole("heading", { name: "Issues" })).toBeVisible({ timeout: 15_000 });
    const issueCard = page.locator(`[data-testid="messenger-issue-card-${issue.id}"]`);
    await expect(issueCard).toContainText("Created issue appears in Messenger");
    await expect(issueCard).toContainText("created by me");
    await expect(issueCard).not.toContainText("assigned to me");
    await expect(issueCard).toContainText("Status changed to blocked");
    await expect(issueCard.locator('[aria-label="Status changed from todo to blocked"]')).toBeVisible();
  });

  test("shows the completed issue title in Messenger issue previews", async ({ page }) => {
    const sessionRes = await page.request.get("/api/auth/get-session");
    expect(sessionRes.ok()).toBe(true);
    const session = await sessionRes.json();
    const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
    expect(currentUserId).toBeTruthy();

    const organization = await createOrganization(page, `Messenger-Completed-Preview-${Date.now()}`);
    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Clarify completed notification",
        description: "The issue notification should name the completed task.",
        status: "todo",
        priority: "medium",
        assigneeUserId: currentUserId,
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();
    const completedAt = new Date();

    await e2eDb
      .update(issues)
      .set({ status: "done", updatedAt: completedAt, completedAt })
      .where(eq(issues.id, issue.id));
    await e2eDb.insert(activityLog).values({
      orgId: organization.id,
      actorType: "agent",
      actorId: randomUUID(),
      action: "issue.updated",
      entityType: "issue",
      entityId: issue.id,
      details: { status: "done", identifier: issue.identifier, _previous: { status: "todo" } },
      createdAt: completedAt,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger`, { waitUntil: "commit" });

    const issuesThread = page.getByTestId(threadTestId("issues"));
    await expect(issuesThread).toBeVisible({ timeout: 15_000 });
    await expect(issuesThread).toContainText("Clarify completed notification");
    await expect(issuesThread).toContainText("Completed");

    await page.goto(`/${organization.issuePrefix}/messenger/issues`, { waitUntil: "commit" });
    const issueCard = page.locator(`[data-testid="messenger-issue-card-${issue.id}"]`);
    await expect(issueCard).toContainText("Clarify completed notification");
    await expect(issueCard).toContainText("Completed");
  });

  test("refreshes the sidebar Issues preview when the Issues feed loads newer content", async ({ page }) => {
    const sessionRes = await page.request.get("/api/auth/get-session");
    expect(sessionRes.ok()).toBe(true);
    const session = await sessionRes.json();
    const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
    expect(currentUserId).toBeTruthy();

    const organization = await createOrganization(page, `Messenger-Issue-Summary-Refresh-${Date.now()}`);
    const olderIssueId = randomUUID();
    const newerIssueId = randomUUID();
    const olderActivityAt = new Date("2026-04-09T09:00:00.000Z");
    const newerActivityAt = new Date("2026-04-10T10:00:00.000Z");

    await e2eDb.insert(issues).values({
      id: olderIssueId,
      orgId: organization.id,
      title: "Old sidebar attention issue",
      status: "todo",
      priority: "medium",
      assigneeUserId: currentUserId,
      createdAt: olderActivityAt,
      updatedAt: olderActivityAt,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger`, { waitUntil: "commit" });
    const issuesThread = page.getByTestId(threadTestId("issues"));
    await expect(issuesThread).toBeVisible({ timeout: 15_000 });
    await expect(issuesThread).toContainText("Old sidebar attention issue");
    await expect(page.getByTestId("messenger-time-issues")).toContainText("Apr 9");

    await e2eDb.insert(issues).values({
      id: newerIssueId,
      orgId: organization.id,
      title: "Latest sidebar-aligned issue",
      status: "in_review",
      priority: "medium",
      createdByUserId: currentUserId,
      createdAt: olderActivityAt,
      updatedAt: newerActivityAt,
    });
    await e2eDb.insert(activityLog).values({
      orgId: organization.id,
      actorType: "user",
      actorId: currentUserId,
      action: "issue.updated",
      entityType: "issue",
      entityId: newerIssueId,
      details: { status: "in_review", _previous: { status: "todo" } },
      createdAt: newerActivityAt,
    });

    await issuesThread.click();
    await expect(page.locator("#main-content").getByRole("heading", { name: "Issues" })).toBeVisible({ timeout: 15_000 });
    const newerIssueCard = page.locator(`[data-testid="messenger-issue-card-${newerIssueId}"]`);
    await expect(newerIssueCard).toContainText("Latest sidebar-aligned issue");
    await expect(newerIssueCard).toContainText("Status changed to in review");
    await expect(issuesThread).toContainText("Latest sidebar-aligned issue");
    await expect(issuesThread).not.toContainText("Old sidebar attention issue");
    await expect(page.getByTestId("messenger-time-issues")).toContainText("Apr 10");
  });

  test("renders failed-run issue titles as links without exposing raw issue ids", async ({ page }, testInfo) => {
    const organization = await createConfiguredOrganization(page, `Messenger-Failed-${Date.now()}`);

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Create your first agent",
        description: "Use this issue to verify failed-run issue links in Messenger.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Ops Runner",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json();

    const olderRunId = randomUUID();
    const newerRunId = randomUUID();
    const olderRunTimestamp = new Date("2026-04-14T02:30:00.000Z");
    const newerRunTimestamp = new Date("2026-04-14T03:45:00.000Z");
    await e2eDb.insert(heartbeatRuns).values([
      {
        id: olderRunId,
        orgId: organization.id,
        agentId: agent.id,
        invocationSource: "manual",
        status: "failed",
        error: "Process exited with code 1.",
        stderrExcerpt: "Agent bootstrap failed before tool execution.",
        contextSnapshot: {
          issueId: issue.id,
          issue: {
            title: issue.title,
          },
        },
        createdAt: olderRunTimestamp,
        updatedAt: olderRunTimestamp,
      },
      {
        id: newerRunId,
        orgId: organization.id,
        agentId: agent.id,
        invocationSource: "manual",
        status: "failed",
        error: "Process exited with code 2.",
        stderrExcerpt: "Agent bootstrap failed again after retry.",
        contextSnapshot: {
          issueId: issue.id,
          issue: {
            title: issue.title,
          },
        },
        createdAt: newerRunTimestamp,
        updatedAt: newerRunTimestamp,
      },
    ]);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/system/failed-runs`, { waitUntil: "commit" });

    const mainContent = page.locator("#main-content");
    await expect(mainContent.getByRole("heading", { name: "Failed runs" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(threadTestId("failed-runs"))).toContainText("Failed runs");
    await expect(page.getByTestId(threadTestId("agent-errors"))).toHaveCount(0);

    const failedRunCards = page.locator('[data-testid^="messenger-system-card-failed-runs-"]');
    await expect(failedRunCards).toHaveCount(2);
    await expect
      .poll(async () => failedRunCards.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-testid"))))
      .toEqual([
        `messenger-system-card-failed-runs-${olderRunId}`,
        `messenger-system-card-failed-runs-${newerRunId}`,
      ]);

    const runCard = page.locator(`[data-testid="messenger-system-card-failed-runs-${olderRunId}"]`);
    await expect(runCard).toContainText("The run hit a system-level execution problem.");
    await expect(runCard).not.toContainText("Process exited with code 1.");
    await expect(runCard).not.toContainText("Agent bootstrap failed before tool execution.");
    const issueLink = runCard.getByTestId(`messenger-failed-run-issue-title-${olderRunId}`);
    await expect(issueLink).toHaveText("Create your first agent");
    await expect(issueLink).toHaveAttribute("href", new RegExp(`/issues/${issue.id}$`));
    await expect(runCard.getByRole("link", { name: "Open issue" })).toHaveCount(0);
    await expect(runCard).not.toContainText(issue.id);

    await runCard.screenshot({
      path: testInfo.outputPath("messenger-failed-run-card.png"),
    });
  });

  test("keeps a new organization Messenger directory empty except for the New chat entry", async ({ page }) => {
    const organization = await createOrganization(page, `Messenger-Empty-${Date.now()}`);

    await page.route("**/api/instance/settings/profile", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          nickname: "Wanhu",
          moreAboutYou: "",
        }),
      });
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/messenger");

    await expect(page).toHaveURL(/\/messenger\/chat$/, { timeout: 15_000 });
    await expect(page.locator(".chat-composer")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".rudder-mdxeditor-content").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "What can I help with, Wanhu?" })).toBeVisible();
    await expect(page.locator('.rudder-mdxeditor [class*="_placeholder_"]')).toHaveText("Ask anything");
    await expect(page.getByRole("button", { name: "Clarify a vague request" })).toBeVisible();
    await expect(page.getByRole("link", { name: "New chat" })).toBeVisible();
    await expect(page.locator('[data-testid="workspace-sidebar"] [data-testid^="messenger-thread-"]')).toHaveCount(0);
    await expect(page.getByTestId(threadTestId("approvals"))).toHaveCount(0);
    await expect(page.getByTestId(threadTestId("issues"))).toHaveCount(0);
  });

  test("expands empty-state prompts into concrete use cases before filling the composer", async ({ page }) => {
    const organization = await createOrganization(page, `Messenger-UseCases-${Date.now()}`);

    await page.route("**/api/instance/settings/profile", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          nickname: "Wanhu",
          moreAboutYou: "",
        }),
      });
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/messenger");

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: "Scope a new feature" }).click();
    const promptOptions = page.getByTestId("chat-empty-state-prompt-options");
    await expect(promptOptions).toBeVisible();
    await expect(promptOptions).toHaveAttribute("data-entered", "true");
    await expect(promptOptions).toHaveClass(/motion-chat-options-pop/);
    await expect(promptOptions).toHaveAttribute("style", /--chat-options-origin-x:\s*22%/);
    await expect(promptOptions).toContainText("Example use cases");
    await expect(promptOptions).toHaveCSS("opacity", "1");
    await expect(page.getByRole("button", { name: "Plan an approval queue for budget overrides" })).toBeVisible();

    await promptOptions.evaluate((element) => {
      element.setAttribute("data-test-remount-marker", "scope");
    });
    await page.getByRole("button", { name: "Turn a chat into an issue" }).click();
    await expect(promptOptions).toHaveAttribute("style", /--chat-options-origin-x:\s*78%/);
    await expect(promptOptions).not.toHaveAttribute("data-test-remount-marker", "scope");
    await expect(page.getByRole("button", { name: "Extract the next shippable task from this discussion" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Plan an approval queue for budget overrides" })).toHaveCount(0);

    await page.getByRole("button", { name: "Scope a new feature" }).click();
    await expect(promptOptions).toHaveAttribute("style", /--chat-options-origin-x:\s*22%/);
    await expect(page.getByRole("button", { name: "Plan an approval queue for budget overrides" })).toBeVisible();

    await page.getByRole("button", { name: "Plan an approval queue for budget overrides" }).click();
    await expect(composer).toContainText("Plan an approval queue for budget overrides");
    await expect(promptOptions).toHaveCount(0);

    await page.getByRole("button", { name: "Clarify a vague request" }).click();
    await expect(promptOptions).toHaveAttribute("data-entered", "true");
    await expect(page.getByRole("button", { name: "Turn rough notes into an implementation plan" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Plan an approval queue for budget overrides" })).toHaveCount(0);
  });

  test("re-enters Messenger at the last opened thread for the same organization", async ({ page }) => {
    const organization = await createOrganization(page, `Messenger-Memory-${Date.now()}`);

    const firstChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Remember me",
        summary: "This should become the remembered Messenger entry.",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(firstChatRes.ok()).toBe(true);
    const firstChat = await firstChatRes.json();

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/messenger/chat");
    await page.getByTestId(threadTestId(`chat:${firstChat.id}`)).click();
    await expect(page).toHaveURL(new RegExp(`/messenger/chat/${firstChat.id}$`), { timeout: 15_000 });

    await page.goto("/messenger");
    await expect(page).toHaveURL(new RegExp(`/messenger/chat/${firstChat.id}$`), { timeout: 15_000 });
    await expect(page.locator("#main-content")).toContainText("No messages yet. Start by describing the work and Rudder will clarify it first.");
  });

  test("opening an unread Messenger chat clears both the thread badge and the rail badge", async ({ page }) => {
    const organization = await createConfiguredOrganization(page, `Messenger-Read-${Date.now()}`);

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Unread chat",
        summary: "Unread badge regression check",
        preferredAgentId: organization.chatAgent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json();

    const sendRes = await page.request.post(`/api/chats/${chat.id}/messages`, {
      data: {
        body: "Create an unread assistant reply for Messenger.",
      },
    });
    expect(sendRes.ok()).toBe(true);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/messenger");

    const chatThread = page.getByTestId(threadTestId(`chat:${chat.id}`));
    await expect(chatThread).toContainText("Unread chat");
    await expect(page.getByTestId(chatUnreadBadgeTestId(chat.id))).toHaveText("1");
    await expect(page.getByTestId("rail-badge-messenger")).toHaveText("1");

    await chatThread.click();
    await expect(page).toHaveURL(new RegExp(`/messenger/chat/${chat.id}$`), { timeout: 15_000 });

    await expect(page.getByTestId(chatUnreadBadgeTestId(chat.id))).toHaveCount(0);
    await expect(page.getByTestId("rail-badge-messenger")).toHaveCount(0);
  });

  test("opening unread Messenger issues clears the issue thread badge and the rail badge", async ({ page }) => {
    const sessionRes = await page.request.get("/api/auth/get-session");
    expect(sessionRes.ok()).toBe(true);
    const session = await sessionRes.json();
    const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
    expect(currentUserId).toBeTruthy();

    const organization = await createOrganization(page, `Messenger-Issue-Read-${Date.now()}`);
    const issueId = randomUUID();
    const activityAt = new Date("2026-05-22T10:00:00.000Z");
    await e2eDb.insert(issues).values({
      id: issueId,
      orgId: organization.id,
      title: "Unread issue thread badge",
      status: "done",
      priority: "medium",
      assigneeUserId: currentUserId,
      identifier: `${organization.issuePrefix}-1`,
      createdAt: new Date("2026-05-22T09:00:00.000Z"),
      updatedAt: activityAt,
      completedAt: activityAt,
    });
    await e2eDb.insert(activityLog).values({
      orgId: organization.id,
      actorType: "agent",
      actorId: "issue-e2e-agent",
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: { status: "done", identifier: `${organization.issuePrefix}-1`, _previous: { status: "in_progress" } },
      createdAt: activityAt,
    });
    const initialBadgesRes = await page.request.get(`/api/orgs/${organization.id}/sidebar-badges`);
    expect(initialBadgesRes.ok()).toBe(true);
    await expect(initialBadgesRes.json()).resolves.toMatchObject({
      inbox: 1,
      unreadTouchedIssues: 1,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/messenger");

    const issueThread = page.getByTestId(threadTestId("issues"));
    await expect(issueThread).toContainText("Issues");
    await expect(issueThread).toContainText("Unread issue thread badge");
    await expect(page.getByTestId("issues-unread-badge")).toHaveText("1");
    await expect(page.getByTestId("rail-badge-messenger")).toHaveText("1");

    await issueThread.click();
    await expect(page).toHaveURL(/\/messenger\/issues$/, { timeout: 15_000 });
    await expect(page.getByTestId(`messenger-issue-card-${issueId}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("issues-unread-badge")).toHaveCount(0);
    await expect(page.getByTestId("rail-badge-messenger")).toHaveCount(0);
    await expect(page.getByTestId(threadTestId("issues"))).toContainText("Unread issue thread badge");
  });

  test("keeps legacy entry points redirecting into Messenger routes", async ({ page }) => {
    const organization = await createOrganization(page, `Messenger-Redirects-${Date.now()}`);

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Redirect chat",
        summary: "Legacy route redirect test",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json();

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/chat");
    await expect(page).toHaveURL(/\/messenger(?:\/|$)/, { timeout: 15_000 });

    await page.goto(`/chat/${chat.id}`, { waitUntil: "commit" });
    await expect(page).toHaveURL(new RegExp(`/messenger/chat/${chat.id}$`), { timeout: 15_000 });

    await page.goto("/inbox");
    await expect(page).toHaveURL(/\/messenger(?:\/|$)/, { timeout: 15_000 });

    await page.goto("/messenger/system/failed-runs");
    await expect(page.locator("#main-content").getByRole("heading", { name: "Failed runs", exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator("#main-content").getByTestId("messenger-panel-header")).not.toContainText(/\b\d+\s+items\b/i);
  });

  test("uses the latest chat reply as the chat preview and keeps Messenger time labels aligned", async ({ page }) => {
    const organization = await createConfiguredOrganization(page, `Messenger-Preview-${Date.now()}`);

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Preview thread",
        summary: "Fallback preview text that should be replaced by the assistant reply.",
        preferredAgentId: organization.chatAgent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json();

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Preview alignment issue",
        description: "Ensure Messenger time labels line up.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();
    const followRes = await page.request.post(`/api/issues/${issue.id}/follow`);
    expect(followRes.ok()).toBe(true);

    const approvalRes = await page.request.post(`/api/orgs/${organization.id}/approvals`, {
      data: {
        type: "budget_override_required",
        payload: {
          scopeName: "Messenger preview alignment",
          budgetAmount: 500,
          observedAmount: 900,
        },
        issueIds: [issue.id],
      },
    });
    expect(approvalRes.ok()).toBe(true);
    const approval = await approvalRes.json();

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/chat/${chat.id}`);

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("Show the latest reply preview");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Streaming reply for chat.", { exact: false }).first()).toBeVisible({ timeout: 15_000 });

    await page.goto("/messenger");

    const chatRow = page.getByTestId(threadTestId(`chat:${chat.id}`));
    await expect(chatRow).toContainText("Streaming reply");
    await expect(chatRow).not.toContainText("Organization default");
    await expect(chatRow).not.toContainText("Fallback preview text that should be replaced by the assistant reply.");

    const [chatTimeBox, issuesTimeBox, approvalsTimeBox] = await Promise.all([
      page.getByTestId(`messenger-time-${`chat-${chat.id}`}`).boundingBox(),
      page.getByTestId("messenger-time-issues").boundingBox(),
      page.getByTestId("messenger-time-approvals").boundingBox(),
    ]);

    expect(chatTimeBox).not.toBeNull();
    expect(issuesTimeBox).not.toBeNull();
    expect(approvalsTimeBox).not.toBeNull();
    expect(Math.abs(chatTimeBox!.x - issuesTimeBox!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(chatTimeBox!.x - approvalsTimeBox!.x)).toBeLessThanOrEqual(1);

    await chatRow.hover();
    await expect(chatRow).toHaveAttribute("title", exactTimestampPattern());

    await page.goto(`/${organization.issuePrefix}/messenger/issues`, { waitUntil: "commit" });
    const issueMessage = page.getByTestId(`messenger-issue-message-${issue.id}`);
    await issueMessage.hover();
    await expect(page.getByTestId(`messenger-issue-message-${issue.id}-timestamp`)).toHaveText(exactTimestampPattern());

    await page.goto(`/${organization.issuePrefix}/messenger/approvals`, { waitUntil: "commit" });
    const approvalMessage = page.getByTestId(`messenger-approval-message-${approval.id}`);
    await approvalMessage.hover();
    await expect(page.getByTestId(`messenger-approval-message-${approval.id}-timestamp`)).toHaveText(exactTimestampPattern());
  });

  test("supports chat pin, archive, and delete actions from Messenger menus", async ({ page }) => {
    const organization = await createOrganization(page, `Messenger-Actions-${Date.now()}`);

    async function createChat(title: string) {
      const res = await page.request.post(`/api/orgs/${organization.id}/chats`, {
        data: {
          title,
          summary: `${title} summary`,
          issueCreationMode: "manual_approval",
          planMode: false,
        },
      });
      expect(res.ok()).toBe(true);
      return res.json();
    }

    const pinChat = await createChat("Pin action chat");
    const archiveChat = await createChat("Archive action chat");
    const deleteChat = await createChat("Delete action chat");
    const sidebarDeleteChat = await createChat("Sidebar delete action chat");

    await page.goto(`/${organization.issuePrefix}/messenger/chat/${pinChat.id}`, { waitUntil: "commit" });
    await page.getByTestId("chat-actions-trigger").click();
    await expect(page.getByRole("menuitem", { name: "Pin Chat" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Archive" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Pin Chat" }).click();
    const pinnedRes = await page.request.get(`/api/chats/${pinChat.id}`);
    expect(pinnedRes.ok()).toBe(true);
    await expect.poll(async () => (await (await page.request.get(`/api/chats/${pinChat.id}`)).json()).isPinned).toBe(true);

    await page.goto(`/${organization.issuePrefix}/messenger/chat/${archiveChat.id}`, { waitUntil: "commit" });
    await page.getByTestId("chat-actions-trigger").click();
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await expect(page).toHaveURL(/\/messenger\/chat(?:\?[^#]*)?$/, { timeout: 15_000 });
    await expect.poll(async () => (await (await page.request.get(`/api/chats/${archiveChat.id}`)).json()).status).toBe("archived");

    await page.goto(`/${organization.issuePrefix}/messenger/chat/${deleteChat.id}`, { waitUntil: "commit" });
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("chat-actions-trigger").click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect(page).toHaveURL(/\/messenger\/chat(?:\?[^#]*)?$/, { timeout: 15_000 });
    await expect.poll(async () => (await page.request.get(`/api/chats/${deleteChat.id}`)).status()).toBe(404);

    await page.goto(`/${organization.issuePrefix}/messenger`, { waitUntil: "commit" });
    const sidebarRow = page.getByTestId(threadTestId(`chat:${sidebarDeleteChat.id}`));
    await expect(sidebarRow).toContainText("Sidebar delete action chat");
    await sidebarRow.hover();
    await sidebarRow.getByRole("button", { name: "Chat actions" }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect.poll(async () => (await page.request.get(`/api/chats/${sidebarDeleteChat.id}`)).status()).toBe(404);
    await expect(sidebarRow).toHaveCount(0);
  });
});
