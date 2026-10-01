import { expect, test } from "@playwright/test";
import path from "node:path";
import { eq } from "../../packages/db/node_modules/drizzle-orm/index.js";
import { chatMessageTranscriptEntries, createDb, heartbeatRunEvents, heartbeatRuns } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_DATABASE_URL, E2E_ROOT } from "./support/e2e-env";

const db = createDb(E2E_DATABASE_URL);
test.afterAll(async () => { await db.$client.end(); });

test("invalid Agent Run deep links report a missing run without losing the list", async ({ page }) => {
  const orgResponse = await page.request.post("/api/orgs", { data: { name: `Run Link ${Date.now()}` } });
  expect(orgResponse.ok()).toBe(true);
  const org = await orgResponse.json();
  const agent = await createE2EChatAgent(page.request, org.id, {
    command: path.join(E2E_ROOT, "fixtures/codex-native-session.mjs"),
  });
  const invalidRun = await page.request.get("/api/agent-runs/missing-run");
  expect(invalidRun.status()).toBe(404);

  await page.goto("/");
  await page.evaluate((id) => localStorage.setItem("rudder.selectedOrganizationId", id), org.id);
  await page.goto(`/${org.urlKey}/agents/${agent.urlKey}/runs/missing-run`);
  await expect(page.getByRole("alert")).toContainText("Run not found");
  await page.getByRole("link", { name: "Back to runs" }).click();
  await expect(page).toHaveURL(new RegExp(`/agents/${agent.urlKey}/runs$`));
});

test("native Chat and Side Chat retain sessions and exact Run history across reload and Keep", async ({ page }, testInfo) => {
  const orgResponse = await page.request.post("/api/orgs", { data: { name: `Native Chat ${Date.now()}` } });
  expect(orgResponse.ok()).toBe(true);
  const org = await orgResponse.json();
  const agent = await createE2EChatAgent(page.request, org.id, {
    command: path.join(E2E_ROOT, "fixtures/codex-native-session.mjs"),
  });
  await page.goto("/");
  await page.evaluate((id) => localStorage.setItem("rudder.selectedOrganizationId", id), org.id);
  await page.setViewportSize({ width: 1500, height: 940 });
  await page.goto(`/${org.urlKey}/messenger/chat?agentId=${agent.id}`);
  const composer = page.locator(".rudder-mdxeditor-content").first();
  await composer.fill("First native input");
  const firstStream = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/messages/stream"));
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await (await firstStream).finished();
  await expect(page.getByTestId("chat-assistant-message").last()).toContainText("Native reply 1", { timeout: 30_000 });
  const parentId = new URL(page.url()).pathname.split("/").at(-1)!;
  await expect(page.getByRole("button", { name: "Refresh answer" }).last()).toBeVisible();
  await expect(composer).toHaveText("");
  await composer.click();
  await page.keyboard.insertText("Second native input");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("chat-assistant-message").last()).toContainText("Native reply 2", { timeout: 30_000 });
  await page.reload();
  await expect(page.getByTestId("chat-assistant-message").last()).toContainText("Native reply 2");
  const assistantMessages = page.getByTestId("chat-assistant-message");
  const firstReplyId = await assistantMessages.first().getAttribute("data-message-id");
  const secondReplyId = await assistantMessages.last().getAttribute("data-message-id");
  expect(secondReplyId).toBeTruthy();
  expect(secondReplyId).not.toBe(firstReplyId);
  const parentRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.chatConversationId, parentId));
  expect(parentRuns).toHaveLength(2);
  const parentSession = parentRuns[0]!.sessionIdAfter;
  expect(parentSession).toBeTruthy();
  expect(parentRuns.every((run) => run.sessionIdAfter === parentSession)).toBe(true);
  expect(new Set(parentRuns.map((run) => run.externalRunId)).size).toBe(2);
  expect(parentRuns.every((run) => (run.logBytes ?? 0) === 0)).toBe(true);
  expect(await db.select().from(chatMessageTranscriptEntries).where(eq(chatMessageTranscriptEntries.orgId, org.id))).toHaveLength(0);
  for (const run of parentRuns) {
    const invokes = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id));
    const invocation = invokes.find((event) => event.eventType === "adapter.invoke");
    expect(invocation?.payload).toMatchObject({ invocationContent: expect.any(Object) });
    expect(invocation?.payload).not.toHaveProperty("prompt");
    expect(run.resultJson).toMatchObject({
      retention: { transcriptSource: "native", rawResultPersisted: false },
    });
    const response = await page.request.get(`/api/run-intelligence/runs/${run.id}/transcript`);
    expect(response.ok()).toBe(true);
    const transcript = await response.json();
    expect(transcript).toMatchObject({ source: "native", availability: "available", completeness: "complete" });
    expect(transcript.rows.filter((row: { kind: string }) => row.kind === "assistant")).toHaveLength(1);
  }
  await composer.fill("Preserve the parent draft");
  await assistantMessages.last().click({ button: "right" });
  await page.getByTestId("chat-message-context-menu").getByRole("menuitem", { name: "Open Side Chat" }).click();
  const panel = page.getByTestId("chat-side-panel");
  await expect(panel.getByTestId("side-chat-panel-view")).toBeVisible();
  expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.orgId, org.id))).toHaveLength(2);
  const creation = page.waitForResponse((response) => response.request().method() === "POST"
    && response.url().includes(`/api/chats/${parentId}/side-chats`));
  await panel.locator('[data-testid="side-chat-composer"]:visible .rudder-mdxeditor-content').first().fill("Branch the second reply");
  await panel.getByRole("button", { name: "Send Side Chat message" }).click();
  const creationResponse = await creation;
  expect(creationResponse.request().postDataJSON()).toMatchObject({ sourceMessageId: secondReplyId });
  const child = await creationResponse.json();
  await expect(panel.getByTestId("chat-assistant-message").last()).toContainText("Native reply 3", { timeout: 30_000 });
  await expect(composer).toContainText("Preserve the parent draft");
  const childRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.chatConversationId, child.id));
  expect(childRuns).toHaveLength(1);
  expect(childRuns.every((run) => (run.logBytes ?? 0) === 0)).toBe(true);
  expect(childRuns[0]!.sessionIdBefore).toBe(childRuns[0]!.sessionIdAfter);
  expect(childRuns[0]!.sessionIdAfter).not.toBe(parentSession);
  const childTranscript = await page.request.get(`/api/run-intelligence/runs/${childRuns[0]!.id}/transcript`);
  expect(childTranscript.ok()).toBe(true);
  expect(await childTranscript.json()).toMatchObject({ source: "native", availability: "available", completeness: "complete" });
  const keep = page.waitForResponse((response) => response.request().method() === "POST"
    && response.url().includes(`/api/chats/${child.id}/side-chat/keep`));
  await panel.locator('[data-side-panel-tab-key^="side-chat:"]').click({ button: "right" });
  await page.getByTestId("chat-side-panel-tab-context-menu").getByRole("menuitem", { name: "Move to Messenger" }).click();
  expect(await (await keep).json()).toMatchObject({ id: child.id, sideChatState: "kept", messengerVisible: true });
  await expect(page).toHaveURL(new RegExp(`/messenger/chat/${child.id}$`));
  await page.reload();
  await expect(page.getByTestId("chat-assistant-message").last()).toContainText("Native reply 3");
  await expect(page.getByRole("link", { name: "Open source message" })).toHaveAttribute(
    "href", `chat://${parentId}?messageId=${secondReplyId}`,
  );
  await expect.poll(async () => {
    const reply = await page.getByText("Native reply 3", { exact: true }).boundingBox();
    const composer = await page.locator(".rudder-mdxeditor-content").last().boundingBox();
    return Boolean(reply && composer && reply.y + reply.height <= composer.y);
  }, { timeout: 10_000 }).toBe(true);
  const afterKeep = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.chatConversationId, child.id));
  expect(afterKeep.map((run) => [run.id, run.sessionIdAfter])).toEqual(childRuns.map((run) => [run.id, run.sessionIdAfter]));
  const parentAfter = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.chatConversationId, parentId));
  expect(parentAfter.map((run) => [run.id, run.sessionIdAfter])).toEqual(parentRuns.map((run) => [run.id, run.sessionIdAfter]));
  expect(await db.select().from(chatMessageTranscriptEntries).where(eq(chatMessageTranscriptEntries.orgId, org.id))).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath("native-side-chat-kept.png"), fullPage: true });
});
