import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_ROOT } from "./support/e2e-env";

const ORIGINAL_INPUT = "Run this once and preserve the partial output";
const PARTIAL_OUTPUT = "PARTIAL_OUTPUT_BEFORE_LOST_ACK";

test("blocks retry after a Codex App Server submission loses its acknowledgement", async ({ page }, testInfo) => {
  test.setTimeout(120_000);

  const fixtureStateDir = await mkdtemp(join(tmpdir(), "rudder-codex-lost-ack-"));
  const fixtureStatePath = join(fixtureStateDir, "state.json");
  const organizationResponse = await page.request.post("/api/orgs", {
    data: { name: `Codex-Lost-Ack-${Date.now()}` },
  });
  expect(organizationResponse.ok()).toBe(true);
  const organization = await organizationResponse.json() as {
    id: string;
    issuePrefix: string;
    urlKey: string;
  };
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: "Lost Ack Agent",
    command: join(E2E_ROOT, "fixtures/codex-lost-ack.mjs"),
    agentRuntimeConfig: {
      model: "gpt-5.4",
      command: join(E2E_ROOT, "fixtures/codex-lost-ack.mjs"),
      chatAppServerEnabled: true,
      env: { RUDDER_E2E_CODEX_LOST_ACK_STATE: fixtureStatePath },
    },
  });

  await page.goto("/");
  await page.evaluate((orgId) => localStorage.setItem("rudder.selectedOrganizationId", orgId), organization.id);
  await page.goto(`/${organization.issuePrefix}/messenger/chat?agentId=${agent.id}`);
  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill(ORIGINAL_INPUT);
  await page.getByRole("button", { name: "Send", exact: true }).click();

  const failedMessage = page.getByTestId("chat-assistant-message").filter({ hasText: "Response failed" });
  await expect(failedMessage).toBeVisible({ timeout: 45_000 });
  await expect(failedMessage.getByRole("link", { name: "Open run" })).toBeVisible();
  await expect(page.getByText(PARTIAL_OUTPUT, { exact: true })).toBeVisible();

  const chatId = new URL(page.url()).pathname.split("/").at(-1);
  expect(chatId).toBeTruthy();
  const beforeMessagesResponse = await page.request.get(`/api/chats/${chatId}/messages`);
  expect(beforeMessagesResponse.ok()).toBe(true);
  const beforeMessages = await beforeMessagesResponse.json() as Array<{
    id: string;
    role: string;
    kind: string;
    body: string;
    status: string;
    chatTurnId?: string | null;
    runId?: string | null;
    structuredPayload?: {
      recoverableFailure?: Record<string, unknown>;
    } | null;
  }>;
  const originalUserMessage = beforeMessages.find((message) =>
    message.role === "user" && message.kind === "message" && message.body === ORIGINAL_INPUT,
  );
  expect(originalUserMessage?.id).toBeTruthy();
  const failedAssistant = beforeMessages.find((message) => message.role === "assistant" && message.status === "failed");
  expect(failedAssistant).toMatchObject({
    kind: "message",
    status: "failed",
    body: PARTIAL_OUTPUT,
    structuredPayload: {
      recoverableFailure: {
        code: "chat_submission_acceptance_unknown",
        retryable: false,
        action: "inspect_run",
        runId: expect.any(String),
      },
    },
  });
  const runId = failedAssistant?.runId;
  expect(runId).toBeTruthy();

  const runResponse = await page.request.get(`/api/agent-runs/${runId}`);
  expect(runResponse.ok()).toBe(true);
  const run = await runResponse.json() as {
    id: string;
    status: string;
    resultJson?: Record<string, unknown> | null;
  };
  expect(run).toMatchObject({
    id: runId,
    status: "failed",
    resultJson: {
      retryable: false,
      action: "inspect_run",
      submissionPhase: "indeterminate",
      nativeCompletion: "unknown",
    },
  });

  const runsResponse = await page.request.get(
    `/api/orgs/${organization.id}/agent-runs?agentId=${agent.id}&limit=100`,
  );
  expect(runsResponse.ok()).toBe(true);
  const beforeRuns = await runsResponse.json() as Array<{ id: string }>;
  expect(beforeRuns.map((candidate) => candidate.id)).toEqual([runId]);
  const fixtureState = JSON.parse(await readFile(fixtureStatePath, "utf8")) as Record<string, unknown>;
  expect(fixtureState).toMatchObject({
    providerSubmissionCount: 1,
    requestReceived: true,
    partialOutputSent: true,
    turnStartResponseSent: false,
    turnCompletedSent: false,
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  const refreshedFailure = page.getByTestId("chat-assistant-message").filter({ hasText: "Response failed" });
  await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: ORIGINAL_INPUT })).toHaveCount(1);
  await expect(refreshedFailure).toBeVisible({ timeout: 15_000 });
  await expect(refreshedFailure.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(page.getByText(PARTIAL_OUTPUT, { exact: true })).toBeVisible();

  const directRetryResponse = await page.request.post(`/api/chats/${chatId}/messages/stream`, {
    data: {
      body: ORIGINAL_INPUT,
      editUserMessageId: originalUserMessage!.id,
      clientMutationId: `lost-ack-direct-retry-${randomUUID()}`,
      modelOverride: null,
      effortOverride: null,
    },
  });
  expect(directRetryResponse.status()).toBe(409);
  expect(await directRetryResponse.json()).toMatchObject({
    details: {
      code: "chat_retry_acceptance_unresolved",
      runId,
    },
  });
  const nonStreamingRetryResponse = await page.request.post(`/api/chats/${chatId}/messages`, {
    data: {
      body: ORIGINAL_INPUT,
      editUserMessageId: originalUserMessage!.id,
      clientMutationId: `lost-ack-non-stream-retry-${randomUUID()}`,
      modelOverride: null,
      effortOverride: null,
    },
  });
  expect(nonStreamingRetryResponse.status()).toBe(409);
  expect(await nonStreamingRetryResponse.json()).toMatchObject({
    details: {
      code: "chat_retry_acceptance_unresolved",
      runId,
    },
  });

  const afterMessagesResponse = await page.request.get(`/api/chats/${chatId}/messages`);
  expect(afterMessagesResponse.ok()).toBe(true);
  const afterMessages = await afterMessagesResponse.json() as typeof beforeMessages;
  expect(afterMessages.map((message) => message.id).sort()).toEqual(
    beforeMessages.map((message) => message.id).sort(),
  );
  expect(afterMessages.filter((message) =>
    message.role === "user" && message.kind === "message" && message.body === ORIGINAL_INPUT,
  )).toHaveLength(1);

  const afterRunsResponse = await page.request.get(
    `/api/orgs/${organization.id}/agent-runs?agentId=${agent.id}&limit=100`,
  );
  expect(afterRunsResponse.ok()).toBe(true);
  const afterRuns = await afterRunsResponse.json() as Array<{ id: string }>;
  expect(afterRuns.map((candidate) => candidate.id)).toEqual(beforeRuns.map((candidate) => candidate.id));
  expect(JSON.parse(await readFile(fixtureStatePath, "utf8"))).toMatchObject({ providerSubmissionCount: 1 });
  await page.screenshot({ path: testInfo.outputPath("codex-lost-ack-refresh-no-retry.png"), fullPage: true });
});
