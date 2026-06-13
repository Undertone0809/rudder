import { expect, test, type Locator, type Page } from "@playwright/test";

test.use({ serviceWorkers: "block" });

function buildProjectMentionHref(projectId: string, color?: string | null) {
  void color;
  return `project://${projectId}`;
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

test("renderable entity links show hover previews except chat links", async ({ page }) => {
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
        `[${project.name}](${buildProjectMentionHref(project.id, project.color)})`,
        `[${libraryDoc.title}](${buildLibraryDocMentionHref(libraryDoc.id, libraryDoc.title)})`,
        `[${fileName}](${buildLibraryFileMentionHref(filePath, fileName)})`,
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
  const projectLink = page.locator('a.rudder-mention-chip[data-mention-kind="project"]').filter({ hasText: project.name }).first();
  const libraryDocLink = page.locator('a.rudder-mention-chip[data-mention-kind="library_doc"]').filter({ hasText: libraryDoc.title }).first();
  const libraryFileLink = page.locator('a.rudder-mention-chip[data-mention-kind="library_file"]').filter({ hasText: fileName }).first();
  const chatLink = page.locator('a.rudder-mention-chip[data-mention-kind="chat"]').filter({ hasText: "Preview chat" }).first();

  await expectPreviewFor(issueLink, "Issue preview summary from the real issue API.");
  await expectPreviewFor(agentLink, "Handles entity preview validation.");
  await expectPreviewFor(projectLink, "Project preview summary from the real project API.");
  await expectPreviewFor(libraryDocLink, "Library document preview summary from the real document API.");
  await expectPreviewFor(libraryFileLink, "Workspace file preview summary from the real workspace API.");

  await expect(chatLink).toBeVisible();
  expect(await chatLink.evaluate((element) => Boolean(element.closest(".rudder-entity-preview-wrap")))).toBe(false);
  await chatLink.hover();
  await expect(page.locator(".rudder-entity-preview-card").filter({ hasText: "Preview chat should not show" })).toHaveCount(0);
});
