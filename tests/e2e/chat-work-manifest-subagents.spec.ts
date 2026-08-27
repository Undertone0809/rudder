import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "../../packages/db/node_modules/drizzle-orm/index.js";
import { chatMessages, createDb, heartbeatRuns } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);
const screenshotDir = process.env.RUDDER_CHAT_WORK_MANIFEST_SUBAGENTS_SCREENSHOT_DIR
  ? path.resolve(process.env.RUDDER_CHAT_WORK_MANIFEST_SUBAGENTS_SCREENSHOT_DIR)
  : fs.mkdtempSync(path.join(os.tmpdir(), "rudder-chat-work-manifest-subagents-"));

type SubagentFixture = {
  threadId: string;
  path: string;
  prompt: string;
  status: string;
  at: string;
  response?: string;
  sparse?: boolean;
};

function transcriptFor(fixtures: SubagentFixture[]) {
  return fixtures.flatMap((fixture, index) => {
    const callId = `subagent-${index + 1}-${fixture.threadId}`;
    const input = {
      id: callId,
      activity_kind: fixture.status === "running" ? "started" : fixture.status,
      agent_path: fixture.path,
      message: fixture.prompt,
      receiver_thread_ids: [fixture.threadId],
      model: "gpt-5.6",
      reasoning_effort: index % 2 === 0 ? "high" : "medium",
      ...(fixture.sparse ? {
        agents_states: {
          [fixture.threadId]: { status: fixture.status },
        },
      } : {
        agent_transcripts: {
          [fixture.threadId]: {
            status: fixture.status,
            entries: [
              {
                kind: "thinking",
                ts: fixture.at,
                text: `Working on ${fixture.prompt}`,
              },
              {
                kind: "assistant",
                ts: new Date(Date.parse(fixture.at) + 500).toISOString(),
                text: fixture.response ?? "",
              },
            ],
          },
        },
      }),
    };
    let projectedResult: unknown = input;
    if ("agent_transcripts" in input) {
      projectedResult = {
        ...input,
        agent_transcripts: Object.fromEntries(Object.entries(input.agent_transcripts).map(([threadId, transcript]) => [
          threadId,
          {
            ...transcript,
            entries: transcript.entries.map((entry, entryIndex) => ({
              ...entry,
              generationId: `generation-${index + 1}`,
              generationSeqStart: entryIndex + 1,
              generationSeqEnd: entryIndex + 1,
            })),
          },
        ])),
      };
    }
    return [
      {
        kind: "tool_call",
        ts: fixture.at,
        name: "subagent_activity",
        toolUseId: callId,
        input,
      },
      {
        kind: "tool_result",
        ts: new Date(Date.parse(fixture.at) + 750).toISOString(),
        toolUseId: callId,
        toolName: "subagent_activity",
        content: JSON.stringify(projectedResult),
        isError: false,
      },
    ];
  });
}

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

test("aggregates Chat subagents and navigates from summary to deduplicated read-only details", async ({ page }) => {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Chat-Manifest-Subagents-${Date.now()}` },
  });
  expect(orgRes.ok(), await orgRes.text()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: "Subagent Coordinator",
  });
  const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
    data: { name: "Subagent evidence project" },
  });
  expect(projectRes.ok(), await projectRes.text()).toBe(true);
  const project = await projectRes.json() as { id: string };
  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Subagent manifest acceptance",
      preferredAgentId: agent.id,
      contextLinks: [{ entityType: "project", entityId: project.id }],
      initialMessage: { body: "Coordinate direct subagents." },
    },
  });
  expect(chatRes.ok(), await chatRes.text()).toBe(true);
  const chat = await chatRes.json() as { id: string };

  const otherChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Same project, different Chat",
      preferredAgentId: agent.id,
      contextLinks: [{ entityType: "project", entityId: project.id }],
      initialMessage: { body: "Keep this subagent outside the selected Chat." },
    },
  });
  expect(otherChatRes.ok(), await otherChatRes.text()).toBe(true);
  const otherChat = await otherChatRes.json() as { id: string };

  const baseFixtures: SubagentFixture[] = [
    {
      threadId: "thread-active-reviewer",
      path: "/root/active_reviewer",
      prompt: "Review the conversation manifest while implementation is still running.",
      status: "running",
      at: "2026-07-29T08:01:00.000Z",
      response: "Review is still in progress.",
    },
    {
      threadId: "thread-active-verifier",
      path: "/root/active_verifier",
      prompt: "Verify active and completed subagent transitions.",
      status: "queued",
      at: "2026-07-29T08:02:00.000Z",
      response: "Verification is queued.",
    },
    {
      threadId: "thread-done-architecture",
      path: "/root/architecture_reviewer",
      prompt: "Check architecture boundaries.",
      status: "completed",
      at: "2026-07-29T08:03:00.000Z",
      response: "Architecture review passed.",
    },
    {
      threadId: "thread-done-runtime",
      path: "/root/runtime_verifier",
      prompt: "Verify runtime behavior.",
      status: "failed",
      at: "2026-07-29T08:04:00.000Z",
      response: "Runtime verification found a failure.",
    },
    {
      threadId: "thread-done-roadmap",
      path: "/root/roadmap_reviewer",
      prompt: "Review roadmap coverage.",
      status: "interrupted",
      at: "2026-07-29T08:05:00.000Z",
      response: "Roadmap review was interrupted.",
    },
    {
      threadId: "thread-done-long-name",
      path: "/root/extremely_long_accessible_subagent_name_for_manifest_layout_verification",
      prompt: "Verify that a deliberately long subagent name truncates without losing its accessible title.",
      status: "completed",
      at: "2026-07-29T08:06:00.000Z",
      response: "Long-name verification passed.",
    },
    {
      threadId: "thread-active-reviewer",
      path: "/root/identity_should_remain_active_reviewer",
      prompt: "A later snapshot should update state without replacing the original identity.",
      status: "running",
      at: "2026-07-29T08:07:00.000Z",
      response: "The latest running snapshot is visible.",
    },
    {
      threadId: "thread-done-architecture",
      path: "/root/architecture_reviewer",
      prompt: "Check architecture boundaries.",
      status: "completed",
      at: "2026-07-29T08:09:00.000Z",
      sparse: true,
    },
  ];
  const sourceMessageId = randomUUID();
  const sourceRunId = randomUUID();
  await e2eDb.insert(heartbeatRuns).values({
    id: sourceRunId,
    orgId: organization.id,
    agentId: agent.id,
    invocationSource: "chat",
    triggerDetail: "chat_assistant_reply",
    status: "succeeded",
    startedAt: new Date("2026-07-29T08:00:00.000Z"),
    finishedAt: new Date("2026-07-29T08:10:00.000Z"),
    chatConversationId: chat.id,
    contextSnapshot: {
      scene: "chat",
      conversationId: chat.id,
      assistantMessageId: sourceMessageId,
    },
    resultJson: { summary: "Direct subagents completed." },
    resultSummaryJson: { summary: "Direct subagents completed." },
  });
  await e2eDb.insert(chatMessages).values([
    {
      id: sourceMessageId,
      orgId: organization.id,
      conversationId: chat.id,
      role: "assistant",
      status: "completed",
      body: "Direct subagents are working across review and verification.",
      structuredPayload: { __chatTranscript: transcriptFor(baseFixtures) },
      runId: sourceRunId,
      replyingAgentId: agent.id,
      chatTurnId: randomUUID(),
    },
    {
      orgId: organization.id,
      conversationId: otherChat.id,
      role: "assistant",
      status: "completed",
      body: "This evidence belongs to the sibling Chat.",
      structuredPayload: {
        __chatTranscript: transcriptFor([{
          threadId: "thread-other-chat",
          path: "/root/other_chat_agent",
          prompt: "Must not leak through shared Project context.",
          status: "running",
          at: "2026-07-29T08:08:00.000Z",
          response: "Hidden from selected Chat.",
        }]),
      },
      replyingAgentId: agent.id,
      chatTurnId: randomUUID(),
    },
  ]);

  const manifestRes = await page.request.get(`/api/chats/${chat.id}/work-manifest`);
  expect(manifestRes.ok(), await manifestRes.text()).toBe(true);
  const manifest = await manifestRes.json() as {
    totalCount: number;
    subagents: {
      active: Array<{ threadId: string; label: string }>;
      done: Array<{ threadId: string; status: string }>;
      totalCount: number;
    };
  };
  expect(manifest.totalCount).toBe(0);
  expect(manifest.subagents.active).toHaveLength(2);
  expect(manifest.subagents.done).toHaveLength(4);
  expect(manifest.subagents.totalCount).toBe(6);
  expect(manifest.subagents.active.filter((item) => item.threadId === "thread-active-reviewer"))
    .toHaveLength(1);
  expect(manifest.subagents.active.some((item) => item.threadId === "thread-other-chat")).toBe(false);

  await page.goto("/");
  await page.evaluate((orgId) => {
    localStorage.setItem("rudder.selectedOrganizationId", orgId);
    localStorage.setItem("rudder.theme", "light");
  }, organization.id);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

  const shelf = page.getByRole("complementary", { name: "Conversation files and links" });
  await expect(shelf).toBeVisible({ timeout: 15_000 });
  await expect(shelf.getByTestId("chat-work-manifest-section-count-subagents")).toHaveText("6");
  const summary = shelf.getByTestId("chat-work-manifest-subagents-summary");
  await expect(summary).toContainText("2 active · 4 done");
  await expect(summary.locator("[data-subagent-avatar]")).toHaveCount(4);
  await page.screenshot({ path: `${screenshotDir}/manifest-subagents-light-1440x900.png`, fullPage: true });

  await summary.click();
  const sidePanel = page.getByTestId("chat-side-panel");
  const list = sidePanel.getByTestId("chat-side-panel-subagents-view");
  await expect(sidePanel).toBeVisible();
  await expect(list.getByText("Active · 2", { exact: true })).toBeVisible();
  await expect(list.getByText("Done · 4", { exact: true })).toBeVisible();
  await expect(list.getByText("Failed", { exact: true })).toBeVisible();
  await expect(list.getByText("Interrupted", { exact: true })).toBeVisible();
  const longNameRow = list.getByTestId("chat-side-panel-subagent-row-thread-done-long-name");
  await expect(longNameRow).toHaveAttribute(
    "title",
    "Extremely Long Accessible Subagent Name For Manifest Layout Verification",
  );
  await page.screenshot({ path: `${screenshotDir}/subagents-list-light-1440x900.png`, fullPage: true });

  let failInitialTranscriptLoad = true;
  await page.route(
    `**/api/chats/${chat.id}/messages/${sourceMessageId}/transcript`,
    async (route) => {
      if (!failInitialTranscriptLoad) {
        await route.fallback();
        return;
      }
      failInitialTranscriptLoad = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Injected initial transcript failure." }),
      });
    },
  );
  await list.getByTestId("chat-side-panel-subagent-row-thread-done-architecture").click();
  const initialLoadError = list.getByRole("alert");
  await expect(initialLoadError).toContainText("Could not load sub-agent details.");
  await expect(initialLoadError.getByRole("button", { name: "Retry" })).toBeVisible();
  await page.screenshot({
    path: `${screenshotDir}/subagent-initial-load-error-retry-light-1440x900.png`,
    fullPage: true,
  });
  await initialLoadError.getByRole("button", { name: "Retry" }).click();
  const detail = sidePanel.getByTestId("chat-side-panel-subagent-view");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("Architecture review passed.");
  await expect(detail.getByText("Working on Check architecture boundaries.", { exact: true })).toHaveCount(1);
  await expect(detail.getByText("Architecture review passed.", { exact: true })).toHaveCount(1);
  await expect(detail).toContainText("Subagent Coordinator");
  await expect(detail.getByRole("textbox")).toHaveCount(0);
  await expect(sidePanel.getByRole("tab", { name: "Subagents" })).toBeVisible();
  const runTranscriptLink = detail.getByRole("link", { name: "View run" });
  await expect(runTranscriptLink).toHaveAttribute(
    "href",
    new RegExp(`/agents/${agent.id}/runs/${sourceRunId}$`),
  );
  await page.screenshot({
    path: `${screenshotDir}/subagent-detail-response-transcript-light-1440x900.png`,
    fullPage: true,
  });
  const transcriptPage = await page.context().newPage();
  await transcriptPage.goto(new URL(await runTranscriptLink.getAttribute("href")!, page.url()).toString());
  await expect(transcriptPage.getByText("Transcript", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(transcriptPage.getByText("Direct subagents are working across review and verification.", {
    exact: true,
  })).toBeVisible();
  await expect(transcriptPage.getByText("16 entries", { exact: true })).toBeVisible();
  await expect(transcriptPage.getByText("Used 8 tools", { exact: true })).toBeVisible();
  await transcriptPage.screenshot({
    path: `${screenshotDir}/linked-agent-run-transcript-light-1440x900.png`,
    fullPage: true,
  });
  await transcriptPage.close();

  await sidePanel.getByRole("tab", { name: "Subagents" }).click();
  await expect(list).toBeVisible();
  await list.getByTestId("chat-side-panel-subagent-row-thread-done-architecture").click();
  const architectureTab = sidePanel.getByRole("tab", { name: "Architecture Reviewer" });
  await expect(architectureTab).toHaveAttribute("aria-selected", "true");
  await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(2);
  const subagentsTab = sidePanel.getByRole("tab", { name: "Subagents" });
  await subagentsTab.click();
  await expect(subagentsTab).toHaveAttribute("aria-selected", "true");
  await list.getByTestId("chat-side-panel-subagent-row-thread-active-reviewer").click();
  await expect(detail).toHaveAttribute("data-subagent-thread-id", "thread-active-reviewer");
  await expect(detail).toContainText("The latest running snapshot is visible.");

  const terminalFixtures = [
    ...baseFixtures,
    {
      ...baseFixtures[0]!,
      status: "completed",
      at: "2026-07-29T08:10:00.000Z",
      response: "Active reviewer completed.",
    },
    {
      ...baseFixtures[1]!,
      status: "cancelled",
      at: "2026-07-29T08:11:00.000Z",
      response: "Active verifier was cancelled.",
    },
  ];
  await e2eDb.update(chatMessages).set({
    status: "completed",
    body: "Direct subagent work reached terminal states.",
    structuredPayload: { __chatTranscript: transcriptFor(terminalFixtures) },
  }).where(eq(chatMessages.id, sourceMessageId));

  await expect(detail.getByText("Completed", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(detail).toContainText("Active reviewer completed.");
  await sidePanel.getByRole("tab", { name: "Subagents" }).click();
  await expect(list.getByText("Active · 0", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(list.getByText("No active subagents", { exact: true })).toBeVisible();
  await expect(list.getByText("Done · 6", { exact: true })).toBeVisible();
  await expect(list.getByTestId("chat-side-panel-subagent-row-thread-active-reviewer")).toHaveCount(1);

  await page.evaluate(() => localStorage.setItem("rudder.theme", "dark"));
  await page.reload();
  await expect(page.getByTestId("chat-work-manifest")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("chat-work-manifest-subagents-summary").click();
  await expect(sidePanel).toBeVisible();
  await expect(list.getByText("Done · 6", { exact: true })).toBeVisible();
  await expect.poll(async () => (await sidePanel.boundingBox())?.width ?? 0).toBeGreaterThan(300);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${screenshotDir}/subagents-list-dark-1440x900.png`, fullPage: true });

  await sidePanel.getByTestId("chat-side-panel-collapse").click();
  await expect(sidePanel).toBeHidden();
  await expect(page.getByTestId("chat-work-manifest")).toBeVisible();

  await page.setViewportSize({ width: 900, height: 900 });
  const compactTrigger = page.getByTestId("chat-work-manifest-trigger");
  await expect(compactTrigger).toContainText("Subagents 6");
  await compactTrigger.click();
  await expect(page.getByTestId("chat-work-manifest-compact-panel")).toBeVisible();
  await page.screenshot({ path: `${screenshotDir}/manifest-subagents-dark-narrow.png`, fullPage: true });
});
