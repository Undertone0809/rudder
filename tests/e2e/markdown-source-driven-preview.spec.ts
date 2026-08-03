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

test("Library Markdown restores the line hover block menu and formats its source block", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const organization = await createOrganization(request);
  const filePath = "docs/hover-block-menu.md";
  const markdown = [
    "# Stable heading",
    "",
    "Paragraph to format.",
    "",
    "- first item",
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
  const paragraph = editor.locator('[data-source-line-start="3"]');
  await expect(paragraph).toContainText("Paragraph to format.");
  await paragraph.hover();

  const trigger = page.getByTestId("markdown-block-menu-trigger");
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-label", "Open block actions for line 3");
  await trigger.click();

  const menu = page.getByTestId("markdown-block-menu");
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("Display");
  await expect(menu).toContainText("Number list");
  await menu.hover();
  await expect(menu).toBeVisible();

  await menu.getByRole("menuitem", { name: /Headline/iu }).click();
  const sourceParagraph = editor.locator(
    '[data-source-line-start="3"][data-markdown-preview-state="source"]',
  );
  await expect(sourceParagraph).toContainText("## Paragraph to format.");
  await expect(page.getByTestId("markdown-block-menu")).toHaveCount(0);

  await expect.poll(async () => {
    const saved = await request.get(
      `${E2E_BASE_URL}/api/orgs/${organization.id}/workspace/file?path=${encodeURIComponent(filePath)}`,
    );
    expect(saved.ok(), await saved.text()).toBe(true);
    return (await saved.json() as { content: string }).content;
  }).toContain(markdown.replace("Paragraph to format.", "## Paragraph to format."));
});

test("Library preview keeps hidden heading syntax out of pointer selections", async ({
  page,
  request,
}) => {
  const organization = await createOrganization(request);
  const filePath = "docs/heading-selection.md";
  const markdown = "# Visible heading\n\nA paragraph.";
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
  const heading = editor.locator(
    '[data-source-line-start="1"][data-markdown-preview-state="preview"]',
  );
  await expect(heading).toContainText("Visible heading");

  const visibleTextStart = await heading.evaluate((element) => {
    const findText = (node: Node): Text | null => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE && child.textContent) return child as Text;
        const descendant = findText(child);
        if (descendant) return descendant;
      }
      return null;
    };
    const textNode = findText(element);
    if (!textNode) throw new Error("Expected visible heading text");
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 1);
    return range.getBoundingClientRect().left;
  });
  const headingBox = await heading.boundingBox();
  expect(headingBox).not.toBeNull();

  await page.mouse.move(visibleTextStart + 1, headingBox!.y + headingBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(visibleTextStart + 90, headingBox!.y + headingBox!.height / 2, { steps: 4 });
  const selectionRects = await editor.evaluate((element) => Array.from(
    element.querySelectorAll<HTMLElement>(".cm-selectionBackground"),
  ).map((selection) => {
    const rect = selection.getBoundingClientRect();
    return { left: rect.left, width: rect.width };
  }));
  await page.mouse.up();

  expect(selectionRects.length).toBeGreaterThan(0);
  expect(Math.min(...selectionRects.map((rect) => rect.left))).toBeGreaterThanOrEqual(
    visibleTextStart - 1,
  );
});

test("Library vertical cursor movement visits every adjacent Markdown source line", async ({
  page,
  request,
}) => {
  const organization = await createOrganization(request);
  const filePath = "docs/vertical-cursor-navigation.md";
  const markdown = "# Heading\n\nParagraph\n";
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
  const activeLine = editor.locator(".cm-activeLine");
  await editor.locator('[data-source-line-start="1"]').click();
  await expect(activeLine).toHaveAttribute("data-source-line-start", "1");

  await page.keyboard.press("ArrowDown");
  await expect(activeLine).toHaveAttribute("data-source-line-start", "2");
  await page.keyboard.press("ArrowDown");
  await expect(activeLine).toHaveAttribute("data-source-line-start", "3");
  await page.keyboard.press("ArrowDown");
  await expect(activeLine).toHaveAttribute("data-source-line-start", "4");
  await page.keyboard.press("ArrowUp");
  await expect(activeLine).toHaveAttribute("data-source-line-start", "3");
});
