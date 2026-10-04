import { expect, test } from "@playwright/test";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_BASE_URL, E2E_CODEX_APP_SERVER_STUB, E2E_CODEX_ERROR_STUB, E2E_DB_PORT, E2E_INSTANCE_ROOT, E2E_ROOT } from "./support/e2e-env";

const ORG_NAME = `Err-Chat-${Date.now()}`;

async function createRetryableFailureStub(outputDir: string) {
  const dir = join(outputDir, "codex-retry-wrapper");
  await mkdir(dir, { recursive: true });
  const scriptPath = join(dir, "codex-retry-once.sh");
  const counterPath = join(dir, "attempts");
  const invocationPath = join(dir, "invocations");
  await writeFile(scriptPath, `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${invocationPath}"
case " $* " in
  *" --version "*|*" generate-json-schema "*) exec "${E2E_CODEX_APP_SERVER_STUB}" "$@" ;;
esac
counter="${counterPath}"
attempt=0
if [ -f "$counter" ]; then
  attempt="$(cat "$counter")"
fi
attempt=$((attempt + 1))
printf '%s' "$attempt" > "$counter"
if [ "$attempt" -eq 1 ]; then
  export RUDDER_E2E_CODEX_FAIL_TURN=1
fi
exec "${E2E_CODEX_APP_SERVER_STUB}" "$@"
`);
  await chmod(scriptPath, 0o755);
  return { scriptPath, counterPath, invocationPath };
}

async function createAskUserWithoutPayloadStub() {
  const dir = await mkdtemp(join(tmpdir(), "rudder-chat-ask-user-fallback-"));
  const scriptPath = join(dir, "codex-ask-user-without-payload.js");
  const protocolLogPath = join(dir, "protocol.jsonl");
  await writeFile(scriptPath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const args = process.argv.slice(2);
const protocolLogPath = ${JSON.stringify(protocolLogPath)};
const record = (entry) => fs.appendFileSync(protocolLogPath, JSON.stringify(entry) + "\\n", "utf8");
record({ kind: "invocation", args });

if (args.includes("--version")) {
  process.stdout.write("codex-cli 0.155.0\\n");
  process.exit(0);
}
if (args.includes("generate-json-schema")) {
  const outputIndex = args.indexOf("--out");
  const outputDir = args[outputIndex + 1];
  if (!outputDir) process.exit(2);
  fs.mkdirSync(outputDir, { recursive: true });
  const methods = ["thread/start", "thread/resume", "thread/read", "turn/start", "turn/interrupt"];
  fs.writeFileSync(path.join(outputDir, "ClientRequest.json"), JSON.stringify({
    oneOf: methods.map((method) => ({ properties: { method: { const: method } } })),
  }));
  process.exit(0);
}
if (args[0] !== "app-server" || !args.includes("--stdio")) process.exit(2);

const threadId = "ask-user-fallback-e2e";
const turnId = "ask-user-fallback-turn-e2e";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  record({ kind: "request", method: request.method });
  if (request.method === "initialized") return;
  if (request.method === "initialize") {
    send({ id: request.id, result: { userAgent: "rudder-ask-user-fallback-e2e" } });
    return;
  }
  if (request.method === "thread/start" || request.method === "thread/resume") {
    send({ id: request.id, result: { thread: { id: threadId } } });
    return;
  }
  if (request.method === "thread/read") {
    send({ id: request.id, result: { thread: { id: threadId, turns: [] } } });
    return;
  }
  if (request.method === "turn/start") {
    const input = (request.params?.input ?? [])
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\\n");
    const sentinel = input.match(/(__RUDDER_RESULT_[a-f0-9-]+__)/i)?.[1] ?? "__RUDDER_RESULT_TEST__";
    const itemId = "ask-user-fallback-answer-e2e";
    const finalText = sentinel + JSON.stringify({
      kind: "ask_user",
      body: "Which topic should I explore for the briefing?",
    });
    send({ id: request.id, result: { turn: { id: turnId } } });
    send({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
    send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId, delta: finalText } });
    send({ method: "item/completed", params: {
      threadId,
      turnId,
      item: { type: "agentMessage", id: itemId, text: finalText, phase: "final_answer", memoryCitation: null },
    } });
    send({ method: "turn/completed", params: { threadId, turn: {
      id: turnId,
      items: [],
      itemsView: { type: "full" },
      status: "completed",
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
    } } });
    return;
  }
  if (request.id !== undefined) {
    send({ id: request.id, error: { code: -32601, message: "Unsupported fixture method: " + request.method } });
  }
});
`, "utf8");
  await chmod(scriptPath, 0o755);
  return { scriptPath, protocolLogPath };
}

test.describe("Chat error recovery", () => {
  test("shows an ask-user reply as a normal message when structured questions are missing", async ({ page }, testInfo) => {
    const askUserFallbackStub = await createAskUserWithoutPayloadStub();
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Ask-User-Fallback-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const chatAgent = await createE2EChatAgent(page.request, organization.id, {
      name: "Ask User Fallback Agent",
      command: askUserFallbackStub.scriptPath,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/messenger/chat?agentId=${chatAgent.id}`);
    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("Ask me which topic to explore");
    await page.getByRole("button", { name: "Send" }).click();

    const assistantMessage = page.getByTestId("chat-assistant-message").last();
    await expect(assistantMessage).toContainText("Which topic should I explore for the briefing?", {
      timeout: 15_000,
    });
    await expect(assistantMessage).not.toContainText("Response failed");
    await expect(assistantMessage).not.toContainText("chat_result_malformed_json");

    const chatId = page.url().match(/\/messenger\/chat\/([^/?#]+)/)?.[1];
    expect(chatId).toBeTruthy();
    type ChatMessage = {
      id: string;
      role: string;
      kind: string;
      status: string;
      body: string;
      structuredPayload: unknown;
      runId: string | null;
      chatTurnId: string | null;
    };
    const readMessages = async () => {
      const messagesRes = await page.request.get(`/api/chats/${chatId}/messages`);
      expect(messagesRes.ok()).toBe(true);
      return await messagesRes.json() as ChatMessage[];
    };
    await expect.poll(async () => {
      const messages = await readMessages();
      return messages.find((message) =>
        message.role === "assistant" && message.body === "Which topic should I explore for the briefing?") ?? null;
    }, { timeout: 15_000 }).toMatchObject({
      kind: "message",
      status: "completed",
      body: "Which topic should I explore for the briefing?",
      structuredPayload: null,
    });
    const messages = await readMessages();
    const completedAssistant = messages.find((message) => message.role === "assistant");
    expect(completedAssistant).toMatchObject({
      kind: "message",
      status: "completed",
      body: "Which topic should I explore for the briefing?",
      structuredPayload: null,
    });
    expect(completedAssistant?.id).toBeTruthy();
    expect(completedAssistant?.runId).toBeTruthy();
    expect(completedAssistant?.chatTurnId).toBeTruthy();

    const protocolLog = (await readFile(askUserFallbackStub.protocolLogPath, "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as { kind: string; args?: string[]; method?: string });
    const invocations = protocolLog.filter((entry) => entry.kind === "invocation");
    const requests = protocolLog.filter((entry) => entry.kind === "request");
    const hasInvocation = (matches: (args: string[]) => boolean) => invocations.some((entry) =>
      entry.args !== undefined && matches(entry.args));
    expect(hasInvocation((args) => args[0] === "--version")).toBe(true);
    expect(hasInvocation((args) => args.includes("generate-json-schema")
      && args.includes("--out") && !args.includes("--experimental"))).toBe(true);
    expect(hasInvocation((args) => args.includes("generate-json-schema") && args.includes("--experimental"))).toBe(true);
    expect(hasInvocation((args) => args[0] === "app-server" && args.includes("--stdio"))).toBe(true);
    expect(requests.map((entry) => entry.method)).toEqual(expect.arrayContaining([
      "initialize",
      "thread/start",
      "turn/start",
    ]));
    await testInfo.attach("ask-user-fallback-runtime-evidence.json", {
      body: Buffer.from(JSON.stringify({
        invocations: invocations.map((entry) => entry.args),
        appServerMethods: requests.map((entry) => entry.method),
        persistedAssistant: completedAssistant,
      }, null, 2)),
      contentType: "application/json",
    });
  });

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
    await expect(failedMessage.getByTestId("chat-long-message-body")).toHaveCount(0);
    await expect(failedMessage.getByRole("button", { name: "Copy message" })).toHaveCount(0);
    await expect(failedMessage.getByRole("button", { name: "Fork from here" })).toHaveCount(0);
    await expect(failedMessage.getByRole("button", { name: "Retry" })).toHaveCount(0);
    await expect(page.getByText("The assistant hit a system-level issue.", { exact: false })).toHaveCount(0);
    await expect(page.getByText("Failed to send message")).toHaveCount(0);
    await expect(page.getByText("Missing optional dependency @openai/codex-darwin-arm64", { exact: false }))
      .toHaveCount(0);
    await expect(page.getByText("file:///stub/codex.js:100")).toHaveCount(0);
  });

  test("lets the operator retry a failed assistant reply", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const retryableFailureStub = await createRetryableFailureStub(testInfo.outputDir);
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Retry-Chat-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const chatAgent = await createE2EChatAgent(page.request, organization.id, {
      name: "Retry Agent",
      agentRuntimeConfig: {
        model: "gpt-5.4",
        command: retryableFailureStub.scriptPath,
        chatAppServerEnabled: true,
      },
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat?agentId=${chatAgent.id}`);
    const organizationPath = organization.urlKey;

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("Please retry this failed request");
    await page.getByRole("button", { name: "Send" }).click();

    const failedMessage = page.getByTestId("chat-assistant-message")
      .filter({ hasText: "Code chat_adapter_failed" });
    await expect(failedMessage).toBeVisible({ timeout: 45_000 });
    await expect(failedMessage).toContainText("Response failed");
    await expect(failedMessage).toContainText("The assistant runtime failed before finishing.");
    await expect(failedMessage).toContainText("Code chat_adapter_failed");
    await expect(failedMessage.getByTestId("chat-long-message-body")).toHaveCount(0);
    await expect(failedMessage.getByRole("button", { name: "Copy message" })).toHaveCount(0);
    await expect(failedMessage.getByRole("button", { name: "Fork from here" })).toHaveCount(0);
    await expect(failedMessage.getByRole("button", { name: "Retry" })).toBeVisible();
    expect((await readFile(retryableFailureStub.invocationPath, "utf8"))
      .split("\n").filter((line) => line === "app-server --stdio")).toHaveLength(1);
    expect(await readFile(retryableFailureStub.counterPath, "utf8")).toBe("1");

    await page.setViewportSize({ width: 390, height: 844 });
    const failureDetailBox = await failedMessage.getByRole("alert").boundingBox();
    const retryButtonBox = await failedMessage.getByRole("button", { name: "Retry" }).boundingBox();
    expect(failureDetailBox).not.toBeNull();
    expect(retryButtonBox).not.toBeNull();
    expect(retryButtonBox!.y).toBeGreaterThanOrEqual(failureDetailBox!.y + failureDetailBox!.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const chatId = page.url().match(/\/messenger\/chat\/([^/?#]+)/)?.[1];
    expect(chatId).toBeTruthy();
    const failedMessagesRes = await page.request.get(`/api/chats/${chatId}/messages`);
    expect(failedMessagesRes.ok()).toBe(true);
    const failedMessages = await failedMessagesRes.json() as Array<{
      id: string;
      body: string;
      chatTurnId: string | null;
      turnVariant: number;
      supersededAt: string | null;
      runId: string | null;
      replyingAgentId: string | null;
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
      runId: expect.any(String),
      replyingAgentId: chatAgent.id,
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
    const failedRunId = failedAssistant?.runId;
    expect(failedRunId).toBeTruthy();
    await expect(failedMessage.getByRole("link", { name: "Open run" })).toHaveAttribute(
      "href",
      `/${organizationPath}/agents/${chatAgent.urlKey}/runs/${failedRunId}`,
    );
    await expect(failedMessage.getByRole("button", { name: "Retry" })).toBeVisible();

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("chat-user-message-bubble").filter({
      hasText: "Please retry this failed request",
    })).toHaveCount(1);
    await expect(failedMessage).toBeVisible({ timeout: 15_000 });
    await expect(failedMessage.getByRole("link", { name: "Open run" })).toHaveAttribute(
      "href",
      `/${organizationPath}/agents/${chatAgent.urlKey}/runs/${failedRunId}`,
    );
    await expect(failedMessage.getByRole("button", { name: "Retry" })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("chat-error-after-refresh.png"),
      fullPage: true,
    });

    await failedMessage.getByRole("button", { name: "Retry" }).click();

    await expect(page.getByTestId("chat-user-message-bubble").filter({
      hasText: "Please retry this failed request",
    })).toBeVisible({ timeout: 15_000 });
    const recoveredMessage = page.getByTestId("chat-assistant-message").last();
    await expect(recoveredMessage).toContainText("Initial App Server reply (marker-false)", {
      timeout: 45_000,
    });
    await expect(failedMessage).toHaveCount(0);
    await expect(recoveredMessage.getByRole("button", { name: "Copy message" })).toBeVisible({ timeout: 15_000 });
    await expect(recoveredMessage.getByRole("button", { name: "Fork from here" })).toHaveCount(0);
    await recoveredMessage.getByRole("button", { name: "More message actions" }).filter({ visible: true }).click();
    await expect(page.getByTestId("chat-fork-more-action")).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");
    expect((await readFile(retryableFailureStub.invocationPath, "utf8"))
      .split("\n").filter((line) => line === "app-server --stdio")).toHaveLength(2);
    expect(await readFile(retryableFailureStub.counterPath, "utf8")).toBe("2");
    await expect(page.getByTestId("chat-user-message-bubble").filter({
      hasText: "Please retry this failed request",
    })).toHaveCount(1);
    const originalRun = await page.request.get(`/api/agent-runs/${failedRunId}`);
    expect(originalRun.ok()).toBe(true);
    expect(await originalRun.json()).toMatchObject({ id: failedRunId, status: "failed" });
    const recoveredMessagesRes = await page.request.get(`/api/chats/${chatId}/messages`);
    expect(recoveredMessagesRes.ok()).toBe(true);
    const recoveredMessages = await recoveredMessagesRes.json() as typeof failedMessages;
    const userVariants = recoveredMessages.filter((message) =>
      message.role === "user" && message.body === "Please retry this failed request");
    expect(userVariants).toHaveLength(2);
    expect(userVariants.map((message) => message.turnVariant)).toEqual([0, 1]);
    expect(new Set(userVariants.map((message) => message.chatTurnId)).size).toBe(1);
    expect(userVariants[0]?.chatTurnId).toBeTruthy();
    expect(userVariants[0]?.supersededAt).toBeTruthy();
    expect(userVariants[1]?.supersededAt).toBeNull();
    const recoveredAssistant = recoveredMessages.find((message) =>
      message.role === "assistant" && message.status === "completed");
    expect(recoveredAssistant?.runId).toBeTruthy();
    expect(recoveredAssistant?.runId).not.toBe(failedRunId);
    expect(recoveredAssistant?.chatTurnId).toBe(userVariants[0]?.chatTurnId);
    expect(recoveredAssistant?.turnVariant).toBe(1);
    const databaseUrl = process.env.RUDDER_E2E_DATABASE_URL;
    const database = databaseUrl
      ? { mode: "external", host: new URL(databaseUrl).host, name: new URL(databaseUrl).pathname.slice(1) }
      : { mode: "embedded", host: `127.0.0.1:${E2E_DB_PORT}`, name: join(E2E_INSTANCE_ROOT, "db") };
    await testInfo.attach("retry-evidence.json", {
      body: Buffer.from(JSON.stringify({
        api: E2E_BASE_URL, database, instanceRoot: E2E_INSTANCE_ROOT,
        organizationId: organization.id, chatId, agentId: chatAgent.id,
        chatTurnId: userVariants[0]?.chatTurnId,
        attempts: [
          { variant: 0, runId: failedRunId, status: "failed" },
          { variant: 1, runId: recoveredAssistant?.runId, status: "completed" },
        ],
        activeUserMessageCount: userVariants.filter((message) => message.supersededAt === null).length,
        invocationPath: retryableFailureStub.invocationPath,
      }, null, 2)),
      contentType: "application/json",
    });
    await testInfo.attach("codex-retry-wrapper-invocations", {
      path: retryableFailureStub.invocationPath,
      contentType: "text/plain",
    });
    await page.screenshot({
      path: testInfo.outputPath("chat-retry-completed.png"),
      fullPage: true,
    });
  });

  test("refreshes a completed assistant answer as another turn variant", async ({ page }) => {
    test.setTimeout(120_000);
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Refresh-Chat-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const chatAgent = await createE2EChatAgent(page.request, organization.id, {
      name: "Refresh Agent",
      agentRuntimeConfig: {
        model: "gpt-5.4",
        command: join(E2E_ROOT, "fixtures", "codex-native-session.mjs"),
        chatAppServerEnabled: true,
        env: { RUDDER_E2E_CODEX_REPLY_BODY: "Streaming reply for chat." },
      },
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
    // The first turn and Refresh use the same stateful App Server fixture.
    await expect(firstAssistantMessage).toBeVisible({ timeout: 45_000 });
    await expect(firstAssistantMessage.getByRole("button", { name: "Refresh answer" })).toBeVisible({ timeout: 15_000 });

    await firstAssistantMessage.getByRole("button", { name: "Refresh answer" }).click();

    await expect(page.getByRole("button", { name: "Previous branch" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("2/2")).toBeVisible();
    await expect(page.getByText("Refresh this final answer").first()).toBeVisible();
    await expect(page.getByTestId("chat-assistant-message").filter({
      hasText: "Streaming reply for chat.",
    })).toBeVisible({ timeout: 45_000 });

    await page.getByRole("button", { name: "Previous branch" }).click();
    await expect(page.getByText("1/2")).toBeVisible();
    await expect(page.getByText("Refresh this final answer").first()).toBeVisible();
  });
});
