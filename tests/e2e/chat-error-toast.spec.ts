import { expect, test } from "@playwright/test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_ERROR_STUB, E2E_CODEX_STUB } from "./support/e2e-env";

const ORG_NAME = `Err-Chat-${Date.now()}`;

async function createRetryableFailureStub() {
  const dir = await mkdtemp(join(tmpdir(), "rudder-chat-retry-"));
  const scriptPath = join(dir, "codex-retry-once.sh");
  const counterPath = join(dir, "attempts");
  await writeFile(scriptPath, `#!/bin/sh
set -eu
counter="${counterPath}"
attempt=0
if [ -f "$counter" ]; then
  attempt="$(cat "$counter")"
fi
attempt=$((attempt + 1))
printf '%s' "$attempt" > "$counter"
if [ "$attempt" -eq 1 ]; then
  printf '%s\\n' '{"type":"thread.started","thread_id":"thread-e2e-retry","model":"gpt-5.4"}'
  printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Partial model output before failure."}}'
  printf '%s\\n' '{"type":"turn.failed","error":{"message":"model generation failed after output"}}'
  exit 1
fi
exec "${E2E_CODEX_STUB}" "$@"
`);
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

test.describe("Chat error recovery", () => {
  test("shows a runtime boot failure instead of a system-level issue", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: ORG_NAME,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const chatAgent = await createE2EChatAgent(page.request, organization.id, {
      name: "Error Agent",
      command: E2E_CODEX_ERROR_STUB,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/chat?agentId=${chatAgent.id}`);

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("Why did this fail?");
    await page.getByRole("button", { name: "Send" }).click();

    const failedMessage = page.getByTestId("chat-assistant-message")
      .filter({ hasText: "The assistant runtime did not start successfully." });
    await expect(failedMessage).toBeVisible({
      timeout: 15_000,
    });
    await expect(failedMessage).toContainText("Runtime unavailable");
    await expect(failedMessage).toContainText("Code chat_runtime_boot_failed");
    await expect(failedMessage.getByRole("button", { name: "Retry" })).toHaveCount(0);
    await expect(page.getByText("The assistant hit a system-level issue.", { exact: false })).toHaveCount(0);
    await expect(page.getByText("Failed to send message")).toHaveCount(0);
    await expect(page.getByText("Missing optional dependency @openai/codex-darwin-arm64", { exact: false }))
      .toHaveCount(0);
    await expect(page.getByText("file:///stub/codex.js:100")).toHaveCount(0);
  });

  test("lets the operator retry a failed assistant reply", async ({ page }) => {
    const retryableFailureStub = await createRetryableFailureStub();
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Retry-Chat-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const chatAgent = await createE2EChatAgent(page.request, organization.id, {
      name: "Retry Agent",
      command: retryableFailureStub,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat?agentId=${chatAgent.id}`);

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("Please retry this failed request");
    await page.getByRole("button", { name: "Send" }).click();

    const failedMessage = page.getByTestId("chat-assistant-message")
      .filter({ hasText: "Code chat_adapter_failed" });
    await expect(failedMessage).toBeVisible({ timeout: 15_000 });
    await expect(failedMessage).toContainText("Response failed");
    await expect(failedMessage).toContainText("The assistant runtime failed before finishing.");
    await expect(failedMessage).toContainText("Code chat_adapter_failed");
    await expect(failedMessage.getByRole("button", { name: "Retry" })).toBeVisible();

    const chatId = page.url().match(/\/messenger\/chat\/([^/?#]+)/)?.[1];
    expect(chatId).toBeTruthy();
    const failedMessagesRes = await page.request.get(`/api/chats/${chatId}/messages`);
    expect(failedMessagesRes.ok()).toBe(true);
    const failedMessages = await failedMessagesRes.json() as Array<{
      role: string;
      status: string;
      structuredPayload?: {
        recoverableFailure?: {
          action?: string;
          code?: string;
          phase?: string;
          recoverable?: boolean;
        };
      } | null;
    }>;
    const failedAssistant = failedMessages.find((message) => message.role === "assistant");
    expect(failedAssistant).toMatchObject({
      status: "failed",
      structuredPayload: {
        recoverableFailure: {
          action: "retry",
          code: "chat_adapter_failed",
          phase: "model_generation",
          recoverable: true,
        },
      },
    });

    await failedMessage.getByRole("button", { name: "Retry" }).click();

    await expect(page.getByTestId("chat-user-message-bubble").filter({
      hasText: "Please retry this failed request",
    })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("chat-assistant-message").last()).toContainText("Streaming reply for chat.", {
      timeout: 15_000,
    });
    await expect(failedMessage).toHaveCount(0);
  });

  test("refreshes a completed assistant answer as another turn variant", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Refresh-Chat-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const chatAgent = await createE2EChatAgent(page.request, organization.id, {
      name: "Refresh Agent",
      command: E2E_CODEX_STUB,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat?agentId=${chatAgent.id}`);

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("Refresh this final answer");
    await page.getByRole("button", { name: "Send" }).click();

    const firstAssistantMessage = page.getByTestId("chat-assistant-message").filter({
      hasText: "Streaming reply for chat.",
    });
    await expect(firstAssistantMessage).toBeVisible({ timeout: 15_000 });

    await firstAssistantMessage.getByRole("button", { name: "Refresh answer" }).click();

    await expect(page.getByRole("button", { name: "Previous branch" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("2/2")).toBeVisible();
    await expect(page.getByText("Refresh this final answer").first()).toBeVisible();
    await expect(page.getByTestId("chat-assistant-message").filter({
      hasText: "Streaming reply for chat.",
    })).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: "Previous branch" }).click();
    await expect(page.getByText("1/2")).toBeVisible();
    await expect(page.getByText("Refresh this final answer").first()).toBeVisible();
  });
});
