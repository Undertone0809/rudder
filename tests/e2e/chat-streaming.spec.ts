import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import {
  E2E_BIN_DIR,
  E2E_CODEX_APP_SERVER_STUB,
  E2E_CODEX_STUB,
  E2E_DATABASE_URL,
  E2E_ROOT,
} from "./support/e2e-env";

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

async function createStreamingOrg(
  page: Page,
  name: string,
  options: { command?: string; agentRuntimeConfig?: Record<string, unknown> } = {},
) {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name,
    },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json();
  const chatAgent = await createE2EChatAgent(page.request, organization.id, {
    name: "Chat Agent",
    agentRuntimeConfig: options.agentRuntimeConfig ?? {
      model: "gpt-5.4",
      command: options.command ?? E2E_CODEX_STUB,
      chatAppServerEnabled: false,
    },
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

async function createTranscriptDeltaCodexStub() {
  const stubDir = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-chat-transcript-delta-"));
  const stubPath = path.join(stubDir, "codex");
  await fs.writeFile(stubPath, `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", async () => {
  const sentinel = input.match(/(__RUDDER_RESULT_[a-f0-9-]+__)/i)?.[1] ?? "__RUDDER_RESULT_TEST__";
  const send = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  send({ type: "thread.started", thread_id: "transcript-delta-e2e", model: "gpt-5.4" });
  send({ type: "item.completed", item: { id: "progress-1", type: "agent_message", text: "我", delta: true } });
  send({ type: "item.completed", item: { id: "progress-1", type: "agent_message", text: "会", delta: true } });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const finalText = "我会\\n" + sentinel + JSON.stringify({
    kind: "message",
    body: "最终答复",
    structuredPayload: null,
  });
  send({
    type: "item.completed",
    item: { id: "progress-1", type: "agent_message", text: finalText },
  });
  send({
    type: "turn.completed",
    result: finalText,
    usage: { input_tokens: 2, cached_input_tokens: 0, output_tokens: 2 },
  });
});
`, "utf8");
  await fs.chmod(stubPath, 0o755);
  return stubPath;
}

async function createStopCodexStub() {
  await fs.mkdir(E2E_BIN_DIR, { recursive: true });
  const stubPath = path.join(E2E_BIN_DIR, `codex-stop-${randomUUID()}`);
  await fs.writeFile(stubPath, `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.on("SIGTERM", () => process.exit(0));
process.stdin.on("end", async () => {
  const sentinel = input.match(/(__RUDDER_RESULT_[a-f0-9-]+__)/i)?.[1] ?? "__RUDDER_RESULT_TEST__";
  const partialBody = "Partial reply preserved before Stop.";
  const finalBody = "Partial reply preserved before Stop. Final reply after the stop window.";
  const finalText = finalBody + "\\n" + sentinel + JSON.stringify({
    kind: "message",
    body: finalBody,
    structuredPayload: null,
  });
  const send = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  send({ type: "thread.started", thread_id: "stop-e2e", model: "gpt-5.4" });
  send({
    type: "item.completed",
    item: { id: "reason-1", type: "reasoning", text: "Inspecting current chat state" },
  });
  send({
    type: "item.started",
    item: { type: "tool_use", id: "tool-1", name: "command_execution", input: { command: "echo chat" } },
  });
  send({
    type: "item.completed",
    item: { type: "tool_result", tool_use_id: "tool-1", content: "TRANSCRIPT_TOOL_OUTPUT_E2E", status: "completed" },
  });
  send({
    type: "item.completed",
    item: { id: "partial-message", type: "agent_message", text: partialBody, delta: true },
  });
  send({
    type: "item.completed",
    item: { id: "partial-barrier", type: "reasoning", text: "Partial output is ready for Stop" },
  });
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  send({ type: "item.completed", item: { id: "final-message", type: "agent_message", text: finalText } });
  send({
    type: "turn.completed",
    result: finalText,
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
  });
});
`, "utf8");
  await fs.chmod(stubPath, 0o755);
  return stubPath;
}

async function createLargeTranscriptCodexStub(entryCount = 1_000) {
  const stubDir = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-chat-large-transcript-"));
  const stubPath = path.join(stubDir, "codex");
  await fs.writeFile(stubPath, `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const sentinel = input.match(/(__RUDDER_RESULT_[a-f0-9-]+__)/i)?.[1] ?? "__RUDDER_RESULT_TEST__";
  const send = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  send({ type: "thread.started", thread_id: "large-transcript-e2e", model: "gpt-5.4" });
  for (let index = 0; index < ${entryCount}; index += 1) {
    send({
      type: "item.completed",
      item: {
        id: "reason-" + index,
        type: "reasoning",
        text: "production-shaped reasoning " + index + " " + "x".repeat(1050),
      },
    });
  }
  const body = "Ledger-backed long transcript completed.";
  const finalText = body + "\\n" + sentinel + JSON.stringify({
    kind: "message",
    body,
    structuredPayload: null,
  });
  send({
    type: "item.completed",
    item: { id: "final-message", type: "agent_message", text: finalText },
  });
  send({
    type: "turn.completed",
    result: finalText,
    usage: { input_tokens: 2, cached_input_tokens: 0, output_tokens: 2 },
  });
});
`, "utf8");
  await fs.chmod(stubPath, 0o755);
  return stubPath;
}

async function createNulTranscriptCodexStub() {
  const stubDir = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-chat-nul-transcript-"));
  const stubPath = path.join(stubDir, "codex");
  await fs.writeFile(stubPath, `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const sentinel = input.match(/(__RUDDER_RESULT_[a-f0-9-]+__)/i)?.[1] ?? "__RUDDER_RESULT_TEST__";
  const send = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  send({ type: "thread.started", thread_id: "nul-transcript-e2e", model: "gpt-5.4" });
  send({
    type: "item.started",
    item: { type: "tool_use", id: "nul-tool", name: "command_execution", input: { command: "inspect archive" } },
  });
  send({
    type: "item.completed",
    item: {
      type: "tool_result",
      tool_use_id: "nul-tool",
      content: "archive\\u0000binary\\u0000tail",
      status: "completed",
    },
  });
  const body = "NUL transcript completed.";
  const finalText = body + "\\n" + sentinel + JSON.stringify({
    kind: "message",
    body,
    structuredPayload: null,
  });
  send({ type: "item.completed", item: { id: "final-message", type: "agent_message", text: finalText } });
  send({
    type: "turn.completed",
    result: finalText,
    usage: { input_tokens: 2, cached_input_tokens: 0, output_tokens: 2 },
  });
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

  test("does not expose persisted provider protocol envelopes in the process transcript", async ({ page }) => {
    const organization = await createStreamingOrg(page, `Private-Transcript-${Date.now()}`);
    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Provider protocol privacy",
        preferredAgentId: organization.chatAgent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
        initialMessage: {
          body: "Show the user-facing answer without private runtime data.",
        },
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json();
    const assistantMessageId = randomUUID();
    const rawProviderEnvelope = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        model: "gpt-5.6-sol",
        content: [{
          type: "redacted_thinking",
          data: "ccswitch-openai-reasoning-v1:opaque-private-payload",
        }],
      },
      session_id: "session-private",
      uuid: randomUUID(),
      timestamp: "2026-07-21T05:37:13.286Z",
    });

    await e2eDb.insert(chatMessages).values({
      id: assistantMessageId,
      orgId: organization.id,
      conversationId: chat.id,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "The user-facing answer remains readable.",
      structuredPayload: {
        __chatTranscript: [
          {
            kind: "stdout",
            ts: "2026-07-21T05:37:13.286Z",
            text: rawProviderEnvelope,
          },
          {
            kind: "assistant",
            ts: "2026-07-21T05:37:14.286Z",
            text: "Readable progress remains visible.",
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
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

    const assistantMessage = page.getByTestId("chat-assistant-message").last();
    await expect(assistantMessage).toContainText("The user-facing answer remains readable.", {
      timeout: 15_000,
    });
    const transcriptToggle = page.getByRole("button", { name: /Worked for/ }).last();
    await expect(transcriptToggle).toBeVisible({ timeout: 15_000 });
    await transcriptToggle.click();

    const transcriptItem = page.getByTestId("chat-transcript-item").last();
    await expect(transcriptItem.getByText("Readable progress remains visible.", { exact: false }))
      .toBeVisible({ timeout: 15_000 });
    await expect(transcriptItem).not.toContainText("ccswitch-openai-reasoning-v1");
    await expect(transcriptItem).not.toContainText("opaque-private-payload");
    await expect(transcriptItem).not.toContainText("redacted_thinking");
    await expect(transcriptItem).not.toContainText("session-private");
    await expect(transcriptItem).not.toContainText('{"type":"assistant"');
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

  test("clears composer loading before slow message reconciliation completes", async ({ page }) => {
    const organization = await createStreamingOrg(
      page,
      `Load-Chat-${Date.now()}`,
      {
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_APP_SERVER_STUB,
          chatAppServerEnabled: true,
        },
      },
    );
    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Final before refresh",
        preferredAgentId: organization.chatAgent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
        initialMessage: {
          body: "Seed the chat before testing final reconciliation.",
        },
      },
    });
    const chatPayload = await chatRes.json() as { id?: string; error?: string };
    expect(chatRes.ok(), JSON.stringify(chatPayload)).toBe(true);
    const chat = chatPayload as { id: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

    let streamStarted = false;
    let refreshStarted = false;
    let refreshCompleted = false;
    let releaseMessagesRefresh!: () => void;
    const messagesRefreshGate = new Promise<void>((resolve) => {
      releaseMessagesRefresh = resolve;
    });
    await page.route(`**/api/chats/${chat.id}/messages**`, async (route) => {
      const shouldHold = route.request().method() === "GET" && streamStarted && !refreshStarted;
      if (shouldHold) {
        refreshStarted = true;
        await messagesRefreshGate;
      }
      await route.continue();
      if (shouldHold) refreshCompleted = true;
    });

    const streamRequest = page.waitForRequest((request) => (
      request.method() === "POST"
      && new URL(request.url()).pathname === `/api/chats/${chat.id}/messages/stream`
    ));
    const editor = page.locator(".rudder-mdxeditor-content").first();
    await expect(editor).toBeVisible({ timeout: 15_000 });
    await editor.fill("Complete fragmented commentary");
    await page.getByRole("button", { name: "Send" }).click();
    await streamRequest;
    streamStarted = true;

    await expect(page.getByTestId("chat-assistant-message").last()).toContainText(
      "Fragmented commentary completed.",
      { timeout: 15_000 },
    );
    await expect.poll(() => refreshStarted, { timeout: 15_000 }).toBe(true);
    expect(refreshCompleted).toBe(false);

    const sendButton = page.getByRole("button", { name: "Send" });
    const composerSurface = page.locator(".chat-composer").first();
    await expect(sendButton).toBeVisible({ timeout: 15_000 });
    await expect(sendButton).not.toHaveAttribute("aria-busy", "true");
    await expect(composerSurface).not.toHaveClass(/chat-composer--streaming/);

    releaseMessagesRefresh();
    await expect.poll(() => refreshCompleted, { timeout: 15_000 }).toBe(true);
  });

  test("completes and reloads when tool output contains NUL characters", async ({ page }) => {
    const stubPath = await createNulTranscriptCodexStub();
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `NUL-Transcript-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const chatAgent = await createE2EChatAgent(page.request, organization.id, {
      name: "NUL Transcript Agent",
      command: stubPath,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/chat?agentId=${chatAgent.id}`);

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await composer.fill("Inspect an archive containing binary output");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("chat-assistant-message").last()).toContainText(
      "NUL transcript completed.",
      { timeout: 30_000 },
    );
    await expect(page.getByText("The assistant reply could not be completed.", { exact: false })).toHaveCount(0);

    const transcriptEvents = await e2eDb.query.chatGenerationEvents.findMany({
      where: (table, { and, eq }) => and(
        eq(table.orgId, organization.id),
        eq(table.eventKind, "transcript"),
      ),
    });
    const toolResult = transcriptEvents
      .map((event) => event.payload?.entry)
      .find((entry) => (
        entry
        && typeof entry === "object"
        && (entry as Record<string, unknown>).kind === "tool_result"
      )) as Record<string, unknown> | undefined;
    expect(toolResult?.content).toBe("archive\uFFFDbinary\uFFFDtail");

    const runEvents = await e2eDb.query.heartbeatRunEvents.findMany({
      where: (table, { and, eq }) => and(
        eq(table.orgId, organization.id),
        eq(table.eventType, "transcript.entry"),
      ),
    });
    const runToolResult = runEvents
      .map((event) => event.payload)
      .find((payload) => payload?.kind === "tool_result");
    expect(runToolResult?.content).toBe("archive\uFFFDbinary\uFFFDtail");

    await page.reload();
    await expect(page.getByTestId("chat-assistant-message").last()).toContainText(
      "NUL transcript completed.",
      { timeout: 15_000 },
    );
  });

  test("completes and reloads a production-shaped long transcript without embedding it in the message", async ({ page }) => {
    test.setTimeout(240_000);
    const stubPath = await createLargeTranscriptCodexStub();
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Large-Transcript-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const chatAgent = await createE2EChatAgent(page.request, organization.id, {
      name: "Large Transcript Agent",
      command: stubPath,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/chat?agentId=${chatAgent.id}`);

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await composer.fill("Produce a production-shaped long transcript");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("chat-assistant-message").last()).toContainText(
      "Ledger-backed long transcript completed.",
      { timeout: 200_000 },
    );
    await expect(page.getByText("The assistant reply could not be completed.", { exact: false })).toHaveCount(0);

    const chatId = currentChatId(page.url());
    const assistantMessage = await e2eDb.query.chatMessages.findFirst({
      where: (table, { and, eq }) => and(
        eq(table.conversationId, chatId),
        eq(table.role, "assistant"),
      ),
    });
    expect(assistantMessage).toBeTruthy();
    expect(assistantMessage?.structuredPayload?.__chatTranscript).toBeUndefined();

    const transcriptEvents = await e2eDb.query.chatGenerationEvents.findMany({
      columns: { id: true },
      where: (table, { and, eq }) => and(
        eq(table.assistantMessageId, assistantMessage!.id),
        eq(table.eventKind, "transcript"),
      ),
    });
    expect(transcriptEvents.length).toBeGreaterThanOrEqual(1_000);

    const transcriptRes = await page.request.get(
      `/api/chats/${chatId}/messages/${assistantMessage!.id}/transcript`,
    );
    expect(transcriptRes.ok()).toBe(true);
    const transcriptPayload = await transcriptRes.json() as { transcript: unknown[] };
    expect(transcriptPayload.transcript.length).toBeGreaterThanOrEqual(1_000);

    await page.reload();
    await expect(page.getByTestId("chat-assistant-message").last()).toContainText(
      "Ledger-backed long transcript completed.",
      { timeout: 30_000 },
    );
    await expect(page.getByRole("button", { name: /Worked for/ }).last()).toBeVisible();
  });

  test("renders each live Work Transcript delta once", async ({ page }) => {
    const stubPath = await createTranscriptDeltaCodexStub();
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Transcript-Delta-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const chatAgent = await createE2EChatAgent(page.request, organization.id, {
      name: "Transcript Delta Agent",
      command: stubPath,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/chat?agentId=${chatAgent.id}`);

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("Show two streamed progress tokens");
    await page.getByRole("button", { name: "Send" }).click();

    const transcriptItem = page.getByTestId("chat-transcript-item").last();
    await expect(transcriptItem).toContainText("我会", { timeout: 15_000 });
    await expect(transcriptItem).not.toContainText("我会会");
    await transcriptItem.screenshot({ path: "/tmp/rudder-live-transcript-no-duplicates.png" });
    await expect(page.getByTestId("chat-assistant-message").last()).toContainText("最终答复", {
      timeout: 15_000,
    });
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

  test("keeps the chat composer boundary static while an agent response is streaming", async ({ page }, testInfo: TestInfo) => {
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

    const streamingBoundary = await composerSurface.evaluate((element) => {
      const before = getComputedStyle(element, "::before");
      const after = getComputedStyle(element, "::after");
      return {
        beforeContent: before.content,
        beforeFilter: before.filter,
        afterContent: after.content,
        afterFilter: after.filter,
      };
    });
    expect(streamingBoundary).toEqual({
      beforeContent: "none",
      beforeFilter: "none",
      afterContent: "none",
      afterFilter: "none",
    });

    const frameSamples = await composerSurface.evaluate(async (element) => {
      const samples: Array<{ borderColor: string; boxShadow: string }> = [];
      for (let index = 0; index < 90; index += 1) {
        const style = getComputedStyle(element);
        samples.push({
          borderColor: style.borderColor,
          boxShadow: style.boxShadow,
        });
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      return samples;
    });
    expect(new Set(frameSamples.map((sample) => sample.borderColor)).size).toBe(1);
    expect(new Set(frameSamples.map((sample) => sample.boxShadow)).size).toBe(1);

    await editor.blur();
    const lightFrameA = await composerSurface.screenshot({
      path: testInfo.outputPath("chat-composer-streaming-light.png"),
    });
    await page.waitForTimeout(800);
    await expect(composerSurface).toHaveClass(/chat-composer--streaming/);
    const lightFrameB = await composerSurface.screenshot({
      path: testInfo.outputPath("chat-composer-streaming-light-after-refresh.png"),
    });
    expect(lightFrameB.equals(lightFrameA)).toBe(true);

    await page.evaluate(() => {
      window.localStorage.setItem("rudder.theme", "dark");
      document.documentElement.classList.add("dark");
    });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await composerSurface.screenshot({ path: testInfo.outputPath("chat-composer-streaming-dark.png") });
    const darkStreamingLayers = await composerSurface.evaluate((element) => ({
      before: getComputedStyle(element, "::before").content,
      after: getComputedStyle(element, "::after").content,
    }));
    expect(darkStreamingLayers).toEqual({ before: "none", after: "none" });

    await page.getByRole("button", { name: "Stop streaming" }).click();
    await expect(page.getByText("Response stopped")).toBeVisible({ timeout: 15_000 });
    await expect(composerSurface).not.toHaveClass(/chat-composer--streaming/, { timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 15_000 });
    await composerSurface.screenshot({ path: testInfo.outputPath("chat-composer-idle-after-stop.png") });
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
    const stopStub = await createStopCodexStub();
    const organization = await createStreamingOrg(page, `Stp-Chat-${Date.now()}`, { command: stopStub });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/chat?agentId=${organization.chatAgent.id}`);

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("Stop this reply");
    await page.getByRole("button", { name: "Send" }).click();

    await expect.poll(() => new URL(page.url()).pathname.split("/").pop() ?? "", { timeout: 15_000 }).not.toBe("chat");
    const partialBody = "Partial reply preserved before Stop.";
    const finalBody = "Partial reply preserved before Stop. Final reply after the stop window.";
    await expect(page.getByRole("button", { name: "Stop streaming" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Partial output is ready for Stop", { exact: false })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Stop streaming" }).click();

    await expect(page.getByText("Response stopped")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /Worked for .*Stopped/ })).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(800);
    await page.reload();

    await expectTranscriptBetweenUserAndAssistant(page);
    const transcriptToggle = page.getByRole("button", { name: /Worked for .*Stopped/ }).last();
    await expect(transcriptToggle).toBeVisible({ timeout: 15_000 });
    await transcriptToggle.click();
    const transcriptItem = page.getByTestId("chat-transcript-item").last();
    await expect(transcriptItem.getByText("Model turn", { exact: false })).toHaveCount(0);
    await expect(transcriptItem.getByText("Inspecting current chat state", { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(transcriptItem.getByText(partialBody, { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(finalBody, { exact: false })).toHaveCount(0);
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
