import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { E2E_BASE_URL } from "./support/e2e-env";

async function createOrganization(request: APIRequestContext) {
  const response = await request.post(`${E2E_BASE_URL}/api/orgs`, {
    data: { name: `Markdown Source Driven ${Date.now()}` },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as { id: string; issuePrefix: string };
}

async function selectOrganization(page: Page, organizationId: string) {
  await page.goto(E2E_BASE_URL, { waitUntil: "domcontentloaded" });
  await page.evaluate((selectedOrganizationId) => {
    window.localStorage.setItem(
      "rudder.selectedOrganizationId",
      selectedOrganizationId,
    );
  }, organizationId);
}

test("Library preview reveals exact Markdown without moving surrounding source lines", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const organization = await createOrganization(request);
  const filePath = "docs/source-driven-preview.md";
  const markdown = [
    "# Stable heading",
    "",
    "Before **bold** and *italic* with [OpenAI](https://openai.com) and [Local](#stable-heading).",
    "",
    "- first item",
    "- second item",
    "- [x] completed task",
    "",
    "```ts",
    "const answer = 42;",
    "```",
  ].join("\n");
  const createFile = await request.post(
    `${E2E_BASE_URL}/api/orgs/${organization.id}/workspace/file`,
    { data: { filePath, content: markdown } },
  );
  expect(createFile.ok(), await createFile.text()).toBe(true);
  await selectOrganization(page, organization.id);

  await page.goto(
    `${E2E_BASE_URL}/${organization.issuePrefix}/library?path=${encodeURIComponent(filePath)}`,
  );
  const editor = page
    .getByTestId("org-workspaces-markdown-editor")
    .locator('[data-editor-engine="codemirror-live-preview"]');
  await expect(editor).toBeVisible();
  await expect(editor.locator(".rudder-codemirror-markdown-preview")).toHaveCount(0);

  const paragraph = editor.locator(
    '[data-source-line-start="3"][data-markdown-preview-state="preview"]',
  );
  const followingList = editor.locator('[data-source-line-start="5"]');
  await expect(paragraph).toContainText("Before bold and italic with OpenAI and Local.");
  await expect(paragraph).not.toContainText("**bold**");
  await expect(paragraph.locator("[data-markdown-website-icon='true']")).toBeVisible();
  const taskLine = editor.locator('[data-source-line-start="7"]');
  const taskCheckbox = taskLine.locator(
    "input.rudder-cm-markdown-task-checkbox",
  );
  await expect(taskCheckbox).toBeChecked();
  await taskLine.getByText("completed task").click();
  await expect(taskLine).toHaveAttribute("data-markdown-preview-state", "source");
  await expect(taskLine).toContainText("- [x] completed task");
  await expect(taskLine.locator("input[type='checkbox']")).toHaveCount(0);
  await editor.locator(".cm-content").evaluate((element) => {
    if (element instanceof HTMLElement) element.blur();
  });
  await expect(taskCheckbox).toBeChecked();

  const previewLink = paragraph.locator("[data-markdown-link-href='#stable-heading']");
  await previewLink.click({
    modifiers: [process.platform === "darwin" ? "Meta" : "Control"],
  });
  await expect(page).toHaveURL(/#stable-heading$/u);
  await expect(paragraph).toHaveAttribute("data-markdown-preview-state", "preview");

  const paragraphBefore = await paragraph.boundingBox();
  const followingBefore = await followingList.boundingBox();
  expect(paragraphBefore).not.toBeNull();
  expect(followingBefore).not.toBeNull();

  await paragraph.locator(".rudder-cm-markdown-strong").click();
  const sourceParagraph = editor.locator(
    '[data-source-line-start="3"][data-markdown-preview-state="source"]',
  );
  await expect(sourceParagraph).toContainText(
    "Before **bold** and *italic* with [OpenAI](https://openai.com) and [Local](#stable-heading).",
  );
  await expect(sourceParagraph.locator("[data-markdown-website-icon='true']")).toHaveCount(0);
  await expect(editor.locator(".cm-activeLine")).toHaveAttribute(
    "data-source-line-start",
    "3",
  );
  await page.keyboard.insertText("Z");
  await expect(sourceParagraph).toContainText("Z");
  await expect(sourceParagraph).not.toContainText("ZBefore");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Z" : "Control+Z");
  await expect(sourceParagraph).toContainText("**bold**");

  const paragraphAfter = await sourceParagraph.boundingBox();
  const followingAfter = await followingList.boundingBox();
  expect(paragraphAfter).not.toBeNull();
  expect(followingAfter).not.toBeNull();
  expect(Math.abs(paragraphAfter!.height - paragraphBefore!.height)).toBeLessThan(0.5);
  expect(Math.abs(paragraphAfter!.y - paragraphBefore!.y)).toBeLessThan(0.5);
  expect(Math.abs(followingAfter!.y - followingBefore!.y)).toBeLessThan(0.5);

  await editor.locator(".cm-content").evaluate((element) => {
    if (element instanceof HTMLElement) element.blur();
  });
  const previewAgain = editor.locator(
    '[data-source-line-start="3"][data-markdown-preview-state="preview"]',
  );
  await expect(previewAgain).toBeVisible();
  const strongBox = await previewAgain.locator(".rudder-cm-markdown-strong").boundingBox();
  const emphasisBox = await previewAgain.locator(".rudder-cm-markdown-emphasis").boundingBox();
  expect(strongBox).not.toBeNull();
  expect(emphasisBox).not.toBeNull();
  await page.mouse.move(
    strongBox!.x + strongBox!.width / 2,
    strongBox!.y + strongBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    emphasisBox!.x + emphasisBox!.width / 2,
    emphasisBox!.y + emphasisBox!.height / 2,
    { steps: 5 },
  );
  await page.mouse.up();
  await expect(editor.locator(
    '[data-source-line-start="3"][data-markdown-preview-state="source"]',
  )).toBeVisible();
  await expect(editor.locator(".cm-selectionBackground")).not.toHaveCount(0);

  await expect(editor.locator('[data-markdown-source-kind="fenced-code"]')).toHaveCount(3);
  const saved = await request.get(
    `${E2E_BASE_URL}/api/orgs/${organization.id}/workspace/file?path=${encodeURIComponent(filePath)}`,
  );
  expect(saved.ok(), await saved.text()).toBe(true);
  expect((await saved.json() as { content: string }).content).toBe(markdown);
});
