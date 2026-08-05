import { expect, test, type Page } from "@playwright/test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB } from "./support/e2e-env";

type SmokeOrganization = {
  id: string;
  issuePrefix: string;
  urlKey: string;
  chatAgent: {
    id: string;
    urlKey: string;
  };
};

type ChatMessage = {
  id: string;
  role: string;
  kind: string;
  status: string;
  body: string;
  runId: string | null;
  replyingAgentId: string | null;
  supersededAt?: string | null;
  structuredPayload?: Record<string, unknown> | null;
};

type AgentRun = {
  id: string;
  orgId: string;
  agentId: string;
  invocationSource: string;
  triggerDetail: string;
  status: string;
  chatConversationId: string | null;
  resultJson: Record<string, unknown> | null;
  usageJson: Record<string, unknown> | null;
};

const WORK_LOOP_TIMEOUT = 75_000;

async function createSmokeOrganization(page: Page, name: string, command = E2E_CODEX_STUB) {
  const organizationResponse = await page.request.post("/api/orgs", {
    data: { name },
  });
  expect(organizationResponse.ok()).toBe(true);
  const organization = await organizationResponse.json() as {
    id: string;
    issuePrefix: string;
    urlKey: string;
  };
  const chatAgent = await createE2EChatAgent(page.request, organization.id, {
    name: "Smoke Work Agent",
    command,
  });
  return { ...organization, chatAgent } as SmokeOrganization;
}

async function openChat(page: Page, organization: SmokeOrganization) {
  await page.addInitScript((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.issuePrefix}/messenger/chat?agentId=${organization.chatAgent.id}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.locator(".rudder-mdxeditor-content").first()).toBeVisible({ timeout: 45_000 });
}

function chatIdFromUrl(url: string) {
  const match = new URL(url).pathname.match(/\/messenger\/chat\/([^/]+)$/);
  expect(match?.[1]).toBeTruthy();
  return match![1]!;
}

async function readMessages(page: Page, chatId: string) {
  const response = await page.request.get(`/api/chats/${chatId}/messages`);
  expect(response.ok()).toBe(true);
  return await response.json() as ChatMessage[];
}

async function waitForAssistantMessage(page: Page, chatId: string, status: string) {
  await expect.poll(async () => {
    const messages = await readMessages(page, chatId);
    return [...messages].reverse().find((message) => message.role === "assistant")?.status ?? null;
  }, { timeout: WORK_LOOP_TIMEOUT }).toBe(status);

  const messages = await readMessages(page, chatId);
  const assistant = [...messages].reverse().find((message) => message.role === "assistant");
  expect(assistant).toBeTruthy();
  return assistant!;
}

async function waitForRun(page: Page, runId: string, status: string) {
  await expect.poll(async () => {
    const response = await page.request.get(`/api/agent-runs/${runId}`);
    if (!response.ok()) return null;
    const run = await response.json() as AgentRun;
    return run.status;
  }, { timeout: WORK_LOOP_TIMEOUT }).toBe(status);

  const response = await page.request.get(`/api/agent-runs/${runId}`);
  expect(response.ok()).toBe(true);
  return await response.json() as AgentRun;
}

async function sendTask(page: Page, task: string) {
  const composer = page.locator(".rudder-mdxeditor-content").first();
  const sendButton = page.getByRole("button", { name: "Send" });
  await composer.fill(task);
  await expect(sendButton).toBeEnabled({ timeout: 45_000 });
  await sendButton.click();
  await expect(page).toHaveURL(/\/messenger\/chat\/[^/?#]+$/, { timeout: 15_000 });
  return chatIdFromUrl(page.url());
}

async function assertRunEvidence(
  page: Page,
  run: AgentRun,
  chatId: string,
  organization: SmokeOrganization,
) {
  expect(run).toMatchObject({
    status: "succeeded",
    orgId: organization.id,
    agentId: organization.chatAgent.id,
    invocationSource: "chat",
    triggerDetail: "chat_assistant_reply_stream",
    chatConversationId: chatId,
    resultJson: {
      outcome: "completed",
      kind: "message",
      body: "Streaming reply for chat.",
    },
    usageJson: {
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
    },
  });

  const eventsResponse = await page.request.get(`/api/agent-runs/${run.id}/events?limit=200`);
  expect(eventsResponse.ok()).toBe(true);
  const events = await eventsResponse.json() as Array<{
    eventType: string;
    message: string | null;
  }>;
  expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
    "lifecycle",
    "adapter.invoke",
    "transcript.entry",
    "chat.message_linked",
  ]));
  expect(events.some((event) => event.message === "chat run succeeded")).toBe(true);

  const transcriptResponse = await page.request.get(
    `/api/run-intelligence/runs/${run.id}/transcript?output=full&includeOutputs=true&order=oldest`,
  );
  expect(transcriptResponse.ok()).toBe(true);
  const transcript = await transcriptResponse.json() as {
    run: { id: string; status: string };
    rows: Array<{ kind: string; preview: string; output: { text: string } | null }>;
  };
  expect(transcript.run).toMatchObject({ id: run.id, status: "succeeded" });
  expect(transcript.rows.length).toBeGreaterThan(0);
  expect(transcript.rows.some((row) => row.preview.includes("Inspecting current chat state"))).toBe(true);
  const assistantOutput = transcript.rows
    .filter((row) => row.kind === "assistant")
    .map((row) => row.output?.text ?? "")
    .join("");
  expect(assistantOutput).toContain("Streaming reply for chat.");
}

async function createRetryOnceStub() {
  const directory = await mkdtemp(join(tmpdir(), "rudder-smoke-retry-"));
  const scriptPath = join(directory, "codex-retry-once.sh");
  const counterPath = join(directory, "attempts");
  await writeFile(scriptPath, `#!/bin/sh
set -eu
counter=${JSON.stringify(counterPath)}
attempt=0
if [ -f "$counter" ]; then
  attempt="$(cat "$counter")"
fi
attempt=$((attempt + 1))
printf '%s' "$attempt" > "$counter"
if [ "$attempt" -eq 1 ]; then
  printf '%s\\n' '{"type":"thread.started","thread_id":"smoke-retry","model":"gpt-5.4"}'
  printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Partial model output before failure."}}'
  printf '%s\\n' '{"type":"turn.failed","error":{"message":"model generation failed after output"}}'
  exit 1
fi
exec ${JSON.stringify(E2E_CODEX_STUB)} "$@"
`);
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

test.describe("@smoke real work loop", () => {
  test.describe.configure({ timeout: 180_000 });

  test("completes Chat -> Agent Run -> result and reloads the persisted evidence", async ({ page }) => {
    const organization = await createSmokeOrganization(page, `Smoke-Loop-${Date.now()}`);
    await openChat(page, organization);

    const chatId = await sendTask(page, "Complete the smoke work item and report the result.");
    await expect(page.getByTestId("chat-assistant-message").last()).toContainText(
      "Streaming reply for chat.",
      { timeout: WORK_LOOP_TIMEOUT },
    );

    const assistant = await waitForAssistantMessage(page, chatId, "completed");
    expect(assistant).toMatchObject({
      kind: "message",
      status: "completed",
      body: "Streaming reply for chat.",
      runId: expect.any(String),
      replyingAgentId: organization.chatAgent.id,
    });
    const run = await waitForRun(page, assistant.runId!, "succeeded");
    await assertRunEvidence(page, run, chatId, organization);

    const transcriptResponse = await page.request.get(
      `/api/chats/${chatId}/messages/${assistant.id}/transcript`,
    );
    expect(transcriptResponse.ok()).toBe(true);
    const messageTranscript = await transcriptResponse.json() as { transcript: unknown[] };
    expect(messageTranscript.transcript.length).toBeGreaterThan(0);

    await page.reload();
    await expect(page.getByTestId("chat-assistant-message").last()).toContainText(
      "Streaming reply for chat.",
      { timeout: 15_000 },
    );
    await expect(page.getByRole("button", { name: /Worked for/ }).last()).toBeVisible();
  });

  test("continues a running work item after leaving Chat", async ({ page }) => {
    const organization = await createSmokeOrganization(page, `Smoke-Leave-${Date.now()}`);
    await openChat(page, organization);

    const chatId = await sendTask(page, "Keep executing this task while I inspect the dashboard.");
    await expect(page.getByRole("button", { name: "Stop streaming" })).toBeVisible({ timeout: 15_000 });

    await expect.poll(async () => {
      const messages = await readMessages(page, chatId);
      return [...messages].reverse().find((message) => message.role === "assistant")?.runId ?? null;
    }, { timeout: 15_000 }).toBeTruthy();
    const runningAssistant = [...await readMessages(page, chatId)].reverse()
      .find((message) => message.role === "assistant");
    expect(runningAssistant?.runId).toEqual(expect.any(String));

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 15_000 });
    const run = await waitForRun(page, runningAssistant!.runId!, "succeeded");
    await assertRunEvidence(page, run, chatId, organization);

    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chatId}`);
    await expect(page.getByTestId("chat-assistant-message").last()).toContainText(
      "Streaming reply for chat.",
      { timeout: 15_000 },
    );
    await expect(page.getByRole("button", { name: /Stopped/ })).toHaveCount(0);
  });

  test("preserves a failed attempt and retries the same work item successfully", async ({ page }) => {
    const retryStub = await createRetryOnceStub();
    try {
      const organization = await createSmokeOrganization(page, `Smoke-Retry-${Date.now()}`, retryStub);
      await openChat(page, organization);

      const task = "Retry this work item after the first runtime attempt fails.";
      const chatId = await sendTask(page, task);
      const failedMessage = page.getByTestId("chat-assistant-message")
        .filter({ hasText: "Code chat_adapter_failed" });
      await expect(failedMessage).toBeVisible({ timeout: WORK_LOOP_TIMEOUT });
      await expect(failedMessage).toContainText("Response failed");
      await expect(failedMessage.getByRole("button", { name: "Retry" })).toBeVisible();

      const failedMessages = await readMessages(page, chatId);
      const failedAssistant = [...failedMessages].reverse()
        .find((message) => message.role === "assistant");
      expect(failedAssistant).toMatchObject({
        status: "failed",
        runId: expect.any(String),
        replyingAgentId: organization.chatAgent.id,
        structuredPayload: {
          recoverableFailure: {
            action: "retry",
            code: "chat_adapter_failed",
            recoverable: true,
          },
        },
      });
      const failedRun = await waitForRun(page, failedAssistant!.runId!, "failed");
      expect(failedRun).toMatchObject({
        orgId: organization.id,
        agentId: organization.chatAgent.id,
        chatConversationId: chatId,
        resultJson: { outcome: "failed", retryable: true },
      });

      await failedMessage.getByRole("button", { name: "Retry" }).click();
      await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: task })).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByTestId("chat-assistant-message").last()).toContainText(
        "Streaming reply for chat.",
        { timeout: WORK_LOOP_TIMEOUT },
      );

      const messagesAfterRetry = await readMessages(page, chatId);
      const preservedFailure = messagesAfterRetry.find((message) => message.id === failedAssistant!.id);
      expect(preservedFailure).toMatchObject({
        status: "failed",
        runId: failedAssistant!.runId,
        supersededAt: expect.any(String),
      });
      const successfulAssistant = [...messagesAfterRetry].reverse()
        .find((message) => message.role === "assistant" && message.status === "completed");
      expect(successfulAssistant).toMatchObject({
        body: "Streaming reply for chat.",
        runId: expect.any(String),
        replyingAgentId: organization.chatAgent.id,
      });
      const retryRun = await waitForRun(page, successfulAssistant!.runId!, "succeeded");
      await assertRunEvidence(page, retryRun, chatId, organization);
      const preservedFailedRun = await waitForRun(page, failedAssistant!.runId!, "failed");
      expect(preservedFailedRun.resultJson).toMatchObject({ outcome: "failed", retryable: true });
      await expect(failedMessage).toHaveCount(0);
    } finally {
      await rm(dirname(retryStub), { recursive: true, force: true });
    }
  });
});
