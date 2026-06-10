import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { eq } from "../../packages/db/node_modules/drizzle-orm/index.js";
import { createDb, heartbeatRuns, issues } from "../../packages/db/src/index.ts";
import { E2E_CODEX_STUB, E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

async function createStreamingOrg(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name,
    },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json();
}

async function createStreamingAgent(page: Page, orgId: string, name: string) {
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
  return agentRes.json();
}

function currentChatId(pageUrl: string) {
  const chatId = new URL(pageUrl).pathname.split("/").pop();
  expect(chatId).toBeTruthy();
  return chatId!;
}

function threadTestId(threadKey: string) {
  return `messenger-thread-${threadKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function threadUnreadBadgeTestId(threadKey: string) {
  return `${threadKey.replace(/[^a-zA-Z0-9_-]/g, "-")}-unread-badge`;
}

test("can stop and delete a Messenger sidebar chat while a reply is generating", async ({ page }) => {
  const organization = await createStreamingOrg(page, `Sidebar-Generating-${Date.now()}`);
  const agent = await createStreamingAgent(page, organization.id, "Sidebar Operator");
  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Generating sidebar actions",
      preferredAgentId: agent.id,
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

  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("Keep sidebar actions available");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByRole("button", { name: "Stop streaming" })).toBeVisible({ timeout: 15_000 });
  const chatId = currentChatId(page.url());
  const threadRow = page.getByTestId(`messenger-thread-chat-${chatId}`);
  const actionButton = threadRow.getByRole("button", { name: "Chat actions" });
  const generatingIcon = threadRow.getByTestId(`messenger-generating-chat-${chatId}`);

  await expect(threadRow).toBeVisible({ timeout: 15_000 });
  await expect(generatingIcon).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => actionButton.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
  await expect.poll(() => generatingIcon.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");

  await threadRow.hover();

  await expect.poll(() => actionButton.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  await expect.poll(() => generatingIcon.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
  await actionButton.click();
  await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
  const deleteItem = page.getByRole("menuitem", { name: "Delete" });
  await expect(deleteItem).toBeEnabled();
  page.once("dialog", (dialog) => dialog.accept());
  await deleteItem.click();
  await expect.poll(async () => (await page.request.get(`/api/chats/${chatId}`)).status()).toBe(404);
  await expect(threadRow).toHaveCount(0);
});

test("shows an active split issue run on the right without replacing the compact status icon", async ({ page }) => {
  const sessionRes = await page.request.get("/api/auth/get-session");
  expect(sessionRes.ok()).toBe(true);
  const session = await sessionRes.json();
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  expect(currentUserId).toBeTruthy();

  const organization = await createStreamingOrg(page, `Sidebar-Issue-Active-Run-${Date.now()}`);
  const agent = await createStreamingAgent(page, organization.id, "Issue Runner");
  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Keep issue status visible",
      description: "The active run affordance should sit on the trailing edge.",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agent.id,
      assigneeUserId: currentUserId,
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; title: string };

  const runId = randomUUID();
  const now = new Date("2026-06-10T03:55:00.000Z");
  await e2eDb.insert(heartbeatRuns).values({
    id: runId,
    orgId: organization.id,
    agentId: agent.id,
    invocationSource: "assignment",
    triggerDetail: "system",
    status: "running",
    startedAt: now,
    contextSnapshot: {
      issueId: issue.id,
      issue: { id: issue.id, title: issue.title, status: "in_progress", priority: "medium" },
    },
    createdAt: now,
    updatedAt: now,
  });
  await e2eDb
    .update(issues)
    .set({
      executionRunId: runId,
      executionLockedAt: now,
      updatedAt: now,
    })
    .where(eq(issues.id, issue.id));

  const threadKey = `issue:${issue.id}`;
  await page.addInitScript(({ orgId }) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    window.localStorage.setItem("rudder.messengerSplitIssueNotificationsByOrg", JSON.stringify({ [orgId]: true }));
  }, { orgId: organization.id });

  await page.goto(`/${organization.issuePrefix}/messenger`, { waitUntil: "commit" });

  const threadRow = page.getByTestId(threadTestId(threadKey));
  const statusIcon = threadRow.locator('[data-slot="status-progress-arc"]');
  const unreadBadge = page.getByTestId(threadUnreadBadgeTestId(threadKey));
  const activeRunIcon = threadRow.getByTestId(`messenger-active-run-issue-${issue.id}`);
  const timeLabel = threadRow.getByTestId(`messenger-time-issue-${issue.id}`);
  const actionButton = threadRow.getByRole("button", { name: "Thread actions" });

  await expect(threadRow).toContainText(issue.title, { timeout: 15_000 });
  await expect(statusIcon).toBeVisible();
  await expect(unreadBadge).toHaveText("1");
  await expect(activeRunIcon).toBeVisible();
  await expect.poll(() => activeRunIcon.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  await expect.poll(() => timeLabel.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
  await expect.poll(() => actionButton.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");

  await threadRow.hover();
  await expect.poll(() => actionButton.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  await expect.poll(() => activeRunIcon.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
  await actionButton.click();
  await expect(page.getByRole("menuitem", { name: "Pin" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Hide" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.mouse.move(0, 0);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await expect.poll(() => actionButton.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
  await expect.poll(() => activeRunIcon.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");

  await actionButton.focus();
  await expect.poll(() => actionButton.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  await expect.poll(() => activeRunIcon.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
});
