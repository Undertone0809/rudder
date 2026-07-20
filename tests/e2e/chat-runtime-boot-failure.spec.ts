import { expect, test, type Page } from "@playwright/test";
import { E2E_CODEX_ERROR_STUB } from "./support/e2e-env";

async function createOrganization(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `${name}-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json() as Promise<{ id: string; issuePrefix: string }>;
}

async function createBrokenChatAgent(page: Page, orgId: string) {
  const agentRes = await page.request.post(`/api/orgs/${orgId}/agents`, {
    data: {
      name: "Broken Runtime",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        model: "gpt-5.4",
        command: E2E_CODEX_ERROR_STUB,
      },
    },
  });
  expect(agentRes.ok()).toBe(true);
  return agentRes.json() as Promise<{ id: string; name: string }>;
}

test("chat runtime boot failures are non-retryable in the real chat UI", async ({ page }) => {
  const organization = await createOrganization(page, "Chat-Runtime-Boot-Failure");
  const agent = await createBrokenChatAgent(page, organization.id);

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.issuePrefix}/messenger/chat?agentId=${agent.id}`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("Trigger the broken runtime");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/messenger/chat/[^/?#]+$`), {
    timeout: 15_000,
  });
  const chatId = new URL(page.url()).pathname.split("/").pop();
  expect(chatId).toBeTruthy();

  const failedAssistant = page.getByTestId("chat-assistant-message").last();
  await expect(failedAssistant).toContainText("Runtime unavailable", { timeout: 15_000 });
  await expect(failedAssistant).toContainText("Fix the runtime command or environment");
  await expect(failedAssistant).toContainText("Code chat_runtime_boot_failed");
  await expect(failedAssistant.getByRole("button", { name: /retry/i })).toHaveCount(0);

  const messagesRes = await page.request.get(`/api/chats/${chatId}/messages`);
  expect(messagesRes.ok()).toBe(true);
  const messages = await messagesRes.json() as Array<{
    role: string;
    status: string;
    structuredPayload: {
      recoverableFailure?: {
        action?: string;
        code?: string;
        phase?: string;
        recoverable?: boolean;
        retryable?: boolean;
      };
    } | null;
  }>;
  const assistantMessage = messages.find((message) => message.role === "assistant");
  expect(assistantMessage).toMatchObject({
    status: "failed",
    structuredPayload: {
      recoverableFailure: {
        action: "repair_runtime",
        code: "chat_runtime_boot_failed",
        phase: "runtime_boot",
        recoverable: false,
        retryable: false,
      },
    },
  });
});
