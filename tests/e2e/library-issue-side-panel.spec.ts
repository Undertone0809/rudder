import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block" });

const modifier: "Meta" | "Control" = process.platform === "darwin" ? "Meta" : "Control";

test("opens a Library Issue reference in the Side Panel without replacing the document", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const suffix = Date.now();
  const organizationResponse = await page.request.post("/api/orgs", {
    data: { name: `Library-Issue-Side-Panel-${suffix}` },
  });
  expect(organizationResponse.ok(), await organizationResponse.text()).toBe(true);
  const organization = await organizationResponse.json() as { id: string; issuePrefix: string; urlKey: string };

  const issueResponse = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Inspect this Issue beside the Library document",
      description: "The Library document should remain visible while this Issue opens in the Side Panel.",
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueResponse.ok(), await issueResponse.text()).toBe(true);
  const issue = await issueResponse.json() as { id: string; identifier: string | null; title: string };
  const issueRef = issue.identifier ?? issue.id;

  const filePath = `projects/library-side-panel-${suffix}/review.md`;
  const marker = `LibraryContextMarker${suffix}`;
  const unsavedMarker = `UnsavedLibraryDraft${suffix}`;
  const initialContent = [
    "# Review notes",
    "",
    `${marker} stays in the active Library document.`,
    "",
    ...Array.from({ length: 68 }, (_, index) => (
      `## Review section ${index + 1}\n\nThis production-shaped section keeps the Library document long enough to verify scroll continuity.`
    )),
    "",
    `Open [${issueRef}](issue://${issue.id}?ref=${encodeURIComponent(issueRef)}) for details.`,
    "",
    "## Review section 69",
    "",
    "This final section keeps the Issue reference inside the user's visible reading context.",
  ].join("\n");
  const fileResponse = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
    data: {
      filePath,
      content: initialContent,
    },
  });
  expect(fileResponse.ok(), await fileResponse.text()).toBe(true);

  let releaseSave: (() => void) | null = null;
  let markSaveStarted: (() => void) | null = null;
  const saveStarted = new Promise<void>((resolve) => {
    markSaveStarted = resolve;
  });
  const saveRelease = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route("**/api/orgs/*/workspace/file?*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (route.request().method() !== "PATCH" || requestUrl.searchParams.get("path") !== filePath) {
      await route.continue();
      return;
    }
    markSaveStarted?.();
    await saveRelease;
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "Verification keeps this draft local." }),
    });
  });

  await page.goto("/");
  await page.evaluate((organizationId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", organizationId);
  }, organization.id);
  await page.setViewportSize({ width: 1440, height: 900 });
  const libraryUrl = `/${organization.issuePrefix}/library?path=${encodeURIComponent(filePath)}`;
  await page.goto(libraryUrl);

  const editor = page.getByTestId("org-workspaces-markdown-editor");
  await expect(editor).toContainText(marker, { timeout: 15_000 });
  const codeMirror = editor.locator('[data-editor-engine="codemirror-live-preview"]');
  const content = codeMirror.locator(".cm-content");
  await content.click();
  await page.keyboard.press(`${modifier}+Home`);
  await page.keyboard.insertText(`${unsavedMarker}\n\n`);
  await content.evaluate((element) => {
    if (element instanceof HTMLElement) element.blur();
  });
  await saveStarted;
  await expect(editor).toContainText(unsavedMarker);

  await editor.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const issueLink = editor
    .locator('[data-mention-kind="issue"]')
    .filter({ hasText: issueRef })
    .first();
  await expect(issueLink).toBeVisible({ timeout: 15_000 });
  await expect(issueLink).toContainText(issue.title);
  await issueLink.scrollIntoViewIfNeeded();

  const continuityBeforeOpen = await editor.evaluate((element) => {
    const codeMirrorElement = element.querySelector<HTMLElement>('[data-editor-engine="codemirror-live-preview"]');
    const state = window as typeof window & { __libraryIssuePanelEditorNode?: HTMLElement };
    if (codeMirrorElement) state.__libraryIssuePanelEditorNode = codeMirrorElement;
    return {
      editorConnected: Boolean(codeMirrorElement?.isConnected),
      scrollTop: element.scrollTop,
    };
  });
  expect(continuityBeforeOpen.editorConnected).toBe(true);
  expect(continuityBeforeOpen.scrollTop).toBeGreaterThan(200);
  const maxExpectedPanelReflowPx = 400;

  const routeBeforeOpen = new URL(page.url()).pathname + new URL(page.url()).search;
  await issueLink.click();

  const sidePanel = page.getByTestId("chat-side-panel");
  await expect(sidePanel).toBeVisible({ timeout: 15_000 });
  await expect(sidePanel.getByTestId("chat-side-panel-issue-view")).toBeVisible();
  await expect(sidePanel.getByRole("heading", { name: issue.title })).toBeVisible();
  await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search).toBe(routeBeforeOpen);
  await expect(page.getByTestId("workspace-column-resizer")).toHaveCount(0);
  await expect(page.getByTestId("side-panel-resizer")).toBeVisible();
  await expect(
    page.getByTestId(`org-workspaces-editor-tab-${filePath}`).getByRole("tab"),
  ).toHaveAttribute("aria-selected", "true");
  const continuityAfterOpen = await editor.evaluate((element) => {
    const state = window as typeof window & { __libraryIssuePanelEditorNode?: HTMLElement };
    return {
      sameNode: element.querySelector('[data-editor-engine="codemirror-live-preview"]')
        === state.__libraryIssuePanelEditorNode,
      scrollTop: element.scrollTop,
    };
  });
  expect(continuityAfterOpen.sameNode).toBe(true);
  expect(continuityAfterOpen.scrollTop).toBeGreaterThan(200);
  expect(Math.abs(continuityAfterOpen.scrollTop - continuityBeforeOpen.scrollTop))
    .toBeLessThan(maxExpectedPanelReflowPx);

  const persistedWhileDraftIsPending = await page.request.get(
    `/api/orgs/${organization.id}/workspace/file?path=${encodeURIComponent(filePath)}`,
  );
  expect(persistedWhileDraftIsPending.ok(), await persistedWhileDraftIsPending.text()).toBe(true);
  expect((await persistedWhileDraftIsPending.json() as { content: string | null }).content).toBe(initialContent);

  await page.screenshot({
    path: testInfo.outputPath("library-issue-side-panel.png"),
    fullPage: false,
  });

  await sidePanel.getByTestId("chat-side-panel-collapse").click();
  await expect(sidePanel).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search).toBe(routeBeforeOpen);
  const continuityAfterHide = await editor.evaluate((element) => {
    const state = window as typeof window & { __libraryIssuePanelEditorNode?: HTMLElement };
    return {
      sameNode: element.querySelector('[data-editor-engine="codemirror-live-preview"]')
        === state.__libraryIssuePanelEditorNode,
      scrollTop: element.scrollTop,
    };
  });
  expect(continuityAfterHide.sameNode).toBe(true);
  expect(continuityAfterHide.scrollTop).toBeGreaterThan(200);
  expect(Math.abs(continuityAfterHide.scrollTop - continuityBeforeOpen.scrollTop))
    .toBeLessThan(maxExpectedPanelReflowPx);

  await page.getByTestId("side-panel-hover-edge").hover();
  await page.getByTestId("global-side-panel-trigger").click();
  await expect(sidePanel).toBeVisible();
  await expect(sidePanel.getByTestId("chat-side-panel-issue-view")).toBeVisible();
  await expect(sidePanel.getByRole("heading", { name: issue.title })).toBeVisible();
  await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search).toBe(routeBeforeOpen);
  const continuityAfterReopen = await editor.evaluate((element) => {
    const state = window as typeof window & { __libraryIssuePanelEditorNode?: HTMLElement };
    return {
      sameNode: element.querySelector('[data-editor-engine="codemirror-live-preview"]')
        === state.__libraryIssuePanelEditorNode,
      scrollTop: element.scrollTop,
    };
  });
  expect(continuityAfterReopen.sameNode).toBe(true);
  expect(continuityAfterReopen.scrollTop).toBeGreaterThan(200);
  expect(Math.abs(continuityAfterReopen.scrollTop - continuityBeforeOpen.scrollTop))
    .toBeLessThan(maxExpectedPanelReflowPx);

  await editor.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(editor).toContainText(marker);
  await expect(editor).toContainText(unsavedMarker);

  await sidePanel.getByTestId("chat-side-panel-collapse").click();
  await expect(sidePanel).toHaveCount(0);
  await editor.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(issueLink).toBeVisible();
  await issueLink.click({ modifiers: [modifier] });
  await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/issues/${issueRef}$`));
  await expect(page.getByTestId("chat-side-panel")).toHaveCount(0);

  releaseSave?.();
});
