import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_DATABASE_URL } from "./support/e2e-env";
import { resolveE2EOrganizationWorkspaceRoot } from "./support/organization-storage";
import { expectRightAnchoredSidePanelMotion, sampleSidePanelMotion } from "./support/side-panel-motion";

const e2eDb = createDb(E2E_DATABASE_URL);
const LOCAL_IMAGE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const LIBRARY_IMAGE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X5p1sAAAAASUVORK5CYII=",
  "base64",
);

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
          { id: "cursor", label: "Cursor", kind: "ide" },
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

async function installDesktopShellLocalFilePreviewStub(
  page: Page,
  canonicalPath: string,
  expectedFileName = "Chat.parts.tsx",
  sourceLocation?: string,
  content = "export const localFileSidePanelEvidence = true;",
) {
  await page.addInitScript(({ targetPath, fileName, requestedPath, previewContent }) => {
    const previewCalls: string[] = [];
    const updateCalls: Array<{
      filePath: string;
      content: string;
      expectedContent: string;
      writeCapability: string;
    }> = [];
    let currentContent = previewContent;
    Object.defineProperty(window, "__rudderLocalFilePreviewCalls", {
      configurable: true,
      value: previewCalls,
    });
    Object.defineProperty(window, "__rudderLocalFileUpdateCalls", {
      configurable: true,
      value: updateCalls,
    });
    const buildPreview = () => ({
      canonicalPath: targetPath,
      fileName,
      parentPath: targetPath.slice(0, targetPath.lastIndexOf("/")),
      contentType: fileName.endsWith(".md")
        ? "text/markdown; charset=utf-8"
        : "text/plain; charset=utf-8",
      previewKind: fileName.endsWith(".md") ? "markdown" : "text",
      content: currentContent,
      base64: null,
      sizeBytes: currentContent.length,
      modifiedAt: "2026-07-21T00:00:00.000Z",
      truncated: false,
      writeCapability: "e2e-local-file-admission",
    });
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: {
        openPath: async () => {},
        previewLocalFile: async (filePath: string) => {
          previewCalls.push(filePath);
          if (filePath !== requestedPath) throw new Error(`Unexpected local file path: ${filePath}`);
          return buildPreview();
        },
        updateLocalFile: async (
          filePath: string,
          input: { content: string; expectedContent: string; writeCapability: string },
        ) => {
          if (filePath !== targetPath) throw new Error(`Unexpected local file path: ${filePath}`);
          if (input.writeCapability !== "e2e-local-file-admission") {
            throw new Error("Missing local file write admission.");
          }
          if (input.expectedContent !== currentContent) {
            throw new Error("This local file changed since it was opened.");
          }
          updateCalls.push({ filePath, ...input });
          currentContent = input.content;
          return buildPreview();
        },
        setSidePanelCloseShortcutActive: async () => {},
      },
    });
  }, {
    targetPath: canonicalPath,
    fileName: expectedFileName,
    previewContent: content,
    requestedPath: sourceLocation ? `${canonicalPath}:${sourceLocation}` : canonicalPath,
  });
}

async function installDesktopShellLocalImagePreviewStub(page: Page, targetPath: string) {
  await page.addInitScript(({ requestedPath, base64 }) => {
    const previewCalls: string[] = [];
    Object.defineProperty(window, "__rudderLocalFilePreviewCalls", {
      configurable: true,
      value: previewCalls,
    });
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: {
        openPath: async () => {},
        previewLocalFile: async (filePath: string) => {
          previewCalls.push(filePath);
          if (filePath !== requestedPath) throw new Error(`Unexpected local image path: ${filePath}`);
          return {
            canonicalPath: requestedPath,
            fileName: "side-chat.png",
            parentPath: requestedPath.slice(0, requestedPath.lastIndexOf("/")),
            contentType: "image/png",
            previewKind: "image",
            content: null,
            base64,
            sizeBytes: 68,
            modifiedAt: "2026-07-31T00:00:00.000Z",
            truncated: false,
          };
        },
        setSidePanelCloseShortcutActive: async () => {},
      },
    });
  }, { requestedPath: targetPath, base64: LOCAL_IMAGE_BASE64 });
}

async function installBrowserDesktopStub(page: Page) {
  await page.addInitScript(() => {
    let openEmptySidePanelListener: (() => void) | null = null;
    Object.assign(window, {
      __emitDesktopOpenEmptySidePanel: () => openEmptySidePanelListener?.(),
    });
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: {
        getBrowserPartition: async () => "persist:rudder-browser-v1-chat-e2e",
        openExternal: async () => {},
        forceOpenExternal: async () => {},
        setSidePanelCloseShortcutActive: async () => {},
        onCloseSidePanelActiveTab: () => () => {},
        onOpenEmptySidePanel: (listener: () => void) => {
          openEmptySidePanelListener = listener;
          return () => {
            openEmptySidePanelListener = null;
          };
        },
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
  test("opens local image links in the global image preview instead of the Side Panel", async ({ page }) => {
    const localImagePath = "/tmp/side-chat.png";
    await installDesktopShellLocalImagePreviewStub(page, localImagePath);

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Side-Panel-Local-Image-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    const agent = await createE2EChatAgent(page.request, organization.id, { name: "Local Image Agent" });

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Local image preview host chat",
        preferredAgentId: agent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
        initialMessage: { body: "Inspect the referenced image." },
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
      body: `Inspect [side-chat.png](${localImagePath}).`,
      structuredPayload: null,
      replyingAgentId: null,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

    const assistantMessage = page.getByTestId("chat-assistant-message").last();
    const localImageLink = assistantMessage.getByRole("link", { name: "side-chat.png" });
    await expect(localImageLink).toBeVisible({ timeout: 15_000 });
    await expect(localImageLink.locator('[data-local-file-icon="image"]')).toBeVisible();
    await localImageLink.click();

    const preview = page.getByTestId("chat-local-image-preview-dialog");
    await expect(preview).toBeVisible({ timeout: 15_000 });
    await expect(preview.getByRole("img", { name: "side-chat.png" })).toHaveAttribute(
      "src",
      `data:image/png;base64,${LOCAL_IMAGE_BASE64}`,
    );
    await expect(page.getByTestId("chat-side-panel")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __rudderLocalFilePreviewCalls?: string[] }).__rudderLocalFilePreviewCalls ?? []
    ))).toEqual([localImagePath]);

    await page.screenshot({ path: "/tmp/rudder-chat-local-image-preview.png", fullPage: true });
    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);
  });

  test("opens Library image links in the global image preview instead of the Side Panel", async ({ page }) => {
    const imageFilePath = `projects/rudder/verification/${Date.now()}-side-chat.png`;

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Side-Panel-Library-Image-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    const agent = await createE2EChatAgent(page.request, organization.id, { name: "Library Image Agent" });
    const imagePath = path.join(resolveE2EOrganizationWorkspaceRoot(organization.id), imageFilePath);
    await fs.mkdir(path.dirname(imagePath), { recursive: true });
    await fs.writeFile(imagePath, LIBRARY_IMAGE_PNG);

    const fileRes = await page.request.get(
      `/api/orgs/${organization.id}/workspace/file?path=${encodeURIComponent(imageFilePath)}`,
    );
    expect(fileRes.ok(), await fileRes.text()).toBe(true);
    const libraryFile = await fileRes.json() as { markdownLink: string; contentPath: string; previewKind: string };
    expect(libraryFile.previewKind).toBe("image");
    expect(libraryFile.contentPath).toContain("/workspace/file/content");

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Library image preview host chat",
        preferredAgentId: agent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
        initialMessage: { body: "Inspect the Library image." },
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
      body: `Inspect ${libraryFile.markdownLink}.`,
      structuredPayload: null,
      replyingAgentId: null,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

    const assistantMessage = page.getByTestId("chat-assistant-message").last();
    const libraryImageLink = assistantMessage.getByRole("link", { name: imageFilePath.split("/").at(-1) });
    await expect(libraryImageLink).toBeVisible({ timeout: 15_000 });
    await libraryImageLink.click();

    const preview = page.getByTestId("chat-library-image-preview-dialog");
    await expect(preview).toBeVisible({ timeout: 15_000 });
    await expect(preview.getByRole("img", { name: imageFilePath.split("/").at(-1) })).toHaveAttribute(
      "src",
      new RegExp(`/api/orgs/${organization.id}/workspace/file/content\\?path=${encodeURIComponent(imageFilePath)}`),
    );
    await expect(preview.getByRole("img")).toHaveJSProperty("naturalWidth", 1);
    await expect(page.getByTestId("chat-side-panel")).toHaveCount(0);

    await page.screenshot({ path: "/tmp/rudder-chat-library-image-preview.png", fullPage: true });
    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);
  });

  test("opens titled source-located local file links in the Side Panel with a file icon", async ({ page }, testInfo) => {
    const localFilePath = "/Users/zeeland/projects/rudder-oss/doc/product/domains/execution/transcripts-and-results.md";
    await installDesktopShellLocalFilePreviewStub(page, localFilePath, "transcripts-and-results.md", "40");

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Side-Panel-Local-File-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    await createE2EChatAgent(page.request, organization.id, { name: "Local File Agent" });

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Local file side panel host chat",
        issueCreationMode: "manual_approval",
        planMode: false,
        initialMessage: { body: "Show the referenced source file beside this chat." },
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
      body: `Inspect [Transcripts And Results](${localFilePath}:40).`,
      structuredPayload: null,
      replyingAgentId: null,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

    const assistantMessage = page.getByTestId("chat-assistant-message").last();
    const localFileLink = assistantMessage.getByRole("link", { name: "Transcripts And Results" });
    await expect(localFileLink).toBeVisible({ timeout: 15_000 });
    await expect(localFileLink.locator('[data-local-file-icon="document"]')).toBeVisible();
    await localFileLink.click();

    const sidePanel = page.getByTestId("chat-side-panel");
    await expect(sidePanel.getByTestId("chat-side-panel-local-file-view")).toBeVisible({ timeout: 15_000 });
    await expect(sidePanel).toContainText("transcripts-and-results.md");
    await expect(sidePanel.getByTestId("chat-side-panel-local-file-editor")).toContainText(
      "localFileSidePanelEvidence",
    );
    const localEditor = sidePanel.getByTestId("chat-side-panel-local-file-editor");
    const localEditable = localEditor.locator(".rudder-milkdown-content [contenteditable='true']").first();
    await localEditable.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" revised");
    await expect(localEditor).toContainText("Saved", { timeout: 10_000 });
    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & {
        __rudderLocalFileUpdateCalls?: Array<{
          filePath: string;
          content: string;
          expectedContent: string;
          writeCapability: string;
        }>;
      }).__rudderLocalFileUpdateCalls ?? []
    ))).toEqual([
      expect.objectContaining({
        filePath: localFilePath,
        expectedContent: "export const localFileSidePanelEvidence = true;",
        content: expect.stringContaining("revised"),
        writeCapability: "e2e-local-file-admission",
      }),
    ]);
    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __rudderLocalFilePreviewCalls?: string[] }).__rudderLocalFilePreviewCalls ?? []
    ))).toEqual(expect.arrayContaining([`${localFilePath}:40`]));
    await localEditor.locator(".scrollbar-auto-hide").evaluate((element) => {
      element.scrollTop = 0;
    });
    const localParagraph = localEditor.locator(".rudder-milkdown-content p").first();
    await localParagraph.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    const annotationToolbar = page.getByRole("toolbar", {
      name: "Response annotation actions",
    });
    await expect(annotationToolbar).toBeVisible();
    await annotationToolbar.getByRole("button", { name: "Add to chat" }).click();
    const annotationEditor = page.getByTestId("chat-response-annotation-editor");
    await annotationEditor.getByLabel("Comment").fill("Review this local file excerpt.");
    await annotationEditor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Show 1 annotation" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/messenger/chat/${chat.id}$`));

    await page.screenshot({
      path: testInfo.outputPath("chat-side-panel-local-file-link.png"),
      fullPage: true,
    });
  });

  test("keeps a long local source file scrollable in the Side Panel", async ({ page }, testInfo) => {
    const localFilePath = "/Users/zeeland/projects/rudder-oss/ui/src/components/MessengerContextSidebar.tsx";
    const source = Array.from(
      { length: 240 },
      (_, index) => `export const localCodeLine${index} = ${index};`,
    ).join("\n");
    await installDesktopShellLocalFilePreviewStub(
      page,
      localFilePath,
      "MessengerContextSidebar.tsx",
      "40",
      source,
    );

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Side-Panel-Local-Code-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    const agent = await createE2EChatAgent(page.request, organization.id, { name: "Local Code Agent" });

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Local source scroll host chat",
        preferredAgentId: agent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
        initialMessage: { body: "Show the long source file beside this chat." },
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
      body: `Inspect [MessengerContextSidebar.tsx](${localFilePath}:40).`,
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
    const localFileLink = assistantMessage.getByRole("link", { name: "MessengerContextSidebar.tsx" });
    await expect(localFileLink).toBeVisible({ timeout: 15_000 });
    await localFileLink.click();

    const sidePanel = page.getByTestId("chat-side-panel");
    const localEditor = sidePanel.getByTestId("chat-side-panel-local-file-editor");
    const sourceEditor = localEditor.getByTestId("chat-side-panel-local-file-source-editor");
    const scroller = sourceEditor.locator(".cm-scroller");
    await expect(sidePanel.getByTestId("chat-side-panel-local-file-view")).toBeVisible({ timeout: 15_000 });
    await expect(sourceEditor).toHaveAttribute("data-workspace-code-language", "TypeScript");
    await expect(scroller).toBeVisible();

    const scrollMetrics = await scroller.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: window.getComputedStyle(element).overflowY,
    }));
    expect(scrollMetrics.overflowY).toBe("auto");
    expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);

    await scroller.evaluate((element) => {
      element.scrollTop = 0;
    });
    await scroller.hover();
    await page.mouse.wheel(0, 900);
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    const [scrollerBox, lastLineBox] = await Promise.all([
      scroller.boundingBox(),
      sourceEditor.locator(".cm-line").last().boundingBox(),
    ]);
    expect(scrollerBox).not.toBeNull();
    expect(lastLineBox).not.toBeNull();
    expect(lastLineBox!.y + lastLineBox!.height).toBeLessThanOrEqual(
      scrollerBox!.y + scrollerBox!.height + 2,
    );

    await page.screenshot({
      path: testInfo.outputPath("chat-side-panel-local-code-scroll.png"),
      fullPage: true,
    });
  });

  test("resolves a relative command-read file against the recorded command cwd", async ({ page }, testInfo) => {
    const commandCwd = "/Users/zeeland/projects/rudder-oss";
    const relativePath = "doc/README.md";
    const resolvedPath = `${commandCwd}/${relativePath}`;
    await installDesktopShellLocalFilePreviewStub(
      page,
      resolvedPath,
      "README.md",
      undefined,
      "# Rudder documentation\n\nResolved from the command working directory.",
    );

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Side-Panel-Relative-Command-File-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    const agent = await createE2EChatAgent(page.request, organization.id, {
      name: "Command Workspace Agent",
    });

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Relative command file preview",
        preferredAgentId: agent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
        initialMessage: { body: "Read the Rudder documentation." },
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
      body: "The documentation is ready.",
      structuredPayload: {
        __chatTranscript: [
          {
            kind: "tool_call",
            ts: "2026-07-27T10:00:00.000Z",
            name: "command_execution",
            toolUseId: "command-read-doc",
            input: {
              command: "sed -n '1,120p' doc/README.md",
              cwd: commandCwd,
            },
          },
          {
            kind: "tool_result",
            ts: "2026-07-27T10:00:01.000Z",
            toolUseId: "command-read-doc",
            content: "command: sed -n '1,120p' doc/README.md\nstatus: completed\nexit_code: 0",
            isError: false,
          },
        ],
      },
      replyingAgentId: agent.id,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

    const transcript = page.getByTestId("chat-transcript-item");
    await transcript.getByRole("button", { name: /Worked for/i }).click();
    const fileButton = transcript.getByRole("button", { name: "Open file README.md", exact: true });
    await expect(fileButton).toHaveAttribute("data-transcript-file-target", resolvedPath);
    await fileButton.click();

    const sidePanel = page.getByTestId("chat-side-panel");
    await expect(sidePanel.getByTestId("chat-side-panel-local-file-view")).toBeVisible();
    await expect(sidePanel.getByTestId("chat-side-panel-local-file-editor")).toContainText(
      "Resolved from the command working directory.",
    );
    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __rudderLocalFilePreviewCalls?: string[] }).__rudderLocalFilePreviewCalls ?? []
    ))).toEqual(expect.arrayContaining([resolvedPath]));
    await expect(page).toHaveURL(new RegExp(`/messenger/chat/${chat.id}$`));

    await page.screenshot({
      path: testInfo.outputPath("chat-command-relative-file-preview.png"),
      fullPage: true,
    });
  });

  test("renders the full issue detail body when an issue Side Panel tab is expanded", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Side-Panel-Expanded-Issue-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    await createE2EChatAgent(page.request, organization.id, { name: "Side Panel Agent" });

    const longDescription = [
      "Expanded Side Panel should render the same issue detail body.",
      ...Array.from({ length: 48 }, (_, index) => `Scrollable issue detail row ${index + 1}.`),
      "Expanded issue detail scroll sentinel.",
    ].join("\n\n");
    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Expanded detail parity issue",
        description: longDescription,
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
        initialMessage: { body: "Open the issue detail beside this chat." },
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
    const embeddedIssueDetail = sidePanel.getByTestId("embedded-issue-detail");
    await expect(embeddedIssueDetail).toBeVisible();
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

    await expect.poll(async () => embeddedIssueDetail.evaluate((element) => ({
      clientHeight: element.clientHeight,
      overflowY: window.getComputedStyle(element).overflowY,
      scrollHeight: element.scrollHeight,
    }))).toMatchObject({
      overflowY: "auto",
    });
    const scrollMetrics = await embeddedIssueDetail.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
    await embeddedIssueDetail.hover();
    await page.mouse.wheel(0, 900);
    await expect.poll(async () => embeddedIssueDetail.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await page.mouse.wheel(0, 10_000);
    await expect.poll(async () => embeddedIssueDetail.evaluate((element) => (
      Math.abs(element.scrollTop - (element.scrollHeight - element.clientHeight)) <= 1
    ))).toBe(true);
    const scrollSentinel = sidePanel.getByText("Expanded issue detail scroll sentinel.", { exact: true });
    await expect(scrollSentinel).toBeVisible();
    expect(await scrollSentinel.evaluate((element) => {
      const elementRect = element.getBoundingClientRect();
      const scrollRect = element.closest('[data-testid="embedded-issue-detail"]')?.getBoundingClientRect();
      return Boolean(scrollRect && elementRect.bottom > scrollRect.top && elementRect.top < scrollRect.bottom);
    })).toBe(true);

    await page.screenshot({
      path: testInfo.outputPath("chat-side-panel-expanded-issue-detail.png"),
      fullPage: true,
    });
  });

  test("keeps adjacent issue links clickable while a hover preview is open", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Side-Panel-Hover-Links-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    await createE2EChatAgent(page.request, organization.id, { name: "Side Panel Agent" });

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Hover preview must not block the next issue link",
        description: "The preview is intentionally tall enough to overlap the next paragraph.",
        status: "todo",
        priority: "high",
      },
    });
    expect(issueRes.ok(), await issueRes.text()).toBe(true);
    const issue = await issueRes.json() as { id: string; identifier: string | null };
    const issueRef = issue.identifier ?? issue.id;
    const secondIssueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "The adjacent issue must open after one click",
        description: "The second link identifies the issue that the click must open.",
        status: "backlog",
        priority: "medium",
      },
    });
    expect(secondIssueRes.ok(), await secondIssueRes.text()).toBe(true);
    const secondIssue = await secondIssueRes.json() as { id: string; identifier: string | null };
    const secondIssueRef = secondIssue.identifier ?? secondIssue.id;
    const mentionHref = buildIssueMentionHref(issue.id, issueRef);
    const secondMentionHref = buildIssueMentionHref(secondIssue.id, secondIssueRef);

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Adjacent issue link hover regression",
        issueCreationMode: "manual_approval",
        planMode: false,
        initialMessage: { body: "Open either issue reference beside this chat." },
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
      body: `First [${issueRef}](${mentionHref}).\n\nSecond [${secondIssueRef}](${secondMentionHref}).`,
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
    await expect(assistantMessage).toContainText("First", { timeout: 15_000 });
    const issueLinks = assistantMessage.locator('a[data-mention-kind="issue"]');
    await expect(issueLinks).toHaveCount(2);

    await issueLinks.nth(0).hover();
    const previewCard = page.locator(".rudder-entity-preview-card");
    await expect(previewCard).toBeVisible({ timeout: 5_000 });
    const previewBox = await previewCard.boundingBox();
    const secondLinkBox = await issueLinks.nth(1).boundingBox();
    expect(previewBox).not.toBeNull();
    expect(secondLinkBox).not.toBeNull();
    expect(previewBox!.x).toBeLessThan(secondLinkBox!.x + secondLinkBox!.width);
    expect(previewBox!.x + previewBox!.width).toBeGreaterThan(secondLinkBox!.x);
    expect(previewBox!.y).toBeLessThan(secondLinkBox!.y + secondLinkBox!.height);
    expect(previewBox!.y + previewBox!.height).toBeGreaterThan(secondLinkBox!.y);
    await issueLinks.nth(1).click();

    const sidePanel = page.getByTestId("chat-side-panel");
    await expect(sidePanel).toBeVisible({ timeout: 15_000 });
    await expect(sidePanel.getByTestId("chat-side-panel-issue-view")).toBeVisible();
    await expect(sidePanel).toContainText("The adjacent issue must open after one click");

    await page.screenshot({
      path: testInfo.outputPath("chat-side-panel-adjacent-issue-link-click.png"),
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
    await createE2EChatAgent(page.request, organization.id, { name: "Side Panel Agent" });
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
        initialMessage: { body: "Open the Library document beside this chat." },
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
    const markdownEditor = page.getByTestId("library-live-surface-markdown-editor");
    const codeMirror = markdownEditor.locator(
      '[data-editor-engine="codemirror-live-preview"]',
    );
    const headingLine = codeMirror.locator(
      '.cm-line[data-source-line-start="1"]',
    );
    const documentTitle = headingLine.filter({
      hasText: "OpenClaw and Hermes Agent SEO competitor research",
    });
    await expect(documentTitle).toBeVisible();
    await expect(documentTitle).toHaveAttribute(
      "data-markdown-preview-state",
      "preview",
    );
    const fileToolbar = page.getByTestId("library-live-surface-file-toolbar");
    await expect(fileToolbar).toContainText(libraryFilePath);
    await expect(fileToolbar).not.toContainText("text/markdown");

    const libraryOpenIn = fileToolbar.getByRole("button", { name: "Open file options" });
    await expect(libraryOpenIn).toBeVisible();
    await expect(libraryOpenIn).toHaveText("Open");
    const [toolbarBox, openInBox, titleBox] = await Promise.all([
      fileToolbar.boundingBox(),
      libraryOpenIn.boundingBox(),
      documentTitle.boundingBox(),
    ]);
    expect(toolbarBox).not.toBeNull();
    expect(titleBox).not.toBeNull();
    expect(openInBox).not.toBeNull();
    expect(titleBox?.y ?? 0).toBeGreaterThanOrEqual(
      (toolbarBox?.y ?? 0) + (toolbarBox?.height ?? 0),
    );

    const editable = codeMirror.locator(".cm-content");
    await expect(editable).toBeVisible();
    await expect(sidePanel.getByTestId("chat-side-panel-library-file-mode-toggle")).toHaveCount(0);

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

    const titleBoxForEdit = await documentTitle.boundingBox();
    expect(titleBoxForEdit).not.toBeNull();
    await page.mouse.click(
      (titleBoxForEdit?.x ?? 0) + (titleBoxForEdit?.width ?? 0) - 2,
      (titleBoxForEdit?.y ?? 0) + (titleBoxForEdit?.height ?? 0) / 2,
    );
    await page.keyboard.press("End");
    await page.keyboard.type(" revised");
    await expect(headingLine).toHaveAttribute("data-markdown-preview-state", "source");
    await expect(headingLine).toContainText(
      "# OpenClaw and Hermes Agent SEO competitor research revised",
    );
    await expect(markdownEditor).toContainText("Temporary Side Panel save failure", { timeout: 10_000 });
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
    const revisedHeadingBox = await headingLine.boundingBox();
    expect(revisedHeadingBox).not.toBeNull();
    await page.mouse.click(
      (revisedHeadingBox?.x ?? 0) + (revisedHeadingBox?.width ?? 0) - 2,
      (revisedHeadingBox?.y ?? 0) + (revisedHeadingBox?.height ?? 0) / 2,
    );
    await page.keyboard.press("End");
    await page.keyboard.type(" conflict");
    await expect(markdownEditor).toContainText("Temporary Side Panel save failure", { timeout: 10_000 });

    const concurrentLibraryContent = "# New agent copy\n\nKeep this concurrent update.";
    const concurrentWriteRes = await page.request.patch(
      `/api/orgs/${organization.id}/workspace/file?path=${encodeURIComponent(libraryFilePath)}`,
      { data: { content: concurrentLibraryContent, expectedContent: retriedFile.content } },
    );
    expect(concurrentWriteRes.ok(), await concurrentWriteRes.text()).toBe(true);

    allowPatch = true;
    await expect(markdownEditor).toContainText("This file changed while you were editing it.", {
      timeout: 10_000,
    });
    await expect(markdownEditor.getByRole("button", { name: "Keep mine" })).toBeVisible();
    await expect(markdownEditor.getByRole("button", { name: "Use latest" })).toBeVisible();
    await expect(headingLine).toContainText(
      "# OpenClaw and Hermes Agent SEO competitor research revised conflict",
    );

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
    const keptHeadingBox = await headingLine.boundingBox();
    expect(keptHeadingBox).not.toBeNull();
    await page.mouse.click(
      (keptHeadingBox?.x ?? 0) + (keptHeadingBox?.width ?? 0) - 2,
      (keptHeadingBox?.y ?? 0) + (keptHeadingBox?.height ?? 0) / 2,
    );
    await page.keyboard.press("End");
    await page.keyboard.type(" again");
    await expect(markdownEditor).toContainText("Temporary Side Panel save failure", { timeout: 10_000 });

    const secondConcurrentContent = "# Latest agent copy\n\nUse this second concurrent update.";
    const secondConcurrentWriteRes = await page.request.patch(
      `/api/orgs/${organization.id}/workspace/file?path=${encodeURIComponent(libraryFilePath)}`,
      { data: { content: secondConcurrentContent, expectedContent: keptFile.content } },
    );
    expect(secondConcurrentWriteRes.ok(), await secondConcurrentWriteRes.text()).toBe(true);

    allowPatch = true;
    await expect(markdownEditor).toContainText("This file changed while you were editing it.", {
      timeout: 10_000,
    });
    await markdownEditor.getByRole("button", { name: "Use latest" }).click();
    await expect(markdownEditor).toContainText("Saved");
    await expect(headingLine).toContainText("Latest agent copy");

    const savedFileRes = await page.request.get(
      `/api/orgs/${organization.id}/workspace/file?path=${encodeURIComponent(libraryFilePath)}`,
    );
    expect(savedFileRes.ok(), await savedFileRes.text()).toBe(true);
    const savedFile = await savedFileRes.json() as { content: string | null };
    expect(savedFile.content).toBe(secondConcurrentContent);

    const editorBox = await markdownEditor.boundingBox();
    expect(editorBox).not.toBeNull();

    await page.screenshot({
      path: testInfo.outputPath("chat-side-panel-library-markdown-editor.png"),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(sidePanel).toHaveClass(/fixed/);
    await expect(markdownEditor).toBeVisible();
    await expect.poll(async () => page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    })), { timeout: 5_000 }).toEqual({ clientWidth: 390, scrollWidth: 390 });
    const mobilePanelBox = await sidePanel.boundingBox();
    expect(mobilePanelBox).not.toBeNull();
    expect(mobilePanelBox?.x ?? 0).toBeGreaterThanOrEqual(0);
    expect(
      (mobilePanelBox?.x ?? 0) + (mobilePanelBox?.width ?? 0),
    ).toBeLessThanOrEqual(392);
    await page.screenshot({
      path: testInfo.outputPath("chat-side-panel-library-markdown-editor-mobile.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 900 });

    await libraryOpenIn.click();
    await expect(page.getByRole("menuitem", { name: "Open in Library" })).toBeVisible();
    await expect(page.getByTestId("chat-side-panel-library-full-path")).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Default app" })).toBeVisible();
    const cursorMenuItem = page.getByRole("menuitem", { name: "Cursor" });
    await expect(cursorMenuItem).toBeVisible();
    await expect(cursorMenuItem.locator("img")).toHaveAttribute("src", "/brands/cursor-app-icon.svg");
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
    await expect(fileToolbar).toBeVisible();
    await expect(fileToolbar).toContainText(libraryFileName);
    await expect(fileToolbar.getByRole("button", { name: "Open file options" })).toHaveText("Open");

    const readableDocument = markdownEditor.locator(".rudder-readable-document");
    const documentViewport = markdownEditor.locator(":scope > .scrollbar-auto-hide");
    const [readableDocumentBox, documentViewportBox] = await Promise.all([
      readableDocument.boundingBox(),
      documentViewport.boundingBox(),
    ]);
    expect(readableDocumentBox).not.toBeNull();
    expect(documentViewportBox).not.toBeNull();
    expect(readableDocumentBox!.width).toBeLessThanOrEqual(880.5);
    expect(Math.abs(
      (readableDocumentBox!.x - documentViewportBox!.x)
      - ((documentViewportBox!.width - readableDocumentBox!.width) / 2),
    )).toBeLessThanOrEqual(1);

    await page.screenshot({
      path: testInfo.outputPath("chat-side-panel-library-open-in.png"),
      fullPage: true,
    });

    await fileToolbar.getByRole("button", { name: "Open file options" }).click();
    await page.getByRole("menuitem", { name: "Open in Library" }).click();
    const organizationRouteKey = organization.urlKey || organization.issuePrefix;
    await expect(page).toHaveURL(new RegExp(`/${organizationRouteKey}/library\\?path=${encodeURIComponent(libraryFilePath)}$`));
    await expect(page.getByTestId("org-workspaces-editor-tabs")).toContainText(libraryFileName, { timeout: 15_000 });
  });

  test("centers a truncated read-only Markdown preview at a readable width", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Side-Panel-Readable-Markdown-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    await createE2EChatAgent(page.request, organization.id, { name: "Side Panel Agent" });

    const libraryFilePath = `artifacts/readable-markdown-${Date.now()}.md`;
    const libraryFileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: {
        filePath: libraryFilePath,
        content: "# Read-only research brief\n\nThis document should remain comfortable to read in a wide panel.",
      },
    });
    expect(libraryFileRes.ok(), await libraryFileRes.text()).toBe(true);
    const libraryFile = await libraryFileRes.json() as { markdownLink: string };
    const libraryFileName = libraryFilePath.split("/").at(-1) ?? libraryFilePath;
    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Read-only Markdown width host chat",
        issueCreationMode: "manual_approval",
        planMode: false,
        initialMessage: { body: "Open the read-only Markdown preview beside this chat." },
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

    await page.route(`**/api/orgs/${organization.id}/workspace/file?*`, async (route) => {
      const response = await route.fetch();
      const file = await response.json() as Record<string, unknown>;
      await route.fulfill({
        response,
        json: {
          ...file,
          message: "Preview truncated to a safe read-only size.",
          truncated: true,
        },
      });
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
    const documentViewport = page.getByTestId("library-live-surface-markdown-preview");
    const readableDocument = documentViewport.locator(".rudder-readable-document");
    await expect(readableDocument.getByRole("heading", { name: "Read-only research brief" })).toBeVisible();
    const sidePanelResizer = page.getByTestId("side-panel-resizer");
    const resizerBox = await sidePanelResizer.boundingBox();
    expect(resizerBox).not.toBeNull();
    await page.mouse.move(resizerBox!.x + (resizerBox!.width / 2), resizerBox!.y + 120);
    await page.mouse.down();
    await page.mouse.move(500, resizerBox!.y + 120, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => documentViewport.boundingBox().then((box) => box?.width ?? 0)).toBeGreaterThan(900);

    const geometry = await documentViewport.evaluate((viewport) => {
      const document = viewport.querySelector<HTMLElement>(".rudder-readable-document");
      if (!document) return null;
      const viewportRect = viewport.getBoundingClientRect();
      const documentRect = document.getBoundingClientRect();
      const viewportStyle = window.getComputedStyle(viewport);
      return {
        documentWidth: documentRect.width,
        leftGap: documentRect.left - viewportRect.left - Number.parseFloat(viewportStyle.paddingLeft),
        maxWidth: window.getComputedStyle(document).maxWidth,
        rightGap: viewportRect.right - Number.parseFloat(viewportStyle.paddingRight) - documentRect.right,
      };
    });
    expect(geometry).not.toBeNull();
    expect(geometry!.maxWidth).toBe("880px");
    expect(geometry!.documentWidth).toBeLessThanOrEqual(880.5);
    expect(Math.abs(geometry!.leftGap - geometry!.rightGap)).toBeLessThanOrEqual(1);

    await page.screenshot({
      path: testInfo.outputPath("chat-side-panel-read-only-readable-width.png"),
      fullPage: true,
    });
  });

  test("edits and annotates a saved Library code file in the Side Panel", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Side-Panel-Code-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    await createE2EChatAgent(page.request, organization.id, { name: "Code Review Agent" });
    const filePath = `src/side-panel-${Date.now()}.ts`;
    const initialContent = 'export const sidePanelValue = "draft";';
    const fileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: { filePath, content: initialContent },
    });
    expect(fileRes.ok(), await fileRes.text()).toBe(true);
    const libraryFile = await fileRes.json() as { markdownLink: string };
    const fileName = filePath.split("/").at(-1)!;
    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Side Panel code editing",
        initialMessage: { body: "Review this source file." },
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
      body: `Edit ${libraryFile.markdownLink} beside this chat.`,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);
    const assistantMessage = page.getByTestId("chat-assistant-message").last();
    await expect(assistantMessage).toContainText(fileName, { timeout: 15_000 });
    await assistantMessage.getByRole("link", { name: fileName }).click();

    const editor = page.getByTestId("library-live-surface-text-editor");
    const codeContent = editor.getByRole("textbox", {
      name: `${filePath} source editor`,
    });
    await expect(codeContent).toBeVisible();
    await codeContent.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.type('export const sidePanelValue = "ready";');
    await expect(editor).toContainText("Saved", { timeout: 10_000 });

    const savedRes = await page.request.get(
      `/api/orgs/${organization.id}/workspace/file?path=${encodeURIComponent(filePath)}`,
    );
    expect(savedRes.ok(), await savedRes.text()).toBe(true);
    expect((await savedRes.json() as { content: string }).content)
      .toBe('export const sidePanelValue = "ready";');

    await codeContent.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    const annotationToolbar = page.getByRole("toolbar", {
      name: "Response annotation actions",
    });
    await expect(annotationToolbar).toBeVisible();
    await annotationToolbar.getByRole("button", { name: "Add to chat" }).click();
    const annotationEditor = page.getByTestId("chat-response-annotation-editor");
    await annotationEditor.getByLabel("Comment").fill("Confirm this code change.");
    await annotationEditor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Show 1 annotation" })).toBeVisible();

    await page.getByRole("button", { name: "Send" }).click();
    const sentTurn = page.getByTestId("chat-user-message-turn").last();
    await expect(sentTurn.getByRole("button", { name: "Show 1 annotation" }))
      .toBeVisible({ timeout: 15_000 });
    await page.reload();
    const restoredTurn = page.getByTestId("chat-user-message-turn").last();
    await restoredTurn.getByRole("button", { name: "Show 1 annotation" }).click();
    const sentCard = page.getByTestId("chat-response-annotation-sent-card");
    await expect(sentCard).toContainText("Confirm this code change.");
    await sentCard.getByRole("button", { name: "Show source" }).click();
    const reopenedEditor = page.getByTestId("library-live-surface-text-editor");
    await expect(reopenedEditor).toBeVisible();
    await expect(
      reopenedEditor.getByTestId("library-live-surface-text-source-editor"),
    ).toHaveAttribute("data-annotation-location-start", "0");
    await expect.poll(
      async () => page.evaluate(() => window.getSelection()?.toString() ?? ""),
    ).toBe('export const sidePanelValue = "ready";');

    const externalChange = await page.request.patch(
      `/api/orgs/${organization.id}/workspace/file?path=${encodeURIComponent(filePath)}`,
      {
        data: {
          content: 'export const sidePanelValue = "changed elsewhere";',
          expectedContent: 'export const sidePanelValue = "ready";',
        },
      },
    );
    expect(externalChange.ok(), await externalChange.text()).toBe(true);
    await sentCard.getByRole("button", { name: "Show source" }).click();
    await expect(sentCard.getByTestId("chat-response-annotation-unlocatable"))
      .toContainText("Source is no longer available.");

    await page.screenshot({
      path: testInfo.outputPath("chat-side-panel-code-editor-annotation.png"),
      fullPage: true,
    });
  });

  test("edits and annotates a saved Library Markdown file in the Side Panel", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Side-Panel-Markdown-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    await createE2EChatAgent(page.request, organization.id, { name: "Markdown Review Agent" });
    const filePath = `notes/side-panel-${Date.now()}.md`;
    const fileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: { filePath, content: "# Draft heading\n\nReview this paragraph." },
    });
    expect(fileRes.ok(), await fileRes.text()).toBe(true);
    const libraryFile = await fileRes.json() as { markdownLink: string };
    const fileName = filePath.split("/").at(-1)!;
    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Side Panel Markdown editing",
        initialMessage: { body: "Review this Markdown file." },
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
      body: `Edit ${libraryFile.markdownLink} beside this chat.`,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);
    const assistantMessage = page.getByTestId("chat-assistant-message").last();
    await expect(assistantMessage).toContainText(fileName, { timeout: 15_000 });
    await assistantMessage.getByRole("link", { name: fileName }).click();

    const editor = page.getByTestId("library-live-surface-markdown-editor");
    const codeMirror = editor.locator(
      '[data-editor-engine="codemirror-live-preview"]',
    );
    const heading = codeMirror.locator(
      '.cm-line[data-source-line-start="1"]',
    ).filter({ hasText: "Draft heading" });
    await expect(heading).toBeVisible();
    await expect(heading).toHaveAttribute("data-markdown-preview-state", "preview");
    const headingBox = await heading.boundingBox();
    expect(headingBox).not.toBeNull();
    await page.mouse.click(
      (headingBox?.x ?? 0) + (headingBox?.width ?? 0) - 2,
      (headingBox?.y ?? 0) + (headingBox?.height ?? 0) / 2,
    );
    await page.keyboard.press("End");
    await page.keyboard.type(" ready");
    await expect(editor).toContainText("Saved", { timeout: 10_000 });
    const readyHeading = codeMirror.locator(
      '.cm-line[data-source-line-start="1"]',
    );
    await expect(readyHeading).toContainText("# Draft heading ready");

    const savedRes = await page.request.get(
      `/api/orgs/${organization.id}/workspace/file?path=${encodeURIComponent(filePath)}`,
    );
    expect(savedRes.ok(), await savedRes.text()).toBe(true);
    expect((await savedRes.json() as { content: string }).content)
      .toContain("# Draft heading ready");

    await readyHeading.evaluate((element) => {
      const text = element.textContent ?? "";
      const start = text.indexOf("Draft heading ready");
      if (start < 0) throw new Error("Heading source is unavailable");
      const end = start + "Draft heading ready".length;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let offset = 0;
      let startNode: Node | null = null;
      let endNode: Node | null = null;
      let startOffset = 0;
      let endOffset = 0;
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const length = node.textContent?.length ?? 0;
        if (!startNode && start <= offset + length) {
          startNode = node;
          startOffset = start - offset;
        }
        if (end <= offset + length) {
          endNode = node;
          endOffset = end - offset;
          break;
        }
        offset += length;
      }
      if (!startNode || !endNode) throw new Error("Heading text nodes are unavailable");
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    const annotationToolbar = page.getByRole("toolbar", {
      name: "Response annotation actions",
    });
    await expect(annotationToolbar).toBeVisible();
    await annotationToolbar.getByRole("button", { name: "Add to chat" }).click();
    const annotationEditor = page.getByTestId("chat-response-annotation-editor");
    await annotationEditor.getByLabel("Comment").fill("Review this Markdown heading.");
    await annotationEditor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Show 1 annotation" })).toBeVisible();

    await page.getByRole("button", { name: "Send" }).click();
    const sentTurn = page.getByTestId("chat-user-message-turn").last();
    await expect(sentTurn.getByRole("button", { name: "Show 1 annotation" }))
      .toBeVisible({ timeout: 15_000 });
    await sentTurn.getByRole("button", { name: "Show 1 annotation" }).click();
    const sentCard = page.getByTestId("chat-response-annotation-sent-card");
    await expect(sentCard).toBeVisible();
    await expect(sentCard.getByTestId("chat-response-annotation-selected-text"))
      .toContainText("Draft heading ready");
    await expect(sentCard.getByTestId("chat-response-annotation-comment"))
      .toContainText("Review this Markdown heading.");

    await page.screenshot({
      path: testInfo.outputPath("chat-side-panel-markdown-editor-annotation.png"),
      fullPage: true,
    });

    await page.route("**/api/health", async (route) => {
      const response = await route.fetch();
      const health = await response.json() as Record<string, unknown>;
      await route.fulfill({
        response,
        json: {
          ...health,
          devServer: {
            enabled: true,
            restartRequired: true,
            reason: "backend_changes",
            lastChangedAt: new Date().toISOString(),
            changedPathCount: 1,
            changedPathsSample: ["server/src/routes/chats.ts"],
            envFileChanged: false,
            pendingMigrations: [],
            lastRestartAt: new Date(Date.now() - 60_000).toISOString(),
          },
        },
      });
    });
    await page.reload();
    await page.getByTestId("chat-assistant-message").filter({ hasText: fileName })
      .getByRole("link", { name: fileName }).click();
    const staleEditor = page.getByTestId("library-live-surface-markdown-editor")
      .locator('[data-editor-engine="codemirror-live-preview"]');
    const staleReadyHeading = staleEditor.locator(
      '.cm-line[data-source-line-start="1"]',
    );
    await expect(staleReadyHeading).toBeVisible();
    await staleReadyHeading.click();
    await staleReadyHeading.evaluate((element) => {
      const text = element.textContent ?? "";
      const start = text.indexOf("Draft heading ready");
      if (start < 0) throw new Error("Heading source is unavailable");
      const end = start + "Draft heading ready".length;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let offset = 0;
      let startNode: Node | null = null;
      let endNode: Node | null = null;
      let startOffset = 0;
      let endOffset = 0;
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const length = node.textContent?.length ?? 0;
        if (!startNode && start <= offset + length) {
          startNode = node;
          startOffset = start - offset;
        }
        if (end <= offset + length) {
          endNode = node;
          endOffset = end - offset;
          break;
        }
        offset += length;
      }
      if (!startNode || !endNode) throw new Error("Heading text nodes are unavailable");
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await expect(annotationToolbar).toBeVisible();
    await annotationToolbar.getByRole("button", { name: "Add to chat" }).click();
    const staleDraftChip = page.getByTestId("chat-composer-file-drop-target")
      .getByRole("button", { name: "Show 1 annotation" });
    await expect(staleDraftChip).toBeVisible();
    let staleSendRequests = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST"
        && request.url().includes(`/api/chats/${chat.id}/messages/stream`)
      ) staleSendRequests += 1;
    });
    await page.getByRole("button", { name: /^(Send|Queue)$/ }).click();
    await expect(page.getByText("Restart Rudder to send annotations")).toBeVisible();
    await expect(staleDraftChip).toBeVisible();
    expect(staleSendRequests).toBe(0);

    await page.unroute("**/api/health");
    await expect(page.getByText("Restart Rudder to send annotations"))
      .toBeHidden({ timeout: 10_000 });
    await page.reload();
    await expect(page.getByTestId("chat-composer-file-drop-target")
      .getByRole("button", { name: "Show 1 annotation" })).toBeVisible();
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
    await createE2EChatAgent(request, organization.id, { name: "Side Panel Agent" });
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

  test("opens inspectable references in the Side Panel and navigates chat references to Messenger", async ({ page }, testInfo) => {
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
        initialMessage: { body: "Open the referenced detail chat." },
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
        initialMessage: { body: "Show the linked work references." },
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
    const issueTab = sidePanel.locator('[data-testid="chat-side-panel-tab"][data-side-panel-tab-kind="issue"]');
    await expect(issueTab.locator('[data-slot="side-panel-tab-issue-status-icon"]')).toHaveAttribute(
      "data-status",
      "in_progress",
    );

    const propertiesPanel = sidePanel.getByRole("region", { name: "Issue properties" });
    await propertiesPanel.locator('button:has([data-slot="issue-status-icon"])').first().click();
    await page.getByRole("menuitemradio", { name: "Done" }).click();
    await expect(propertiesPanel.getByText("Done", { exact: true })).toBeVisible();
    await expect(issueTab.locator('[data-slot="side-panel-tab-issue-status-icon"]')).toHaveAttribute(
      "data-status",
      "done",
    );

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
    await expect(
      sidePanel.locator('[data-testid="chat-side-panel-tab"][data-side-panel-tab-kind="automation"] svg'),
    ).toBeVisible();
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
    await expect(
      sidePanel.locator('[data-testid="chat-side-panel-tab"][data-side-panel-tab-kind="library_file"] svg'),
    ).toBeVisible();
    const libraryPath = sidePanel.getByRole("navigation", { name: "Library file path" });
    await expect(libraryPath).toContainText("docs");
    await expect(libraryPath).toContainText(libraryFileName);
    await expect(sidePanel).toContainText("Reference library file");
    await expect(sidePanel).toContainText("Library preview should render beside the active chat.");

    await assistantMessage.getByRole("link", { name: "Referenced detail chat" }).click();
    await expect(page).toHaveURL(new RegExp(`/messenger/chat/${referencedChat.id}$`));
    await expect(page.getByTestId("chat-side-panel")).toHaveCount(0);
    await expect(page.getByTestId("chat-assistant-message")).toContainText(
      "Referenced chat body should render beside the active chat.",
    );
  });

  test("navigates a chat reference directly without opening a Side Panel chat tab", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Reference-Navigation-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    await createE2EChatAgent(page.request, organization.id, { name: "Reference Navigation Agent" });

    const targetRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Direct navigation target",
        initialMessage: { body: "This is the destination chat." },
      },
    });
    expect(targetRes.ok(), await targetRes.text()).toBe(true);
    const targetChat = await targetRes.json() as { id: string };

    const hostRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Direct navigation host",
        initialMessage: { body: "Show the referenced destination." },
      },
    });
    expect(hostRes.ok(), await hostRes.text()).toBe(true);
    const hostChat = await hostRes.json() as { id: string };

    await e2eDb.insert(chatMessages).values({
      id: randomUUID(),
      orgId: organization.id,
      conversationId: hostChat.id,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: `Open [Direct navigation target](${buildChatMentionHref(targetChat.id)}).`,
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

    const reference = page.locator('a[data-mention-kind="chat"]', { hasText: "Direct navigation target" });
    await expect(reference).toBeVisible({ timeout: 15_000 });
    await reference.click();

    await expect(page).toHaveURL(new RegExp(`/messenger/chat/${targetChat.id}$`));
    await expect(page.getByTestId("chat-side-panel")).toHaveCount(0);
    await expect(page.getByTestId("chat-user-message")).toContainText("This is the destination chat.");
    await page.screenshot({
      path: "/tmp/rudder-chat-reference-direct-navigation.png",
      fullPage: true,
    });
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
    await createE2EChatAgent(page.request, organization.id, { name: "Side Panel Agent" });

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
        initialMessage: { body: "Open the issue detail beside this chat." },
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
    await createE2EChatAgent(page.request, organization.id, { name: "Side Panel Agent" });

    async function createChat(title: string, body?: string) {
      const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
        data: {
          title,
          issueCreationMode: "manual_approval",
          planMode: false,
          initialMessage: { body: `Open ${title}.` },
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

    async function createIssue(title: string, description: string) {
      const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
        data: {
          title,
          description,
          status: "todo",
          priority: "medium",
        },
      });
      expect(issueRes.ok(), await issueRes.text()).toBe(true);
      return issueRes.json() as Promise<{ id: string; identifier: string | null; title: string }>;
    }

    const panelTargetA = await createIssue("Panel target A", "Panel target A body.");
    const panelTargetB = await createIssue("Panel target B", "Panel target B body.");
    const otherChat = await createChat("Other chat without panel history", "Other chat has no panel history.");
    const thirdChat = await createChat("Third chat without panel history", "Third chat has no panel history.");
    const hostChat = await createChat("Session state host chat", [
      `Compare [Panel target A](${buildIssueMentionHref(panelTargetA.id, panelTargetA.identifier ?? panelTargetA.id)}) beside this chat.`,
      `Compare [Panel target B](${buildIssueMentionHref(panelTargetB.id, panelTargetB.identifier ?? panelTargetB.id)}) beside this chat.`,
    ].join("\n\n"));

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${hostChat.id}`);

    const assistantMessage = page.getByTestId("chat-assistant-message").last();
    await expect(assistantMessage).toContainText("Panel target A", { timeout: 15_000 });

    await assistantMessage.locator('a[data-mention-kind="issue"]').filter({ hasText: "Panel target A" }).click();
    const sidePanel = page.getByTestId("chat-side-panel");
    await expect(sidePanel).toBeVisible({ timeout: 15_000 });
    await expect(sidePanel).toContainText("Panel target A body.");

    await assistantMessage.locator('a[data-mention-kind="issue"]').filter({ hasText: "Panel target B" }).click();
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
    await createE2EChatAgent(page.request, organization.id, { name: "Side Panel Agent" });

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
    await createE2EChatAgent(page.request, organization.id, { name: "Side Panel Agent" });

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
    expect(await page.getByTestId("side-panel-resizer").evaluate((element) => element.offsetWidth)).toBe(4);
    expect(await page.getByTestId("side-panel-resizer-hit-target").evaluate((element) => element.offsetWidth)).toBeGreaterThanOrEqual(10);
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

    await sidePanel.getByTestId("chat-side-panel-empty-library-target").click();
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

  test("requires confirmation before reopening blocked Agents from the Messenger Side Panel", async ({ page }) => {
    test.setTimeout(120_000);

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: "Chat-Side-Panel-Blocked-Reopen-" + Date.now(),
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    const statuses = ["paused", "terminated", "pending_approval"] as const;
    const blockedIssues: Array<{
      status: (typeof statuses)[number];
      issueId: string;
      issueRef: string;
      title: string;
    }> = [];

    for (const status of statuses) {
      const agentRes = await page.request.post("/api/orgs/" + organization.id + "/agents", {
        data: {
          name: status + " Messenger Side Panel Agent",
          role: "pm",
          agentRuntimeType: "codex_local",
          agentRuntimeConfig: { model: "gpt-5.4" },
        },
      });
      expect(agentRes.ok(), await agentRes.text()).toBe(true);
      const agent = await agentRes.json() as { id: string };
      const title = status + " Messenger Side Panel reopen";
      const issueRes = await page.request.post("/api/orgs/" + organization.id + "/issues", {
        data: {
          title,
          description: "Blocked Agent reopen confirmation coverage.",
          status: "done",
          priority: "medium",
          assigneeAgentId: agent.id,
        },
      });
      expect(issueRes.ok(), await issueRes.text()).toBe(true);
      const issue = await issueRes.json() as { id: string; identifier: string | null };
      const statusRes = await page.request.patch("/api/agents/" + agent.id, {
        data: { status },
      });
      expect(statusRes.ok(), await statusRes.text()).toBe(true);
      blockedIssues.push({
        status,
        issueId: issue.id,
        issueRef: issue.identifier ?? issue.id,
        title,
      });
    }

    const hostChatRes = await page.request.post("/api/orgs/" + organization.id + "/chats", {
      data: {
        title: "Blocked Agent Side Panel host",
        issueCreationMode: "manual_approval",
        planMode: false,
        initialMessage: { body: "Open the blocked Agent issues." },
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
      body: blockedIssues.map((entry) => (
        "Open [" + entry.title + "](" + buildIssueMentionHref(entry.issueId, entry.issueRef) + ")"
      )).join("\n\n"),
      structuredPayload: null,
      replyingAgentId: null,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto("/" + organization.issuePrefix + "/messenger/chat/" + hostChat.id);

    const assistantMessage = page
      .getByTestId("chat-assistant-message")
      .filter({ hasText: blockedIssues[0].title })
      .last();
    await expect(assistantMessage).toBeVisible({ timeout: 15_000 });
    const sidePanel = page.getByTestId("chat-side-panel");
    const dialog = page.getByRole("dialog");

    for (const entry of blockedIssues) {
      await assistantMessage
        .locator('a[data-mention-kind="issue"]')
        .filter({ hasText: entry.issueRef })
        .click();
      await expect(sidePanel).toBeVisible({ timeout: 15_000 });
      await expect(sidePanel).toContainText(entry.title);
      const activity = sidePanel.getByRole("region", { name: "Activity" });
      const composer = activity.locator(".rudder-milkdown-content [contenteditable='true']").last();
      const reopenCheckbox = activity.getByRole("checkbox", { name: "Re-open" });
      await expect(reopenCheckbox).toBeChecked();
      await composer.click();
      await page.keyboard.type("Confirm the " + entry.status + " Side Panel reopen first");

      let commentPostCount = 0;
      const onRequest = (request: { method(): string; url(): string }) => {
        const url = new URL(request.url());
        if (request.method() === "POST" && url.pathname === "/api/issues/" + entry.issueId + "/comments") {
          commentPostCount += 1;
        }
      };
      page.on("request", onRequest);
      try {
        await activity.getByRole("button", { name: "Comment", exact: true }).click();
        await expect(dialog).toBeVisible();
        expect(commentPostCount).toBe(0);
        await dialog.getByRole("button", { name: "Return and mention an Agent" }).click();
      } finally {
        page.off("request", onRequest);
      }
      await expect(composer).toContainText("Confirm the " + entry.status + " Side Panel reopen first");
      await expect(composer).toBeFocused();
      const issueAfterCancelRes = await page.request.get("/api/issues/" + entry.issueId);
      expect(issueAfterCancelRes.ok(), await issueAfterCancelRes.text()).toBe(true);
      expect((await issueAfterCancelRes.json() as { status: string }).status).toBe("done");
    }
  });

  test("opens the panel picker from the Desktop new-tab event without creating placeholder tabs", async ({ page }) => {
    await installBrowserDesktopStub(page);
    await installEnabledBrowserSettingsStub(page);
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Desktop-Side-Panel-New-Tab-${Date.now()}`,
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

    const emitDesktopNewTab = () => page.evaluate(() => (
      window as typeof window & { __emitDesktopOpenEmptySidePanel(): void }
    ).__emitDesktopOpenEmptySidePanel());
    const sidePanel = page.getByTestId("chat-side-panel");

    await expect(sidePanel).toHaveCount(0);
    await emitDesktopNewTab();
    await expect(sidePanel).toBeVisible({ timeout: 15_000 });
    await expect(sidePanel.getByTestId("chat-side-panel-empty-state")).toBeVisible();
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(0);

    await sidePanel.getByTestId("chat-side-panel-empty-library-target").click();
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(1);
    await expect(sidePanel.getByTestId("chat-side-panel-tab").first()).toContainText("Library");

    await emitDesktopNewTab();
    await emitDesktopNewTab();
    await expect(sidePanel.getByTestId("chat-side-panel-empty-state")).toBeVisible();
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(1);

    await sidePanel.getByTestId("chat-side-panel-empty-browser-target").click();
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(2);
    await sidePanel.getByLabel("Close Side Panel").click();
    await expect(sidePanel).toBeHidden();

    await emitDesktopNewTab();
    await expect(sidePanel).toBeVisible();
    await expect(sidePanel.getByTestId("chat-side-panel-empty-state")).toBeVisible();
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(2);
    await sidePanel.getByTestId("chat-side-panel-empty-browser-target").click();
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(3);
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

  test("keeps the main workspace mounted but fully hidden and inert while the Side Panel is expanded", async ({ page }) => {
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
    await expect(mainWorkspace).toHaveCSS("border-left-width", "0px");
    await expect(mainWorkspace).toHaveCSS("border-right-width", "0px");
    await expect(mainWorkspace).toHaveCSS("box-shadow", "none");
    expect((await mainWorkspace.boundingBox())?.width ?? 0).toBeLessThanOrEqual(0.5);

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
    await expect(page.getByTestId("workspace-main-card")).toHaveCSS("border-left-width", "1px");
    await expect(page.getByTestId("workspace-main-card")).toHaveCSS("border-right-width", "1px");

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
    await expect(page.getByTestId("workspace-main-card")).toHaveCSS("border-left-width", "1px");
    await expect(page.getByTestId("workspace-main-card")).toHaveCSS("border-right-width", "1px");
  });

  test("keeps resize continuous through the 2:1 auto-expand boundary", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Side-Panel-Auto-Expand-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    await createE2EChatAgent(page.request, organization.id, { name: "Side Panel Boundary Agent" });
    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Side Panel boundary host",
        initialMessage: { body: "Verify the Side Panel resize boundary." },
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

    const cases = [
      {
        label: "Dashboard at 994 CSS pixels",
        path: `/${organization.issuePrefix}/dashboard`,
        viewportWidth: 994,
        open: async () => {
          await page.getByTestId("side-panel-hover-edge").hover();
          await page.getByTestId("global-side-panel-trigger").click();
        },
      },
      {
        label: "Messenger three-column workspace at 1440 CSS pixels",
        path: `/${organization.issuePrefix}/messenger/chat/${chat.id}`,
        viewportWidth: 1440,
        open: async () => page.getByTestId("chat-side-panel-trigger").click(),
      },
    ];

    for (const resizeCase of cases) {
      await test.step(resizeCase.label, async () => {
        await page.setViewportSize({ width: resizeCase.viewportWidth, height: 900 });
        await page.evaluate(() => {
          window.localStorage.removeItem("rudder.workspace.sidePanelWidth.v2");
        });
        await page.goto(resizeCase.path);
        await resizeCase.open();

        const sidePanel = page.getByTestId("chat-side-panel");
        const resizer = page.getByTestId("side-panel-resizer");
        const resizerHitTarget = page.getByTestId("side-panel-resizer-hit-target");
        const main = page.getByTestId("workspace-main-card");
        await expect(sidePanel).toBeVisible({ timeout: 15_000 });
        await expect(resizer).toBeVisible();
        await expect.poll(() => resizer.evaluate((element) => element.offsetWidth)).toBe(4);
        expect(await resizerHitTarget.evaluate((element) => element.offsetWidth)).toBeGreaterThanOrEqual(10);
        expect(await resizerHitTarget.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const edgeTarget = document.elementFromPoint(rect.left + 0.5, rect.top + rect.height / 2);
          return edgeTarget === element || element.contains(edgeTarget);
        })).toBe(true);

        const [initialStackBox, initialPanelBox, initialResizerBox] = await Promise.all([
          page.getByTestId("workspace-main-panel-stack").boundingBox(),
          sidePanel.boundingBox(),
          resizer.boundingBox(),
        ]);
        expect(initialStackBox).not.toBeNull();
        expect(initialPanelBox).not.toBeNull();
        expect(initialResizerBox).not.toBeNull();

        const [stackLayoutWidth, resizerLayoutWidth] = await Promise.all([
          page.getByTestId("workspace-main-panel-stack").evaluate((element) => element.offsetWidth),
          resizer.evaluate((element) => element.offsetWidth),
        ]);
        const visualScale = initialStackBox!.width / stackLayoutWidth;
        const boundaryWidth = (stackLayoutWidth - resizerLayoutWidth) * (2 / 3) * visualScale;
        const pointerY = initialResizerBox!.y + initialResizerBox!.height / 2;
        const startPointerX = initialResizerBox!.x + initialResizerBox!.width / 2;
        await page.mouse.move(startPointerX, pointerY);
        await page.mouse.down();
        await expect(page.getByTestId("side-panel-resize-shield")).toBeVisible();

        let pointerX = startPointerX;
        let previousPanelWidth = initialPanelBox!.width;
        let previousResizerX = initialResizerBox!.x;
        for (const targetPanelWidth of [boundaryWidth - 8, boundaryWidth - 2]) {
          const currentPanelBox = await sidePanel.boundingBox();
          expect(currentPanelBox).not.toBeNull();
          pointerX -= targetPanelWidth - currentPanelBox!.width;
          await page.mouse.move(pointerX, pointerY, { steps: 12 });
          await expect.poll(async () => {
            const panelBox = await sidePanel.boundingBox();
            return panelBox ? Math.abs(panelBox.width - targetPanelWidth) : Number.POSITIVE_INFINITY;
          }).toBeLessThanOrEqual(2);
          await expect(page.getByTestId("side-panel-expanded-overlay")).toHaveCount(0);
          await expect(resizer).toBeVisible();

          const [panelBox, mainBox, resizerBox] = await Promise.all([
            sidePanel.boundingBox(),
            main.boundingBox(),
            resizer.boundingBox(),
          ]);
          expect(panelBox).not.toBeNull();
          expect(mainBox).not.toBeNull();
          expect(resizerBox).not.toBeNull();
          expect(panelBox!.width).toBeGreaterThanOrEqual(previousPanelWidth - 2);
          expect(resizerBox!.x).toBeLessThanOrEqual(previousResizerX + 2);
          expect(panelBox!.width).toBeLessThanOrEqual(2 * mainBox!.width + 2);
          previousPanelWidth = panelBox!.width;
          previousResizerX = resizerBox!.x;
        }

        const preCrossPanelBox = await sidePanel.boundingBox();
        expect(preCrossPanelBox).not.toBeNull();
        pointerX -= boundaryWidth + 6 - preCrossPanelBox!.width;
        await page.mouse.move(pointerX, pointerY, { steps: 8 });
        await expect(page.getByTestId("side-panel-expanded-overlay")).toBeVisible();
        await expect(resizer).toBeHidden();
        await page.mouse.up();
        await expect(page.getByTestId("side-panel-resize-shield")).toHaveCount(0);
        await expect(main).toHaveAttribute("aria-hidden", "true");
        await expect(main).toHaveAttribute("inert", "");
        await expect(main).toHaveCSS("border-left-width", "0px");
        await expect(main).toHaveCSS("border-right-width", "0px");
        await expect.poll(async () => (await main.boundingBox())?.width ?? Number.POSITIVE_INFINITY)
          .toBeLessThanOrEqual(0.5);
        await expect.poll(async () => {
          const [stackBox, panelBox] = await Promise.all([
            page.getByTestId("workspace-main-panel-stack").boundingBox(),
            sidePanel.boundingBox(),
          ]);
          if (!stackBox || !panelBox) return Number.POSITIVE_INFINITY;
          return Math.max(
            Math.abs(panelBox.x - stackBox.x),
            Math.abs((panelBox.x + panelBox.width) - (stackBox.x + stackBox.width)),
          );
        }).toBeLessThanOrEqual(2);

        await sidePanel.getByLabel("Close Side Panel").click();
        await expect(sidePanel).toHaveCount(0);
      });
    }
  });

  test("keeps desktop chat usable beside the Side Panel without a toolbar clearance strip", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-No-Clearance-${Date.now()}`,
        issuePrefix: `CTC${randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string; urlKey: string };
    await createE2EChatAgent(page.request, organization.id, { name: "Side Panel Agent" });

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Interrupted chat beside Browser",
        issueCreationMode: "manual_approval",
        planMode: false,
        initialMessage: { body: "Keep desktop chat controls readable while the transcript scrolls." },
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
      body: [
        "Chat run interrupted before a final reply. Continue the conversation to resume from the preserved context.",
        ...Array.from(
          { length: 32 },
          (_, index) => `Preserved transcript line ${index + 1} remains visible while scrolling in desktop chat.`,
        ),
      ].join("\n\n"),
      structuredPayload: null,
      replyingAgentId: null,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await page.setViewportSize({ width: 1200, height: 820 });
    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
      window.localStorage.setItem("rudder.theme", "dark");
    }, organization.id);
    await page.goto(`/${organization.urlKey}/messenger/chat/${chat.id}`);

    await page.getByRole("button", { name: "Collapse workspace sidebar" }).click();
    const reopenZone = page.getByTestId("workspace-sidebar-reopen-zone");
    await reopenZone.hover();
    await expect(page.getByTestId("workspace-sidebar-reopen-button")).toBeVisible();
    await page.getByTestId("chat-side-panel-trigger").click();
    const sidePanel = page.getByTestId("chat-side-panel");
    await expect(sidePanel).toBeVisible({ timeout: 15_000 });

    const openSidebarButton = page.getByTestId("workspace-sidebar-reopen-button");
    const chatActionsButton = page.getByTestId("chat-actions-trigger");
    const assistantMessage = page.getByTestId("chat-assistant-message");
    const transcriptLine = assistantMessage.getByText(
      "Preserved transcript line 1 remains visible while scrolling in desktop chat.",
      { exact: true },
    );
    const scrollRegion = page.getByTestId("chat-messages-scroll-region");
    await expect(page.getByTestId("chat-desktop-toolbar-clearance")).toHaveCount(0);
    await expect(chatActionsButton).toBeVisible();
    await expect(assistantMessage).toContainText("Chat run interrupted before a final reply.");
    await expect(transcriptLine).toBeVisible();
    await scrollRegion.evaluate((element) => {
      element.scrollTop = 0;
    });

    const [openSidebarBox, chatActionsBox, messageBox, transcriptLineBox, scrollRegionBox, mainCardBox] =
      await Promise.all([
        openSidebarButton.boundingBox(),
        chatActionsButton.boundingBox(),
        assistantMessage.boundingBox(),
        transcriptLine.boundingBox(),
        scrollRegion.boundingBox(),
        page.getByTestId("chat-main-workspace-card").boundingBox(),
      ]);
    expect(openSidebarBox).not.toBeNull();
    expect(chatActionsBox).not.toBeNull();
    expect(messageBox).not.toBeNull();
    expect(transcriptLineBox).not.toBeNull();
    expect(scrollRegionBox).not.toBeNull();
    expect(mainCardBox).not.toBeNull();

    expect(openSidebarBox!.y).toBeGreaterThanOrEqual(mainCardBox!.y);
    expect(chatActionsBox!.y).toBeGreaterThanOrEqual(mainCardBox!.y);
    expect(scrollRegionBox!.y).toBeGreaterThanOrEqual(mainCardBox!.y);
    expect(messageBox!.y).toBeGreaterThanOrEqual(scrollRegionBox!.y);
    const controlsMessageOverlapWidth = Math.max(
      0,
      Math.min(chatActionsBox!.x + chatActionsBox!.width, messageBox!.x + messageBox!.width)
        - Math.max(chatActionsBox!.x, messageBox!.x),
    );
    const controlsMessageOverlapHeight = Math.max(
      0,
      Math.min(chatActionsBox!.y + chatActionsBox!.height, messageBox!.y + messageBox!.height)
        - Math.max(chatActionsBox!.y, messageBox!.y),
    );
    expect(controlsMessageOverlapWidth * controlsMessageOverlapHeight).toBe(0);

    const scrollAmount = Math.max(1, transcriptLineBox!.y - (scrollRegionBox!.y + 10));
    await scrollRegion.evaluate((element, nextScrollTop) => {
      element.scrollTop = nextScrollTop;
      element.dispatchEvent(new Event("scroll"));
    }, scrollAmount);
    await expect.poll(() => scrollRegion.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    const scrolledTranscriptLineBox = await transcriptLine.boundingBox();
    expect(scrolledTranscriptLineBox).not.toBeNull();
    expect(scrolledTranscriptLineBox!.y).toBeLessThan(transcriptLineBox!.y);

    await page.screenshot({
      path: "/tmp/rudder-chat-without-toolbar-clearance.png",
      fullPage: true,
    });
  });

  test("keeps each newly opened Side Panel tab fully visible", async ({ page }, testInfo) => {
    await installBrowserDesktopStub(page);
    const browserSettings = await page.request.patch("/api/instance/settings/browser", {
      data: { enabled: true, openLinksIn: "built_in" },
    });
    expect(browserSettings.ok(), await browserSettings.text()).toBe(true);
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Visible-Side-Panel-Tab-${Date.now()}`,
        issuePrefix: `VST${randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    await createE2EChatAgent(page.request, organization.id, { name: "Visible Tab Agent" });

    const hostChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Visible Side Panel tab host chat",
        issueCreationMode: "manual_approval",
        planMode: false,
        initialMessage: { body: "Keep new tabs visible." },
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
    await page.getByTestId("chat-side-panel-trigger").click();

    const sidePanel = page.getByTestId("chat-side-panel");
    await expect(sidePanel).toBeVisible({ timeout: 15_000 });
    await sidePanel.getByRole("button", { name: /Browser/ }).click();
    const openNewBrowserTab = page.getByRole("button", { name: "Open new browser tab" }).last();
    await expect(openNewBrowserTab).toBeVisible();
    const tabScroller = sidePanel.getByTestId("chat-side-panel-tab-scroller");
    const activeTabShell = sidePanel.locator(
      '[data-testid="chat-side-panel-tab"][aria-selected="true"]',
    ).locator("..");
    const expectActiveTabContained = async () => {
      await expect.poll(async () => {
        const [activeBox, scrollerBox] = await Promise.all([
          activeTabShell.boundingBox(),
          tabScroller.boundingBox(),
        ]);
        if (!activeBox || !scrollerBox) return false;
        return activeBox.x >= scrollerBox.x - 1
          && activeBox.x + activeBox.width <= scrollerBox.x + scrollerBox.width + 1;
      }).toBe(true);
    };
    for (let index = 0; index < 5; index += 1) {
      await openNewBrowserTab.click();
      await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(index + 2);
      await expectActiveTabContained();
    }

    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(6);
    await expect(sidePanel.getByTestId("chat-side-panel-add-tab")).toBeVisible();
    await expect(sidePanel.getByLabel("Expand Side Panel")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("chat-side-panel-active-tab-visible.png"),
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
    await createE2EChatAgent(page.request, organization.id, { name: "Side Panel Agent" });

    const hostChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Side Panel Browser host chat",
        issueCreationMode: "manual_approval",
        planMode: false,
        initialMessage: { body: "Open a browser beside this chat." },
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
    await stableWebview.evaluate((element) => {
      element.dispatchEvent(Object.assign(new Event("page-favicon-updated"), {
        favicons: ["http://localhost:4173/favicon.ico"],
      }));
    });
    await expect(activeBrowserTab.getByTestId("chat-side-panel-tab-browser-favicon")).toHaveAttribute(
      "src",
      "http://localhost:4173/favicon.ico",
    );

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
    await browserTabs.first().locator("..").click({ button: "right" });
    const inactiveTabMenu = page.getByTestId("chat-side-panel-tab-context-menu");
    await expect(inactiveTabMenu).toBeVisible();
    await expect(inactiveTabMenu.getByRole("menuitem", { name: "Move to Messenger" })).toHaveCount(0);
    await expect(browserTabs.first()).toHaveAttribute("aria-selected", "false");
    await expect(browserTabs.last()).toHaveAttribute("aria-selected", "true");
    await expect(sidePanel.getByTestId("chat-side-panel-browser-start")).toBeVisible();
    await page.keyboard.press("Escape");

    const inactiveTabShell = browserTabs.first().locator("..");
    const inactiveTabBox = await inactiveTabShell.boundingBox();
    expect(inactiveTabBox).not.toBeNull();
    await inactiveTabShell.dispatchEvent("pointerdown", {
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      clientX: inactiveTabBox!.x + inactiveTabBox!.width / 2,
      clientY: inactiveTabBox!.y + inactiveTabBox!.height / 2,
    });
    await page.waitForTimeout(750);
    await expect(page.getByTestId("chat-side-panel-tab-context-menu")).toBeVisible();
    await inactiveTabShell.dispatchEvent("pointerup", {
      pointerType: "touch",
      isPrimary: true,
      button: 0,
    });
    await browserTabs.first().dispatchEvent("click", { button: 0 });
    await expect(browserTabs.first()).toHaveAttribute("aria-selected", "false");
    await expect(browserTabs.last()).toHaveAttribute("aria-selected", "true");
    await expect(sidePanel.getByTestId("chat-side-panel-browser-start")).toBeVisible();
    await page.keyboard.press("Escape");

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

    await browserTabs.last().locator("..").click({ button: "right" });
    const activeTabMenu = page.getByTestId("chat-side-panel-tab-context-menu");
    await expect(activeTabMenu).toBeVisible();
    await activeTabMenu.getByRole("menuitem", { name: "Close" }).click();
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(1);
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toContainText("localhost");

    await sidePanel.getByLabel("Browser URL").focus();
    await dispatchBrowserShortcut("t", "KeyT");
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(2);
    await page.keyboard.press("ControlOrMeta+W");
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(1);
    expect(page.isClosed()).toBe(false);

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
    await createE2EChatAgent(page.request, organization.id, { name: "Side Panel Agent" });

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
    await createE2EChatAgent(page.request, organization.id, { name: "Side Panel Agent" });
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
