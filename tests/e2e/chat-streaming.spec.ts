import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { E2E_CODEX_STUB, E2E_ROOT } from "./support/e2e-env";

const E2E_CODEX_IGNORE_TERM_STUB = path.resolve(E2E_ROOT, "fixtures", "codex-ignore-term");

async function expectTranscriptBetweenUserAndAssistant(page: Page) {
  const userBubble = page.getByTestId("chat-user-message-bubble").last();
  const transcriptItem = page.getByTestId("chat-transcript-item").last();
  const assistantMessage = page.getByTestId("chat-assistant-message").last();

  await expect(userBubble).toBeVisible({ timeout: 15_000 });
  await expect(transcriptItem).toBeVisible({ timeout: 15_000 });
  await expect(assistantMessage).toBeVisible({ timeout: 15_000 });

  const [userBox, transcriptBox, assistantBox] = await Promise.all([
    userBubble.boundingBox(),
    transcriptItem.boundingBox(),
    assistantMessage.boundingBox(),
  ]);

  expect(userBox).not.toBeNull();
  expect(transcriptBox).not.toBeNull();
  expect(assistantBox).not.toBeNull();
  expect(userBox!.y).toBeLessThan(transcriptBox!.y);
  expect(transcriptBox!.y).toBeLessThan(assistantBox!.y);
}

async function createStreamingOrg(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name,
      defaultChatAgentRuntimeType: "codex_local",
      defaultChatAgentRuntimeConfig: {
        model: "gpt-5.4",
        command: E2E_CODEX_STUB,
      },
    },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json();
}

async function createStreamingOrgThatIgnoresStop(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name,
      defaultChatAgentRuntimeType: "codex_local",
      defaultChatAgentRuntimeConfig: {
        model: "gpt-5.4",
        command: E2E_CODEX_IGNORE_TERM_STUB,
        graceSec: 1,
      },
    },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json();
}

function currentChatId(pageUrl: string) {
  const chatId = new URL(pageUrl).pathname.split("/").pop();
  expect(chatId).toBeTruthy();
  return chatId!;
}

test.describe("Chat streaming", () => {
  test("streams a codex reply through to completion", async ({ page }) => {
    const organization = await createStreamingOrg(page, `Str-Chat-${Date.now()}`);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/chat");

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("Stream this reply");
    await page.getByRole("button", { name: "Send" }).click();

    const assistantReply = page.getByText("Streaming reply for chat.", { exact: false }).first();
    await expect(page.getByRole("button", { name: "Stop streaming" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Streaming reply", { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(assistantReply).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /Worked for/ })).toBeVisible({ timeout: 15_000 });

    await page.reload();
    await expect(page.getByText("Streaming reply for chat.", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    await expectTranscriptBetweenUserAndAssistant(page);
    const transcriptToggle = page.getByRole("button", { name: /Worked for/ }).last();
    await expect(transcriptToggle).toBeVisible({ timeout: 15_000 });
    await transcriptToggle.click();
    const transcriptItem = page.getByTestId("chat-transcript-item").last();
    await expect(transcriptItem.getByText("Model turn 1", { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(transcriptItem.getByText("Inspecting current chat state", { exact: false })).toBeVisible({ timeout: 15_000 });
    const toolActivityToggle = transcriptItem.locator('button[aria-label$="tool activity for model turn 1"]');
    await expect(toolActivityToggle).toBeVisible({ timeout: 15_000 });
    await expect(toolActivityToggle).toHaveAttribute("aria-expanded", "false");
    await expect(transcriptItem.getByText("Ran echo chat", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    await expect(transcriptItem.getByText("Activity details", { exact: false })).toHaveCount(0);
    await expect(transcriptItem.getByText("TRANSCRIPT_TOOL_OUTPUT_E2E", { exact: false })).toHaveCount(0);
    await toolActivityToggle.click();
    await expect(toolActivityToggle).toHaveAttribute("aria-expanded", "true");
    await expect(transcriptItem.getByText("Command activity", { exact: false })).toHaveCount(0);
    await expect(transcriptItem.getByText("Ran echo chat", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    await expect(transcriptItem.locator('button[aria-label="Expand command details"]').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/__RUDDER_RESULT_/)).toHaveCount(0);
    await expect(page.getByText(/"kind":"message"/)).toHaveCount(0);
  });

  test("keeps generating when the operator leaves the chat page", async ({ page }) => {
    const organization = await createStreamingOrg(page, `Leave-Chat-${Date.now()}`);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/chat");

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("Keep running after navigation");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByRole("button", { name: "Stop streaming" })).toBeVisible({ timeout: 15_000 });
    const chatId = currentChatId(page.url());

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({ timeout: 15_000 });

    await expect.poll(async () => {
      const messagesRes = await page.request.get(`/api/chats/${chatId}/messages`);
      expect(messagesRes.ok()).toBe(true);
      const messages = await messagesRes.json();
      return messages.find((message: { role: string }) => message.role === "assistant")?.status ?? null;
    }, { timeout: 15_000 }).toBe("completed");

    await page.goto(`/messenger/chat/${chatId}`);
    await expect(page.getByTestId("chat-assistant-message").last()).toContainText("Streaming reply for chat.", {
      timeout: 15_000,
    });
    await expect(page.getByRole("button", { name: /Stopped/ })).toHaveCount(0);
  });

  test("stops generation and keeps the partial assistant output", async ({ page }) => {
    const organization = await createStreamingOrg(page, `Stp-Chat-${Date.now()}`);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/chat");

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("Stop this reply");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText("Streaming reply", { exact: false })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Stop streaming" }).click();

    await expect(page.getByRole("button", { name: /Worked for .*Stopped/ })).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(800);
    await page.reload();

    await expect(page.getByText("Streaming reply", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    await expectTranscriptBetweenUserAndAssistant(page);
    const transcriptToggle = page.getByRole("button", { name: /Worked for .*Stopped/ }).last();
    await expect(transcriptToggle).toBeVisible({ timeout: 15_000 });
    await transcriptToggle.click();
    const transcriptItem = page.getByTestId("chat-transcript-item").last();
    await expect(transcriptItem.getByText("Model turn 1", { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(transcriptItem.getByText("Inspecting current chat state", { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(transcriptItem.locator('button[aria-label$="tool activity for model turn 1"]')).toHaveAttribute("aria-expanded", "false");
    await expect(transcriptItem.getByText("Ran echo chat", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    await expect(transcriptItem.getByText("TRANSCRIPT_TOOL_OUTPUT_E2E", { exact: false })).toHaveCount(0);
    await expect(page.getByText("Streaming reply for chat.", { exact: false })).toHaveCount(0);
    await expect(page.getByText(/__RUDDER_RESULT_/)).toHaveCount(0);
    await expect(page.getByText(/"kind":"message"/)).toHaveCount(0);
  });

  test("recovers the composer after stopping a stubborn chat run", async ({ page }) => {
    const organization = await createStreamingOrgThatIgnoresStop(page, `Stubborn-Chat-${Date.now()}`);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/chat");

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("Stop the stubborn reply");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText("Streaming reply", { exact: false })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Stop streaming" }).click();

    await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 15_000 });

    await composer.fill("Follow-up after stop");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: "Follow-up after stop" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("chat-assistant-message").last()).toContainText("Streaming reply for chat.", {
      timeout: 15_000,
    });
  });
});
