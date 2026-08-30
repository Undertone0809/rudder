import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { eq } from "../../packages/db/node_modules/drizzle-orm/index.js";
import {
  chatConversations,
  chatMessages,
  createDb,
  heartbeatRuns,
  issues,
} from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB, E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);
const E2E_SLOW_CODEX_STUB = path.resolve("tests/e2e/fixtures/codex-ignore-term");

type Organization = { id: string; issuePrefix: string };
type Agent = { id: string; name: string };
type StreamRequest = {
  body?: string;
  preferredAgentId?: string;
  planMode?: boolean;
  issueCreationMode?: string;
  contextLinks?: unknown[];
  clientMutationId?: string;
};

const EXPECTED_DIAGNOSTIC_METADATA_ERROR = "Failed to load resource: the server responded with a status of 400 (Bad Request)";
const EXPECTED_AGENT_UNAVAILABLE_ERROR = "Failed to load resource: the server responded with a status of 503 (Service Unavailable)";

function assertNoUnexpectedBrowserErrors(
  consoleErrors: string[],
  pageErrors: string[],
  requestFailures: string[],
  expectedConsoleErrors: string[],
) {
  expect(consoleErrors.filter((error) => !expectedConsoleErrors.includes(error))).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
}

function recordBrowserErrors(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    requestFailures.push(`${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? "unknown"}`);
  });
  return { consoleErrors, pageErrors, requestFailures };
}

async function createFailedRunFixture(
  page: Page,
  name: string,
  withFallback = false,
  command = E2E_CODEX_STUB,
) {
  const organizationResponse = await page.request.post("/api/orgs", { data: { name } });
  expect(organizationResponse.ok(), await organizationResponse.text()).toBe(true);
  const organization = await organizationResponse.json() as Organization;
  const primaryAgent = await createE2EChatAgent(page.request, organization.id, {
    name: "Run Debug Primary",
    agentRuntimeConfig: {
      model: "gpt-5.4",
      command,
      chatAppServerEnabled: false,
    },
  }) as Agent;
  const fallbackAgent = withFallback
    ? await createE2EChatAgent(page.request, organization.id, {
      name: "Run Debug Fallback",
      agentRuntimeConfig: {
        model: "gpt-5.4",
        command: E2E_CODEX_STUB,
        chatAppServerEnabled: false,
      },
    }) as Agent
    : null;
  const runId = randomUUID();
  await e2eDb.insert(heartbeatRuns).values({
    id: runId,
    orgId: organization.id,
    agentId: primaryAgent.id,
    invocationSource: "assignment",
    triggerDetail: "system",
    status: "failed",
    startedAt: new Date("2026-05-23T09:00:00.000Z"),
    finishedAt: new Date("2026-05-23T09:45:00.000Z"),
    error: "Process lost\nAPI_KEY=run-secret-must-not-leak",
    errorCode: "process_lost",
    stdoutExcerpt: "request https://private.example.test/run?token=private-token",
    stderrExcerpt: "Authorization: Bearer private-bearer\nconfig /Users/e2e/private/.env",
    usageJson: { inputTokens: 450_000, cachedInputTokens: 75_000, outputTokens: 30_000 },
    resultJson: { summary: "Process lost on launch" },
    contextSnapshot: { recovery: { failureKind: "process_lost" } },
    createdAt: new Date("2026-05-23T09:00:00.000Z"),
    updatedAt: new Date("2026-05-23T09:45:00.000Z"),
  });
  return { organization, primaryAgent, fallbackAgent, runId };
}

function recordStreamRequests(page: Page) {
  const requests: StreamRequest[] = [];
  page.on("request", (request) => {
    if (
      request.method() !== "POST"
      || !request.url().includes("/api/orgs/")
      || !request.url().endsWith("/chats/messages/stream")
    ) return;
    requests.push(JSON.parse(request.postData() ?? "{}") as StreamRequest);
  });
  return requests;
}

async function openRunDetail(page: Page, organization: Organization, runId: string, agentId: string) {
  await page.addInitScript((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/agents/${agentId}/runs/${runId}`, { waitUntil: "domcontentloaded" });
  const mainContent = page.locator("#main-content");
  await expect(mainContent.getByTestId("agent-runs-detail-pane")).toBeVisible({ timeout: 15_000 });
  await expect(mainContent.getByTestId("run-summary-card")).toContainText("Run failed", { timeout: 15_000 });
  return mainContent;
}

async function openReportDialogAndEditGitHubText(page: Page, mainContent: Locator) {
  await mainContent.getByTestId("run-report-issue").click();
  const dialog = page.getByRole("dialog", { name: "Report this run failure" });
  const diagnostics = dialog.getByTestId("run-issue-diagnostics");
  await expect(diagnostics).toBeVisible();
  const generatedSnapshot = await diagnostics.inputValue();
  await diagnostics.fill("Edited GitHub-only report");
  return { dialog, generatedSnapshot };
}

async function chooseDebugMode(page: Page, mainContent: Locator, mode: "Create task" | "Start chat") {
  await mainContent.getByTestId("run-debug-menu-trigger").click();
  await page.getByRole("menuitem", { name: mode }).click();
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual({ clientWidth: 390, scrollWidth: 390 });
}

async function expectWithinScrollViewport(locator: Locator, scrollContainer: Locator) {
  await expect.poll(async () => {
    const [itemBox, scrollBox] = await Promise.all([
      locator.boundingBox(),
      scrollContainer.boundingBox(),
    ]);
    return Boolean(
      itemBox
      && scrollBox
      && itemBox.y >= scrollBox.y
      && itemBox.y + itemBox.height <= scrollBox.y + scrollBox.height,
    );
  }).toBe(true);
}

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

test.describe("failed Agent Run Debug Chat", () => {
  test("creates one retryable Debug task with a direct Issue result", async ({ page }, testInfo: TestInfo) => {
    test.setTimeout(120_000);
    const browserErrors = recordBrowserErrors(page);
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 960 });
    const fixture = await createFailedRunFixture(page, `Run-Debug-Task-${Date.now()}`);
    const mainContent = await openRunDetail(page, fixture.organization, fixture.runId, fixture.primaryAgent.id);
    const firstDialog = await openReportDialogAndEditGitHubText(page, mainContent);
    await firstDialog.dialog.getByRole("button", { name: "Cancel" }).click();

    await mainContent.getByTestId("run-debug-menu-trigger").click();
    await expect(page.getByRole("menuitem", { name: "Create task" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Start chat" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("run-debug-modes-desktop.png"), fullPage: true });
    await page.keyboard.press("Escape");
    expect(await e2eDb.select().from(issues).where(eq(issues.orgId, fixture.organization.id))).toHaveLength(0);

    let failFirstRequest = true;
    await page.route(`**/api/orgs/${fixture.organization.id}/agent-runs/${fixture.runId}/debug-issue`, async (route) => {
      if (!failFirstRequest) return route.continue();
      failFirstRequest = false;
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Debug task service unavailable." }),
      });
    });

    await page.setViewportSize({ width: 390, height: 844 });
    const generatedSnapshot = firstDialog.generatedSnapshot;
    await mainContent.getByTestId("run-debug-menu-trigger").click();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("run-debug-modes-mobile.png"), fullPage: true });
    await page.getByRole("menuitem", { name: "Create task" }).click();
    await expect(mainContent.getByTestId("run-debug-menu-trigger")).toBeDisabled();
    await expect(mainContent.getByRole("alert")).toContainText("Debug task service unavailable");
    expect(await e2eDb.select().from(issues).where(eq(issues.orgId, fixture.organization.id))).toHaveLength(0);

    await chooseDebugMode(page, mainContent, "Create task");
    await expect(page.getByText(/^Created Debug task /)).toBeVisible({ timeout: 15_000 });
    const createdRows = await e2eDb.select().from(issues).where(eq(issues.orgId, fixture.organization.id));
    expect(createdRows).toHaveLength(1);
    const [createdIssue] = createdRows;
    expect(createdIssue).toMatchObject({
      assigneeAgentId: fixture.primaryAgent.id,
      originKind: "run_debug",
      originId: fixture.runId,
      originRunId: fixture.runId,
      status: "todo",
    });
    expect(createdIssue!.description).toContain(`Run ID: \`${fixture.runId}\``);
    expect(createdIssue!.description).toContain("BEGIN UNTRUSTED DIAGNOSTIC EVIDENCE");
    expect(createdIssue!.description).toContain("Safe diagnostics generated by Rudder");
    expect(createdIssue!.description).toContain(`Run ID: ${fixture.runId}`);
    expect(createdIssue!.description).toContain("API_KEY=[REDACTED]");
    expect(createdIssue!.description).not.toContain("Edited GitHub-only report");
    expect(createdIssue!.description).not.toContain("run-secret-must-not-leak");
    expect(createdIssue!.description).not.toContain("private-bearer");

    const issueRef = createdIssue!.identifier ?? createdIssue!.id;
    await expect(page.getByText(`Created Debug task ${issueRef}`)).toBeVisible();
    const issueLink = page.getByRole("link", { name: `Open ${issueRef}` });
    await expect(issueLink).toHaveAttribute("href", new RegExp(`/issues/${issueRef}$`));

    const replay = await page.request.post(
      `/api/orgs/${fixture.organization.id}/agent-runs/${fixture.runId}/debug-issue`,
      { data: { diagnostics: generatedSnapshot } },
    );
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toMatchObject({ created: false, issue: { id: createdIssue!.id } });
    expect(await e2eDb.select().from(issues).where(eq(issues.orgId, fixture.organization.id))).toHaveLength(1);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("run-debug-task-created-mobile.png"), fullPage: true });
    assertNoUnexpectedBrowserErrors(
      browserErrors.consoleErrors,
      browserErrors.pageErrors,
      browserErrors.requestFailures,
      [EXPECTED_DIAGNOSTIC_METADATA_ERROR, EXPECTED_AGENT_UNAVAILABLE_ERROR],
    );
  });

  test("isolates generated evidence, sends once, and stays in the mobile Side Panel", async ({ page }, testInfo: TestInfo) => {
    test.setTimeout(120_000);
    const browserErrors = recordBrowserErrors(page);
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 960 });
    const fixture = await createFailedRunFixture(
      page,
      `Run-Debug-Chat-${Date.now()}`,
      false,
      E2E_SLOW_CODEX_STUB,
    );
    const streamRequests = recordStreamRequests(page);
    const mainContent = await openRunDetail(page, fixture.organization, fixture.runId, fixture.primaryAgent.id);
    const { dialog, generatedSnapshot } = await openReportDialogAndEditGitHubText(page, mainContent);
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await chooseDebugMode(page, mainContent, "Start chat");
    const sidePanel = page.getByTestId("chat-side-panel");
    const debugPanel = sidePanel.getByTestId("run-debug-chat-panel");
    await expect(debugPanel).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => streamRequests.length).toBe(1);
    expect(streamRequests[0]).toMatchObject({
      preferredAgentId: fixture.primaryAgent.id,
      planMode: false,
      issueCreationMode: "manual_approval",
      contextLinks: [],
      clientMutationId: `run-debug:${fixture.organization.id}:${fixture.runId}`,
    });
    expect(streamRequests[0]?.body).toContain("BEGIN UNTRUSTED DIAGNOSTIC EVIDENCE");
    expect(streamRequests[0]?.body).toContain(generatedSnapshot);
    expect(streamRequests[0]?.body).not.toContain("Edited GitHub-only report");
    expect(streamRequests[0]?.body).not.toContain("run-secret-must-not-leak");
    await expect(debugPanel.getByTestId("run-feedback-chat-message").first()).toBeVisible({ timeout: 20_000 });
    await expect(debugPanel.getByRole("button", { name: "Stop feedback" })).toBeVisible();

    await sidePanel.getByRole("button", { name: "Close Side Panel" }).click();
    await expect(sidePanel).toBeHidden();
    await chooseDebugMode(page, mainContent, "Start chat");
    await expect(debugPanel.getByRole("button", { name: "Stop feedback" })).toBeVisible();
    expect(streamRequests).toHaveLength(1);
    await page.screenshot({ path: testInfo.outputPath("run-debug-chat-stream-desktop.png"), fullPage: true });

    await sidePanel.getByRole("button", { name: "Close Side Panel" }).click();
    await expect(sidePanel).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileUrl = page.url();
    await chooseDebugMode(page, mainContent, "Start chat");
    await expect(page).toHaveURL(mobileUrl);
    await expect(sidePanel).toBeVisible();
    await expect(sidePanel).toHaveAttribute("role", "dialog");
    await expect(sidePanel).toHaveClass(/fixed/);
    await expect(debugPanel).toHaveAttribute("data-debug-conversation-id", /.+/);
    await expect(debugPanel).toHaveAttribute(
      "data-debug-queue-status",
      /^(starting|active|running|tool_busy|closing|stop_requested|stopping|waiting_for_network)$/,
    );
    await expect(debugPanel.getByRole("button", { name: "Stop feedback" })).toBeVisible();
    expect(streamRequests).toHaveLength(1);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("run-debug-chat-stream-mobile.png"), fullPage: true });

    const assistantMessage = debugPanel.getByTestId("chat-assistant-message")
      .filter({ hasText: "Streaming reply for chat." });
    await expect(assistantMessage).toBeVisible({ timeout: 60_000 });
    await expectWithinScrollViewport(assistantMessage, debugPanel.getByTestId("run-chat-messages-scroll"));
    await expect(debugPanel.getByTestId("run-feedback-composer").locator("[contenteditable='true']"))
      .toBeEmpty();
    await expect(debugPanel.getByTestId("run-feedback-composer"))
      .not.toContainText("BEGIN UNTRUSTED DIAGNOSTIC EVIDENCE");
    await expect(debugPanel.getByTestId("run-chat-pending-message")).toHaveCount(0);

    await expect.poll(async () => {
      const rows = await e2eDb.select().from(chatConversations)
        .where(eq(chatConversations.orgId, fixture.organization.id));
      return rows.length;
    }).toBe(1);
    const [conversation] = await e2eDb.select().from(chatConversations)
      .where(eq(chatConversations.orgId, fixture.organization.id));
    const messages = await e2eDb.select().from(chatMessages)
      .where(eq(chatMessages.conversationId, conversation!.id));
    expect(messages.some((message) => message.body.includes(`Run ID: ${fixture.runId}`))).toBe(true);
    expect(messages.some((message) => message.body.includes("Edited GitHub-only report"))).toBe(false);

    await expect(debugPanel.getByTestId("run-feedback-chat-message")
      .filter({ hasText: `Run ID: ${fixture.runId}` })).toHaveCount(1);
    await expect(debugPanel.getByTestId("run-feedback-composer"))
      .not.toContainText("BEGIN UNTRUSTED DIAGNOSTIC EVIDENCE");
    expect(streamRequests).toHaveLength(1);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("run-debug-chat-mobile.png"), fullPage: true });

    await sidePanel.getByRole("button", { name: "Close Side Panel" }).click();
    await expect(sidePanel).toBeHidden();
    await page.setViewportSize({ width: 1440, height: 960 });
    await chooseDebugMode(page, mainContent, "Start chat");
    await expect(sidePanel).toBeVisible();
    await expectWithinScrollViewport(assistantMessage, debugPanel.getByTestId("run-chat-messages-scroll"));
    expect(streamRequests).toHaveLength(1);
    await page.screenshot({ path: testInfo.outputPath("run-debug-chat-desktop.png"), fullPage: true });
    assertNoUnexpectedBrowserErrors(
      browserErrors.consoleErrors,
      browserErrors.pageErrors,
      browserErrors.requestFailures,
      [EXPECTED_DIAGNOSTIC_METADATA_ERROR],
    );
  });

  test("keeps a failed first request retryable without creating an empty Chat", async ({ page }, testInfo: TestInfo) => {
    test.setTimeout(120_000);
    const browserErrors = recordBrowserErrors(page);
    await page.setViewportSize({ width: 1440, height: 960 });
    const fixture = await createFailedRunFixture(page, `Run-Debug-Retry-${Date.now()}`, true);
    const streamRequests = recordStreamRequests(page);
    let failFirstRequest = true;
    await page.route(`**/api/orgs/${fixture.organization.id}/chats/messages/stream`, async (route) => {
      if (!failFirstRequest) return route.continue();
      failFirstRequest = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "The selected Agent is unavailable." }),
      });
    });

    const mainContent = await openRunDetail(page, fixture.organization, fixture.runId, fixture.primaryAgent.id);
    const { dialog } = await openReportDialogAndEditGitHubText(page, mainContent);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await chooseDebugMode(page, mainContent, "Start chat");
    const debugPanel = page.getByTestId("run-debug-chat-panel");
    await expect(debugPanel.getByRole("alert")).toContainText("Choose another agent or try again", { timeout: 15_000 });
    await expect(debugPanel.getByTestId("run-feedback-composer").locator("[contenteditable='true']"))
      .toContainText("BEGIN UNTRUSTED DIAGNOSTIC EVIDENCE");
    await expect.poll(async () => {
      const rows = await e2eDb.select().from(chatConversations)
        .where(eq(chatConversations.orgId, fixture.organization.id));
      return rows.length;
    }).toBe(0);

    await debugPanel.getByTestId("chat-agent-selector").click();
    const agentMenu = page.getByTestId("run-feedback-agent-menu");
    await agentMenu.getByTestId(`chat-agent-option-${fixture.fallbackAgent!.id}`)
      .getByRole("menuitemradio").click();
    await debugPanel.getByRole("button", { name: "Send feedback" }).click();
    await expect.poll(() => streamRequests.length).toBe(2);
    expect(streamRequests[1]).toMatchObject({
      preferredAgentId: fixture.fallbackAgent!.id,
      planMode: false,
      issueCreationMode: "manual_approval",
      clientMutationId: `run-debug:${fixture.organization.id}:${fixture.runId}`,
    });
    await expect(debugPanel.getByTestId("chat-assistant-message").filter({ hasText: "Streaming reply for chat." }))
      .toBeVisible({ timeout: 60_000 });
    await expect(debugPanel.getByTestId("run-feedback-composer").locator("[contenteditable='true']"))
      .toBeEmpty();
    await expect(debugPanel.getByTestId("run-feedback-composer"))
      .not.toContainText("BEGIN UNTRUSTED DIAGNOSTIC EVIDENCE");
    await expect(debugPanel.getByTestId("run-chat-pending-message")).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("run-debug-chat-retry-mobile.png"), fullPage: true });
    assertNoUnexpectedBrowserErrors(
      browserErrors.consoleErrors,
      browserErrors.pageErrors,
      browserErrors.requestFailures,
      [EXPECTED_DIAGNOSTIC_METADATA_ERROR, EXPECTED_AGENT_UNAVAILABLE_ERROR],
    );
  });

  test("stops the same active Debug Chat after reopening it on mobile", async ({ page }, testInfo: TestInfo) => {
    test.setTimeout(120_000);
    const browserErrors = recordBrowserErrors(page);
    await page.setViewportSize({ width: 1440, height: 960 });
    const fixture = await createFailedRunFixture(page, `Run-Debug-Stop-${Date.now()}`);
    const streamRequests = recordStreamRequests(page);
    const mainContent = await openRunDetail(page, fixture.organization, fixture.runId, fixture.primaryAgent.id);
    const { dialog } = await openReportDialogAndEditGitHubText(page, mainContent);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await chooseDebugMode(page, mainContent, "Start chat");

    const sidePanel = page.getByTestId("chat-side-panel");
    const debugPanel = sidePanel.getByTestId("run-debug-chat-panel");
    await expect(debugPanel.getByRole("button", { name: "Stop feedback" })).toBeVisible({ timeout: 20_000 });
    await sidePanel.getByRole("button", { name: "Close Side Panel" }).click();
    await expect(sidePanel).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 });
    await chooseDebugMode(page, mainContent, "Start chat");
    const stopButton = debugPanel.getByRole("button", { name: "Stop feedback" });
    await expect(stopButton).toBeVisible();

    const stopResponse = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && response.url().endsWith("/messages/stream/stop")
    ));
    await stopButton.click();
    expect((await stopResponse).ok()).toBe(true);
    await expect(stopButton).toHaveCount(0, { timeout: 20_000 });
    const pendingStop = debugPanel.getByRole("button", { name: "Stop status pending" });
    if (await pendingStop.count()) {
      await expect(debugPanel.getByRole("alert")).toContainText(
        "Stop was accepted, but the final runtime state could not be confirmed yet.",
      );
      await expect(pendingStop).toBeDisabled();
    } else {
      await expect(debugPanel.getByRole("alert")).toHaveCount(0);
    }
    expect(streamRequests).toHaveLength(1);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("run-debug-chat-stopped-mobile.png"), fullPage: true });
    expect(browserErrors.requestFailures).toEqual([
      expect.stringMatching(/POST .*\/chats\/messages\/stream :: net::ERR_ABORTED/),
    ]);
    browserErrors.requestFailures.splice(0);
    assertNoUnexpectedBrowserErrors(
      browserErrors.consoleErrors,
      browserErrors.pageErrors,
      browserErrors.requestFailures,
      [EXPECTED_DIAGNOSTIC_METADATA_ERROR],
    );
  });
});
