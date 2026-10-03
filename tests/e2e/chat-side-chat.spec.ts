import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "../../packages/db/node_modules/drizzle-orm/index.js";
import {
  chatConversations,
  chatGenerations,
  chatMessages,
  createDb,
  heartbeatRuns,
  messengerCustomGroupEntries,
  messengerCustomGroups,
  sideChatFirstInputs,
} from "../../packages/db/src/index.ts";
import { MESSENGER_FORK_GROUP_DEFAULT_ICON } from "../../packages/shared/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB, E2E_DATABASE_URL } from "./support/e2e-env";
import { restartE2eServer, stopRestartedE2eServer } from "./support/restart-e2e-server";

const e2eDb = createDb(E2E_DATABASE_URL);

async function enableSideChatSkill(page: Page, orgId: string, agentIds: string[]) {
  const skillRes = await page.request.post(`/api/orgs/${orgId}/skills`, {
    data: {
      name: "Side Chat Research",
      slug: "side-chat-research",
      markdown: "---\nname: side-chat-research\n---\n\n# Side Chat Research\n",
    },
  });
  expect(skillRes.ok(), await skillRes.text()).toBe(true);
  const skill = await skillRes.json() as { key: string };
  for (const agentId of agentIds) {
    const syncRes = await page.request.post(
      `/api/agents/${agentId}/skills/sync?orgId=${encodeURIComponent(orgId)}`,
      { data: { desiredSkills: [`org:${skill.key}`] } },
    );
    expect(syncRes.ok(), await syncRes.text()).toBe(true);
  }
}

function threadTestId(threadKey: string) {
  return `messenger-thread-${threadKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

async function seedSideChatSource(page: Page, name: string, options: { command?: string } = {}) {
  const orgRes = await page.request.post("/api/orgs", { data: { name } });
  expect(orgRes.ok(), await orgRes.text()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string; urlKey: string };
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: "Sidekick",
    command: options.command ?? E2E_CODEX_STUB,
  }) as { id: string };
  const alternateAgent = await createE2EChatAgent(page.request, organization.id, {
    name: "Analyst",
    command: E2E_CODEX_STUB,
  }) as { id: string };
  await enableSideChatSkill(page, organization.id, [agent.id, alternateAgent.id]);
  const conversationId = randomUUID();
  const assistantMessageId = randomUUID();
  const secondAssistantMessageId = randomUUID();
  await e2eDb.insert(chatConversations).values({
    id: conversationId,
    orgId: organization.id,
    title: "Main strategy chat",
    preferredAgentId: agent.id,
    issueCreationMode: "manual_approval",
    planMode: false,
    createdByUserId: "local-board",
    lastMessageAt: new Date(),
  });
  await e2eDb.insert(chatMessages).values([
    {
      id: randomUUID(),
      orgId: organization.id,
      conversationId,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Give me the launch recommendation.",
    },
    {
      id: assistantMessageId,
      orgId: organization.id,
      conversationId,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Launch with a narrow cohort and keep a rollback path.",
      replyingAgentId: agent.id,
    },
    {
      id: secondAssistantMessageId,
      orgId: organization.id,
      conversationId,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Keep this second answer available for another Side Chat.",
      replyingAgentId: agent.id,
    },
  ]);
  await page.goto("/");
  await page.evaluate((orgId) => localStorage.setItem("rudder.selectedOrganizationId", orgId), organization.id);
  await page.setViewportSize({ width: 1500, height: 940 });
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${conversationId}`);
  await expect(page.getByTestId("chat-assistant-message").filter({ hasText: "narrow cohort" })).toBeVisible({ timeout: 15_000 });
  return { organization, agent, alternateAgent, conversationId, assistantMessageId, secondAssistantMessageId };
}

async function createSideChatFinalAnswerDeltaStub(finalBody: string, deltas: string[]) {
  // This is a Codex CLI-shaped JSONL stub for UI regression, not provider parity evidence.
  const stubDir = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-side-chat-final-answer-delta-"));
  const stubPath = path.join(stubDir, "codex");
  const script = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.155.0\\n");
  process.exit(0);
}
if (process.argv.includes("generate-json-schema")) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const outputDir = process.argv[process.argv.indexOf("--out") + 1];
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "ClientRequest.json"), JSON.stringify({ oneOf: [] }));
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
  const sentinel = input.match(/(__RUDDER_RESULT_[a-f0-9-]+__)/i)?.[1] ?? "__RUDDER_RESULT_TEST__";
  const finalBody = ${JSON.stringify(finalBody)};
  const deltas = ${JSON.stringify(deltas)};
  const send = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  send({ type: "thread.started", thread_id: "side-chat-final-answer-delta-e2e", model: "gpt-5.4" });
  send({ type: "item.completed", item: { id: "reason-1", type: "reasoning", text: "Checking the final response." } });
  for (const text of deltas) {
    send({ type: "item.completed", item: { id: "final-answer-1", type: "agent_message", phase: "final_answer", text, delta: true } });
    await pause(500);
  }
  await pause(10_000);
  send({ type: "item.completed", item: { id: "final-answer-1", type: "agent_message", phase: "final_answer", text: finalBody } });
  await pause(3_000);
  const finalText = finalBody + "\\n" + sentinel + JSON.stringify({ kind: "message", body: finalBody, structuredPayload: null });
  send({ type: "turn.completed", result: finalText, usage: { input_tokens: 2, cached_input_tokens: 0, output_tokens: 8 } });
});
`;
  await fs.writeFile(stubPath, script, "utf8");
  await fs.chmod(stubPath, 0o755);
  return stubPath;
}

function isolatedSideChatFinalAnswerScreenshotPath() {
  const runId = process.env.RUDDER_E2E_RUN_ID?.replace(/[^a-z0-9._-]/gi, "-") ?? "local";
  return path.join(os.tmpdir(), `rudder-side-chat-final-answer-${runId}-${Date.now()}.png`);
}

async function openSideChatFromPanelTarget(page: Page) {
  await page.getByTestId("chat-side-panel-trigger").click();
  const panel = page.getByTestId("chat-side-panel");
  await expect(panel.getByTestId("chat-side-panel-empty-state")).toBeVisible();
  await panel.getByTestId("chat-side-panel-empty-side-chat-target").click();
  await expect(panel.getByTestId("side-chat-panel-view")).toBeVisible();
  await expect(panel.getByTestId("side-chat-anchor-preview")).toHaveCount(0);
  await expect(panel).not.toContainText("From the main chat");
  return panel;
}

async function openFromAssistantAction(page: Page, assistantMessageId: string) {
  const assistant = page.locator(`[data-testid="chat-assistant-message"][data-message-id="${assistantMessageId}"]`);
  await assistant.hover();
  const moreActions = assistant.locator('[data-testid="chat-message-actions-trigger"]:visible');
  await expect(moreActions).toBeVisible();
  await moreActions.click();
  const menu = page.getByTestId("chat-message-actions-menu");
  const openSideChat = menu.getByRole("menuitem", { name: "Open Side Chat", exact: true });
  await expect(openSideChat).toBeVisible();
  await openSideChat.click();
  const panel = page.getByTestId("chat-side-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-testid="side-chat-panel-view"]:visible')).toBeVisible();
  await expect(panel.getByTestId("side-chat-anchor-preview")).toHaveCount(0);
  await expect(panel).not.toContainText("From the main chat");
  return panel;
}

test("opens Side Chat from More, keyboard context-menu, and pointer context-menu", async ({ page }) => {
  const source = await seedSideChatSource(page, `Side-Chat-Context-Menu-${Date.now()}`);
  const assistant = page.locator(
    `[data-testid="chat-assistant-message"][data-message-id="${source.assistantMessageId}"]`,
  );
  const moreActions = assistant.locator('[data-testid="chat-message-actions-trigger"]:visible');
  await moreActions.focus();
  await moreActions.press("Shift+F10");
  const menu = page.getByTestId("chat-message-context-menu");
  await expect(menu.getByRole("menuitem", { name: "Open Side Chat", exact: true })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Open Side Chat", exact: true }).click();
  const panel = page.getByTestId("chat-side-panel");
  await expect(panel.getByTestId("side-chat-panel-view")).toBeVisible();
  await panel.getByTestId("chat-side-panel-collapse").click();
  await expect(panel).toBeHidden();

  await assistant.click({ button: "right" });
  await expect(menu.getByRole("menuitem", { name: "Open Side Chat", exact: true })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Open Side Chat", exact: true }).click();
  await expect(page.getByTestId("chat-side-panel").getByTestId("side-chat-panel-view")).toBeVisible();

  await page.getByTestId("chat-side-panel-collapse").click();
  await expect(page.getByTestId("chat-side-panel")).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await assistant.locator('[data-testid="chat-message-actions-trigger"]:visible').click();
  const moreMenu = page.getByTestId("chat-message-actions-menu");
  await expect(moreMenu.getByRole("menuitem", { name: "Open Side Chat", exact: true })).toBeVisible();
  await moreMenu.getByRole("menuitem", { name: "Open Side Chat", exact: true }).click();
  await expect(page.getByTestId("chat-side-panel").getByTestId("side-chat-panel-view")).toBeVisible();
});

function sideComposerEditor(panel: Locator) {
  return panel.locator('[data-testid="side-chat-composer"]:visible .rudder-mdxeditor-content').first();
}

function sideComposerSendButton(panel: Locator) {
  return panel.locator('[data-testid="side-chat-composer"]:visible button[aria-label="Send Side Chat message"]');
}

async function waitForSideChatAssistantReplyToComplete(sideChatId: string) {
  await expect.poll(async () => {
    const messages = await e2eDb.select({ status: chatMessages.status })
      .from(chatMessages)
      .where(and(
        eq(chatMessages.conversationId, sideChatId),
        eq(chatMessages.role, "assistant"),
        eq(chatMessages.body, "Streaming reply for chat."),
      ));
    return messages.some((message) => message.status === "completed");
  }, { timeout: 30_000 }).toBe(true);
}

function parseChatStreamEvents(body: string) {
  return body.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { type: string });
}

async function failSideChatGenerationAdmission(conversationId: string) {
  const suffix = conversationId.replaceAll("-", "");
  const functionName = `e2e_fail_side_chat_generation_${suffix}`;
  const triggerName = `e2e_fail_side_chat_generation_${suffix}`;
  await e2eDb.execute(sql.raw(`
    CREATE FUNCTION ${functionName}() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.conversation_id = '${conversationId}'::uuid THEN
        RAISE EXCEPTION 'E2E first-input Generation admission failure';
      END IF;
      RETURN NEW;
    END;
    $$;
  `));
  await e2eDb.execute(sql.raw(`
    CREATE TRIGGER ${triggerName}
    BEFORE INSERT ON chat_generations
    FOR EACH ROW EXECUTE FUNCTION ${functionName}();
  `));
  return async () => {
    await e2eDb.execute(sql.raw(`DROP TRIGGER IF EXISTS ${triggerName} ON chat_generations`));
    await e2eDb.execute(sql.raw(`DROP FUNCTION IF EXISTS ${functionName}()`));
  };
}

async function openSideChatTabContextMenu(page: Page, panel: Locator) {
  const sideChatTab = panel.locator('[data-side-panel-tab-key^="side-chat:"]');
  await sideChatTab.click({ button: "right" });
  const menu = page.getByTestId("chat-side-panel-tab-context-menu");
  await expect(menu).toBeVisible();
  return { menu, sideChatTab };
}

async function sendFirstSideChatMessage(
  page: Page,
  panel: Locator,
  sourceConversationId: string,
  testInfo?: TestInfo,
) {
  const createResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && response.url().includes(`/api/chats/${sourceConversationId}/side-chats`)
  ));
  const messageResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname.endsWith("/messages/stream")
  ));
  await sideComposerEditor(panel).fill("What is the rollback trigger?");
  await sideComposerSendButton(panel).click();
  const userMessage = panel.getByTestId("chat-user-message-bubble").filter({
    hasText: "What is the rollback trigger?",
  }).last();
  await expect(userMessage).toBeVisible();
  const streamingReply = panel.getByTestId("side-chat-streaming-reply");
  await expect(streamingReply).toBeVisible();
  await expect(streamingReply).toContainText("Streaming reply", { timeout: 15_000 });
  const createResponse = await createResponsePromise;
  expect(createResponse.ok(), await createResponse.text()).toBe(true);
  const sideChat = await createResponse.json() as { id: string };
  const creationPayload = createResponse.request().postDataJSON() as {
    preferredAgentId?: string;
    sourceMessageId?: string;
  };
  const messageResponse = await messageResponsePromise;
  expect(messageResponse.ok(), await messageResponse.text()).toBe(true);
  const messagePayload = messageResponse.request().postDataJSON() as {
    modelOverride?: string | null;
    effortOverride?: string | null;
  };
  await expect(panel.getByTestId("side-chat-messages")).toContainText("What is the rollback trigger?", { timeout: 15_000 });
  const assistantMessage = panel.getByTestId("chat-assistant-message").filter({
    hasText: "Streaming reply for chat.",
  }).last();
  await expect(assistantMessage).toBeVisible({ timeout: 20_000 });
  const [userMessageTop, assistantMessageTop] = await Promise.all([
    userMessage.evaluate((element) => element.getBoundingClientRect().top),
    assistantMessage.evaluate((element) => element.getBoundingClientRect().top),
  ]);
  expect(userMessageTop).toBeLessThan(assistantMessageTop);
  if (testInfo) {
    await page.screenshot({
      path: testInfo.outputPath("side-chat-user-before-assistant.png"),
      fullPage: true,
    });
  }
  await expect(panel.getByTestId("side-chat-messages").getByTestId("chat-transcript-item")).toHaveCount(1, {
    timeout: 20_000,
  });
  await expect(panel.getByRole("button", { name: "Done & return" })).toHaveCount(0);
  return { ...sideChat, creationPayload, messagePayload };
}

test("opens and reopens a usable Side Chat on a narrow viewport without leaving the parent", async ({ page }) => {
  const source = await seedSideChatSource(page, `Side-Chat-Mobile-${Date.now()}`);
  await page.setViewportSize({ width: 390, height: 844 });
  const parentUrl = page.url();
  let sideChatCreateCount = 0;
  let sideChatMessageCount = 0;
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    if (request.url().includes(`/api/chats/${source.conversationId}/side-chats`)) sideChatCreateCount += 1;
    if (new URL(request.url()).pathname.endsWith("/messages/stream")) sideChatMessageCount += 1;
  });

  const panel = await openFromAssistantAction(page, source.assistantMessageId);
  expect(page.url()).toBe(parentUrl);
  expect(sideChatCreateCount).toBe(0);
  expect(sideChatMessageCount).toBe(0);
  await expect(panel.getByTestId("side-chat-composer")).toBeVisible();

  const sideChat = await sendFirstSideChatMessage(page, panel, source.conversationId);
  expect(sideChatCreateCount).toBe(1);
  expect(sideChatMessageCount).toBe(1);
  expect(page.url()).toBe(parentUrl);

  await panel.getByTestId("chat-side-panel-collapse").click();
  await expect(panel).toBeHidden();
  const reopen = page.getByRole("button", { name: "Reopen Side Chat" });
  await expect(reopen).toBeVisible();
  await reopen.click();
  await expect(page.getByTestId("chat-side-panel")).toBeVisible();
  await expect(page.getByTestId("side-chat-messages")).toContainText("What is the rollback trigger?");
});

test("recovers a first-send draft after Side Chat creation fails and the page reloads", async ({ page }) => {
  const source = await seedSideChatSource(page, `Side-Chat-First-Send-Recovery-${Date.now()}`);
  let rejectNextCreate = true;
  const mutationIds: string[] = [];
  await page.route(`**/api/chats/${source.conversationId}/side-chats`, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      mutationIds.push((request.postDataJSON() as { clientMutationId: string }).clientMutationId);
      if (rejectNextCreate) {
        rejectNextCreate = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Temporary Side Chat creation failure" }),
        });
        return;
      }
    }
    await route.continue();
  });

  let panel = await openFromAssistantAction(page, source.assistantMessageId);
  const createFailurePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && response.url().includes(`/api/chats/${source.conversationId}/side-chats`)
  ));
  await sideComposerEditor(panel).fill("Keep this first Side Chat message through a reload.");
  await sideComposerSendButton(panel).click();
  expect((await createFailurePromise).status()).toBe(503);
  await expect(sideComposerEditor(panel)).toContainText("Keep this first Side Chat message through a reload.");

  await page.reload();
  panel = page.getByTestId("chat-side-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("side-chat-panel-view")).toBeVisible();
  await expect(sideComposerEditor(panel)).toContainText("Keep this first Side Chat message through a reload.");

  await sideComposerSendButton(panel).click();
  await expect(panel.getByTestId("chat-user-message-bubble").filter({
    hasText: "Keep this first Side Chat message through a reload.",
  }).last()).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByTestId("chat-assistant-message").filter({
    hasText: "Streaming reply for chat.",
  })).toBeVisible({ timeout: 30_000 });
  expect(mutationIds).toHaveLength(2);
  expect(mutationIds[0]).toBe(mutationIds[1]);
  const createdSideChat = await e2eDb.select({ id: chatConversations.id })
    .from(chatConversations)
    .where(eq(chatConversations.sideChatClientMutationId, mutationIds[0]!));
  expect(createdSideChat).toHaveLength(1);
});

test("recovers the first message after Side Chat creation succeeds but sending fails and the page reloads", async ({ page }) => {
  const source = await seedSideChatSource(page, `Side-Chat-Send-Recovery-${Date.now()}`);
  let sideChatCreateCount = 0;
  let streamAttempts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes(`/api/chats/${source.conversationId}/side-chats`)) {
      sideChatCreateCount += 1;
    }
  });
  await page.route("**/api/chats/*/messages/stream", async (route) => {
    if (route.request().method() === "POST" && streamAttempts++ === 0) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Temporary first-message send failure." }),
      });
      return;
    }
    await route.continue();
  });

  let panel = await openFromAssistantAction(page, source.assistantMessageId);
  const firstSendResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname.endsWith("/messages/stream")
  ));
  await sideComposerEditor(panel).fill("Preserve this message after the created Side Chat send fails.");
  await sideComposerSendButton(panel).click();
  expect((await firstSendResponsePromise).status()).toBe(503);
  await expect(panel.getByRole("alert")).toContainText("Rudder could not process the request");
  await expect(sideComposerEditor(panel)).toContainText("Preserve this message after the created Side Chat send fails.");
  expect(sideChatCreateCount).toBe(1);

  const createdSideChats = await e2eDb.select({ id: chatConversations.id })
    .from(chatConversations)
    .where(eq(chatConversations.forkedFromConversationId, source.conversationId));
  expect(createdSideChats).toHaveLength(1);
  const sideChatId = createdSideChats[0]!.id;

  await page.reload();
  panel = page.getByTestId("chat-side-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(`[data-side-panel-tab-key="side-chat:${sideChatId}"]`)).toBeVisible();
  await expect(sideComposerEditor(panel)).toContainText("Preserve this message after the created Side Chat send fails.");

  const retryResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname.endsWith("/messages/stream")
  ));
  await sideComposerSendButton(panel).click();
  expect((await retryResponsePromise).ok()).toBe(true);
  await expect(panel.getByTestId("chat-user-message-bubble").filter({
    hasText: "Preserve this message after the created Side Chat send fails.",
  })).toHaveCount(1);
  await waitForSideChatAssistantReplyToComplete(sideChatId);
  expect(sideChatCreateCount).toBe(1);
  expect(streamAttempts).toBe(2);
  const persistedUserMessages = await e2eDb.select({ id: chatMessages.id })
    .from(chatMessages)
    .where(and(
      eq(chatMessages.conversationId, sideChatId),
      eq(chatMessages.role, "user"),
      eq(chatMessages.body, "Preserve this message after the created Side Chat send fails."),
    ));
  expect(persistedUserMessages).toHaveLength(1);
});

test("recovers an accepted first Side Chat input after the HTTP server restarts", async ({ page }) => {
  test.setTimeout(180_000);
  const source = await seedSideChatSource(page, `Side-Chat-Server-Restart-Recovery-${Date.now()}`);
  const body = "Recover this accepted first Side Chat input after a server restart.";
  let continueFirstStream!: () => void;
  const firstStreamGate = new Promise<void>((resolve) => { continueFirstStream = resolve; });
  let firstStreamRequestBody: Record<string, unknown> | null = null;
  let heldFirstStream = false;
  let removeAdmissionFailure: (() => Promise<void>) | null = null;

  try {
    await page.route("**/api/chats/*/messages/stream", async (route) => {
      if (route.request().method() === "POST" && !heldFirstStream) {
        heldFirstStream = true;
        firstStreamRequestBody = route.request().postDataJSON() as Record<string, unknown>;
        await firstStreamGate;
      }
      await route.continue();
    });

    const panel = await openFromAssistantAction(page, source.assistantMessageId);
    const createResponsePromise = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && response.url().includes(`/api/chats/${source.conversationId}/side-chats`)
    ));
    const firstStreamResponsePromise = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && new URL(response.url()).pathname.endsWith("/messages/stream")
    ));
    await sideComposerEditor(panel).fill(body);
    await sideComposerSendButton(panel).click();

    const createResponse = await createResponsePromise;
    expect(createResponse.ok(), await createResponse.text()).toBe(true);
    const sideChat = await createResponse.json() as { id: string };
    await expect.poll(() => heldFirstStream).toBe(true);
    removeAdmissionFailure = await failSideChatGenerationAdmission(sideChat.id);
    continueFirstStream();

    const firstStreamResponse = await firstStreamResponsePromise;
    expect(firstStreamResponse.status()).toBe(201);
    const firstStreamEvents = parseChatStreamEvents(await firstStreamResponse.text());
    expect(firstStreamEvents.map((event) => event.type)).toEqual(expect.arrayContaining(["ack", "error"]));
    expect(firstStreamRequestBody).toMatchObject({ body, clientMutationId: expect.any(String) });
    const mutationId = firstStreamRequestBody!.clientMutationId as string;

    const acceptedInputs = await e2eDb.select().from(sideChatFirstInputs)
      .where(eq(sideChatFirstInputs.conversationId, sideChat.id));
    expect(acceptedInputs).toHaveLength(1);
    expect(acceptedInputs[0]).toMatchObject({
      status: "accepted",
      requestClientMutationId: mutationId,
      generationId: null,
    });
    const acceptedMessages = await e2eDb.select({ id: chatMessages.id })
      .from(chatMessages)
      .where(and(
        eq(chatMessages.conversationId, sideChat.id),
        eq(chatMessages.clientMutationId, mutationId),
        eq(chatMessages.body, body),
      ));
    expect(acceptedMessages).toHaveLength(1);
    expect(await e2eDb.select().from(chatGenerations)
      .where(eq(chatGenerations.conversationId, sideChat.id))).toHaveLength(0);

    await restartE2eServer();
    const healthAfterRestart = await page.request.get("/api/health");
    expect(healthAfterRestart.ok(), await healthAfterRestart.text()).toBe(true);
    await removeAdmissionFailure();
    removeAdmissionFailure = null;

    const retryResponse = await page.request.post(`/api/chats/${sideChat.id}/messages/stream`, {
      data: firstStreamRequestBody,
    });
    expect(retryResponse.ok(), await retryResponse.text()).toBe(true);
    const retryEvents = parseChatStreamEvents(await retryResponse.text());
    expect(retryEvents.map((event) => event.type)).toContain("final");

    await waitForSideChatAssistantReplyToComplete(sideChat.id);
    const recoveredInputs = await e2eDb.select({ id: chatMessages.id })
      .from(chatMessages)
      .where(and(
        eq(chatMessages.conversationId, sideChat.id),
        eq(chatMessages.clientMutationId, mutationId),
        eq(chatMessages.body, body),
      ));
    expect(recoveredInputs).toHaveLength(1);
    const generations = await e2eDb.select().from(chatGenerations)
      .where(eq(chatGenerations.conversationId, sideChat.id));
    expect(generations).toHaveLength(1);
    expect(acceptedInputs[0]?.generationId).toBeNull();
    const recoveredIntent = await e2eDb.select().from(sideChatFirstInputs)
      .where(eq(sideChatFirstInputs.conversationId, sideChat.id));
    expect(recoveredIntent[0]?.generationId).toBe(generations[0]?.id);
    const runs = await e2eDb.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.chatConversationId, sideChat.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("succeeded");
  } finally {
    continueFirstStream();
    await removeAdmissionFailure?.();
    await page.unrouteAll({ behavior: "wait" });
    await stopRestartedE2eServer();
  }
});

test("discarding an unsent Side Chat draft is local-only and does not reappear after reload", async ({ page }) => {
  const source = await seedSideChatSource(page, `Side-Chat-Discard-Draft-${Date.now()}`);
  const draftBody = "This provisional Side Chat must stay local.";
  let sideChatCreateCount = 0;
  let sideChatMessageCount = 0;
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    if (request.url().includes(`/api/chats/${source.conversationId}/side-chats`)) sideChatCreateCount += 1;
    if (new URL(request.url()).pathname.endsWith("/messages/stream")) sideChatMessageCount += 1;
  });
  const panel = await openFromAssistantAction(page, source.assistantMessageId);
  await sideComposerEditor(panel).fill(draftBody);
  const readPersistedDrafts = () => page.evaluate(() => (
    localStorage.getItem("rudder:side-chat-send-drafts:v1") ?? ""
  ));
  await expect.poll(readPersistedDrafts).toContain(draftBody);
  const { menu } = await openSideChatTabContextMenu(page, panel);
  await menu.getByRole("menuitem", { name: "Discard Side Chat Draft" }).click();

  await expect(panel).toBeHidden();
  await expect.poll(readPersistedDrafts).not.toContain(draftBody);
  expect(sideChatCreateCount).toBe(0);
  expect(sideChatMessageCount).toBe(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Reopen Side Chat" })).toHaveCount(0);
});

test("discovers and resumes the same Side Chat after local panel state is lost", async ({ page }) => {
  const source = await seedSideChatSource(page, `Side-Chat-History-Resume-${Date.now()}`);
  let sideChatCreateCount = 0;
  let sideChatMessageCount = 0;
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    if (request.url().includes(`/api/chats/${source.conversationId}/side-chats`)) sideChatCreateCount += 1;
    if (new URL(request.url()).pathname.endsWith("/messages/stream")) sideChatMessageCount += 1;
  });
  const panel = await openFromAssistantAction(page, source.assistantMessageId);
  const sideChat = await sendFirstSideChatMessage(page, panel, source.conversationId);

  await page.evaluate(({ contextKey, organizationId }) => {
    const panelPrefix = "rudder:side-chat-panel-state:v1:";
    const organizationSuffix = `:org-${encodeURIComponent(organizationId)}:${encodeURIComponent(contextKey)}`;
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(panelPrefix) && key.endsWith(organizationSuffix)) {
        localStorage.removeItem(key);
      }
    }
  }, {
    contextKey: `chat:${source.conversationId}`,
    organizationId: source.organization.id,
  });
  await page.reload();
  const historyTrigger = page.getByTestId("side-chat-history-trigger");
  await expect(historyTrigger).toBeVisible();
  await historyTrigger.click();
  const historyItem = page.getByTestId("side-chat-history-item").filter({
    hasText: "Side chat from: Main strategy chat",
  });
  await expect(historyItem).toContainText("Active");
  await historyItem.click();

  const restoredPanel = page.getByTestId("chat-side-panel");
  await expect(restoredPanel).toBeVisible();
  await expect(restoredPanel.getByTestId("side-chat-messages")).toContainText("What is the rollback trigger?");
  const sendResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname.endsWith("/messages/stream")
  ));
  await sideComposerEditor(restoredPanel).fill("Continue from the recovered Side Chat session.");
  await sideComposerSendButton(restoredPanel).click();
  expect((await sendResponsePromise).ok()).toBe(true);
  await expect(restoredPanel.getByTestId("chat-user-message-bubble").filter({
    hasText: "Continue from the recovered Side Chat session.",
  })).toBeVisible({ timeout: 20_000 });
  await expect(restoredPanel.getByTestId("chat-assistant-message").filter({
    hasText: "Streaming reply for chat.",
  }).last()).toBeVisible({ timeout: 30_000 });
  expect(sideChatCreateCount).toBe(1);
  expect(sideChatMessageCount).toBe(2);
  await expect(restoredPanel.locator(`[data-side-panel-tab-key="side-chat:${sideChat.id}"]`)).toBeVisible();
});

test("loads and restores Side Chat history beyond the first page", async ({ page }) => {
  const source = await seedSideChatSource(page, `Side-Chat-History-Pagination-${Date.now()}`);
  const createdAt = new Date("2026-08-01T00:00:00.000Z");
  const historyRows = Array.from({ length: 55 }, (_, index) => ({
    id: randomUUID(),
    orgId: source.organization.id,
    title: `Historical Side Chat ${String(index).padStart(2, "0")}`,
    preferredAgentId: source.agent.id,
    conversationKind: "side_chat",
    messengerVisible: false,
    sideChatState: "active",
    forkedFromConversationId: source.conversationId,
    forkedFromMessageId: source.assistantMessageId,
    createdByUserId: "local-board",
    createdAt: new Date(createdAt.getTime() + index * 1_000),
    updatedAt: new Date(createdAt.getTime() + index * 1_000),
  }));
  await e2eDb.insert(chatConversations).values(historyRows);
  await page.reload();

  await page.getByTestId("side-chat-history-trigger").click();
  const historyItems = page.getByTestId("side-chat-history-item");
  await expect(historyItems).toHaveCount(50);
  const firstPageTitles = await historyItems.allTextContents();
  expect(new Set(firstPageTitles.map((title) => title.trim().split("\n")[0])).size).toBe(50);

  await page.getByTestId("side-chat-history-load-more").click();
  await expect(historyItems).toHaveCount(55);
  const allTitles = await historyItems.allTextContents();
  expect(new Set(allTitles.map((title) => title.trim().split("\n")[0])).size).toBe(55);
  await historyItems.filter({ hasText: "Historical Side Chat 00" }).click();

  const panel = page.getByTestId("chat-side-panel");
  await expect(panel.getByTestId("side-chat-panel-view")).toBeVisible();
  await expect(panel.locator(`[data-side-panel-tab-key="side-chat:${historyRows[0]!.id}"]`)).toBeVisible();
});

test("anchors Side Chat to the selected completed assistant reply", async ({ page }, testInfo) => {
  const source = await seedSideChatSource(page, `Side-Chat-Selected-Reply-${Date.now()}`);
  const mainComposer = page.getByTestId("chat-composer-editor-scroll").locator(".rudder-mdxeditor-content").first();
  await mainComposer.click();
  await page.keyboard.insertText("Keep this main-chat draft while opening a reply branch.");

  const panel = await openFromAssistantAction(page, source.assistantMessageId);
  await expect(mainComposer).toContainText("Keep this main-chat draft while opening a reply branch.");
  await page.screenshot({
    path: testInfo.outputPath("selected-assistant-side-chat.png"),
    fullPage: true,
  });
  const createResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && response.url().includes(`/api/chats/${source.conversationId}/side-chats`)
  ));
  await sideComposerEditor(panel).fill("Branch from this exact assistant reply.");
  await sideComposerSendButton(panel).click();
  const createResponse = await createResponsePromise;
  const sideChat = await createResponse.json() as { id: string };
  expect(createResponse.ok(), JSON.stringify(sideChat)).toBe(true);
  const creationPayload = createResponse.request().postDataJSON() as {
    sourceMessageId?: string;
  };
  expect(creationPayload.sourceMessageId).toBe(source.assistantMessageId);
  await expect(panel.getByTestId("chat-user-message-bubble").filter({
    hasText: "Branch from this exact assistant reply.",
  }).last()).toBeVisible();

  const stopResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && response.url().includes(`/api/chats/${sideChat.id}/messages/stream/stop`)
  ));
  const destroyResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "DELETE"
    && response.url().includes(`/api/chats/${sideChat.id}/side-chat`)
  ));
  const { menu } = await openSideChatTabContextMenu(page, panel);
  await menu.getByRole("menuitem", { name: "Close Side Chat" }).click();
  const stopResponse = await stopResponsePromise;
  const stopRequest = stopResponse.request().postDataJSON() as Record<string, unknown>;
  const stopResponseBody = await stopResponse.json() as unknown;
  expect(stopResponse.ok(), JSON.stringify({ request: stopRequest, response: stopResponseBody })).toBe(true);
  expect(stopRequest).toEqual(expect.objectContaining({
    expectedGenerationId: expect.any(String),
    expectedAttemptEpoch: expect.any(Number),
    expectedControlVersion: expect.any(Number),
  }));
  expect(stopResponseBody).toEqual(expect.objectContaining({
    controlActionId: stopRequest.controlActionId,
    generationId: stopRequest.expectedGenerationId,
  }));
  const destroyResponse = await destroyResponsePromise;
  expect(destroyResponse.ok(), await destroyResponse.text()).toBe(true);
  await expect(panel).toBeHidden();
});

test("Side Chat preserves the main draft, streams like Chat, and is destroyed when closed", async ({ page }, testInfo) => {
  const source = await seedSideChatSource(page, `Side-Chat-Close-${Date.now()}`);
  const mainComposer = page.getByTestId("chat-composer-editor-scroll").locator(".rudder-mdxeditor-content").first();
  await mainComposer.click();
  await page.keyboard.insertText("Keep this unfinished main-chat draft");

  const panel = await openSideChatFromPanelTarget(page);
  await expect(mainComposer).toContainText("Keep this unfinished main-chat draft");
  await page.screenshot({ path: testInfo.outputPath("01-side-panel-entry-draft.png"), fullPage: true });
  await expect(panel.locator(".chat-composer")).toBeVisible();
  const mainComposerSurface = page.getByTestId("chat-composer-file-drop-target");
  const sideComposerSurface = panel.getByTestId("side-chat-composer-file-drop-target");
  await expect(mainComposerSurface).toHaveClass(/chat-composer/);
  await expect(sideComposerSurface).toHaveClass(/chat-composer/);
  await expect(mainComposerSurface.getByTestId("chat-composer-toolbar")).toBeVisible();
  await expect(sideComposerSurface.getByTestId("side-chat-composer-toolbar")).toBeVisible();
  await expect(mainComposerSurface.getByRole("button", { name: "Send" })).toHaveClass(
    await sideComposerSurface.getByRole("button", { name: "Send Side Chat message" })
      .getAttribute("class") ?? "",
  );
  await expect(panel.getByTestId("side-chat-project-chip")).toHaveCount(0);
  await expect(panel).not.toContainText("No project");
  const agentSelector = panel.getByTestId("side-chat-composer").getByTestId("chat-agent-selector");
  await expect(agentSelector).toContainText("Sidekick");
  await panel.getByRole("button", { name: "Add files and options" }).click();
  await expect(page.getByRole("menuitem", { name: "Add files" })).toBeVisible();
  await page.keyboard.press("Escape");
  await sideComposerSurface.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["pasted"], "side-chat-pasted.txt", {
      type: "text/plain",
    }));
    element.querySelector('[data-testid="side-chat-composer-editor-scroll"]')
      ?.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }));
  });
  await expect(panel.getByTestId("side-chat-pending-attachments")).toContainText(
    "side-chat-pasted.txt",
  );
  await panel.getByRole("button", { name: "Remove side-chat-pasted.txt" }).click();
  await sideComposerSurface.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["dropped"], "side-chat-dropped.txt", {
      type: "text/plain",
    }));
    element.dispatchEvent(new DragEvent("dragenter", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
  });
  await expect(sideComposerSurface.getByTestId("chat-composer-file-drop-overlay")).toBeVisible();
  await sideComposerSurface.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["dropped"], "side-chat-dropped.txt", {
      type: "text/plain",
    }));
    element.dispatchEvent(new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
  });
  await expect(panel.getByTestId("side-chat-pending-attachments")).toContainText(
    "side-chat-dropped.txt",
  );
  await panel.getByRole("button", { name: "Remove side-chat-dropped.txt" }).click();
  const sideFileInput = panel.getByTestId("side-chat-composer").locator('input[type="file"]');
  await sideFileInput.setInputFiles({
    name: "side-chat-evidence.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Side Chat attachment evidence"),
  });
  await expect(panel.getByTestId("side-chat-pending-attachments")).toContainText(
    "side-chat-evidence.txt",
  );
  await panel.getByRole("button", { name: "Remove side-chat-evidence.txt" }).click();
  await expect(panel.getByTestId("side-chat-pending-attachments")).toHaveCount(0);
  await panel.getByRole("button", { name: "Skills" }).click();
  const sideChatSkillMenu = page.getByTestId("side-chat-skill-menu");
  await expect(sideChatSkillMenu).toBeVisible();
  const sideChatSkill = sideChatSkillMenu
    .getByRole("menuitem")
    .filter({ hasText: /Side Chat Research|side-chat-research/ });
  await expect(sideChatSkill).toBeVisible();
  await sideChatSkill.click();
  await expect(sideComposerEditor(panel)).toContainText("side-chat-research");
  await sideComposerEditor(panel).fill("");
  await expect(panel).not.toContainText("Enter to send · Shift+Enter for a new line");
  await expect(panel.getByTestId("side-chat-anchor-preview")).toHaveCount(0);
  await expect(panel).not.toContainText("From the main chat");
  await agentSelector.click();
  const analystRow = page.getByTestId(`chat-agent-option-${source.alternateAgent.id}`);
  await expect(analystRow.getByRole("menuitemradio")).toBeEnabled();
  await analystRow.getByRole("menuitemradio").click();
  await expect(agentSelector).toContainText("Analyst");
  const runtimeSelector = analystRow.getByTestId("chat-agent-runtime-selector");
  await expect(runtimeSelector).toBeVisible();
  await runtimeSelector.click();
  const runtimePanel = page.getByTestId("chat-agent-runtime-panel");
  await expect(runtimePanel).toBeVisible();
  const [runtimePanelBox, runtimeSelectorBox] = await Promise.all([
    runtimePanel.boundingBox(),
    runtimeSelector.boundingBox(),
  ]);
  expect(runtimePanelBox).not.toBeNull();
  expect(runtimeSelectorBox).not.toBeNull();
  expect(Math.abs(
    runtimePanelBox!.y + runtimePanelBox!.height - runtimeSelectorBox!.y,
  )).toBeLessThanOrEqual(12);
  await page.screenshot({
    path: testInfo.outputPath("side-chat-agent-runtime-draft.png"),
    fullPage: true,
  });
  await page.getByTestId("chat-model-selector").click();
  await page.getByTestId("chat-model-option-gpt-5.6-terra").click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  const sideChat = await sendFirstSideChatMessage(page, panel, source.conversationId, testInfo);
  expect(sideChat.creationPayload).toMatchObject({
    preferredAgentId: source.alternateAgent.id,
  });
  expect(sideChat.creationPayload).not.toHaveProperty("modelOverride");
  expect(sideChat.creationPayload).not.toHaveProperty("effortOverride");
  expect(sideChat.messagePayload).toMatchObject({
    modelOverride: "gpt-5.6-terra",
    effortOverride: null,
  });

  await expect(
    agentSelector.getByLabel("Agent is bound to this chat"),
  ).toHaveCount(0);
  await agentSelector.click();
  await expect(page.getByTestId("chat-agent-lock-state")).toContainText("Bound to chat");
  await expect(
    page
      .getByTestId(`chat-agent-option-${source.agent.id}`)
      .getByRole("menuitemradio"),
  ).toBeDisabled();
  await expect(
    page
      .getByTestId(`chat-agent-option-${source.alternateAgent.id}`)
      .getByTestId("chat-agent-runtime-selector"),
  ).toBeVisible();
  await expect(page.getByTestId("side-chat-agent-menu")).toBeVisible();
  await page.waitForTimeout(250);
  await page.screenshot({
    path: testInfo.outputPath(
      "side-chat-agent-locked-runtime-available.png",
    ),
    fullPage: true,
  });
  await page.keyboard.press("Escape");

  const hiddenList = await page.request.get(`/api/orgs/${source.organization.id}/chats?status=all`);
  expect(hiddenList.ok()).toBe(true);
  expect((await hiddenList.json() as Array<{ id: string }>).some((chat) => chat.id === sideChat.id)).toBe(false);
  const hiddenMessenger = await page.request.get(
    `/api/orgs/${source.organization.id}/messenger/threads?limit=40&splitIssues=true`,
  );
  expect(hiddenMessenger.ok()).toBe(true);
  expect((await hiddenMessenger.json() as { items: Array<{ threadKey: string }> }).items
    .some((thread) => thread.threadKey === `chat:${sideChat.id}`)).toBe(false);
  const hiddenMessengerThread = await page.request.get(
    `/api/orgs/${source.organization.id}/messenger/chat/${sideChat.id}`,
  );
  expect(hiddenMessengerThread.status()).toBe(404);

  await page.screenshot({ path: testInfo.outputPath("04-side-chat-active.png"), fullPage: true });
  const destroyResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "DELETE"
    && response.url().includes(`/api/chats/${sideChat.id}/side-chat`)
  ));
  const { menu } = await openSideChatTabContextMenu(page, panel);
  await menu.getByRole("menuitem", { name: "Close Side Chat" }).click();
  const destroyResponse = await destroyResponsePromise;
  expect(destroyResponse.ok(), await destroyResponse.text()).toBe(true);
  await expect(panel).toBeHidden();
  expect((await page.request.get(`/api/chats/${sideChat.id}`)).status()).toBe(404);
  await expect(mainComposer).toContainText("Keep this unfinished main-chat draft");
  await page.screenshot({ path: testInfo.outputPath("05-side-chat-destroyed.png"), fullPage: true });
});

test("keeps an in-flight Side Chat stream visible after the panel is collapsed and reopened", async ({ page }, testInfo) => {
  const source = await seedSideChatSource(page, `Side-Chat-Reopen-${Date.now()}`);
  const panel = await openFromAssistantAction(page, source.assistantMessageId);

  await sideComposerEditor(panel).fill("Keep this Side Chat stream alive while hidden.");
  await sideComposerSendButton(panel).click();
  await expect(panel.getByTestId("side-chat-streaming-reply")).toContainText("Streaming reply", {
    timeout: 15_000,
  });

  await panel.getByTestId("chat-side-panel-collapse").click();
  await expect(panel).toBeHidden();
  await page.getByTestId("chat-side-panel-trigger").click();

  const reopenedPanel = page.getByTestId("chat-side-panel");
  await expect(reopenedPanel).toBeVisible();
  await expect(reopenedPanel.getByTestId("side-chat-streaming-reply")).toContainText("Streaming reply", {
    timeout: 5_000,
  });
  await expect(
    reopenedPanel.getByTestId("chat-assistant-message").filter({ hasText: "Streaming reply for chat." }),
  ).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: testInfo.outputPath("side-chat-stream-survives-reopen.png"), fullPage: true });

  const { menu } = await openSideChatTabContextMenu(page, reopenedPanel);
  await menu.getByRole("menuitem", { name: "Close Side Chat" }).click();
  await expect(reopenedPanel).toBeHidden();
});

test("keeps an in-flight Side Chat stream visible after navigating away and back", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const source = await seedSideChatSource(page, `Side-Chat-Navigate-${Date.now()}`);
  const panel = await openFromAssistantAction(page, source.assistantMessageId);

  await sideComposerEditor(panel).fill("Keep this Side Chat stream alive across navigation.");
  await sideComposerSendButton(panel).click();
  await expect(panel.getByTestId("side-chat-streaming-reply")).toContainText("Streaming reply", {
    timeout: 30_000,
  });

  await page.getByTestId("primary-rail").getByRole("link", { name: "Issue" }).click();
  await expect(page).toHaveURL(new RegExp(`/${source.organization.urlKey}/issues(?:/.*)?$`), {
    timeout: 15_000,
  });
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/messenger/chat/${source.conversationId}$`), {
    timeout: 15_000,
  });

  const returnedPanel = page.getByTestId("chat-side-panel");
  await expect(returnedPanel).toBeVisible();
  await expect(returnedPanel.getByTestId("side-chat-streaming-reply")).toContainText("Streaming reply", {
    timeout: 5_000,
  });
  await expect(
    returnedPanel.getByTestId("chat-assistant-message").filter({ hasText: "Streaming reply for chat." }),
  ).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: testInfo.outputPath("side-chat-stream-survives-navigation.png"), fullPage: true });

  const { menu } = await openSideChatTabContextMenu(page, returnedPanel);
  await menu.getByRole("menuitem", { name: "Close Side Chat" }).click();
  await expect(returnedPanel).toBeHidden();
});

test("keeps streamed final-answer deltas from a Codex-shaped stub in one stable Side Chat bubble", async ({ page }) => {
  test.setTimeout(90_000);
  const finalBody = "The Side Chat final answer stays in one stable assistant bubble.";
  const deltas = ["The Side Chat final ", "answer stays"];
  const visiblePrefix = deltas.join("");
  const stubPath = await createSideChatFinalAnswerDeltaStub(finalBody, deltas);
  const source = await seedSideChatSource(
    page,
    `Side-Chat-Final-Delta-${Date.now()}`,
    { command: stubPath },
  );
  const panel = await openFromAssistantAction(page, source.assistantMessageId);
  const userPrompt = "Stream this Side Chat final response in multiple chunks.";
  const createResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && response.url().includes(`/api/chats/${source.conversationId}/side-chats`)
  ));

  await sideComposerEditor(panel).fill(userPrompt);
  await sideComposerSendButton(panel).click();
  const createResponse = await createResponsePromise;
  expect(createResponse.ok(), await createResponse.text()).toBe(true);
  const sideChat = await createResponse.json() as { id: string };

  const sideChatMessages = panel.getByTestId("side-chat-messages");
  const userMessage = sideChatMessages.getByTestId("chat-user-message-bubble").filter({ hasText: userPrompt });
  await expect(userMessage).toHaveCount(1);
  const streamingTranscript = sideChatMessages.getByTestId("chat-transcript-item").last();
  const streamingBubble = sideChatMessages.getByTestId("chat-assistant-message").filter({ hasText: visiblePrefix });
  await expect(streamingBubble).toHaveCount(1, { timeout: 20_000 });
  await expect(streamingTranscript).not.toContainText(visiblePrefix);
  await expect(streamingTranscript).not.toContainText(finalBody);
  const streamingTranscriptTop = (await streamingTranscript.boundingBox())?.y;
  expect(streamingTranscriptTop).not.toBeNull();
  const userMessageTop = (await userMessage.boundingBox())?.y;
  expect(userMessageTop).not.toBeNull();
  expect(userMessageTop!).toBeLessThan(streamingTranscriptTop!);
  const streamingBubbleTop = (await streamingBubble.locator(".group.w-full.max-w-3xl").boundingBox())?.y;
  expect(streamingBubbleTop).not.toBeNull();
  const streamingBubbleGap = streamingBubbleTop! - userMessageTop!;

  const countVisibleText = (text: string) => sideChatMessages.evaluate(
    (element, value) => (element.innerText.split(value).length ?? 1) - 1,
    text,
  );
  const readAssistantStatus = async () => {
    const response = await page.request.get(`/api/chats/${sideChat.id}/messages`);
    if (!response.ok()) return null;
    const messages = await response.json() as Array<{ role: string; status: string }>;
    return [...messages].reverse().find((message) => message.role === "assistant")?.status ?? null;
  };
  await expect.poll(readAssistantStatus, { timeout: 10_000 }).toBe("streaming");
  await expect(streamingBubble).toContainText(visiblePrefix);
  expect(await countVisibleText(visiblePrefix)).toBe(1);
  await page.screenshot({ path: isolatedSideChatFinalAnswerScreenshotPath(), fullPage: true });

  await expect.poll(readAssistantStatus, { timeout: 20_000 }).toBe("completed");
  await page.waitForTimeout(250);

  const completedBubble = sideChatMessages.getByTestId("chat-assistant-message").filter({ hasText: finalBody });
  await expect(completedBubble).toHaveCount(1);
  await expect(completedBubble).toContainText("Sidekick");
  expect(await countVisibleText(finalBody)).toBe(1);
  await expect(streamingTranscript).not.toContainText(finalBody);
  const completedBubbleTop = (await completedBubble.locator(".group.w-full.max-w-3xl").boundingBox())?.y;
  expect(completedBubbleTop).not.toBeNull();
  expect(streamingTranscriptTop!).toBeLessThan(completedBubbleTop!);
  const completedUserTop = (await userMessage.boundingBox())?.y;
  expect(completedUserTop).not.toBeNull();
  expect(Math.abs(completedBubbleTop! - completedUserTop! - streamingBubbleGap)).toBeLessThanOrEqual(2);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel.locator(`[data-side-panel-tab-key="side-chat:${sideChat.id}"]`)).toBeVisible();
  const refreshedMessages = panel.getByTestId("side-chat-messages");
  const refreshedUserMessage = refreshedMessages.getByTestId("chat-user-message-bubble").filter({ hasText: userPrompt });
  const refreshedAssistantMessage = refreshedMessages.getByTestId("chat-assistant-message").filter({ hasText: finalBody });
  await expect(refreshedUserMessage).toHaveCount(1);
  await expect(refreshedAssistantMessage).toHaveCount(1);
  expect(await refreshedMessages.evaluate((element, value) => element.innerText.split(value).length - 1, finalBody)).toBe(1);
  await expect(refreshedMessages.getByTestId("chat-transcript-item").last()).not.toContainText(finalBody);
  const refreshedUserTop = (await refreshedUserMessage.boundingBox())?.y;
  const refreshedAssistantTop = (await refreshedAssistantMessage.boundingBox())?.y;
  expect(refreshedUserTop).not.toBeNull();
  expect(refreshedAssistantTop).not.toBeNull();
  expect(refreshedUserTop!).toBeLessThan(refreshedAssistantTop!);
  await page.screenshot({ path: isolatedSideChatFinalAnswerScreenshotPath(), fullPage: true });

  const { menu } = await openSideChatTabContextMenu(page, panel);
  await menu.getByRole("menuitem", { name: "Close Side Chat" }).click();
  await expect(panel).toBeHidden();
});

test("completes a Side Chat after para-memory-files tool activity without duplicate sends", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const source = await seedSideChatSource(page, `Side-Chat-Memory-Tool-${Date.now()}`);
  const panel = await openFromAssistantAction(page, source.assistantMessageId);
  const createResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && response.url().includes(`/api/chats/${source.conversationId}/side-chats`)
  ));

  await sideComposerEditor(panel).fill("Use para-memory-files before answering this Side Chat.");
  const sendButton = sideComposerSendButton(panel);
  await sendButton.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });

  const createResponse = await createResponsePromise;
  expect(createResponse.ok(), await createResponse.text()).toBe(true);
  const sideChat = await createResponse.json() as { id: string };
  await expect(panel.getByTestId("side-chat-streaming-reply")).toContainText("Streaming reply", {
    timeout: 20_000,
  });
  await expect(
    panel.getByTestId("chat-assistant-message").filter({ hasText: "Streaming reply for chat." }),
  ).toBeVisible({ timeout: 35_000 });
  const transcriptToggle = panel.getByRole("button", { name: /Worked for/ });
  await expect(transcriptToggle).toBeVisible({ timeout: 20_000 });
  const transcriptItem = panel.getByTestId("chat-transcript-item");
  await expect(transcriptItem).toHaveCount(1, { timeout: 20_000 });
  await transcriptToggle.click();
  await expect(transcriptItem.getByText("Ran echo chat", { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  await expect(transcriptItem.getByText("TRANSCRIPT_TOOL_OUTPUT_E2E", { exact: false })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /Expand command details.*Ran echo chat/ })).toBeVisible({
    timeout: 20_000,
  });

  const userMessages = await e2eDb
    .select({ id: chatMessages.id, body: chatMessages.body })
    .from(chatMessages)
    .where(and(
      eq(chatMessages.orgId, source.organization.id),
      eq(chatMessages.conversationId, sideChat.id),
      eq(chatMessages.role, "user"),
      eq(chatMessages.body, "Use para-memory-files before answering this Side Chat."),
    ));
  expect(userMessages).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath("side-chat-para-memory-tool-completes.png"), fullPage: true });

  const { menu } = await openSideChatTabContextMenu(page, panel);
  await menu.getByRole("menuitem", { name: "Close Side Chat" }).click();
  await expect(panel).toBeHidden();
});

test("keeps concurrent Side Chat streams isolated when switching tabs", async ({ page }, testInfo) => {
  const source = await seedSideChatSource(page, `Side-Chat-Tabs-${Date.now()}`);
  const panel = await openFromAssistantAction(page, source.assistantMessageId);

  const firstPrompt = "FIRST_SIDE_CHAT_STREAM";
  const secondPrompt = "SECOND_SIDE_CHAT_STREAM";
  const activeMessages = () => panel.locator('[data-testid="side-chat-messages"]:visible');
  const activeStreamingReply = () => panel.locator('[data-testid="side-chat-streaming-reply"]:visible');

  await sideComposerEditor(panel).fill(firstPrompt);
  await sideComposerSendButton(panel).click();
  await expect(activeMessages()).toContainText(firstPrompt, {
    timeout: 15_000,
  });
  await expect(activeStreamingReply()).toContainText("Streaming reply", {
    timeout: 15_000,
  });

  await openFromAssistantAction(page, source.secondAssistantMessageId);
  await expect(panel.getByTestId("chat-side-panel-tab")).toHaveCount(2);
  const sideChatTabs = panel.locator('[data-side-panel-tab-key^="side-chat:"]');
  await expect(sideChatTabs.nth(1).getByRole("tab")).toHaveAttribute("aria-selected", "true");
  const firstSideChatTab = sideChatTabs.first().getByRole("tab");
  await firstSideChatTab.focus();
  await expect(firstSideChatTab).toBeFocused();
  await expect(firstSideChatTab).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("Shift+F10");
  const tabMenu = page.getByTestId("chat-side-panel-tab-context-menu");
  await expect(tabMenu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(tabMenu).toBeHidden();
  await expect(firstSideChatTab).toBeFocused();
  await expect(firstSideChatTab).toHaveAttribute("aria-selected", "false");
  await expect(sideChatTabs.nth(1).getByRole("tab")).toHaveAttribute("aria-selected", "true");
  await panel.locator('[data-testid="side-chat-composer"]:visible [data-testid="chat-agent-selector"]').click();
  await expect(page.getByTestId("side-chat-agent-menu")).toBeVisible();
  await sideChatTabs.first().click();
  await expect(page.getByTestId("side-chat-agent-menu")).toHaveCount(0);
  await sideChatTabs.nth(1).click();
  await expect(sideChatTabs.nth(1).getByRole("tab")).toHaveAttribute("aria-selected", "true");
  await sideComposerEditor(panel).fill(secondPrompt);
  await sideComposerSendButton(panel).click();
  await expect(activeMessages()).toContainText(secondPrompt, {
    timeout: 15_000,
  });
  await expect(activeStreamingReply()).toContainText("Streaming reply", {
    timeout: 15_000,
  });

  await sideChatTabs.first().click();
  await expect(sideChatTabs.first().getByRole("tab")).toHaveAttribute("aria-selected", "true");
  await expect(activeMessages()).toContainText(firstPrompt, {
    timeout: 5_000,
  });
  await expect(activeMessages()).not.toContainText(secondPrompt);
  await expect(activeStreamingReply()).toContainText("Streaming reply", { timeout: 5_000 });

  await sideChatTabs.nth(1).click();
  await expect(sideChatTabs.nth(1).getByRole("tab")).toHaveAttribute("aria-selected", "true");
  await expect(activeMessages()).toContainText(secondPrompt, {
    timeout: 5_000,
  });
  await expect(activeMessages()).not.toContainText(firstPrompt);
  await expect(activeStreamingReply()).toContainText("Streaming reply", { timeout: 5_000 });
  await expect(panel.getByTestId("chat-assistant-message").filter({ hasText: "Streaming reply for chat." }).last()).toBeVisible({
    timeout: 20_000,
  });
  await page.screenshot({ path: testInfo.outputPath("side-chat-concurrent-tabs-isolated.png"), fullPage: true });
});

test("aborts and destroys a Side Chat when its tab closes during streaming", async ({ page }, testInfo) => {
  const source = await seedSideChatSource(page, `Side-Chat-Close-In-Flight-${Date.now()}`);
  const panel = await openFromAssistantAction(page, source.assistantMessageId);

  await sideComposerEditor(panel).fill("Close this Side Chat before its answer finishes.");
  await sideComposerSendButton(panel).click();
  await expect(panel.getByTestId("side-chat-streaming-reply")).toContainText("Streaming reply", {
    timeout: 15_000,
  });

  const destroyResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "DELETE"
    && response.url().includes("/side-chat")
  ));
  const { menu } = await openSideChatTabContextMenu(page, panel);
  await menu.getByRole("menuitem", { name: "Close Side Chat" }).click();
  const destroyResponse = await destroyResponsePromise;
  expect(destroyResponse.ok(), await destroyResponse.text()).toBe(true);
  await expect(panel).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("side-chat-close-in-flight.png"), fullPage: true });
});

test("starts Side Chat from a completed historical turn variant after its replacement was stopped", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("rudder.theme", "dark");
  });

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Historical-Side-Chat-${Date.now()}` },
  });
  expect(orgRes.ok(), await orgRes.text()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: "Historical Side Chat Agent",
    command: E2E_CODEX_STUB,
  }) as { id: string };
  const conversationId = randomUUID();
  const turnId = randomUUID();
  const sourceAssistantId = randomUUID();
  const supersededAt = new Date("2026-07-30T16:54:30.434Z");
  await e2eDb.insert(chatConversations).values({
    id: conversationId,
    orgId: organization.id,
    title: "Historical Side Chat source",
    preferredAgentId: agent.id,
    issueCreationMode: "manual_approval",
    planMode: false,
    createdByUserId: "local-board",
    lastMessageAt: new Date("2026-07-30T16:54:35.390Z"),
  });
  await e2eDb.insert(chatMessages).values([
    {
      id: randomUUID(),
      orgId: organization.id,
      conversationId,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Original historical Side Chat request",
      chatTurnId: turnId,
      turnVariant: 0,
      supersededAt,
      createdAt: new Date("2026-07-30T14:47:07.233Z"),
      updatedAt: supersededAt,
    },
    {
      id: sourceAssistantId,
      orgId: organization.id,
      conversationId,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Completed historical Side Chat answer",
      replyingAgentId: agent.id,
      chatTurnId: turnId,
      turnVariant: 0,
      supersededAt,
      createdAt: new Date("2026-07-30T14:55:24.548Z"),
      updatedAt: supersededAt,
    },
    {
      id: randomUUID(),
      orgId: organization.id,
      conversationId,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Replacement Side Chat request that was stopped",
      chatTurnId: turnId,
      turnVariant: 1,
      createdAt: new Date("2026-07-30T16:54:30.434Z"),
      updatedAt: new Date("2026-07-30T16:54:30.434Z"),
    },
    {
      id: randomUUID(),
      orgId: organization.id,
      conversationId,
      role: "assistant",
      kind: "message",
      status: "stopped",
      body: "Chat run stopped before a final reply.",
      replyingAgentId: agent.id,
      chatTurnId: turnId,
      turnVariant: 1,
      createdAt: new Date("2026-07-30T16:54:35.390Z"),
      updatedAt: new Date("2026-07-30T16:54:35.390Z"),
    },
  ]);

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${conversationId}`);
  await expect(page.getByText("2/2")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(`[data-testid="chat-assistant-message"][data-message-id="${sourceAssistantId}"]`)
    .locator('[data-testid="chat-message-actions-trigger"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Previous branch" }).click();
  await expect(page.getByText("1/2")).toBeVisible();
  await expect(page.locator(`[data-testid="chat-assistant-message"][data-message-id="${sourceAssistantId}"]`)
    .locator('[data-testid="chat-message-actions-trigger"]:visible')).toBeVisible();

  const panel = await openFromAssistantAction(page, sourceAssistantId);
  const createResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && response.url().includes(`/api/chats/${conversationId}/side-chats`)
  ));
  await sideComposerEditor(panel).fill("Use the completed historical answer.");
  await sideComposerSendButton(panel).click();
  await expect(
    panel.getByTestId("chat-user-message-bubble").filter({
      hasText: "Use the completed historical answer.",
    }).last(),
  ).toBeVisible();
  const createResponse = await createResponsePromise;
  expect(createResponse.ok(), await createResponse.text()).toBe(true);
  const sideChat = await createResponse.json() as { id: string };
  await expect(panel).not.toContainText("Side Chat source must be a completed assistant response");
  await page.screenshot({
    path: testInfo.outputPath("historical-variant-side-chat.png"),
    fullPage: true,
  });

  const messagesRes = await page.request.get(`/api/chats/${sideChat.id}/messages`);
  expect(messagesRes.ok(), await messagesRes.text()).toBe(true);
  const messages = await messagesRes.json() as Array<{ body: string }>;
  expect(messages.map((message) => message.body)).toEqual(expect.arrayContaining([
    "Original historical Side Chat request",
    "Completed historical Side Chat answer",
    "Use the completed historical answer.",
  ]));
  expect(messages.map((message) => message.body)).not.toContain(
    "Replacement Side Chat request that was stopped",
  );
});

test("the /side menu matches composer popovers and can move the same Side Chat to Messenger", async ({ page }, testInfo) => {
  const source = await seedSideChatSource(page, `Side-Chat-Keep-${Date.now()}`);
  const mainComposer = page.getByTestId("chat-composer-editor-scroll").locator(".rudder-mdxeditor-content").first();
  await mainComposer.click();
  await page.keyboard.insertText("/");
  const slashMenu = page.getByTestId("chat-slash-command-menu");
  await expect(slashMenu).toBeVisible();
  await expect(slashMenu).toHaveAttribute("role", "menu");
  await expect(slashMenu.getByTestId("chat-slash-side-chat")).toHaveAttribute("role", "menuitem");
  await page.waitForTimeout(400);
  const [menuBox, composerBox] = await Promise.all([slashMenu.boundingBox(), page.locator(".chat-composer").boundingBox()]);
  expect(menuBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(composerBox!.y - 8);
  expect(Math.abs(menuBox!.width - composerBox!.width)).toBeLessThanOrEqual(2);
  await page.screenshot({ path: testInfo.outputPath("05-side-slash-menu.png"), fullPage: true });
  await page.keyboard.press("Enter");
  const panel = page.getByTestId("chat-side-panel");
  await expect(panel.getByTestId("side-chat-panel-view")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("06-side-slash-draft.png"), fullPage: true });

  const draftTab = panel.locator('[data-side-panel-tab-key^="side-chat:"]');
  await draftTab.getByRole("tab").focus();
  await page.keyboard.press("Shift+F10");
  const keyboardMenu = page.getByTestId("chat-side-panel-tab-context-menu");
  await expect(keyboardMenu).toBeVisible();
  await expect(keyboardMenu.getByRole("menuitem", { name: "Move to Messenger" })).toBeFocused();
  await expect(page.getByRole("tooltip")).toContainText("Send a message first to create this Side Chat.");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(keyboardMenu).toBeHidden();
  await expect(draftTab.getByRole("tab")).toBeFocused();
  await page.keyboard.press("ContextMenu");
  await expect(page.getByTestId("chat-side-panel-tab-context-menu")).toBeVisible();
  await page.keyboard.press("Escape");

  const draftTabBox = await draftTab.boundingBox();
  expect(draftTabBox).not.toBeNull();
  await draftTab.dispatchEvent("pointerdown", {
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    clientX: draftTabBox!.x + draftTabBox!.width / 2,
    clientY: draftTabBox!.y + draftTabBox!.height / 2,
  });
  await page.waitForTimeout(750);
  await expect(page.getByTestId("chat-side-panel-tab-context-menu")).toBeVisible();
  await draftTab.dispatchEvent("pointerup", { pointerType: "touch", isPrimary: true, button: 0 });
  await page.keyboard.press("Escape");

  const { menu: draftMenu } = await openSideChatTabContextMenu(page, panel);
  const disabledDraftMove = draftMenu.getByRole("menuitem", { name: "Move to Messenger" });
  await expect(disabledDraftMove).toHaveAttribute("aria-disabled", "true");
  await disabledDraftMove.hover();
  await expect(page.getByRole("tooltip")).toContainText("Send a message first to create this Side Chat.");
  await page.screenshot({ path: testInfo.outputPath("07-side-chat-draft-menu.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(draftMenu).toBeHidden();

  const sideChat = await sendFirstSideChatMessage(page, panel, source.conversationId);
  const keepResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && response.url().includes(`/api/chats/${sideChat.id}/side-chat/keep`)
  ));
  const { menu: activeMenu } = await openSideChatTabContextMenu(page, panel);
  const moveItem = activeMenu.getByRole("menuitem", { name: "Move to Messenger" });
  await expect(moveItem).not.toHaveAttribute("aria-disabled", "true");
  await moveItem.hover();
  await expect(page.getByRole("tooltip")).toContainText("Make this Side Chat a regular Messenger chat. This tab will close.");
  await page.screenshot({ path: testInfo.outputPath("08-side-chat-active-menu.png"), fullPage: true });
  await moveItem.click();
  const keepResponse = await keepResponsePromise;
  expect(keepResponse.ok(), await keepResponse.text()).toBe(true);
  expect(await keepResponse.json()).toMatchObject({
    id: sideChat.id,
    title: "Side chat from: Main strategy chat",
    messengerVisible: true,
    sideChatState: "kept",
  });
  await expect(page).toHaveURL(new RegExp(`/messenger/chat/${sideChat.id}$`));
  await expect(page.getByTestId("side-chat-panel-view")).toHaveCount(0);
  await expect(page.getByTestId("chat-composer-layout")).toBeVisible();
  await expect(page.getByTestId("chat-assistant-message").filter({ hasText: "Streaming reply for chat." })).toBeVisible();

  const listAfterKeep = await page.request.get(`/api/orgs/${source.organization.id}/chats?status=active`);
  expect(listAfterKeep.ok()).toBe(true);
  expect((await listAfterKeep.json() as Array<{ id: string }>).some((chat) => chat.id === sideChat.id)).toBe(true);
  const visibleMessengerThread = await page.request.get(
    `/api/orgs/${source.organization.id}/messenger/chat/${sideChat.id}`,
  );
  expect(visibleMessengerThread.ok(), await visibleMessengerThread.text()).toBe(true);
  expect(await visibleMessengerThread.json()).toMatchObject({
    conversation: {
      id: sideChat.id,
      title: "Side chat from: Main strategy chat",
      messengerVisible: true,
      sideChatState: "kept",
    },
  });

  const groups = await e2eDb
    .select()
    .from(messengerCustomGroups)
    .where(eq(messengerCustomGroups.orgId, source.organization.id));
  expect(groups).toHaveLength(1);
  expect(groups[0]).toMatchObject({
    name: "Main strategy chat",
    icon: MESSENGER_FORK_GROUP_DEFAULT_ICON,
  });
  const groupEntries = await e2eDb
    .select()
    .from(messengerCustomGroupEntries)
    .where(eq(messengerCustomGroupEntries.groupId, groups[0]!.id));
  expect(new Set(groupEntries.map((entry) => entry.threadKey))).toEqual(new Set([
    `chat:${source.conversationId}`,
    `chat:${sideChat.id}`,
  ]));
  const groupSection = page.getByTestId(`messenger-thread-section-custom-group-${groups[0]!.id}`);
  await expect(groupSection).toContainText("Main strategy chat", { timeout: 15_000 });
  await expect(groupSection).toContainText(MESSENGER_FORK_GROUP_DEFAULT_ICON);
  await expect(groupSection.getByTestId(threadTestId(`chat:${source.conversationId}`))).toBeVisible();
  await expect(groupSection.getByTestId(threadTestId(`chat:${sideChat.id}`))).toContainText(
    "Side chat from: Main strategy chat",
  );
  await page.screenshot({ path: "/tmp/rudder-side-chat-title-grouping.png", fullPage: true });

  await page.goto(`/${source.organization.issuePrefix}/messenger/chat/${sideChat.id}`);
  const sourceChatLink = page.getByRole("link", { name: "Open source chat Main strategy chat" });
  await expect(sourceChatLink).toBeVisible({ timeout: 15_000 });
  await sourceChatLink.click();
  await expect(page).toHaveURL(new RegExp(`/messenger/chat/${source.conversationId}$`));
  await expect(page.getByTestId("chat-side-panel")).toBeHidden();
  await expect(page.getByTestId("chat-assistant-message").filter({ hasText: "narrow cohort" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("10-source-chat-direct-navigation.png"), fullPage: true });
});

test("the Side Panel empty state opens the same provisional Side Chat flow", async ({ page }, testInfo) => {
  await seedSideChatSource(page, `Side-Chat-Panel-${Date.now()}`);
  await page.getByTestId("workspace-main-card").getByTestId("chat-side-panel-trigger").click();
  const panel = page.getByTestId("chat-side-panel");
  await expect(panel.getByTestId("chat-side-panel-empty-state")).toBeVisible();
  await expect(panel.getByTestId("chat-side-panel-empty-side-chat-target")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("08-side-panel-empty-state.png"), fullPage: true });

  await panel.getByTestId("chat-side-panel-empty-side-chat-target").click();
  await expect(panel.getByTestId("side-chat-panel-view")).toBeVisible();
  await expect(panel.getByTestId("side-chat-anchor-preview")).toHaveCount(0);
  await expect(panel).not.toContainText("From the main chat");
  await expect(sideComposerEditor(panel)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("09-side-panel-entry-draft.png"), fullPage: true });

  const sideChatTab = panel.locator('[data-side-panel-tab-key^="side-chat:"]');
  await sideChatTab.hover();
  await sideChatTab.getByRole("button", { name: "Close Side Chat tab" }).click();
  await expect(panel).toBeHidden();
});

test("the Side Chat tab menu and disabled explanation fit a narrow viewport", async ({ page }, testInfo) => {
  const source = await seedSideChatSource(page, `Side-Chat-Narrow-${Date.now()}`);
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = await openFromAssistantAction(page, source.assistantMessageId);
  const { menu } = await openSideChatTabContextMenu(page, panel);
  const moveItem = menu.getByRole("menuitem", { name: "Move to Messenger" });
  await expect(moveItem).toHaveAttribute("aria-disabled", "true");
  await moveItem.focus();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText("Send a message first to create this Side Chat.");
  const [menuBox, tooltipBox] = await Promise.all([menu.boundingBox(), tooltip.boundingBox()]);
  expect(menuBox).not.toBeNull();
  expect(tooltipBox).not.toBeNull();
  expect(menuBox!.x).toBeGreaterThanOrEqual(0);
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(390);
  expect(tooltipBox!.x).toBeGreaterThanOrEqual(0);
  expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("12-side-chat-narrow-menu.png"), fullPage: true });
});

test("a failed Move to Messenger keeps the Side Chat tab and can be retried", async ({ page }) => {
  const source = await seedSideChatSource(page, `Side-Chat-Move-Retry-${Date.now()}`);
  const panel = await openSideChatFromPanelTarget(page);
  const sideChat = await sendFirstSideChatMessage(page, panel, source.conversationId);
  let moveAttempts = 0;
  await page.route(`**/api/chats/${sideChat.id}/side-chat/keep`, async (route) => {
    moveAttempts += 1;
    if (moveAttempts === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Promotion temporarily unavailable." }),
      });
      return;
    }
    await route.continue();
  });

  const firstMenu = (await openSideChatTabContextMenu(page, panel)).menu;
  await firstMenu.getByRole("menuitem", { name: "Move to Messenger" }).click();
  await expect(page.getByText("Could not move Side Chat", { exact: true })).toBeVisible();
  await expect(page.getByText("Promotion temporarily unavailable.", { exact: true })).toBeVisible();
  await expect(panel.locator('[data-side-panel-tab-key^="side-chat:"]')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/messenger/chat/${source.conversationId}$`));

  const retryResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && response.url().includes(`/api/chats/${sideChat.id}/side-chat/keep`)
    && response.status() < 500
  ));
  const retryMenu = (await openSideChatTabContextMenu(page, panel)).menu;
  await retryMenu.getByRole("menuitem", { name: "Move to Messenger" }).click();
  const retryResponse = await retryResponsePromise;
  expect(retryResponse.ok(), await retryResponse.text()).toBe(true);
  expect(moveAttempts).toBe(2);
  await expect(page).toHaveURL(new RegExp(`/messenger/chat/${sideChat.id}$`));
  await expect(page.getByTestId("side-chat-panel-view")).toHaveCount(0);
});

test("a Side Chat expiring after its menu opens stays in place and disables Move on refresh", async ({ page }) => {
  const source = await seedSideChatSource(page, `Side-Chat-Move-Race-${Date.now()}`);
  const panel = await openSideChatFromPanelTarget(page);
  const sideChat = await sendFirstSideChatMessage(page, panel, source.conversationId);
  const firstMenu = (await openSideChatTabContextMenu(page, panel)).menu;
  const firstMove = firstMenu.getByRole("menuitem", { name: "Move to Messenger" });
  await expect(firstMove).not.toHaveAttribute("aria-disabled", "true");

  await e2eDb
    .update(chatConversations)
    .set({ sideChatExpiresAt: new Date(Date.now() - 1_000) })
    .where(eq(chatConversations.id, sideChat.id));
  const raceResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && response.url().includes(`/api/chats/${sideChat.id}/side-chat/keep`)
  ));
  await firstMove.click();
  const raceResponse = await raceResponsePromise;
  expect(raceResponse.status()).toBe(409);
  await expect(page.getByText("Could not move Side Chat", { exact: true })).toBeVisible();
  await expect(page.getByText("Side Chat expired", { exact: true })).toBeVisible();
  await expect(panel.locator('[data-side-panel-tab-key^="side-chat:"]')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/messenger/chat/${source.conversationId}$`));

  const refreshedMenu = (await openSideChatTabContextMenu(page, panel)).menu;
  const refreshedMove = refreshedMenu.getByRole("menuitem", { name: "Move to Messenger" });
  await expect(refreshedMove).toHaveAttribute("aria-disabled", "true");
  await refreshedMove.hover();
  await expect(page.getByRole("tooltip")).toContainText(
    "This Side Chat can no longer be moved. Close it instead.",
  );
});

test("an elapsed Side Chat becomes non-editable and can still be destroyed", async ({ page }, testInfo) => {
  const source = await seedSideChatSource(page, `Side-Chat-Expiry-${Date.now()}`);
  const panel = await openSideChatFromPanelTarget(page);
  const createResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && response.url().includes(`/api/chats/${source.conversationId}/side-chats`)
  ));
  await sideComposerEditor(panel).fill("Expire this focused exploration.");
  await sideComposerSendButton(panel).click();
  const createResponse = await createResponsePromise;
  expect(createResponse.ok(), await createResponse.text()).toBe(true);
  const sideChat = await createResponse.json() as { id: string };
  await expect(panel.getByTestId("side-chat-messages")).toContainText("Expire this focused exploration.");
  await expect(panel.getByTestId("chat-assistant-message").filter({
    hasText: "Streaming reply for chat.",
  })).toBeVisible({ timeout: 20_000 });
  await waitForSideChatAssistantReplyToComplete(sideChat.id);
  await e2eDb
    .update(chatConversations)
    // This Playwright database is isolated to the run; reload makes the client
    // read the changed server deadline instead of a cached conversation.
    .set({ sideChatExpiresAt: new Date(Date.now() - 1_000) })
    .where(eq(chatConversations.id, sideChat.id));
  await page.evaluate((contextKey) => {
    localStorage.removeItem(`rudder:side-chat-panel-state:v1:${encodeURIComponent(contextKey)}`);
  }, `chat:${source.conversationId}`);
  await page.reload();
  const historyTrigger = page.getByTestId("side-chat-history-trigger");
  await expect(historyTrigger).toBeVisible();
  await historyTrigger.click();
  const historyItem = page.getByTestId("side-chat-history-item").filter({
    hasText: "Side chat from: Main strategy chat",
  });
  await expect(historyItem).toContainText("Expired · read-only");
  await historyItem.click();
  const expiredPanel = page.getByTestId("chat-side-panel");
  await expect(expiredPanel.getByTestId("side-chat-read-only")).toBeVisible({ timeout: 20_000 });
  await expect(expiredPanel.getByTestId("side-chat-state")).toContainText("Expired · read-only");
  await expect(expiredPanel.getByTestId("side-chat-composer")).toHaveCount(0);
  await expect(expiredPanel.getByTestId("side-chat-messages")).toContainText("Expire this focused exploration.");
  await page.screenshot({ path: testInfo.outputPath("10-side-chat-expired-read-only.png"), fullPage: true });

  await expiredPanel.getByTestId("chat-side-panel-collapse").click();
  await expect(expiredPanel).toBeHidden();
  await page.reload();
  const reopen = page.getByRole("button", { name: "Reopen Side Chat" });
  await expect(reopen).toBeVisible();
  await reopen.click();
  const restoredPanel = page.getByTestId("chat-side-panel");
  await expect(restoredPanel).toBeVisible();
  await expect(restoredPanel.getByTestId("side-chat-state")).toContainText("Expired · read-only");
  await expect(restoredPanel.getByTestId("side-chat-messages")).toContainText("Expire this focused exploration.");
  await expect(restoredPanel.getByTestId("chat-assistant-message").filter({
    hasText: "Streaming reply for chat.",
  })).toBeVisible();
  await expect(restoredPanel.getByTestId("side-chat-composer")).toHaveCount(0);

  const { menu } = await openSideChatTabContextMenu(page, restoredPanel);
  const expiredMove = menu.getByRole("menuitem", { name: "Move to Messenger" });
  await expect(expiredMove).toHaveAttribute("aria-disabled", "true");
  await expiredMove.hover();
  await expect(page.getByRole("tooltip")).toContainText("This Side Chat can no longer be moved. Close it instead.");
  await page.screenshot({ path: testInfo.outputPath("11-side-chat-expired-menu.png"), fullPage: true });

  const destroyResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "DELETE"
    && response.url().includes(`/api/chats/${sideChat.id}/side-chat`)
  ));
  await menu.getByRole("menuitem", { name: "Close Side Chat" }).click();
  expect((await destroyResponsePromise).ok()).toBe(true);
  expect((await page.request.get(`/api/chats/${sideChat.id}`)).status()).toBe(404);
});
