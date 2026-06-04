import { expect, test } from "@playwright/test";

async function selectOrganization(page: import("@playwright/test").Page, orgId: string) {
  await page.goto("/");
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

test("Library markdown editor can mention global Rudder entities", async ({ page }) => {
  const suffix = Date.now();
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Global-Markdown-Mentions-${suffix}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: `Mention Agent ${suffix}`,
      role: "engineer",
      agentRuntimeType: "process",
      agentRuntimeConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
    },
  });
  expect(agentRes.ok()).toBe(true);
  const agent = await agentRes.json() as { id: string; name: string };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: `Mention Issue ${suffix}`,
      description: "Mention target issue.",
      status: "todo",
      priority: "medium",
      assigneeUserId: "local-board",
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; title: string };

  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: `Mention Chat ${suffix}`,
      summary: "Mention target chat.",
    },
  });
  expect(chatRes.ok()).toBe(true);
  const chat = await chatRes.json() as { id: string; title: string };

  const skillRes = await page.request.post(`/api/orgs/${organization.id}/skills`, {
    data: {
      name: `Mention Skill ${suffix}`,
      slug: `mention-skill-${suffix}`,
      markdown: "---\nname: Mention Skill\ndescription: Mention target skill.\n---\n\n# Mention Skill\n",
    },
  });
  expect(skillRes.ok()).toBe(true);
  const skill = await skillRes.json() as { id: string; slug: string };

  const workspaceDocPath = "docs/global-mention-reference.md";
  const workspaceDocRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
    data: {
      filePath: workspaceDocPath,
      content: "# Global mention reference\n",
    },
  });
  expect(workspaceDocRes.ok()).toBe(true);
  const workspaceDoc = await workspaceDocRes.json() as { libraryEntryId: string };
  expect(workspaceDoc.libraryEntryId).toBeTruthy();

  const editorDocPath = "docs/global-mention-editor.md";
  const editorDocRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
    data: {
      filePath: editorDocPath,
      content: "# Global mention editor\n",
    },
  });
  expect(editorDocRes.ok()).toBe(true);

  await selectOrganization(page, organization.id);
  await page.goto(`/${organization.issuePrefix}/library?entry=${encodeURIComponent(workspaceDoc.libraryEntryId)}&path=docs%2Fstale-reference.md`);
  await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/library\\?path=${encodeURIComponent(workspaceDocPath)}$`));
  await expect(page.locator("#main-content")).toContainText("global-mention-reference.md");

  const renameRes = await page.request.patch(`/api/orgs/${organization.id}/workspace/entry?path=${encodeURIComponent(workspaceDocPath)}`, {
    data: {
      name: "global-mention-reference-renamed.md",
    },
  });
  expect(renameRes.ok()).toBe(true);
  const renamedWorkspaceDocPath = "docs/global-mention-reference-renamed.md";
  await page.goto(`/${organization.issuePrefix}/library?entry=${encodeURIComponent(workspaceDoc.libraryEntryId)}&path=${encodeURIComponent(workspaceDocPath)}`);
  await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/library\\?path=${encodeURIComponent(renamedWorkspaceDocPath)}$`));
  await expect(page.locator("#main-content")).toContainText("global-mention-reference-renamed.md");

  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(editorDocPath)}`);

  const editor = page.locator('.rudder-milkdown-scope .ProseMirror[contenteditable="true"]').first();
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();

  async function expectMention(query: string, optionTestId: string, visibleText: string) {
    await editor.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.type(`@${query}`);
    const menu = page.getByTestId("markdown-mention-menu");
    await expect(menu).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(optionTestId)).toContainText(visibleText, { timeout: 15_000 });
  }

  await expectMention(String(suffix), `markdown-mention-option-agent:${agent.id}`, agent.name);
  await expectMention(String(suffix), `markdown-mention-option-issue:${issue.id}`, issue.title);
  await expectMention(String(suffix), `markdown-mention-option-chat:${chat.id}`, chat.title);
  await expectMention("global-mention-reference", `markdown-mention-option-library-file:${renamedWorkspaceDocPath}`, "global-mention-reference-renamed.md");
  await expectMention(String(suffix), `markdown-mention-option-skill:org:${skill.id}`, skill.slug);
});
