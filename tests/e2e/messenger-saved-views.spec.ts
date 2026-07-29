import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import {
  buildAutomationMentionHref,
  buildLibraryFileMentionMarkdown,
} from "../../packages/shared/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

function uniqueIssuePrefix() {
  return `S${randomUUID().replaceAll("-", "").slice(0, 9).toUpperCase()}`;
}

async function createOrganization(request: APIRequestContext, label: string) {
  const response = await request.post("/api/orgs", {
    data: { name: `${label}-${Date.now()}`, issuePrefix: uniqueIssuePrefix() },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<{ id: string; issuePrefix: string }>;
}

async function createHostChatWithFile(page: Page, organization: { id: string }, input: {
  chatTitle: string;
  filePath: string;
}) {
  await createE2EChatAgent(page.request, organization.id, { name: `${input.chatTitle} agent` });
  const fileResponse = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
    data: { filePath: input.filePath, content: `# ${input.chatTitle}\n` },
  });
  expect(fileResponse.ok(), await fileResponse.text()).toBe(true);
  const chatResponse = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: input.chatTitle,
      issueCreationMode: "manual_approval",
      planMode: false,
      initialMessage: { body: "Open the attached work product." },
    },
  });
  expect(chatResponse.ok(), await chatResponse.text()).toBe(true);
  const chat = await chatResponse.json() as { id: string };
  await e2eDb.insert(chatMessages).values({
    id: randomUUID(),
    orgId: organization.id,
    conversationId: chat.id,
    role: "assistant",
    kind: "message",
    status: "completed",
    body: buildLibraryFileMentionMarkdown(input.filePath, input.filePath.split("/").at(-1) ?? input.filePath),
    structuredPayload: null,
    replyingAgentId: null,
    chatTurnId: randomUUID(),
    turnVariant: 0,
  });
  return chat;
}

async function selectOrganization(page: Page, organization: { id: string }) {
  await page.addInitScript((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    window.localStorage.setItem("rudder.messengerThreadOrganizationByOrg", JSON.stringify({ [orgId]: "custom" }));
  }, organization.id);
}

async function installWorkbenchFileLauncherStub(page: Page) {
  await page.addInitScript(() => {
    const fileLocationCalls: Array<{
      filePath: string;
      rootPath: string;
      targetId: string;
    }> = [];
    Object.defineProperty(window, "__rudderWorkbenchFileLocationCalls", {
      configurable: true,
      value: fileLocationCalls,
    });
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: {
        listWorkspaceLaunchTargets: async () => [
          { id: "cursor", label: "Cursor", kind: "ide" },
          { id: "terminal", label: "Terminal", kind: "terminal" },
          { id: "finder", label: "Finder", kind: "folder" },
        ],
        openWorkspaceFileInIde: async () => {},
        openWorkspaceFileLocation: async (
          rootPath: string,
          filePath: string,
          targetId: string,
        ) => {
          fileLocationCalls.push({ rootPath, filePath, targetId });
        },
      },
    });
  });
}

async function listGroups(page: Page, orgId: string) {
  const response = await page.request.get(`/api/orgs/${orgId}/messenger/groups`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<{ groups: Array<{
    id: string;
    name: string;
    entries: Array<{
      itemKey: string;
      item: { type: "thread" } | {
        type: "saved_view";
        savedView: { id: string; targetPayload: { filePath?: string; viewInstanceId: string } };
      };
    }>;
  }> }>;
}

async function keepLooseSavedView(
  page: Page,
  orgId: string,
  input: {
    title: string;
    target:
      | { kind: "browser"; tabId: string; url: string; viewInstanceId: string }
      | { kind: "library_file"; filePath: string; viewInstanceId: string };
  },
) {
  const response = await page.request.post(
    `/api/orgs/${orgId}/messenger/saved-views/keep`,
    {
      data: {
        ...input,
        clientMutationId: randomUUID(),
        placement: { kind: "loose" },
      },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<{
    savedView: { id: string; title: string };
    group: null;
  }>;
}

async function openGlobalLibraryFileInSidePanel(page: Page, fileName: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId("side-panel-hover-edge").hover();
  await page.getByTestId("global-side-panel-trigger").click({ force: true });
  const sidePanel = page.getByTestId("chat-side-panel");
  await expect(sidePanel.getByTestId("chat-side-panel-empty-state")).toBeVisible({ timeout: 15_000 });
  await sidePanel.getByTestId("chat-side-panel-empty-library-target").click();
  await expect(page.locator(
    '[data-testid="library-live-surface"][data-surface="side_panel"][data-active="true"]',
  )).toBeVisible();
  await page.getByRole("button", { name: fileName, exact: true }).click();
  await expect(page.locator(
    '[data-testid="library-live-surface"][data-surface="side_panel"][data-active="true"]',
  )).toBeVisible();
  return sidePanel;
}

test.describe("Messenger Saved Views", () => {
  test("runs a moved Main Automation and opens its linked Messenger chat", async ({ page }) => {
    const organization = await createOrganization(
      page.request,
      "Messenger-Main-Automation",
    );
    const agent = await createE2EChatAgent(page.request, organization.id, {
      name: "Main Automation Agent",
    }) as { id: string };
    const automationResponse = await page.request.post(
      `/api/orgs/${organization.id}/automations`,
      {
        data: {
          title: "Main workbench automation",
          description: "Open the linked chat after a manual run.",
          assigneeAgentId: agent.id,
          priority: "medium",
          outputMode: "chat_output",
        },
      },
    );
    expect(
      automationResponse.ok(),
      await automationResponse.text(),
    ).toBe(true);
    const automation = await automationResponse.json() as {
      id: string;
      title: string;
    };
    const chatResponse = await page.request.post(
      `/api/orgs/${organization.id}/chats`,
      {
        data: {
          title: "Automation workbench host",
          issueCreationMode: "manual_approval",
          planMode: false,
          initialMessage: { body: "Open the Automation." },
        },
      },
    );
    expect(chatResponse.ok(), await chatResponse.text()).toBe(true);
    const chat = await chatResponse.json() as { id: string };
    await e2eDb.insert(chatMessages).values({
      id: randomUUID(),
      orgId: organization.id,
      conversationId: chat.id,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: `Open [${automation.title}](${buildAutomationMentionHref(
        automation.id,
        automation.title,
      )}).`,
      structuredPayload: null,
      replyingAgentId: null,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await selectOrganization(page, organization);
    await page.goto(
      `/${organization.issuePrefix}/messenger/chat/${chat.id}`,
    );
    const assistantMessage = page.getByTestId("chat-assistant-message").last();
    await assistantMessage
      .locator('a[data-mention-kind="automation"]')
      .click();
    await expect(page.getByTestId("automation-detail-shell")).toBeVisible();
    await page.getByTestId("chat-side-panel-keep-in-messenger").click();
    await expect(page.getByText("Moved to Messenger")).toBeVisible();
    await expect(page).toHaveURL(/\/messenger\/saved\/[^/]+$/);
    await expect(page.getByTestId("automation-detail-shell")).toBeVisible();

    await page.getByRole("button", { name: "Run now" }).click();
    await expect(page).toHaveURL(/\/messenger\/chat\/[0-9a-f-]+$/, {
      timeout: 20_000,
    });
  });

  test("moves only the exact Side Panel instance into Main and keeps remove separate from close", async ({ page }, testInfo) => {
    const organization = await createOrganization(page.request, "Messenger-Saved-View-Workflow");
    const filePath = `docs/saved-view-${randomUUID()}.md`;
    const chat = await createHostChatWithFile(page, organization, {
      chatTitle: "Saved view host chat",
      filePath,
    });
    const secondGroupResponse = await page.request.post(`/api/orgs/${organization.id}/messenger/groups`, {
      data: { name: "Review later", icon: "folder::slate" },
    });
    expect(secondGroupResponse.ok(), await secondGroupResponse.text()).toBe(true);
    const secondGroup = await secondGroupResponse.json() as { id: string };
    await selectOrganization(page, organization);
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

    const fileName = filePath.split("/").at(-1)!;
    await page.getByRole("link", { name: fileName }).click();
    await expect(page.getByTestId("library-live-surface")).toHaveAttribute(
      "data-surface",
      "side_panel",
      { timeout: 15_000 },
    );
    const sideTabs = page.getByTestId("chat-side-panel-tab").filter({
      hasText: fileName,
    });
    for (let index = 0; index < 2; index += 1) {
      await sideTabs.last().click({ button: "right" });
      await page.getByRole("menuitem", { name: "Open in new tab" }).click();
    }
    await expect(sideTabs).toHaveCount(3);
    const [leftInstanceId, movedInstanceId, rightInstanceId] =
      await sideTabs.evaluateAll((tabs) => tabs.map(
        (tab) => tab.getAttribute("data-view-instance-id") ?? "",
      ));
    expect(leftInstanceId).toBeTruthy();
    expect(movedInstanceId).toBeTruthy();
    expect(rightInstanceId).toBeTruthy();

    await sideTabs.nth(1).click();
    await page.getByTestId("chat-side-panel-keep-in-messenger").click();
    await expect(page.getByText("Moved to Messenger")).toBeVisible();
    await expect(page).toHaveURL(/\/messenger\/saved\/[^/]+$/);

    const mainWorkbench = page.getByTestId("messenger-main-workbench");
    await expect(mainWorkbench).toBeVisible();
    await expect(mainWorkbench).not.toHaveClass(/workspace-main-card/);
    await expect(mainWorkbench).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(mainWorkbench).not.toHaveCSS("border-radius", "0px");
    await expect(mainWorkbench.getByRole("tablist")).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(mainWorkbench.locator(
      `[role="tab"][data-view-instance-id="${movedInstanceId}"][aria-selected="true"]`,
    )).toBeVisible();
    await expect(page.locator(
      `[data-testid="library-live-surface"][data-surface="workbench"][data-active="true"]`,
    )).toBeVisible();

    await expect(sideTabs).toHaveCount(2);
    await expect(sideTabs.nth(0)).toHaveAttribute(
      "data-view-instance-id",
      leftInstanceId,
    );
    await expect(sideTabs.nth(1)).toHaveAttribute(
      "data-view-instance-id",
      rightInstanceId,
    );
    await expect(sideTabs.nth(1)).toHaveAttribute("aria-selected", "true");

    let directory = await listGroups(page, organization.id);
    expect(directory.groups).toHaveLength(2);
    const firstGroup = directory.groups.find(
      (group) => group.entries.some((entry) => entry.itemKey === `chat:${chat.id}`),
    );
    if (!firstGroup) {
      throw new Error("Expected the auto-created host group");
    }
    expect(firstGroup.entries.some((entry) => entry.itemKey === `chat:${chat.id}`)).toBe(true);
    const savedEntry = firstGroup.entries.find(
      (entry) => entry.item.type === "saved_view",
    )?.item;
    if (!savedEntry || savedEntry.type !== "saved_view") {
      throw new Error("Expected the moved Saved View");
    }
    expect(savedEntry.savedView.targetPayload.viewInstanceId).toBe(
      movedInstanceId,
    );

    await page.screenshot({
      path: testInfo.outputPath("messenger-main-exact-library-move.png"),
      fullPage: true,
    });

    const firstGroupSection = page.getByTestId(`messenger-thread-section-custom-group-${firstGroup.id}`);
    const savedViewRowIn = (section: Locator) => (
      section.locator(`a[href$="/messenger/saved/${savedEntry.savedView.id}"]`).locator("..")
    );
    const firstGroupSavedRow = savedViewRowIn(firstGroupSection);
    await firstGroupSavedRow.hover();
    await firstGroupSavedRow.getByRole("button", { name: `Saved View actions for ${fileName}` }).click();
    await page.getByRole("menuitem", { name: "Move to group" }).hover();
    await page.getByRole("menuitem", { name: "Review later" }).click();
    await expect.poll(async () => {
      const next = await listGroups(page, organization.id);
      return next.groups.find((group) => group.id === secondGroup.id)?.entries.some(
        (entry) => entry.item.type === "saved_view" && entry.item.savedView.id === savedEntry.savedView.id,
      );
    }).toBe(true);

    const reviewGroup = page.getByTestId(`messenger-thread-section-custom-group-${secondGroup.id}`);
    const movedRow = savedViewRowIn(reviewGroup);
    await expect(movedRow).toBeVisible();

    await mainWorkbench.getByRole("button", {
      name: `Close ${fileName} tab`,
    }).click();
    await expect(mainWorkbench.getByRole("tab")).toHaveCount(0);
    await expect(movedRow).toBeVisible();
    await movedRow.getByRole("link").click();
    await expect(page).toHaveURL(
      new RegExp(`/messenger/saved/${savedEntry.savedView.id}$`),
    );
    await expect(mainWorkbench.locator(
      `[role="tab"][data-view-instance-id="${movedInstanceId}"][aria-selected="true"]`,
    )).toBeVisible();
    await page.reload();
    await expect(mainWorkbench.locator(
      `[role="tab"][data-view-instance-id="${movedInstanceId}"][aria-selected="true"]`,
    )).toBeVisible();

    const refreshedMovedRow = savedViewRowIn(reviewGroup);
    await refreshedMovedRow.hover();
    await refreshedMovedRow.getByRole("button", {
      name: `Saved View actions for ${fileName}`,
    }).click();
    await page.getByRole("menuitem", { name: "Remove from Messenger" }).click();
    await expect.poll(async () => {
      const next = await listGroups(page, organization.id);
      return next.groups.find((group) => group.id === secondGroup.id)?.entries.some(
        (entry) => entry.item.type === "saved_view" && entry.item.savedView.id === savedEntry.savedView.id,
      );
    }).toBe(false);
    await expect(page).toHaveURL(/\/messenger\/workbench$/);
    await expect(mainWorkbench.locator(
      `[role="tab"][data-view-instance-id="${movedInstanceId}"][aria-selected="true"]`,
    )).toBeVisible();
    await mainWorkbench.getByRole("button", {
      name: `Close ${fileName} tab`,
    }).click();
    await expect(page).toHaveURL(
      new RegExp(`/messenger/chat/${chat.id}$`),
    );
    expect((await listGroups(page, organization.id)).groups.some(
      (group) => group.id === firstGroup.id,
    )).toBe(true);
  });

  test("uses an existing host group instead of creating another one", async ({ page }) => {
    const organization = await createOrganization(page.request, "Messenger-Saved-View-Existing-Group");
    const filePath = `docs/existing-group-${randomUUID()}.md`;
    const chat = await createHostChatWithFile(page, organization, {
      chatTitle: "Existing group host chat",
      filePath,
    });
    const groupResponse = await page.request.post(`/api/orgs/${organization.id}/messenger/groups`, {
      data: { name: "Existing work package" },
    });
    expect(groupResponse.ok(), await groupResponse.text()).toBe(true);
    const group = await groupResponse.json() as { id: string };
    const assignResponse = await page.request.post(`/api/orgs/${organization.id}/messenger/groups/${group.id}/entries`, {
      data: { itemKey: `chat:${chat.id}` },
    });
    expect(assignResponse.ok(), await assignResponse.text()).toBe(true);

    await selectOrganization(page, organization);
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);
    await page.getByRole("link", { name: filePath.split("/").at(-1)! }).click();
    const movedInstanceId = await page.locator(
      '[data-testid="chat-side-panel-tab"][aria-selected="true"]',
    ).getAttribute("data-view-instance-id");
    expect(movedInstanceId).toBeTruthy();
    await page.getByTestId("chat-side-panel-keep-in-messenger").click();
    await expect(page.getByText("Moved to Messenger")).toBeVisible();
    await expect(page).toHaveURL(/\/messenger\/saved\/[^/]+$/);
    await expect(page.locator(
      `[data-testid="messenger-main-workbench"] [role="tab"][data-view-instance-id="${movedInstanceId}"]`,
    )).toBeVisible();

    await expect.poll(async () => {
      const next = await listGroups(page, organization.id);
      return next.groups[0]?.entries.filter((entry) => entry.item.type === "saved_view").length;
    }).toBe(1);
    const directory = await listGroups(page, organization.id);
    expect(directory.groups).toHaveLength(1);
    expect(directory.groups[0]!.id).toBe(group.id);
    expect(directory.groups[0]!.entries.filter((entry) => entry.item.type === "saved_view")).toHaveLength(1);
  });

  test("resolves an Issue identifier to its UUID before auto-grouping a kept view", async ({ page }) => {
    const organization = await createOrganization(page.request, "Messenger-Saved-View-Issue-Anchor");
    await createE2EChatAgent(page.request, organization.id, { name: "Issue anchor agent" });
    const filePath = `issue-anchor-${randomUUID()}.md`;
    const fileName = filePath.split("/").at(-1)!;
    const fileResponse = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: { filePath, content: "# Issue anchor\n" },
    });
    expect(fileResponse.ok(), await fileResponse.text()).toBe(true);
    const issueResponse = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Anchor a Side Panel view by issue identifier",
        description: "The visible route uses an identifier while Saved View placement stores the UUID.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueResponse.ok(), await issueResponse.text()).toBe(true);
    const issue = await issueResponse.json() as { id: string; identifier: string };
    const followResponse = await page.request.post(`/api/issues/${issue.id}/follow`);
    expect(followResponse.ok(), await followResponse.text()).toBe(true);

    await selectOrganization(page, organization);
    const issueRoute = `/${organization.issuePrefix}/messenger/issues/${issue.identifier}`;
    await page.goto(issueRoute);
    await expect(page.locator("#main-content").getByRole("heading", {
      name: "Anchor a Side Panel view by issue identifier",
    })).toBeVisible({ timeout: 15_000 });
    await openGlobalLibraryFileInSidePanel(page, fileName);
    const movedInstanceId = await page.locator(
      '[data-testid="chat-side-panel-tab"][aria-selected="true"]',
    ).getAttribute("data-view-instance-id");
    expect(movedInstanceId).toBeTruthy();
    await page.getByTestId("chat-side-panel-keep-in-messenger").click();
    await expect(page.getByText("Moved to Messenger")).toBeVisible();
    await expect(page).toHaveURL(/\/messenger\/saved\/[^/]+$/);
    await expect(page.locator(
      `[data-testid="messenger-main-workbench"] [role="tab"][data-view-instance-id="${movedInstanceId}"]`,
    )).toBeVisible();

    await expect.poll(async () => {
      const directory = await listGroups(page, organization.id);
      const group = directory.groups[0];
      return {
        groupCount: directory.groups.length,
        hasIssueAnchor: group?.entries.some((entry) => entry.itemKey === `issue:${issue.id}`) ?? false,
        savedCount: group?.entries.filter((entry) => entry.item.type === "saved_view").length ?? 0,
      };
    }).toEqual({ groupCount: 1, hasIssueAnchor: true, savedCount: 1 });
  });

  test("keeps a truly global unsaved Side Panel target in a chosen existing group", async ({ page }) => {
    const organization = await createOrganization(page.request, "Messenger-Saved-View-Global-Chooser");
    const filePath = `global-chooser-${randomUUID()}.md`;
    const fileName = filePath.split("/").at(-1)!;
    const fileResponse = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: { filePath, content: "# Global chooser\n" },
    });
    expect(fileResponse.ok(), await fileResponse.text()).toBe(true);
    const groupResponse = await page.request.post(`/api/orgs/${organization.id}/messenger/groups`, {
      data: { name: "Global research", icon: "folder::emerald" },
    });
    expect(groupResponse.ok(), await groupResponse.text()).toBe(true);
    const group = await groupResponse.json() as { id: string };

    await selectOrganization(page, organization);
    await page.goto(`/${organization.issuePrefix}/dashboard`);
    const sidePanel = await openGlobalLibraryFileInSidePanel(page, fileName);
    const keepButton = sidePanel.getByTestId("chat-side-panel-keep-in-messenger");
    const movedInstanceId = await page.locator(
      '[data-testid="chat-side-panel-tab"][aria-selected="true"]',
    ).getAttribute("data-view-instance-id");
    expect(movedInstanceId).toBeTruthy();
    await keepButton.click();
    await page.getByRole("menuitem", { name: "Global research" }).click();
    await expect(page.getByText("Moved to Messenger")).toBeVisible();
    await expect(page).toHaveURL(/\/messenger\/saved\/[^/]+$/);
    await expect(page.locator(
      `[data-testid="messenger-main-workbench"] [role="tab"][data-view-instance-id="${movedInstanceId}"]`,
    )).toBeVisible();
    await expect(page.locator(
      `[data-testid="chat-side-panel-tab"][data-view-instance-id="${movedInstanceId}"]`,
    )).toHaveCount(0);

    await expect.poll(async () => {
      const directory = await listGroups(page, organization.id);
      const savedEntries = directory.groups.find((candidate) => candidate.id === group.id)
        ?.entries.filter((entry) => entry.item.type === "saved_view") ?? [];
      return {
        groupCount: directory.groups.length,
        savedCount: savedEntries.length,
        viewInstanceId: savedEntries[0]?.item.type === "saved_view"
          ? savedEntries[0].item.savedView.targetPayload.viewInstanceId
          : null,
      };
    }).toEqual({
      groupCount: 1,
      savedCount: 1,
      viewInstanceId: movedInstanceId,
    });

    const savedView = (await listGroups(page, organization.id)).groups[0]?.entries.find(
      (entry) => entry.item.type === "saved_view",
    )?.item;
    if (!savedView || savedView.type !== "saved_view") {
      throw new Error("Expected the chosen Saved View");
    }
    const groupSection = page.getByTestId(`messenger-thread-section-custom-group-${group.id}`);
    const savedRow = groupSection.locator(
      `a[href$="/messenger/saved/${savedView.savedView.id}"]`,
    ).locator("..");
    await expect(savedRow).toBeVisible();
    await expect(savedRow).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("messenger-saved-views-section")).toHaveCount(0);
    await expect(savedRow.locator('[data-testid$="-unread-badge"]')).toHaveCount(0);

    await page.getByRole("link", { name: "New chat" }).click();
    await expect(page).toHaveURL(/\/messenger\/chat$/);
    await expect(savedRow).toHaveAttribute("data-active", "false");
    await expect(savedRow.locator("a")).not.toHaveAttribute("aria-current", "page");
  });

  test("moves a Library Saved View through loose placement without replacing its active Main runtime", async ({ page }) => {
    const organization = await createOrganization(page.request, "Messenger-Saved-View-Loose-Lifecycle");
    const libraryFilePath = `loose/library-${randomUUID()}.md`;
    const libraryTitle = "Loose library document";
    const browserTitle = "Loose browser reference";
    const libraryViewInstanceId = `library-${randomUUID()}`;
    const fileResponse = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: { filePath: libraryFilePath, content: "# Loose library document\n" },
    });
    expect(fileResponse.ok(), await fileResponse.text()).toBe(true);
    const groupResponse = await page.request.post(`/api/orgs/${organization.id}/messenger/groups`, {
      data: { name: "Research package", icon: "folder::emerald" },
    });
    expect(groupResponse.ok(), await groupResponse.text()).toBe(true);
    const group = await groupResponse.json() as { id: string };
    const library = await keepLooseSavedView(page, organization.id, {
      title: libraryTitle,
      target: {
        kind: "library_file",
        filePath: libraryFilePath,
        viewInstanceId: libraryViewInstanceId,
      },
    });
    const browser = await keepLooseSavedView(page, organization.id, {
      title: browserTitle,
      target: {
        kind: "browser",
        tabId: `browser-${randomUUID()}`,
        url: "https://example.com/research",
        viewInstanceId: `browser-${randomUUID()}`,
      },
    });
    const groupLibraryResponse = await page.request.post(
      `/api/orgs/${organization.id}/messenger/groups/${group.id}/entries`,
      { data: { itemKey: `saved-view:${library.savedView.id}` } },
    );
    expect(groupLibraryResponse.ok(), await groupLibraryResponse.text()).toBe(true);

    await selectOrganization(page, organization);
    await installWorkbenchFileLauncherStub(page);
    await page.goto(`/${organization.issuePrefix}/messenger/workbench`);

    const groupSection = page.getByTestId(`messenger-thread-section-custom-group-${group.id}`);
    const groupedLibraryRow = groupSection.locator(
      `[data-messenger-saved-view-id="${library.savedView.id}"]`,
    );
    const looseBrowserRow = page.locator(
      `[data-messenger-saved-view-id="${browser.savedView.id}"]`,
    );
    await expect(groupedLibraryRow).toBeVisible({ timeout: 15_000 });
    await expect(looseBrowserRow).toBeVisible();
    await groupedLibraryRow.locator("a").click();
    const libraryMainTab = page.locator(
      `[data-testid="messenger-main-workbench"] [role="tab"][data-view-instance-id="${libraryViewInstanceId}"]`,
    );
    await expect(libraryMainTab).toBeVisible();
    await expect(libraryMainTab).toHaveAttribute("aria-selected", "true");
    const activeLibrarySurface = page.locator(
      '[data-testid="library-live-surface"][data-surface="workbench"][data-active="true"]',
    );
    await expect(activeLibrarySurface).toHaveAttribute("data-target-kind", "library_file");
    const fileOpenSelector = activeLibrarySurface.getByTestId(
      "library-live-surface-file-open-selector",
    );
    await expect(fileOpenSelector.getByRole("button", {
      name: "Open file options",
    })).toBeVisible();
    await fileOpenSelector.getByRole("button", {
      name: "Open file options",
    }).click();
    await expect(page.getByRole("menuitem", { name: "Default app" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Cursor" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Terminal" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Finder" }).click();
    await expect.poll(async () => page.evaluate(() => (
      (
        window as typeof window & {
          __rudderWorkbenchFileLocationCalls?: Array<{
            filePath: string;
            rootPath: string;
            targetId: string;
          }>;
        }
      ).__rudderWorkbenchFileLocationCalls ?? []
    ))).toEqual([
      expect.objectContaining({
        filePath: libraryFilePath,
        targetId: "finder",
      }),
    ]);
    await activeLibrarySurface.evaluate((surface) => {
      surface.dataset.runtimeIdentity = "preserve-across-placement";
    });

    const groupedDragHandleBox = await groupedLibraryRow
      .getByRole("button", { name: `Drag ${libraryTitle}` })
      .boundingBox();
    const initialLooseBrowserBox = await looseBrowserRow.boundingBox();
    expect(groupedDragHandleBox).not.toBeNull();
    expect(initialLooseBrowserBox).not.toBeNull();
    await page.mouse.move(
      groupedDragHandleBox!.x + groupedDragHandleBox!.width / 2,
      groupedDragHandleBox!.y + groupedDragHandleBox!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      initialLooseBrowserBox!.x + initialLooseBrowserBox!.width / 2,
      initialLooseBrowserBox!.y + 4,
      { steps: 12 },
    );
    await page.mouse.up();

    const looseLibraryRow = page.locator(
      `[data-messenger-saved-view-id="${library.savedView.id}"]`,
    );
    await expect(looseLibraryRow).toBeVisible();
    await expect(looseBrowserRow).toBeVisible();
    await expect(libraryMainTab).toHaveAttribute("aria-selected", "true");
    await expect(activeLibrarySurface).toHaveAttribute(
      "data-runtime-identity",
      "preserve-across-placement",
    );
    await expect.poll(async () => (
      (await listGroups(page, organization.id)).groups
        .find((candidate) => candidate.id === group.id)
        ?.entries.some((entry) => entry.itemKey === `saved-view:${library.savedView.id}`)
    )).toBe(false);

    const initialLibraryBox = await looseLibraryRow.boundingBox();
    const initialBrowserBox = await looseBrowserRow.boundingBox();
    expect(initialLibraryBox).not.toBeNull();
    expect(initialBrowserBox).not.toBeNull();
    const rowToMove = initialLibraryBox!.y < initialBrowserBox!.y
      ? looseBrowserRow
      : looseLibraryRow;
    const rowToMoveTitle = initialLibraryBox!.y < initialBrowserBox!.y
      ? browserTitle
      : libraryTitle;
    const targetRow = rowToMoveTitle === libraryTitle
      ? looseBrowserRow
      : looseLibraryRow;
    const dragHandleBox = await rowToMove
      .getByRole("button", { name: `Drag ${rowToMoveTitle}` })
      .boundingBox();
    const targetRowBox = await targetRow.boundingBox();
    expect(dragHandleBox).not.toBeNull();
    expect(targetRowBox).not.toBeNull();
    await page.mouse.move(
      dragHandleBox!.x + dragHandleBox!.width / 2,
      dragHandleBox!.y + dragHandleBox!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      targetRowBox!.x + targetRowBox!.width / 2,
      targetRowBox!.y + 4,
      { steps: 12 },
    );
    await page.mouse.up();

    const reorderedLibraryBox = await looseLibraryRow.boundingBox();
    const reorderedBrowserBox = await looseBrowserRow.boundingBox();
    expect(reorderedLibraryBox).not.toBeNull();
    expect(reorderedBrowserBox).not.toBeNull();
    expect(
      rowToMoveTitle === libraryTitle
        ? reorderedLibraryBox!.y < reorderedBrowserBox!.y
        : reorderedBrowserBox!.y < reorderedLibraryBox!.y,
    ).toBe(true);

    await looseLibraryRow.hover();
    await looseLibraryRow.getByRole("button", {
      name: `Saved View actions for ${libraryTitle}`,
    }).click();
    await page.getByRole("menuitem", { name: "Move to group" }).hover();
    await page.getByRole("menuitem", { name: "Research package" }).click();
    await expect(groupSection.locator(
      `[data-messenger-saved-view-id="${library.savedView.id}"]`,
    )).toBeVisible();
    await expect(looseBrowserRow).toBeVisible();
    await expect(libraryMainTab).toHaveAttribute("aria-selected", "true");
    await expect(activeLibrarySurface).toHaveAttribute(
      "data-runtime-identity",
      "preserve-across-placement",
    );

    await page.reload();
    await expect(groupSection.locator(
      `[data-messenger-saved-view-id="${library.savedView.id}"]`,
    )).toBeVisible({ timeout: 15_000 });
    await expect(looseBrowserRow).toBeVisible();
  });

  test("keeps a global Side Panel view loose when no groups exist", async ({ page }) => {
    const organization = await createOrganization(page.request, "Messenger-Saved-View-No-Group");
    const filePath = `no-group-${randomUUID()}.md`;
    const fileName = filePath.split("/").at(-1)!;
    const fileResponse = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: { filePath, content: "# no group\n" },
    });
    expect(fileResponse.ok(), await fileResponse.text()).toBe(true);

    await selectOrganization(page, organization);
    await page.goto(`/${organization.issuePrefix}/dashboard`);
    const sidePanel = await openGlobalLibraryFileInSidePanel(page, fileName);
    const keepButton = sidePanel.getByTestId("chat-side-panel-keep-in-messenger");
    await keepButton.click();
    await page.getByRole("menuitem", { name: "Messenger sidebar" }).click();
    await expect(page.getByText("Moved to Messenger", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/messenger\/saved\/[^/]+$/);
    expect((await listGroups(page, organization.id)).groups).toHaveLength(0);
    await expect(page.locator(`[data-messenger-saved-view-id]`).filter({ hasText: fileName })).toBeVisible();
    await page.reload();
    await expect(page.locator(`[data-messenger-saved-view-id]`).filter({ hasText: fileName })).toBeVisible();
  });
});
