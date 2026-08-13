import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB, E2E_DATABASE_URL } from "./support/e2e-env";

const AVATAR = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

test.describe("Current user avatar", () => {
  test("uses the signed-in account avatar across Issue identities", async ({ page }, testInfo) => {
    await page.addInitScript(({ image }) => {
      const account = { id: "desktop-account", email: "zee@rudderhq.dev", name: "Zee", image };
      const state = { status: "signed-in", account, deviceId: "avatar-e2e-device" };
      Object.defineProperty(window, "desktopIdentity", {
        configurable: true,
        value: {
          getState: async () => state,
          signOut: async () => ({ status: "signed-out" }),
          listDeviceSessions: async () => [],
          getProfile: async () => account,
          updateProfile: async ({ image: nextImage }: { image: string | null }) => ({ ...account, image: nextImage }),
          onStateChanged: () => () => undefined,
        },
      });
    }, { image: AVATAR });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    const sessionRes = await page.request.get("/api/auth/get-session");
    expect(sessionRes.ok()).toBe(true);
    const session = await sessionRes.json();
    const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
    expect(currentUserId).toBeTruthy();

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Current-User-Avatar-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Current user identity uses the account avatar",
        status: "todo",
        priority: "medium",
        assigneeUserId: currentUserId,
        reviewerUserId: currentUserId,
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json() as { id: string; identifier?: string | null };
    const commentRes = await page.request.post(`/api/issues/${issue.id}/comments`, {
      data: { body: "Current user comment with the same avatar." },
    });
    expect(commentRes.ok()).toBe(true);
    const comment = await commentRes.json() as { id: string };

    await page.goto(`/issues/${issue.identifier ?? issue.id}`);
    const properties = page.getByRole("region", { name: "Issue properties" });
    await expect(properties).toBeVisible();
    await expect(properties.locator(`[data-avatar-url="${AVATAR}"]`)).toHaveCount(3);
    await expect(properties.locator(`img[src="${AVATAR}"]`)).toHaveCount(3);
    const activityTimeline = page.getByRole("region", { name: "Issue activity timeline" });
    await expect(activityTimeline.locator(`img[src="${AVATAR}"]`)).toHaveCount(1);

    const assigneeButton = properties.getByText("Assignee", { exact: true }).locator("..").getByRole("button", { name: "Me Me", exact: true });
    await assigneeButton.click();
    await expect(page.locator('[data-slot="assignee-self-action-label"]')).toHaveAttribute("data-slot", "assignee-self-action-label");
    await expect(page.locator('[data-slot="assignee-self-action-label"] img')).toHaveAttribute("src", AVATAR);
    await page.keyboard.press("Escape");

    await page.goto(`/${organization.issuePrefix}/issues`);
    await page.getByTitle("Board view").click();
    const boardCard = page.locator('[data-testid^="kanban-card-"]').filter({ hasText: "Current user identity uses the account avatar" });
    await expect(boardCard).toBeVisible();
    await expect(boardCard.locator(`[data-avatar-url="${AVATAR}"]`)).toHaveCount(2);

    await page.getByTestId("workspace-main-header").getByRole("button", { name: "Create Issue" }).click();
    const newIssueDialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await expect(newIssueDialog).toBeVisible();
    await newIssueDialog.getByRole("button", { name: "No assignee", exact: true }).click();
    await expect(newIssueDialog.locator(`[data-avatar-url="${AVATAR}"]`)).toHaveCount(1);
    await page.keyboard.press("Escape");
    await newIssueDialog.getByRole("button", { name: "No reviewer", exact: true }).click();
    await expect(newIssueDialog.locator(`[data-avatar-url="${AVATAR}"]`)).toHaveCount(1);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    const agent = await createE2EChatAgent(page.request, organization.id, {
      name: "Avatar E2E Agent",
      command: E2E_CODEX_STUB,
    });
    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Current user avatar Chat coverage",
        preferredAgentId: agent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
        initialMessage: { body: "Show current-user identity surfaces." },
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json() as { id: string };
    await e2eDb.insert(chatMessages).values([
      {
        id: randomUUID(),
        orgId: organization.id,
        conversationId: chat.id,
        role: "assistant",
        kind: "issue_proposal",
        status: "completed",
        body: "Review this current-user proposal.",
        structuredPayload: {
          issueProposal: {
            title: "Avatar proposal",
            description: "Current user remains recognizable in Chat.",
            priority: "medium",
            assigneeUserId: currentUserId,
            reviewerUserId: currentUserId,
          },
        },
        replyingAgentId: null,
        chatTurnId: randomUUID(),
        turnVariant: 0,
      },
      {
        id: randomUUID(),
        orgId: organization.id,
        conversationId: chat.id,
        role: "assistant",
        kind: "message",
        status: "completed",
        body: "Current-user rich references.",
        structuredPayload: {
          richReferences: [
            { type: "issue", issueId: issue.id, identifier: issue.identifier, display: "card" },
            { type: "issue_comment", issueId: issue.id, identifier: issue.identifier, commentId: comment.id, display: "card" },
          ],
        },
        replyingAgentId: null,
        chatTurnId: randomUUID(),
        turnVariant: 0,
      },
    ]);

    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);
    await expect(page.getByTestId("proposal-review-block").locator(`[data-avatar-url="${AVATAR}"]`)).toHaveCount(2);
    await expect(page.getByTestId("chat-rich-references").locator(`[data-avatar-url="${AVATAR}"]`)).toHaveCount(2);

    await page.screenshot({ path: testInfo.outputPath("current-user-avatar-desktop.png"), fullPage: false });
    await page.goto(`/issues/${issue.identifier ?? issue.id}`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("issue-detail-heading").getByRole("button", { name: "Properties", exact: true }).click();
    const mobileProperties = page.getByRole("dialog", { name: "Properties" });
    await expect(mobileProperties.locator(`img[src="${AVATAR}"]`)).toHaveCount(3);
    await page.screenshot({ path: testInfo.outputPath("current-user-avatar-mobile.png"), fullPage: false });
  });

  test("shows the fallback when the account avatar fails to load", async ({ page }) => {
    const brokenAvatar = "https://avatar.invalid/current-user.png";
    await page.addInitScript(({ image }) => {
      const account = { id: "desktop-account", email: "zee@rudderhq.dev", name: "Zee", image };
      const state = { status: "signed-in", account, deviceId: "avatar-e2e-device" };
      Object.defineProperty(window, "desktopIdentity", {
        configurable: true,
        value: {
          getState: async () => state,
          signOut: async () => ({ status: "signed-out" }),
          listDeviceSessions: async () => [],
          getProfile: async () => account,
          updateProfile: async () => account,
          onStateChanged: () => () => undefined,
        },
      });
    }, { image: brokenAvatar });
    await page.route(brokenAvatar, (route) => route.abort("failed"));
    await page.goto("/");
    const sessionRes = await page.request.get("/api/auth/get-session");
    const session = await sessionRes.json();
    const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
    const orgRes = await page.request.post("/api/orgs", { data: { name: `Broken-Avatar-${Date.now()}` } });
    const organization = await orgRes.json() as { id: string };
    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: { title: "Broken avatar fallback", status: "todo", priority: "medium", assigneeUserId: currentUserId },
    });
    const issue = await issueRes.json() as { id: string; identifier?: string | null };

    await page.goto(`/issues/${issue.identifier ?? issue.id}`);
    const assignee = page.getByRole("region", { name: "Issue properties" }).getByRole("button", { name: "Me", exact: true });
    await expect(assignee.locator('[data-slot="avatar-fallback"]')).toBeVisible();
    await expect(assignee.locator('[data-slot="avatar-image"]')).toHaveCount(0);
  });
});
