import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB, E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

test("hides internal lifecycle and result protocol entries from Messenger process details", async ({ page }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Chat-Transcript-Internals-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: "Transcript Agent",
    command: E2E_CODEX_STUB,
  });
  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Clean process details",
      preferredAgentId: agent.id,
      issueCreationMode: "manual_approval",
      planMode: false,
      initialMessage: {
        body: "Show clean process details.",
      },
    },
  });
  expect(chatRes.ok()).toBe(true);
  const chat = await chatRes.json() as { id: string };

  await e2eDb.insert(chatMessages).values({
    id: randomUUID(),
    orgId: organization.id,
    conversationId: chat.id,
    role: "assistant",
    kind: "message",
    status: "completed",
    body: "Final answer shown in the assistant message.",
    structuredPayload: {
      __chatTranscript: [
        { kind: "system", ts: "2026-07-19T00:00:00.000Z", text: "turn started" },
        {
          kind: "tool_call",
          ts: "2026-07-19T00:00:01.000Z",
          name: "command_execution",
          toolUseId: "command-1",
          input: { command: "printf done" },
        },
        {
          kind: "tool_result",
          ts: "2026-07-19T00:00:02.000Z",
          toolUseId: "command-1",
          content: "done",
          isError: false,
        },
        { kind: "system", ts: "2026-07-19T00:00:03.000Z", text: "reasoning started" },
        { kind: "system", ts: "2026-07-19T00:00:04.000Z", text: "reasoning completed" },
        { kind: "assistant", ts: "2026-07-19T00:00:05.000Z", text: "R" },
        { kind: "assistant", ts: "2026-07-19T00:00:06.000Z", text: "UD" },
        {
          kind: "assistant",
          ts: "2026-07-19T00:00:07.000Z",
          text: "DER_RESULT_BEGIN\nFinal answer shown ",
        },
        {
          kind: "assistant",
          ts: "2026-07-19T00:00:08.000Z",
          text: "in the assistant message.\nRUDDER_RESULT_END",
        },
      ],
    },
    replyingAgentId: agent.id,
    chatTurnId: randomUUID(),
    turnVariant: 0,
  });

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

  await expect(page.getByText("Final answer shown in the assistant message.", { exact: true })).toBeVisible();
  const transcript = page.getByTestId("chat-transcript-item");
  await expect(transcript).toBeVisible();
  await transcript.getByRole("button").click();

  await expect(transcript.getByText("Ran printf done", { exact: true })).toBeVisible();
  await expect(transcript.getByText(/reasoning started/i)).toHaveCount(0);
  await expect(transcript.getByText(/reasoning completed/i)).toHaveCount(0);
  await expect(transcript.getByText(/RUDDER_RESULT/i)).toHaveCount(0);
  await expect(transcript.getByText(/^System$/)).toHaveCount(0);
});

test("does not show an empty transcript block when Messenger has only internal lifecycle entries", async ({ page }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Chat-Transcript-Empty-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: "Transcript Agent",
    command: E2E_CODEX_STUB,
  });
  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Empty process details",
      preferredAgentId: agent.id,
      issueCreationMode: "manual_approval",
      planMode: false,
      initialMessage: {
        body: "Show the answer without an empty transcript placeholder.",
      },
    },
  });
  expect(chatRes.ok()).toBe(true);
  const chat = await chatRes.json() as { id: string };

  await e2eDb.insert(chatMessages).values({
    id: randomUUID(),
    orgId: organization.id,
    conversationId: chat.id,
    role: "assistant",
    kind: "message",
    status: "completed",
    body: "The final answer remains visible without transcript details.",
    structuredPayload: {
      __chatTranscript: [
        { kind: "system", ts: "2026-07-21T00:00:00.000Z", text: "turn started" },
        { kind: "system", ts: "2026-07-21T00:00:01.000Z", text: "reasoning started" },
        { kind: "system", ts: "2026-07-21T00:00:02.000Z", text: "reasoning completed" },
      ],
    },
    replyingAgentId: agent.id,
    chatTurnId: randomUUID(),
    turnVariant: 0,
  });

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

  await expect(page.getByText("The final answer remains visible without transcript details.", { exact: true }))
    .toBeVisible();
  const transcript = page.getByTestId("chat-transcript-item");
  await expect(transcript).toBeVisible();
  await transcript.getByRole("button").click();

  await expect(page.getByText("No transcript yet.", { exact: true })).toHaveCount(0);
  await expect(transcript.locator(".border-dashed")).toHaveCount(0);
  await page.screenshot({ path: "/tmp/rudder-empty-transcript-block-removed.png" });
});
