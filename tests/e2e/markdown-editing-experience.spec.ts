import { expect, test, type Locator, type Page } from "@playwright/test";
import { buildAgentMentionHref } from "../../packages/shared/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";

async function createOrganization(page: Page, name: string) {
  const response = await page.request.post("/api/orgs", {
    data: { name: `${name}-${Date.now()}` },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<{ id: string; issuePrefix: string }>;
}

async function selectOrganization(page: Page, organizationId: string) {
  await page.goto("/");
  await page.evaluate((selectedOrganizationId) => {
    window.localStorage.setItem(
      "rudder.selectedOrganizationId",
      selectedOrganizationId,
    );
  }, organizationId);
}

async function typeMarkdownLines(page: Page, editor: Locator, lines: string[]) {
  await editor.click();
  for (const [index, line] of lines.entries()) {
    if (line) await page.keyboard.insertText(line);
    if (index < lines.length - 1) await page.keyboard.press("Enter");
  }
}

test("Issue live preview stays stable while typing mixed Markdown and accepting @ with Tab", async ({
  page,
}, testInfo) => {
  const organization = await createOrganization(page, "Markdown-Editing-Matrix");
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: `MarkdownAgent${Date.now()}`,
  }) as { id: string; name: string; icon: string | null; role: string };

  await selectOrganization(page, organization.id);
  await page.goto(`/${organization.issuePrefix}/issues`);
  await page.getByRole("button", { name: "Create Todo issue" }).click();

  const dialog = page.getByRole("dialog", { name: "New issue" });
  const editor = dialog.getByRole("textbox", {
    name: "Add description... Markdown editor",
  });
  await expect(editor).toBeVisible();

  await editor.click();
  await page.keyboard.insertText([
    "# 中文标题",
    "普通 **粗体**、*斜体*、~~删除线~~ 与 `inline code`。",
    "> 引用 mixed 输入",
    "",
    "",
  ].join("\n"));
  await page.keyboard.insertText("- first");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("second");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Backspace");

  await expect(editor.locator(".cm-line").filter({ hasText: "second" })).toBeVisible();
  await expect(editor.locator(
    '.cm-line[data-markdown-source-heading-level]:not([data-markdown-source-heading-level="none"])',
  ).filter({ hasText: "second" })).toHaveCount(0);
  await expect(editor.locator(".cm-line").filter({ hasText: "-" }).last()).toBeVisible();
  await expect(editor.locator(
    '.cm-line[data-markdown-source-kind="setext-heading"]',
  )).toHaveCount(0);

  const deterministicSource = [
    "# 中文标题",
    "普通 **粗体**、*斜体*、~~删除线~~ 与 `inline code`。",
    "> 引用 mixed 输入",
    "",
    "- first",
    "- second",
    "",
    "1. ordered",
    "2. second ordered",
    "",
    "- [ ] task",
    "",
    "[OpenAI](https://openai.com)",
    `@${agent.name}`,
  ].join("\n");
  await editor.fill(deterministicSource);

  const option = page.getByTestId(`markdown-mention-option-agent:${agent.id}`);
  await expect(option).toBeVisible();
  await page.keyboard.press("Tab");

  await expect(editor.locator("[data-markdown-atomic-reference='true']").filter({
    hasText: agent.name,
  })).toBeVisible();
  await expect(page.getByTestId("markdown-mention-menu")).toHaveCount(0);
  await expect(editor).toBeFocused();

  await page.keyboard.insertText("\n\n---");
  const agentReferenceLabel = `${agent.name} (${
    agent.role.charAt(0).toUpperCase() + agent.role.slice(1)
  })`;
  const expectedSource = deterministicSource.replace(
    `@${agent.name}`,
    `[${agentReferenceLabel}](${buildAgentMentionHref(agent.id, agent.icon)}) `,
  ) + "\n\n---";
  await dialog.getByPlaceholder("Issue title").click();

  await expect(editor.locator(".rudder-cm-markdown-strong")).toContainText("粗体");
  await expect(editor.locator(".rudder-cm-markdown-emphasis")).toContainText("斜体");
  await expect(editor.locator(".rudder-cm-markdown-strikethrough")).toContainText("删除线");
  await expect(editor.locator(".rudder-cm-markdown-inline-code")).toContainText("inline code");
  await expect(editor.locator("[data-markdown-website-icon='true']")).toBeVisible();
  await expect(editor.locator(
    '[data-markdown-thematic-break="true"][data-markdown-preview-state="preview"]',
  )).toBeVisible();

  await page.screenshot({
    path: testInfo.outputPath("issue-mixed-markdown-preview.png"),
    fullPage: true,
  });

  const issueTitle = `Markdown editing matrix ${Date.now()}`;
  await dialog.getByPlaceholder("Issue title").fill(issueTitle);
  const createResponse = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && response.url().endsWith(`/api/orgs/${organization.id}/issues`)
    && response.ok()
  ));
  await dialog.getByRole("button", { name: "Create Issue" }).click();
  const createdIssue = await (await createResponse).json() as {
    id: string;
    description: string | null;
  };
  expect(createdIssue.description).toBe(expectedSource);
});

test("Chat composer remains on its existing editor while skill completion avoids leaked entities", async ({
  page,
}, testInfo) => {
  const organization = await createOrganization(page, "Chat-Markdown-Editing");
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: `Composer Agent ${Date.now()}`,
  }) as { id: string };
  const suffix = Date.now();
  const skillSlug = `composer-skill-${suffix}`;
  const skillResponse = await page.request.post(
    `/api/orgs/${organization.id}/skills`,
    {
      data: {
        name: `Composer Skill ${suffix}`,
        slug: skillSlug,
        markdown: [
          "---",
          `name: Composer Skill ${suffix}`,
          "description: Markdown editing acceptance skill.",
          "---",
          "",
          "# Composer Skill",
        ].join("\n"),
      },
    },
  );
  expect(skillResponse.ok()).toBe(true);
  const skill = await skillResponse.json() as { id: string; key: string; slug: string };
  const syncResponse = await page.request.post(
    `/api/agents/${agent.id}/skills/sync?orgId=${encodeURIComponent(organization.id)}`,
    { data: { desiredSkills: [`org:${skill.key}`] } },
  );
  expect(syncResponse.ok()).toBe(true);
  const chatResponse = await page.request.post(
    `/api/orgs/${organization.id}/chats`,
    {
      data: {
        title: "Markdown composer regression",
        preferredAgentId: agent.id,
        initialMessage: { body: "Markdown composer setup." },
      },
    },
  );
  expect(chatResponse.ok(), await chatResponse.text()).toBe(true);
  const chat = await chatResponse.json() as { id: string };
  await selectOrganization(page, organization.id);
  await page.goto(
    `/${organization.issuePrefix}/messenger/chat/${chat.id}`,
  );

  const composer = page
    .getByTestId("chat-composer-editor-scroll")
    .locator('[contenteditable="true"]')
    .first();
  await expect(composer).toBeVisible();
  await expect(composer.locator('[data-editor-engine="codemirror-live-preview"]')).toHaveCount(0);
  await composer.click();
  await page.keyboard.type("- alpha");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("- beta");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("- gamma");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type(`@${skill.slug}`);

  const option = page.getByTestId(`markdown-mention-option-skill:org:${skill.key}`);
  await expect(option).toBeVisible();
  await page.keyboard.press("Tab");

  const skillToken = composer.locator("[data-skill-token='true']").filter({
    hasText: skill.slug,
  });
  await expect(skillToken).toBeVisible();
  await expect(composer).not.toContainText("&#x20;");
  await expect(composer).toBeFocused();

  await page.keyboard.type("after-tab");
  await expect(composer).toContainText("after-tab");

  await page.screenshot({
    path: testInfo.outputPath("chat-multiline-skill-composer.png"),
    fullPage: true,
  });

  const expectedBody = [
    "- alpha",
    "- beta",
    "- gamma",
    `[${skill.slug}](skill://org/${skill.id}?ref=${encodeURIComponent(skill.slug)}) after-tab`,
  ].join("\n");
  const sendButton = page.getByRole("button", { name: "Send" });
  await expect(sendButton).toBeEnabled();
  await sendButton.click();
  await expect.poll(async () => {
    const response = await page.request.get(`/api/chats/${chat.id}/messages`);
    expect(response.ok()).toBe(true);
    const messages = await response.json() as Array<{ role: string; body: string }>;
    return messages
      .filter((message) => message.role === "user")
      .at(-1)
      ?.body;
  }).toBe(expectedBody);
});
