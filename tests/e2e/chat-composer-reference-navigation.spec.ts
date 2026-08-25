import { expect, test, type Page } from "@playwright/test";
import { createE2EChatAgent } from "./support/chat-agent";

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

function buildLibraryDirectoryMentionHref(directoryPath: string, title: string) {
  void title;
  return `library-directory://directory?p=${encodeURIComponent(directoryPath)}`;
}

function organizationSkillMarkdownTarget(skill: { id: string; slug: string }) {
  return `skill://org/${encodeURIComponent(skill.id)}?ref=${encodeURIComponent(skill.slug)}`;
}

async function createOrganization(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `${name}-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json() as Promise<{ id: string; issuePrefix: string }>;
}

async function createIssue(page: Page, orgId: string, title: string) {
  const issueRes = await page.request.post(`/api/orgs/${orgId}/issues`, {
    data: {
      title,
      description: `${title} description`,
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueRes.ok()).toBe(true);
  return issueRes.json() as Promise<{ id: string; identifier: string | null; title: string }>;
}

async function createProject(page: Page, orgId: string, name: string) {
  const projectRes = await page.request.post(`/api/orgs/${orgId}/projects`, {
    data: { name },
  });
  expect(projectRes.ok()).toBe(true);
  return projectRes.json() as Promise<{ id: string; name: string; urlKey?: string | null; color?: string | null }>;
}

test("chat composer reference tokens navigate to their target pages with a command click", async ({ page }) => {
  const organization = await createOrganization(page, "Composer-Reference-Navigation");
  const agent = await createE2EChatAgent(page.request, organization.id, { name: "Navigator Agent" }) as {
    id: string;
    name: string;
  };
  const project = await createProject(page, organization.id, "Navigation project");
  const issue = await createIssue(page, organization.id, "Navigation issue");

  const libraryDocRes = await page.request.post(`/api/orgs/${organization.id}/library/documents`, {
    data: {
      title: "Navigation library doc",
      body: "# Navigation library doc\n",
    },
  });
  expect(libraryDocRes.ok()).toBe(true);
  const libraryDoc = await libraryDocRes.json() as { id: string; title: string };

  const libraryFilePath = `docs/navigation-reference-${Date.now()}.md`;
  const libraryFileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
    data: {
      filePath: libraryFilePath,
      content: "# Navigation library file\n",
    },
  });
  expect(libraryFileRes.ok()).toBe(true);
  const libraryFileName = libraryFilePath.split("/").at(-1) ?? libraryFilePath;

  const libraryDirectoryPath = `projects/navigation-folder-${Date.now()}`;
  const libraryDirectoryRes = await page.request.post(`/api/orgs/${organization.id}/workspace/directory`, {
    data: {
      directoryPath: libraryDirectoryPath,
    },
  });
  expect(libraryDirectoryRes.ok()).toBe(true);
  const libraryDirectoryName = libraryDirectoryPath.split("/").at(-1) ?? libraryDirectoryPath;

  const skillRes = await page.request.post(`/api/orgs/${organization.id}/skills`, {
    data: {
      name: "Navigation Skill",
      slug: "navigation-skill",
      markdown: "---\nname: Navigation Skill\n---\n\n# Navigation Skill\n",
    },
  });
  expect(skillRes.ok()).toBe(true);
  const skill = await skillRes.json() as {
    id: string;
    key: string;
    slug: string;
  };
  const skillTarget = organizationSkillMarkdownTarget(skill);
  expect(skillTarget).toBeTruthy();

  const syncRes = await page.request.post(`/api/agents/${agent.id}/skills/sync?orgId=${encodeURIComponent(organization.id)}`, {
    data: { desiredSkills: [`org:${skill.key}`] },
  });
  expect(syncRes.ok()).toBe(true);

  const hostChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Navigation host chat",
      preferredAgentId: agent.id,
      initialMessage: { body: "Navigation host seed" },
    },
  });
  expect(hostChatRes.ok()).toBe(true);
  const hostChat = await hostChatRes.json() as { id: string };

  const referencedChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Referenced navigation chat",
      preferredAgentId: agent.id,
      initialMessage: { body: "Referenced navigation seed" },
    },
  });
  expect(referencedChatRes.ok()).toBe(true);
  const referencedChat = await referencedChatRes.json() as { id: string };

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  const hostChatPath = `/${organization.issuePrefix}/messenger/chat/${hostChat.id}`;
  await page.goto(hostChatPath);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });

  const draft = [
    `[${agent.name}](agent://${agent.id})`,
    `[${project.name}](${buildProjectMentionHref(project.id, project.color ?? null)})`,
    `[${issue.title}](issue://${issue.id})`,
    `[Referenced navigation chat](chat://${referencedChat.id})`,
    `[${libraryDoc.title}](${buildLibraryDocMentionHref(libraryDoc.id, libraryDoc.title)})`,
    `[${libraryFileName}](${buildLibraryFileMentionHref(libraryFilePath, libraryFileName)})`,
    `[${libraryDirectoryName}](${buildLibraryDirectoryMentionHref(libraryDirectoryPath, libraryDirectoryName)})`,
    `[navigation-skill](${skillTarget})`,
  ].join(" ");

  await composer.fill(draft);

  const agentToken = composer.locator("[data-mention-kind='agent']").filter({ hasText: agent.name }).first();
  const projectToken = composer.locator("[data-mention-kind='project']").filter({ hasText: project.name }).first();
  const issueToken = composer.locator("[data-mention-kind='issue']").filter({ hasText: issue.title }).first();
  const chatToken = composer.locator("[data-mention-kind='chat']").filter({ hasText: "Referenced navigation chat" }).first();
  const libraryDocToken = composer.locator("[data-mention-kind='library_doc']").filter({ hasText: libraryDoc.title }).first();
  const libraryFileToken = composer.locator("[data-mention-kind='library_file']").filter({ hasText: libraryFileName }).first();
  const libraryDirectoryToken = composer.locator("[data-mention-kind='library_directory']").filter({ hasText: libraryDirectoryName }).first();
  const skillToken = composer.locator("[data-skill-token='true']").filter({ hasText: "navigation-skill" }).first();

  await expect(agentToken).toBeVisible({ timeout: 15_000 });
  await expect(projectToken).toBeVisible();
  await expect(issueToken).toBeVisible();
  await expect(chatToken).toBeVisible();
  await expect(libraryDocToken).toBeVisible();
  await expect(libraryFileToken).toBeVisible();
  await expect(libraryDirectoryToken).toBeVisible();
  await expect(skillToken).toBeVisible();

  await agentToken.click({ modifiers: ["ControlOrMeta"] });
  await expect(page).toHaveURL(/\/[^/]+\/agents\/[^/]+\/dashboard$/);

  await page.goto(hostChatPath);
  await expect(projectToken).toBeVisible({ timeout: 15_000 });
  await projectToken.click({ modifiers: ["ControlOrMeta"] });
  await expect(page).toHaveURL(/\/[^/]+\/projects\/[^/?]+(?:\/configuration)?(?:\\?.*)?$/);
  await expect(page.getByText(project.name).first()).toBeVisible({ timeout: 15_000 });

  await page.goto(hostChatPath);
  await expect(issueToken).toBeVisible({ timeout: 15_000 });
  await issueToken.click({ modifiers: ["ControlOrMeta"] });
  await expect(page).toHaveURL(new RegExp(`/[^/]+/issues/${issue.id}$`));

  await page.goto(hostChatPath);
  await expect(chatToken).toBeVisible({ timeout: 15_000 });
  await chatToken.click({ modifiers: ["ControlOrMeta"] });
  await expect(page).toHaveURL(new RegExp(`/[^/]+/messenger/chat/${referencedChat.id}$`));

  await page.goto(hostChatPath);
  await expect(libraryDocToken).toBeVisible({ timeout: 15_000 });
  await libraryDocToken.click({ modifiers: ["ControlOrMeta"] });
  await expect(page).toHaveURL(new RegExp(`/[^/]+/library\\?doc=${libraryDoc.id}$`));

  await page.goto(hostChatPath);
  await expect(libraryFileToken).toBeVisible({ timeout: 15_000 });
  await libraryFileToken.click({ modifiers: ["ControlOrMeta"] });
  await expect(page).toHaveURL(new RegExp(`/[^/]+/library\\?path=${encodeURIComponent(libraryFilePath).replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}$`));

  await page.goto(hostChatPath);
  await expect(libraryDirectoryToken).toBeVisible({ timeout: 15_000 });
  await libraryDirectoryToken.click({ modifiers: ["ControlOrMeta"] });
  await expect(page).toHaveURL(new RegExp(`/[^/]+/library\\?directory=${encodeURIComponent(libraryDirectoryPath).replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}$`));

  await page.goto(hostChatPath);
  await expect(skillToken).toBeVisible({ timeout: 15_000 });
  await skillToken.click({ modifiers: ["ControlOrMeta"] });
  await expect(page).toHaveURL(
    new RegExp(`/[^/]+/library\\?skill=${skill.id}&skillFile=SKILL\\.md$`),
  );
  await expect(page.getByRole("textbox", { name: /Markdown editor/i })).toContainText("Navigation Skill");
});

test("chat composer focuses and sends after clicking a reference token", async ({ page }) => {
  const organization = await createOrganization(page, "Composer-Reference-Input");
  const agent = await createE2EChatAgent(page.request, organization.id, { name: "Input Agent" }) as {
    id: string;
    name: string;
  };

  const hostChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Input host chat",
      preferredAgentId: agent.id,
      initialMessage: { body: "Input host seed" },
    },
  });
  expect(hostChatRes.ok()).toBe(true);
  const hostChat = await hostChatRes.json() as { id: string };

  const referencedChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Input referenced chat",
      preferredAgentId: agent.id,
      initialMessage: { body: "Input referenced seed" },
    },
  });
  expect(referencedChatRes.ok()).toBe(true);
  const referencedChat = await referencedChatRes.json() as { id: string };

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.issuePrefix}/messenger/chat/${hostChat.id}`);

  const composer = page.locator(".chat-composer .rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });

  const href = `chat://${referencedChat.id}`;
  const draft = `请继续分析 [Input referenced chat](${href})`;
  await composer.fill(draft);

  const token = composer.locator("[data-mention-kind='chat']").filter({ hasText: "Input referenced chat" }).first();
  await expect(token).toBeVisible({ timeout: 15_000 });
  await token.click();
  await expect(composer).toBeFocused();

  await page.keyboard.type(" 后续输入");
  const expectedBody = `${draft} 后续输入`;
  await expect(composer).toContainText("Input referenced chat 后续输入");
  await expect(token).not.toContainText("后续输入");

  await page.getByRole("button", { name: "Send" }).click();
  await expect(composer).toHaveText("");
  await expect(
    page.getByTestId("chat-user-message-bubble").filter({ hasText: "后续输入" }).last(),
  ).toBeVisible({ timeout: 15_000 });

  const messagesRes = await page.request.get(`/api/chats/${hostChat.id}/messages`);
  expect(messagesRes.ok()).toBe(true);
  const messages = await messagesRes.json() as Array<{ role: string; body: string }>;
  expect(messages.filter((message) => message.role === "user").at(-1)?.body).toBe(expectedBody);
});
