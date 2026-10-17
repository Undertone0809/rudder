import { expect, test } from "@playwright/test";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "../../packages/db/src/index.js";
import { startNativeChatFixture } from "./support/native-chat-fixture";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
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

test("uses one native Hermes session across server restart and sends only new input", async ({ page }, testInfo) => {
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
    await expect(composer).toBeVisible();
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
