import { expect, test, type Locator, type Page } from "@playwright/test";
import { createE2EChatAgent } from "./support/chat-agent";

async function createOrganization(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `${name}-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json() as Promise<{ id: string; issuePrefix: string }>;
}

async function selectOrganization(page: Page, orgId: string) {
  await page.goto("/");
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

async function resetComposer(composer: Locator) {
  await composer.click();
  await composer.press("ControlOrMeta+A");
  await composer.press("Backspace");
  await expect(composer).toHaveText("");
  await expect.poll(async () => {
    return composer.evaluate((element) => {
      const selection = window.getSelection();
      return Boolean(selection?.anchorNode && element.contains(selection.anchorNode));
    });
  }).toBe(true);
  await composer.press("Escape");
  await composer.click();
}

async function expectReadableReferenceIcon(token: Locator, minPx: number) {
  const size = await token.evaluate((element) => {
    const style = window.getComputedStyle(element, "::before");
    return {
      width: Number.parseFloat(style.width),
      height: Number.parseFloat(style.height),
    };
  });
  expect(size.width).toBeGreaterThanOrEqual(minPx);
  expect(size.height).toBeGreaterThanOrEqual(minPx);
}

test("chat composer inserts every @ reference type with Tab and keeps typing after the token", async ({ page }, testInfo) => {
  const suffix = Date.now();
  const agentName = `AtAgent${suffix}`;
  const projectName = `AtProject${suffix}`;
  const issueTitle = `AtIssue${suffix}`;
  const hostChatTitle = `AtHostChat${suffix}`;
  const referencedChatTitle = `AtReferencedChat${suffix}`;
  const libraryDocTitle = `AtLibraryDoc${suffix}`;
  const skillSlug = `at-skill-${suffix}`;
  const organization = await createOrganization(page, "Chat-Composer-At-Mentions");
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: agentName,
  }) as { id: string; name: string };

  const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
    data: { name: projectName },
  });
  expect(projectRes.ok()).toBe(true);
  const project = await projectRes.json() as { id: string; name: string };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: issueTitle,
      description: "Composer @ mention target issue.",
      status: "todo",
      priority: "medium",
      projectId: project.id,
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; title: string };

  const hostChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: hostChatTitle,
      preferredAgentId: agent.id,
    },
  });
  expect(hostChatRes.ok()).toBe(true);
  const hostChat = await hostChatRes.json() as { id: string };

  const referencedChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: referencedChatTitle,
      summary: "Composer @ mention target chat.",
      preferredAgentId: agent.id,
    },
  });
  expect(referencedChatRes.ok()).toBe(true);
  const referencedChat = await referencedChatRes.json() as { id: string; title: string };

  const libraryDocRes = await page.request.post(`/api/orgs/${organization.id}/library/documents`, {
    data: {
      title: libraryDocTitle,
      body: "# Composer @ mention target library doc\n",
    },
  });
  expect(libraryDocRes.ok()).toBe(true);
  const libraryDoc = await libraryDocRes.json() as { id: string; title: string };

  const libraryFilePath = `docs/at-library-file-${suffix}.md`;
  const libraryFileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
    data: {
      filePath: libraryFilePath,
      content: "# Composer @ mention target library file\n",
    },
  });
  expect(libraryFileRes.ok()).toBe(true);

  const libraryDirectoryPath = `projects/at-library-folder-${suffix}`;
  const libraryDirectoryRes = await page.request.post(`/api/orgs/${organization.id}/workspace/directory`, {
    data: {
      directoryPath: libraryDirectoryPath,
    },
  });
  expect(libraryDirectoryRes.ok()).toBe(true);

  const skillRes = await page.request.post(`/api/orgs/${organization.id}/skills`, {
    data: {
      name: `AtSkill${suffix}`,
      slug: skillSlug,
      markdown: `---\nname: AtSkill${suffix}\ndescription: Composer @ mention target skill.\n---\n\n# At Skill\n`,
    },
  });
  expect(skillRes.ok()).toBe(true);
  const skill = await skillRes.json() as { key: string; slug: string };
  const syncRes = await page.request.post(`/api/agents/${agent.id}/skills/sync?orgId=${encodeURIComponent(organization.id)}`, {
    data: { desiredSkills: [`org:${skill.key}`] },
  });
  expect(syncRes.ok()).toBe(true);

  await selectOrganization(page, organization.id);
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${hostChat.id}`);

  const composer = page.locator(".chat-composer .rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });

  const cases: Array<{
    kind: string;
    query: string;
    optionTestId: string;
    optionText?: string;
    tokenSelector: string;
    tokenText: string;
    minIconPx: number;
  }> = [
    {
      kind: "agent",
      query: agentName,
      optionTestId: `markdown-mention-option-agent:${agent.id}`,
      tokenSelector: "[data-mention-kind='agent']",
      tokenText: agent.name,
      minIconPx: 17,
    },
    {
      kind: "project",
      query: projectName,
      optionTestId: `markdown-mention-option-project:${project.id}`,
      tokenSelector: "[data-mention-kind='project']",
      tokenText: project.name,
      minIconPx: 11,
    },
    {
      kind: "issue",
      query: issueTitle,
      optionTestId: `markdown-mention-option-issue:${issue.id}`,
      tokenSelector: "[data-mention-kind='issue']",
      tokenText: issue.title,
      minIconPx: 17,
    },
    {
      kind: "chat",
      query: referencedChatTitle,
      optionTestId: `markdown-mention-option-chat:${referencedChat.id}`,
      tokenSelector: "[data-mention-kind='chat']",
      tokenText: referencedChat.title,
      minIconPx: 17,
    },
    {
      kind: "library_doc",
      query: libraryDocTitle,
      optionTestId: `markdown-mention-option-library-doc:${libraryDoc.id}`,
      tokenSelector: "[data-mention-kind='library_doc']",
      tokenText: libraryDoc.title,
      minIconPx: 17,
    },
    {
      kind: "library_file",
      query: `at-library-file-${suffix}`,
      optionTestId: `markdown-mention-option-library-file:${libraryFilePath}`,
      tokenSelector: "[data-mention-kind='library_file']",
      tokenText: `at-library-file-${suffix}.md`,
      minIconPx: 17,
    },
    {
      kind: "library_directory",
      query: `at-library-folder-${suffix}`,
      optionTestId: `markdown-mention-option-library-directory:${libraryDirectoryPath}`,
      optionText: `Folder`,
      tokenSelector: "[data-mention-kind='library_directory']",
      tokenText: `at-library-folder-${suffix}`,
      minIconPx: 17,
    },
    {
      kind: "skill",
      query: skillSlug,
      optionTestId: `markdown-mention-option-skill:org:${skill.key}`,
      optionText: `AtSkill${suffix}`,
      tokenSelector: "[data-skill-token='true']",
      tokenText: skill.slug,
      minIconPx: 17,
    },
  ];

  for (const mentionCase of cases) {
    await resetComposer(composer);
    await page.keyboard.type(`@${mentionCase.query}`);
    const option = page.getByTestId(mentionCase.optionTestId);
    await expect(option).toContainText(mentionCase.optionText ?? mentionCase.tokenText, { timeout: 15_000 });
    if (mentionCase.kind === "library_directory") {
      await expect(option).toContainText(libraryDirectoryPath);
    }
    await page.keyboard.press("Tab");

    const token = composer.locator(mentionCase.tokenSelector).filter({ hasText: mentionCase.tokenText }).first();
    await expect(token, `${mentionCase.kind} token`).toBeVisible({ timeout: 15_000 });
    await expectReadableReferenceIcon(token, mentionCase.minIconPx);
    if (mentionCase.kind === "library_directory") {
      await expect(token).toHaveAttribute("data-mention-href", /library-directory:\/\/directory\?/);
    }

    const trailingText = ` after-${mentionCase.kind}`;
    await page.keyboard.type(trailingText);
    await expect(composer).toContainText(trailingText);
    await expect(token).not.toContainText(trailingText);
    await expect(composer).toBeFocused();
  }

  await page.screenshot({ path: testInfo.outputPath("chat-composer-at-mentions.png"), fullPage: true });
});

test("chat composer sends pasted text after a clicked issue reference token", async ({ page }) => {
  const suffix = Date.now();
  const issueTitle = `SendAfterIssueMention${suffix}`;
  const organization = await createOrganization(page, "Chat-Composer-Issue-After-Token");
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: `IssueAgent${suffix}`,
  }) as { id: string; name: string };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: issueTitle,
      description: "Composer send regression target.",
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; title: string };

  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: `Issue send ${suffix}`,
      preferredAgentId: agent.id,
    },
  });
  expect(chatRes.ok()).toBe(true);
  const chat = await chatRes.json() as { id: string };

  await selectOrganization(page, organization.id);
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

  const composer = page.locator(".chat-composer .rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.click();
  await page.keyboard.type(`@${issueTitle}`);
  const option = page.getByTestId(`markdown-mention-option-issue:${issue.id}`);
  await expect(option).toContainText(issue.title, { timeout: 15_000 });
  await page.keyboard.press("Tab");

  const token = composer.locator("[data-mention-kind='issue']").filter({ hasText: issue.title }).first();
  await expect(token).toBeVisible({ timeout: 15_000 });
  await token.click({ force: true });

  await composer.evaluate((element) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", "可以这样");
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: dataTransfer,
    });
    element.dispatchEvent(pasteEvent);
  });
  await expect(composer).toContainText("可以这样");

  await page.getByRole("button", { name: "Send" }).click();

  const userBubble = page.getByTestId("chat-user-message-bubble").last();
  await expect(userBubble).toContainText(issue.title, { timeout: 15_000 });
  await expect(userBubble).toContainText("可以这样", { timeout: 15_000 });

  const messagesRes = await page.request.get(`/api/chats/${chat.id}/messages`);
  expect(messagesRes.ok()).toBe(true);
  const messages = await messagesRes.json();
  const userMessage = [...messages].reverse().find((message: { role: string }) => message.role === "user");
  expect(userMessage?.body).toContain(issue.title);
  expect(userMessage?.body).toContain(`](issue://${issue.id}`);
  expect(userMessage?.body).toContain("可以这样");
});
