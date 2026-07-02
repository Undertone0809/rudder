import { expect, test } from "@playwright/test";
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

function buildLibraryFileMentionHref(filePath: string) {
  return `library-file://file?p=${encodeURIComponent(filePath)}`;
}

function buildLibraryDirectoryMentionHref(directoryPath: string) {
  return `library-directory://directory?p=${encodeURIComponent(directoryPath)}`;
}

test.describe("Chat Side Panel", () => {
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
        `Read [${libraryFileName}](${buildLibraryFileMentionHref(libraryFilePath)}) beside this chat.`,
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
    await expect(sidePanel.getByLabel("Edit issue")).toBeVisible();
    await expect(sidePanel.getByLabel("Close Side Panel")).toBeVisible();
    await expect(sidePanel.getByLabel("Expand Side Panel")).toBeVisible();
    await expect(sidePanel.getByRole("link", { name: "Full page" })).toHaveCount(0);

    await sidePanel.locator('button:has([data-slot="issue-status-icon"])').first().click();
    await page.getByRole("menuitemradio", { name: "Done" }).click();
    await expect(sidePanel).toContainText("done");

    await sidePanel.getByLabel("Edit issue").click();
    await sidePanel.getByLabel("Issue title").fill("Reference issue target edited");
    await sidePanel.getByLabel("Issue description").fill("Edited from the chat detail panel.");
    await sidePanel.getByRole("button", { name: "Save" }).click();
    await expect(sidePanel).toContainText("Reference issue target edited");
    await expect(sidePanel).toContainText("Edited from the chat detail panel.");

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
    await expect(sidePanel).toContainText("Issue");
    await expect(page.getByTestId("side-panel-resizer")).toBeVisible();
    await expect(sidePanel.locator(".workspace-main-card")).toHaveCount(2);

    const mainCardBox = await page.getByTestId("workspace-main-card").boundingBox();
    const resizerBox = await page.getByTestId("side-panel-resizer").boundingBox();
    const sidePanelBox = await sidePanel.boundingBox();
    expect(mainCardBox).not.toBeNull();
    expect(resizerBox).not.toBeNull();
    expect(sidePanelBox).not.toBeNull();
    expect(Math.round(resizerBox!.x - (mainCardBox!.x + mainCardBox!.width))).toBeGreaterThanOrEqual(0);
    expect(Math.round(sidePanelBox!.x - (resizerBox!.x + resizerBox!.width))).toBeGreaterThanOrEqual(0);

    await sidePanel.getByLabel("Expand Side Panel").click();
    await expect(sidePanel.getByLabel("Restore Side Panel width")).toBeVisible();
    await sidePanel.getByLabel("Restore Side Panel width").click();
    await expect(sidePanel.getByLabel("Expand Side Panel")).toBeVisible();

    await sidePanel.getByRole("button", { name: /Issue/ }).click();
    await expect(sidePanel).toContainText("Open an issue link");
    await expect(sidePanel.getByRole("link", { name: "Full page" })).toHaveCount(0);

    await sidePanel.getByTestId("chat-side-panel-add-tab").click();
    await expect(sidePanel.getByTestId("chat-side-panel-add-menu")).toHaveCount(0);
    await expect(sidePanel).toContainText("Open a panel");
    await expect(sidePanel).toContainText("Browser");
    await expect(sidePanel).toContainText("Library");
    await expect(sidePanel).toContainText("Issue");

    await sidePanel.getByRole("button", { name: /Library/ }).click();
    await expect(sidePanel).toContainText("Library root");
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(2);

    const collapseStart = await page.getByTestId("side-panel-resizer").boundingBox();
    expect(collapseStart).not.toBeNull();
    await page.mouse.move(collapseStart!.x + collapseStart!.width / 2, collapseStart!.y + collapseStart!.height / 2);
    await page.mouse.down();
    await page.mouse.move(page.viewportSize()!.width - 16, collapseStart!.y + collapseStart!.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(sidePanel).toHaveCount(0);
    await page.getByTestId("side-panel-hover-edge").hover();
    await expect(page.getByTestId("global-side-panel-trigger")).toBeVisible();
  });

  test("opens a Browser side panel tab with URL navigation controls", async ({ page }) => {
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
    await expect(page.getByTestId("chat-side-panel-trigger")).toHaveAttribute("aria-label", "Close Side Panel");
    await expect(page.getByTestId("chat-side-panel-trigger")).toHaveAttribute("aria-pressed", "true");

    await sidePanel.getByRole("button", { name: /Browser/ }).click();
    await expect(sidePanel.getByTestId("chat-side-panel-browser-view")).toBeVisible();
    await expect(sidePanel).toContainText("Start browsing");

    const encodedPage = encodeURIComponent("<!doctype html><title>Rudder Browser Proof</title><main>Browser panel proof</main>");
    const targetUrl = `data:text/html,${encodedPage}`;
    await sidePanel.getByLabel("Browser URL").fill(targetUrl);
    await sidePanel.getByLabel("Browser URL").press("Enter");

    const webview = sidePanel.getByTestId("chat-side-panel-browser-webview");
    await expect(webview).toHaveAttribute("src", targetUrl);
    await expect(sidePanel.getByTestId("chat-side-panel-browser-start")).toHaveCount(0);
    await expect(sidePanel.getByTestId("chat-side-panel-tab").first()).toContainText("Data URL");

    await sidePanel.getByLabel("Open new browser tab").click();
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(2);
    await expect(sidePanel.getByTestId("chat-side-panel-tab").last()).toContainText("New tab");

    await page.getByTestId("chat-side-panel-trigger").click();
    await expect(page.getByTestId("chat-side-panel")).toHaveCount(0);
    await expect(page.getByTestId("chat-side-panel-trigger")).toHaveAttribute("aria-pressed", "false");
  });
});
