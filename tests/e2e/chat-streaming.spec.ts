import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB, E2E_DATABASE_URL, E2E_ROOT } from "./support/e2e-env";

const E2E_CODEX_IGNORE_TERM_STUB = path.resolve(E2E_ROOT, "fixtures", "codex-ignore-term");
const e2eDb = createDb(E2E_DATABASE_URL);

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
    },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json();
  const chatAgent = await createE2EChatAgent(page.request, organization.id, {
    name: "Chat Agent",
    command: E2E_CODEX_STUB,
  });
  return { ...organization, chatAgent };
}

async function createStreamingOrgThatIgnoresStop(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name,
    },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json();
  const chatAgent = await createE2EChatAgent(page.request, organization.id, {
    name: "Chat Agent",
    agentRuntimeConfig: {
      model: "gpt-5.4",
      command: E2E_CODEX_IGNORE_TERM_STUB,
      graceSec: 1,
    },
  });
  return { ...organization, chatAgent };
}

async function createMissingSentinelCodexStub() {
  const stubPath = path.resolve(E2E_ROOT, "fixtures", `codex-missing-sentinel-${Date.now()}`);
  await fs.mkdir(path.dirname(stubPath), { recursive: true });
  await fs.writeFile(stubPath, `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk.toString();
});
process.stdin.on("end", () => {
  const match = input.match(/(__RUDDER_RESULT_[a-f0-9-]+__)/i);
  const sentinel = match ? match[1] : "__RUDDER_RESULT_TEST__";
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "missing-sentinel-e2e", model: "gpt-5.4" }) + "\\n");
  if (input.includes("Rudder internal repair request:")) {
    process.stdout.write(JSON.stringify({
      type: "turn.completed",
      result: sentinel + JSON.stringify({
        kind: "message",
        body: "Recovered after internal sentinel repair.",
        structuredPayload: null,
      }),
      usage: { input_tokens: 8, cached_input_tokens: 0, output_tokens: 7 },
    }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({
    type: "turn.completed",
    result: "Plain-text reply without the Rudder sentinel.",
    usage: { input_tokens: 3, cached_input_tokens: 0, output_tokens: 5 },
  }) + "\\n");
});
`, "utf8");
  await fs.chmod(stubPath, 0o755);
  return stubPath;
}

function currentChatId(pageUrl: string) {
  const chatId = new URL(pageUrl).pathname.split("/").pop();
  expect(chatId).toBeTruthy();
  return chatId!;
}

test.describe("Chat streaming", () => {
  test("replays persisted assistant progress without duplicating the final answer in the process transcript", async ({ page }) => {
    const organization = await createStreamingOrg(page, `Persisted-Chat-${Date.now()}`);
    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Persisted transcript replay",
        preferredAgentId: organization.chatAgent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json();
    const assistantMessageId = randomUUID();

    await e2eDb.insert(chatMessages).values({
      id: assistantMessageId,
      orgId: organization.id,
      conversationId: chat.id,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Final answer shown in the assistant message.",
      structuredPayload: {
        __chatTranscript: [
          {
            kind: "system",
            ts: "2026-05-11T03:00:00.000Z",
            text: "turn started",
          },
          {
            kind: "assistant",
            ts: "2026-05-11T03:00:01.000Z",
            text: "I am checking the chat surface first.",
          },
          {
            kind: "todo_list",
            ts: "2026-05-11T03:00:02.000Z",
            items: [
              { text: "Inspect chat transcript", status: "completed" },
              { text: "Replay progress", status: "in_progress" },
            ],
          },
          {
            kind: "assistant",
            ts: "2026-05-11T03:00:03.000Z",
            text: "Final answer shown ",
            delta: true,
          },
          {
            kind: "assistant",
            ts: "2026-05-11T03:00:04.000Z",
            text: "in the assistant message.",
            delta: true,
          },
        ],
      },
      replyingAgentId: organization.chatAgent.id,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    const lightweightMessagesResponse = page.waitForResponse((response) =>
      response.request().method() === "GET"
      && response.url().includes(`/api/chats/${chat.id}/messages?includeTranscript=false`),
    );
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);
    const lightweightMessages = await (await lightweightMessagesResponse).json();
    expect(lightweightMessages[0].transcript).toBeUndefined();
    expect(lightweightMessages[0].transcriptSummary).toMatchObject({ entryCount: 5 });
    expect(lightweightMessages[0].structuredPayload).toBeNull();

    await expect(page.getByTestId("chat-assistant-message").last()).toContainText(
      "Final answer shown in the assistant message.",
      { timeout: 15_000 },
    );
    const transcriptToggle = page.getByRole("button", { name: /Worked for/ }).last();
    await expect(transcriptToggle).toBeVisible({ timeout: 15_000 });

    const lazyTranscriptResponse = page.waitForResponse((response) =>
      response.request().method() === "GET"
      && response.url().includes(`/api/chats/${chat.id}/messages/${assistantMessageId}/transcript`),
    );
    await transcriptToggle.click();
    const lazyTranscript = await (await lazyTranscriptResponse).json();
    expect(lazyTranscript.transcript).toHaveLength(5);

    const transcriptItem = page.getByTestId("chat-transcript-item").last();
    await expect(transcriptItem.getByText("I am checking the chat surface first.", { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(transcriptItem.getByText("Inspect chat transcript", { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(transcriptItem.getByText("Final answer shown in the assistant message.", { exact: false })).toHaveCount(0);
  });

  test("streams a codex reply through to completion", async ({ page }) => {
    const organization = await createStreamingOrg(page, `Str-Chat-${Date.now()}`);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/chat?agentId=${organization.chatAgent.id}`);

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("Stream this reply");
    await page.getByRole("button", { name: "Send" }).click();

    const assistantReply = page.getByText("Streaming reply for chat.", { exact: false }).first();
    await expect(page.getByRole("button", { name: "Stop streaming" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Streaming reply", { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(assistantReply).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 15_000 });
    const completedTranscriptToggle = page.getByRole("button", { name: /Worked for/ }).last();
    await expect(completedTranscriptToggle).toBeVisible({ timeout: 15_000 });
    const completedTranscriptItem = page.getByTestId("chat-transcript-item").last();
    await expect(completedTranscriptItem).not.toContainText(/Run [0-9a-f]{8}/i);
    await completedTranscriptToggle.click();
    await expect(completedTranscriptItem.getByText("Inspecting current chat state", { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("chat-assistant-message").filter({ hasText: "Streaming reply for chat." })).toHaveCount(1);
    await expect(page.getByTestId("chat-transcript-item")).toHaveCount(1);

    await page.reload();
    await expect(page.getByText("Streaming reply for chat.", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    await expectTranscriptBetweenUserAndAssistant(page);
    const transcriptToggle = page.getByRole("button", { name: /Worked for/ }).last();
    await expect(transcriptToggle).toBeVisible({ timeout: 15_000 });
    await transcriptToggle.click();
    const transcriptItem = page.getByTestId("chat-transcript-item").last();
    await expect(transcriptItem.getByText("Model turn", { exact: false })).toHaveCount(0);
    await expect(transcriptItem.getByText("Inspecting current chat state", { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(transcriptItem.getByText("Streaming reply for chat.", { exact: false })).toHaveCount(0);
    await expect(transcriptItem.locator('button[aria-label^="Expand tool activity"]')).toHaveCount(0);
    await expect(transcriptItem.getByText("Ran echo chat", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    await expect(transcriptItem.getByText("Activity details", { exact: false })).toHaveCount(0);
    await expect(transcriptItem.getByText("TRANSCRIPT_TOOL_OUTPUT_E2E", { exact: false })).toHaveCount(0);
    await expect(transcriptItem.getByText("Command activity", { exact: false })).toHaveCount(0);
    await expect(transcriptItem.getByText("Ran echo chat", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    await expect(transcriptItem.locator('button[aria-label="Expand command details"]').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/__RUDDER_RESULT_/)).toHaveCount(0);
    await expect(page.getByText(/"kind":"message"/)).toHaveCount(0);
  });

  test("internally repairs a successful chat reply when the runtime omits the Rudder sentinel", async ({ page }) => {
    const missingSentinelStub = await createMissingSentinelCodexStub();
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Missing-Sentinel-Chat-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const chatAgent = await createE2EChatAgent(page.request, organization.id, {
      name: "Missing Sentinel Agent",
      command: missingSentinelStub,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/chat?agentId=${chatAgent.id}`);

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("Return plain text without the sentinel");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByTestId("chat-assistant-message").last()).toContainText(
      "Recovered after internal sentinel repair.",
      { timeout: 15_000 },
    );
    await expect(page.getByText("The assistant finished without a final Rudder reply", { exact: false })).toHaveCount(0);
    await expect(page.getByText("chat_result_missing_sentinel", { exact: false })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 15_000 });

    const chatId = currentChatId(page.url());
    const messagesRes = await page.request.get(`/api/chats/${chatId}/messages`);
    expect(messagesRes.ok()).toBe(true);
    const messages = await messagesRes.json() as Array<{ role: string; body: string; runId: string | null }>;
    const assistantMessage = [...messages].reverse().find((message) => message.role === "assistant");
    expect(assistantMessage?.body).toBe("Recovered after internal sentinel repair.");
    expect(assistantMessage?.runId).toBeTruthy();

    const run = await e2eDb.query.heartbeatRuns.findFirst({
      where: (table, { eq }) => eq(table.id, assistantMessage!.runId!),
    });
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
    expect(run?.resultJson).toMatchObject({
      outcome: "completed",
      kind: "message",
      sentinelRepairAttempted: true,
      sentinelRepairSucceeded: true,
      repairReason: "missing_result_sentinel",
    });
  });

  test("highlights the chat composer boundary while an agent response is streaming", async ({ page }) => {
    const organization = await createStreamingOrg(page, `Ring-Chat-${Date.now()}`);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/chat?agentId=${organization.chatAgent.id}`);

    const editor = page.locator(".rudder-mdxeditor-content").first();
    const composerSurface = page.locator(".chat-composer").first();
    await expect(editor).toBeVisible({ timeout: 15_000 });
    await editor.fill("Show the streaming composer ring");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByRole("button", { name: "Stop streaming" })).toBeVisible({ timeout: 15_000 });
    await expect(composerSurface).toHaveClass(/chat-composer--streaming/, { timeout: 15_000 });

    await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 15_000 });
    await expect(composerSurface).not.toHaveClass(/chat-composer--streaming/, { timeout: 15_000 });
  });

  test("keeps generating when the operator leaves the chat page", async ({ page }) => {
    const organization = await createStreamingOrg(page, `Leave-Chat-${Date.now()}`);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/chat?agentId=${organization.chatAgent.id}`);

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("Keep running after navigation");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByRole("button", { name: "Stop streaming" })).toBeVisible({ timeout: 15_000 });
    const chatId = currentChatId(page.url());

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 15_000 });
    const dashboardRunPreview = page.locator(".dashboard-run-preview").first();
    await expect(dashboardRunPreview).toBeVisible({ timeout: 15_000 });
    await expect(dashboardRunPreview).toContainText("for chat.", { timeout: 15_000 });
    await expect(dashboardRunPreview).not.toContainText("chat transcript entry");

    await expect.poll(async () => {
      const messagesRes = await page.request.get(`/api/chats/${chatId}/messages`);
      expect(messagesRes.ok()).toBe(true);
      const messages = await messagesRes.json();
      return messages.find((message: { role: string }) => message.role === "assistant")?.status ?? null;
    }, { timeout: 15_000 }).toBe("completed");

    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chatId}`);
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

    await page.goto(`/chat?agentId=${organization.chatAgent.id}`);

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("Stop this reply");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText("Streaming reply", { exact: false })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Stop streaming" }).click();

    await expect(page.getByText("Response stopped")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /Worked for .*Stopped/ })).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(800);
    await page.reload();

    await expect(page.getByText("Streaming reply", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    await expectTranscriptBetweenUserAndAssistant(page);
    const transcriptToggle = page.getByRole("button", { name: /Worked for .*Stopped/ }).last();
    await expect(transcriptToggle).toBeVisible({ timeout: 15_000 });
    await transcriptToggle.click();
    const transcriptItem = page.getByTestId("chat-transcript-item").last();
    await expect(transcriptItem.getByText("Model turn", { exact: false })).toHaveCount(0);
    await expect(transcriptItem.getByText("Inspecting current chat state", { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(transcriptItem.locator('button[aria-label^="Expand tool activity"]')).toHaveCount(0);
    await expect(transcriptItem.getByText("Ran echo chat", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    await expect(transcriptItem.getByText("TRANSCRIPT_TOOL_OUTPUT_E2E", { exact: false })).toHaveCount(0);
    await expect(page.getByText("Streaming reply for chat.", { exact: false })).toHaveCount(0);
    await expect(page.getByText(/__RUDDER_RESULT_/)).toHaveCount(0);
    await expect(page.getByText(/"kind":"message"/)).toHaveCount(0);
  });

  test("marks preserved streaming progress interrupted after restart and can continue", async ({ page }) => {
    const organization = await createStreamingOrg(page, `Recover-Chat-${Date.now()}`);

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Interrupted progress recovery",
        preferredAgentId: organization.chatAgent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json();

    const chatTurnId = randomUUID();
    const userCreatedAt = new Date(Date.now() - 2_000);
    const assistantCreatedAt = new Date(Date.now() - 1_000);
    await e2eDb.insert(chatMessages).values([
      {
        id: randomUUID(),
        orgId: organization.id,
        conversationId: chat.id,
        role: "user",
        kind: "message",
        status: "completed",
        body: "Original interrupted request",
        chatTurnId,
        turnVariant: 0,
        createdAt: userCreatedAt,
        updatedAt: userCreatedAt,
      },
      {
        id: randomUUID(),
        orgId: organization.id,
        conversationId: chat.id,
        role: "assistant",
        kind: "message",
        status: "streaming",
        body: "Partial preserved reply",
        structuredPayload: {
          __chatTranscript: [
            {
              kind: "thinking",
              ts: assistantCreatedAt.toISOString(),
              text: "Preserved recovery transcript",
            },
          ],
        },
        replyingAgentId: organization.chatAgent.id,
        chatTurnId,
        turnVariant: 0,
        createdAt: assistantCreatedAt,
        updatedAt: assistantCreatedAt,
      },
    ]);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

    await expect(page.getByTestId("chat-assistant-message").filter({ hasText: "Partial preserved reply" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("Interrupted", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Continue" })).toBeVisible({ timeout: 15_000 });
    const messagesRes = await page.request.get(`/api/chats/${chat.id}/messages`);
    expect(messagesRes.ok()).toBe(true);
    const messages = await messagesRes.json();
    expect(messages.find((message: { role: string }) => message.role === "assistant")?.status).toBe("interrupted");

    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: "Continue from the interrupted chat run." })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("chat-assistant-message").last()).toContainText("Streaming reply for chat.", {
      timeout: 15_000,
    });
  });

  test("recovers the composer after stopping a stubborn chat run", async ({ page }) => {
    const organization = await createStreamingOrgThatIgnoresStop(page, `Stubborn-Chat-${Date.now()}`);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/chat?agentId=${organization.chatAgent.id}`);

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
