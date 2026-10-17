import { expect, test } from "@playwright/test";
import { access } from "node:fs/promises";
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
    await page.screenshot({ path: testInfo.outputPath("native-chat-first-send-terminal.png"), fullPage: true });
    passed = true;
  } finally { await fixture.stop({ preserveRoot: !passed }); }
});
