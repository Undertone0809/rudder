import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "../../packages/db/src/index.js";
import { startNativeChatFixture } from "./support/native-chat-fixture";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const BODY = "Create one native conversation from this first message.";

async function binary(name: string, relative: string) {
  const value = process.env[name]?.trim();
  const resolved = value ? path.resolve(value) : path.join(REPO, relative);
  await access(resolved).catch(() => { throw new Error(`${name} requires an existing binary: ${resolved}`); });
  return resolved;
}

test("creates a native Chat on the first browser Send with a stable identity and complete acknowledgement", async ({ page }, testInfo) => {
  const postgresBinDir = process.env.RUDDER_POSTGRES_BIN_DIR?.trim();
  if (!postgresBinDir) throw new Error("RUDDER_POSTGRES_BIN_DIR must identify the disposable PostgreSQL binaries");
  const fixture = await startNativeChatFixture({
    exampleBinary: await binary("RUDDER_NATIVE_CHAT_E2E_EXAMPLE", "native/target/debug/examples/native_chat_browser_fixture"),
    processHost: await binary("RUDDER_TEST_PROCESS_HOST", "native/target/debug/rudder-process-host"),
    foundationBinary: await binary("RUDDER_SERVER_FOUNDATION_PATH", "native/target/debug/rudder-server-foundation"),
    postgresBinDir: path.resolve(postgresBinDir),
  });
  let passed = false;
  try {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(`${fixture.publicUrl}/native-${fixture.orgId}/messenger/chat`);
    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible();
    await composer.fill(BODY);
    const requestPromise = page.waitForRequest((request) => request.method() === "POST"
      && new URL(request.url()).pathname === `/api/orgs/${fixture.orgId}/chats/messages/stream`);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const request = await requestPromise;
    const payload = request.postDataJSON() as { body: string; clientMutationId?: string };
    expect(payload.body).toBe(BODY);
    expect(payload.clientMutationId, "First Send must establish its durable retry identity before dispatch").toEqual(expect.any(String));
    expect(payload.clientMutationId?.trim().length).toBeGreaterThan(0);
    await expect(page).toHaveURL(/\/messenger\/chat\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: BODY })).toHaveCount(1);
    await expect(page.getByTestId("chat-assistant-message").filter({ hasText: "synthetic answer" })).toHaveCount(1);
    const acceptedChatId = new URL(page.url()).pathname.split("/").at(-1)!;
    expect(acceptedChatId).not.toBe(fixture.chatId);
    const db = createDb(fixture.databaseUrl);
    try {
      const rows = await db.$client`SELECT c.id::text AS id, c.initial_client_mutation_id AS mutation,
        (SELECT count(*)::int FROM heartbeat_runs r WHERE r.org_id=c.org_id AND r.chat_conversation_id=c.id AND r.execution_authority='native_rust') AS runs,
        (SELECT count(*)::int FROM chat_messages m WHERE m.org_id=c.org_id AND m.conversation_id=c.id AND m.role='user' AND m.body=${BODY}) AS inputs
        FROM chat_conversations c WHERE c.org_id=${fixture.orgId}::uuid AND c.id=${acceptedChatId}::uuid`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: acceptedChatId, mutation: payload.clientMutationId, runs: 1, inputs: 1 });
    } finally { await db.$client.end({ timeout: 5 }); }
    await page.reload();
    await expect(page.getByTestId("chat-assistant-message").filter({ hasText: "synthetic answer" })).toHaveCount(1);
    // Acknowledged admission belongs to the saved chat. Returning through the
    // sidebar must start a usable draft, not resurrect that admitted intent.
    await page.getByRole("link", { name: "New chat", exact: true }).click();
    await expect(page).toHaveURL(/\/messenger\/chat$/);
    await expect(page.getByRole("heading", { name: "What can I help with?", exact: true })).toBeVisible();
    await expect(composer).toHaveText("");
    await expect(page.getByRole("button", { name: "Open accepted chat", exact: true })).toHaveCount(0);
    await expect(page.getByText("Selected chat configuration is unavailable.", { exact: true })).toHaveCount(0);
    const secondBody = "Create a different native conversation after the accepted first one.";
    await composer.fill(secondBody);
    const secondRequestPromise = page.waitForRequest((next) => next.method() === "POST"
      && new URL(next.url()).pathname === `/api/orgs/${fixture.orgId}/chats/messages/stream`);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const secondPayload = (await secondRequestPromise).postDataJSON() as { clientMutationId: string; body: string };
    expect(secondPayload.body).toBe(secondBody);
    expect(secondPayload.clientMutationId).not.toBe(payload.clientMutationId);
    await expect(page).toHaveURL(/\/messenger\/chat\/[0-9a-f-]{36}$/);
    expect(new URL(page.url()).pathname.split("/").at(-1)).not.toBe(acceptedChatId);
    await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: secondBody })).toHaveCount(1);
    await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: BODY })).toHaveCount(0);
    await expect(page.getByTestId("chat-assistant-message").filter({ hasText: "synthetic answer" })).toHaveCount(1);
    const afterSecond = createDb(fixture.databaseUrl);
    try {
      const admitted = await afterSecond.$client`SELECT c.initial_client_mutation_id AS mutation,
        (SELECT count(*)::int FROM heartbeat_runs r WHERE r.org_id=c.org_id AND r.chat_conversation_id=c.id AND r.execution_authority='native_rust') AS runs,
        (SELECT count(*)::int FROM chat_messages m WHERE m.org_id=c.org_id AND m.conversation_id=c.id AND m.role='user') AS inputs
        FROM chat_conversations c WHERE c.org_id=${fixture.orgId}::uuid
          AND c.initial_client_mutation_id IN (${payload.clientMutationId!}, ${secondPayload.clientMutationId})`;
      expect(admitted).toHaveLength(2);
      expect(admitted).toEqual(expect.arrayContaining([
        { mutation: payload.clientMutationId, runs: 1, inputs: 1 },
        { mutation: secondPayload.clientMutationId, runs: 1, inputs: 1 },
      ]));
    } finally { await afterSecond.$client.end({ timeout: 5 }); }
    await page.screenshot({ path: testInfo.outputPath("native-chat-first-send-terminal.png"), fullPage: true });
    passed = true;
  } finally { await fixture.stop({ preserveRoot: !passed }); }
});


test("recovers a lost first acknowledgement after the current Agent changes without dispatching again", async ({ page }, testInfo) => {
  const postgresBinDir = process.env.RUDDER_POSTGRES_BIN_DIR?.trim();
  if (!postgresBinDir) throw new Error("RUDDER_POSTGRES_BIN_DIR must identify the disposable PostgreSQL binaries");
  const fixture = await startNativeChatFixture({
    exampleBinary: await binary("RUDDER_NATIVE_CHAT_E2E_EXAMPLE", "native/target/debug/examples/native_chat_browser_fixture"),
    processHost: await binary("RUDDER_TEST_PROCESS_HOST", "native/target/debug/rudder-process-host"),
    foundationBinary: await binary("RUDDER_SERVER_FOUNDATION_PATH", "native/target/debug/rudder-server-foundation"),
    postgresBinDir: path.resolve(postgresBinDir),
  });
  let passed = false;
  try {
    const firstSendPath = `/api/orgs/${fixture.orgId}/chats/messages/stream`;
    const firstSends: Array<{ body: string; clientMutationId: string }> = [];
    const changedAgentId = randomUUID();
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === firstSendPath) {
        firstSends.push(request.postDataJSON());
      }
    });
    // Forward the real request all the way through Rust admission/execution,
    // then drop its response. No successful API response is manufactured.
    await page.route(`**${firstSendPath}`, async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      const original = route.request().postDataJSON() as { clientMutationId: string };
      const db = createDb(fixture.databaseUrl);
      try {
        await db.$client`INSERT INTO agents(id,org_id,name,role,status,agent_runtime_type,agent_runtime_config)
          VALUES(${changedAgentId}::uuid,${fixture.orgId}::uuid,'Changed after Send','engineer','idle','codex_local','{}'::jsonb)`;
        const changed = await db.$client`UPDATE chat_conversations SET preferred_agent_id=${changedAgentId}::uuid
          WHERE org_id=${fixture.orgId}::uuid AND initial_client_mutation_id=${original.clientMutationId} RETURNING id`;
        expect(changed).toHaveLength(1);
      } finally { await db.$client.end({ timeout: 5 }); }
      await route.abort("connectionreset");
    }, { times: 1 });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(`${fixture.publicUrl}/native-${fixture.orgId}/messenger/chat`);
    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible();
    await composer.fill(BODY);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("button", { name: "Check status", exact: true })).toBeEnabled();
    expect(firstSends).toHaveLength(1);
    expect(firstSends[0].clientMutationId).toEqual(expect.any(String));
    const newerDraft = "Keep this newer draft while checking the accepted first message.";
    await composer.fill(newerDraft);
    await page.reload();
    await expect(composer).toContainText(newerDraft);
    await expect(page.getByRole("button", { name: "Open accepted chat", exact: true })).toBeVisible();
    expect(firstSends).toHaveLength(1);
    await page.getByRole("button", { name: "Open accepted chat", exact: true }).click();
    await expect(page).toHaveURL(/\/messenger\/chat\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: BODY })).toHaveCount(1);
    await expect(page.getByTestId("chat-assistant-message").filter({ hasText: "synthetic answer" })).toHaveCount(1);
    const chatId = new URL(page.url()).pathname.split("/").at(-1)!;
    const db = createDb(fixture.databaseUrl);
    try {
      const rows = await db.$client`SELECT c.initial_client_mutation_id AS mutation, c.preferred_agent_id::text AS preferred_agent,
        (SELECT count(*)::int FROM heartbeat_runs r WHERE r.org_id=c.org_id AND r.chat_conversation_id=c.id AND r.execution_authority='native_rust') AS runs,
        (SELECT count(*)::int FROM chat_messages m WHERE m.org_id=c.org_id AND m.conversation_id=c.id AND m.role='user' AND m.body=${BODY}) AS inputs
        FROM chat_conversations c WHERE c.org_id=${fixture.orgId}::uuid AND c.id=${chatId}::uuid`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ mutation: firstSends[0].clientMutationId, preferred_agent: changedAgentId, runs: 1, inputs: 1 });
    } finally { await db.$client.end({ timeout: 5 }); }
    expect(firstSends).toHaveLength(1);
    await page.screenshot({ path: testInfo.outputPath("native-chat-lost-first-ack-recovered.png"), fullPage: true });
    passed = true;
  } finally { await fixture.stop({ preserveRoot: !passed }); }
});

test("hands an active first Send to saved-chat recovery before New chat, reload and Stop", async ({ page }, testInfo) => {
  const postgresBinDir = process.env.RUDDER_POSTGRES_BIN_DIR?.trim();
  if (!postgresBinDir) throw new Error("RUDDER_POSTGRES_BIN_DIR must identify the disposable PostgreSQL binaries");
  const fixture = await startNativeChatFixture({
    exampleBinary: await binary("RUDDER_NATIVE_CHAT_E2E_EXAMPLE", "native/target/debug/examples/native_chat_browser_fixture"),
    processHost: await binary("RUDDER_TEST_PROCESS_HOST", "native/target/debug/rudder-process-host"),
    foundationBinary: await binary("RUDDER_SERVER_FOUNDATION_PATH", "native/target/debug/rudder-server-foundation"),
    postgresBinDir: path.resolve(postgresBinDir),
  });
  let passed = false;
  try {
    await writeFile(path.join(fixture.root, "isolated-home/mode.txt"), "live-stop-output-after-stop\n");
    const firstSends: Array<{ body: string; clientMutationId: string }> = [];
    page.on("request", (request) => {
      if (request.method() === "POST"
        && new URL(request.url()).pathname === `/api/orgs/${fixture.orgId}/chats/messages/stream`) {
        firstSends.push(request.postDataJSON());
      }
    });
    const providerMethods = async () => {
      try {
        return (await readFile(fixture.providerEventsPath, "utf8")).trim().split("\n").filter(Boolean)
          .map((line) => JSON.parse(line).received?.method as string | undefined);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    };
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(`${fixture.publicUrl}/native-${fixture.orgId}/messenger/chat`);
    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible();
    await composer.fill(BODY);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page).toHaveURL(/\/messenger\/chat\/[0-9a-f-]{36}$/);
    const firstUrl = page.url();
    const firstChatId = new URL(firstUrl).pathname.split("/").at(-1)!;
    await expect.poll(async () => (await providerMethods()).filter((method) => method === "turn/start").length,
      { timeout: 45_000 }).toBe(1);
    await page.getByRole("link", { name: "New chat", exact: true }).click();
    await expect(page).toHaveURL(/\/messenger\/chat$/);
    await expect(page.getByRole("heading", { name: "What can I help with?", exact: true })).toBeVisible();
    await expect(composer).toHaveText("");
    await expect(composer).toBeEditable();
    await expect(page.getByRole("button", { name: "Open accepted chat", exact: true })).toHaveCount(0);
    await expect(page.getByText("Selected chat configuration is unavailable.", { exact: true })).toHaveCount(0);
    const newerDraft = "A separate draft survives while the previous first response is active.";
    await composer.fill(newerDraft);
    await expect.poll(() => page.evaluate((orgId) => {
      const stored = JSON.parse(localStorage.getItem("rudder:chat-drafts") ?? "{}")[orgId]?.__new__;
      return typeof stored === "string" ? stored : stored?.body;
    }, fixture.orgId)).toBe(newerDraft);
    await page.reload();
    await expect(composer).toContainText(newerDraft);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    expect(firstSends).toHaveLength(1);

    await page.goto(firstUrl);
    await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: BODY })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Resume response", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop streaming", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Stop streaming", exact: true }).click();
    await expect(page.getByText("Stopped", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    expect((await providerMethods()).filter((method) => method === "turn/start")).toHaveLength(1);
    expect((await providerMethods()).filter((method) => method === "turn/interrupt")).toHaveLength(1);

    await page.getByRole("link", { name: "New chat", exact: true }).click();
    await expect(page.getByRole("heading", { name: "What can I help with?", exact: true })).toBeVisible();
    await expect(composer).toContainText(newerDraft);
    await expect(page.getByRole("button", { name: "Open accepted chat", exact: true })).toHaveCount(0);
    await writeFile(path.join(fixture.root, "isolated-home/mode.txt"), "complete\n");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page).toHaveURL(/\/messenger\/chat\/[0-9a-f-]{36}$/);
    const secondChatId = new URL(page.url()).pathname.split("/").at(-1)!;
    expect(secondChatId).not.toBe(firstChatId);
    await expect(page.getByTestId("chat-assistant-message").filter({ hasText: "synthetic answer" })).toHaveCount(1);
    expect(firstSends).toHaveLength(2);
    expect(firstSends[1].clientMutationId).not.toBe(firstSends[0].clientMutationId);
    const db = createDb(fixture.databaseUrl);
    try {
      const rows = await db.$client`SELECT c.id::text AS id,
        (SELECT count(*)::int FROM heartbeat_runs r WHERE r.org_id=c.org_id AND r.chat_conversation_id=c.id) AS runs,
        (SELECT count(*)::int FROM chat_messages m WHERE m.org_id=c.org_id AND m.conversation_id=c.id AND m.role='user') AS inputs
        FROM chat_conversations c WHERE c.org_id=${fixture.orgId}::uuid AND c.id IN (${firstChatId}::uuid, ${secondChatId}::uuid)`;
      expect(rows).toEqual(expect.arrayContaining([
        { id: firstChatId, runs: 1, inputs: 1 }, { id: secondChatId, runs: 1, inputs: 1 },
      ]));
    } finally { await db.$client.end({ timeout: 5 }); }
    await page.screenshot({ path: testInfo.outputPath("native-first-send-active-handoff.png"), fullPage: true });
    passed = true;
  } finally { await fixture.stop({ preserveRoot: !passed }); }
});
