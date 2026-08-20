import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  chatConversations,
  chatMessages,
  chatWorkManifestItems,
  createDb,
  heartbeatRuns,
  organizationResources,
  projectResourceAttachments,
} from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_DATABASE_URL } from "./support/e2e-env";
import { expectRightAnchoredSidePanelMotion, sampleSidePanelMotion } from "./support/side-panel-motion";

const e2eDb = createDb(E2E_DATABASE_URL);
const screenshotDir = process.env.RUDDER_CHAT_WORK_MANIFEST_SCREENSHOT_DIR
  ? path.resolve(process.env.RUDDER_CHAT_WORK_MANIFEST_SCREENSHOT_DIR)
  : fs.mkdtempSync(path.join(os.tmpdir(), "rudder-chat-work-manifest-"));
const manifestWaitTimeout = 90_000;

async function gotoChatAndWaitForManifest(
  page: Page,
  issuePrefix: string,
  chatId: string,
) {
  const manifestResponse = page.waitForResponse(
    (response) => (
      new URL(response.url()).pathname === `/api/chats/${chatId}/work-manifest`
      && response.status() < 500
    ),
    { timeout: manifestWaitTimeout },
  ).catch(() => null);
  await page.goto(`/${issuePrefix}/messenger/chat/${chatId}`, { waitUntil: "domcontentloaded" });
  const shelf = page.getByRole("complementary", { name: "Conversation files and links" });
  await expect(shelf).toBeVisible({ timeout: manifestWaitTimeout });
  await expect(page.getByRole("status", { name: "Chat messages loading" })).toHaveCount(0, { timeout: manifestWaitTimeout });
  await Promise.race([manifestResponse, page.waitForTimeout(5_000)]);
  return shelf;
}

test.describe("Chat Work Manifest", () => {
  test.setTimeout(180_000);

  test("shows all six references without a collapse control", async ({ page }) => {
    fs.mkdirSync(screenshotDir, { recursive: true });
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Six-References-${Date.now()}`,
        issuePrefix: `CSR${randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    const agent = await createE2EChatAgent(page.request, organization.id, { name: "Six References Agent" });
    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Six direct references",
        preferredAgentId: agent.id,
        initialMessage: { body: "Show six reference links." },
      },
    });
    expect(chatRes.ok(), await chatRes.text()).toBe(true);
    const chat = await chatRes.json() as { id: string };
    const referenceUrls = Array.from(
      { length: 6 },
      (_, index) => `https://six-reference-${index + 1}.example/research`,
    );
    await e2eDb.insert(chatMessages).values({
      orgId: organization.id,
      conversationId: chat.id,
      role: "assistant",
      body: referenceUrls.join(" "),
      status: "completed",
      replyingAgentId: agent.id,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      localStorage.setItem("rudder.selectedOrganizationId", orgId);
      localStorage.setItem("rudder.theme", "dark");
    }, organization.id);
    await page.setViewportSize({ width: 1440, height: 900 });
    const shelf = await gotoChatAndWaitForManifest(page, organization.issuePrefix, chat.id);
    const references = shelf.getByRole("region", { name: "References" });
    await expect(shelf.getByTestId("chat-work-manifest-section-count-references")).toHaveText("6");
    await expect(references.getByRole("button", { name: "View all 6" })).toHaveCount(0);
    for (const referenceUrl of referenceUrls) {
      await expect(references.locator(`button[title="${new URL(referenceUrl).hostname}"]`)).toBeVisible();
    }
    await page.screenshot({ path: `${screenshotDir}/six-references-direct.png`, fullPage: true });
  });

  test("shows the current Automation name for an unlabeled reference", async ({ page }) => {
    fs.mkdirSync(screenshotDir, { recursive: true });
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Automation-Manifest-${Date.now()}`,
        issuePrefix: `CAM${randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    const agent = await createE2EChatAgent(page.request, organization.id, { name: "Automation Manifest Agent" });
    const automationRes = await page.request.post(`/api/orgs/${organization.id}/automations`, {
      data: {
        title: "Daily standup review",
        description: "Referenced from a Chat message without an embedded title.",
        assigneeAgentId: agent.id,
        priority: "medium",
      },
    });
    expect(automationRes.ok(), await automationRes.text()).toBe(true);
    const automation = await automationRes.json() as { id: string; title: string };

    const chatId = randomUUID();
    const messageId = randomUUID();
    const historicalRowId = randomUUID();
    await e2eDb.insert(chatConversations).values({
      id: chatId,
      orgId: organization.id,
      title: "Automation reference Chat",
      preferredAgentId: agent.id,
    });
    await e2eDb.insert(chatMessages).values({
      id: messageId,
      orgId: organization.id,
      conversationId: chatId,
      role: "assistant",
      status: "completed",
      body: `Recommended automation: [](automation://${automation.id})`,
      replyingAgentId: agent.id,
    });
    await e2eDb.insert(chatWorkManifestItems).values({
      id: historicalRowId,
      orgId: organization.id,
      conversationId: chatId,
      messageId,
      category: "references",
      targetType: "automation",
      targetKey: `automation:${automation.id}`,
      title: "Automation",
      sourceRole: "assistant",
      metadata: { automationId: automation.id },
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      localStorage.setItem("rudder.selectedOrganizationId", orgId);
      localStorage.setItem("rudder.theme", "dark");
    }, organization.id);
    await page.setViewportSize({ width: 1440, height: 900 });
    const shelf = await gotoChatAndWaitForManifest(page, organization.issuePrefix, chatId);
    const automationButton = shelf
      .locator("button[data-target-type='automation']")
      .filter({ hasText: automation.title });
    await expect(automationButton).toHaveCount(1);
    await expect(automationButton).toHaveAttribute("title", automation.title);
    await expect(automationButton.locator("[data-file-icon='automation']")).toBeVisible();
    await expect(shelf.getByText("Automation", { exact: true })).toHaveCount(0);
    const manifestRes = await page.request.get(`/api/chats/${chatId}/work-manifest`);
    expect(manifestRes.ok(), await manifestRes.text()).toBe(true);
    const manifest = await manifestRes.json() as {
      references: Array<{ id: string; title: string }>;
    };
    expect(manifest.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: historicalRowId,
        title: automation.title,
      }),
    ]));
    await page.screenshot({ path: `${screenshotDir}/automation-reference-name.png`, fullPage: true });

    await automationButton.click();
    const automationSidePanel = page.getByTestId("chat-side-panel");
    await expect(automationSidePanel).toBeVisible();
    await expect(automationSidePanel).toContainText(automation.title);
  });

  test("hydrates canonical Issue and Issue Comment references in an existing Chat", async ({ page }) => {
    fs.mkdirSync(screenshotDir, { recursive: true });
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Issue-Manifest-${Date.now()}`,
        issuePrefix: `CIM${randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    const agent = await createE2EChatAgent(page.request, organization.id, { name: "Issue Manifest Agent" });
    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Canonical manifest issue",
        description: "Issue reference hydration target.",
        status: "todo",
        priority: "high",
      },
    });
    expect(issueRes.ok(), await issueRes.text()).toBe(true);
    const issue = await issueRes.json() as { id: string; identifier: string; title: string };
    const commentRes = await page.request.post(`/api/issues/${issue.id}/comments`, {
      data: { body: "Canonical manifest comment target." },
    });
    expect(commentRes.ok(), await commentRes.text()).toBe(true);
    const comment = await commentRes.json() as { id: string };
    const foreignOrgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Foreign-Chat-Issue-Manifest-${Date.now()}`,
        issuePrefix: `FCI${randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      },
    });
    expect(foreignOrgRes.ok(), await foreignOrgRes.text()).toBe(true);
    const foreignOrganization = await foreignOrgRes.json() as { id: string };
    const foreignIssueRes = await page.request.post(`/api/orgs/${foreignOrganization.id}/issues`, {
      data: {
        title: "Foreign issue title must stay private",
        description: "Cross-organization boundary target.",
        status: "blocked",
        priority: "high",
      },
    });
    expect(foreignIssueRes.ok(), await foreignIssueRes.text()).toBe(true);
    const foreignIssue = await foreignIssueRes.json() as { id: string };

    const chatId = randomUUID();
    const messageId = randomUUID();
    const historicalRowId = randomUUID();
    await e2eDb.insert(chatConversations).values({
      id: chatId,
      orgId: organization.id,
      title: "Existing issue reference Chat",
      preferredAgentId: agent.id,
    });
    await e2eDb.insert(chatMessages).values({
      id: messageId,
      orgId: organization.id,
      conversationId: chatId,
      role: "user",
      status: "completed",
      body: [
        `[Stale Issue label](issue://${issue.id}?r=stale-ref)`,
        `[Stale Comment label](issue://${issue.identifier.toLowerCase()}?c=${comment.id})`,
        `[Foreign fallback](issue://${foreignIssue.id}?r=foreign-ref)`,
      ].join(" "),
    });
    await e2eDb.insert(chatWorkManifestItems).values({
      id: historicalRowId,
      orgId: organization.id,
      conversationId: chatId,
      messageId,
      category: "references",
      targetType: "issue",
      targetKey: `issue:${issue.id}`,
      title: "Issue",
      url: `/issues/${issue.identifier.toLowerCase()}`,
      sourceRole: "user",
      metadata: { issueId: issue.id },
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      localStorage.setItem("rudder.selectedOrganizationId", orgId);
      localStorage.setItem("rudder.theme", "dark");
    }, organization.id);
    await page.setViewportSize({ width: 1440, height: 900 });
    const shelf = await gotoChatAndWaitForManifest(page, organization.issuePrefix, chatId);
    const canonicalTitle = `${issue.identifier} · ${issue.title}`;
    const issueButton = shelf.locator("button[data-target-type='issue']").filter({ hasText: canonicalTitle });
    const commentButton = shelf.locator("button[data-target-type='issue_comment']").filter({ hasText: canonicalTitle });
    await expect(issueButton).toHaveCount(1);
    await expect(commentButton).toHaveCount(1);
    await expect(issueButton.locator("[data-issue-type-icon='true']")).toBeVisible();
    await expect(issueButton.locator("[data-issue-status='todo'] [data-slot='issue-status-icon']"))
      .toHaveAttribute("data-status", "todo");
    await expect(commentButton.locator("[data-issue-type-icon='true']")).toBeVisible();
    const foreignButton = shelf.locator("button[data-target-type='issue']").filter({ hasText: "Foreign fallback" });
    await expect(foreignButton).toHaveCount(1);
    await expect(foreignButton.locator("[data-issue-status]")).toHaveCount(0);
    await expect(shelf).not.toContainText("Foreign issue title must stay private");
    const initialManifestRes = await page.request.get(`/api/chats/${chatId}/work-manifest`);
    expect(initialManifestRes.ok(), await initialManifestRes.text()).toBe(true);
    const initialManifest = await initialManifestRes.json() as {
      references: Array<{
        id: string;
        title: string;
        metadata?: Record<string, unknown> | null;
      }>;
    };
    expect(initialManifest.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: historicalRowId,
        title: canonicalTitle,
        metadata: expect.objectContaining({ issueStatus: "todo" }),
      }),
      expect.objectContaining({
        title: "Foreign fallback",
        metadata: expect.not.objectContaining({ issueStatus: expect.anything() }),
      }),
    ]));

    await commentButton.click();
    const issueSidePanel = page.getByTestId("chat-side-panel");
    await expect(issueSidePanel).toContainText("Canonical manifest comment target.");
    await expect(page).toHaveURL(new RegExp(`/messenger/chat/${chatId}$`));
    const updateRes = await page.request.patch(`/api/issues/${issue.id}`, {
      data: { title: "Canonical manifest issue updated", status: "done" },
    });
    expect(updateRes.ok(), await updateRes.text()).toBe(true);
    await issueSidePanel.getByTestId("chat-side-panel-tab").hover();
    await issueSidePanel.getByTestId("chat-side-panel-tab-close").click();
    await expect(issueSidePanel).toHaveCount(0);

    const updatedTitle = `${issue.identifier} · Canonical manifest issue updated`;
    const updatedIssueButton = shelf.locator("button[data-target-type='issue']").filter({ hasText: updatedTitle });
    await expect(updatedIssueButton).toBeVisible({ timeout: 15_000 });
    await expect(updatedIssueButton.locator("[data-issue-status='done'] [data-slot='issue-status-icon']"))
      .toHaveAttribute("data-status", "done");
    await page.screenshot({ path: `${screenshotDir}/issue-references-fixed.png`, fullPage: true });
  });

  test("shows category-led thread outputs across desktop and compact layouts", async ({ page }) => {
    fs.mkdirSync(screenshotDir, { recursive: true });
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Work-Manifest-${Date.now()}`,
        issuePrefix: `CWM${randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    const agent = await createE2EChatAgent(page.request, organization.id, { name: "Manifest Agent" });

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Manifest reference issue",
        description: "Referenced from a user message in the Work manifest.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok(), await issueRes.text()).toBe(true);
    const issue = await issueRes.json() as { id: string; identifier: string; title: string };
    const issueCommentRes = await page.request.post(`/api/issues/${issue.id}/comments`, {
      data: { body: "Manifest comment target evidence." },
    });
    expect(issueCommentRes.ok(), await issueCommentRes.text()).toBe(true);
    const issueComment = await issueCommentRes.json() as { id: string };
    const issueManifestTitle = `${issue.identifier} · ${issue.title}`;

    const automationRes = await page.request.post(`/api/orgs/${organization.id}/automations`, {
      data: {
        title: "Manifest reference automation",
        description: "Referenced from a user message in the Work manifest.",
        assigneeAgentId: agent.id,
        priority: "medium",
      },
    });
    expect(automationRes.ok(), await automationRes.text()).toBe(true);
    const automation = await automationRes.json() as { id: string; title: string };

    const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: { name: "Manifest Project", status: "in_progress" },
    });
    expect(projectRes.ok(), await projectRes.text()).toBe(true);
    const project = await projectRes.json() as { id: string };

    const outputPath = `artifacts/chat-manifest-${Date.now()}/report.md`;
    const outputFileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: { filePath: outputPath, content: "# Manifest report\n\nA run-backed output." },
    });
    expect(outputFileRes.ok(), await outputFileRes.text()).toBe(true);
    const outputFile = await outputFileRes.json() as { markdownLink: string };
    const websiteOutputPath = `artifacts/chat-manifest-${Date.now()}/index.html`;
    const websiteOutputFileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: { filePath: websiteOutputPath, content: "<!doctype html><title>Manifest site</title>" },
    });
    expect(websiteOutputFileRes.ok(), await websiteOutputFileRes.text()).toBe(true);
    const websiteOutputFile = await websiteOutputFileRes.json() as { markdownLink: string };
    const sourcePath = `docs/chat-manifest-${Date.now()}-brief.md`;
    const sourceFileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: { filePath: sourcePath, content: "# Source brief" },
    });
    expect(sourceFileRes.ok(), await sourceFileRes.text()).toBe(true);
    const sourceFile = await sourceFileRes.json() as { markdownLink: string };

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Current manifest chat",
        preferredAgentId: agent.id,
        contextLinks: [{ entityType: "project", entityId: project.id }],
        initialMessage: { body: "Prepare the current conversation manifest." },
      },
    });
    expect(chatRes.ok(), await chatRes.text()).toBe(true);
    const chat = await chatRes.json() as { id: string };
    const referencedChatTitle = "Original referenced chat title that is deliberately longer than the compact References shelf can display";
    const otherChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: referencedChatTitle,
        preferredAgentId: agent.id,
        contextLinks: [{ entityType: "project", entityId: project.id }],
        initialMessage: { body: "Track the other project conversation." },
      },
    });
    expect(otherChatRes.ok(), await otherChatRes.text()).toBe(true);
    const otherChat = await otherChatRes.json() as { id: string };
    const outputOnlyChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Output-only manifest chat",
        preferredAgentId: agent.id,
        initialMessage: { body: "Prepare one output." },
      },
    });
    expect(outputOnlyChatRes.ok(), await outputOnlyChatRes.text()).toBe(true);
    const outputOnlyChat = await outputOnlyChatRes.json() as { id: string };
    const emptyChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Empty manifest chat",
        preferredAgentId: agent.id,
        contextLinks: [{ entityType: "project", entityId: project.id }],
        initialMessage: { body: "Keep this conversation free of manifest targets." },
      },
    });
    expect(emptyChatRes.ok(), await emptyChatRes.text()).toBe(true);
    const emptyChat = await emptyChatRes.json() as { id: string };
    const errorChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Unavailable manifest chat",
        preferredAgentId: agent.id,
        initialMessage: { body: "Exercise the unavailable manifest state." },
      },
    });
    expect(errorChatRes.ok(), await errorChatRes.text()).toBe(true);
    const errorChat = await errorChatRes.json() as { id: string };

    const resourceId = randomUUID();
    await e2eDb.insert(organizationResources).values({
      id: resourceId,
      orgId: organization.id,
      name: "Project research source",
      kind: "document",
      locator: "https://project-source.example/research",
    });
    await e2eDb.insert(projectResourceAttachments).values({
      orgId: organization.id,
      projectId: project.id,
      resourceId,
    });

    const runId = randomUUID();
    const overflowReferences = Array.from(
      { length: 24 },
      (_, index) => `https://x.com/rudder/status/${index + 1}`,
    ).join(" ");
    await e2eDb.insert(heartbeatRuns).values({
      id: runId,
      orgId: organization.id,
      agentId: agent.id,
      invocationSource: "chat",
      status: "completed",
      chatConversationId: chat.id,
      contextSnapshot: { projectId: project.id },
    });
    const outputOnlyRunId = randomUUID();
    await e2eDb.insert(heartbeatRuns).values({
      id: outputOnlyRunId,
      orgId: organization.id,
      agentId: agent.id,
      invocationSource: "chat",
      status: "completed",
      chatConversationId: outputOnlyChat.id,
      contextSnapshot: {},
    });
    await e2eDb.insert(chatMessages).values([
      {
        orgId: organization.id,
        conversationId: chat.id,
        role: "user",
        body: [
          `Use https://source.example/research, https://source-two.example/data, and ${sourceFile.markdownLink}.`,
          `[${issue.identifier}](issue://${issue.id}?r=${encodeURIComponent(issue.identifier)})`,
          `[Issue comment](issue://${issue.id}?r=${encodeURIComponent(issue.identifier)}&c=${issueComment.id})`,
          `[](automation://${automation.id})`,
          `[](chat://${otherChat.id})`,
        ].join(" "),
        status: "completed",
      },
      {
        orgId: organization.id,
        conversationId: chat.id,
        role: "assistant",
        body: `Produced ${outputFile.markdownLink} and ${websiteOutputFile.markdownLink}. Source duplicate: https://source.example/research#section. Reference: https://reference.example/docs. [GitHub repository](https://github.com/Undertone0809/rudder). ${overflowReferences}`,
        status: "completed",
        runId,
        replyingAgentId: agent.id,
      },
      {
        orgId: organization.id,
        conversationId: chat.id,
        role: "assistant",
        body: "Stale reference https://stale.example/hidden",
        status: "completed",
        supersededAt: new Date(),
      },
      {
        orgId: organization.id,
        conversationId: otherChat.id,
        role: "user",
        body: "Other project source https://other-source.example/data",
        status: "completed",
      },
      {
        orgId: organization.id,
        conversationId: outputOnlyChat.id,
        role: "assistant",
        body: `Produced ${outputFile.markdownLink}.`,
        status: "completed",
        runId: outputOnlyRunId,
        replyingAgentId: agent.id,
      },
    ]);

    const otherManifestRes = await page.request.get(`/api/chats/${otherChat.id}/work-manifest`);
    expect(otherManifestRes.ok(), await otherManifestRes.text()).toBe(true);

    await page.goto("/");
    await page.evaluate((orgId) => {
      localStorage.setItem("rudder.selectedOrganizationId", orgId);
      localStorage.setItem("rudder.theme", "dark");
    }, organization.id);
    await page.setViewportSize({ width: 1440, height: 900 });
    const shelf = await gotoChatAndWaitForManifest(page, organization.issuePrefix, chat.id);
    await expect(shelf.getByText("Outputs", { exact: true })).toHaveCount(1);
    await expect(shelf).toContainText("Sources");
    await expect(shelf).toContainText("References");
    await expect(shelf).toContainText("report.md");
    await expect(shelf).toContainText("index.html");
    await expect(shelf.getByRole("button", { name: /index\.html/ }).locator("[data-file-icon='website']"))
      .toBeVisible();
    await expect(shelf).not.toContainText("From Agent");
    const references = shelf.locator("section[aria-label='References']");
    await references.getByRole("button", { name: "View all 30" }).click();
    await expect(references).toContainText("https://reference.example/docs");
    await expect(references.getByRole("button", { name: /reference\.example/ }).locator("[data-website-icon]"))
      .toBeVisible();
    const githubLogo = references.getByRole("button", { name: /GitHub repository/ })
      .locator("img.rudder-website-link-logo");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(githubLogo).toHaveAttribute("data-dark-mode", "invert");
    await expect(githubLogo).toHaveCSS("filter", "invert(1)");
    const issueReferenceButton = references
      .locator("button[data-target-type='issue']")
      .filter({ hasText: issueManifestTitle });
    const issueCommentButton = references
      .locator("button[data-target-type='issue_comment']")
      .filter({ hasText: issueManifestTitle });
    const issueStatusIcon = issueReferenceButton
      .locator("[data-file-icon='issue'][data-issue-status='todo'] [data-slot='issue-status-icon']");
    await expect(issueReferenceButton).toHaveCount(1);
    await expect(issueCommentButton).toHaveCount(1);
    await expect(issueReferenceButton.locator("[data-issue-type-icon='true']")).toBeVisible();
    await expect(issueCommentButton.locator("[data-issue-type-icon='true']")).toBeVisible();
    await expect(issueStatusIcon).toBeVisible();
    await expect(issueStatusIcon).toHaveAttribute("data-status", "todo");
    await expect(references.getByRole("button", { name: new RegExp(automation.title) }).locator("[data-file-icon='automation']"))
      .toBeVisible();
    const referencedChatButton = references.getByRole("button", { name: referencedChatTitle, exact: true });
    await expect(referencedChatButton.locator("[data-file-icon='chat']")).toBeVisible();
    await expect(referencedChatButton).toHaveAttribute("title", referencedChatTitle);
    const referencedChatLabel = referencedChatButton.locator("span.truncate").first();
    await expect(referencedChatLabel).toHaveText(referencedChatTitle);
    const referencedChatLabelGeometry = await referencedChatLabel.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        overflowX: style.overflowX,
        textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace,
      };
    });
    expect(referencedChatLabelGeometry.scrollWidth).toBeGreaterThan(referencedChatLabelGeometry.clientWidth);
    expect(referencedChatLabelGeometry.overflowX).toBe("hidden");
    expect(referencedChatLabelGeometry.textOverflow).toBe("ellipsis");
    expect(referencedChatLabelGeometry.whiteSpace).toBe("nowrap");
    await expect(shelf).not.toContainText("Project work");
    await expect(shelf).not.toContainText("Project research source");
    await expect(shelf).not.toContainText("stale.example");
    await expect(shelf).not.toContainText("Browser");
    await expect(shelf.getByRole("button", { name: "Add source" })).toHaveCount(0);
    await expect(shelf.getByText("Work", { exact: true })).toHaveCount(0);
    const outputsHeader = shelf.getByTestId("chat-work-manifest-section-header-outputs");
    const referencesHeader = shelf.getByTestId("chat-work-manifest-section-header-references");
    await expect(outputsHeader).toBeVisible();
    await expect(referencesHeader).toBeVisible();
    expect(await outputsHeader.getAttribute("class")).toBe(await referencesHeader.getAttribute("class"));
    await expect(outputsHeader.locator("svg")).toHaveCount(1);
    await expect(referencesHeader.locator("svg")).toHaveCount(1);
    await expect(shelf.getByRole("button", { name: /source\.example https:\/\/source\.example\/research/ }))
      .toHaveCount(1);

    const [shelfBox, maxUserMessageRight, composerContentBox] = await Promise.all([
      shelf.boundingBox(),
      page.getByTestId("chat-user-message-bubble").evaluateAll((elements) =>
        Math.max(0, ...elements.map((element) => element.getBoundingClientRect().right))
      ),
      page.getByTestId("chat-composer-content").boundingBox(),
    ]);
    expect(shelfBox).not.toBeNull();
    expect(maxUserMessageRight).toBeGreaterThan(0);
    expect(composerContentBox).not.toBeNull();
    expect(shelfBox!.x - maxUserMessageRight).toBeGreaterThanOrEqual(12);
    expect(shelfBox!.x - (composerContentBox!.x + composerContentBox!.width)).toBeGreaterThanOrEqual(12);

    const sources = shelf.getByRole("region", { name: "Sources" });
    await expect(sources).toContainText("source-two.example");
    await expect(sources.getByRole("button", { name: /View all/ })).toHaveCount(0);
    await page.screenshot({ path: `${screenshotDir}/references.png`, fullPage: true });

    await issueCommentButton.click();
    const issueSidePanel = page.getByTestId("chat-side-panel");
    await expect(issueSidePanel).toBeVisible();
    await expect(issueSidePanel.getByTestId("chat-side-panel-issue-view")).toBeVisible();
    await expect(issueSidePanel).toContainText("Manifest reference issue");
    await expect(issueSidePanel).toContainText("Manifest comment target evidence.");
    await expect(page).toHaveURL(new RegExp(`/messenger/chat/${chat.id}$`));
    await page.screenshot({ path: `${screenshotDir}/issue-side-panel.png`, fullPage: true });
    const updateIssueRes = await page.request.patch(`/api/issues/${issue.id}`, {
      data: { title: "Manifest reference issue updated", status: "done" },
    });
    expect(updateIssueRes.ok(), await updateIssueRes.text()).toBe(true);
    await issueSidePanel.getByTestId("chat-side-panel-tab").hover();
    await issueSidePanel.getByTestId("chat-side-panel-tab-close").click();
    await expect(issueSidePanel).toHaveCount(0);
    await expect(shelf).toBeVisible({ timeout: 15_000 });
    const reopenedReferences = shelf.locator("section[aria-label='References']");
    await reopenedReferences
      .getByRole("button", { name: "View all 30" })
      .click();
    const updatedIssueTitle = `${issue.identifier} · Manifest reference issue updated`;
    const updatedIssueButton = reopenedReferences
      .locator("button[data-target-type='issue']")
      .filter({ hasText: updatedIssueTitle });
    await expect(updatedIssueButton).toBeVisible({ timeout: 15_000 });
    await expect(updatedIssueButton.locator("[data-issue-status='done'] [data-slot='issue-status-icon']"))
      .toHaveAttribute("data-status", "done");

    await references.getByRole("button", { name: automation.title, exact: true }).click();
    const automationSidePanel = page.getByTestId("chat-side-panel");
    await expect(automationSidePanel).toBeVisible();
    await expect(automationSidePanel).toContainText("Manifest reference automation");
    await expect(page).toHaveURL(new RegExp(`/messenger/chat/${chat.id}$`));
    await page.screenshot({ path: `${screenshotDir}/automation-side-panel.png`, fullPage: true });
    await automationSidePanel.getByTestId("chat-side-panel-tab").hover();
    await automationSidePanel.getByTestId("chat-side-panel-tab-close").click();
    await expect(automationSidePanel).toHaveCount(0);
    await expect(shelf).toBeVisible({ timeout: 15_000 });
    await shelf.locator("section[aria-label='References']")
      .getByRole("button", { name: "View all 30" })
      .click();

    await references.getByRole("button", { name: referencedChatTitle, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/messenger/chat/${otherChat.id}$`));
    await expect(page.getByTestId("chat-side-panel")).toHaveCount(0);
    await expect(page.getByTestId("chat-user-message").filter({ hasText: "Other project source" })).toBeVisible();
    await page.screenshot({ path: `${screenshotDir}/chat-reference-navigation.png`, fullPage: true });
    await gotoChatAndWaitForManifest(page, organization.issuePrefix, chat.id);
    await shelf.locator("section[aria-label='References']")
      .getByRole("button", { name: "View all 30" })
      .click();

    const manifestScrollRegion = shelf.getByTestId("chat-work-manifest-scroll-region");
    await expect(manifestScrollRegion).toBeVisible();
    const shelfGeometry = await shelf.evaluate((element) => {
      const panel = element.getBoundingClientRect();
      const scrollRegion = element.querySelector<HTMLElement>("[data-testid='chat-work-manifest-scroll-region']");
      return {
        bottom: panel.bottom,
        height: panel.height,
        viewportHeight: window.innerHeight,
        clientHeight: scrollRegion?.clientHeight ?? 0,
        scrollHeight: scrollRegion?.scrollHeight ?? 0,
      };
    });
    expect(shelfGeometry.bottom).toBeLessThanOrEqual(shelfGeometry.viewportHeight);
    expect(shelfGeometry.height).toBeLessThanOrEqual(512);
    expect(shelfGeometry.scrollHeight).toBeGreaterThan(shelfGeometry.clientHeight);
    await manifestScrollRegion.hover();
    await page.mouse.wheel(0, 600);
    await expect.poll(() => manifestScrollRegion.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await gotoChatAndWaitForManifest(page, organization.issuePrefix, otherChat.id);
    const otherShelf = page.getByRole("complementary", { name: "Conversation files and links" });
    await expect(otherShelf).toBeVisible({ timeout: 15_000 });
    await expect(otherShelf).toContainText("other-source.example");
    await expect.poll(() => (
      otherShelf.getByTestId("chat-work-manifest-scroll-region").evaluate((element) => element.scrollTop)
    )).toBe(0);
    await gotoChatAndWaitForManifest(page, organization.issuePrefix, chat.id);
    await expect.poll(() => manifestScrollRegion.evaluate((element) => element.scrollTop)).toBe(0);

    const [scrollBox, workspaceBox] = await Promise.all([
      page.getByTestId("chat-messages-scroll-region").boundingBox(),
      page.getByTestId("workspace-main-card").boundingBox(),
    ]);
    expect(scrollBox).not.toBeNull();
    expect(workspaceBox).not.toBeNull();
    expect(Math.abs((scrollBox!.x + scrollBox!.width) - (workspaceBox!.x + workspaceBox!.width))).toBeLessThanOrEqual(2);

    const wideToggle = page.getByTestId("chat-work-manifest-wide-toggle");
    const widePanel = page.getByTestId("chat-work-manifest-wide-panel");
    await expect(wideToggle).toBeVisible();
    const widePanelBox = await widePanel.boundingBox();
    expect(widePanelBox).not.toBeNull();
    await wideToggle.click();
    await expect(widePanel).toHaveAttribute("data-state", "closed");
    await expect(widePanel).toHaveAttribute("aria-hidden", "true");
    const collapsedShelfInterceptsPointer = await page.evaluate(({ x, y }) => {
      return Boolean(document.elementFromPoint(x, y)?.closest("[data-testid='chat-work-manifest']"));
    }, { x: widePanelBox!.x + 12, y: widePanelBox!.y + 56 });
    expect(collapsedShelfInterceptsPointer).toBe(false);
    await wideToggle.click();
    await expect(widePanel).toHaveAttribute("data-state", "open");
    await expect(shelf).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: `${screenshotDir}/desktop.png`, fullPage: true });
    await page.evaluate(() => {
      const state = window as typeof window & {
        __rudderChatMotionIdentity?: {
          composer: Element | null;
          messages: Element | null;
          scrollRegion: Element | null;
        };
      };
      state.__rudderChatMotionIdentity = {
        composer: document.querySelector("[data-testid='chat-composer-content']"),
        messages: document.querySelector("[data-testid='chat-messages-content']"),
        scrollRegion: document.querySelector("[data-testid='chat-messages-scroll-region']"),
      };
    });

    await expect(page.locator(
      "[data-testid='side-panel-stable-host'], [data-testid='side-panel-expanded-overlay']",
    )).toHaveCount(1);
    await page.waitForTimeout(500);
    const openingSamples = await sampleSidePanelMotion(
      page,
      () => shelf.getByText("report.md", { exact: true }).click(),
    );
    expectRightAnchoredSidePanelMotion(openingSamples, "opening", {
      checkMessageWidth: true,
      endPanelWidth: { min: 390 },
    });
    const sidePanel = page.getByTestId("chat-side-panel");
    await expect(sidePanel).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Manifest report", { exact: true }))
      .toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("chat-work-manifest")).toHaveCount(0);
    expect(await page.evaluate(() => {
      const state = (window as typeof window & {
        __rudderChatMotionIdentity?: { composer: Element | null; messages: Element | null; scrollRegion: Element | null };
      }).__rudderChatMotionIdentity;
      return Boolean(
        state
          && state.composer === document.querySelector("[data-testid='chat-composer-content']")
          && state.messages === document.querySelector("[data-testid='chat-messages-content']")
          && state.scrollRegion === document.querySelector("[data-testid='chat-messages-scroll-region']"),
      );
    })).toBe(true);
    await page.screenshot({ path: `${screenshotDir}/side-panel.png`, fullPage: true });

    await sidePanel.getByTestId("chat-side-panel-tab").hover();
    const closingSamples = await sampleSidePanelMotion(
      page,
      () => sidePanel.getByTestId("chat-side-panel-tab-close").click(),
    );
    expectRightAnchoredSidePanelMotion(closingSamples, "closing", {
      checkClosingContent: true,
      checkMessageWidth: true,
      endPanelWidth: { max: 2 },
    });
    await expect(sidePanel).toHaveCount(0);
    expect(await page.evaluate(() => {
      const state = (window as typeof window & {
        __rudderChatMotionIdentity?: { composer: Element | null; messages: Element | null; scrollRegion: Element | null };
      }).__rudderChatMotionIdentity;
      return Boolean(
        state
          && state.composer === document.querySelector("[data-testid='chat-composer-content']")
          && state.messages === document.querySelector("[data-testid='chat-messages-content']")
          && state.scrollRegion === document.querySelector("[data-testid='chat-messages-scroll-region']"),
      );
    })).toBe(true);
    await page.setViewportSize({ width: 1024, height: 768 });
    const trigger = page.getByTestId("chat-work-manifest-trigger");
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveText(/Outputs 2/);
    await trigger.click();
    const compactPanel = page.getByTestId("chat-work-manifest-compact-panel");
    await expect(compactPanel).toBeVisible();
    await expect(compactPanel.getByText("Outputs", { exact: true })).toHaveCount(1);
    await expect(compactPanel).toContainText("report.md");
    await expect(compactPanel.getByText("Work", { exact: true })).toHaveCount(0);
    await expect(compactPanel.getByRole("button", { name: "Add source" })).toHaveCount(0);
    const compactOutputsHeader = compactPanel.getByTestId("chat-work-manifest-section-header-outputs");
    const compactReferencesHeader = compactPanel.getByTestId("chat-work-manifest-section-header-references");
    expect(await compactOutputsHeader.getAttribute("class")).toBe(await compactReferencesHeader.getAttribute("class"));
    const [compactOutputsCountBox, compactReferencesCountBox] = await Promise.all([
      compactOutputsHeader.getByTestId("chat-work-manifest-section-count-outputs").boundingBox(),
      compactReferencesHeader.getByTestId("chat-work-manifest-section-count-references").boundingBox(),
    ]);
    expect(compactOutputsCountBox).not.toBeNull();
    expect(compactReferencesCountBox).not.toBeNull();
    expect(Math.abs(
      (compactOutputsCountBox!.x + compactOutputsCountBox!.width)
      - (compactReferencesCountBox!.x + compactReferencesCountBox!.width),
    )).toBeLessThanOrEqual(1);
    await compactPanel.getByRole("button", { name: "View all 30" }).click();
    const compactScrollRegion = compactPanel.getByTestId("chat-work-manifest-scroll-region");
    const [panelBox, composerBox] = await Promise.all([
      compactPanel.boundingBox(),
      page.getByTestId("chat-composer-toolbar").boundingBox(),
    ]);
    expect(panelBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    expect(panelBox!.height).toBeLessThanOrEqual(512);
    expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(composerBox!.y);
    const compactScrollGeometry = await compactScrollRegion.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(compactScrollGeometry.scrollHeight).toBeGreaterThan(compactScrollGeometry.clientHeight);
    await page.screenshot({ path: `${screenshotDir}/compact.png`, fullPage: true });
    await compactPanel.getByRole("button", { name: "Close conversation files and links" }).click();
    await expect(compactPanel).toHaveCount(0);

    await trigger.focus();
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(compactPanel).toBeVisible();
    const compactCloseButton = compactPanel.getByRole("button", { name: "Close conversation files and links" });
    await compactCloseButton.focus();
    await expect(compactCloseButton).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(compactPanel).toHaveCount(0);

    await page.evaluate(() => localStorage.setItem("rudder.theme", "light"));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    const mobileTrigger = page.getByTestId("chat-work-manifest-trigger");
    await expect(mobileTrigger).toBeVisible();
    await expect(mobileTrigger).toHaveText(/Outputs 2/);
    await mobileTrigger.click();
    const mobilePanel = page.getByTestId("chat-work-manifest-compact-panel");
    await expect(mobilePanel).toBeVisible();
    const mobilePanelBox = await mobilePanel.boundingBox();
    expect(mobilePanelBox).not.toBeNull();
    expect(mobilePanelBox!.width).toBeLessThanOrEqual(390);
    expect(mobilePanelBox!.x).toBeGreaterThanOrEqual(0);
    expect(mobilePanelBox!.x + mobilePanelBox!.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${screenshotDir}/mobile-light.png`, fullPage: true });
    await mobilePanel.getByRole("button", { name: "Close conversation files and links" }).click();
    await expect(mobilePanel).toHaveCount(0);

    await page.setViewportSize({ width: 1440, height: 900 });
    const outputOnlyShelf = await gotoChatAndWaitForManifest(page, organization.issuePrefix, outputOnlyChat.id);
    await expect(outputOnlyShelf.getByText("Outputs", { exact: true })).toHaveCount(1);
    await expect(outputOnlyShelf).toContainText("report.md");
    await expect(outputOnlyShelf.getByText("Work", { exact: true })).toHaveCount(0);
    await expect(outputOnlyShelf.getByRole("button", { name: "Add source" })).toHaveCount(0);
    await page.screenshot({ path: `${screenshotDir}/output-only.png`, fullPage: true });

    await page.goto(`/${organization.issuePrefix}/messenger/chat/${emptyChat.id}`);
    await expect(page.getByTestId("chat-work-manifest")).toHaveCount(0);
    await expect(page.getByTestId("chat-work-manifest-wide-toggle")).toHaveCount(0);
    await expect(page.getByTestId("chat-work-manifest-trigger")).toHaveCount(0);

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId("chat-work-manifest")).toHaveCount(0);
    await expect(page.getByTestId("chat-work-manifest-wide-toggle")).toHaveCount(0);
    await gotoChatAndWaitForManifest(page, organization.issuePrefix, chat.id);
    await expect(wideToggle).toBeVisible();
    await wideToggle.click();
    await expect(widePanel).toHaveAttribute("data-state", "closed");

    await page.route(`**/api/chats/${errorChat.id}/work-manifest`, async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Manifest unavailable" }),
      });
    });
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${errorChat.id}`);
    const errorShelf = page.getByRole("complementary", { name: "Conversation files and links" });
    await expect(errorShelf).toBeVisible({ timeout: 15_000 });
    await expect(errorShelf).toContainText("Manifest unavailable");
    await expect(wideToggle).toHaveAttribute("aria-expanded", "true");
  });
});
