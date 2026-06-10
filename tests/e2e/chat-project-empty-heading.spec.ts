import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.describe("Chat project empty heading", () => {
  test("updates the draft chat heading when the selected project changes", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Project-Heading-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const alphaRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Alpha Console",
        description: "Primary chat heading test project.",
      },
    });
    const betaRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Beta Workspace",
        description: "Secondary chat heading test project.",
      },
    });
    expect(alphaRes.ok()).toBe(true);
    expect(betaRes.ok()).toBe(true);
    const alpha = await alphaRes.json() as { id: string; name: string };
    const beta = await betaRes.json() as { id: string; name: string };
    const agent = await createE2EChatAgent(page.request, organization.id, { name: "Project Switcher" });

    const alphaChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Alpha kickoff thread",
        preferredAgentId: agent.id,
        contextLinks: [{ entityType: "project", entityId: alpha.id }],
      },
    });
    const betaChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Beta roadmap thread",
        preferredAgentId: agent.id,
        contextLinks: [{ entityType: "project", entityId: beta.id }],
      },
    });
    expect(alphaChatRes.ok()).toBe(true);
    expect(betaChatRes.ok()).toBe(true);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat?projectId=${alpha.id}&agentId=${agent.id}`);

    const heading = page.locator("h1.motion-chat-empty-heading");
    const recentConversations = page.getByTestId("chat-empty-state-recent-project-conversations");
    await expect(heading).toHaveText(`What should we build in ${alpha.name}?`, { timeout: 15_000 });
    await expect(heading).toHaveClass(/motion-chat-empty-heading/);
    await expect(page.getByTestId("chat-project-selector")).toContainText(alpha.name);
    await expect(recentConversations).toContainText("Alpha kickoff thread", { timeout: 15_000 });
    await expect(recentConversations).toHaveCSS("animation-name", "rudder-chat-empty-recent-project-enter");

    await page.getByTestId("chat-project-selector").click();
    await page.getByRole("menuitemradio", { name: new RegExp(beta.name) }).click();

    await expect(heading).toHaveText(`What should we build in ${beta.name}?`, { timeout: 15_000 });
    await expect(page.getByTestId("chat-project-selector")).toContainText(beta.name);
    await expect(recentConversations).toContainText("Beta roadmap thread", { timeout: 15_000 });
    await expect(recentConversations).not.toContainText("Alpha kickoff thread");
    await expect(recentConversations).toHaveCSS("animation-name", "rudder-chat-empty-recent-project-enter");

    await page.getByTestId("chat-project-selector").click();
    await page.getByRole("menuitemradio", { name: "No project" }).click();

    await expect(heading).toHaveText(/What can I help with\?/);
    await expect(page.getByTestId("chat-project-selector")).toContainText("No project");
  });

  test("hides recent project conversations while the new chat composer has text", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Recent-Visibility-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Rudder dev",
        description: "Recent chat visibility test project.",
      },
    });
    expect(projectRes.ok()).toBe(true);
    const project = await projectRes.json() as { id: string; name: string };
    const agent = await createE2EChatAgent(page.request, organization.id, { name: "Wesley" });

    const recentChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Users need edit/delete comment support",
        preferredAgentId: agent.id,
        contextLinks: [{ entityType: "project", entityId: project.id }],
      },
    });
    expect(recentChatRes.ok()).toBe(true);
    const recentChat = await recentChatRes.json();
    const singleQuestionChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Single question design thread",
        preferredAgentId: agent.id,
        contextLinks: [{ entityType: "project", entityId: project.id }],
      },
    });
    expect(singleQuestionChatRes.ok()).toBe(true);
    const singleQuestionChat = await singleQuestionChatRes.json();
    const firstUserQuestion = "Users need edit/delete comment support";
    const secondUserQuestion = "What should we do after comment edit support ships?";
    const assistantReply = "Confirmed: reply preview should stay out of the recent conversations list.";
    const onlyUserQuestion = "Can the old use cases stay visible?";
    const singleQuestionAssistantReply = "Yes, keep the old use cases visible when there are no recent chats.";

    await e2eDb.insert(chatMessages).values([
      {
        id: randomUUID(),
        orgId: organization.id,
        conversationId: recentChat.id,
        role: "user",
        kind: "message",
        status: "completed",
        body: firstUserQuestion,
        structuredPayload: null,
        chatTurnId: randomUUID(),
        turnVariant: 0,
        createdAt: new Date("2026-06-09T08:00:00.000Z"),
        updatedAt: new Date("2026-06-09T08:00:00.000Z"),
      },
      {
        id: randomUUID(),
        orgId: organization.id,
        conversationId: recentChat.id,
        role: "assistant",
        kind: "message",
        status: "completed",
        body: assistantReply,
        structuredPayload: null,
        chatTurnId: randomUUID(),
        turnVariant: 0,
        createdAt: new Date("2026-06-09T08:01:00.000Z"),
        updatedAt: new Date("2026-06-09T08:01:00.000Z"),
      },
      {
        id: randomUUID(),
        orgId: organization.id,
        conversationId: recentChat.id,
        role: "user",
        kind: "message",
        status: "completed",
        body: secondUserQuestion,
        structuredPayload: null,
        chatTurnId: randomUUID(),
        turnVariant: 0,
        createdAt: new Date("2026-06-09T08:02:00.000Z"),
        updatedAt: new Date("2026-06-09T08:02:00.000Z"),
      },
      {
        id: randomUUID(),
        orgId: organization.id,
        conversationId: singleQuestionChat.id,
        role: "user",
        kind: "message",
        status: "completed",
        body: onlyUserQuestion,
        structuredPayload: null,
        chatTurnId: randomUUID(),
        turnVariant: 0,
        createdAt: new Date("2026-06-09T08:03:00.000Z"),
        updatedAt: new Date("2026-06-09T08:03:00.000Z"),
      },
      {
        id: randomUUID(),
        orgId: organization.id,
        conversationId: singleQuestionChat.id,
        role: "assistant",
        kind: "message",
        status: "completed",
        body: singleQuestionAssistantReply,
        structuredPayload: null,
        chatTurnId: randomUUID(),
        turnVariant: 0,
        createdAt: new Date("2026-06-09T08:04:00.000Z"),
        updatedAt: new Date("2026-06-09T08:04:00.000Z"),
      },
    ]);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat?projectId=${project.id}&agentId=${agent.id}`);

    const recentConversations = page.getByTestId("chat-empty-state-recent-project-conversations");
    await expect(recentConversations).toHaveAttribute("data-state", "open", { timeout: 15_000 });
    await expect(recentConversations).toContainText("Recent conversations");
    await expect(recentConversations).toContainText("Users need edit/delete comment support");
    await expect(recentConversations).toContainText(secondUserQuestion);
    await expect(recentConversations).not.toContainText(assistantReply);
    await expect(recentConversations).toContainText("Single question design thread");
    await expect(recentConversations).toContainText(singleQuestionAssistantReply);
    await expect(recentConversations).not.toContainText(onlyUserQuestion);
    await expect(page.getByTestId("chat-empty-state-tab-recent")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("chat-empty-state-tab-use-cases")).toHaveAttribute("aria-selected", "false");

    await page.getByTestId("chat-empty-state-tab-use-cases").click();
    await expect(page.getByTestId("chat-empty-state-tab-use-cases")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("button", { name: /Scope a new feature/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Clarify a vague request/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Turn a chat into an issue/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Review a blocker/ })).toBeVisible();

    await page.getByTestId("chat-empty-state-tab-recent").click();
    await expect(page.getByTestId("chat-empty-state-tab-recent")).toHaveAttribute("aria-selected", "true");

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("Draft a new implementation plan");

    await expect(recentConversations).toHaveAttribute("data-state", "closed");
    await expect(recentConversations).toHaveAttribute("aria-hidden", "true");
    await expect(recentConversations).toHaveCSS("pointer-events", "none");
    await expect(recentConversations).toHaveCSS("opacity", "0");
    await expect(recentConversations).toHaveCSS("max-height", "0px");

    await composer.fill("");

    await expect(recentConversations).toHaveAttribute("data-state", "open");
    await expect(recentConversations).toHaveAttribute("aria-hidden", "false");
    await expect(recentConversations).toHaveCSS("opacity", "1");
  });

  test("wraps long project names on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    const longProjectName = "SupercalifragilisticexpialidociousProjectWithoutNaturalBreakpoints";
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Project-Long-Heading-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: longProjectName,
        description: "Long mobile chat heading test project.",
      },
    });
    expect(projectRes.ok()).toBe(true);
    const project = await projectRes.json() as { id: string; name: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat?projectId=${project.id}`);

    const heading = page.locator("h1.motion-chat-empty-heading");
    await expect(heading).toHaveText(`What should we build in ${longProjectName}?`, { timeout: 15_000 });
    await expect(page.getByTestId("chat-empty-state-tabs")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Scope a new feature/ })).toBeVisible();

    const headingMetrics = await heading.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      overflowWrap: window.getComputedStyle(element).overflowWrap,
      text: element.textContent,
    }));
    const pageMetrics = await page.evaluate(() => ({
      bodyWidth: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
    }));

    expect(headingMetrics.text?.trim()).toBe(`What should we build in ${longProjectName}?`);
    expect(headingMetrics.overflowWrap).toBe("anywhere");
    expect(headingMetrics.scrollWidth).toBeLessThanOrEqual(headingMetrics.clientWidth);
    expect(pageMetrics.bodyWidth).toBeLessThanOrEqual(pageMetrics.viewportWidth);
  });
});
