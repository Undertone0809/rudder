import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_ROOT } from "./support/e2e-env";

const E2E_CODEX_IGNORE_TERM_STUB = path.resolve(E2E_ROOT, "fixtures", "codex-ignore-term");

async function createStreamingOrg(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name,
    },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json();
  const chatAgent = await createE2EChatAgent(page.request, organization.id, {
    name: "Chat Agent",
    command: E2E_CODEX_IGNORE_TERM_STUB,
  });
  return { ...organization, chatAgent };
}

async function createSkill(page: Page, orgId: string, name: string, slug: string) {
  const skillRes = await page.request.post(`/api/orgs/${orgId}/skills`, {
    data: {
      name,
      slug,
      markdown: `---\nname: ${name}\n---\n\n# ${name}\n`,
    },
  });
  expect(skillRes.ok()).toBe(true);
  return skillRes.json() as Promise<{ key: string }>;
}

async function syncAgentSkills(page: Page, agentId: string, orgId: string, desiredSkills: string[]) {
  const syncRes = await page.request.post(`/api/agents/${agentId}/skills/sync?orgId=${encodeURIComponent(orgId)}`, {
    data: { desiredSkills },
  });
  expect(syncRes.ok()).toBe(true);
}

test.describe("Chat edit streaming layout", () => {
  test("exposes editing only for the latest user-authored message", async ({ page }) => {
    test.setTimeout(180_000);
    const pageErrors: string[] = [];
    const requestFailures: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
    page.on("requestfailed", (request) => requestFailures.push(
      `${request.method()} ${request.url()} ${request.failure()?.errorText ?? "unknown"}`,
    ));
    const organization = await createStreamingOrg(page, `Latest-Edit-${Date.now()}`);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/messenger/chat?agentId=${organization.chatAgent.id}`);

    const composer = page.getByTestId("chat-composer-editor-scroll").locator(".rudder-mdxeditor-content").first();
    const sendButton = page.getByRole("button", { name: "Send", exact: true });
    await expect(composer).toBeVisible({ timeout: 15_000 });

    const sendAndStop = async (body: string) => {
      await composer.fill(body);
      await sendButton.click();
      await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: body })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("button", { name: "Stop streaming" })).toBeVisible({ timeout: 45_000 });
      await page.getByRole("button", { name: "Stop streaming" }).click();
      await expect(page.getByRole("button", { name: "Stop streaming" })).toHaveCount(0, { timeout: 15_000 });
    };

    await sendAndStop("First user message");
    await sendAndStop("Second user message");

    const firstMessage = page.getByTestId("chat-user-message").filter({ hasText: "First user message" });
    const secondMessage = page.getByTestId("chat-user-message").filter({ hasText: "Second user message" });
    await expect(page.getByTestId("chat-user-message")).toHaveCount(2);
    await expect(firstMessage.getByRole("button", { name: "Edit message" })).toHaveCount(0);
    await expect(secondMessage.getByRole("button", { name: "Edit message" })).toHaveCount(1);
    await page.screenshot({ path: "/tmp/r6z-99-latest-user-edit-final.png", fullPage: true });

    await page.reload();
    await expect(secondMessage).toBeVisible({ timeout: 15_000 });
    await expect(firstMessage.getByRole("button", { name: "Edit message" })).toHaveCount(0);
    await expect(secondMessage.getByRole("button", { name: "Edit message" })).toHaveCount(1);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(firstMessage.getByRole("button", { name: "Edit message" })).toHaveCount(0);
    await expect(secondMessage.getByRole("button", { name: "Edit message" })).toHaveCount(1);
    expect(pageErrors, "The chat workflow should not emit page errors").toEqual([]);
    const unexpectedRequestFailures = requestFailures.filter((failure) => !failure.endsWith("net::ERR_ABORTED"));
    expect(unexpectedRequestFailures, `request failures: ${requestFailures.join(" | ")}`).toEqual([]);
  });

  test("shows only the replacement branch while an edited message is streaming", async ({ page }) => {
    test.setTimeout(180_000);
    const organization = await createStreamingOrg(page, `Edt-Chat-${Date.now()}`);
    const skill = await createSkill(page, organization.id, "Build Advisor", "build-advisor");
    await syncAgentSkills(page, organization.chatAgent.id, organization.id, [`org:${skill.key}`]);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    let forceStaleActiveGeneration = false;
    let lastActiveGeneration: {
      activeGenerationId: string;
      activeAttemptEpoch: number;
      activeControlVersion: number;
    } | null = null;
    await page.route("**/api/chats/*/queue", async (route) => {
      const response = await route.fetch();
      const snapshot = await response.json() as {
        activeGenerationId: string | null;
        activeAttemptEpoch: number | null;
        activeControlVersion: number | null;
        activeGenerationStatus: string | null;
        items: unknown[];
      };
      if (
        snapshot.activeGenerationId
        && snapshot.activeAttemptEpoch !== null
        && snapshot.activeControlVersion !== null
      ) {
        lastActiveGeneration = {
          activeGenerationId: snapshot.activeGenerationId,
          activeAttemptEpoch: snapshot.activeAttemptEpoch,
          activeControlVersion: snapshot.activeControlVersion,
        };
      }
      await route.fulfill({
        response,
        json: forceStaleActiveGeneration && lastActiveGeneration
          ? {
              ...snapshot,
              ...lastActiveGeneration,
              activeGenerationStatus: "running",
            }
          : snapshot,
      });
    });

    await page.goto(`/chat?agentId=${organization.chatAgent.id}`);

    const chatMain = page.getByRole("main").last();
    const composer = page.getByTestId("chat-composer-editor-scroll").locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("Original edit target");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page).toHaveURL(/\/messenger\/chat\/[^/]+$/i, { timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Stop streaming" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Streaming reply", { exact: false }).first()).toBeVisible({ timeout: 45_000 });
    await expect.poll(() => lastActiveGeneration?.activeGenerationId ?? null, { timeout: 15_000 }).not.toBeNull();

    await page.getByRole("button", { name: "Stop streaming" }).click();
    await expect(page.getByRole("button", { name: "Stop streaming" })).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText("Stop was rejected", { exact: false })).toHaveCount(0);

    const chatId = new URL(page.url()).pathname.split("/").pop();
    expect(chatId).toBeTruthy();
    let repeatedStopStatus: number | null = null;
    await page.route(`**/api/chats/${chatId}/messages/stream/stop`, async (route) => {
      const response = await route.fetch();
      repeatedStopStatus = response.status();
      forceStaleActiveGeneration = false;
      await route.fulfill({ response });
    });
    forceStaleActiveGeneration = true;
    await page.reload();
    await expect(page.getByRole("button", { name: "Stop streaming" })).toBeVisible({ timeout: 15_000 });

    const originalBubble = page.getByTestId("chat-user-message-bubble").filter({ hasText: "Original edit target" }).last();
    await originalBubble.hover();
    await page.getByRole("button", { name: "Edit message" }).last().click();

    const inlineEditor = page.getByTestId("chat-inline-message-editor");
    await expect(inlineEditor).toBeVisible();
    await expect(inlineEditor).toContainText("Original edit target");
    await expect(composer).not.toContainText("Original edit target");
    await expect(inlineEditor.getByRole("button", { name: "Send" })).toBeDisabled();
    await expect(page.getByTestId("chat-running-queue")).toHaveCount(0);
    const inlineContent = inlineEditor.locator(".rudder-mdxeditor-content").first();
    await inlineContent.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" @");
    const inlineMentionMenu = page.getByTestId("markdown-mention-menu");
    await expect(inlineMentionMenu).toBeVisible();
    await expect(inlineMentionMenu.getByRole("option").filter({ hasText: "build-advisor" }).first()).toBeVisible();
    const inlineEditorBox = await inlineEditor.boundingBox();
    const mentionMenuBox = await inlineMentionMenu.boundingBox();
    const caretBox = await page.evaluate(() => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return null;
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      return {
        bottom: rect.bottom,
        left: rect.left,
      };
    });
    expect(inlineEditorBox).not.toBeNull();
    expect(mentionMenuBox).not.toBeNull();
    expect(caretBox).not.toBeNull();
    expect(inlineEditorBox!.width).toBeGreaterThan(780);
    expect(mentionMenuBox!.width).toBeGreaterThan(480);
    expect(Math.abs(mentionMenuBox!.y - (caretBox!.bottom + 4))).toBeLessThanOrEqual(24);
    expect(Math.abs(mentionMenuBox!.x - caretBox!.left)).toBeLessThanOrEqual(24);
    expect(mentionMenuBox!.width).toBeLessThan(inlineEditorBox!.width - 32);
    expect(mentionMenuBox!.y).toBeLessThan(inlineEditorBox!.y + inlineEditorBox!.height - 2);
    await page.keyboard.press("Escape");
    await expect(inlineMentionMenu).toBeHidden();
    await inlineEditor.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Stop streaming" }).click({ force: true });
    await expect.poll(() => repeatedStopStatus, { timeout: 15_000 }).toBe(200);
    await expect(page.getByRole("button", { name: "Stop streaming" })).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText("Stop was rejected", { exact: false })).toHaveCount(0);
    await expect(page.getByTestId("chat-running-queue")).toHaveCount(0);

    await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: "Original edit target" })).toBeVisible();
    await expect(composer).not.toContainText("Original edit target");

    await originalBubble.hover();
    await page.getByRole("button", { name: "Edit message" }).last().click();
    await expect(inlineEditor).toBeVisible();
    await expect(inlineEditor.getByRole("button", { name: "Send" })).toBeEnabled();
    await inlineEditor.locator(".rudder-mdxeditor-content").fill("Edited edit target");
    await inlineEditor.getByRole("button", { name: "Send" }).click();

    await expect(chatMain.getByText("Edited edit target", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(chatMain.locator(".chat-message-user:visible").filter({ hasText: "Original edit target" })).toHaveCount(0);
    await expect(chatMain.locator(".chat-message-user:visible")).toHaveCount(1);
    await expect(page.getByText("2/2")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("chat-running-queue")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop streaming" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Stop streaming" }).click();
    await expect(page.getByRole("button", { name: "Stop streaming" })).toHaveCount(0, { timeout: 15_000 });

    const editedMessage = page.getByTestId("chat-user-message").filter({ hasText: "Edited edit target" });
    await expect(editedMessage).toBeVisible({ timeout: 15_000 });
    await expect(editedMessage.getByRole("button", { name: "Edit message" })).toHaveCount(1);

    await page.getByRole("button", { name: "Previous branch" }).click();

    await expect(chatMain.getByText("Original edit target", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(chatMain.getByText("Chat run stopped before a final reply", { exact: false })).toBeVisible({
      timeout: 15_000,
    });
    await expect(chatMain.locator(".chat-message-user:visible").filter({ hasText: "Edited edit target" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop streaming" })).toHaveCount(0);
    await expect(page.getByText("1/2")).toBeVisible({ timeout: 15_000 });
    const historicalMessage = page.getByTestId("chat-user-message").filter({ hasText: "Original edit target" });
    await expect(historicalMessage.getByRole("button", { name: "Edit message" })).toHaveCount(0);

    await page.getByRole("button", { name: "Next branch" }).click();
    await expect(chatMain.getByText("Edited edit target", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(chatMain.locator(".chat-message-user:visible").filter({ hasText: "Original edit target" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop streaming" })).toHaveCount(0);
    await expect(editedMessage.getByRole("button", { name: "Edit message" })).toHaveCount(1);
  });
});
