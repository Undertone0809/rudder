import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createDb, heartbeatRuns } from "../../packages/db/src/index.ts";
import { E2E_CODEX_STUB, E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

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
      defaultChatAgentRuntimeType: "codex_local",
      defaultChatAgentRuntimeConfig: {
        model: "gpt-5.4",
        command: E2E_CODEX_STUB,
      },
    },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json();
}

function threadTestId(threadKey: string) {
  return `messenger-thread-${threadKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function chatUnreadBadgeTestId(chatId: string) {
  return `${`chat:${chatId}`.replace(/[^a-zA-Z0-9_-]/g, "-")}-unread-badge`;
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

test.describe("Messenger unified threads contract", () => {
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

  test("renders the mixed Messenger directory and supports issue + approval actions", async ({ page }, testInfo) => {
    const sessionRes = await page.request.get("/api/auth/get-session");
    expect(sessionRes.ok()).toBe(true);
    const session = await sessionRes.json();
    const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
    expect(currentUserId).toBeTruthy();

    const organization = await createOrganization(page, `Messenger-${Date.now()}`);

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Messenger intake",
        summary: "Clarify, route, and keep the conversation lightweight.",
        issueCreationMode: "manual_approval",
        planMode: false,
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

    const approvalRes = await page.request.post(`/api/orgs/${organization.id}/approvals`, {
      data: {
        type: "budget_override_required",
        payload: {
          scopeName: "Messenger contract test",
          budgetAmount: 1200,
          observedAmount: 1800,
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

    const sidebarThreads = page.locator('[data-testid="workspace-sidebar"] [data-testid^="messenger-thread-"]');
    await expect(sidebarThreads).toHaveCount(3, { timeout: 15_000 });
    await expect(page.getByTestId(threadTestId("approvals"))).toContainText("Approvals");
    await expect(page.getByTestId(threadTestId("issues"))).toContainText("Cross-issue activity feed");
    await expect(page.getByTestId(threadTestId(`chat:${chat.id}`))).toContainText("Messenger intake");
    await expect(sidebarThreads.nth(0)).toContainText("Approvals");
    await expect(sidebarThreads.nth(1)).toContainText("Issues");
    await expect(sidebarThreads.nth(2)).toContainText("Messenger intake");
    await expect(page.getByTestId("approvals-unread-badge")).toHaveText("1");
    await expect(page.getByTestId("issues-unread-badge")).toHaveText("1");
    await expect(page.getByTestId("rail-badge-messenger")).toHaveText("2");
    await expect(page.getByTestId("rail-badge-messenger")).toHaveClass(/bg-red-500/);

    await page.goto(`/${organizationPrefix}/messenger/issues`, { waitUntil: "commit" });
    await expect(mainContent.getByRole("heading", { name: "Issues" })).toBeVisible({ timeout: 15_000 });
    await expect(mainContent.getByTestId("messenger-panel-header")).not.toContainText(/\b\d+\s+unread\b/i);
    const issueCard = page.locator(`[data-testid="messenger-issue-card-${issue.id}"]`);
    await issueCard.getByRole("button", { name: "Quick comment" }).click();
    await issueCard.getByPlaceholder("Add a quick comment").fill("Quick comment from Messenger contract test.");
    await issueCard.getByRole("button", { name: "Comment" }).click();

    await expect.poll(async () => {
      const commentsRes = await page.request.get(`/api/issues/${issue.id}/comments`);
      const comments = await commentsRes.json();
      return comments.some((comment: { body: string }) => comment.body.includes("Quick comment from Messenger contract test."));
    }).toBe(true);

    const openIssueLink = issueCard.getByRole("link", { name: "Open issue" });
    await expect(openIssueLink).toHaveAttribute(
      "href",
      new RegExp(`/issues/${issue.identifier ?? issue.id}$`),
    );
    await expect(issueCard.getByRole("button", { name: "Assign to me" })).toHaveCount(0);
    await expect(issueCard.getByRole("button", { name: "Unassign me" })).toHaveCount(0);

    await page.goto(`/${organizationPrefix}/messenger/approvals`, { waitUntil: "commit" });
    await expect(mainContent.getByRole("heading", { name: "Approvals" })).toBeVisible({ timeout: 15_000 });
    await expect(mainContent.getByTestId("messenger-panel-header")).not.toContainText(/\b\d+\s+(?:pending|total)\b/i);
    await page.getByRole("link", { name: "Open full approval" }).click();
    await expect(page).toHaveURL(new RegExp(`/${organizationPrefix}/messenger/approvals/${approval.id}(?:\\?[^#]*)?$`));
    await expect(page.getByTestId("approval-detail-dialog")).toBeVisible();
    await expect(page.getByTestId("approval-detail-dialog")).toContainText("Messenger contract test");
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
});
