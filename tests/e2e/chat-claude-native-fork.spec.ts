import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { asc, desc, eq } from "../../packages/db/node_modules/drizzle-orm/index.js";
import {
  chatGenerations,
  chatMessageTranscriptEntries,
  createDb,
  heartbeatRuns,
  nativeSegments,
  runRuntimeSpans,
  runtimeBindings,
} from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_DATABASE_URL, E2E_ROOT } from "./support/e2e-env";
import { restartE2eServer, stopRestartedE2eServer } from "./support/restart-e2e-server";

const db = createDb(E2E_DATABASE_URL);
const CLAUDE_FIXTURE = path.join(E2E_ROOT, "fixtures/claude-native-session.mjs");

test.afterAll(async () => {
  await stopRestartedE2eServer();
  await db.$client.end();
});

async function runsForConversation(conversationId: string) {
  return db.select().from(heartbeatRuns)
    .where(eq(heartbeatRuns.chatConversationId, conversationId))
    .orderBy(asc(heartbeatRuns.startedAt));
}

async function nativeForkIntentForConversation(conversationId: string) {
  const [binding] = await db.select().from(runtimeBindings)
    .where(eq(runtimeBindings.conversationId, conversationId)).limit(1);
  expect(binding?.currentSegmentId).toBeTruthy();
  const [segment] = await db.select().from(nativeSegments)
    .where(eq(nativeSegments.id, binding!.currentSegmentId!)).limit(1);
  expect(segment).toBeTruthy();
  return segment!.providerStateJson?.__rudderNativeForkIntent as Record<string, any> | undefined;
}

async function readJsonl(filePath: string) {
  return (await fs.readFile(filePath, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

function messageText(record: Record<string, any>) {
  const content = record.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block: Record<string, any>) => typeof block.text === "string" ? block.text : "").join("\n");
}

async function expectCompleteTranscript(
  page: Page,
  runId: string,
  userText: string,
  assistantText: string,
  expectedSource: "native" | "legacy" = "native",
) {
  const endpoint = `/api/run-intelligence/runs/${runId}/transcript?output=full&order=oldest&turnLimit=200`;
  const response = await page.request.get(endpoint);
  expect(response.ok(), await response.text()).toBe(true);
  const transcript = await response.json();
  expect.soft(transcript).toMatchObject({
    source: expectedSource,
    availability: "available",
    completeness: "complete",
  });
  expect.soft(transcript.rows.some((row: Record<string, any>) => row.kind === "user")).toBe(true);
  expect.soft(transcript.rows.some((row: Record<string, any>) => row.kind === "assistant"
    && (row.preview?.includes(assistantText) || row.detailPreview?.includes(assistantText)))).toBe(true);
  const readerMessages = transcript.entries
    .map((item: Record<string, any>) => item.entry as Record<string, any>)
    .filter((entry: Record<string, any>) => (entry.kind === "user" || entry.kind === "assistant")
      && typeof entry.text === "string")
    .map((entry: Record<string, any>) => ({ kind: entry.kind as string, text: entry.text as string }));
  const readerKinds = readerMessages.map((entry: { kind: string; text: string }) => entry.kind);
  const userMessages = readerMessages
    .filter((entry: { kind: string; text: string }) => entry.kind === "user")
    .map((entry: { kind: string; text: string }) => entry.text);
  const assistantMessages = readerMessages
    .filter((entry: { kind: string; text: string }) => entry.kind === "assistant")
    .map((entry: { kind: string; text: string }) => entry.text);
  expect.soft(readerKinds).toEqual(["user", "assistant"]);
  if (expectedSource === "native") {
    expect.soft(readerMessages.find((entry: { kind: string; text: string }) => entry.kind === "user")?.text)
      .toContain(userText);
  }
  expect.soft(assistantMessages).toEqual([assistantText]);
  const spans = await db.select({ id: runRuntimeSpans.id })
    .from(runRuntimeSpans)
    .where(eq(runRuntimeSpans.runId, runId));
  expect.soft(spans.length).toBeGreaterThan(0);
  return {
    runId,
    endpoint,
    source: transcript.source as string,
    availability: transcript.availability as string,
    completeness: transcript.completeness as string,
    spanIds: spans.map((span) => span.id),
    readerKinds,
    userMessages,
    assistantMessages,
  };
}

async function sendPrompt(page: Page, composer: Locator, prompt: string, reply: string) {
  await composer.fill(prompt);
  const streamPromise = page.waitForResponse((response: any) => (
    response.request().method() === "POST" && response.url().endsWith("/messages/stream")
  ));
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const stream = await streamPromise;
  expect(stream.ok(), await stream.text()).toBe(true);
  await stream.finished();
  await expect(page.getByTestId("chat-assistant-message").last()).toContainText(reply, { timeout: 30_000 });
}

async function sendSideChatPrompt(page: Page, panel: Locator, prompt: string, reply: string) {
  const composer = panel.locator('[data-testid="side-chat-composer"]:visible .rudder-mdxeditor-content').first();
  await composer.fill(prompt);
  const streamPromise = page.waitForResponse((response) => (
    response.request().method() === "POST" && response.url().endsWith("/messages/stream")
  ));
  await panel.getByRole("button", { name: "Send Side Chat message" }).click();
  const stream = await streamPromise;
  expect(stream.ok(), await stream.text()).toBe(true);
  await stream.finished();
  await expect(panel.getByTestId("chat-assistant-message").last()).toContainText(reply, { timeout: 30_000 });
}

async function sendSideChatPromptWithProcessLoss(page: Page, panel: Locator, prompt: string) {
  const composer = panel.locator('[data-testid="side-chat-composer"]:visible .rudder-mdxeditor-content').first();
  await composer.fill(prompt);
  const streamPromise = page.waitForResponse((response) => (
    response.request().method() === "POST" && response.url().endsWith("/messages/stream")
  ));
  await panel.getByRole("button", { name: "Send Side Chat message" }).click();
  const stream = await streamPromise;
  expect(stream.ok(), await stream.text()).toBe(true);
  await stream.finished();
}

async function seedDescriptorOnlyTerminalGeneration(conversationId: string, runId: string, sourceBoundaryRef: string) {
  const [binding] = await db.select().from(runtimeBindings)
    .where(eq(runtimeBindings.conversationId, conversationId)).limit(1);
  expect(binding?.currentSegmentId).toBeTruthy();
  const [segment] = await db.select().from(nativeSegments)
    .where(eq(nativeSegments.id, binding!.currentSegmentId!)).limit(1);
  const [generation] = await db.select().from(chatGenerations)
    .where(eq(chatGenerations.conversationId, conversationId))
    .orderBy(desc(chatGenerations.startedAt)).limit(1);
  expect(segment).toBeTruthy();
  expect(generation).toBeTruthy();

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(nativeSegments).set({
      state: "pending",
      sealedAt: null,
      nativeSessionId: null,
      rootSessionId: null,
      leafId: null,
      providerStateJson: null,
      sourceBoundaryRef,
      updatedAt: now,
    }).where(eq(nativeSegments.id, segment!.id));
    await tx.update(runRuntimeSpans).set({ nativeExecutionRef: null, updatedAt: now })
      .where(eq(runRuntimeSpans.runId, runId));
    await tx.update(heartbeatRuns).set({
      status: "failed",
      errorCode: "claude_fork_unsubmitted",
      error: "Claude deferred fork ended before provider submission; send a new message to retry the branch.",
      sessionIdAfter: null,
      sessionParamsAfterJson: null,
      finishedAt: now,
      updatedAt: now,
    }).where(eq(heartbeatRuns.id, runId));
    await tx.update(chatGenerations).set({
      status: "failed",
      terminalReason: "process_lost_before_provider_submission",
      completedAt: now,
      runtimeTerminalAt: now,
      updatedAt: now,
    }).where(eq(chatGenerations.id, generation!.id));
  });

  return { bindingId: binding!.id, segmentId: segment!.id, generationId: generation!.id };
}

test("Claude Side Chat forks the latest completed assistant head on its first real prompt", async ({ page }) => {
  const readerEvidence: Array<{
    runId: string;
    endpoint: string;
    source: string;
    availability: string;
    completeness: string;
    spanIds: string[];
    readerKinds: string[];
    userMessages: string[];
    assistantMessages: string[];
  }> = [];
  test.setTimeout(240_000);
  const orgResponse = await page.request.post("/api/orgs", { data: { name: `Claude Native Fork ${Date.now()}` } });
  expect(orgResponse.ok(), await orgResponse.text()).toBe(true);
  const org = await orgResponse.json() as { id: string; urlKey: string };
  const agent = await createE2EChatAgent(page.request, org.id, {
    name: "Claude Native Fork Agent",
    agentRuntimeType: "claude_local",
    agentRuntimeConfig: {
      command: CLAUDE_FIXTURE,
      model: "claude-e2e",
      // Keep the stub's project key aligned with the SDK's canonical path on macOS.
      cwd: path.resolve(E2E_ROOT, "../.."),
    },
  }) as { id: string };

  await page.goto("/");
  await page.evaluate((orgId) => localStorage.setItem("rudder.selectedOrganizationId", orgId), org.id);
  await page.setViewportSize({ width: 1500, height: 940 });
  await page.goto(`/${org.urlKey}/messenger/chat?agentId=${agent.id}`);
  const mainComposer = page.getByTestId("chat-composer-editor-scroll").locator(".rudder-mdxeditor-content").first();
  await expect(mainComposer).toBeVisible({ timeout: 45_000 });

  await sendPrompt(page, mainComposer, "First Claude native request", "Claude native reply 1");
  const parentId = new URL(page.url()).pathname.split("/").at(-1)!;
  await sendPrompt(page, mainComposer, "Second Claude native request", "Claude native reply 2");

  const assistantMessages = page.getByTestId("chat-assistant-message");
  const firstAssistantMessageId = await assistantMessages.first().getAttribute("data-message-id");
  const latestAssistantMessageId = await assistantMessages.last().getAttribute("data-message-id");
  expect(firstAssistantMessageId).toBeTruthy();
  expect(latestAssistantMessageId).toBeTruthy();
  expect(latestAssistantMessageId).not.toBe(firstAssistantMessageId);

  await page.reload();
  await expect(page.getByTestId("chat-assistant-message").last()).toContainText("Claude native reply 2");
  const parentRuns = await runsForConversation(parentId);
  expect(parentRuns).toHaveLength(2);
  expect(parentRuns.map((run) => run.status)).toEqual(["succeeded", "succeeded"]);
  const parentSessionId = parentRuns[0]!.sessionIdAfter;
  expect(parentSessionId).toBeTruthy();
  expect(parentRuns.every((run) => run.sessionIdAfter === parentSessionId)).toBe(true);
  expect(new Set(parentRuns.map((run) => run.externalRunId)).size).toBe(2);
  for (const [index, run] of parentRuns.entries()) {
    readerEvidence.push(await expectCompleteTranscript(
      page,
      run.id,
      index === 0 ? "First Claude native request" : "Second Claude native request",
      `Claude native reply ${index + 1}`,
    ));
  }
  expect(readerEvidence[0]!.userMessages[0]).not.toContain("Second Claude native request");
  expect(readerEvidence[1]!.userMessages[0]).not.toContain("First Claude native request");

  const parentParams = parentRuns[1]!.sessionParamsAfterJson ?? {};
  const configDir = String(parentParams.claudeConfigDir ?? "");
  const parentSessionPath = String(parentParams.sessionFilePath ?? "");
  expect(configDir).toBeTruthy();
  expect(parentSessionPath).toBeTruthy();
  const parentRecords = await readJsonl(parentSessionPath);
  const parentUserRecords = parentRecords.filter((record) => record.type === "user");
  const parentAssistantRecords = parentRecords.filter((record) => record.type === "assistant");
  expect(parentUserRecords).toHaveLength(2);
  expect(parentUserRecords.some((record) => messageText(record).includes("First Claude native request"))).toBe(true);
  expect(parentUserRecords.some((record) => messageText(record).includes("Second Claude native request"))).toBe(true);
  expect(parentAssistantRecords.map(messageText)).toEqual(["Claude native reply 1", "Claude native reply 2"]);
  const firstAssistantUuid = parentAssistantRecords[0]?.uuid;
  const parentHeadUuid = parentAssistantRecords.at(-1)?.uuid;
  expect(firstAssistantUuid).toBeTruthy();
  expect(parentHeadUuid).toBeTruthy();
  const parentSessionBytes = await fs.readFile(parentSessionPath);
  expect(readerEvidence[0]?.spanIds).toHaveLength(1);
  expect(readerEvidence[1]?.spanIds).toHaveLength(1);
  const firstParentSpanId = readerEvidence[0]!.spanIds[0]!;
  const secondParentSpanId = readerEvidence[1]!.spanIds[0]!;
  expect(secondParentSpanId).not.toBe(firstParentSpanId);

  const mainDraft = "Keep the main Chat draft through Side Chat.";
  await mainComposer.fill(mainDraft);
  await assistantMessages.first().hover();
  await assistantMessages.first().locator('[data-testid="chat-message-actions-trigger"]:visible').click();
  await page.getByTestId("chat-message-actions-menu").getByRole("menuitem", { name: "Open Side Chat" }).click();
  const panel = page.getByTestId("chat-side-panel");
  await expect(panel.getByTestId("side-chat-panel-view")).toBeVisible();
  await expect(mainComposer).toContainText(mainDraft);
  expect(await runsForConversation(parentId)).toHaveLength(2);

  const invocationPath = path.join(configDir, "rudder-e2e-invocations.jsonl");
  const invocationsBeforeSend = await readJsonl(invocationPath);
  expect(invocationsBeforeSend).toHaveLength(2);
  expect(invocationsBeforeSend.every((call) => !call.fork)).toBe(true);

  const sidePrompt = "Branch from Main1 after Main2 has advanced the Claude session.";
  const side2Prompt = "Continue Side1 in the same historical child session.";
  const createPromise = page.waitForResponse((response) => (
    response.request().method() === "POST" && response.url().includes(`/api/chats/${parentId}/side-chats`)
  ));
  const sideStreamPromise = page.waitForResponse((response) => (
    response.request().method() === "POST" && response.url().endsWith("/messages/stream")
  ));
  const sideComposer = panel.locator('[data-testid="side-chat-composer"]:visible .rudder-mdxeditor-content').first();
  await sideComposer.fill(sidePrompt);
  await panel.getByRole("button", { name: "Send Side Chat message" }).click();
  const createResponse = await createPromise;
  expect(createResponse.ok(), await createResponse.text()).toBe(true);
  expect(createResponse.request().postDataJSON()).toMatchObject({ sourceMessageId: firstAssistantMessageId });
  const child = await createResponse.json() as { id: string };
  const sideStream = await sideStreamPromise;
  expect(sideStream.ok(), await sideStream.text()).toBe(true);
  await sideStream.finished();

  const side1Runs = await runsForConversation(child.id);
  expect(side1Runs).toHaveLength(1);
  expect(side1Runs[0]!.status).toBe("succeeded");
  expect(side1Runs[0]!.sessionIdAfter).toBeTruthy();
  expect(side1Runs[0]!.sessionIdAfter).not.toBe(parentSessionId);
  const side1Reader = await expectCompleteTranscript(page, side1Runs[0]!.id, sidePrompt, "Claude native fork reply");
  readerEvidence.push(side1Reader);
  expect(side1Reader.spanIds).toHaveLength(1);
  expect(side1Reader.userMessages).toHaveLength(1);
  expect(side1Reader.userMessages[0]).toContain(sidePrompt);
  expect(side1Reader.userMessages[0]).not.toContain(side2Prompt);
  expect(side1Reader.userMessages[0]).not.toContain("Second Claude native request");

  const childParams = side1Runs[0]!.sessionParamsAfterJson ?? {};
  const childSessionPath = String(childParams.sessionFilePath ?? "");
  expect(childSessionPath).toBeTruthy();

  const invocations = await readJsonl(invocationPath);
  expect(invocations).toHaveLength(3);
  const forkInvocation = invocations[2]!;
  expect(forkInvocation.fork).toBe(false);
  expect(forkInvocation.args).not.toContain("--fork-session");
  expect(forkInvocation.resumedSessionId).toBe(side1Runs[0]!.sessionIdAfter);
  expect(forkInvocation.inputText).toContain(sidePrompt);
  expect(forkInvocation.sessionId).toBe(side1Runs[0]!.sessionIdAfter);
  expect(forkInvocation.sessionId).not.toBe(parentSessionId);

  const childRecords = await readJsonl(childSessionPath);
  const childAssistantRecords = childRecords.filter((record) => record.type === "assistant");
  const copiedSourceUuids = childRecords
    .filter((record) => (record.type === "user" || record.type === "assistant")
      && typeof record.forkedFrom?.messageUuid === "string")
    .map((record) => record.forkedFrom.messageUuid as string);
  expect(copiedSourceUuids).toEqual([parentUserRecords[0]!.uuid, firstAssistantUuid]);
  expect(childRecords.some((record) => messageText(record).includes("Second Claude native request"))).toBe(false);
  expect(childRecords.some((record) => messageText(record).includes("Claude native reply 2"))).toBe(false);
  expect(childRecords.some((record) => messageText(record).includes(side2Prompt))).toBe(false);
  expect(childAssistantRecords.map(messageText)).toEqual(["Claude native reply 1", "Claude native fork reply"]);
  expect(childAssistantRecords.at(-1)).toMatchObject({
    sessionId: side1Runs[0]!.sessionIdAfter,
    parentUuid: expect.any(String),
  });
  expect(messageText(childAssistantRecords.at(-1)!)).toBe("Claude native fork reply");
  expect(childRecords.every((record) => record.sessionId === side1Runs[0]!.sessionIdAfter)).toBe(true);
  const side1Intent = await nativeForkIntentForConversation(child.id);
  expect(side1Intent).toMatchObject({
    status: "accepted",
    idempotencyKey: `side-chat:${child.id}`,
    source: {
      sourceConversationId: parentId,
      sourceRunId: parentRuns[0]!.id,
      sourceSpanId: firstParentSpanId,
      sourceBoundaryRef: firstAssistantUuid,
      selectorJson: {
        kind: "claude_chain",
        sessionId: parentSessionId,
        throughInclusiveUuid: firstAssistantUuid,
      },
    },
  });
  expect(await fs.readFile(parentSessionPath)).toEqual(parentSessionBytes);
  await expect(panel.getByTestId("chat-assistant-message").last()).toContainText("Claude native fork reply", { timeout: 30_000 });

  await sendSideChatPrompt(page, panel, side2Prompt, "Claude native reply 3");
  const childRuns = await runsForConversation(child.id);
  expect(childRuns).toHaveLength(2);
  expect(childRuns[0]!.id).not.toBe(childRuns[1]!.id);
  expect(childRuns.every((run) => run.status === "succeeded")).toBe(true);
  const historicalChildSessionId = childRuns[0]!.sessionIdAfter;
  expect(historicalChildSessionId).toBeTruthy();
  expect(childRuns[1]!.sessionIdBefore).toBe(historicalChildSessionId);
  expect(childRuns[1]!.sessionIdAfter).toBe(historicalChildSessionId);
  const side1Span = await db.select({
    id: runRuntimeSpans.id,
    nativeExecutionRef: runRuntimeSpans.nativeExecutionRef,
    selectorJson: runRuntimeSpans.selectorJson,
    state: runRuntimeSpans.state,
    completeness: runRuntimeSpans.completeness,
  }).from(runRuntimeSpans).where(eq(runRuntimeSpans.runId, childRuns[0]!.id));
  const side2Span = await db.select({
    id: runRuntimeSpans.id,
    nativeExecutionRef: runRuntimeSpans.nativeExecutionRef,
    selectorJson: runRuntimeSpans.selectorJson,
    state: runRuntimeSpans.state,
    completeness: runRuntimeSpans.completeness,
  }).from(runRuntimeSpans).where(eq(runRuntimeSpans.runId, childRuns[1]!.id));
  expect(side1Span).toHaveLength(1);
  expect(side2Span).toHaveLength(1);
  expect(side1Span[0]).toMatchObject({ state: "sealed", completeness: "complete" });
  expect(side2Span[0]).toMatchObject({ state: "sealed", completeness: "complete" });
  expect(side1Span[0]!.id).not.toBe(side2Span[0]!.id);
  expect(side1Span[0]!.nativeExecutionRef).toBeTruthy();
  expect(side2Span[0]!.nativeExecutionRef).toBeTruthy();
  expect(side2Span[0]!.nativeExecutionRef).not.toBe(side1Span[0]!.nativeExecutionRef);
  expect(side2Span[0]!.selectorJson).toMatchObject({
    kind: "claude_chain",
    sessionId: historicalChildSessionId,
    startExclusiveUuid: side1Span[0]!.nativeExecutionRef,
    throughInclusiveUuid: side2Span[0]!.nativeExecutionRef,
  });
  const side2Reader = await expectCompleteTranscript(
    page,
    childRuns[1]!.id,
    side2Prompt,
    "Claude native reply 3",
  );
  readerEvidence.push(side2Reader);
  expect(side2Reader.spanIds).toHaveLength(1);
  expect(side2Reader.userMessages).toHaveLength(1);
  expect(side2Reader.userMessages[0]).toContain(side2Prompt);
  expect(side2Reader.userMessages[0]).not.toContain(sidePrompt);
  expect(side2Reader.userMessages[0]).not.toContain("Second Claude native request");
  expect(side1Reader.spanIds[0]).not.toBe(side2Reader.spanIds[0]);
  expect(side1Reader.assistantMessages).toEqual(["Claude native fork reply"]);
  expect(side2Reader.assistantMessages).toEqual(["Claude native reply 3"]);
  const invocationsAfterSide2 = await readJsonl(invocationPath);
  expect(invocationsAfterSide2).toHaveLength(4);
  const side2Invocation = invocationsAfterSide2[3]!;
  expect(side2Invocation.fork).toBe(false);
  expect(side2Invocation.args).not.toContain("--fork-session");
  expect(side2Invocation.resumedSessionId).toBe(historicalChildSessionId);
  expect(side2Invocation.sessionId).toBe(historicalChildSessionId);
  expect(side2Invocation.inputText).toContain(side2Prompt);
  const childRecordsAfterSide2 = await readJsonl(childSessionPath);
  expect(childRecordsAfterSide2.every((record) => record.sessionId === historicalChildSessionId)).toBe(true);
  expect(childRecordsAfterSide2.some((record) => messageText(record).includes("Second Claude native request"))).toBe(false);
  expect(childRecordsAfterSide2.some((record) => messageText(record).includes("Claude native reply 2"))).toBe(false);
  expect(childRecordsAfterSide2.some((record) => messageText(record).includes(sidePrompt))).toBe(true);
  expect(childRecordsAfterSide2.some((record) => messageText(record).includes(side2Prompt))).toBe(true);
  expect((await nativeForkIntentForConversation(child.id))?.intentId).toBe(side1Intent?.intentId);
  expect(await fs.readFile(parentSessionPath)).toEqual(parentSessionBytes);

  const keepPromise = page.waitForResponse((response) => (
    response.request().method() === "POST" && response.url().includes(`/api/chats/${child.id}/side-chat/keep`)
  ));
  await panel.locator('[data-side-panel-tab-key^="side-chat:"]').click({ button: "right" });
  await page.getByTestId("chat-side-panel-tab-context-menu")
    .getByRole("menuitem", { name: "Move to Messenger" }).click();
  const keepResponse = await keepPromise;
  expect(keepResponse.ok(), await keepResponse.text()).toBe(true);
  expect(await keepResponse.json()).toMatchObject({ id: child.id, messengerVisible: true, sideChatState: "kept" });
  await expect(page).toHaveURL(new RegExp(`/messenger/chat/${child.id}$`));

  await page.reload();
  await expect(page.getByTestId("chat-assistant-message").last()).toContainText("Claude native reply 3");
  await expect(page.getByRole("link", { name: "Open source message" })).toHaveAttribute(
    "href",
    `chat://${parentId}?messageId=${firstAssistantMessageId}`,
  );
  expect((await runsForConversation(parentId)).map((run) => [run.id, run.sessionIdAfter]))
    .toEqual(parentRuns.map((run) => [run.id, run.sessionIdAfter]));
  expect((await runsForConversation(child.id)).map((run) => [run.id, run.sessionIdAfter]))
    .toEqual(childRuns.map((run) => [run.id, run.sessionIdAfter]));

  await page.goto(`/${org.urlKey}/messenger/chat/${parentId}`);
  const headAssistant = page.locator(
    `[data-testid="chat-assistant-message"][data-message-id="${latestAssistantMessageId}"]`,
  );
  await expect(headAssistant).toBeVisible();
  await headAssistant.hover();
  await headAssistant.locator('[data-testid="chat-message-actions-trigger"]:visible').click();
  await page.getByTestId("chat-message-actions-menu").getByRole("menuitem", { name: "Open Side Chat" }).click();
  const headPanel = page.getByTestId("chat-side-panel");
  await expect(headPanel.getByTestId("side-chat-panel-view")).toBeVisible();
  const headPrompt = "Branch from Main2 in its own current-head Claude child.";
  const headCreatePromise = page.waitForResponse((response) => (
    response.request().method() === "POST" && response.url().includes(`/api/chats/${parentId}/side-chats`)
  ));
  const headStreamPromise = page.waitForResponse((response) => (
    response.request().method() === "POST" && response.url().endsWith("/messages/stream")
  ));
  const headComposer = headPanel.locator('[data-testid="side-chat-composer"]:visible .rudder-mdxeditor-content').first();
  await headComposer.fill(headPrompt);
  await headPanel.getByRole("button", { name: "Send Side Chat message" }).click();
  const headCreate = await headCreatePromise;
  expect(headCreate.ok(), await headCreate.text()).toBe(true);
  expect(headCreate.request().postDataJSON()).toMatchObject({ sourceMessageId: latestAssistantMessageId });
  const headChild = await headCreate.json() as { id: string };
  expect(headChild.id).not.toBe(child.id);
  const headStream = await headStreamPromise;
  expect(headStream.ok(), await headStream.text()).toBe(true);
  await headStream.finished();
  await expect(headPanel.getByTestId("side-chat-context-handoff")).toHaveCount(0);
  await expect(headPanel.getByTestId("chat-assistant-message").last()).toContainText("Claude native fork reply", {
    timeout: 30_000,
  });

  const headRuns = await runsForConversation(headChild.id);
  expect(headRuns).toHaveLength(1);
  expect(headRuns[0]!.status).toBe("succeeded");
  expect(headRuns[0]!.sessionIdAfter).toBeTruthy();
  expect(headRuns[0]!.sessionIdAfter).not.toBe(parentSessionId);
  expect(headRuns[0]!.sessionIdAfter).not.toBe(historicalChildSessionId);
  readerEvidence.push(await expectCompleteTranscript(
    page,
    headRuns[0]!.id,
    headPrompt,
    "Claude native fork reply",
  ));

  const invocationsAfterHeadChild = await readJsonl(invocationPath);
  expect(invocationsAfterHeadChild).toHaveLength(5);
  const headInvocation = invocationsAfterHeadChild[4]!;
  expect(headInvocation.fork).toBe(true);
  expect(headInvocation.args).toContain("--fork-session");
  expect(headInvocation.resumedSessionId).toBe(parentSessionId);
  expect(headInvocation.sessionId).toBe(headRuns[0]!.sessionIdAfter);
  expect(headInvocation.inputText).toContain(headPrompt);
  const headSessionPath = String(headRuns[0]!.sessionParamsAfterJson?.sessionFilePath ?? "");
  expect(headSessionPath).toBeTruthy();
  const headRecords = await readJsonl(headSessionPath);
  const headUserRecords = headRecords.filter((record) => record.type === "user");
  const headAssistantRecords = headRecords.filter((record) => record.type === "assistant");
  expect(headUserRecords).toHaveLength(3);
  expect(headUserRecords.some((record) => messageText(record).includes("First Claude native request"))).toBe(true);
  expect(headUserRecords.some((record) => messageText(record).includes("Second Claude native request"))).toBe(true);
  expect(headUserRecords.some((record) => messageText(record).includes(headPrompt))).toBe(true);
  expect(headAssistantRecords.map(messageText)).toEqual([
    "Claude native reply 1", "Claude native reply 2", "Claude native fork reply",
  ]);
  expect(headRecords.some((record) => messageText(record).includes(sidePrompt))).toBe(false);
  expect(headRecords.some((record) => messageText(record).includes(side2Prompt))).toBe(false);
  const headIntent = await nativeForkIntentForConversation(headChild.id);
  expect(headIntent).toMatchObject({
    status: "accepted",
    idempotencyKey: `side-chat:${headChild.id}`,
    source: {
      sourceConversationId: parentId,
      sourceRunId: parentRuns[1]!.id,
      sourceSpanId: secondParentSpanId,
      sourceBoundaryRef: parentHeadUuid,
      selectorJson: {
        kind: "claude_chain",
        sessionId: parentSessionId,
        throughInclusiveUuid: parentHeadUuid,
      },
    },
  });
  expect(headIntent?.intentId).not.toBe(side1Intent?.intentId);
  expect(await fs.readFile(parentSessionPath)).toEqual(parentSessionBytes);
  expect((await runsForConversation(parentId)).map((run) => [run.id, run.sessionIdAfter]))
    .toEqual(parentRuns.map((run) => [run.id, run.sessionIdAfter]));

  const processLossAnchor = page.locator(
    `[data-testid="chat-assistant-message"][data-message-id="${latestAssistantMessageId}"]`,
  ).first();
  await processLossAnchor.hover();
  await processLossAnchor.locator('[data-testid="chat-message-actions-trigger"]:visible').click();
  await page.getByTestId("chat-message-actions-menu").getByRole("menuitem", { name: "Open Side Chat" }).click();
  const recoveryPanel = page.getByTestId("chat-side-panel");
  const recoveryTabs = recoveryPanel.locator('[data-side-panel-tab-key^="side-chat:"]');
  await expect(recoveryTabs.last().getByRole("tab")).toHaveAttribute("aria-selected", "true");
  await expect(recoveryPanel.locator('[data-testid="side-chat-composer"]:visible .rudder-mdxeditor-content').first())
    .toBeVisible();

  const processLossPrompt = "RUDDER_E2E_PROCESS_LOSS: first Claude fork result is lost";
  const processLossCreatePromise = page.waitForResponse((response) => (
    response.request().method() === "POST" && response.url().includes(`/api/chats/${parentId}/side-chats`)
  ));
  await sendSideChatPromptWithProcessLoss(page, recoveryPanel, processLossPrompt);
  const processLossCreate = await processLossCreatePromise;
  expect(processLossCreate.ok(), await processLossCreate.text()).toBe(true);
  expect(processLossCreate.request().postDataJSON()).toMatchObject({ sourceMessageId: latestAssistantMessageId });
  const recoveryChild = await processLossCreate.json() as { id: string };
  await expect.poll(() => runsForConversation(recoveryChild.id), { timeout: 30_000 }).toHaveLength(1);
  const lostRun = (await runsForConversation(recoveryChild.id))[0]!;
  expect(lostRun.status).toBe("failed");
  expect.soft(lostRun.errorCode).toBe("claude_fork_acceptance_unknown");
  expect(lostRun.sessionIdAfter).toBeNull();

  const invocationsAfterProcessLoss = await readJsonl(invocationPath);
  expect(invocationsAfterProcessLoss).toHaveLength(6);
  expect(invocationsAfterProcessLoss[5]).toMatchObject({
    resumedSessionId: parentSessionId,
    fork: true,
  });
  expect(invocationsAfterProcessLoss[5]!.inputText).toContain(processLossPrompt);
  const [recoveryBinding] = await db.select().from(runtimeBindings)
    .where(eq(runtimeBindings.conversationId, recoveryChild.id)).limit(1);
  const [lostSegment] = await db.select().from(nativeSegments)
    .where(eq(nativeSegments.id, recoveryBinding!.currentSegmentId!)).limit(1);
  expect(lostSegment?.providerStateJson).toMatchObject({
    __rudderNativeForkIntent: { status: "unknown" },
  });
  const recoveryKeepPromise = page.waitForResponse((response) => (
    response.request().method() === "POST" && response.url().includes(`/api/chats/${recoveryChild.id}/side-chat/keep`)
  ));
  await recoveryTabs.last().click({ button: "right" });
  await page.getByTestId("chat-side-panel-tab-context-menu")
    .getByRole("menuitem", { name: "Move to Messenger" }).click();
  const recoveryKeep = await recoveryKeepPromise;
  expect(recoveryKeep.ok(), await recoveryKeep.text()).toBe(true);
  expect(await recoveryKeep.json()).toMatchObject({ id: recoveryChild.id, messengerVisible: true, sideChatState: "kept" });

  const descriptorOnly = await seedDescriptorOnlyTerminalGeneration(
    recoveryChild.id,
    lostRun.id,
    parentHeadUuid!,
  );
  await restartE2eServer();
  const healthAfterRestart = await page.request.get("/api/health");
  expect(healthAfterRestart.ok(), await healthAfterRestart.text()).toBe(true);
  await page.goto(`/${org.urlKey}/messenger/chat/${recoveryChild.id}`);
  await expect(mainComposer).toBeVisible();
  const [persistedGeneration] = await db.select().from(chatGenerations)
    .where(eq(chatGenerations.id, descriptorOnly.generationId));
  const [persistedSegment] = await db.select().from(nativeSegments)
    .where(eq(nativeSegments.id, descriptorOnly.segmentId));
  expect(persistedGeneration?.status).toBe("failed");
  expect(persistedSegment).toMatchObject({
    state: "pending",
    nativeSessionId: null,
    providerStateJson: null,
  });

  const retriedNativePrompt = "A new Claude prompt retries the pristine branch with a native first send.";
  await sendPrompt(page, mainComposer, retriedNativePrompt, "Claude native fork reply");
  const recoveryRuns = await runsForConversation(recoveryChild.id);
  expect(recoveryRuns).toHaveLength(2);
  expect(recoveryRuns[0]).toMatchObject({ status: "failed", errorCode: "claude_fork_unsubmitted" });
  expect(recoveryRuns[1]).toMatchObject({ status: "succeeded", sessionIdBefore: null });
  expect(recoveryRuns[1]!.sessionIdAfter).toBeTruthy();
  expect(recoveryRuns[1]!.sessionIdAfter).not.toBe(parentSessionId);
  readerEvidence.push(await expectCompleteTranscript(
    page,
    recoveryRuns[1]!.id,
    retriedNativePrompt,
    "Claude native fork reply",
  ));
  const invocationsAfterNativeRetry = await readJsonl(invocationPath);
  expect(invocationsAfterNativeRetry).toHaveLength(7);
  expect(invocationsAfterNativeRetry[6]).toMatchObject({
    resumedSessionId: parentSessionId,
    sessionId: recoveryRuns[1]!.sessionIdAfter,
    fork: true,
  });
  expect(invocationsAfterNativeRetry[6]!.inputText).toContain(retriedNativePrompt);
  expect(invocationsAfterNativeRetry[6]!.args).toContain("--fork-session");

  await page.goto(`/${org.urlKey}/messenger/chat/${parentId}`);
  const driftAnchor = page.locator(
    `[data-testid="chat-assistant-message"][data-message-id="${latestAssistantMessageId}"]`,
  ).first();
  await driftAnchor.hover();
  await driftAnchor.locator('[data-testid="chat-message-actions-trigger"]:visible').click();
  await page.getByTestId("chat-message-actions-menu").getByRole("menuitem", { name: "Open Side Chat" }).click();
  const driftPanel = page.getByTestId("chat-side-panel");
  await expect(driftPanel.getByTestId("side-chat-panel-view")).toBeVisible();
  const driftLossPrompt = "RUDDER_E2E_PROCESS_LOSS: source changes before the next Claude prompt";
  const driftCreatePromise = page.waitForResponse((response) => (
    response.request().method() === "POST" && response.url().includes(`/api/chats/${parentId}/side-chats`)
  ));
  await sendSideChatPromptWithProcessLoss(page, driftPanel, driftLossPrompt);
  const driftCreate = await driftCreatePromise;
  expect(driftCreate.ok(), await driftCreate.text()).toBe(true);
  expect(driftCreate.request().postDataJSON()).toMatchObject({ sourceMessageId: latestAssistantMessageId });
  const driftChild = await driftCreate.json() as { id: string };
  await expect.poll(() => runsForConversation(driftChild.id), { timeout: 30_000 }).toHaveLength(1);
  const driftLostRun = (await runsForConversation(driftChild.id))[0]!;
  expect(driftLostRun.status).toBe("failed");
  expect.soft(driftLostRun.errorCode).toBe("claude_fork_acceptance_unknown");
  const driftDescriptorOnly = await seedDescriptorOnlyTerminalGeneration(
    driftChild.id,
    driftLostRun.id,
    parentHeadUuid!,
  );

  const driftUserUuid = randomUUID();
  const driftAssistantUuid = randomUUID();
  const driftTimestamp = new Date().toISOString();
  await fs.appendFile(parentSessionPath, `${[
    {
      type: "user",
      uuid: driftUserUuid,
      parentUuid: parentHeadUuid,
      sessionId: parentSessionId,
      cwd: parentRecords[0]?.cwd,
      timestamp: driftTimestamp,
      message: { role: "user", content: [{ type: "text", text: "External Claude session advance" }] },
    },
    {
      type: "assistant",
      uuid: driftAssistantUuid,
      parentUuid: driftUserUuid,
      sessionId: parentSessionId,
      cwd: parentRecords[0]?.cwd,
      timestamp: driftTimestamp,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "External Claude answer advanced the provider head." }],
        stop_reason: "end_turn",
      },
    },
  ].map((record) => JSON.stringify(record)).join("\n")}\n`);

  const driftHandoffPrompt = "Continue from the saved answer without forking a drifted Claude head.";
  await sendSideChatPrompt(page, driftPanel, driftHandoffPrompt, "Claude native reply 1");
  await expect(driftPanel.getByTestId("side-chat-context-handoff")).toBeVisible();
  const driftRuns = await runsForConversation(driftChild.id);
  expect(driftRuns).toHaveLength(2);
  expect(driftRuns[0]).toMatchObject({ status: "failed", errorCode: "claude_fork_unsubmitted" });
  expect(driftRuns[1]!.status).toBe("succeeded");
  const [driftBinding] = await db.select().from(runtimeBindings)
    .where(eq(runtimeBindings.conversationId, driftChild.id))
    .orderBy(desc(runtimeBindings.bindingEpoch)).limit(1);
  expect(driftBinding?.continuity).toBe("context_handoff");
  readerEvidence.push(await expectCompleteTranscript(
    page,
    driftRuns[1]!.id,
    driftHandoffPrompt,
    "Claude native reply 1",
    "legacy",
  ));
  const finalInvocations = await readJsonl(invocationPath);
  expect(finalInvocations).toHaveLength(9);
  expect(finalInvocations[8]).toMatchObject({
    resumedSessionId: null,
    fork: false,
  });
  expect(finalInvocations[8]!.inputText).toContain(driftHandoffPrompt);
  expect(finalInvocations[8]!.args).not.toContain("--fork-session");

  console.log("CLAUDE_NATIVE_FORK_E2E_EVIDENCE", JSON.stringify({
    parentConversationId: parentId,
    parentSessionId,
    latestAssistantMessageId,
    sourceAssistantHeadUuid: parentHeadUuid,
    sideChats: [
      {
        id: child.id,
        sourceMessageId: firstAssistantMessageId,
        sourceSpanId: firstParentSpanId,
        side1RunId: childRuns[0]!.id,
        side1SpanId: side1Span[0]!.id,
        side2RunId: childRuns[1]!.id,
        side2SpanId: side2Span[0]!.id,
        sessionId: historicalChildSessionId,
        outcome: "historical_exact_fork_then_same_child_followup",
      },
      { id: headChild.id, sourceMessageId: latestAssistantMessageId, sourceSpanId: secondParentSpanId, outcome: "current_head_native_fork" },
      { id: recoveryChild.id, sourceMessageId: latestAssistantMessageId, outcome: "process_loss_then_native_retry" },
      { id: driftChild.id, sourceMessageId: latestAssistantMessageId, outcome: "process_loss_then_head_drift_handoff" },
    ],
    runs: [...parentRuns, ...childRuns, ...headRuns, ...recoveryRuns, ...driftRuns].map((run) => ({
      id: run.id,
      conversationId: run.chatConversationId,
      status: run.status,
      sessionIdAfter: run.sessionIdAfter,
    })),
    readers: readerEvidence,
    keepReload: { messengerVisible: true, childReplyRestored: true, sourceLinkRestored: true },
    historicalHead: {
      selectedMessageId: firstAssistantMessageId,
      latestMessageId: latestAssistantMessageId,
      sourceSpanId: firstParentSpanId,
      continuity: "native",
      nativeFork: true,
      exactPrefix: [parentUserRecords[0]!.uuid, firstAssistantUuid],
      laterTurnExcluded: true,
      sameChildFollowupRunId: childRuns[1]!.id,
      sameChildFollowupSpanId: side2Span[0]!.id,
      sameChildSession: true,
      followupDidNotForkAgain: true,
      sourceSessionUnchanged: true,
    },
    processLossRecovery: {
      failedRunId: lostRun.id,
      terminalGenerationId: descriptorOnly.generationId,
      retriedRunId: recoveryRuns[1]!.id,
      retryContinuity: "native",
      descriptorOnlySegment: descriptorOnly.segmentId,
    },
    sourceHeadDriftRecovery: {
      failedRunId: driftLostRun.id,
      terminalGenerationId: driftDescriptorOnly.generationId,
      retriedRunId: driftRuns[1]!.id,
      continuity: "context_handoff",
      driftAssistantUuid,
    },
  }));
  expect(await db.select().from(chatMessageTranscriptEntries).where(eq(chatMessageTranscriptEntries.orgId, org.id)))
    .toHaveLength(0);
});
