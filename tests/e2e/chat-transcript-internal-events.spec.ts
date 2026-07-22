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
          kind: "system",
          ts: "2026-07-19T00:00:00.250Z",
          text: "item started: userMessage (id=user-message-1)",
        },
        {
          kind: "system",
          ts: "2026-07-19T00:00:00.500Z",
          text: "item completed: userMessage (id=user-message-1)",
        },
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
  await expect(transcript.getByText("UserMessage", { exact: true })).toHaveCount(0);
  await expect(transcript.getByText(/RUDDER_RESULT/i)).toHaveCount(0);
  await expect(transcript.getByText(/^System$/)).toHaveCount(0);
  await page.screenshot({ path: "/tmp/rudder-user-message-lifecycle-hidden.png", fullPage: true });
});

test("shows concrete Codex spawn-agent details in Messenger process activity", async ({ page }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Chat-Transcript-Spawn-Agent-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: "Transcript Delegation Agent",
    command: E2E_CODEX_STUB,
  });
  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Inspectable spawn agent activity",
      preferredAgentId: agent.id,
      issueCreationMode: "manual_approval",
      planMode: false,
      initialMessage: { body: "Delegate an independent transcript review." },
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
    body: "The independent review passed.",
    structuredPayload: {
      __chatTranscript: [
        { kind: "system", ts: "2026-07-23T00:00:00.000Z", text: "turn started" },
        {
          kind: "tool_call",
          ts: "2026-07-23T00:00:01.000Z",
          name: "spawn_agent",
          toolUseId: "collab-agent-1",
          input: {
            message: "Review the transcript renderer for collaboration events.",
            receiver_thread_ids: [],
          },
        },
        {
          kind: "tool_result",
          ts: "2026-07-23T00:00:02.000Z",
          toolUseId: "collab-agent-1",
          toolName: "spawn_agent",
          content: JSON.stringify({
            status: "completed",
            receiver_thread_ids: ["thread-child-1"],
            model: "gpt-5.6-sol",
            reasoning_effort: "high",
            agents_states: {
              "thread-child-1": { status: "completed", message: "Review passed." },
            },
          }),
          isError: false,
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

  await expect(page.getByText("The independent review passed.", { exact: true })).toBeVisible();
  const transcript = page.getByTestId("chat-transcript-item");
  await transcript.getByRole("button").first().click();
  await expect(transcript).toContainText(
    "Spawned agent thread-child-1: Review the transcript renderer for collaboration events.",
  );
  await expect(transcript).toContainText("gpt-5.6-sol");
  await expect(transcript).toContainText("high reasoning");
  await expect(transcript).not.toContainText("Collab Tool Call");
  await page.screenshot({ path: "/tmp/rudder-spawn-agent-transcript-details.png", fullPage: true });
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

test("shows Codex-style activity disclosure and opens transcript files from the file row", async ({ page }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Chat-Transcript-Files-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: "Transcript File Agent",
    command: E2E_CODEX_STUB,
  });
  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Inspectable activity files",
      preferredAgentId: agent.id,
      issueCreationMode: "manual_approval",
      planMode: false,
      initialMessage: { body: "Show the files you inspected." },
    },
  });
  expect(chatRes.ok()).toBe(true);
  const chat = await chatRes.json() as { id: string };
  const fileLabel = "rudder-transcript-evidence.md";
  const filePath = `/tmp/${fileLabel}`;

  await e2eDb.insert(chatMessages).values({
    id: randomUUID(),
    orgId: organization.id,
    conversationId: chat.id,
    role: "assistant",
    kind: "message",
    status: "completed",
    body: "The inspected evidence is ready.",
    structuredPayload: {
      __chatTranscript: [
        { kind: "system", ts: "2026-07-21T01:00:00.000Z", text: "turn started" },
        {
          kind: "tool_call",
          ts: "2026-07-21T01:00:01.000Z",
          name: "Skill",
          toolUseId: "skill-1",
          input: { skill: "systematic-debugging" },
        },
        {
          kind: "tool_result",
          ts: "2026-07-21T01:00:01.010Z",
          toolUseId: "skill-1",
          content: "Loaded skill",
          isError: false,
        },
        {
          kind: "tool_call",
          ts: "2026-07-21T01:00:02.000Z",
          name: "read_file",
          toolUseId: "read-1",
          input: { path: fileLabel, cwd: "/tmp" },
        },
        {
          kind: "tool_result",
          ts: "2026-07-21T01:00:02.020Z",
          toolUseId: "read-1",
          content: "Evidence",
          isError: false,
        },
        {
          kind: "tool_call",
          ts: "2026-07-21T01:00:03.000Z",
          name: "command_execution",
          toolUseId: "command-1",
          input: { command: "pnpm test:run" },
        },
        {
          kind: "tool_result",
          ts: "2026-07-21T01:00:03.030Z",
          toolUseId: "command-1",
          content: "Tests passed",
          isError: false,
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

  const transcript = page.getByTestId("chat-transcript-item");
  const workedButton = transcript.getByRole("button", { name: /Worked for/i });
  await workedButton.click();

  const activityButton = transcript.getByRole("button", { name: "Expand tool activity" });
  await expect(activityButton).toContainText("Used 1 skill, read 1 file, ran 1 command");
  const disclosure = activityButton.locator("[data-transcript-disclosure-chevron]");
  await expect(disclosure).toHaveCSS("opacity", "0");
  await workedButton.focus();
  await workedButton.press("Tab");
  await expect(activityButton).toBeFocused();
  await expect(disclosure).toHaveCSS("opacity", "1");
  await activityButton.blur();
  await expect(disclosure).toHaveCSS("opacity", "0");
  await activityButton.hover();
  await expect(disclosure).toHaveCSS("opacity", "1");
  await page.screenshot({ path: "/tmp/rudder-transcript-activity-hover.png", fullPage: true });
  await activityButton.click();

  const fileButton = transcript.getByRole("button", { name: `Open file ${fileLabel}` });
  await expect(fileButton).toBeVisible();
  await expect(fileButton).toHaveAttribute("data-transcript-file-target", filePath);
  await page.waitForTimeout(250);
  await page.screenshot({ path: "/tmp/rudder-transcript-activity-expanded.png", fullPage: true });
  const chatUrl = page.url();
  await fileButton.click();
  await expect(page.getByTestId("chat-side-panel-local-file-view").or(page.getByRole("alert"))).toContainText("Rudder Desktop");
  await expect(page).toHaveURL(chatUrl);
  await page.screenshot({ path: "/tmp/rudder-transcript-file-side-panel-web.png", fullPage: true });
});
