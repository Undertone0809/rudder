import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_DATABASE_URL } from "./support/e2e-env";

test.use({ serviceWorkers: "block" });

const e2eDb = createDb(E2E_DATABASE_URL);

function buildIssueMentionHref(issueId: string) {
  return `issue://${issueId}`;
}

async function createOrganization(page: Page) {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Issue-Mention-Status-Icons-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json() as Promise<{ id: string; issuePrefix: string }>;
}

async function selectOrganization(page: Page, organizationId: string) {
  await page.goto("/");
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, organizationId);
}

async function createIssue(
  page: Page,
  organizationId: string,
  title: string,
  status = "todo",
  priority = "medium",
) {
  const issueRes = await page.request.post(`/api/orgs/${organizationId}/issues`, {
    data: {
      title,
      description: `${title} description`,
      status,
      priority,
      ...(status === "in_progress" ? { assigneeUserId: "local-board" } : {}),
    },
  });
  expect(issueRes.ok(), await issueRes.text()).toBe(true);
  return issueRes.json() as Promise<{ id: string; identifier: string | null; title: string; status: string }>;
}

async function expectEditorIssueStatusMention(root: Locator, issueId: string, status: string) {
  const anchor = root.locator(`a[href^="issue://${issueId}"]`).first();
  await expect(anchor).toBeVisible({ timeout: 15_000 });

  const statusSummary = await anchor.evaluate((element) => {
    const anchorElement = element as HTMLElement;
    const statusSelector = '.rudder-mention-chip--with-status-icon[data-mention-kind="issue"]';
    const statusElements = [
      ...(anchorElement.matches(statusSelector) ? [anchorElement] : []),
      ...Array.from(anchorElement.querySelectorAll<HTMLElement>(statusSelector)),
    ];
    return {
      statusCount: statusElements.length,
      nestedStatusCount: anchorElement.querySelectorAll(`${statusSelector} ${statusSelector}`).length,
    };
  });
  expect(statusSummary.statusCount).toBe(1);
  expect(statusSummary.nestedStatusCount).toBe(0);

  const visualChip = anchor.locator('.rudder-mention-chip--with-status-icon[data-mention-kind="issue"]').first();
  await expect(visualChip).toBeVisible();
  await expect(visualChip).toHaveAttribute("data-mention-status", status);

  const beforeStyle = await visualChip.evaluate((element) => {
    const style = window.getComputedStyle(element, "::before");
    return {
      content: style.content,
      display: style.display,
      maskImage: style.getPropertyValue("-webkit-mask-image") || style.getPropertyValue("mask-image"),
    };
  });
  expect(beforeStyle.content).not.toBe("none");
  expect(beforeStyle.display).not.toBe("none");
  expect(beforeStyle.maskImage).not.toBe("none");
  expect(beforeStyle.maskImage).not.toContain("viewBox='0 0 24 24'");

  if (status === "done") {
    const afterStyle = await visualChip.evaluate((element) => {
      const style = window.getComputedStyle(element, "::after");
      return {
        content: style.content,
        display: style.display,
        background: style.backgroundColor,
        maskImage: style.getPropertyValue("-webkit-mask-image") || style.getPropertyValue("mask-image"),
      };
    });
    expect(afterStyle.content).not.toBe("none");
    expect(afterStyle.display).not.toBe("none");
    expect(afterStyle.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(afterStyle.maskImage).not.toBe("none");
  }
}

test("issue mentions render the canonical status icon across read-only and editor surfaces", async ({ page }) => {
  const organization = await createOrganization(page);
  const targetIssue = await createIssue(page, organization.id, "Status chip target issue", "done");
  const targetRef = targetIssue.identifier ?? targetIssue.id;
  const hostIssue = await createIssue(page, organization.id, "Status chip host issue", "todo");
  const hostRef = hostIssue.identifier ?? hostIssue.id;
  const issueMentionHref = buildIssueMentionHref(targetIssue.id);

  for (let index = 0; index < 40; index += 1) {
    await createIssue(
      page,
      organization.id,
      `Critical editor catalog issue ${String(index + 1).padStart(2, "0")}`,
      "todo",
      "critical",
    );
  }

  const catalogRes = await page.request.get(`/api/orgs/${organization.id}/issues?limit=40`);
  expect(catalogRes.ok(), await catalogRes.text()).toBe(true);
  const catalog = await catalogRes.json() as Array<{ id: string }>;
  expect(catalog).toHaveLength(40);
  expect(catalog.some((issue) => issue.id === targetIssue.id)).toBe(false);

  const commentRes = await page.request.post(`/api/issues/${hostIssue.id}/comments`, {
    data: {
      body: [
        "- 自动化 issue 列表正文里已经完成 ",
        `[${targetRef}](${issueMentionHref})`,
        "，这里继续显示后续中文 prose，不能被蓝色圆圈勾打断。",
      ].join(""),
    },
  });
  expect(commentRes.ok(), await commentRes.text()).toBe(true);
  const comment = await commentRes.json() as { id: string };

  const filePath = `docs/status-chip-${Date.now()}.md`;
  const fileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
    data: {
      filePath,
      content: `# Status Chip\n\nLibrary editor mention: [${targetRef}](${issueMentionHref})\n`,
    },
  });
  expect(fileRes.ok(), await fileRes.text()).toBe(true);

  await selectOrganization(page, organization.id);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(filePath)}`);
  const libraryEditor = page.getByTestId("org-workspaces-markdown-editor").locator(".ProseMirror");
  await expect(libraryEditor).toBeVisible({ timeout: 15_000 });
  await expectEditorIssueStatusMention(libraryEditor, targetIssue.id, "done");

  await page.goto(`/${organization.issuePrefix}/issues/${hostRef}`);

  const renderedCommentChip = page.locator(`#comment-${comment.id} a.rudder-mention-chip[data-mention-kind="issue"]`).first();
  await expect(renderedCommentChip).toBeVisible({ timeout: 15_000 });
  await expect(renderedCommentChip).toHaveAttribute("data-mention-status", "done");
  await expect(renderedCommentChip).toHaveClass(/rudder-mention-chip--with-status-icon/);
  await expect(renderedCommentChip.locator('[data-slot="issue-status-icon"]')).toHaveCount(0);
  const renderedCommentBeforeStyle = await renderedCommentChip.evaluate((element) => {
    const style = window.getComputedStyle(element, "::before");
    return {
      content: style.content,
      maskImage: style.getPropertyValue("-webkit-mask-image") || style.getPropertyValue("mask-image"),
    };
  });
  expect(renderedCommentBeforeStyle.content).not.toBe("none");
  expect(renderedCommentBeforeStyle.maskImage).not.toBe("none");

  const composer = page.locator('.rudder-milkdown-scope .ProseMirror[contenteditable="true"]').last();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await composer.click();
  await page.evaluate((markdown) => navigator.clipboard.writeText(markdown), `[${targetRef}](${issueMentionHref})`);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
  await expectEditorIssueStatusMention(composer, targetIssue.id, "done");
});

test("Messenger resolves issue status when the reference is outside the bounded mention catalog", async ({ page }, testInfo) => {
  const organization = await createOrganization(page);
  await createE2EChatAgent(page.request, organization.id, { name: "Mention Agent" });
  const targetIssue = await createIssue(
    page,
    organization.id,
    "深度分析一下你今天这些 agent run 中遇到的各种报错和困难，优化系统",
    "in_progress",
    "medium",
  );
  const targetRef = targetIssue.identifier ?? targetIssue.id;

  for (let index = 0; index < 40; index += 1) {
    await createIssue(
      page,
      organization.id,
      `Critical catalog issue ${String(index + 1).padStart(2, "0")}`,
      "todo",
      "critical",
    );
  }

  const catalogRes = await page.request.get(`/api/orgs/${organization.id}/issues?limit=40`);
  expect(catalogRes.ok(), await catalogRes.text()).toBe(true);
  const catalog = await catalogRes.json() as Array<{ id: string }>;
  expect(catalog).toHaveLength(40);
  expect(catalog.some((issue) => issue.id === targetIssue.id)).toBe(false);

  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Issue status fallback chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    },
  });
  expect(chatRes.ok(), await chatRes.text()).toBe(true);
  const chat = await chatRes.json() as { id: string };
  await e2eDb.insert(chatMessages).values({
    id: randomUUID(),
    orgId: organization.id,
    conversationId: chat.id,
    role: "user",
    kind: "message",
    status: "completed",
    body: [
      "总结一下，这个任务都在做些啥？ ",
      `[${targetRef} ${targetIssue.title}](issue://${targetIssue.id}?r=${targetRef})`,
    ].join(""),
    structuredPayload: null,
    replyingAgentId: null,
    chatTurnId: randomUUID(),
    turnVariant: 0,
  });

  await selectOrganization(page, organization.id);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

  const message = page.getByTestId("chat-user-message-bubble").last();
  await expect(message).toContainText("总结一下，这个任务都在做些啥？", { timeout: 15_000 });
  const issueMention = message.locator(`a[data-mention-kind="issue"][href*="${targetIssue.id}"]`);
  await expect(issueMention).toBeVisible();
  await expect(issueMention).toHaveAttribute("data-mention-status", "in_progress");
  await expect(issueMention).toHaveClass(/rudder-mention-chip--with-status-icon/);

  const iconStyle = await issueMention.evaluate((element) => {
    const style = window.getComputedStyle(element, "::before");
    return {
      content: style.content,
      display: style.display,
      maskImage: style.getPropertyValue("-webkit-mask-image") || style.getPropertyValue("mask-image"),
    };
  });
  expect(iconStyle.content).not.toBe("none");
  expect(iconStyle.display).not.toBe("none");
  expect(iconStyle.maskImage).not.toBe("none");

  await page.screenshot({
    path: testInfo.outputPath("messenger-out-of-catalog-issue-status.png"),
    fullPage: false,
  });
});
