import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { buildLibraryFileMentionMarkdown } from "../../packages/shared/src/index.ts";
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

async function openGlobalLibraryFileInSidePanel(page: Page, fileName: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId("side-panel-hover-edge").hover();
  await page.getByTestId("global-side-panel-trigger").click({ force: true });
  const sidePanel = page.getByTestId("chat-side-panel");
  await expect(sidePanel.getByTestId("chat-side-panel-empty-state")).toBeVisible({ timeout: 15_000 });
  await sidePanel.getByTestId("chat-side-panel-empty-library-target").click();
  const directoryView = sidePanel.getByTestId("chat-side-panel-library-directory-view");
  await expect(directoryView).toBeVisible();
  await directoryView.getByRole("button", { name: fileName, exact: true }).click();
  await expect(sidePanel.getByTestId("chat-side-panel-library-file-view")).toBeVisible();
  return sidePanel;
}

test.describe("Messenger Saved Views", () => {
  test("keeps exact Side Panel instances in normal groups and supports move, remove, and guarded group actions", async ({ page }, testInfo) => {
    const organization = await createOrganization(page.request, "Messenger-Saved-View-Workflow");
    const filePath = `docs/saved-view-${randomUUID()}.md`;
    const chat = await createHostChatWithFile(page, organization, {
      chatTitle: "Saved view host chat",
      filePath,
    });
    await selectOrganization(page, organization);
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

    const fileName = filePath.split("/").at(-1)!;
    await page.getByRole("link", { name: fileName }).click();
    await expect(page.getByTestId("chat-side-panel-library-file-view")).toBeVisible({ timeout: 15_000 });
    const originalUrl = page.url();

    const keepButton = page.getByTestId("chat-side-panel-keep-in-messenger");
    await expect(keepButton).toBeVisible();
    await keepButton.click();
    await expect(page.getByText("Kept in Messenger")).toBeVisible();
    await expect(page).toHaveURL(originalUrl);

    let directory = await listGroups(page, organization.id);
    expect(directory.groups).toHaveLength(1);
    expect(directory.groups[0]!.entries.filter((entry) => entry.item.type === "saved_view")).toHaveLength(1);
    expect(directory.groups[0]!.entries.some((entry) => entry.itemKey === `chat:${chat.id}`)).toBe(true);

    await keepButton.click();
    await expect.poll(async () => {
      const next = await listGroups(page, organization.id);
      return next.groups[0]?.entries.filter((entry) => entry.item.type === "saved_view").length;
    }).toBe(1);

    await page.getByTestId("chat-side-panel-tab").filter({ hasText: fileName }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Open in new tab" }).click();
    await expect(page.getByTestId("chat-side-panel-tab").filter({ hasText: fileName })).toHaveCount(2);
    await page.getByTestId("chat-side-panel-keep-in-messenger").click();

    await expect.poll(async () => {
      const next = await listGroups(page, organization.id);
      return next.groups[0]?.entries.filter((entry) => entry.item.type === "saved_view").length;
    }).toBe(2);
    directory = await listGroups(page, organization.id);
    const firstGroup = directory.groups[0]!;
    const savedEntries = firstGroup.entries.filter((entry) => entry.item.type === "saved_view");
    expect(savedEntries).toHaveLength(2);
    expect(new Set(savedEntries.map((entry) => (
      entry.item.type === "saved_view" ? entry.item.savedView.targetPayload.viewInstanceId : ""
    ))).size).toBe(2);

    const secondGroupResponse = await page.request.post(`/api/orgs/${organization.id}/messenger/groups`, {
      data: { name: "Review later", icon: "folder::slate" },
    });
    expect(secondGroupResponse.ok(), await secondGroupResponse.text()).toBe(true);
    const secondGroup = await secondGroupResponse.json() as { id: string };

    const firstSavedView = savedEntries[0]!.item.type === "saved_view" ? savedEntries[0]!.item.savedView : null;
    expect(firstSavedView).toBeTruthy();
    await page.goto(`/${organization.issuePrefix}/messenger/saved/${firstSavedView!.id}`);
    await expect(page.getByTestId("messenger-saved-view-workspace")).toContainText(fileName);
    await expect(page.getByTestId("chat-side-panel-library-file-view")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("messenger-saved-view-restored.png"),
      fullPage: true,
    });

    await page.getByTestId("chat-side-panel-keep-in-messenger").click();
    await expect(page.getByText(
      `Already kept in ${firstGroup.name}. Use the Saved View row menu to move or remove it.`,
    )).toBeVisible();
    await page.keyboard.press("Escape");

    const firstGroupSection = page.getByTestId(`messenger-thread-section-custom-group-${firstGroup.id}`);
    const savedViewRowIn = (section: Locator) => (
      section.locator(`a[href$="/messenger/saved/${firstSavedView!.id}"]`).locator("..")
    );
    const firstGroupSavedRow = savedViewRowIn(firstGroupSection);
    await firstGroupSavedRow.hover();
    await firstGroupSavedRow.getByRole("button", { name: `Saved View actions for ${fileName}` }).click();
    await page.getByRole("menuitem", { name: "Move to group" }).hover();
    await page.getByRole("menuitem", { name: "Review later" }).click();
    await expect.poll(async () => {
      const next = await listGroups(page, organization.id);
      return next.groups.find((group) => group.id === secondGroup.id)?.entries.some(
        (entry) => entry.item.type === "saved_view" && entry.item.savedView.id === firstSavedView!.id,
      );
    }).toBe(true);

    const reviewGroup = page.getByTestId(`messenger-thread-section-custom-group-${secondGroup.id}`);
    const movedRow = savedViewRowIn(reviewGroup);
    await expect(movedRow).toBeVisible();
    await movedRow.hover();
    await reviewGroup.getByRole("button", { name: `Saved View actions for ${fileName}` }).click();
    await page.getByRole("menuitem", { name: "Move to group" }).hover();
    await page.getByRole("menuitem", { name: firstGroup.name }).click();
    await expect.poll(async () => {
      const next = await listGroups(page, organization.id);
      return next.groups.find((group) => group.id === firstGroup.id)?.entries.some(
        (entry) => entry.item.type === "saved_view" && entry.item.savedView.id === firstSavedView!.id,
      );
    }).toBe(true);

    await firstGroupSection.getByRole("button", { name: "Group actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Separate items" })).toHaveAttribute("data-disabled", "");
    await page.keyboard.press("Escape");
    const deleteBlocked = await page.request.delete(`/api/orgs/${organization.id}/messenger/groups/${firstGroup.id}`);
    expect(deleteBlocked.status()).toBe(409);

    const savedRow = savedViewRowIn(firstGroupSection);
    await savedRow.hover();
    await savedRow.getByRole("button", { name: `Saved View actions for ${fileName}` }).click();
    await page.getByRole("menuitem", { name: "Remove from Messenger" }).click();
    await expect.poll(async () => {
      const next = await listGroups(page, organization.id);
      return next.groups.find((group) => group.id === firstGroup.id)?.entries.some(
        (entry) => entry.item.type === "saved_view" && entry.item.savedView.id === firstSavedView!.id,
      );
    }).toBe(false);
    expect((await listGroups(page, organization.id)).groups.some((group) => group.id === firstGroup.id)).toBe(true);
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
    await page.getByTestId("chat-side-panel-keep-in-messenger").click();

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
    await page.getByTestId("chat-side-panel-keep-in-messenger").click();
    await expect(page.getByText("Kept in Messenger")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/messenger/issues/${issue.identifier}$`));

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
    await keepButton.click();
    await page.getByRole("menuitem", { name: "Global research" }).click();
    await expect(page.getByText("Kept in Messenger")).toBeVisible();

    await expect.poll(async () => {
      const directory = await listGroups(page, organization.id);
      const savedEntries = directory.groups.find((candidate) => candidate.id === group.id)
        ?.entries.filter((entry) => entry.item.type === "saved_view") ?? [];
      return {
        groupCount: directory.groups.length,
        savedCount: savedEntries.length,
        filePath: savedEntries[0]?.item.type === "saved_view"
          ? savedEntries[0].item.savedView.targetPayload.filePath
          : null,
      };
    }).toEqual({ groupCount: 1, savedCount: 1, filePath });

    await page.goto(`/${organization.issuePrefix}/messenger`);
    const groupSection = page.getByTestId(`messenger-thread-section-custom-group-${group.id}`);
    const savedRow = groupSection.locator('[data-testid^="messenger-saved-view-"]').filter({ hasText: fileName });
    await expect(savedRow).toBeVisible();
    await expect(page.getByTestId("messenger-saved-views-section")).toHaveCount(0);
    await expect(savedRow.locator('[data-testid$="-unread-badge"]')).toHaveCount(0);
  });

  test("explains that a global Side Panel view needs an existing group", async ({ page }) => {
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
    await expect(page.getByText("No groups yet. Keep a view from a Chat or Issue first to create one.")).toBeVisible();
    expect((await listGroups(page, organization.id)).groups).toHaveLength(0);
  });
});
