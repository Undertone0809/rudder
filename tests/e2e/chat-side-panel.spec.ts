import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";
import { expectRightAnchoredSidePanelMotion, sampleSidePanelMotion } from "./support/side-panel-motion";

const e2eDb = createDb(E2E_DATABASE_URL);

function uniqueIssuePrefix() {
  return `T${randomUUID().replaceAll("-", "").slice(0, 9).toUpperCase()}`;
}

function createSimplePdf() {
  const stream = "BT /F1 18 Tf 36 96 Td (Rudder PDF preview) Tj /F1 10 Tf 0 -24 Td (Rendered in Messenger.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "utf8"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, "utf8");
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer << /Root 1 0 R /Size ${objects.length + 1} >>\n`;
  body += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "utf8");
}

function buildIssueMentionHref(issueId: string, ref?: string | null, commentId?: string | null) {
  const params = new URLSearchParams();
  if (ref) params.set("r", ref);
  if (commentId) params.set("c", commentId);
  const query = params.toString();
  return query ? `issue://${issueId}?${query}` : `issue://${issueId}`;
}

function buildChatMentionHref(chatId: string) {
  return `chat://${chatId}`;
}

function buildAutomationMentionHref(automationId: string, title?: string | null) {
  const params = new URLSearchParams();
  if (title) params.set("t", title);
  const query = params.toString();
  return query ? `automation://${automationId}?${query}` : `automation://${automationId}`;
}

function buildLibraryDirectoryMentionHref(directoryPath: string) {
  return `library-directory://directory?p=${encodeURIComponent(directoryPath)}`;
}

async function installDesktopShellFileLauncherStub(page: Page) {
  await page.addInitScript(() => {
    const fileLocationCalls: Array<{ rootPath: string; filePath: string; targetId: string }> = [];
    Object.defineProperty(window, "__rudderFileLocationCalls", {
      configurable: true,
      value: fileLocationCalls,
    });
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: {
        listWorkspaceLaunchTargets: async () => [
          { id: "vscode", label: "VS Code", kind: "ide" },
          { id: "terminal", label: "Terminal", kind: "terminal" },
          { id: "finder", label: "Finder", kind: "folder" },
        ],
        openWorkspaceFileInIde: async () => {},
        openWorkspaceFileLocation: async (rootPath: string, filePath: string, targetId: string) => {
          fileLocationCalls.push({ rootPath, filePath, targetId });
        },
        setSidePanelCloseShortcutActive: async () => {},
      },
    });
  });
}

async function installBrowserDesktopStub(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: {
        getBrowserPartition: async () => "persist:rudder-browser-v1-chat-e2e",
        openExternal: async () => {},
        forceOpenExternal: async () => {},
        setSidePanelCloseShortcutActive: async () => {},
        onCloseSidePanelActiveTab: () => () => {},
        onBrowserReset: () => () => {},
      },
    });
  });
}

async function installEnabledBrowserSettingsStub(page: Page) {
  await page.route("**/api/instance/settings/browser", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      json: { enabled: true, openLinksIn: "built_in" },
      status: 200,
    });
  });
}

test.describe("Chat Side Panel", () => {
  test("renders the full issue detail body when an issue Side Panel tab is expanded", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Side-Panel-Expanded-Issue-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Expanded detail parity issue",
        description: "Expanded Side Panel should render the same issue detail body.",
        status: "todo",
        priority: "high",
      },
    });
    expect(issueRes.ok(), await issueRes.text()).toBe(true);
    const issue = await issueRes.json() as { id: string; identifier: string | null };
    const issueRef = issue.identifier ?? issue.id;
    const commentRes = await page.request.post(`/api/issues/${issue.id}/comments`, {
      data: { body: "Expanded detail activity should be visible." },
    });
    expect(commentRes.ok(), await commentRes.text()).toBe(true);

    const hostChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Expanded issue side panel host chat",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(hostChatRes.ok(), await hostChatRes.text()).toBe(true);
    const hostChat = await hostChatRes.json() as { id: string };

    await e2eDb.insert(chatMessages).values({
      id: randomUUID(),
      orgId: organization.id,
      conversationId: hostChat.id,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: `Open [${issueRef}](${buildIssueMentionHref(issue.id, issueRef)}) beside this chat.`,
      structuredPayload: null,
      replyingAgentId: null,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${hostChat.id}`);
    const assistantMessage = page.getByTestId("chat-assistant-message").last();
    await expect(assistantMessage).toContainText("Open", { timeout: 15_000 });

    await assistantMessage.locator('a[data-mention-kind="issue"]').filter({ hasText: issueRef }).click();
    const sidePanel = page.getByTestId("chat-side-panel");
    await expect(sidePanel).toBeVisible({ timeout: 15_000 });
    await expect(sidePanel.getByTestId("chat-side-panel-issue-view")).toBeVisible();

    await sidePanel.getByLabel("Expand Side Panel").click();
    await expect(sidePanel.getByTestId("embedded-issue-detail")).toBeVisible();
    await expect(sidePanel.getByTestId("chat-side-panel-issue-view")).toHaveCount(0);
    await expect(sidePanel).toContainText("Expanded detail parity issue");
    await expect(sidePanel).toContainText("Expanded Side Panel should render the same issue detail body.");
    await expect(sidePanel.getByText("Properties", { exact: true })).toBeVisible();
    await expect(sidePanel.getByRole("region", { name: "Issue properties" })).toBeVisible();
    await expect(sidePanel).toContainText("Sub-issues");
    await expect(sidePanel).toContainText("Add sub-issue");
    await expect(sidePanel).toContainText("Attach");
    await expect(sidePanel).toContainText("Activity");
    await expect(sidePanel).toContainText("Expanded detail activity should be visible.");
    await expect(page).toHaveURL(new RegExp(`/messenger/chat/${hostChat.id}$`));

    await page.screenshot({
      path: testInfo.outputPath("chat-side-panel-expanded-issue-detail.png"),
      fullPage: true,
    });
  });

  test("opens a Library document with Desktop app, Finder, and Terminal targets", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Side-Panel-File-Launcher-${Date.now()}`,
        issuePrefix: `CSL${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string; urlKey?: string | null };
    const libraryFilePath = `projects/competitor-research/exports/2026/07/file-launcher-${Date.now()}.md`;
    const initialLibraryContent = "# OpenClaw and Hermes Agent SEO competitor research\n\nOpen this document outside Rudder.";
    const libraryFileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: {
        filePath: libraryFilePath,
        content: initialLibraryContent,
      },
    });
    expect(libraryFileRes.ok(), await libraryFileRes.text()).toBe(true);
    const libraryFile = await libraryFileRes.json() as { markdownLink: string };
    const libraryFileName = libraryFilePath.split("/").at(-1) ?? libraryFilePath;
    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Library file launcher host chat",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(chatRes.ok(), await chatRes.text()).toBe(true);
    const chat = await chatRes.json() as { id: string };
    await e2eDb.insert(chatMessages).values({
      id: randomUUID(),
      orgId: organization.id,
      conversationId: chat.id,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: `Open ${libraryFile.markdownLink} beside this chat.`,
      structuredPayload: null,
      replyingAgentId: null,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await installDesktopShellFileLauncherStub(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

    const assistantMessage = page.getByTestId("chat-assistant-message").last();
    await expect(assistantMessage).toContainText(libraryFileName, { timeout: 15_000 });
    await assistantMessage.getByRole("link", { name: libraryFileName }).click();
    const sidePanel = page.getByTestId("chat-side-panel");
    const documentTitle = sidePanel.getByRole("heading", {
      name: "OpenClaw and Hermes Agent SEO competitor research",
      exact: true,
    });
    await expect(documentTitle).toBeVisible();
    const fileToolbar = sidePanel.getByTestId("chat-side-panel-library-file-toolbar");
    const filePath = fileToolbar.getByRole("navigation", { name: "Library file path" });
    await expect(filePath.getByText("…", { exact: true })).toBeVisible();
    await expect(filePath.getByText("07", { exact: true })).toBeVisible();
    const fileNameBreadcrumb = filePath.getByText(libraryFileName, { exact: true });
    await expect(fileNameBreadcrumb).toBeVisible();
    await expect(fileToolbar).not.toContainText("text/markdown");

    await filePath.hover();
    await expect(page.getByTestId("chat-side-panel-library-full-path")).toContainText(libraryFilePath);

    const libraryOpenIn = sidePanel.getByRole("button", { name: "Open file options" });
    await expect(libraryOpenIn).toBeVisible();
    await expect(libraryOpenIn).toHaveText("Open");
    const [toolbarBox, pathBox, fileNameBox, openInBox, titleBox] = await Promise.all([
      fileToolbar.boundingBox(),
      filePath.boundingBox(),
      fileNameBreadcrumb.boundingBox(),
      libraryOpenIn.boundingBox(),
      documentTitle.boundingBox(),
    ]);
    expect(toolbarBox).not.toBeNull();
    expect(pathBox).not.toBeNull();
    expect(fileNameBox).not.toBeNull();
    expect(titleBox).not.toBeNull();
    expect(openInBox).not.toBeNull();
    expect(Math.abs(
      ((pathBox?.y ?? 0) + (pathBox?.height ?? 0) / 2)
      - ((openInBox?.y ?? 0) + (openInBox?.height ?? 0) / 2),
    )).toBeLessThanOrEqual(2);
    expect(fileNameBox?.x ?? 0).toBeGreaterThanOrEqual(pathBox?.x ?? 0);
    expect((fileNameBox?.x ?? 0) + (fileNameBox?.width ?? 0)).toBeLessThanOrEqual(
      (pathBox?.x ?? 0) + (pathBox?.width ?? 0) + 1,
    );
    expect(fileNameBox?.width ?? 0).toBeGreaterThan(40);
    expect(titleBox?.y ?? 0).toBeGreaterThanOrEqual(
      (toolbarBox?.y ?? 0) + (toolbarBox?.height ?? 0),
    );

    const markdownEditor = sidePanel.getByTestId("chat-side-panel-library-markdown-editor");
    const editable = markdownEditor.locator(".rudder-milkdown-content [contenteditable='true']").first();
    const historyControls = markdownEditor.getByTestId("chat-side-panel-library-history-controls");
    const undoButton = markdownEditor.getByRole("button", { name: "Undo Markdown edit" });
    const redoButton = markdownEditor.getByRole("button", { name: "Redo Markdown edit" });
    await expect(editable).toBeVisible();
    await expect(historyControls).toBeVisible();
    await expect(sidePanel.getByTestId("chat-side-panel-library-file-mode-toggle")).toHaveCount(0);
    await expect(undoButton).toBeDisabled();

    let patchAttempts = 0;
    let allowPatch = false;
    await page.route("**/api/orgs/**/workspace/file**", async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.continue();
        return;
      }
      patchAttempts += 1;
      if (!allowPatch) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Temporary Side Panel save failure" }),
        });
        return;
      }
      await route.continue();
    });

    await documentTitle.evaluate((heading) => {
      const editableRoot = heading.closest<HTMLElement>("[contenteditable='true']");
      editableRoot?.focus();
      const range = document.createRange();
      range.selectNodeContents(heading);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await page.keyboard.type(" revised");
    await expect(markdownEditor.getByRole("heading", {
      name: "OpenClaw and Hermes Agent SEO competitor research revised",
      exact: true,
    })).toBeVisible();
    await expect(undoButton).toBeEnabled();

    await undoButton.click();
    await expect(markdownEditor.getByRole("heading", {
      name: "OpenClaw and Hermes Agent SEO competitor research",
      exact: true,
    })).toBeVisible();
    await expect(redoButton).toBeEnabled();

    await redoButton.click();
    await expect(markdownEditor.getByRole("heading", {
      name: "OpenClaw and Hermes Agent SEO competitor research revised",
      exact: true,
    })).toBeVisible();
    await expect(markdownEditor).toContainText("Save failed", { timeout: 10_000 });
    allowPatch = true;
    await markdownEditor.getByRole("button", { name: "Retry" }).click();
    await expect(markdownEditor).toContainText("Saved", { timeout: 10_000 });
    expect(patchAttempts).toBeGreaterThanOrEqual(2);

    const retriedFileRes = await page.request.get(
      `/api/orgs/${organization.id}/workspace/file?path=${encodeURIComponent(libraryFilePath)}`,
    );
    expect(retriedFileRes.ok(), await retriedFileRes.text()).toBe(true);
    const retriedFile = await retriedFileRes.json() as { content: string | null };
    expect(retriedFile.content).toContain("# OpenClaw and Hermes Agent SEO competitor research revised");

    allowPatch = false;
    const revisedHeading = markdownEditor.getByRole("heading", {
      name: "OpenClaw and Hermes Agent SEO competitor research revised",
      exact: true,
    });
    await revisedHeading.evaluate((heading) => {
      const editableRoot = heading.closest<HTMLElement>("[contenteditable='true']");
      editableRoot?.focus();
      const range = document.createRange();
      range.selectNodeContents(heading);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await page.keyboard.type(" conflict");
    await expect(markdownEditor).toContainText("Save failed", { timeout: 10_000 });

    const concurrentLibraryContent = "# New agent copy\n\nKeep this concurrent update.";
    const concurrentWriteRes = await page.request.patch(
      `/api/orgs/${organization.id}/workspace/file?path=${encodeURIComponent(libraryFilePath)}`,
      { data: { content: concurrentLibraryContent, expectedContent: retriedFile.content } },
    );
    expect(concurrentWriteRes.ok(), await concurrentWriteRes.text()).toBe(true);

    allowPatch = true;
    await expect(markdownEditor).toContainText("Conflict", { timeout: 10_000 });
    await expect(markdownEditor.getByRole("button", { name: "Keep mine" })).toBeVisible();
    await expect(markdownEditor.getByRole("button", { name: "Use latest" })).toBeVisible();
    await expect(markdownEditor.getByRole("heading", {
      name: "OpenClaw and Hermes Agent SEO competitor research revised conflict",
      exact: true,
    })).toBeVisible();

    await markdownEditor.getByRole("button", { name: "Keep mine" }).click();
    await expect(markdownEditor).toContainText("Saved");

    const keptFileRes = await page.request.get(
      `/api/orgs/${organization.id}/workspace/file?path=${encodeURIComponent(libraryFilePath)}`,
    );
    expect(keptFileRes.ok(), await keptFileRes.text()).toBe(true);
    const keptFile = await keptFileRes.json() as { content: string | null };
    expect(keptFile.content).toContain("OpenClaw and Hermes Agent SEO competitor research revised conflict");
    expect(keptFile.content).not.toBe(concurrentLibraryContent);

    allowPatch = false;
    const keptHeading = markdownEditor.getByRole("heading", {
      name: "OpenClaw and Hermes Agent SEO competitor research revised conflict",
      exact: true,
    });
    await keptHeading.evaluate((heading) => {
      const editableRoot = heading.closest<HTMLElement>("[contenteditable='true']");
      editableRoot?.focus();
      const range = document.createRange();
      range.selectNodeContents(heading);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await page.keyboard.type(" again");
    await expect(markdownEditor).toContainText("Save failed", { timeout: 10_000 });

    const secondConcurrentContent = "# Latest agent copy\n\nUse this second concurrent update.";
    const secondConcurrentWriteRes = await page.request.patch(
      `/api/orgs/${organization.id}/workspace/file?path=${encodeURIComponent(libraryFilePath)}`,
      { data: { content: secondConcurrentContent, expectedContent: keptFile.content } },
    );
    expect(secondConcurrentWriteRes.ok(), await secondConcurrentWriteRes.text()).toBe(true);

    allowPatch = true;
    await expect(markdownEditor).toContainText("Conflict", { timeout: 10_000 });
    await markdownEditor.getByRole("button", { name: "Use latest" }).click();
    await expect(markdownEditor).toContainText("Saved");
    await expect(markdownEditor.getByRole("heading", { name: "Latest agent copy", exact: true })).toBeVisible();

    const savedFileRes = await page.request.get(
      `/api/orgs/${organization.id}/workspace/file?path=${encodeURIComponent(libraryFilePath)}`,
    );
    expect(savedFileRes.ok(), await savedFileRes.text()).toBe(true);
    const savedFile = await savedFileRes.json() as { content: string | null };
    expect(savedFile.content).toBe(secondConcurrentContent);

    const [editorBox, historyBox] = await Promise.all([
      markdownEditor.boundingBox(),
      historyControls.boundingBox(),
    ]);
    expect(editorBox).not.toBeNull();
    expect(historyBox).not.toBeNull();
    expect(historyBox?.x ?? 0).toBeGreaterThanOrEqual(editorBox?.x ?? 0);
    expect((historyBox?.x ?? 0) + (historyBox?.width ?? 0)).toBeLessThanOrEqual(
      (editorBox?.x ?? 0) + (editorBox?.width ?? 0) + 1,
    );
    expect((historyBox?.y ?? 0) + (historyBox?.height ?? 0)).toBeLessThanOrEqual(
      (editorBox?.y ?? 0) + (editorBox?.height ?? 0) + 1,
    );

    await page.screenshot({
      path: testInfo.outputPath("chat-side-panel-library-markdown-editor.png"),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(sidePanel).toHaveClass(/fixed/);
    await expect(historyControls).toBeVisible();
    const mobileHistoryBox = await historyControls.boundingBox();
    expect(mobileHistoryBox).not.toBeNull();
    expect(mobileHistoryBox?.x ?? 0).toBeGreaterThanOrEqual(0);
    expect((mobileHistoryBox?.x ?? 0) + (mobileHistoryBox?.width ?? 0)).toBeLessThanOrEqual(390);
    expect((mobileHistoryBox?.y ?? 0) + (mobileHistoryBox?.height ?? 0)).toBeLessThanOrEqual(844);
    await page.screenshot({
      path: testInfo.outputPath("chat-side-panel-library-markdown-editor-mobile.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 900 });

    await libraryOpenIn.click();
    await expect(page.getByRole("menuitem", { name: "Open in Library" })).toBeVisible();
    await expect(page.getByTestId("chat-side-panel-library-full-path")).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Default app" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "VS Code" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Finder" })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("chat-side-panel-library-open-in-menu.png"),
      fullPage: true,
    });
    await page.getByRole("menuitem", { name: "Terminal" }).click();
    await expect(page.getByText("Opened in Terminal")).toBeVisible();
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & {
        __rudderFileLocationCalls?: Array<{ rootPath: string; filePath: string; targetId: string }>;
      }
    ).__rudderFileLocationCalls ?? [])).toEqual([
      expect.objectContaining({ filePath: libraryFilePath, targetId: "terminal" }),
    ]);

    await sidePanel.getByLabel("Expand Side Panel").click();
    await expect(sidePanel.getByTestId("chat-side-panel-library-file-toolbar")).toBeVisible();
    await expect(sidePanel.getByRole("navigation", { name: "Library file path" })).toContainText(libraryFileName);
    await expect(sidePanel.getByRole("button", { name: "Open file options" })).toHaveText("Open");

    await page.screenshot({
      path: testInfo.outputPath("chat-side-panel-library-open-in.png"),
      fullPage: true,
    });

    await sidePanel.getByRole("button", { name: "Open file options" }).click();
    await page.getByRole("menuitem", { name: "Open in Library" }).click();
    const organizationRouteKey = organization.urlKey || organization.issuePrefix;
    await expect(page).toHaveURL(new RegExp(`/${organizationRouteKey}/library\\?path=${encodeURIComponent(libraryFilePath)}$`));
    await expect(page.getByTestId("org-workspaces-editor-tabs")).toContainText(libraryFileName, { timeout: 15_000 });
  });

  test("previews a Library PDF inline in the Side Panel", async ({ page, request }, testInfo) => {
    const orgRes = await request.post("/api/orgs", {
      data: {
        name: `Chat-Side-Panel-PDF-${Date.now()}`,
        issuePrefix: `CSP${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    const pdfFilePath = `projects/reports/2026/quarterly-${Date.now()}.pdf`;
    const fileRes = await request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: {
        filePath: pdfFilePath,
        content: createSimplePdf().toString("utf8"),
      },
    });
    expect(fileRes.ok(), await fileRes.text()).toBe(true);
    const libraryFile = await fileRes.json() as { markdownLink: string };
    const pdfFileName = pdfFilePath.split("/").at(-1) ?? pdfFilePath;

    const chatRes = await request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "PDF Side Panel preview host chat",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(chatRes.ok(), await chatRes.text()).toBe(true);
    const chat = await chatRes.json() as { id: string };
    await e2eDb.insert(chatMessages).values({
      id: randomUUID(),
      orgId: organization.id,
      conversationId: chat.id,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: `Preview ${libraryFile.markdownLink} beside this chat.`,
      structuredPayload: null,
      replyingAgentId: null,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

    const assistantMessage = page.getByTestId("chat-assistant-message").last();
    await expect(assistantMessage).toContainText(pdfFileName, { timeout: 15_000 });
    await assistantMessage.getByRole("link", { name: pdfFileName }).click();

    const sidePanel = page.getByTestId("chat-side-panel");
    const preview = sidePanel.getByTestId("chat-side-panel-library-pdf-preview");
    await expect(preview).toBeVisible({ timeout: 15_000 });
    await expect(preview).toHaveAttribute(
      "data-pdf-src",
      new RegExp(`/api/orgs/${organization.id}/workspace/file/content\\?path=${encodeURIComponent(pdfFilePath)}`),
    );
    const previewCanvas = sidePanel.getByTestId("chat-side-panel-library-pdf-preview-canvas");
    await expect(previewCanvas).toHaveAttribute("data-rendered-page", "1", { timeout: 15_000 });
    await expect(sidePanel.getByTestId("chat-side-panel-library-pdf-preview-text-content"))
      .toContainText("Rudder PDF preview");
    await expect.poll(() => previewCanvas.evaluate((canvasElement) => {
      const canvas = canvasElement as HTMLCanvasElement;
      const context = canvas.getContext("2d");
      if (!context || canvas.width === 0 || canvas.height === 0) return 0;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let inkPixels = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index]! < 230 || pixels[index + 1]! < 230 || pixels[index + 2]! < 230) inkPixels += 1;
      }
      return inkPixels;
    })).toBeGreaterThan(20);
    await expect(sidePanel.getByText("No inline preview is available for this file.")).toHaveCount(0);

    const contentResponse = await request.get(
      `/api/orgs/${organization.id}/workspace/file/content?path=${encodeURIComponent(pdfFilePath)}`,
    );
    expect(contentResponse.ok(), await contentResponse.text()).toBe(true);
    expect(contentResponse.headers()["content-type"]).toBe("application/pdf");
    expect(contentResponse.headers()["content-disposition"]).toContain("inline;");

    await page.screenshot({
      path: testInfo.outputPath("chat-side-panel-library-pdf-preview.png"),
      fullPage: true,
    });
  });

  test("reuses the Automation detail UI in the Side Panel", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Side-Panel-Automation-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Side Panel Automation Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { model: "gpt-5.4" },
      },
    });
    expect(agentRes.ok(), await agentRes.text()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    const automationRes = await page.request.post(`/api/orgs/${organization.id}/automations`, {
      data: {
        title: "Shared Side Panel automation detail",
        description: "This Automation uses the same detail UI in Messenger and the workspace.",
        assigneeAgentId: agent.id,
        priority: "medium",
        outputMode: "chat_output",
      },
    });
    expect(automationRes.ok(), await automationRes.text()).toBe(true);
    const automation = await automationRes.json() as { id: string; title: string };
    const triggerRes = await page.request.post(`/api/automations/${automation.id}/triggers`, {
      data: {
        kind: "schedule",
        label: "weekday verification",
        cronExpression: "0 9 * * 1-5",
        timezone: "Asia/Shanghai",
      },
    });
    expect(triggerRes.ok(), await triggerRes.text()).toBe(true);

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Automation detail host chat",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(chatRes.ok(), await chatRes.text()).toBe(true);
    const chat = await chatRes.json() as { id: string };
    await e2eDb.insert(chatMessages).values({
      id: randomUUID(),
      orgId: organization.id,
      conversationId: chat.id,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: `Inspect [${automation.title}](${buildAutomationMentionHref(automation.id, automation.title)}) beside this chat.`,
      structuredPayload: null,
      replyingAgentId: null,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    const hostChatPath = `/${organization.issuePrefix}/messenger/chat/${chat.id}`;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(hostChatPath);

    const assistantMessage = page.getByTestId("chat-assistant-message").last();
    await expect(assistantMessage).toContainText(automation.title, { timeout: 15_000 });
    await assistantMessage.locator('a[data-mention-kind="automation"]').click();

    const sidePanel = page.getByTestId("chat-side-panel");
    await expect(page).toHaveURL(new RegExp(`${chat.id}$`));
    await expect(sidePanel).toBeVisible({ timeout: 15_000 });
    await expect(sidePanel.getByTestId("chat-side-panel-automation-view")).toBeVisible();
    await expect(sidePanel.getByTestId("automation-detail-shell")).toBeVisible();
    await expect(sidePanel).toContainText(automation.title);
    await expect(sidePanel).toContainText("Details");
    await expect(sidePanel).toContainText("Frequency");
    await expect(sidePanel).toContainText("Previous runs");
    await expect(sidePanel.getByLabel("Pause automation")).toBeVisible();
    await sidePanel.getByRole("button", { name: "Automation actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Run now" })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.screenshot({
      path: testInfo.outputPath("chat-side-panel-shared-automation-detail.png"),
      fullPage: true,
    });

    await sidePanel.getByLabel("Close automation detail").click();
    await expect(sidePanel.getByTestId("automation-detail-shell")).toHaveCount(0);
  });

  test("opens issue, automation, library, and chat references in the Side Panel without replacing the Chat route", async ({ page }, testInfo) => {
    test.setTimeout(120_000);

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Side-Panel-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Reference issue target",
        description: "Issue details should stay beside the active chat.",
        status: "todo",
        priority: "high",
      },
    });
    expect(issueRes.ok(), await issueRes.text()).toBe(true);
    const issue = await issueRes.json() as { id: string; identifier: string | null; title: string };
    const issueRef = issue.identifier ?? issue.id;
    const existingCommentRes = await page.request.post(`/api/issues/${issue.id}/comments`, {
      data: {
        body: "Existing side panel comment should stay visible.",
      },
    });
    expect(existingCommentRes.ok(), await existingCommentRes.text()).toBe(true);
    for (let index = 1; index <= 12; index += 1) {
      const scrollCommentRes = await page.request.post(`/api/issues/${issue.id}/comments`, {
        data: {
          body: `Scrollable side panel activity comment ${index}. This keeps the issue activity long enough to verify narrow panel scrolling.`,
        },
      });
      expect(scrollCommentRes.ok(), await scrollCommentRes.text()).toBe(true);
    }

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Reference Automation Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { model: "gpt-5.4" },
      },
    });
    expect(agentRes.ok(), await agentRes.text()).toBe(true);
    const agent = await agentRes.json() as { id: string };
    const assignIssueRes = await page.request.patch(`/api/issues/${issue.id}`, {
      data: { assigneeAgentId: agent.id },
    });
    expect(assignIssueRes.ok(), await assignIssueRes.text()).toBe(true);

    const automationRes = await page.request.post(`/api/orgs/${organization.id}/automations`, {
      data: {
        title: "Codex verification automation",
        description: "Run a verification pass and report the result.",
        assigneeAgentId: agent.id,
        priority: "medium",
        outputMode: "chat_output",
      },
    });
    expect(automationRes.ok(), await automationRes.text()).toBe(true);
    const automation = await automationRes.json() as { id: string; title: string };
    const triggerRes = await page.request.post(`/api/automations/${automation.id}/triggers`, {
      data: {
        kind: "schedule",
        label: "weekday verification",
        cronExpression: "0 9 * * 1-5",
        timezone: "Asia/Shanghai",
      },
    });
    expect(triggerRes.ok(), await triggerRes.text()).toBe(true);

    const libraryFilePath = `docs/side-panel-${Date.now()}.md`;
    const libraryFileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: {
        filePath: libraryFilePath,
        content: "# Reference library file\n\nLibrary preview should render beside the active chat.",
      },
    });
    expect(libraryFileRes.ok(), await libraryFileRes.text()).toBe(true);
    const libraryFile = await libraryFileRes.json() as { markdownLink: string };
    const libraryFileName = libraryFilePath.split("/").at(-1) ?? libraryFilePath;

    const referencedChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Referenced detail chat",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(referencedChatRes.ok(), await referencedChatRes.text()).toBe(true);
    const referencedChat = await referencedChatRes.json() as { id: string };

    await e2eDb.insert(chatMessages).values({
      id: randomUUID(),
      orgId: organization.id,
      conversationId: referencedChat.id,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Referenced chat body should render beside the active chat.",
      structuredPayload: null,
      replyingAgentId: null,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    const hostChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Reference host chat",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(hostChatRes.ok(), await hostChatRes.text()).toBe(true);
    const hostChat = await hostChatRes.json() as { id: string };

    await e2eDb.insert(chatMessages).values({
      id: randomUUID(),
      orgId: organization.id,
      conversationId: hostChat.id,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: [
        `Open [${issueRef}](${buildIssueMentionHref(issue.id, issueRef)}) beside this chat.`,
        `Inspect [${automation.title}](${buildAutomationMentionHref(automation.id, automation.title)}) beside this chat.`,
        `Read ${libraryFile.markdownLink} beside this chat.`,
        `Compare [Referenced detail chat](${buildChatMentionHref(referencedChat.id)}) beside this chat.`,
      ].join("\n\n"),
      structuredPayload: null,
      replyingAgentId: null,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    const hostChatPath = `/${organization.issuePrefix}/messenger/chat/${hostChat.id}`;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(hostChatPath);

    const assistantMessage = page
      .getByTestId("chat-assistant-message")
      .filter({ hasText: "Compare" })
      .last();
    await expect(assistantMessage).toContainText("Open", { timeout: 15_000 });

    await assistantMessage.locator('a[data-mention-kind="issue"]').filter({ hasText: issueRef }).click();
    await expect(page).toHaveURL(new RegExp(`${hostChat.id}$`));
    const sidePanel = page.getByTestId("chat-side-panel");
    await expect(sidePanel).toBeVisible({ timeout: 15_000 });
    await expect(sidePanel.getByTestId("chat-side-panel-tabs")).toBeVisible();
    await expect(sidePanel.getByText("Side Panel", { exact: true })).toHaveCount(0);
    await expect(sidePanel.getByRole("button", { name: /Close .*Reference issue target tab$/ })).toBeVisible();
    await expect(sidePanel).toContainText("Reference issue target");
    await expect(sidePanel).toContainText("Issue details should stay beside the active chat.");
    await expect(sidePanel).toContainText("Existing side panel comment should stay visible.");
    await expect(sidePanel.getByLabel("Edit issue")).toHaveCount(0);
    await expect(sidePanel.getByRole("region", { name: "Issue properties" })).toBeVisible();
    await expect(sidePanel.getByText("Reference Automation Agent", { exact: true })).toBeVisible();
    await expect(sidePanel.getByText("Engineer", { exact: true })).toBeVisible();
    await expect(sidePanel.getByLabel("Close Side Panel")).toBeVisible();
    await expect(sidePanel.getByLabel("Expand Side Panel")).toBeVisible();
    await expect(sidePanel.getByRole("link", { name: "Full page" })).toHaveCount(0);

    const propertiesPanel = sidePanel.getByRole("region", { name: "Issue properties" });
    await propertiesPanel.locator('button:has([data-slot="issue-status-icon"])').first().click();
    await page.getByRole("menuitemradio", { name: "Done" }).click();
    await expect(propertiesPanel.getByText("Done", { exact: true })).toBeVisible();

    const reassigneeRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Side Panel Reviewer",
        role: "pm",
        title: "Review Lead",
      },
    });
    expect(reassigneeRes.ok(), await reassigneeRes.text()).toBe(true);
    const reassignee = await reassigneeRes.json() as { id: string };

    await propertiesPanel.getByText("Reference Automation Agent", { exact: true }).click();
    await page.getByPlaceholder("Search assignees...").fill("Side Panel Reviewer");
    const assigneePatchResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "PATCH"
        && url.pathname.endsWith(`/api/issues/${issue.id}`);
    });
    await page.getByRole("button", { name: /Side Panel Reviewer/ }).click();
    const assigneePatchRes = await assigneePatchResponse;
    expect(assigneePatchRes.ok(), await assigneePatchRes.text()).toBe(true);
    await expect(propertiesPanel.getByText("Side Panel Reviewer", { exact: true })).toBeVisible();
    await expect(propertiesPanel.getByText("Review Lead", { exact: true })).toBeVisible();

    await sidePanel.getByRole("heading", { name: "Reference issue target" }).click();
    const titlePatchResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "PATCH"
        && url.pathname.endsWith(`/api/issues/${issue.id}`);
    });
    await sidePanel.locator("textarea").first().fill("Reference issue target edited");
    await page.keyboard.press("Enter");
    const titlePatchRes = await titlePatchResponse;
    expect(titlePatchRes.ok(), await titlePatchRes.text()).toBe(true);

    const descriptionPatchResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "PATCH"
        && url.pathname.endsWith(`/api/issues/${issue.id}`);
    });
    const descriptionEditor = sidePanel.locator(".rudder-inline-markdown-surface .rudder-milkdown-content [contenteditable='true']").first();
    await expect(descriptionEditor).toBeVisible({ timeout: 15_000 });
    await descriptionEditor.fill("Edited from the chat detail panel.");
    await propertiesPanel.click();
    const descriptionPatchRes = await descriptionPatchResponse;
    expect(descriptionPatchRes.ok(), await descriptionPatchRes.text()).toBe(true);
    await expect(sidePanel).toContainText("Reference issue target edited");
    await expect(sidePanel).toContainText("Edited from the chat detail panel.");

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(sidePanel).toBeVisible();
    const activityRegion = sidePanel.getByRole("region", { name: "Activity" });
    const scrollBody = sidePanel.locator("[data-testid='chat-side-panel-scroll-body']");
    const issueScroller = sidePanel.locator("[data-testid='chat-side-panel-issue-scroll']");
    const timelineFlow = sidePanel.locator("[data-testid='comment-thread-timeline-flow']");
    const activityScroller = sidePanel.locator("[data-testid='comment-thread-timeline-scroll']");
    const fixedComposer = sidePanel.locator("[data-testid='comment-thread-fixed-composer']");
    await expect(activityRegion).toBeVisible();
    await expect(scrollBody).toBeVisible();
    await expect(issueScroller).toBeVisible();
    await expect(timelineFlow).toBeVisible();
    await expect(activityScroller).toHaveCount(0);
    await expect(fixedComposer).toBeVisible();
    await expect(sidePanel.getByText("Assignee", { exact: true })).toBeVisible();
    await expect(sidePanel.getByText("Edited from the chat detail panel.")).toBeVisible();
    await expect(activityRegion).toContainText("Existing side panel comment should stay visible.");
    await expect(activityRegion).toContainText("Scrollable side panel activity comment 12.");
    const scrollBodyMetrics = await scrollBody.evaluate((element) => ({
      className: element.className,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(scrollBodyMetrics.className).toContain("overflow-hidden");
    await expect(issueScroller).toHaveClass(/overflow-y-auto/);
    const issueScrollerMetrics = await issueScroller.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(issueScrollerMetrics.scrollHeight).toBeGreaterThan(issueScrollerMetrics.clientHeight);
    await issueScroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect.poll(async () => issueScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(activityRegion.getByText("Scrollable side panel activity comment 12.")).toBeInViewport();

    await page.setViewportSize({ width: 1440, height: 900 });
    await sidePanel.getByLabel("Expand Side Panel").click();
    await expect(sidePanel).toContainText("Sub-issues");
    await expect(sidePanel).toContainText("Activity");
    await expect(propertiesPanel).toBeVisible();

    const commentComposer = sidePanel.locator(".chat-composer .rudder-milkdown-content [contenteditable='true']").last();
    const reopenCheckbox = sidePanel.getByRole("checkbox", { name: "Re-open" });
    await expect(commentComposer).toBeVisible({ timeout: 15_000 });
    await expect(reopenCheckbox).toBeChecked();
    await reopenCheckbox.uncheck();
    await commentComposer.click();
    await page.keyboard.type("Posted without leaving Messenger.");
    const commentResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "POST"
        && url.pathname.endsWith(`/api/issues/${issue.id}/comments`);
    });
    await sidePanel.locator(".chat-composer").getByRole("button", { name: "Comment", exact: true }).click();
    const postedCommentRes = await commentResponse;
    expect(postedCommentRes.ok(), await postedCommentRes.text()).toBe(true);
    await expect(sidePanel).toContainText("Posted without leaving Messenger.");

    const updatedIssueRes = await page.request.get(`/api/issues/${issue.id}`);
    expect(updatedIssueRes.ok(), await updatedIssueRes.text()).toBe(true);
    const updatedIssue = await updatedIssueRes.json() as { status: string; title: string; description: string | null };
    expect(updatedIssue.status).toBe("done");
    expect(updatedIssue.title).toBe("Reference issue target edited");
    expect(updatedIssue.description).toBe("Edited from the chat detail panel.");
    expect((updatedIssue as { assigneeAgentId?: string | null }).assigneeAgentId).toBe(reassignee.id);

    const commentsRes = await page.request.get(`/api/issues/${issue.id}/comments`);
    expect(commentsRes.ok(), await commentsRes.text()).toBe(true);
    const comments = await commentsRes.json() as Array<{ body: string }>;
    expect(comments.some((comment) => comment.body === "Posted without leaving Messenger.")).toBe(true);

    await page.screenshot({
      path: testInfo.outputPath("chat-side-panel-issue-editable.png"),
      fullPage: true,
    });

    await sidePanel.getByLabel("Restore Side Panel width").click();
    await assistantMessage.locator('a[data-mention-kind="automation"]').filter({ hasText: automation.title }).click();
    await expect(page).toHaveURL(new RegExp(`${hostChat.id}$`));
    await expect(sidePanel).toContainText("Codex verification automation");
    await expect(sidePanel).toContainText("Active");
    await expect(sidePanel).toContainText("Next run");
    await expect(sidePanel).toContainText("Previous runs");
    await sidePanel.getByRole("button", { name: "Automation actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Run now" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sidePanel.getByRole("link", { name: "Full page" })).toHaveCount(0);

    await assistantMessage.getByRole("link", { name: libraryFileName }).click();
    await expect(page).toHaveURL(new RegExp(`${hostChat.id}$`));
    const libraryPath = sidePanel.getByRole("navigation", { name: "Library file path" });
    await expect(libraryPath).toContainText("docs");
    await expect(libraryPath).toContainText(libraryFileName);
    await expect(sidePanel).toContainText("Reference library file");
    await expect(sidePanel).toContainText("Library preview should render beside the active chat.");

    await assistantMessage.getByRole("link", { name: "Referenced detail chat" }).click();
    await expect(page).toHaveURL(new RegExp(`${hostChat.id}$`));
    await expect(sidePanel).toContainText("Referenced detail chat");
    await expect(sidePanel).toContainText("Referenced chat body should render beside the active chat.");
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(4);
  });

  test("keeps the issue Side Panel in one scroll flow with a pinned composer", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Side-Panel-Pinned-Composer-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Side panel issue detail should scroll as one page",
        description: "Activity should scroll together with issue details without splitting the side panel into two independent scroll regions.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok(), await issueRes.text()).toBe(true);
    const issue = await issueRes.json() as { id: string; identifier: string | null };
    const issueRef = issue.identifier ?? issue.id;

    for (let index = 0; index < 18; index += 1) {
      const commentRes = await page.request.post(`/api/issues/${issue.id}/comments`, {
        data: {
          body: `Side panel scroll comment ${index + 1}\n\n${"This comment gives the narrow side panel activity timeline realistic vertical weight. ".repeat(6)}`,
        },
      });
      expect(commentRes.ok(), await commentRes.text()).toBe(true);
    }

    const hostChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Pinned composer host chat",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(hostChatRes.ok(), await hostChatRes.text()).toBe(true);
    const hostChat = await hostChatRes.json() as { id: string };

    await e2eDb.insert(chatMessages).values({
      id: randomUUID(),
      orgId: organization.id,
      conversationId: hostChat.id,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: `Open [${issueRef}](${buildIssueMentionHref(issue.id, issueRef)}) beside this chat.`,
      structuredPayload: null,
      replyingAgentId: null,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${hostChat.id}`);
    const assistantMessage = page.getByTestId("chat-assistant-message").last();
    await expect(assistantMessage).toContainText("Open", { timeout: 15_000 });
    await assistantMessage.locator('a[data-mention-kind="issue"]').filter({ hasText: issueRef }).click();

    const sidePanel = page.getByTestId("chat-side-panel");
    const issueScroller = sidePanel.locator("[data-testid='chat-side-panel-issue-scroll']");
    const timelineFlow = sidePanel.locator("[data-testid='comment-thread-timeline-flow']");
    const activityScroller = sidePanel.locator("[data-testid='comment-thread-timeline-scroll']");
    const fixedComposer = sidePanel.locator("[data-testid='comment-thread-fixed-composer']");
    await expect(sidePanel).toBeVisible({ timeout: 15_000 });
    await expect(sidePanel.getByRole("region", { name: "Activity" })).toBeVisible();
    await expect(issueScroller).toBeVisible();
    await expect(timelineFlow).toBeVisible();
    await expect(activityScroller).toHaveCount(0);
    await expect(fixedComposer).toBeVisible();

    const metrics = await page.evaluate(async () => {
      const panel = document.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
      const issueScroll = document.querySelector<HTMLElement>("[data-testid='chat-side-panel-issue-scroll']");
      const timeline = document.querySelector<HTMLElement>("[data-testid='comment-thread-timeline-flow']");
      const composer = document.querySelector<HTMLElement>("[data-testid='comment-thread-fixed-composer']");
      const activity = document.querySelector<HTMLElement>("section[aria-label='Activity']");
      const properties = document.querySelector<HTMLElement>("section[aria-label='Issue properties']");
      if (!panel || !issueScroll || !timeline || !composer || !activity || !properties) return null;

      issueScroll.scrollTop = 0;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const before = {
        activityTop: activity.getBoundingClientRect().top,
        propertiesTop: properties.getBoundingClientRect().top,
      };
      issueScroll.scrollTop = Math.floor(issueScroll.scrollHeight / 2);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const after = composer.getBoundingClientRect();
      const afterActivityTop = activity.getBoundingClientRect().top;
      const afterPropertiesTop = properties.getBoundingClientRect().top;
      const panelRect = panel.getBoundingClientRect();
      const issueScrollRect = issueScroll.getBoundingClientRect();
      const timelineRect = timeline.getBoundingClientRect();

      return {
        issueScrollerCanScroll: issueScroll.scrollHeight > issueScroll.clientHeight + 120,
        hasInternalTimelineScroll: Boolean(document.querySelector("[data-testid='comment-thread-timeline-scroll']")),
        activityMovesWithIssueScroll: Math.round(before.activityTop - afterActivityTop),
        propertiesMovesWithIssueScroll: Math.round(before.propertiesTop - afterPropertiesTop),
        composerBottomGap: Math.round(issueScrollRect.bottom - after.bottom),
        composerHeight: Math.round(after.height),
        timelineTop: Math.round(timelineRect.top),
        timelineBottom: Math.round(timelineRect.bottom),
        composerTop: Math.round(after.top),
        composerVisibleInPanel: after.bottom <= panelRect.bottom + 1 && after.top >= panelRect.top - 1,
        composerVisibleInScroller: after.bottom <= issueScrollRect.bottom + 1 && after.top >= issueScrollRect.top - 1,
      };
    });

    expect(metrics).not.toBeNull();
    expect(metrics!.issueScrollerCanScroll).toBe(true);
    expect(metrics!.hasInternalTimelineScroll).toBe(false);
    expect(metrics!.activityMovesWithIssueScroll).toBeGreaterThan(120);
    expect(metrics!.propertiesMovesWithIssueScroll).toBeGreaterThan(120);
    expect(metrics!.composerBottomGap).toBeGreaterThanOrEqual(0);
    expect(metrics!.composerBottomGap).toBeLessThanOrEqual(28);
    expect(metrics!.composerHeight).toBeGreaterThan(80);
    expect(metrics!.timelineTop).toBeLessThan(metrics!.composerTop);
    expect(metrics!.timelineBottom).toBeGreaterThan(metrics!.composerTop);
    expect(metrics!.composerVisibleInPanel).toBe(true);
    expect(metrics!.composerVisibleInScroller).toBe(true);

    await page.screenshot({
      path: testInfo.outputPath("chat-side-panel-issue-single-scroll-flow.png"),
      fullPage: false,
    });
  });

  test("keeps hidden Side Panel tabs scoped to the active Messenger chat", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Side-Panel-Session-State-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    async function createChat(title: string, body?: string) {
      const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
        data: {
          title,
          issueCreationMode: "manual_approval",
          planMode: false,
        },
      });
      expect(chatRes.ok(), await chatRes.text()).toBe(true);
      const chat = await chatRes.json() as { id: string; title: string };
      if (body) {
        await e2eDb.insert(chatMessages).values({
          id: randomUUID(),
          orgId: organization.id,
          conversationId: chat.id,
          role: "assistant",
          kind: "message",
          status: "completed",
          body,
          structuredPayload: null,
          replyingAgentId: null,
          chatTurnId: randomUUID(),
          turnVariant: 0,
        });
      }
      return chat;
    }

    const panelTargetA = await createChat("Panel target A", "Panel target A body.");
    const panelTargetB = await createChat("Panel target B", "Panel target B body.");
    const otherChat = await createChat("Other chat without panel history", "Other chat has no panel history.");
    const thirdChat = await createChat("Third chat without panel history", "Third chat has no panel history.");
    const hostChat = await createChat("Session state host chat", [
      `Compare [Panel target A](${buildChatMentionHref(panelTargetA.id)}) beside this chat.`,
      `Compare [Panel target B](${buildChatMentionHref(panelTargetB.id)}) beside this chat.`,
    ].join("\n\n"));

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${hostChat.id}`);

    const assistantMessage = page.getByTestId("chat-assistant-message").last();
    await expect(assistantMessage).toContainText("Panel target A", { timeout: 15_000 });

    await assistantMessage.locator('a[data-mention-kind="chat"]').filter({ hasText: "Panel target A" }).click();
    const sidePanel = page.getByTestId("chat-side-panel");
    await expect(sidePanel).toBeVisible({ timeout: 15_000 });
    await expect(sidePanel).toContainText("Panel target A body.");

    await assistantMessage.locator('a[data-mention-kind="chat"]').filter({ hasText: "Panel target B" }).click();
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(2);
    await expect(sidePanel.getByTestId("chat-side-panel-tab").last()).toContainText("Panel target B");
    await expect(sidePanel.getByTestId("chat-side-panel-tab").last()).toHaveAttribute("aria-selected", "true");
    await expect(sidePanel).toContainText("Panel target B body.");

    await page.getByTestId(`messenger-thread-chat-${otherChat.id}`).click();
    await expect(page).toHaveURL(new RegExp(`/messenger/chat/${otherChat.id}$`));
    await expect(page.getByTestId("chat-side-panel")).toHaveCount(0);
    await page.getByTestId(`messenger-thread-chat-${hostChat.id}`).click();
    await expect(page).toHaveURL(new RegExp(`/messenger/chat/${hostChat.id}$`));
    await expect(sidePanel).toBeVisible();
    const restoredTabs = sidePanel.getByTestId("chat-side-panel-tabs");
    await expect(restoredTabs.getByRole("tab", { name: "Panel target A" })).toBeVisible();
    await expect(restoredTabs.getByRole("tab", { name: "Panel target B" })).toBeVisible();
    await expect(restoredTabs.getByRole("tab", { name: "Panel target B" })).toHaveAttribute("aria-selected", "true");
    await expect(sidePanel).toContainText("Panel target B body.");

    await sidePanel.getByTestId("chat-side-panel-collapse").click();
    await expect(page.getByTestId("chat-side-panel")).toHaveCount(0);
    const chatSidePanelTrigger = () => page.getByTestId("workspace-main-card").getByTestId("chat-side-panel-trigger");
    await expect(chatSidePanelTrigger()).toHaveAttribute("aria-pressed", "false");

    await chatSidePanelTrigger().click();
    await expect(sidePanel).toBeVisible();
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(2);
    await expect(sidePanel.getByTestId("chat-side-panel-tab").last()).toContainText("Panel target B");
    await expect(sidePanel.getByTestId("chat-side-panel-tab").last()).toHaveAttribute("aria-selected", "true");
    await expect(sidePanel).toContainText("Panel target B body.");

    await sidePanel.getByTestId("chat-side-panel-collapse").click();
    await expect(page.getByTestId("chat-side-panel")).toHaveCount(0);
    await page.getByTestId(`messenger-thread-chat-${otherChat.id}`).click();
    await expect(page).toHaveURL(new RegExp(`/messenger/chat/${otherChat.id}$`));
    await expect(page.getByTestId("chat-side-panel")).toHaveCount(0);

    await chatSidePanelTrigger().click();
    await expect(sidePanel).toBeVisible();
    await expect(sidePanel.getByTestId("chat-side-panel-empty-state")).toBeVisible();
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(0);
    await expect(sidePanel).not.toContainText("Panel target A body.");
    await expect(sidePanel).not.toContainText("Panel target B body.");

    await page.getByTestId(`messenger-thread-chat-${hostChat.id}`).click();
    await expect(page).toHaveURL(new RegExp(`/messenger/chat/${hostChat.id}$`));
    await expect(page.getByTestId("chat-side-panel")).toHaveCount(0);

    await chatSidePanelTrigger().click();
    await expect(sidePanel).toBeVisible();
    const restoredTabsAfterEmptyPanel = sidePanel.getByTestId("chat-side-panel-tabs");
    await expect(restoredTabsAfterEmptyPanel.getByRole("tab", { name: "Panel target A" })).toBeVisible();
    await expect(restoredTabsAfterEmptyPanel.getByRole("tab", { name: "Panel target B" })).toBeVisible();
    await expect(restoredTabsAfterEmptyPanel.getByRole("tab", { name: "Panel target B" })).toHaveAttribute("aria-selected", "true");
    await expect(sidePanel).toContainText("Panel target B body.");

    await page.getByTestId(`messenger-thread-chat-${thirdChat.id}`).click();
    await expect(page).toHaveURL(new RegExp(`/messenger/chat/${thirdChat.id}$`));
    await expect(page.getByTestId("chat-side-panel")).toHaveCount(0);
  });

  test("keeps Side Panel tabs scoped to a concrete Messenger issue", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Side-Panel-Issue-Session-State-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Issue panel session target",
        description: "Issue route should keep its own side panel state.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok(), await issueRes.text()).toBe(true);
    const issue = await issueRes.json() as { id: string; identifier: string | null; title: string };
    const issueRef = issue.identifier ?? issue.id;
    const followRes = await page.request.post(`/api/issues/${issue.id}/follow`);
    expect(followRes.ok(), await followRes.text()).toBe(true);

    const otherChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Issue context no-history chat",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(otherChatRes.ok(), await otherChatRes.text()).toBe(true);
    const otherChat = await otherChatRes.json() as { id: string };

    await e2eDb.insert(chatMessages).values({
      id: randomUUID(),
      orgId: organization.id,
      conversationId: otherChat.id,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "No side panel history belongs to this chat.",
      structuredPayload: null,
      replyingAgentId: null,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
      window.localStorage.setItem("rudder.messengerSplitIssueNotificationsByOrg", JSON.stringify({ [orgId]: true }));
    }, organization.id);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${organization.issuePrefix}/messenger/issues/${issueRef}`, { waitUntil: "commit" });
    await expect(page).toHaveURL(new RegExp(`/messenger/issues/${issueRef}$`));
    await expect(page.locator("#main-content").getByRole("heading", { name: "Issue panel session target" })).toBeVisible({ timeout: 15_000 });

    const globalSidePanelTrigger = page.getByTestId("global-side-panel-trigger");
    await globalSidePanelTrigger.click({ force: true });
    const sidePanel = page.getByTestId("chat-side-panel");
    await expect(sidePanel).toBeVisible({ timeout: 15_000 });
    await expect(sidePanel.getByTestId("chat-side-panel-empty-state")).toBeVisible();
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(0);
    await sidePanel.getByTestId("chat-side-panel-empty-library-target").click();
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(1);
    await expect(sidePanel.getByTestId("chat-side-panel-tab").first()).toContainText("Library");
    await expect(sidePanel.getByTestId("chat-side-panel-library-directory-view")).toBeVisible();

    await sidePanel.getByTestId("chat-side-panel-collapse").click();
    await expect(page.getByTestId("chat-side-panel")).toHaveCount(0);
    await globalSidePanelTrigger.click({ force: true });
    await expect(sidePanel).toBeVisible();
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(1);
    await expect(sidePanel.getByTestId("chat-side-panel-tab").first()).toContainText("Library");
    await expect(sidePanel.getByTestId("chat-side-panel-library-directory-view")).toBeVisible();

    await page.getByTestId(`messenger-thread-chat-${otherChat.id}`).click();
    await expect(page).toHaveURL(new RegExp(`/messenger/chat/${otherChat.id}$`));
    await expect(page.getByTestId("chat-side-panel")).toHaveCount(0);
    await page.getByTestId("workspace-main-card").getByTestId("chat-side-panel-trigger").click();
    await expect(sidePanel).toBeVisible();
    await expect(sidePanel.getByTestId("chat-side-panel-empty-state")).toBeVisible();
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(0);

    await page.getByTestId(`messenger-thread-issue-${issue.id}`).click();
    await expect(page).toHaveURL(new RegExp(`/messenger/issues/${issueRef}$`));
    await expect(sidePanel).toBeVisible();
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(1);
    await expect(sidePanel.getByTestId("chat-side-panel-tab").first()).toContainText("Library");
    await expect(sidePanel.getByTestId("chat-side-panel-library-directory-view")).toBeVisible();
  });

  test("opens a Library directory in the Side Panel with the Library file-tree UI", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Side-Panel-Library-Directory-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const directoryPath = `docs/side-panel-browser-${Date.now()}`;
    const files = [
      { filePath: `${directoryPath}/alpha.md`, content: "# Alpha\n\nAlpha file preview." },
      { filePath: `${directoryPath}/bravo.md`, content: "# Bravo\n\nBravo file preview." },
      { filePath: `${directoryPath}/nested/charlie.md`, content: "# Charlie\n\nNested file preview." },
    ];
    for (const file of files) {
      const libraryFileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
        data: file,
      });
      expect(libraryFileRes.ok(), await libraryFileRes.text()).toBe(true);
    }

    const hostChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Side Panel Library directory host chat",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(hostChatRes.ok(), await hostChatRes.text()).toBe(true);
    const hostChat = await hostChatRes.json() as { id: string };

    await e2eDb.insert(chatMessages).values({
      id: randomUUID(),
      orgId: organization.id,
      conversationId: hostChat.id,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: `Browse [${directoryPath}](${buildLibraryDirectoryMentionHref(directoryPath)}) beside this chat.`,
      structuredPayload: null,
      replyingAgentId: null,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    const hostChatPath = `/${organization.issuePrefix}/messenger/chat/${hostChat.id}`;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(hostChatPath);

    const assistantMessage = page.getByTestId("chat-assistant-message").last();
    await expect(assistantMessage).toContainText("Browse", { timeout: 15_000 });

    await assistantMessage.locator('a[data-mention-kind="library_directory"]').click();
    await expect(page).toHaveURL(new RegExp(`${hostChat.id}$`));

    const sidePanel = page.getByTestId("chat-side-panel");
    await expect(sidePanel).toBeVisible({ timeout: 15_000 });
    const directoryView = sidePanel.getByTestId("chat-side-panel-library-directory-view");
    await expect(directoryView).toBeVisible();
    await expect(directoryView.getByTestId("chat-side-panel-library-file-count")).toBeVisible();
    await expect(directoryView.getByTestId("chat-side-panel-library-file-count")).toHaveText("2 files · 1 folder");
    await expect(directoryView).toContainText("alpha.md");
    await expect(directoryView).toContainText("bravo.md");
    const nestedFolder = directoryView.getByRole("button", { name: /nested/ });
    await expect(nestedFolder).toHaveAttribute("aria-expanded", "false");
    await nestedFolder.click();
    await expect(nestedFolder).toHaveAttribute("aria-expanded", "true");
    await expect(directoryView).toContainText("charlie.md");

    await directoryView.getByRole("button", { name: "charlie.md" }).click();
    const filePathNavigation = sidePanel.getByRole("navigation", { name: "Library file path" });
    await expect(filePathNavigation.getByText("nested", { exact: true })).toBeVisible();
    await expect(filePathNavigation.getByText("charlie.md", { exact: true })).toBeVisible();
    await filePathNavigation.hover();
    await expect(page.getByTestId("chat-side-panel-library-full-path"))
      .toContainText(`${directoryPath}/nested/charlie.md`);
    await expect(sidePanel).toContainText("Nested file preview.");
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(2);
  });

  test("opens the global empty Side Panel picker from a non-reference page", async ({ page }) => {
    await installBrowserDesktopStub(page);
    await installEnabledBrowserSettingsStub(page);
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Global-Side-Panel-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByTestId("side-panel-hover-edge").hover();
    await page.getByTestId("global-side-panel-trigger").click();
    const sidePanel = page.getByTestId("chat-side-panel");
    await expect(sidePanel).toBeVisible({ timeout: 15_000 });
    await expect(sidePanel).toContainText("Open a panel");
    await expect(sidePanel).toContainText("Browser");
    await expect(sidePanel).toContainText("Library");
    await expect(page.getByTestId("side-panel-resizer")).toBeVisible();
    await expect(sidePanel.locator(".workspace-main-card")).toHaveCount(2);
    await expect.poll(async () => {
      const [mainBox, panelBox] = await Promise.all([
        page.getByTestId("workspace-main-card").boundingBox(),
        sidePanel.boundingBox(),
      ]);
      if (!mainBox || !panelBox) return Number.POSITIVE_INFINITY;
      return Math.abs(mainBox.width - panelBox.width);
    }).toBeLessThanOrEqual(2);

    const mainCardBox = await page.getByTestId("workspace-main-card").boundingBox();
    const resizerBox = await page.getByTestId("side-panel-resizer").boundingBox();
    const sidePanelBox = await sidePanel.boundingBox();
    const sidePanelHeaderBox = await sidePanel.locator(".workspace-main-card").first().boundingBox();
    expect(mainCardBox).not.toBeNull();
    expect(resizerBox).not.toBeNull();
    expect(sidePanelBox).not.toBeNull();
    expect(sidePanelHeaderBox).not.toBeNull();
    expect(resizerBox!.width).toBeGreaterThanOrEqual(10);
    expect(Math.round(resizerBox!.x - (mainCardBox!.x + mainCardBox!.width))).toBeLessThanOrEqual(2);
    expect(Math.round(sidePanelBox!.x - (resizerBox!.x + resizerBox!.width))).toBe(0);
    expect(Math.round(sidePanelHeaderBox!.x - (mainCardBox!.x + mainCardBox!.width))).toBeLessThanOrEqual(6);

    await sidePanel.getByLabel("Expand Side Panel").click();
    await expect(sidePanel.getByLabel("Restore Side Panel width")).toBeVisible();
    await expect(page.getByTestId("side-panel-expanded-overlay")).toBeVisible();
    await expect(page.getByTestId("side-panel-resizer")).toBeHidden();

    await expect.poll(async () => {
      const workspaceBox = await page.getByTestId("workspace-main-panel-stack").boundingBox();
      const expandedSidePanelBox = await sidePanel.boundingBox();
      if (!workspaceBox || !expandedSidePanelBox) return null;
      return {
        left: Math.abs(Math.round(expandedSidePanelBox.x - workspaceBox.x)),
        right: Math.abs(Math.round(
          (workspaceBox.x + workspaceBox.width)
            - (expandedSidePanelBox.x + expandedSidePanelBox.width),
        )),
      };
    }).toEqual({ left: 0, right: 0 });

    await sidePanel.getByLabel("Restore Side Panel width").click();
    await expect(sidePanel.getByLabel("Expand Side Panel")).toBeVisible();
    await expect(page.getByTestId("side-panel-expanded-overlay")).toHaveCount(0);
    await expect(page.getByTestId("side-panel-resizer")).toBeVisible();

    await sidePanel.getByLabel("Expand Side Panel").click();
    await expect(page.getByTestId("side-panel-expanded-overlay")).toBeVisible();
    await sidePanel.getByLabel("Close Side Panel").click();
    await expect(sidePanel).toHaveCount(0);
    await page.getByTestId("side-panel-hover-edge").hover();
    await page.getByTestId("global-side-panel-trigger").click();
    await expect(sidePanel).toBeVisible();
    await expect(page.getByTestId("side-panel-expanded-overlay")).toHaveCount(0);
    await expect(page.getByTestId("side-panel-resizer")).toBeVisible();

    await sidePanel.getByRole("button", { name: /Browser/ }).click();
    await expect(sidePanel).toContainText("Start browsing");
    await expect(sidePanel.getByRole("link", { name: "Full page" })).toHaveCount(0);

    await sidePanel.getByTestId("chat-side-panel-add-tab").click();
    await expect(sidePanel.getByTestId("chat-side-panel-add-menu")).toHaveCount(0);
    await expect(sidePanel).toContainText("Open a panel");
    await expect(sidePanel).toContainText("Browser");
    await expect(sidePanel).toContainText("Library");

    await sidePanel.getByRole("button", { name: /Library/ }).click();
    await expect(sidePanel).toContainText("Library root");
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(2);

    const collapseStart = await page.getByTestId("side-panel-resizer").boundingBox();
    expect(collapseStart).not.toBeNull();
    await page.mouse.move(collapseStart!.x + collapseStart!.width / 2, collapseStart!.y + collapseStart!.height / 2);
    await page.mouse.down();
    await page.mouse.move(page.viewportSize()!.width - 16, collapseStart!.y + collapseStart!.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(sidePanel).toBeHidden();
    await page.getByTestId("side-panel-hover-edge").hover();
    await expect(page.getByTestId("global-side-panel-trigger")).toBeVisible();
  });

  test("animates the Side Panel shell and auto-collapses during narrow resize", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Side-Panel-Motion-Resize-${Date.now()}`,
        issuePrefix: `SPM${randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByTestId("side-panel-hover-edge").hover();
    const openingSamples = await sampleSidePanelMotion(
      page,
      () => page.getByTestId("global-side-panel-trigger").click(),
    );
    expectRightAnchoredSidePanelMotion(openingSamples, "opening", { endPanelWidth: { min: 390 } });

    const sidePanel = page.getByTestId("chat-side-panel");
    await expect(sidePanel).toBeVisible({ timeout: 15_000 });
    await expect(sidePanel.getByLabel("Close Side Panel")).toBeFocused();
    await expect(page.getByTestId("side-panel-stable-host")).toHaveClass(/motion-resize/);
    await expect(page.getByTestId("side-panel-resizer")).toHaveClass(/motion-resize/);

    const collapseStart = await page.getByTestId("side-panel-resizer").boundingBox();
    expect(collapseStart).not.toBeNull();
    await page.mouse.move(collapseStart!.x + collapseStart!.width / 2, collapseStart!.y + collapseStart!.height / 2);
    await page.mouse.down();
    await expect(page.getByTestId("side-panel-resize-shield")).toBeVisible();
    await page.mouse.move(page.viewportSize()!.width - 16, collapseStart!.y + collapseStart!.height / 2, { steps: 8 });
    await expect(sidePanel).toHaveCount(0);
    await page.mouse.up();
    await expect(page.getByTestId("side-panel-resize-shield")).toHaveCount(0);
    await expect(page.getByTestId("side-panel-stable-host")).toHaveCSS("width", "0px");

    await page.getByTestId("side-panel-hover-edge").hover();
    const reopeningSamples = await sampleSidePanelMotion(
      page,
      () => page.getByTestId("global-side-panel-trigger").click(),
    );
    expectRightAnchoredSidePanelMotion(reopeningSamples, "opening", { endPanelWidth: { min: 390 } });
    await expect(sidePanel).toBeVisible();
    const reopenedBox = await sidePanel.boundingBox();
    expect(reopenedBox).not.toBeNull();
    expect(reopenedBox!.width).toBeGreaterThanOrEqual(390);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await sidePanel.getByLabel("Close Side Panel").click();
    const stableHost = page.getByTestId("side-panel-stable-host");
    await expect(stableHost).toHaveCSS("width", "0px");
    await expect(page.getByTestId("global-side-panel-trigger")).toBeFocused();
    await page.getByTestId("global-side-panel-trigger").click();
    await expect.poll(async () => (await sidePanel.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(390);
    await page.emulateMedia({ reducedMotion: "no-preference" });
  });

  test("keeps the main workspace mounted but inert while the Side Panel is expanded", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Global-Side-Panel-Expanded-${Date.now()}`,
        issuePrefix: `SPE${randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByTestId("side-panel-hover-edge").hover();
    await page.getByTestId("global-side-panel-trigger").click();
    const sidePanel = page.getByTestId("chat-side-panel");
    await expect(sidePanel).toBeVisible({ timeout: 15_000 });
    await expect(sidePanel).toContainText("Open a panel");
    await expect(page.getByTestId("workspace-main-card")).toBeVisible();

    const expandSamples = await sampleSidePanelMotion(
      page,
      () => sidePanel.getByLabel("Expand Side Panel").click(),
    );
    expectRightAnchoredSidePanelMotion(expandSamples, "opening", { endPanelWidth: { min: 900 } });
    await expect(page.getByTestId("side-panel-expanded-overlay")).toBeVisible();
    await expect(sidePanel.getByLabel("Restore Side Panel width")).toBeVisible();
    await expect(page.getByTestId("side-panel-resizer")).toBeHidden();
    const mainWorkspace = page.getByTestId("workspace-main-card");
    await expect(mainWorkspace).toBeAttached();
    await expect(mainWorkspace).toHaveAttribute("aria-hidden", "true");
    await expect(mainWorkspace).toHaveAttribute("inert", "");
    expect((await mainWorkspace.boundingBox())?.width ?? 0).toBeLessThanOrEqual(2);

    const workspaceStackBox = await page.getByTestId("workspace-main-panel-stack").boundingBox();
    const expandedSidePanelBox = await sidePanel.boundingBox();
    expect(workspaceStackBox).not.toBeNull();
    expect(expandedSidePanelBox).not.toBeNull();
    expect(Math.abs(Math.round(expandedSidePanelBox!.x - workspaceStackBox!.x))).toBeLessThanOrEqual(2);
    expect(Math.abs(Math.round((workspaceStackBox!.x + workspaceStackBox!.width) - (expandedSidePanelBox!.x + expandedSidePanelBox!.width)))).toBeLessThanOrEqual(2);

    const restoreSamples = await sampleSidePanelMotion(
      page,
      () => sidePanel.getByLabel("Restore Side Panel width").click(),
    );
    expectRightAnchoredSidePanelMotion(restoreSamples, "closing", { endPanelWidth: { min: 390 } });
    await expect(page.getByTestId("side-panel-expanded-overlay")).toHaveCount(0);
    await expect(page.getByTestId("side-panel-resizer")).toBeVisible();
    await expect(page.getByTestId("workspace-main-card")).toBeVisible();
    await expect(page.getByTestId("workspace-main-card")).not.toHaveAttribute("aria-hidden", "true");
    await expect(page.getByTestId("workspace-main-card")).not.toHaveAttribute("inert", "");

    await sidePanel.getByLabel("Expand Side Panel").click();
    await expect(page.getByTestId("side-panel-expanded-overlay")).toBeVisible();
    await expect.poll(async () => {
      const [workspaceBox, panelBox] = await Promise.all([
        page.getByTestId("workspace-main-panel-stack").boundingBox(),
        sidePanel.boundingBox(),
      ]);
      if (!workspaceBox || !panelBox) return Number.POSITIVE_INFINITY;
      return Math.abs(workspaceBox.width - panelBox.width);
    }).toBeLessThanOrEqual(2);
    const closeSamples = await sampleSidePanelMotion(
      page,
      () => sidePanel.getByLabel("Close Side Panel").click(),
    );
    expectRightAnchoredSidePanelMotion(closeSamples, "closing", {
      checkClosingContent: true,
      endPanelWidth: { max: 2 },
    });
    await expect(sidePanel).toHaveCount(0);
    await expect(page.getByTestId("workspace-main-card")).toBeVisible();
    await expect(page.getByTestId("workspace-main-card")).not.toHaveAttribute("aria-hidden", "true");
    await expect(page.getByTestId("workspace-main-card")).not.toHaveAttribute("inert", "");
  });

  test("only auto-expands after a resize makes the Side Panel wider than 2:1", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Side-Panel-Auto-Expand-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByTestId("side-panel-hover-edge").hover();
    await page.getByTestId("global-side-panel-trigger").click();

    const sidePanel = page.getByTestId("chat-side-panel");
    const resizer = page.getByTestId("side-panel-resizer");
    await expect(sidePanel).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => {
      const [mainBox, panelBox] = await Promise.all([
        page.getByTestId("workspace-main-card").boundingBox(),
        sidePanel.boundingBox(),
      ]);
      if (!mainBox || !panelBox) return Number.POSITIVE_INFINITY;
      return Math.abs(mainBox.width - panelBox.width);
    }).toBeLessThanOrEqual(2);
    const stackBox = await page.getByTestId("workspace-main-panel-stack").boundingBox();
    const resizerBox = await resizer.boundingBox();
    expect(stackBox).not.toBeNull();
    expect(resizerBox).not.toBeNull();

    const pointerY = resizerBox!.y + resizerBox!.height / 2;
    await page.mouse.move(resizerBox!.x + resizerBox!.width / 2, pointerY);
    await page.mouse.down();
    await page.mouse.move(stackBox!.x + stackBox!.width * 0.4, pointerY, { steps: 8 });
    await expect(page.getByTestId("side-panel-expanded-overlay")).toHaveCount(0);
    await expect(resizer).toBeVisible();

    await page.mouse.move(stackBox!.x + stackBox!.width * 0.3, pointerY, { steps: 8 });
    await expect(page.getByTestId("side-panel-expanded-overlay")).toBeVisible();
    await expect(resizer).toBeHidden();
    await page.mouse.up();
  });

  test("keeps desktop chat controls clear of interrupted messages beside the Side Panel", async ({ page }) => {
    await installBrowserDesktopStub(page);
    const browserSettings = await page.request.patch("/api/instance/settings/browser", {
      data: { enabled: true, openLinksIn: "built_in" },
    });
    expect(browserSettings.ok(), await browserSettings.text()).toBe(true);

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Toolbar-Clearance-${Date.now()}`,
        issuePrefix: `CTC${randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Interrupted chat beside Browser",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(chatRes.ok(), await chatRes.text()).toBe(true);
    const chat = await chatRes.json() as { id: string };

    await e2eDb.insert(chatMessages).values({
      id: randomUUID(),
      orgId: organization.id,
      conversationId: chat.id,
      role: "assistant",
      kind: "message",
      status: "interrupted",
      body: "Chat run interrupted before a final reply. Continue the conversation to resume from the preserved context.",
      structuredPayload: null,
      replyingAgentId: null,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await page.setViewportSize({ width: 1200, height: 820 });
    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

    await page.getByRole("button", { name: "Collapse workspace sidebar" }).click();
    await expect(page.getByRole("button", { name: "Open Messenger sidebar" })).toBeVisible();
    await page.getByTestId("chat-side-panel-trigger").click();
    const sidePanel = page.getByTestId("chat-side-panel");
    await expect(sidePanel).toBeVisible({ timeout: 15_000 });
    await sidePanel.getByRole("button", { name: /Browser/ }).click();
    await expect(sidePanel.getByTestId("chat-side-panel-browser-view")).toBeVisible();

    const toolbarClearance = page.getByTestId("chat-desktop-toolbar-clearance");
    const openSidebarButton = page.getByRole("button", { name: "Open Messenger sidebar" });
    const chatActionsButton = page.getByTestId("chat-actions-trigger");
    const assistantMessage = page.getByTestId("chat-assistant-message");
    await expect(toolbarClearance).toBeVisible();
    await expect(chatActionsButton).toBeVisible();
    await expect(assistantMessage).toContainText("Chat run interrupted before a final reply.");

    const [toolbarBox, openSidebarBox, chatActionsBox, messageBox, scrollRegionBox] = await Promise.all([
      toolbarClearance.boundingBox(),
      openSidebarButton.boundingBox(),
      chatActionsButton.boundingBox(),
      assistantMessage.boundingBox(),
      page.getByTestId("chat-messages-scroll-region").boundingBox(),
    ]);
    expect(toolbarBox).not.toBeNull();
    expect(openSidebarBox).not.toBeNull();
    expect(chatActionsBox).not.toBeNull();
    expect(messageBox).not.toBeNull();
    expect(scrollRegionBox).not.toBeNull();

    const toolbarBottom = toolbarBox!.y + toolbarBox!.height;
    expect(openSidebarBox!.y + openSidebarBox!.height).toBeLessThanOrEqual(toolbarBottom + 1);
    expect(chatActionsBox!.y + chatActionsBox!.height).toBeLessThanOrEqual(toolbarBottom + 1);
    expect(scrollRegionBox!.y).toBeGreaterThanOrEqual(toolbarBottom - 1);
    expect(messageBox!.y).toBeGreaterThanOrEqual(toolbarBottom - 1);

    await page.screenshot({
      path: "/tmp/rudder-chat-toolbar-clearance-with-side-panel.png",
      fullPage: true,
    });
  });

  test("opens a Browser side panel tab with URL navigation controls", async ({ page }) => {
    await installBrowserDesktopStub(page);
    const browserSettings = await page.request.patch("/api/instance/settings/browser", {
      data: { enabled: true, openLinksIn: "built_in" },
    });
    expect(browserSettings.ok(), await browserSettings.text()).toBe(true);
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Global-Side-Panel-Browser-${Date.now()}`,
        issuePrefix: `SPB${randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const hostChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Side Panel Browser host chat",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(hostChatRes.ok(), await hostChatRes.text()).toBe(true);
    const hostChat = await hostChatRes.json() as { id: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${hostChat.id}`);
    await expect(page.getByTestId("chat-side-panel-trigger")).toHaveAttribute("aria-pressed", "false");
    await page.getByTestId("chat-side-panel-trigger").click();
    const sidePanel = page.getByTestId("chat-side-panel");
    await expect(sidePanel).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("chat-side-panel-trigger")).toHaveCount(0);

    await sidePanel.getByRole("button", { name: /Browser/ }).click();
    await expect(sidePanel.getByTestId("chat-side-panel-browser-view")).toBeVisible();
    await expect(sidePanel).toContainText("Start browsing");

    const targetUrl = "http://localhost:4173/browser-fixture";
    await sidePanel.getByLabel("Browser URL").fill("localhost:4173/browser-fixture");
    await sidePanel.getByLabel("Browser URL").press("Enter");

    const webview = sidePanel.getByTestId("chat-side-panel-browser-webview");
    await expect(webview).toHaveAttribute("src", targetUrl);
    await expect(sidePanel.getByTestId("chat-side-panel-browser-start")).toHaveCount(0);
    await expect(sidePanel.getByTestId("chat-side-panel-tab").first()).toContainText("localhost");
    await webview.evaluate((element) => {
      const actions: Array<string | number> = [];
      Object.assign(element, {
        __rudderBrowserActions: actions,
        __rudderKeepaliveMarker: "browser-guest-1",
        canGoBack: () => true,
        canGoForward: () => true,
        getURL: () => "http://localhost:4173/browser-fixture",
        goBack: () => actions.push("back"),
        goForward: () => actions.push("forward"),
        reload: () => actions.push("reload"),
        reloadIgnoringCache: () => actions.push("hard-reload"),
        setZoomFactor: (factor: number) => actions.push(factor),
      });
      element.dispatchEvent(new Event("dom-ready"));
    });
    const browserTabId = await webview.getAttribute("data-browser-tab-id");
    expect(browserTabId).toBeTruthy();
    const stableWebview = sidePanel.locator(`webview[data-browser-tab-id="${browserTabId}"]`);
    const activeBrowserTab = sidePanel.getByTestId("chat-side-panel-tab").first();

    const initialTabWidth = await activeBrowserTab.evaluate((element) => element.getBoundingClientRect().width);
    await stableWebview.evaluate((element) => {
      element.dispatchEvent(Object.assign(new Event("page-title-updated"), { title: "Overview" }));
    });
    await expect(activeBrowserTab).toContainText("Overview");
    const shortTitleTabWidth = await activeBrowserTab.evaluate((element) => element.getBoundingClientRect().width);
    await stableWebview.evaluate((element) => {
      element.dispatchEvent(Object.assign(new Event("page-title-updated"), {
        title: "Rudder MKT Command Center Daily Analytics",
      }));
    });
    await expect(activeBrowserTab).toContainText("Rudder MKT Command Center Daily Analytics");
    const longTitleTabWidth = await activeBrowserTab.evaluate((element) => element.getBoundingClientRect().width);
    expect(shortTitleTabWidth).toBeCloseTo(initialTabWidth, 1);
    expect(longTitleTabWidth).toBeCloseTo(initialTabWidth, 1);
    await stableWebview.evaluate((element) => {
      element.dispatchEvent(Object.assign(new Event("page-title-updated"), { title: "localhost" }));
    });
    await expect(activeBrowserTab).toContainText("localhost");

    const dispatchBrowserShortcut = async (key: string, code: string, shiftKey = false) => {
      await sidePanel.getByLabel("Browser URL").evaluate((element, shortcut) => {
        const isMac = navigator.platform.toLowerCase().includes("mac");
        element.dispatchEvent(new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          code: shortcut.code,
          ctrlKey: !isMac,
          key: shortcut.key,
          metaKey: isMac,
          shiftKey: shortcut.shiftKey,
        }));
      }, { key, code, shiftKey });
    };
    await sidePanel.getByLabel("Browser URL").focus();
    await dispatchBrowserShortcut("r", "KeyR");
    await dispatchBrowserShortcut("r", "KeyR", true);
    await dispatchBrowserShortcut("[", "BracketLeft");
    await dispatchBrowserShortcut("]", "BracketRight");
    await dispatchBrowserShortcut("=", "Equal");
    await expect(sidePanel.getByTestId("chat-side-panel-browser-zoom")).toHaveText("110%");
    await dispatchBrowserShortcut("0", "Digit0");
    await expect(sidePanel.getByTestId("chat-side-panel-browser-zoom")).toHaveCount(0);
    await expect.poll(() => webview.evaluate((element) => (
      element as HTMLElement & { __rudderBrowserActions?: Array<string | number> }
    ).__rudderBrowserActions)).toEqual(["reload", "hard-reload", "back", "forward", 1.1, 1]);

    await sidePanel.getByLabel("Open new browser tab").focus();
    await dispatchBrowserShortcut("l", "KeyL");
    await expect(sidePanel.getByLabel("Browser URL")).toBeFocused();
    expect(await sidePanel.getByLabel("Browser URL").evaluate((element) => {
      const input = element as HTMLInputElement;
      return [input.selectionStart, input.selectionEnd, input.value.length];
    })).toEqual([0, targetUrl.length, targetUrl.length]);

    await sidePanel.getByLabel("Expand Side Panel").click();
    await expect(page.getByTestId("side-panel-expanded-overlay")).toBeVisible();
    await expect.poll(() => stableWebview.evaluate((element) => (
      element as HTMLElement & { __rudderKeepaliveMarker?: string }
    ).__rudderKeepaliveMarker)).toBe("browser-guest-1");
    await sidePanel.getByLabel("Restore Side Panel width").click();
    await expect(page.getByTestId("side-panel-expanded-overlay")).toHaveCount(0);
    await expect.poll(() => stableWebview.evaluate((element) => (
      element as HTMLElement & { __rudderKeepaliveMarker?: string }
    ).__rudderKeepaliveMarker)).toBe("browser-guest-1");

    await dispatchBrowserShortcut("t", "KeyT");
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(2);
    await expect(sidePanel.getByTestId("chat-side-panel-tab").last()).toContainText("New tab");

    const closeButtons = sidePanel.getByTestId("chat-side-panel-tab-close");
    await expect(closeButtons.first()).toHaveCSS("opacity", "0");
    await sidePanel.getByTestId("chat-side-panel-tab").first().hover();
    await expect(closeButtons.first()).toHaveCSS("opacity", "1");

    const browserTabs = sidePanel.getByTestId("chat-side-panel-tab");
    await browserTabs.last().dragTo(browserTabs.first(), {
      targetPosition: { x: 2, y: 14 },
    });
    await expect(browserTabs.first()).toContainText("New tab");
    await expect(browserTabs.last()).toContainText("localhost");
    await expect(browserTabs.first()).toHaveAttribute("aria-selected", "true");

    await browserTabs.first().dragTo(browserTabs.last(), {
      targetPosition: { x: 150, y: 14 },
    });
    await expect(browserTabs.first()).toContainText("localhost");
    await expect(browserTabs.last()).toContainText("New tab");
    await expect(browserTabs.last()).toHaveAttribute("aria-selected", "true");
    await page.screenshot({ path: "/tmp/rudder-side-panel-tab-reorder.png", fullPage: true });

    const closeSamples = await sampleSidePanelMotion(
      page,
      () => sidePanel.getByLabel("Close Side Panel").click(),
    );
    expectRightAnchoredSidePanelMotion(closeSamples, "closing", {
      checkClosingContent: true,
      endPanelWidth: { max: 2 },
    });
    await expect(page.getByTestId("chat-side-panel")).toBeHidden();
    await expect(stableWebview).toHaveCount(1);
    await expect.poll(() => stableWebview.evaluate((element) => (
      element as HTMLElement & { __rudderKeepaliveMarker?: string }
    ).__rudderKeepaliveMarker)).toBe("browser-guest-1");
    await expect(page.getByTestId("chat-side-panel-trigger")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("chat-side-panel-trigger")).toBeFocused();
    await page.getByTestId("chat-side-panel-trigger").click();
    await expect(page.getByTestId("chat-side-panel")).toBeVisible();
    await expect.poll(() => stableWebview.evaluate((element) => (
      element as HTMLElement & { __rudderKeepaliveMarker?: string }
    ).__rudderKeepaliveMarker)).toBe("browser-guest-1");
  });

  test("renders Browser connection failure details and reloads the current URL", async ({ page }) => {
    await installBrowserDesktopStub(page);
    const browserSettings = await page.request.patch("/api/instance/settings/browser", {
      data: { enabled: true, openLinksIn: "built_in" },
    });
    expect(browserSettings.ok(), await browserSettings.text()).toBe(true);

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Side-Panel-Browser-Error-${Date.now()}`,
        issuePrefix: `SBE${randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Browser error UI host chat",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(chatRes.ok(), await chatRes.text()).toBe(true);
    const chat = await chatRes.json() as { id: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);
    await page.getByTestId("chat-side-panel-trigger").click();

    const sidePanel = page.getByTestId("chat-side-panel");
    await expect(sidePanel).toBeVisible({ timeout: 15_000 });
    await sidePanel.getByRole("button", { name: /Browser/ }).click();
    await sidePanel.getByLabel("Browser URL").fill("localhost:4173/browser-fixture");
    await sidePanel.getByLabel("Browser URL").press("Enter");

    const webview = sidePanel.getByTestId("chat-side-panel-browser-webview");
    await expect(webview).toHaveAttribute("src", "http://localhost:4173/browser-fixture");
    await webview.evaluate((element) => {
      const browserElement = element as HTMLElement & { reload?: () => void };
      browserElement.dispatchEvent(new Event("dom-ready"));
      browserElement.reload = () => {
        browserElement.dataset.errorReloadCount = String(
          Number(browserElement.dataset.errorReloadCount ?? "0") + 1,
        );
      };
      browserElement.dispatchEvent(Object.assign(new Event("did-start-navigation"), {
        isMainFrame: true,
        url: "http://127.0.0.1:3201/",
      }));
      browserElement.dispatchEvent(Object.assign(new Event("did-fail-load"), {
        errorDescription: "ERR_CONNECTION_REFUSED",
        isMainFrame: true,
        validatedURL: "http://127.0.0.1:3201/",
      }));
    });

    const browserError = sidePanel.getByTestId("chat-side-panel-browser-error");
    await expect(browserError).toBeVisible();
    await expect(browserError).toContainText("This site can't be reached");
    await expect(browserError).toContainText("127.0.0.1 refused to connect.");
    await expect(browserError).toContainText("ERR_CONNECTION_REFUSED");
    await expect(sidePanel.getByLabel("Browser URL")).toHaveValue("http://127.0.0.1:3201/");
    await expect(webview).toHaveAttribute("src", "http://localhost:4173/browser-fixture");
    await expect(webview).toHaveClass(/invisible/);

    await browserError.getByRole("button", { name: "Details" }).click();
    await expect(browserError).toContainText("http://127.0.0.1:3201/");
    await page.screenshot({ path: "/tmp/rudder-side-panel-browser-error.png", fullPage: true });

    await browserError.getByRole("button", { name: "Reload" }).click();
    await expect(webview).toHaveAttribute("data-error-reload-count", "1");
    await expect(browserError).toBeVisible();
    await webview.evaluate((element) => {
      element.dispatchEvent(new Event("did-start-loading"));
    });
    await expect(browserError).toHaveCount(0);
    await expect(webview).not.toHaveClass(/invisible/);
  });

  test("keeps the default Side Panel and main content at a 1:1 split while the app width changes", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Global-Side-Panel-Proportional-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByTestId("global-side-panel-trigger").click();
    const sidePanel = page.getByTestId("chat-side-panel");
    await expect(sidePanel).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => {
      const mainBox = await page.getByTestId("workspace-main-card").boundingBox();
      const sidePanelBox = await sidePanel.boundingBox();
      if (!mainBox || !sidePanelBox) return Number.POSITIVE_INFINITY;
      return Math.abs(Math.round(mainBox.width - sidePanelBox.width));
    }).toBeLessThanOrEqual(2);

    await page.setViewportSize({ width: 1200, height: 900 });
    await expect.poll(async () => {
      const mainBox = await page.getByTestId("workspace-main-card").boundingBox();
      const sidePanelBox = await sidePanel.boundingBox();
      if (!mainBox || !sidePanelBox) return Number.POSITIVE_INFINITY;
      return Math.abs(Math.round(mainBox.width - sidePanelBox.width));
    }).toBeLessThanOrEqual(2);

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(async () => {
      const mainBox = await page.getByTestId("workspace-main-card").boundingBox();
      const sidePanelBox = await sidePanel.boundingBox();
      if (!mainBox || !sidePanelBox) return Number.POSITIVE_INFINITY;
      return Math.abs(Math.round(mainBox.width - sidePanelBox.width));
    }).toBeLessThanOrEqual(2);
    await page.screenshot({ path: "/tmp/rudder-side-panel-equal-width.png", fullPage: true });
  });

  test("resizes and collapses the Browser Side Panel in two- and three-column workspaces", async ({ page }) => {
    await installBrowserDesktopStub(page);
    await installEnabledBrowserSettingsStub(page);
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Side-Panel-Resize-${Date.now()}`,
        issuePrefix: `SPR${randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Side Panel resize host",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(chatRes.ok(), await chatRes.text()).toBe(true);
    const chat = await chatRes.json() as { id: string };

    const openBrowserPanel = async () => {
      const sidePanel = page.getByTestId("chat-side-panel");
      await expect(sidePanel).toBeVisible({ timeout: 15_000 });
      await sidePanel.getByRole("button", { name: /Browser/ }).click();
      await sidePanel.getByLabel("Browser URL").fill("http://127.0.0.1:3201/audience");
      await sidePanel.getByLabel("Browser URL").press("Enter");
      await expect(sidePanel.getByTestId("chat-side-panel-browser-webview")).toBeVisible();
      return sidePanel;
    };

    const dragResizer = async (targetX: number) => {
      const resizer = page.getByTestId("side-panel-resizer");
      const box = await resizer.boundingBox();
      expect(box).not.toBeNull();
      const pointerY = box!.y + box!.height / 2;
      await page.mouse.move(box!.x + box!.width / 2, pointerY);
      await page.mouse.down();
      await expect(page.getByTestId("side-panel-resize-shield")).toBeVisible();
      await page.mouse.move(targetX, pointerY, { steps: 12 });
      await page.mouse.up();
      await expect(page.getByTestId("side-panel-resize-shield")).toHaveCount(0);
    };

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByTestId("side-panel-hover-edge").hover();
    await page.getByTestId("global-side-panel-trigger").click();
    let sidePanel = await openBrowserPanel();
    const initialTwoColumnPanel = await sidePanel.boundingBox();
    const twoColumnResizer = await page.getByTestId("side-panel-resizer").boundingBox();
    const twoColumnHitTarget = await page.getByTestId("side-panel-resizer-hit-target").boundingBox();
    expect(initialTwoColumnPanel).not.toBeNull();
    expect(twoColumnResizer).not.toBeNull();
    expect(twoColumnHitTarget).not.toBeNull();
    expect(twoColumnHitTarget!.width).toBeGreaterThanOrEqual(10);
    await dragResizer(twoColumnResizer!.x - 80);
    const widenedTwoColumnPanel = await sidePanel.boundingBox();
    const twoColumnMain = await page.getByTestId("workspace-main-card").boundingBox();
    expect(widenedTwoColumnPanel).not.toBeNull();
    expect(twoColumnMain).not.toBeNull();
    expect(widenedTwoColumnPanel!.width).toBeGreaterThan(initialTwoColumnPanel!.width + 20);
    expect(twoColumnMain!.width).toBeGreaterThanOrEqual(340);

    const cancelStartBox = await page.getByTestId("side-panel-resizer").boundingBox();
    expect(cancelStartBox).not.toBeNull();
    const cancelY = cancelStartBox!.y + cancelStartBox!.height / 2;
    await page.mouse.move(cancelStartBox!.x + cancelStartBox!.width / 2, cancelY);
    await page.mouse.down();
    await expect(page.getByTestId("side-panel-resize-shield")).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(page.getByTestId("side-panel-resize-shield")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => ({
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    }))).toEqual({ cursor: "", userSelect: "" });
    const widthAfterCancel = (await sidePanel.boundingBox())!.width;
    await page.mouse.move(cancelStartBox!.x - 120, cancelY, { steps: 4 });
    await expect.poll(async () => (await sidePanel.boundingBox())!.width).toBeCloseTo(widthAfterCancel, 0);
    await page.mouse.up();

    const restartBox = await page.getByTestId("side-panel-resizer").boundingBox();
    expect(restartBox).not.toBeNull();
    await dragResizer(restartBox!.x + 40);
    expect((await sidePanel.boundingBox())!.width).toBeLessThan(widthAfterCancel - 20);

    const unmountBox = await page.getByTestId("side-panel-resizer").boundingBox();
    expect(unmountBox).not.toBeNull();
    const unmountY = unmountBox!.y + unmountBox!.height / 2;
    await page.mouse.move(unmountBox!.x + unmountBox!.width / 2, unmountY);
    await page.mouse.down();
    await expect(page.getByTestId("side-panel-resize-shield")).toBeVisible();
    await page.evaluate(() => {
      window.history.pushState({}, "", "/auth");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.getByTestId("side-panel-resize-shield")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => ({
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    }))).toEqual({ cursor: "", userSelect: "" });
    await page.mouse.up();
    await expect(page).toHaveURL(/\/messenger\/chat$/);
    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.getByTestId("side-panel-hover-edge").hover();
    await page.getByTestId("global-side-panel-trigger").click();
    sidePanel = await openBrowserPanel();
    await expect(page.getByTestId("side-panel-resizer")).toBeVisible();

    await sidePanel.getByLabel("Close Side Panel").click();
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);
    await page.getByTestId("chat-side-panel-trigger").click();
    sidePanel = await openBrowserPanel();
    await expect(page.getByTestId("workspace-context-card")).toBeVisible();
    const threeColumnResizer = await page.getByTestId("side-panel-resizer").boundingBox();
    expect(threeColumnResizer).not.toBeNull();
    await page.screenshot({ path: "/tmp/zst-774-side-panel-resize.png", fullPage: true });

    await dragResizer(page.viewportSize()!.width - 16);
    await expect(sidePanel).toBeHidden();
    await page.getByTestId("side-panel-hover-edge").hover();
    await expect(page.getByTestId("global-side-panel-trigger")).toBeVisible();
  });
});
