import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "../../packages/db/src/index.js";
import { startNativeChatFixture } from "./support/native-chat-fixture";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const BODY = "Create one native conversation from this first message.";

type TransitionSample = {
  frame: number;
  at: number;
  welcomeHeading: boolean;
  visiblePromptItems: number;
  recoveryControls: string[];
  composerHeight: number | null;
  pendingFirstTurn: boolean;
};

async function binary(name: string, relative: string) {
  const value = process.env[name]?.trim();
  const resolved = value ? path.resolve(value) : path.join(REPO, relative);
  await access(resolved).catch(() => { throw new Error(`${name} requires an existing binary: ${resolved}`); });
  return resolved;
}

async function runDelayedFirstSend(
  page: Page,
  testInfo: TestInfo,
  options: {
    runtimeType: "codex_local" | "hermes_local";
    label: string;
    viewport: { width: number; height: number };
  },
) {
  const postgresBinDir = process.env.RUDDER_POSTGRES_BIN_DIR?.trim();
  if (!postgresBinDir) throw new Error("RUDDER_POSTGRES_BIN_DIR must identify the disposable PostgreSQL binaries");
  const fixture = await startNativeChatFixture({
    exampleBinary: await binary("RUDDER_NATIVE_CHAT_E2E_EXAMPLE", "native/target/debug/examples/native_chat_browser_fixture"),
    processHost: await binary("RUDDER_TEST_PROCESS_HOST", "native/target/debug/rudder-process-host"),
    foundationBinary: await binary("RUDDER_SERVER_FOUNDATION_PATH", "native/target/debug/rudder-server-foundation"),
    postgresBinDir: path.resolve(postgresBinDir),
    runtimeType: options.runtimeType,
  });
  let passed = false;
  const consoleErrors: string[] = [];
  let releaseAck!: () => void;
  let resolveAckFetched!: () => void;
  let ackStatus: number | null = null;
  const ackGate = new Promise<void>((resolve) => { releaseAck = resolve; });
  const ackFetched = new Promise<void>((resolve) => { resolveAckFetched = resolve; });
  const requestPath = `/api/orgs/${fixture.orgId}/chats/messages/stream`;
  const sends: Array<{ body: string; clientMutationId?: string }> = [];

  try {
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === requestPath) {
        sends.push(request.postDataJSON());
      }
    });

    // This recorder starts synchronously in the browser's capture phase for
    // the Send click, then samples the actual rendered tree before every paint.
    await page.addInitScript(() => {
      type Snapshot = {
        frame: number;
        at: number;
        welcomeHeading: boolean;
        visiblePromptItems: number;
        recoveryControls: string[];
        composerHeight: number | null;
        pendingFirstTurn: boolean;
      };
      const state = window as Window & { __nativeFirstSendFrames?: Snapshot[] };
      const samples: Snapshot[] = [];
      state.__nativeFirstSendFrames = samples;
      const visible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement) || element.getAttribute("aria-hidden") === "true") return false;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        for (let current: HTMLElement | null = element; current; current = current.parentElement) {
          if (current.getAttribute("aria-hidden") === "true") return false;
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || style.contentVisibility === "hidden") return false;
          if (Number.parseFloat(style.opacity || "1") <= 0.02) return false;
        }
        return true;
      };
      const sample = (at: number) => {
        const heading = document.querySelector(".motion-chat-empty-heading");
        const promptItems = Array.from(document.querySelectorAll(
          "[data-testid^='chat-empty-state-starter-'], [data-chat-option]",
        )).filter(visible).length;
        const recoveryControls = Array.from(document.querySelectorAll(
          "button, a, [role='status'], .chat-warning",
        )).filter(visible).map((element) => (element.textContent || element.getAttribute("aria-label") || "").trim())
          .filter((text) => /check status|open accepted chat|open agents|retry exact message|checking|unavailable|accepted|admission/i.test(text));
        const composer = document.querySelector("[data-testid='chat-composer-file-drop-target']");
        const composerHeight = composer && visible(composer) ? composer.getBoundingClientRect().height : null;
        samples.push({
          frame: samples.length + 1,
          at,
          welcomeHeading: visible(heading ?? null),
          visiblePromptItems: promptItems,
          recoveryControls,
          composerHeight,
          pendingFirstTurn: visible(document.querySelector("[data-testid='chat-pending-first-turn']")),
        });
      };
      let armed = false;
      const recordFrame = (at: number) => {
        if (armed) sample(at);
        window.requestAnimationFrame(recordFrame);
      };
      window.requestAnimationFrame(recordFrame);
      document.addEventListener("click", (event) => {
        const target = event.target;
        const button = target instanceof Element ? target.closest("button") : null;
        if (button?.getAttribute("aria-label") === "Send") armed = true;
      }, true);
    });

    await page.route(`**${requestPath}`, async (route) => {
      const response = await route.fetch();
      ackStatus = response.status();
      resolveAckFetched();
      await ackGate;
      await route.fulfill({ response });
    }, { times: 1 });

    await page.setViewportSize(options.viewport);
    await page.goto(`${fixture.publicUrl}/native-${fixture.orgId}/messenger/chat`);
    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible();
    const initialComposerHeight = await page.locator("[data-testid='chat-composer-file-drop-target']").evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    await composer.fill(BODY);
    const sendButton = page.getByRole("button", { name: "Send", exact: true });
    await expect(sendButton).toBeEnabled();
    await sendButton.click();

    await ackFetched;
    expect(ackStatus, "The fixture must return a real Rust admission ACK").toBe(200);
    // Keep the real ACK held long enough to observe dozens of animation
    // frames in the first-turn pending state before allowing route navigation.
    await expect.poll(() => page.evaluate(() => (
      (window as Window & { __nativeFirstSendFrames?: TransitionSample[] }).__nativeFirstSendFrames?.length ?? 0
    )), { timeout: 10_000 }).toBeGreaterThan(20);
    await expect(page.getByTestId("chat-pending-first-turn")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sending", exact: true })).toBeDisabled();
    await expect(page.getByTestId("chat-pending-first-turn").getByTestId("chat-user-message-bubble").filter({ hasText: BODY }))
      .toHaveCount(1);
    await expect(composer).toHaveText("");
    await page.waitForTimeout(500);

    const heldSamples = await page.evaluate(() => (
      (window as Window & { __nativeFirstSendFrames?: TransitionSample[] }).__nativeFirstSendFrames ?? []
    ));
    expect(heldSamples.length).toBeGreaterThan(35);
    const firstPendingFrame = heldSamples.findIndex((sample) => sample.pendingFirstTurn);
    expect(firstPendingFrame, "The held ACK never rendered the pending first turn").toBeGreaterThanOrEqual(0);
    const pendingSamples = heldSamples.slice(firstPendingFrame);
    expect(pendingSamples.some((sample) => sample.welcomeHeading), "The welcome heading reappeared after the pending first turn began")
      .toBe(false);
    expect(pendingSamples.every((sample) => sample.visiblePromptItems === 0), "Prompt suggestions reappeared after the pending first turn began")
      .toBe(true);
    expect(heldSamples.flatMap((sample) => sample.recoveryControls), "Normal first Send showed recovery UI")
      .toEqual([]);
    const heldComposerHeights = pendingSamples.map((sample) => sample.composerHeight).filter((height): height is number => height !== null);
    expect(heldComposerHeights.length).toBeGreaterThan(20);
    expect(Math.max(...heldComposerHeights) - Math.min(...heldComposerHeights), "Composer expanded during the held first Send")
      .toBeLessThanOrEqual(8);
    expect(Math.max(...heldComposerHeights) - initialComposerHeight, "Pending Send expanded the composer beyond its pre-send height")
      .toBeLessThanOrEqual(8);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ body: BODY, clientMutationId: expect.any(String) });
    const heldIntent = await page.evaluate(() => {
      const prefix = "rudder:native-chat-first-send:v1:scope:";
      return Object.keys(localStorage).filter((key) => key.startsWith(prefix)).map((key) => {
        const parsed = JSON.parse(localStorage.getItem(key) ?? "null") as {
          clientMutationId?: string;
          status?: string;
          draft?: { body?: string };
        } | null;
        return parsed && { clientMutationId: parsed.clientMutationId, status: parsed.status, body: parsed.draft?.body };
      });
    });
    expect(heldIntent, "The submitted Native first-send identity must remain durable while the ACK is held")
      .toEqual([{ clientMutationId: sends[0].clientMutationId, status: "pending", body: BODY }]);

    releaseAck();
    await expect(page).toHaveURL(/\/messenger\/chat\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: BODY })).toHaveCount(1);
    const expectedAssistantText = options.runtimeType === "hermes_local"
      ? `Native Hermes answer: ${BODY}`
      : "synthetic answer";
    await expect(page.getByTestId("chat-assistant-message").filter({ hasText: expectedAssistantText })).toHaveCount(1);
    await expect(composer).toHaveText("");
    await expect.poll(() => page.evaluate((orgId) => {
      const prefix = "rudder:native-chat-first-send:v1:scope:";
      const intents = Object.keys(localStorage).filter((key) => key.startsWith(prefix)).map((key) => {
        const parsed = JSON.parse(localStorage.getItem(key) ?? "null") as {
          clientMutationId?: string;
          status?: string;
          draft?: { body?: string };
        } | null;
        return parsed && { clientMutationId: parsed.clientMutationId, status: parsed.status, body: parsed.draft?.body };
      });
      const drafts = JSON.parse(localStorage.getItem("rudder:chat-drafts") ?? "{}");
      return { intents, newChatDraft: drafts?.[orgId]?.__new__ ?? null };
    }, fixture.orgId)).toEqual({
      intents: [{ clientMutationId: sends[0].clientMutationId, status: "settled", body: BODY }],
      newChatDraft: null,
    });
    const chatId = new URL(page.url()).pathname.split("/").at(-1)!;
    const db = createDb(fixture.databaseUrl);
    try {
      const rows = await db.$client`SELECT c.initial_client_mutation_id AS mutation,
        (SELECT count(*)::int FROM heartbeat_runs r WHERE r.org_id=c.org_id AND r.chat_conversation_id=c.id AND r.execution_authority='native_rust') AS runs,
        (SELECT count(*)::int FROM chat_messages m WHERE m.org_id=c.org_id AND m.conversation_id=c.id AND m.role='user' AND m.body=${BODY}) AS inputs
        FROM chat_conversations c WHERE c.org_id=${fixture.orgId}::uuid AND c.id=${chatId}::uuid`;
      expect(rows).toEqual([{ mutation: sends[0].clientMutationId, runs: 1, inputs: 1 }]);
    } finally { await db.$client.end({ timeout: 5 }); }

    const allSamples = await page.evaluate(() => (
      (window as Window & { __nativeFirstSendFrames?: TransitionSample[] }).__nativeFirstSendFrames ?? []
    ));
    const acceptedTransitionSamples = allSamples.slice(firstPendingFrame);
    const frameEvidencePath = testInfo.outputPath(`native-first-send-${options.label}-frames.json`);
    const screenshotPath = testInfo.outputPath(`native-first-send-${options.label}-terminal.png`);
    await mkdir(path.dirname(frameEvidencePath), { recursive: true });
    await writeFile(frameEvidencePath, `${JSON.stringify({
      runtimeType: options.runtimeType,
      viewport: options.viewport,
      initialComposerHeight,
      samples: allSamples,
    }, null, 2)}\n`);
    expect(acceptedTransitionSamples.some((sample) => sample.welcomeHeading), "The accepted route briefly returned to the welcome surface")
      .toBe(false);
    expect(acceptedTransitionSamples.every((sample) => sample.visiblePromptItems === 0), "Prompt starters reappeared during route acknowledgement")
      .toBe(true);
    expect(allSamples.flatMap((sample) => sample.recoveryControls), "Normal first Send showed recovery UI")
      .toEqual([]);
    expect(sends).toHaveLength(1);
    expect(consoleErrors, "Browser console or page errors during native first Send").toEqual([]);

    await page.screenshot({ path: screenshotPath, fullPage: true });
    passed = true;
  } finally {
    // If an assertion fails before release, unblock and cleanly stop the real fixture.
    releaseAck();
    await fixture.stop({ preserveRoot: !passed });
  }
}

test("keeps the delayed Hermes first-send transition stable on desktop", async ({ page }, testInfo) => {
  await runDelayedFirstSend(page, testInfo, {
    runtimeType: "hermes_local",
    label: "hermes-desktop",
    viewport: { width: 1440, height: 960 },
  });
});

test("keeps the delayed Codex first-send transition stable on a narrow viewport", async ({ page }, testInfo) => {
  await runDelayedFirstSend(page, testInfo, {
    runtimeType: "codex_local",
    label: "codex-narrow",
    viewport: { width: 390, height: 844 },
  });
});
