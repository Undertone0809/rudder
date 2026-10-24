import { expect, test, type Page } from "@playwright/test";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "../../packages/db/src/index.js";
import { startNativeChatFixture } from "./support/native-chat-fixture";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const HERMES_HOME = "operator-home/hermes-profile";
const RELOAD_PROMPT = "Show live Hermes progress after reload.";
const STOP_PROMPT = "Stop after Hermes emits public progress with a prompt error.";
const PUBLIC_THOUGHT = "PUBLIC HERMES THOUGHT";
const TOOL_TITLE = "web_search";
const PUBLIC_QUERY = "HERMES PUBLIC SEARCH";
const PUBLIC_RESULT = "PUBLIC HERMES SEARCH RESULT";
const PUBLIC_FAILURE = "PUBLIC HERMES READ FAILURE";
const PRIVATE_ARGUMENTS = "PRIVATE_HERMES_TOOL_ARGUMENTS_MUST_NOT_PROJECT";
const PRIVATE_RESULT = "PRIVATE_HERMES_TOOL_RESULT_MUST_NOT_PROJECT";
const LATE_PROGRESS = "LATE_HERMES_PROGRESS_AFTER_STOP_MUST_NOT_APPEAR";

async function binary(name: string, relative: string) {
  const resolved = path.resolve(process.env[name]?.trim() || path.join(REPO, relative));
  await access(resolved);
  return resolved;
}
async function fixture() {
  if (!process.env.RUDDER_POSTGRES_BIN_DIR) throw new Error("Set RUDDER_POSTGRES_BIN_DIR to disposable PostgreSQL binaries");
  return startNativeChatFixture({
    runtimeType: "hermes_local",
    exampleBinary: await binary("RUDDER_NATIVE_CHAT_E2E_EXAMPLE", "native/target/debug/examples/native_chat_browser_fixture"),
    processHost: await binary("RUDDER_TEST_PROCESS_HOST", "native/target/debug/rudder-process-host"),
    foundationBinary: await binary("RUDDER_SERVER_FOUNDATION_PATH", "native/target/debug/rudder-server-foundation"),
    postgresBinDir: process.env.RUDDER_POSTGRES_BIN_DIR,
  });
}
async function events(file: string) {
  try { return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

async function openChat(page: Page, f: Awaited<ReturnType<typeof fixture>>) {
  await page.addInitScript((orgId: string) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, f.orgId);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${f.publicUrl}/native-${f.orgId}/messenger/chat/${f.chatId}`);
  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 30_000 });
  return composer;
}

async function waitForFile(filePath: string) {
  await expect.poll(async () => {
    try { await access(filePath); return true; } catch { return false; }
  }, { timeout: 45_000 }).toBe(true);
}

async function expectPublicToolProjection(page: Page, chatId: string) {
  const messagesUrl = new URL(`/api/chats/${chatId}/messages?includeTranscript=true`, page.url());
  const response = await page.request.get(messagesUrl.toString());
  expect(response.ok()).toBe(true);
  const messages = await response.json() as Array<{ transcript?: Array<Record<string, unknown>> }>;
  const entries = messages.flatMap((message) => message.transcript ?? []);
  const toolCall = entries.find((entry) => entry.kind === "tool_call" && entry.name === TOOL_TITLE);
  expect(toolCall).toBeDefined();
  expect(toolCall?.input).toEqual({ query: PUBLIC_QUERY });
  const toolResult = entries.filter((entry) => entry.kind === "tool_result" && entry.toolUseId === toolCall?.toolUseId).at(-1);
  expect(toolResult).toMatchObject({ kind: "tool_result", content: PUBLIC_RESULT, status: "completed", isError: false });
  const readCall = entries.find((entry) => entry.kind === "tool_call" && entry.name === "read_file");
  expect(readCall?.input).toEqual({ path: "/tmp/hermes-fixture.txt" });
  expect(readCall?.toolUseId).not.toBe(toolCall?.toolUseId);
  const readResult = entries.find((entry) => entry.kind === "tool_result" && entry.toolUseId === readCall?.toolUseId);
  expect(readResult).toMatchObject({ content: PUBLIC_FAILURE, status: "failed", isError: true });
  const publicProjection = JSON.stringify(entries);
  expect(publicProjection).not.toContain(PRIVATE_ARGUMENTS);
  expect(publicProjection).not.toContain(PRIVATE_RESULT);
}

async function expectPublicProgress(page: Page, chatId: string, requirePartialAssistant = true) {
  const transcript = page.getByTestId("chat-transcript-content").last();
  if (!(await transcript.isVisible().catch(() => false))) {
    const processDetails = page.getByRole("button", { name: /^(Working for|Waiting for|Worked for|Process details)/ }).last();
    await expect(processDetails).toBeVisible({ timeout: 30_000 });
    if (await processDetails.getAttribute("aria-expanded") !== "true") await processDetails.click();
  }
  await expect(transcript).toBeVisible();
  await expect(transcript).toContainText(PUBLIC_THOUGHT);
  if (requirePartialAssistant) await expect(transcript).toContainText("Native Hermes answer:");

  // Chat presents short thinking inline. Expand it only if this transcript
  // happens to use a collapsible thinking block.
  const thinking = transcript.getByRole("button", { name: /^(Expand|Collapse) thinking$/ }).last();
  if (await thinking.count()) {
    if (await thinking.getAttribute("aria-label") === "Expand thinking") await thinking.click();
  }

  // Adjacent read/search actions share one compact activity disclosure.
  const group = transcript.getByRole("button", { name: /^Expand tool activity(?::|$)/ }).first();
  if (await group.count()) await group.click();

  // Expand both correlated tool rows to verify actual public requests/results.
  const toolDetails = transcript.getByRole("button", { name: /^(Expand|Collapse) tool details(?::|$)/ });
  await expect(toolDetails).toHaveCount(2);
  for (const button of await toolDetails.all()) {
    if (await button.getAttribute("aria-expanded") !== "true") await button.click();
  }
  await expect(transcript).toContainText(PUBLIC_QUERY);
  await expect(transcript).toContainText(PUBLIC_RESULT);
  await expect(transcript).toContainText(PUBLIC_FAILURE);
  await expect(transcript).toContainText("/tmp/hermes-fixture.txt");
  await expect(transcript.locator('[data-transcript-action-icon-slot="true"]').first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText(PRIVATE_ARGUMENTS);
  await expect(page.locator("body")).not.toContainText(PRIVATE_RESULT);
  await expectPublicToolProjection(page, chatId);
  return transcript;
}

async function openPersistedTranscript(page: Page, chatId: string, requirePartialAssistant = true) {
  return expectPublicProgress(page, chatId, requirePartialAssistant);
}

async function executionState(databaseUrl: string, orgId: string, chatId: string, prompt: string) {
  const db = createDb(databaseUrl);
  try {
    const rows = await db.$client.unsafe(
      `SELECT
         (SELECT status FROM heartbeat_runs WHERE org_id=$1::uuid AND chat_conversation_id=$2::uuid
           AND execution_authority='native_rust' ORDER BY created_at DESC LIMIT 1) AS "runStatus",
         (SELECT status FROM chat_generations WHERE org_id=$1::uuid AND conversation_id=$2::uuid
           AND execution_authority='native_rust' ORDER BY created_at DESC LIMIT 1) AS "generationStatus",
         (SELECT native_admission_hold FROM heartbeat_runs WHERE org_id=$1::uuid AND chat_conversation_id=$2::uuid
           AND execution_authority='native_rust' ORDER BY created_at DESC LIMIT 1) AS "runHold",
         (SELECT native_admission_hold FROM chat_generations WHERE org_id=$1::uuid AND conversation_id=$2::uuid
           AND execution_authority='native_rust' ORDER BY created_at DESC LIMIT 1) AS "generationHold",
         (SELECT count(*)::int FROM chat_messages WHERE org_id=$1::uuid AND conversation_id=$2::uuid
           AND role='user' AND body=$3) AS "userMessageCount",
         (SELECT count(*)::int FROM chat_messages WHERE org_id=$1::uuid AND conversation_id=$2::uuid
           AND role='assistant') AS "assistantMessageCount",
         (SELECT body FROM chat_messages WHERE org_id=$1::uuid AND conversation_id=$2::uuid
           AND role='assistant' ORDER BY created_at DESC LIMIT 1) AS "assistantBody",
         (SELECT result_json->'nativeChatFinalization'->'result' FROM heartbeat_runs WHERE org_id=$1::uuid AND chat_conversation_id=$2::uuid
           AND execution_authority='native_rust' ORDER BY created_at DESC LIMIT 1) AS "nativeOutcome"`,
      [orgId, chatId, prompt],
    );
    return (rows as unknown as Array<Record<string, unknown>>)[0];
  } finally { await db.$client.end({ timeout: 5 }); }
}

test("uses one native Hermes session across server restart and sends only new input", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const f = await fixture();
  let passed = false;
  try {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(`${f.publicUrl}/native-${f.orgId}/messenger/chat`);
    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible();
    const send = async (body: string) => {
      await composer.fill(body);
      const sendButton = page.getByRole("button", { name: "Send", exact: true });
      await expect(sendButton).toBeEnabled();
      await sendButton.click();
      await expect(page.getByTestId("chat-assistant-message").filter({ hasText: `Native Hermes answer: ${body}` })).toHaveCount(1);
    };
    await send("Remember this first native turn.");
    const chatId = new URL(page.url()).pathname.split("/").at(-1)!;
    await f.restartRust();
    await page.reload();
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await send("Continue the same session.");
    expect(new URL(page.url()).pathname.split("/").at(-1)).toBe(chatId);
    await expect(page.getByText("REPLAY MUST NOT APPEAR AS NEW OUTPUT", { exact: false })).toHaveCount(0);
    const observed = await events(f.providerEventsPath);
    expect(observed.filter((e) => e.method === "session/new")).toHaveLength(1);
    expect(observed.filter((e) => e.method === "session/load")).toHaveLength(1);
    expect(new Set(observed.map((e) => e.sessionId)).size).toBe(1);
    expect(observed.filter((e) => e.method === "session/prompt").map((e) => e.text)).toEqual([
      "Remember this first native turn.", "Continue the same session.",
    ]);
    const db = createDb(f.databaseUrl);
    try {
      const rows = await db.$client`SELECT r.status, r.execution_authority FROM heartbeat_runs r WHERE r.org_id=${f.orgId}::uuid AND r.chat_conversation_id=${chatId}::uuid ORDER BY r.created_at`;
      expect(rows.map((r) => r.status)).toEqual(["succeeded", "succeeded"]);
      expect(rows.every((r) => r.execution_authority === "native_rust")).toBe(true);
    } finally { await db.$client.end({ timeout: 5 }); }
    await page.reload();
    await page.screenshot({ path: testInfo.outputPath("native-hermes-restart-and-continue.png"), fullPage: true });
    passed = true;
  } finally { await f.stop({ preserveRoot: !passed }); }
});

test("recovers public Hermes progress after reload and finalizes the same turn", async ({ page }, testInfo) => {
  const f = await fixture();
  let passed = false;
  try {
    const composer = await openChat(page, f);
    await composer.fill(RELOAD_PROMPT);
    await page.getByRole("button", { name: "Send", exact: true }).click();

    const pending = path.join(f.root, HERMES_HOME, "output-pending");
    await waitForFile(pending);
    await page.screenshot({ path: testInfo.outputPath("native-hermes-public-progress-held.png"), fullPage: true });
    await expectPublicProgress(page, f.chatId);
    await expect(page.getByText("REPLAY MUST NOT APPEAR AS NEW OUTPUT", { exact: false })).toHaveCount(0);

    await page.reload();
    await expect(composer).toBeVisible();
    expect(new URL(page.url()).pathname.endsWith(`/${f.chatId}`)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("native-hermes-public-progress-reload-held.png"), fullPage: true });
    await openPersistedTranscript(page, f.chatId);
    await expect(page.getByRole("button", { name: "Stop streaming", exact: true })).toBeVisible();
    const beforeRelease = await events(f.providerEventsPath);
    expect(beforeRelease.filter((event) => event.method === "session/new")).toHaveLength(1);
    expect(beforeRelease.filter((event) => event.method === "session/load")).toHaveLength(0);
    expect(beforeRelease.filter((event) => event.method === "session/prompt").map((event) => event.text)).toEqual([RELOAD_PROMPT]);

    await writeFile(path.join(f.root, HERMES_HOME, "release-output"), "continue\n");
    const finalText = `Native Hermes answer: ${RELOAD_PROMPT}`;
    await expect(page.getByTestId("chat-assistant-message").filter({ hasText: finalText })).toHaveCount(1, { timeout: 45_000 });
    await expect.poll(() => executionState(f.databaseUrl, f.orgId, f.chatId, RELOAD_PROMPT), { timeout: 45_000 }).toMatchObject({
      runStatus: "succeeded",
      generationStatus: "completed",
      runHold: false,
      generationHold: false,
      userMessageCount: 1,
      assistantMessageCount: 1,
      assistantBody: finalText,
    });
    await expect(page.locator("body")).not.toContainText(PRIVATE_ARGUMENTS);
    await expect(page.locator("body")).not.toContainText(PRIVATE_RESULT);

    await page.reload();
    await expect(composer).toBeVisible();
    await expect(page.getByTestId("chat-assistant-message").filter({ hasText: finalText })).toHaveCount(1);
    await openPersistedTranscript(page, f.chatId, false);
    await expect(page.getByText("REPLAY MUST NOT APPEAR AS NEW OUTPUT", { exact: false })).toHaveCount(0);
    const afterReload = await events(f.providerEventsPath);
    expect(afterReload.filter((event) => event.method === "session/new")).toHaveLength(1);
    expect(afterReload.filter((event) => event.method === "session/load")).toHaveLength(0);
    expect(afterReload.filter((event) => event.method === "session/prompt").map((event) => event.text)).toEqual([RELOAD_PROMPT]);
    await page.screenshot({ path: testInfo.outputPath("native-hermes-public-progress-terminal.png"), fullPage: true });
    passed = true;
  } finally { await f.stop({ preserveRoot: !passed }); }
});

test("stops after a correlated Hermes prompt error and ignores late provider output", async ({ page }, testInfo) => {
  const f = await fixture();
  let passed = false;
  try {
    const composer = await openChat(page, f);
    await composer.fill(STOP_PROMPT);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await waitForFile(path.join(f.root, HERMES_HOME, "output-pending"));
    await page.screenshot({ path: testInfo.outputPath("native-hermes-public-progress-held.png"), fullPage: true });
    await expectPublicProgress(page, f.chatId);

    await page.getByRole("button", { name: "Stop streaming", exact: true }).click();
    await expect(page.getByText("Stopped", { exact: true }).first()).toBeVisible({ timeout: 45_000 });
    await expect.poll(() => executionState(f.databaseUrl, f.orgId, f.chatId, STOP_PROMPT), { timeout: 45_000 }).toMatchObject({
      runStatus: "cancelled",
      generationStatus: "stopped",
      runHold: false,
      generationHold: false,
      userMessageCount: 1,
    });
    await expect(page.locator("body")).not.toContainText(LATE_PROGRESS);
    await expect(page.locator("body")).not.toContainText(PRIVATE_ARGUMENTS);
    await expect(page.locator("body")).not.toContainText(PRIVATE_RESULT);

    await page.screenshot({ path: testInfo.outputPath("native-hermes-public-progress-stopped.png"), fullPage: true });
    await page.reload();
    await expect(composer).toBeVisible();
    await expect(page.getByText("Stopped", { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("native-hermes-public-progress-stopped-reload.png"), fullPage: true });
    await openPersistedTranscript(page, f.chatId);
    await expect(page.locator("body")).not.toContainText(LATE_PROGRESS);
    await expect(page.locator("body")).not.toContainText(PRIVATE_ARGUMENTS);
    await expect(page.locator("body")).not.toContainText(PRIVATE_RESULT);
    const stopped = await executionState(f.databaseUrl, f.orgId, f.chatId, STOP_PROMPT);
    expect(stopped).toMatchObject({ runStatus: "cancelled", generationStatus: "stopped", runHold: false,
      generationHold: false, userMessageCount: 1 });
    expect(stopped.nativeOutcome).toMatchObject({ providerStatus: "error_response", providerErrorCode: -32603,
      cancelSent: true, providerCancelAcknowledged: false, usageAvailable: false });
    expect(JSON.stringify(stopped.nativeOutcome)).not.toContain("PRIVATE_HERMES_PROMPT_ERROR");
    await expect(page.locator("body")).not.toContainText("PRIVATE_HERMES_PROMPT_ERROR");
    expect(Number(stopped.assistantMessageCount)).toBeLessThanOrEqual(1);
    expect(stopped.assistantBody == null || stopped.assistantBody === "").toBe(true);
    const observed = await events(f.providerEventsPath);
    expect(observed.filter((event) => event.method === "session/new")).toHaveLength(1);
    expect(observed.filter((event) => event.method === "session/load")).toHaveLength(0);
    expect(observed.filter((event) => event.method === "session/prompt").map((event) => event.text)).toEqual([STOP_PROMPT]);
    expect(observed.filter((event) => event.method === "session/cancel")).toHaveLength(1);
    passed = true;
  } finally { await f.stop({ preserveRoot: !passed }); }
});

test("configures Hermes through the runtime picker, checks native readiness and preserves a failed Profile draft", async ({ page }, testInfo) => {
  const f = await fixture();
  let passed = false;
  try {
    // Existing Codex data is setup only; the tested replacement is performed in UI.
    const setup = await page.request.patch(`${f.publicUrl}/api/agents/${f.agentId}`, {
      data: { agentRuntimeType: "codex_local", agentRuntimeConfig: { profileId: "operator-default", model: "gpt-5.4", search: true } },
    });
    expect(setup.ok()).toBe(true);
    await page.setViewportSize({ width: 1440, height: 960 });
    const detailResponse = page.waitForResponse((response) => response.url().includes(`/api/agents/${f.agentId}`) && response.request().method() === "GET");
    await page.goto(`${f.publicUrl}/native-${f.orgId}/agents/${f.agentId}/configuration`);
    const detail = await detailResponse;
    expect(detail.ok(), `Agent detail failed: ${await detail.text()}`).toBe(true);
    await page.getByRole("button", { name: "Codex (local)", exact: true }).click();
    const hermes = page.getByRole("button", { name: "Hermes", exact: true });
    await expect(hermes).toBeEnabled();
    await expect(page.getByRole("button", { name: /Hermes.*(?:legacy|API Server|HTTP gateway)/ })).toHaveCount(0);
    await hermes.click();
    await page.getByRole("button", { name: "Advanced options", exact: true }).click();
    const profile = page.getByPlaceholder("default", { exact: true });
    await expect(profile).toHaveValue("");
    await expect(page.getByText("Command", { exact: true })).toHaveCount(0);

    const check = async (status: "pass" | "fail") => {
      const responsePromise = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(`/api/orgs/${f.orgId}/native-chat/runtime-check`));
      await page.getByRole("button", { name: "Test runtime chain", exact: true }).click();
      const response = await responsePromise;
      expect(response.ok()).toBe(true);
      const result = await response.json();
      expect(result.agentRuntimeType).toBe("hermes_local");
      expect(result.status).toBe(status);
      await expect(page.getByText("Provider connectivity and model credentials were not tested.", { exact: true })).toBeVisible();
      return result;
    };
    await check("pass");
    const savedPromise = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes(`/api/agents/${f.agentId}`));
    await page.getByRole("button", { name: "Save", exact: true }).first().click();
    expect((await savedPromise).ok()).toBe(true);
    await page.reload();
    await expect(page.getByRole("button", { name: "Hermes", exact: true })).toBeVisible();
    const readback = await page.request.get(`${f.publicUrl}/api/agents/${f.agentId}`);
    const agent = await readback.json();
    expect(agent.agentRuntimeType).toBe("hermes_local");
    expect(agent.agentRuntimeConfig).toEqual({});
    await page.getByRole("button", { name: "Advanced options", exact: true }).click();
    await profile.fill("missing-profile-for-native-check");
    const failed = await check("fail");
    expect(failed.checks.some((item: { code: string }) => /profile/.test(item.code))).toBe(true);
    await expect(profile).toHaveValue("missing-profile-for-native-check");
    await page.screenshot({ path: testInfo.outputPath("hermes-invalid-profile-draft.png"), fullPage: true });
    await page.getByRole("button", { name: "Cancel", exact: true }).first().click();
    await expect(profile).toHaveValue("");
    await check("pass");
    passed = true;
  } finally { await f.stop({ preserveRoot: !passed }); }
});
