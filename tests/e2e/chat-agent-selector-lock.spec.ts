import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatConversations, chatMessages, createDb } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB, E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.describe("Chat agent selector lock", () => {
  test("allows repairing a historical unassigned conversation before sending", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Agent-Repair-Chat-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const agent = await createE2EChatAgent(page.request, organization.id, { name: "Migration Agent" });
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const createdAt = new Date("2026-05-07T08:00:00.000Z");

    await e2eDb.insert(chatConversations).values({
      id: conversationId,
      orgId: organization.id,
      title: "Migrated unassigned chat",
      preferredAgentId: null,
      issueCreationMode: "manual_approval",
      lastMessageAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    });
    await e2eDb.insert(chatMessages).values({
      id: messageId,
      orgId: organization.id,
      conversationId,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Historical Copilot-era message",
      createdAt,
      updatedAt: createdAt,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat/${conversationId}`);

    const agentSelector = page.getByTestId("chat-agent-selector");
    await expect(agentSelector).toBeVisible({ timeout: 15_000 });
    await expect(agentSelector).toContainText("Migration Agent");
    await expect(agentSelector).toBeEnabled();
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();

    const patchPromise = page.waitForResponse((response) => {
      if (!response.url().includes(`/api/chats/${conversationId}`)) return false;
      if (response.request().method() !== "PATCH") return false;
      const body = response.request().postDataJSON() as { preferredAgentId?: string };
      return body.preferredAgentId === agent.id;
    });
    await agentSelector.click();
    await page.getByRole("menuitemradio", { name: /Migration Agent/ }).click();
    const patchResponse = await patchPromise;
    expect(patchResponse.ok()).toBe(true);

    await expect(agentSelector).toContainText("Migration Agent");
    await expect(agentSelector).toBeDisabled();

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible();
    await composer.fill("Continue this migrated conversation");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByTestId("chat-assistant-message").last()).toContainText("Streaming reply", { timeout: 15_000 });
  });

  test("locks the selected agent after the first message starts", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Agent-Lock-Chat-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Lock Agent",
        role: "engineer",
        title: "Engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(agentRes.ok()).toBe(true);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat`);

    const agentSelector = page.getByTestId("chat-agent-selector");
    await expect(agentSelector).toBeVisible({ timeout: 15_000 });
    await agentSelector.click();
    await page.getByRole("menuitemradio", { name: /Lock Agent/ }).click();
    await expect(agentSelector).toContainText("Lock Agent");

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible();
    await composer.fill("Start the locked-agent conversation");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(agentSelector).toBeDisabled({ timeout: 15_000 });
    await expect(agentSelector.getByTestId("chat-agent-selector-icon")).toBeVisible();
    await expect(agentSelector.getByTestId("chat-agent-selector-chevron")).toHaveCount(0);

    const backgroundBeforeHover = await agentSelector.evaluate((element) => getComputedStyle(element).backgroundColor);
    await agentSelector.hover({ force: true });
    await expect.poll(async () => agentSelector.evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe(backgroundBeforeHover);

    await agentSelector.evaluate((element) => (element as HTMLButtonElement).click());
    await expect(page.getByTestId("chat-agent-menu")).toHaveCount(0);

    await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 15_000 });
    await expect(agentSelector).toBeDisabled();
  });
});
