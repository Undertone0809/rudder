import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block" });

const modifier: "Meta" | "Control" = process.platform === "darwin" ? "Meta" : "Control";

test("opens a Library Issue reference in the Side Panel without replacing the document", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  let expectedSaveConflictConsoleErrors = 0;
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (
      expectedSaveConflictConsoleErrors > 0
      && message.text() === "Failed to load resource: the server responded with a status of 409 (Conflict)"
    ) {
      expectedSaveConflictConsoleErrors -= 1;
      return;
    }
    consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    requestFailures.push(`${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? "unknown"}`);
  });
  const suffix = Date.now();
  const organizationResponse = await page.request.post("/api/orgs", {
    data: { name: `Library-Issue-Side-Panel-${suffix}` },
  });
  expect(organizationResponse.ok(), await organizationResponse.text()).toBe(true);
  const organization = await organizationResponse.json() as { id: string; issuePrefix: string; urlKey: string };

  const knownWebsiteUrl = "https://rudderhq.dev/docs";
  const metadataWebsiteUrl = "https://example.org/side-panel-metadata";
  const metadataIconUrl = "/api/website-metadata/icon?url=https%3A%2F%2Fexample.org%2Fside-panel-metadata.ico";
  const privateWebsiteUrl = "http://127.0.0.1:3100/private";
  const issueDescription = [
    "The Library document should remain visible while this Issue opens in the Side Panel.",
    `Known [Rudder docs](${knownWebsiteUrl}) and fetched [metadata icon](${metadataWebsiteUrl}).`,
    `Private [internal link](${privateWebsiteUrl}) keeps the generic fallback.`,
  ].join("\n\n");
  const metadataRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/website-metadata")) metadataRequests.push(request.url());
  });
  await page.route("**/api/website-metadata?**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.searchParams.get("url") !== metadataWebsiteUrl) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        url: metadataWebsiteUrl,
        siteName: "Example",
        pageTitle: null,
        iconUrl: metadataIconUrl,
      }),
    });
  });
  await page.route("**/api/website-metadata/icon?**", async (route) => {
    if (!route.request().url().includes(encodeURIComponent(metadataWebsiteUrl))) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 16 16\"><rect width=\"16\" height=\"16\" rx=\"3\" fill=\"#2563eb\"/></svg>",
    });
  });

  const issueResponse = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Inspect this Issue beside the Library document",
      description: issueDescription,
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
  const sidePanelDescription = sidePanel.locator(".rudder-milkdown-content").first();
  await expect(sidePanelDescription).toContainText("Rudder docs");
  const websiteIcons = sidePanelDescription.locator(".rudder-milkdown-website-icon");
  await expect(websiteIcons).toHaveCount(3);
  await expect(websiteIcons.nth(0)).toHaveAttribute("data-website-icon", "metadata");
  await expect(websiteIcons.nth(0).locator("img")).toHaveAttribute("src", /^data:image\/(?:x-icon|png|svg\+xml);base64,/u);
  await expect(websiteIcons.nth(1)).toHaveAttribute("data-website-icon", "metadata");
  await expect(websiteIcons.nth(1).locator("img")).toHaveAttribute("src", metadataIconUrl);
  await expect(websiteIcons.nth(2)).toHaveAttribute("data-website-icon", "generic");
  await expect(websiteIcons.nth(2).locator("img[src]")).toHaveCount(0);
  expect(metadataRequests.some((url) => url.includes(encodeURIComponent(metadataWebsiteUrl)))).toBe(true);
  expect(metadataRequests.some((url) => url.includes(encodeURIComponent(knownWebsiteUrl)))).toBe(false);
  expect(metadataRequests.some((url) => url.includes(encodeURIComponent(privateWebsiteUrl)))).toBe(false);
  const persistedIssueResponse = await page.request.get(`/api/issues/${issue.id}`);
  expect(persistedIssueResponse.ok(), await persistedIssueResponse.text()).toBe(true);
  expect((await persistedIssueResponse.json() as { description: string | null }).description).toBe(issueDescription);
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

  const releasedSaveResponse = page.waitForResponse((response) => (
    response.request().method() === "PATCH"
    && response.url().includes(`/api/orgs/${organization.id}/workspace/file`)
    && response.status() === 409
  ));
  expectedSaveConflictConsoleErrors = 1;
  releaseSave?.();
  await releasedSaveResponse;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(routeBeforeOpen);
  const mobileEditor = page.getByTestId("org-workspaces-markdown-editor");
  await expect(mobileEditor).toContainText(marker, { timeout: 15_000 });
  await mobileEditor.evaluate((element) => {
    const scrollables = [element, ...Array.from(element.querySelectorAll<HTMLElement>("*"))]
      .filter((candidate) => candidate.scrollHeight > candidate.clientHeight);
    for (const scrollable of scrollables) {
      scrollable.scrollTop = scrollable.scrollHeight;
    }
  });
  await page.evaluate(() => {
    window.scrollTo(0, Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
  });
  await expect(mobileEditor).toContainText("Review section 69", { timeout: 15_000 });
  const mobileIssueLink = page
    .locator('[data-mention-kind="issue"]')
    .first();
  await mobileIssueLink.scrollIntoViewIfNeeded();
  await expect(mobileIssueLink).toBeVisible({ timeout: 15_000 });
  await expect(mobileIssueLink).toHaveAttribute("href", new RegExp(`/issues/${issue.id}$`));
  await mobileIssueLink.click();
  await expect(page).toHaveURL(new RegExp(`/issues/${issue.id}$`));
  const mobileDescription = page.getByTestId("issue-detail-primary-content");
  const mobileWebsiteIcons = mobileDescription.locator(
    ".rudder-codemirror-markdown-website .rudder-website-link-icon",
  );
  await expect(mobileWebsiteIcons).toHaveCount(3);
  await expect(mobileWebsiteIcons.nth(2))
    .toHaveAttribute("data-website-icon", "generic");
  await page.screenshot({
    path: testInfo.outputPath("library-issue-side-panel-mobile.png"),
    fullPage: false,
  });

  expect(consoleErrors, `console errors: ${consoleErrors.join(" | ")}`).toEqual([]);
  expect(pageErrors, `page errors: ${pageErrors.join(" | ")}`).toEqual([]);
  const unexpectedRequestFailures = requestFailures.filter((failure) => !failure.endsWith("net::ERR_ABORTED"));
  expect(unexpectedRequestFailures, `request failures: ${requestFailures.join(" | ")}`).toEqual([]);
});
