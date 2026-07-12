import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

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
      data: { name: `Chat-Side-Panel-Expanded-Issue-${Date.now()}` },
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
      data: { name: `Chat-Side-Panel-File-Launcher-${Date.now()}` },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    const libraryFilePath = `docs/file-launcher-${Date.now()}.md`;
    const libraryFileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: {
        filePath: libraryFilePath,
        content: "# OpenClaw and Hermes Agent SEO competitor research\n\nOpen this document outside Rudder.",
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

    const libraryOpenIn = sidePanel.getByRole("button", { name: "Open Library document in another app" });
    await expect(libraryOpenIn).toBeVisible();
    const [titleBox, openInBox] = await Promise.all([
      documentTitle.boundingBox(),
      libraryOpenIn.boundingBox(),
    ]);
    expect(titleBox).not.toBeNull();
    expect(openInBox).not.toBeNull();
    expect(Math.abs((titleBox?.y ?? 0) - (openInBox?.y ?? 0))).toBeLessThanOrEqual(2);
    expect((openInBox?.y ?? 0) + (openInBox?.height ?? 0)).toBeLessThanOrEqual(
      (titleBox?.y ?? 0) + (titleBox?.height ?? 0),
    );
    await libraryOpenIn.click();
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

    await page.screenshot({
      path: testInfo.outputPath("chat-side-panel-library-open-in.png"),
      fullPage: true,
    });
  });

  test("reuses the Automation detail UI in the Side Panel", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Chat-Side-Panel-Automation-${Date.now()}` },
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
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Chat-Side-Panel-${Date.now()}` },
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

    const assistantMessage = page.getByTestId("chat-assistant-message").last();
    await expect(assistantMessage).toContainText("Open", { timeout: 15_000 });

    await assistantMessage.locator('a[data-mention-kind="issue"]').filter({ hasText: issueRef }).click();
    await expect(page).toHaveURL(new RegExp(`${hostChat.id}$`));
    const sidePanel = page.getByTestId("chat-side-panel");
    await expect(sidePanel).toBeVisible({ timeout: 15_000 });
    await expect(sidePanel.getByTestId("chat-side-panel-tabs")).toBeVisible();
    await expect(sidePanel.getByText("Side Panel")).toHaveCount(0);
    await expect(sidePanel.getByRole("button", { name: `Close ${issueRef} tab` })).toBeVisible();
    await expect(sidePanel).toContainText("Reference issue target");
    await expect(sidePanel).toContainText("Issue details should stay beside the active chat.");
    await expect(sidePanel).toContainText("Existing side panel comment should stay visible.");
    await expect(sidePanel.getByLabel("Edit issue")).toHaveCount(0);
    await expect(sidePanel.getByRole("region", { name: "Issue properties" })).toBeVisible();
    await expect(sidePanel.getByText("Properties", { exact: true })).toBeVisible();
    await expect(sidePanel.getByText("Reference Automation Agent", { exact: true })).toBeVisible();
    await expect(sidePanel.getByText("engineer", { exact: true })).toBeVisible();
    await expect(sidePanel.getByLabel("Close Side Panel")).toBeVisible();
    await expect(sidePanel.getByLabel("Expand Side Panel")).toBeVisible();
    await expect(sidePanel.getByRole("link", { name: "Full page" })).toHaveCount(0);

    const propertiesPanel = sidePanel.getByRole("region", { name: "Issue properties" });
    await propertiesPanel.locator('button:has([data-slot="issue-status-icon"])').first().click();
    await page.getByRole("menuitemradio", { name: "Done" }).click();
    await expect(sidePanel).toContainText("done");

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

    await sidePanel.getByLabel("Expand Side Panel").click();
    await expect(sidePanel).toContainText("Sub-issues");
    await expect(sidePanel).toContainText("Activity");
    await expect(propertiesPanel).toBeVisible();

    const commentComposer = sidePanel.locator(".chat-composer .rudder-milkdown-content [contenteditable='true']").last();
    await expect(commentComposer).toBeVisible({ timeout: 15_000 });
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

    await assistantMessage.locator('a[data-mention-kind="automation"]').filter({ hasText: automation.title }).click();
    await expect(page).toHaveURL(new RegExp(`${hostChat.id}$`));
    await expect(sidePanel).toContainText("Codex verification automation");
    await expect(sidePanel).toContainText("Active");
    await expect(sidePanel).toContainText("Next run");
    await expect(sidePanel).toContainText("Previous runs");
    await expect(sidePanel.getByRole("button", { name: "Run now" })).toBeVisible();
    await expect(sidePanel.getByRole("link", { name: "Full page" })).toHaveCount(0);

    await assistantMessage.locator('a[data-mention-kind="library_file"]').filter({ hasText: libraryFileName }).click();
    await expect(page).toHaveURL(new RegExp(`${hostChat.id}$`));
    await expect(sidePanel).toContainText(libraryFilePath);
    await expect(sidePanel).toContainText("Reference library file");
    await expect(sidePanel).toContainText("Library preview should render beside the active chat.");

    await assistantMessage.locator('a[data-mention-kind="chat"]').filter({ hasText: "Referenced detail chat" }).click();
    await expect(page).toHaveURL(new RegExp(`${hostChat.id}$`));
    await expect(sidePanel).toContainText("Referenced detail chat");
    await expect(sidePanel).toContainText("Referenced chat body should render beside the active chat.");
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(4);
  });

  test("keeps the issue Side Panel in one scroll flow with a pinned composer", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Chat-Side-Panel-Pinned-Composer-${Date.now()}` },
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
      data: { name: `Chat-Side-Panel-Session-State-${Date.now()}` },
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
      data: { name: `Chat-Side-Panel-Issue-Session-State-${Date.now()}` },
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
      data: { name: `Chat-Side-Panel-Library-Directory-${Date.now()}` },
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
    await expect(sidePanel).toContainText(`${directoryPath}/nested/charlie.md`);
    await expect(sidePanel).toContainText("Nested file preview.");
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(2);
  });

  test("opens the global empty Side Panel picker from a non-reference page", async ({ page }) => {
    await installBrowserDesktopStub(page);
    await installEnabledBrowserSettingsStub(page);
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Global-Side-Panel-${Date.now()}` },
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

    const mainCardBox = await page.getByTestId("workspace-main-card").boundingBox();
    const resizerBox = await page.getByTestId("side-panel-resizer").boundingBox();
    const sidePanelBox = await sidePanel.boundingBox();
    const sidePanelHeaderBox = await sidePanel.locator(".workspace-main-card").first().boundingBox();
    expect(mainCardBox).not.toBeNull();
    expect(resizerBox).not.toBeNull();
    expect(sidePanelBox).not.toBeNull();
    expect(sidePanelHeaderBox).not.toBeNull();
    expect(Math.round(resizerBox!.x - (mainCardBox!.x + mainCardBox!.width))).toBeLessThanOrEqual(2);
    expect(Math.round(sidePanelBox!.x - (resizerBox!.x + resizerBox!.width))).toBe(0);
    expect(Math.round(sidePanelHeaderBox!.x - (mainCardBox!.x + mainCardBox!.width))).toBeLessThanOrEqual(6);

    await sidePanel.getByLabel("Expand Side Panel").click();
    await expect(sidePanel.getByLabel("Restore Side Panel width")).toBeVisible();
    await expect(page.getByTestId("side-panel-expanded-overlay")).toBeVisible();
    await expect(page.getByTestId("side-panel-resizer")).toHaveCount(0);

    const expandedMainCardBox = await page.getByTestId("workspace-main-card").boundingBox();
    const expandedSidePanelBox = await sidePanel.boundingBox();
    expect(expandedMainCardBox).not.toBeNull();
    expect(expandedSidePanelBox).not.toBeNull();
    expect(Math.abs(Math.round(expandedSidePanelBox!.x - expandedMainCardBox!.x))).toBeLessThanOrEqual(2);
    expect(Math.abs(Math.round((expandedMainCardBox!.x + expandedMainCardBox!.width) - (expandedSidePanelBox!.x + expandedSidePanelBox!.width)))).toBeLessThanOrEqual(2);

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
      data: { name: `Side-Panel-Motion-Resize-${Date.now()}` },
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
    await expect(sidePanel).toHaveClass(/motion-chat-side-panel/);
    await expect(sidePanel).toHaveClass(/transition-\[width,opacity,transform\]/);
    await expect(page.getByTestId("side-panel-resizer")).toHaveClass(/transition-\[width,opacity,transform\]/);

    const collapseStart = await page.getByTestId("side-panel-resizer").boundingBox();
    expect(collapseStart).not.toBeNull();
    await page.mouse.move(collapseStart!.x + collapseStart!.width / 2, collapseStart!.y + collapseStart!.height / 2);
    await page.mouse.down();
    await page.mouse.move(page.viewportSize()!.width - 16, collapseStart!.y + collapseStart!.height / 2, { steps: 8 });
    await expect(sidePanel).toHaveCount(0);
    await page.mouse.up();

    await page.getByTestId("side-panel-hover-edge").hover();
    await page.getByTestId("global-side-panel-trigger").click();
    const reopenedBox = await sidePanel.boundingBox();
    expect(reopenedBox).not.toBeNull();
    expect(reopenedBox!.width).toBeGreaterThanOrEqual(390);
  });

  test("hides the main workspace while the Side Panel is expanded", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Global-Side-Panel-Expanded-${Date.now()}` },
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

    await sidePanel.getByLabel("Expand Side Panel").click();
    await expect(page.getByTestId("side-panel-expanded-overlay")).toBeVisible();
    await expect(sidePanel.getByLabel("Restore Side Panel width")).toBeVisible();
    await expect(page.getByTestId("side-panel-resizer")).toHaveCount(0);
    await expect(page.getByTestId("workspace-main-card")).not.toBeVisible();
    await expect(page.getByTestId("workspace-main-card")).toHaveAttribute("aria-hidden", "true");
    await expect(page.getByTestId("workspace-main-card")).toHaveAttribute("inert", "");

    const workspaceStackBox = await page.getByTestId("workspace-main-panel-stack").boundingBox();
    const expandedSidePanelBox = await sidePanel.boundingBox();
    expect(workspaceStackBox).not.toBeNull();
    expect(expandedSidePanelBox).not.toBeNull();
    expect(Math.abs(Math.round(expandedSidePanelBox!.x - workspaceStackBox!.x))).toBeLessThanOrEqual(2);
    expect(Math.abs(Math.round((workspaceStackBox!.x + workspaceStackBox!.width) - (expandedSidePanelBox!.x + expandedSidePanelBox!.width)))).toBeLessThanOrEqual(2);

    await sidePanel.getByLabel("Restore Side Panel width").click();
    await expect(page.getByTestId("side-panel-expanded-overlay")).toHaveCount(0);
    await expect(page.getByTestId("side-panel-resizer")).toBeVisible();
    await expect(page.getByTestId("workspace-main-card")).toBeVisible();
    await expect(page.getByTestId("workspace-main-card")).not.toHaveAttribute("aria-hidden", "true");
    await expect(page.getByTestId("workspace-main-card")).not.toHaveAttribute("inert", "");

    await sidePanel.getByLabel("Expand Side Panel").click();
    await expect(page.getByTestId("side-panel-expanded-overlay")).toBeVisible();
    await sidePanel.getByLabel("Close Side Panel").click();
    await expect(sidePanel).toHaveCount(0);
    await expect(page.getByTestId("workspace-main-card")).toBeVisible();
    await expect(page.getByTestId("workspace-main-card")).not.toHaveAttribute("aria-hidden", "true");
    await expect(page.getByTestId("workspace-main-card")).not.toHaveAttribute("inert", "");
  });

  test("opens a Browser side panel tab with URL navigation controls", async ({ page }) => {
    await installBrowserDesktopStub(page);
    const browserSettings = await page.request.patch("/api/instance/settings/browser", {
      data: { enabled: true, openLinksIn: "built_in" },
    });
    expect(browserSettings.ok(), await browserSettings.text()).toBe(true);
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Global-Side-Panel-Browser-${Date.now()}` },
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
      Object.assign(element, { __rudderKeepaliveMarker: "browser-guest-1" });
    });
    const browserTabId = await webview.getAttribute("data-browser-tab-id");
    expect(browserTabId).toBeTruthy();
    const stableWebview = sidePanel.locator(`webview[data-browser-tab-id="${browserTabId}"]`);

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

    await sidePanel.getByLabel("Open new browser tab").click();
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(2);
    await expect(sidePanel.getByTestId("chat-side-panel-tab").last()).toContainText("New tab");

    await sidePanel.getByLabel("Close Side Panel").click();
    await expect(page.getByTestId("chat-side-panel")).toBeHidden();
    await expect(stableWebview).toHaveCount(1);
    await expect.poll(() => stableWebview.evaluate((element) => (
      element as HTMLElement & { __rudderKeepaliveMarker?: string }
    ).__rudderKeepaliveMarker)).toBe("browser-guest-1");
    await expect(page.getByTestId("chat-side-panel-trigger")).toHaveAttribute("aria-pressed", "false");
    await page.getByTestId("chat-side-panel-trigger").click();
    await expect(page.getByTestId("chat-side-panel")).toBeVisible();
    await expect.poll(() => stableWebview.evaluate((element) => (
      element as HTMLElement & { __rudderKeepaliveMarker?: string }
    ).__rudderKeepaliveMarker)).toBe("browser-guest-1");
  });

  test("scales the Side Panel proportionally when the app width changes", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Global-Side-Panel-Proportional-${Date.now()}` },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByTestId("global-side-panel-trigger").click();
    const sidePanel = page.getByTestId("chat-side-panel");
    await expect(sidePanel).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => Math.round((await sidePanel.boundingBox())?.width ?? 0)).toBe(420);

    await page.setViewportSize({ width: 1200, height: 900 });
    await expect.poll(async () => Math.round((await sidePanel.boundingBox())?.width ?? 0)).toBe(350);

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(async () => Math.round((await sidePanel.boundingBox())?.width ?? 0)).toBe(420);
  });
});
