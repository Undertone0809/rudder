import { expect, test, type Page } from "@playwright/test";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "../../packages/db/src/index.js";
import { startNativeChatFixture } from "./support/native-chat-fixture";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PROVIDER = "vendor/native-chat-executor-model";
const ORIGINAL_MESSAGE = "Continue the accepted response after reconnecting.";
const NEWER_DRAFT = "Keep this newer unsent draft through recovery.";

type StreamRequest = { body: string; clientMutationId: string };
type ExecutionSnapshot = {
  runCount: number;
  attemptCount: number;
  generationCount: number;
  sourceCount: number;
  assistantCount: number;
  runStatus: string | null;
  generationStatus: string | null;
};

function resolveBinary(envName: string, relativeDefault: string) {
  const configured = process.env[envName]?.trim();
  const candidate = configured ? path.resolve(configured) : path.join(REPO_ROOT, relativeDefault);
  return access(candidate).then(() => candidate).catch(() => {
    throw new Error(`${envName} must point to an existing test binary; checked ${candidate}`);
  });
}

async function fixtureOptions() {
  const postgresBinDir = process.env.RUDDER_POSTGRES_BIN_DIR?.trim();
  if (!postgresBinDir) throw new Error("RUDDER_POSTGRES_BIN_DIR must point to the disposable PostgreSQL 17 binaries");
  return {
    exampleBinary: await resolveBinary(
      "RUDDER_NATIVE_CHAT_E2E_EXAMPLE",
      "native/target/debug/examples/native_chat_browser_fixture",
    ),
    foundationBinary: await resolveBinary(
      "RUDDER_SERVER_FOUNDATION_PATH",
      "native/target/debug/rudder-server-foundation",
    ),
    processHost: await resolveBinary(
      "RUDDER_TEST_PROCESS_HOST",
      "native/target/debug/rudder-process-host",
    ),
    postgresBinDir: path.resolve(postgresBinDir),
  };
}

async function readProviderEvents(eventsPath: string): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(eventsPath, "utf8");
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function waitForFile(filePath: string) {
  await expect.poll(async () => {
    try { await access(filePath); return true; } catch { return false; }
  }, { timeout: 45_000 }).toBe(true);
}

function streamRequests(page: Page) {
  const requests: StreamRequest[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || !new URL(request.url()).pathname.endsWith("/messages/stream")) return;
    try {
      const body = request.postDataJSON() as Partial<StreamRequest>;
      if (typeof body.body === "string" && typeof body.clientMutationId === "string") {
        requests.push({ body: body.body, clientMutationId: body.clientMutationId });
      }
    } catch { /* Other stream endpoints use a different contract. */ }
  });
  return requests;
}

async function databaseSnapshot(databaseUrl: string, orgId: string, chatId: string, body: string) {
  const db = createDb(databaseUrl);
  try {
    const result = await db.$client.unsafe(
      `SELECT
         (SELECT count(*)::int FROM heartbeat_runs r
           WHERE r.org_id=$1::uuid AND r.chat_conversation_id=$2::uuid
             AND r.execution_authority='native_rust') AS "runCount",
         (SELECT count(*)::int FROM heartbeat_run_attempts a
           JOIN heartbeat_runs r ON r.org_id=a.org_id AND r.id=a.run_id
           WHERE r.org_id=$1::uuid AND r.chat_conversation_id=$2::uuid
             AND r.execution_authority='native_rust') AS "attemptCount",
         (SELECT count(*)::int FROM chat_generations g
           WHERE g.org_id=$1::uuid AND g.conversation_id=$2::uuid
             AND g.execution_authority='native_rust') AS "generationCount",
         (SELECT count(*)::int FROM chat_messages m
           WHERE m.org_id=$1::uuid AND m.conversation_id=$2::uuid
             AND m.role='user' AND m.body=$3) AS "sourceCount",
         (SELECT count(*)::int FROM chat_messages m
           WHERE m.org_id=$1::uuid AND m.conversation_id=$2::uuid
             AND m.role='assistant' AND m.body='synthetic answer') AS "assistantCount",
         (SELECT r.status FROM heartbeat_runs r
           WHERE r.org_id=$1::uuid AND r.chat_conversation_id=$2::uuid
             AND r.execution_authority='native_rust' ORDER BY r.created_at DESC LIMIT 1) AS "runStatus",
         (SELECT g.status FROM chat_generations g
           WHERE g.org_id=$1::uuid AND g.conversation_id=$2::uuid
             AND g.execution_authority='native_rust' ORDER BY g.created_at DESC LIMIT 1) AS "generationStatus"`,
      [orgId, chatId, body],
    );
    return (result as unknown as ExecutionSnapshot[])[0];
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}

async function openChat(page: Page, fixture: Awaited<ReturnType<typeof startNativeChatFixture>>) {
  const orgKey = `native-${fixture.orgId}`;
  await page.addInitScript((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, fixture.orgId);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${fixture.publicUrl}/${orgKey}/messenger/chat/${fixture.chatId}`);
  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 30_000 });
  return composer;
}

test("resumes the exact accepted Run after reload without replacing a newer draft", async ({ page }, testInfo) => {
  const fixture = await startNativeChatFixture({ ...(await fixtureOptions()), mode: "visible_checkpoint" });
  let passed = false;
  try {
    const requests = streamRequests(page);
    const composer = await openChat(page, fixture);
    await composer.fill(ORIGINAL_MESSAGE);
    await page.getByRole("button", { name: "Send", exact: true }).click();

    // The provider is a local synthetic process. It pauses after a real turn
    // checkpoint, keeping the Rust-owned stream live while this browser drops.
    await waitForFile(path.join(fixture.root, "isolated-home/output-pending"));
    await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: ORIGINAL_MESSAGE })).toHaveCount(1);
    await expect.poll(async () => {
      const snapshot = await databaseSnapshot(fixture.databaseUrl, fixture.orgId, fixture.chatId, ORIGINAL_MESSAGE);
      return [snapshot.runCount, snapshot.attemptCount, snapshot.generationCount, snapshot.sourceCount];
    }).toEqual([1, 1, 1, 1]);
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toBe(ORIGINAL_MESSAGE);

    await expect.poll(async () => (await composer.innerText()).trim()).toBe("");
    await composer.fill(NEWER_DRAFT);

    // A full page reload closes the actual HTTP stream. Rust keeps the owned
    // worker and database state; no route interception or API success mock is
    // involved in this journey.
    await page.reload();
    await expect(composer).toBeVisible();
    await expect(composer).toContainText(NEWER_DRAFT);
    const resume = page.getByRole("button", { name: "Resume response", exact: true });
    await expect(resume).toBeVisible({ timeout: 30_000 });
    await resume.click();

    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1]).toEqual(requests[0]);
    await expect(composer).toContainText(NEWER_DRAFT);
    await writeFile(path.join(fixture.root, "isolated-home/release-output"), "continue\n");

    const assistant = page.getByTestId("chat-assistant-message").filter({ hasText: "synthetic answer" }).last();
    await expect(assistant).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: ORIGINAL_MESSAGE })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Resume response", exact: true })).toHaveCount(0);
    await expect(composer).toContainText(NEWER_DRAFT);

    await expect.poll(async () => {
      const snapshot = await databaseSnapshot(fixture.databaseUrl, fixture.orgId, fixture.chatId, ORIGINAL_MESSAGE);
      return snapshot;
    }).toMatchObject({
      runCount: 1,
      attemptCount: 1,
      generationCount: 1,
      sourceCount: 1,
      assistantCount: 1,
      runStatus: "succeeded",
      generationStatus: "completed",
    });
    const providerEvents = await readProviderEvents(fixture.providerEventsPath);
    const methods = providerEvents.map((event) => (event.received as Record<string, unknown> | undefined)?.method);
    expect(methods.filter((method) => method === "thread/start")).toHaveLength(1);
    expect(methods.filter((method) => method === "thread/resume")).toHaveLength(0);
    expect(methods.filter((method) => method === "turn/start")).toHaveLength(1);
    expect(methods.filter((method) => method === "turn/interrupt")).toHaveLength(0);

    await page.screenshot({ path: testInfo.outputPath("native-chat-resumed-terminal.png"), fullPage: true });
    passed = true;
  } finally {
    await fixture.stop({ preserveRoot: !passed });
  }
});
test("resumes an active Run and then records an explicit Stop without another provider start", async ({ page }, testInfo) => {
  const fixture = await startNativeChatFixture({ ...(await fixtureOptions()), mode: "complete" });
  let passed = false;
  try {
    await writeFile(path.join(fixture.root, "isolated-home/mode.txt"), "live-stop-output-after-stop\n");
    const requests = streamRequests(page);
    const composer = await openChat(page, fixture);
    await composer.fill("Keep this accepted message while stopping its response.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(async () => {
      const events = await readProviderEvents(fixture.providerEventsPath);
      return events.some((event) => (event.received as Record<string, unknown> | undefined)?.method === "turn/start");
    }, { timeout: 45_000 }).toBe(true);

    await page.reload();
    await expect(composer).toBeVisible();
    const resume = page.getByRole("button", { name: "Resume response", exact: true });
    await expect(resume).toBeVisible({ timeout: 30_000 });
    await resume.click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1]).toEqual(requests[0]);
    await expect(page.getByRole("button", { name: "Stop streaming", exact: true })).toBeVisible({ timeout: 30_000 });
    const afterStopDraft = "Keep this unsent draft while the stopped Run settles.";
    await composer.fill(afterStopDraft);
    await page.getByRole("button", { name: "Stop streaming", exact: true }).click();
    await expect(page.getByRole("button", { name: "Stop streaming", exact: true })).toHaveCount(0, { timeout: 45_000 });
    await expect(page.getByText("Stopped", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: testInfo.outputPath("native-chat-stop-confirmed.png"), fullPage: true });

    await expect(composer).toContainText(afterStopDraft);
    await expect(page.getByRole("button", { name: "Resume response", exact: true })).toHaveCount(0);
    await page.reload();
    await expect(composer).toContainText(afterStopDraft);
    await expect(page.getByRole("button", { name: "Resume response", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("native-chat-stop-after-reload-terminal.png"), fullPage: true });
    const snapshot = await databaseSnapshot(
      fixture.databaseUrl,
      fixture.orgId,
      fixture.chatId,
      "Keep this accepted message while stopping its response.",
    );
    expect(snapshot).toMatchObject({ runCount: 1, attemptCount: 1, generationCount: 1, sourceCount: 1,
      runStatus: "cancelled", generationStatus: "stopped" });
    const providerEvents = await readProviderEvents(fixture.providerEventsPath);
    const methods = providerEvents.map((event) => (event.received as Record<string, unknown> | undefined)?.method);
    expect(methods.filter((method) => method === "thread/start")).toHaveLength(1);
    expect(methods.filter((method) => method === "turn/start")).toHaveLength(1);
    expect(methods.filter((method) => method === "turn/interrupt")).toHaveLength(1);
    passed = true;
  } finally {
    await fixture.stop({ preserveRoot: !passed });
  }
});
