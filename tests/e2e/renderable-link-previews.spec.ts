import { expect, test, type Locator, type Page } from "@playwright/test";

test.use({ serviceWorkers: "block" });

function buildProjectMentionHref(projectId: string, color?: string | null) {
  void color;
  return `project://${projectId}`;
}

function buildAutomationMentionHref(automationId: string, title: string) {
  void title;
  return `automation://${automationId}`;
}

function buildLibraryDocMentionHref(documentId: string, title: string) {
  void title;
  return `library-doc://${documentId}`;
}

function buildLibraryFileMentionHref(filePath: string, title: string) {
  void title;
  return `library-file://file?p=${encodeURIComponent(filePath)}`;
}

async function createOrganization(page: Page) {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Renderable-Link-Previews-${Date.now()}` },
  });
  expect(orgRes.ok(), await orgRes.text()).toBe(true);
  return orgRes.json() as Promise<{ id: string; issuePrefix: string }>;
}

async function expectPreviewFor(link: Locator, text: string) {
  await expect(link).toBeVisible({ timeout: 15_000 });
  await link.hover();
  await expect(link.page().locator(".rudder-entity-preview-card").filter({ hasText: text })).toBeVisible({ timeout: 15_000 });
}

async function expectPreviewIconFor(link: Locator, selector: string, text: string) {
  await expect(link).toBeVisible({ timeout: 15_000 });
  await link.hover();
  const card = link.page().locator(".rudder-entity-preview-card").filter({ hasText: text });
  await expect(card.locator(selector).first()).toBeVisible({ timeout: 15_000 });
  return card;
}

test("renderable entity links show hover previews except non-previewable links", async ({ page }) => {
  const organization = await createOrganization(page);

  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Preview Agent",
      role: "engineer",
      title: "Preview engineer",
      capabilities: "Handles entity preview validation.",
      agentRuntimeType: "process",
      agentRuntimeConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
    },
  });
  expect(agentRes.ok(), await agentRes.text()).toBe(true);
  const agent = await agentRes.json() as { id: string; name: string };

  const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
    data: {
      name: "Preview project",
      description: "Project preview summary from the real project API.",
      status: "in_progress",
    },
  });
  expect(projectRes.ok(), await projectRes.text()).toBe(true);
  const project = await projectRes.json() as { id: string; name: string; color: string | null };

  const automationRes = await page.request.post(`/api/orgs/${organization.id}/automations`, {
    data: {
      title: "Preview automation",
      description: "Automation preview target from the real automation API.",
      projectId: project.id,
      assigneeAgentId: agent.id,
      priority: "medium",
    },
  });
  expect(automationRes.ok(), await automationRes.text()).toBe(true);
  const automation = await automationRes.json() as { id: string; title: string };

  const targetIssueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Preview target issue",
      description: "Issue preview summary from the real issue API.",
      status: "todo",
      priority: "high",
      projectId: project.id,
      assigneeAgentId: agent.id,
    },
  });
  expect(targetIssueRes.ok(), await targetIssueRes.text()).toBe(true);
  const targetIssue = await targetIssueRes.json() as { id: string; identifier: string | null; title: string };
  const targetIssueRef = targetIssue.identifier ?? targetIssue.id;

  const targetCommentRes = await page.request.post(`/api/issues/${targetIssue.id}/comments`, {
    data: {
      body: "Comment preview body from the real comments API, not the parent issue metadata.",
    },
  });
  expect(targetCommentRes.ok(), await targetCommentRes.text()).toBe(true);
  const targetComment = await targetCommentRes.json() as { id: string };

  const libraryDocRes = await page.request.post(`/api/orgs/${organization.id}/library/documents`, {
    data: {
      title: "Preview library doc",
      body: "# Preview library doc\n\nLibrary document preview summary from the real document API.",
    },
  });
  expect(libraryDocRes.ok(), await libraryDocRes.text()).toBe(true);
  const libraryDoc = await libraryDocRes.json() as { id: string; title: string };

  const filePath = `docs/renderable-preview-${Date.now()}.md`;
  const libraryFileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
    data: {
      filePath,
      content: "# Preview workspace file\n\nWorkspace file preview summary from the real workspace API.",
    },
  });
  expect(libraryFileRes.ok(), await libraryFileRes.text()).toBe(true);
  const fileName = filePath.split("/").at(-1) ?? filePath;

  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Preview chat should not show a hover card",
      preferredAgentId: agent.id,
    },
  });
  expect(chatRes.ok(), await chatRes.text()).toBe(true);
  const chat = await chatRes.json() as { id: string };

  const hostIssueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Renderable link preview host",
      description: [
        `[${targetIssueRef}](issue://${targetIssue.id})`,
        `[${agent.name}](agent://${agent.id})`,
        `[${automation.title}](${buildAutomationMentionHref(automation.id, automation.title)})`,
        `[${project.name}](${buildProjectMentionHref(project.id, project.color)})`,
        `[${libraryDoc.title}](${buildLibraryDocMentionHref(libraryDoc.id, libraryDoc.title)})`,
        `[${fileName}](${buildLibraryFileMentionHref(filePath, fileName)})`,
        `[Target comment](issue://${targetIssue.id}?c=${targetComment.id})`,
        `[Preview chat](chat://${chat.id})`,
      ].join(" "),
      status: "todo",
      priority: "medium",
    },
  });
  expect(hostIssueRes.ok(), await hostIssueRes.text()).toBe(true);
  const hostIssue = await hostIssueRes.json() as { identifier: string | null; id: string };
  const hostIssueRef = hostIssue.identifier ?? hostIssue.id;

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${organization.issuePrefix}/issues/${hostIssueRef}`);

  const issueLink = page.locator('a.rudder-mention-chip[data-mention-kind="issue"]').filter({ hasText: targetIssueRef }).first();
  const agentLink = page.locator('a.rudder-mention-chip[data-mention-kind="agent"]').filter({ hasText: agent.name }).first();
  const automationLink = page.locator('a.rudder-mention-chip[data-mention-kind="automation"]').filter({ hasText: automation.title }).first();
  const projectLink = page.locator('a.rudder-mention-chip[data-mention-kind="project"]').filter({ hasText: project.name }).first();
  const libraryDocLink = page.locator('a.rudder-mention-chip[data-mention-kind="library_doc"]').filter({ hasText: libraryDoc.title }).first();
  const libraryFileLink = page.locator('a.rudder-mention-chip[data-mention-kind="library_file"]').filter({ hasText: fileName }).first();
  const issueCommentLink = page.locator('a.rudder-mention-chip[data-mention-kind="issue"]').filter({ hasText: "Target comment" }).first();
  const chatLink = page.locator('a.rudder-mention-chip[data-mention-kind="chat"]').filter({ hasText: "Preview chat" }).first();

  await expectPreviewIconFor(issueLink, '[data-slot="issue-status-icon"][data-status="todo"]', "Issue preview summary from the real issue API.");
  await expectPreviewIconFor(agentLink, ".rudder-entity-preview-main-icon--agent", "Handles entity preview validation.");
  await expect(automationLink).toBeVisible();
  expect(await automationLink.evaluate((element) => Boolean(element.closest(".rudder-entity-preview-wrap")))).toBe(false);
  await automationLink.hover();
  await expect(page.locator(".rudder-entity-preview-card").filter({ hasText: "Automation preview target" })).toHaveCount(0);
  await expectPreviewIconFor(projectLink, ".rudder-entity-preview-main-icon--project", "Project preview summary from the real project API.");
  await expectPreviewIconFor(libraryDocLink, ".rudder-entity-preview-main-icon--library", "Library document preview summary from the real document API.");
  await expectPreviewFor(libraryFileLink, "Workspace file preview summary from the real workspace API.");
  const commentCard = await expectPreviewIconFor(issueCommentLink, '[data-slot="issue-comment-preview-icon"]', "Comment preview body from the real comments API");
  await expect(commentCard.locator('[data-slot="issue-status-icon"]')).toHaveCount(0);
  await expect(commentCard).toContainText("Preview target issue");
  await expect(commentCard).not.toContainText("High");

  await expect(chatLink).toBeVisible();
  expect(await chatLink.evaluate((element) => Boolean(element.closest(".rudder-entity-preview-wrap")))).toBe(false);
  await chatLink.hover();
  await expect(page.locator(".rudder-entity-preview-card").filter({ hasText: "Preview chat should not show" })).toHaveCount(0);

  await automationLink.click();
  await expect(page).toHaveURL(new RegExp(`/automations/${automation.id}$`));
});
