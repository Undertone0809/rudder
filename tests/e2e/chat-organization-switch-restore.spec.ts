import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

type TestOrganization = {
  id: string;
  issuePrefix: string;
  name: string;
  urlKey?: string | null;
};

type ChatFixture = {
  fileContentToken: string;
  fileName: string;
  filePath: string;
  id: string;
  messageToken: string;
  title: string;
};

type WorkspaceFileRequest = {
  filePath: string;
  orgId: string;
  url: string;
};

function organizationRouteKey(organization: TestOrganization) {
  return organization.urlKey ?? organization.issuePrefix;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function chatThreadTestId(chatId: string) {
  return `messenger-thread-chat-${chatId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

async function createOrganization(
  request: APIRequestContext,
  name: string,
  issuePrefix: string,
): Promise<TestOrganization> {
  const response = await request.post("/api/orgs", {
    data: { name, issuePrefix },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<TestOrganization>;
}

async function createChatFixture(
  request: APIRequestContext,
  organization: TestOrganization,
  label: string,
): Promise<ChatFixture> {
  const agent = await createE2EChatAgent(request, organization.id, {
    name: `${label} chat agent`,
  }) as { id: string };
  const fileName = `${label.toLowerCase()}-organization-report.md`;
  const filePath = `${label.toLowerCase()}-reports/${fileName}`;
  const fileContentToken = `${label} report content ${randomUUID()}`;
  const fileResponse = await request.post(`/api/orgs/${organization.id}/workspace/file`, {
    data: {
      filePath,
      content: `# ${label} organization report\n\n${fileContentToken}\n`,
    },
  });
  expect(fileResponse.ok(), await fileResponse.text()).toBe(true);
  const libraryFile = await fileResponse.json() as { markdownLink: string };

  const title = `${label} restored chat`;
  const chatResponse = await request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title,
      preferredAgentId: agent.id,
      issueCreationMode: "manual_approval",
      planMode: false,
    },
  });
  expect(chatResponse.ok(), await chatResponse.text()).toBe(true);
  const chat = await chatResponse.json() as { id: string };
  const messageToken = `${label} conversation body ${randomUUID()}`;

  await e2eDb.insert(chatMessages).values({
    id: randomUUID(),
    orgId: organization.id,
    conversationId: chat.id,
    role: "assistant",
    kind: "message",
    status: "completed",
    body: `${messageToken}\n\nOpen ${libraryFile.markdownLink}.`,
    structuredPayload: null,
    replyingAgentId: agent.id,
    chatTurnId: randomUUID(),
    turnVariant: 0,
  });

  return {
    fileContentToken,
    fileName,
    filePath,
    id: chat.id,
    messageToken,
    title,
  };
}

async function switchOrganization(page: Page, organization: TestOrganization) {
  await page.getByRole("button", { name: "Organization menu" }).click();
  const menuItem = page
    .getByRole("menu", { name: "Organization menu" })
    .getByRole("menuitem")
    .filter({ hasText: organization.name });
  await expect(menuItem).toBeVisible({ timeout: 10_000 });
  await menuItem.click();
}

async function expectRestoredChat(
  page: Page,
  organization: TestOrganization,
  chat: ChatFixture,
  otherChat: ChatFixture,
) {
  const routeKey = escapeRegExp(organizationRouteKey(organization));
  await expect(page).toHaveURL(
    new RegExp(`/${routeKey}/messenger/chat/${escapeRegExp(chat.id)}(?:\\?.*)?$`),
    { timeout: 15_000 },
  );
  await expect(page.getByText(chat.messageToken, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(otherChat.messageToken, { exact: true })).toHaveCount(0);

  const composer = page
    .getByTestId("chat-composer-editor-scroll")
    .locator(".rudder-mdxeditor-content")
    .first();
  await expect(composer).toBeVisible();

  const activeThread = page.getByTestId(chatThreadTestId(chat.id));
  await expect(activeThread).toContainText(chat.title);
  await expect(activeThread).toHaveClass(/chat-conversation-active/);
  await expect(page.getByTestId(chatThreadTestId(otherChat.id))).toHaveCount(0);

  const mainCard = page.getByTestId("workspace-main-card");
  await expect(mainCard).toBeVisible();
  await expect(mainCard).not.toHaveClass(/invisible/);
  await expect(mainCard).not.toHaveAttribute("aria-hidden", "true");
  await expect(mainCard).not.toHaveAttribute("inert", "");
}

async function openReportFromChat(page: Page, chat: ChatFixture) {
  const assistantMessage = page
    .getByTestId("chat-assistant-message")
    .filter({ hasText: chat.messageToken })
    .last();
  await expect(assistantMessage).toBeVisible();
  await assistantMessage.getByRole("link", { name: chat.fileName, exact: true }).click();

  const sidePanel = page.getByTestId("chat-side-panel");
  await expect(sidePanel).toBeVisible();
  await expect(sidePanel.getByRole("tab", { name: chat.fileName, exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(sidePanel.getByTestId("chat-side-panel-library-file-view")).toContainText(
    chat.fileContentToken,
  );
  return sidePanel;
}

test("restores each organization chat and Library Side Panel after A -> B -> A switching", async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 900 });

  const suffix = randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
  const organizationA = await createOrganization(
    page.request,
    `Org Switch A ${suffix}`,
    `OSA${suffix}`,
  );
  const organizationB = await createOrganization(
    page.request,
    `Org Switch B ${suffix}`,
    `OSB${suffix}`,
  );
  const chatA = await createChatFixture(page.request, organizationA, "A");
  const chatB = await createChatFixture(page.request, organizationB, "B");
  const workspaceFileRequests: WorkspaceFileRequest[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") return;
    const url = new URL(request.url());
    const match = url.pathname.match(/^\/api\/orgs\/([^/]+)\/workspace\/file(?:\/content)?$/);
    const filePath = url.searchParams.get("path");
    if (!match?.[1] || !filePath) return;
    workspaceFileRequests.push({
      filePath,
      orgId: decodeURIComponent(match[1]),
      url: request.url(),
    });
  });

  await page.goto("/");
  await page.evaluate((organizationId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", organizationId);
  }, organizationA.id);

  await page.goto(`/${organizationRouteKey(organizationA)}/messenger/chat/${chatA.id}`);
  await expectRestoredChat(page, organizationA, chatA, chatB);

  await page.goto(`/${organizationRouteKey(organizationB)}/messenger/chat/${chatB.id}`);
  await expectRestoredChat(page, organizationB, chatB, chatA);

  await switchOrganization(page, organizationA);
  await expectRestoredChat(page, organizationA, chatA, chatB);
  const sidePanelA = await openReportFromChat(page, chatA);
  await sidePanelA.getByRole("button", { name: "Expand Side Panel" }).click();
  await expect(page.getByTestId("side-panel-expanded-overlay")).toBeVisible();
  await expect(page.getByTestId("workspace-main-card")).toHaveClass(/invisible/);
  await expect(page.getByTestId("workspace-main-card")).toHaveAttribute("aria-hidden", "true");

  await switchOrganization(page, organizationB);
  await expectRestoredChat(page, organizationB, chatB, chatA);
  const sidePanelB = await openReportFromChat(page, chatB);
  await expect(sidePanelB).toContainText(chatB.fileContentToken);
  await expect(sidePanelB).not.toContainText(chatA.fileContentToken);

  await switchOrganization(page, organizationA);
  await expectRestoredChat(page, organizationA, chatA, chatB);
  const restoredSidePanelA = page.getByTestId("chat-side-panel");
  await expect(restoredSidePanelA).toBeVisible();
  await expect(page.getByTestId("side-panel-expanded-overlay")).toHaveCount(0);
  await expect(restoredSidePanelA.getByRole("button", { name: "Expand Side Panel" })).toBeVisible();
  await expect(restoredSidePanelA.getByRole("tab", { name: chatA.fileName, exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(restoredSidePanelA).toContainText(chatA.fileContentToken);
  await expect(restoredSidePanelA).not.toContainText(chatB.fileContentToken);

  expect(workspaceFileRequests).toEqual(expect.arrayContaining([
    expect.objectContaining({ orgId: organizationA.id, filePath: chatA.filePath }),
    expect.objectContaining({ orgId: organizationB.id, filePath: chatB.filePath }),
  ]));
  const crossOrganizationFileRequests = workspaceFileRequests.filter(({ filePath, orgId }) => (
    (orgId === organizationA.id && filePath === chatB.filePath)
    || (orgId === organizationB.id && filePath === chatA.filePath)
  ));
  expect(
    crossOrganizationFileRequests,
    `Observed cross-organization workspace file requests: ${JSON.stringify(crossOrganizationFileRequests)}`,
  ).toEqual([]);
});
