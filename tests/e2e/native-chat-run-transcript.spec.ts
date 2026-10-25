import { expect, test } from "@playwright/test";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "../../packages/db/src/index.js";
import { startNativeChatFixture } from "./support/native-chat-fixture";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const DECOY = "LATER RUN TRANSCRIPT MUST NOT REPLACE THE SELECTED RUN";
test.use({ actionTimeout: 30_000, navigationTimeout: 45_000 });

async function binary(env: string, relative: string) {
  const value = path.resolve(process.env[env]?.trim() || path.join(REPO, relative));
  await access(value);
  return value;
}

for (const runtimeType of ["codex_local", "hermes_local"] as const) {
  test(`reads the selected referenced ${runtimeType} Run transcript in Nice and Raw`, async ({ page }, testInfo) => {
    const postgresBinDir = process.env.RUDDER_POSTGRES_BIN_DIR;
    if (!postgresBinDir) throw new Error("Set RUDDER_POSTGRES_BIN_DIR to disposable PostgreSQL binaries");
    const f = await startNativeChatFixture({
      runtimeType,
      postgresBinDir,
      exampleBinary: await binary("RUDDER_NATIVE_CHAT_E2E_EXAMPLE", "native/target/debug/examples/native_chat_browser_fixture"),
      processHost: await binary("RUDDER_TEST_PROCESS_HOST", "native/target/debug/rudder-process-host"),
      foundationBinary: await binary("RUDDER_SERVER_FOUNDATION_PATH", "native/target/debug/rudder-server-foundation"),
    });
    let passed = false;
    try {
      await page.addInitScript((orgId: string) => window.localStorage.setItem("rudder.selectedOrganizationId", orgId), f.orgId);
      await page.goto(`${f.publicUrl}/native-${f.orgId}/messenger/chat/${f.chatId}`);
      const prompt = `Read this original ${runtimeType} turn from its native reference.`;
      const answer = runtimeType === "hermes_local" ? `Native Hermes answer: ${prompt}` : "synthetic answer";
      const composer = page.locator(".rudder-mdxeditor-content").first();
      const send = async (text: string, expectedAnswer: string, expectedCount = 1) => {
        await composer.fill(text);
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await expect(page.getByTestId("chat-assistant-message").filter({ hasText: expectedAnswer })).toHaveCount(expectedCount);
      };
      await send(prompt, answer);

      const db = createDb(f.databaseUrl);
      let runId = "";
      let assistantId = "";
      try {
        await expect.poll(async () => {
          const rows = await db.$client`SELECT id, status FROM heartbeat_runs WHERE org_id=${f.orgId}::uuid AND chat_conversation_id=${f.chatId}::uuid ORDER BY created_at DESC LIMIT 1`;
          return rows[0]?.status;
        }).toBe("succeeded");
        const rows = await db.$client`SELECT id, log_ref, context_snapshot, result_json FROM heartbeat_runs WHERE org_id=${f.orgId}::uuid AND chat_conversation_id=${f.chatId}::uuid ORDER BY created_at DESC LIMIT 1`;
        const run = rows[0];
        runId = run.id as string;
        expect(run.log_ref).toBeNull();
        const context = run.context_snapshot as Record<string, unknown>;
        expect(context.assistantMessageId).toBeUndefined();
        expect(context.runtimeBindingId).toBeTruthy();
        expect(context.nativeSegmentId).toBeTruthy();
        const result = run.result_json as { nativeChatFinalization: { result: { runId: string; assistantMessageId: string } } };
        expect(result.nativeChatFinalization.result.runId).toBe(runId);
        assistantId = result.nativeChatFinalization.result.assistantMessageId;
        expect(assistantId).toBeTruthy();

      } finally { await db.$client.end({ timeout: 5 }); }

      // A second real native turn catches resolvers that guess the latest reply.
      await send(DECOY, runtimeType === "hermes_local" ? `Native Hermes answer: ${DECOY}` : answer, runtimeType === "codex_local" ? 2 : 1);
      const messagesResponse = await page.request.get(`${f.publicUrl}/api/chats/${f.chatId}/messages?includeTranscript=false`);
      expect(messagesResponse.ok()).toBe(true);
      const messages = await messagesResponse.json() as Array<{ id: string; role: string; runId: string | null }>;
      const replies = messages.filter((message) => message.role === "assistant");
      expect(replies).toHaveLength(2);
      expect(replies.some((message) => message.id !== assistantId && message.runId !== runId)).toBe(true);

      const transcriptPath = `/api/chats/${f.chatId}/messages/${assistantId}/transcript`;
      const requests: string[] = [];
      page.on("request", (request) => {
        const pathname = new URL(request.url()).pathname;
        if (pathname.endsWith("/transcript")) requests.push(pathname);
      });
      const runUrl = `${f.publicUrl}/native-${f.orgId}/agents/${f.agentId}/runs/${runId}`;
      await page.goto(runUrl);
      const transcript = page.getByRole("region", { name: "Run transcript", exact: true });
      await expect(transcript).toContainText(answer);
      await expect(transcript).not.toContainText(DECOY);
      expect(requests).toContain(transcriptPath);
      expect(requests.every((value) => value === transcriptPath)).toBe(true);

      await page.getByRole("button", { name: /^raw$/i }).click();
      await expect(transcript).toContainText(answer);
      await expect(transcript).not.toContainText(DECOY);
      await page.getByRole("button", { name: "Expand transcript", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("region", { name: "Run transcript", exact: true })).toContainText(answer);
      await page.keyboard.press("Escape");
      await page.reload();
      await expect(transcript).toContainText(answer);
      await expect(transcript).not.toContainText(DECOY);

      // Even with the two lifecycle rows, a failed reader must remain visible.
      await page.route(`**${transcriptPath}`, (route) => route.fulfill({
        json: { messageId: assistantId, transcript: [], reader: { availability: "unavailable" } },
      }));
      await page.reload();
      await expect(transcript.getByRole("alert")).toContainText("Transcript unavailable.");
      await expect(transcript).not.toContainText(answer);
      await page.unroute(`**${transcriptPath}`);
      await transcript.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(transcript).toContainText(answer);
      await expect(transcript.getByRole("alert")).toHaveCount(0);
      await expect(transcript).not.toContainText(DECOY);
      await page.screenshot({ path: testInfo.outputPath(`${runtimeType}-referenced-run-transcript.png`), fullPage: true });
      passed = true;
    } finally { await f.stop({ preserveRoot: !passed }); }
  });
}
