import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.describe("Chat rich references", () => {
  test("opens an assistant skill token's SKILL.md in the current Chat Side Panel", async ({ page }) => {
    const suffix = Date.now();
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Chat-Skill-Ref-${suffix}` },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string; urlKey: string };
    const agent = await createE2EChatAgent(page.request, organization.id, {
      name: "Skill Reference Agent",
    }) as { id: string };

    const skillSlug = `side-panel-skill-${suffix}`;
    const skillRes = await page.request.post(`/api/orgs/${organization.id}/skills`, {
      data: {
        name: "Side Panel Skill",
        slug: skillSlug,
        markdown: `---\nname: ${skillSlug}\ndescription: Opens in the current Chat Side Panel.\n---\n\n# Side Panel Skill\n\nInspectable skill body.\n`,
      },
    });
    expect(skillRes.ok(), await skillRes.text()).toBe(true);
    const skill = await skillRes.json() as { id: string; key: string; slug: string };

    const syncRes = await page.request.post(
      `/api/agents/${agent.id}/skills/sync?orgId=${encodeURIComponent(organization.id)}`,
      { data: { desiredSkills: [`org:${skill.key}`] } },
    );
    expect(syncRes.ok(), await syncRes.text()).toBe(true);

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Skill Side Panel chat",
        preferredAgentId: agent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
        initialMessage: { body: "Show the referenced skill beside this chat." },
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
      body: `Use [${skill.slug}](skill://org/${skill.id}?ref=${skill.slug}) for this review.`,
      replyingAgentId: agent.id,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.urlKey}/messenger/chat/${chat.id}`);

    const assistantMessage = page.getByTestId("chat-assistant-message").last();
    const skillToken = assistantMessage.locator("[data-skill-token='true']");
    await expect(skillToken).toHaveText(skill.slug, { timeout: 15_000 });
    await expect(assistantMessage).toContainText("for this review.");
    await skillToken.click();

    const sidePanel = page.getByTestId("chat-side-panel");
    await expect(sidePanel).toBeVisible({ timeout: 15_000 });
    await expect(sidePanel.getByRole("tab", { name: skill.slug, exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByRole("heading", { name: "Side Panel Skill", exact: true })).toBeVisible();
    await expect(page.getByText("Inspectable skill body.", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/messenger/chat/${chat.id}$`));
    const screenshotPath = process.env.RUDDER_SKILL_REFERENCE_SCREENSHOT?.trim();
    if (screenshotPath) {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }
  });

  test("renders issue and issue comment cards from assistant richReferences and opens the target", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Chat-Rich-Refs-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string; urlKey: string };
    await createE2EChatAgent(page.request, organization.id, { name: "Reference Agent" });

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Chat rich reference target",
        description: "This issue should appear as a rich chat card.",
        status: "todo",
        priority: "high",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();
    const issueLabel = issue.identifier ?? issue.id.slice(0, 8);
    const issueRouteRef = issue.identifier ?? issue.id;

    const commentRes = await page.request.post(`/api/issues/${issue.id}/comments`, {
      data: {
        body: "Review note: **add the missing Playwright coverage** before approving.",
      },
    });
    expect(commentRes.ok()).toBe(true);
    const comment = await commentRes.json();

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Rich reference chat",
        issueCreationMode: "manual_approval",
        planMode: false,
        initialMessage: { body: "Show the related issue and review comment." },
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json();

    await e2eDb.insert(chatMessages).values({
      id: randomUUID(),
      orgId: organization.id,
      conversationId: chat.id,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "I found the relevant issue and review comment.",
      structuredPayload: {
        richReferences: [
          { type: "issue", issueId: issue.id, identifier: issue.identifier, display: "card" },
          { type: "issue_comment", issueId: issue.id, identifier: issue.identifier, commentId: comment.id, display: "card" },
        ],
      },
      replyingAgentId: null,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.urlKey}/messenger/chat/${chat.id}`);

    const assistantMessage = page.getByTestId("chat-assistant-message").last();
    await expect(assistantMessage).toContainText("I found the relevant issue and review comment.", { timeout: 15_000 });

    const richReferences = page.getByTestId("chat-rich-references").last();
    await expect(richReferences).toBeVisible({ timeout: 15_000 });
    await expect(richReferences.getByRole("link", { name: `Open issue ${issueLabel}` })).toBeVisible();
    await expect(richReferences.getByRole("link", { name: `Open comment on issue ${issueLabel}` })).toBeVisible();
    await expect(richReferences).toContainText("Chat rich reference target");
    await expect(richReferences).toContainText("Review note: add the missing Playwright coverage before approving.");

    const commentLink = richReferences.getByRole("link", { name: `Open comment on issue ${issueLabel}` });
    await expect(commentLink).toHaveAttribute(
      "href",
      new RegExp(`/${organization.urlKey}/issues/${issueRouteRef}#comment-${comment.id}$`),
    );
    await commentLink.click();

    await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/issues/${issueRouteRef}#comment-${comment.id}$`));
    await expect(page.getByRole("heading", { name: "Chat rich reference target" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("add the missing Playwright coverage", { exact: false })).toBeVisible({ timeout: 15_000 });
  });
});
