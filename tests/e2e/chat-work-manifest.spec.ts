import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  chatMessages,
  createDb,
  heartbeatRuns,
  organizationResources,
  projectResourceAttachments,
} from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);
const screenshotDir = "/tmp/rudder-chat-work-manifest";

test.describe("Chat Work Manifest", () => {
  test("shows thread work without project work across desktop and compact layouts", async ({ page }) => {
    fs.mkdirSync(screenshotDir, { recursive: true });
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Chat-Work-Manifest-${Date.now()}` },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    const agent = await createE2EChatAgent(page.request, organization.id, { name: "Manifest Agent" });

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
      },
    });
    expect(chatRes.ok(), await chatRes.text()).toBe(true);
    const chat = await chatRes.json() as { id: string };
    const otherChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Other project chat",
        preferredAgentId: agent.id,
        contextLinks: [{ entityType: "project", entityId: project.id }],
      },
    });
    expect(otherChatRes.ok(), await otherChatRes.text()).toBe(true);
    const otherChat = await otherChatRes.json() as { id: string };
    const emptyChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Empty manifest chat",
        preferredAgentId: agent.id,
        contextLinks: [{ entityType: "project", entityId: project.id }],
      },
    });
    expect(emptyChatRes.ok(), await emptyChatRes.text()).toBe(true);
    const emptyChat = await emptyChatRes.json() as { id: string };
    const errorChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Unavailable manifest chat",
        preferredAgentId: agent.id,
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
    await e2eDb.insert(heartbeatRuns).values({
      id: runId,
      orgId: organization.id,
      agentId: agent.id,
      invocationSource: "chat",
      status: "completed",
      chatConversationId: chat.id,
      contextSnapshot: { projectId: project.id },
    });
    await e2eDb.insert(chatMessages).values([
      {
        orgId: organization.id,
        conversationId: chat.id,
        role: "user",
        body: `Use https://source.example/research and ${sourceFile.markdownLink}.`,
        status: "completed",
      },
      {
        orgId: organization.id,
        conversationId: chat.id,
        role: "assistant",
        body: `Produced ${outputFile.markdownLink} and ${websiteOutputFile.markdownLink}. Source duplicate: https://source.example/research#section. Reference: https://reference.example/docs.`,
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
    ]);

    const otherManifestRes = await page.request.get(`/api/chats/${otherChat.id}/work-manifest`);
    expect(otherManifestRes.ok(), await otherManifestRes.text()).toBe(true);

    await page.goto("/");
    await page.evaluate((orgId) => localStorage.setItem("rudder.selectedOrganizationId", orgId), organization.id);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

    const shelf = page.getByRole("complementary", { name: "Work manifest" });
    await expect(shelf).toBeVisible({ timeout: 15_000 });
    await expect(shelf).toContainText("Outputs");
    await expect(shelf).toContainText("Sources");
    await expect(shelf).toContainText("References");
    await expect(shelf).toContainText("report.md");
    await expect(shelf).toContainText("index.html");
    await expect(shelf.getByRole("button", { name: /index\.html/ }).locator("[data-file-icon='website']"))
      .toBeVisible();
    await expect(shelf).not.toContainText("From Agent");
    await expect(shelf).toContainText("https://reference.example/docs");
    await expect(shelf.getByRole("button", { name: /reference\.example/ }).locator("[data-website-icon]"))
      .toBeVisible();
    await expect(shelf).not.toContainText("Project work");
    await expect(shelf).not.toContainText("Project research source");
    await expect(shelf).not.toContainText("stale.example");
    await expect(shelf).not.toContainText("Browser");
    await expect(shelf.getByRole("button", { name: /source\.example https:\/\/source\.example\/research/ }))
      .toHaveCount(1);

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
    await expect(shelf).toBeVisible();
    await page.screenshot({ path: `${screenshotDir}/desktop.png`, fullPage: true });

    await shelf.getByText("report.md", { exact: true }).click();
    const sidePanel = page.getByTestId("chat-side-panel");
    await expect(sidePanel).toBeVisible({ timeout: 15_000 });
    await expect(sidePanel.getByRole("heading", { name: "Manifest report", exact: true })).toBeVisible();
    await expect(page.getByTestId("chat-work-manifest")).toHaveCount(0);
    await page.screenshot({ path: `${screenshotDir}/side-panel.png`, fullPage: true });

    await sidePanel.getByTestId("chat-side-panel-tab-close").click();
    await expect(sidePanel).toHaveCount(0);
    await page.setViewportSize({ width: 1024, height: 768 });
    const trigger = page.getByTestId("chat-work-manifest-trigger");
    await expect(trigger).toBeVisible();
    await trigger.click();
    const compactPanel = page.getByTestId("chat-work-manifest-compact-panel");
    await expect(compactPanel).toBeVisible();
    await expect(compactPanel).toContainText("report.md");
    const [panelBox, composerBox] = await Promise.all([
      compactPanel.boundingBox(),
      page.getByTestId("chat-composer-toolbar").boundingBox(),
    ]);
    expect(panelBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(composerBox!.y);
    await page.screenshot({ path: `${screenshotDir}/compact.png`, fullPage: true });

    await page.goto(`/${organization.issuePrefix}/messenger/chat/${emptyChat.id}`);
    await expect(page.getByTestId("chat-work-manifest")).toHaveCount(0);
    await expect(page.getByTestId("chat-work-manifest-wide-toggle")).toHaveCount(0);
    await expect(page.getByTestId("chat-work-manifest-trigger")).toHaveCount(0);

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId("chat-work-manifest")).toHaveCount(0);
    await expect(page.getByTestId("chat-work-manifest-wide-toggle")).toHaveCount(0);
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);
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
    const errorShelf = page.getByRole("complementary", { name: "Work manifest" });
    await expect(errorShelf).toBeVisible();
    await expect(errorShelf).toContainText("Manifest unavailable");
    await expect(wideToggle).toHaveAttribute("aria-expanded", "true");
  });
});
