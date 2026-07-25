import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB, E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

test("matches Codex activity disclosure in collapsed and expanded Messenger states", async ({ page }) => {
  test.setTimeout(120_000);
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Chat-Transcript-Codex-Activity-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: "Codex Activity Agent",
    command: E2E_CODEX_STUB,
  });
  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Codex activity disclosure",
      preferredAgentId: agent.id,
      issueCreationMode: "manual_approval",
      planMode: false,
      initialMessage: { body: "Show compact process activity." },
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
    body: "The compact activity is ready.",
    structuredPayload: {
      __chatTranscript: [
        { kind: "system", ts: "2026-07-23T00:00:00.000Z", text: "turn started" },
        {
          kind: "tool_call",
          ts: "2026-07-23T00:00:01.000Z",
          name: "Skill",
          toolUseId: "skill-1",
          input: { skill: "systematic-debugging" },
        },
        {
          kind: "tool_result",
          ts: "2026-07-23T00:00:01.010Z",
          toolUseId: "skill-1",
          content: "Loaded skill",
          isError: false,
        },
        {
          kind: "tool_call",
          ts: "2026-07-23T00:00:02.000Z",
          name: "command_execution",
          toolUseId: "command-1",
          input: { command: "pnpm test:run" },
        },
        {
          kind: "tool_result",
          ts: "2026-07-23T00:00:03.000Z",
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
  await transcript.getByRole("button", { name: /Worked for/i }).click();
  const activityButton = transcript.getByRole("button", { name: "Expand tool activity" });
  await expect(activityButton).toContainText("Used 1 skill, ran 1 command");

  const [activityBox, transcriptBox] = await Promise.all([
    activityButton.boundingBox(),
    transcript.boundingBox(),
  ]);
  expect(activityBox).not.toBeNull();
  expect(transcriptBox).not.toBeNull();
  expect(activityBox!.width).toBeLessThan(transcriptBox!.width * 0.75);

  const groupDisclosure = transcript.locator("[data-transcript-disclosure-chevron]").first();
  await expect(groupDisclosure).toHaveCSS("opacity", "0");
  await page.keyboard.press("Tab");
  await activityButton.focus();
  await expect(activityButton).toBeFocused();
  await expect(groupDisclosure).toHaveCSS("opacity", "1");
  await activityButton.click();
  await expect(groupDisclosure).toHaveCSS("opacity", "1");

  const rowDisclosures = transcript.locator("[data-transcript-action-row-disclosure]");
  await expect(rowDisclosures).toHaveCount(2);
  await expect(rowDisclosures.first()).toHaveCSS("opacity", "0");
  await expect(transcript).not.toContainText("10ms");
  await expect(transcript).not.toContainText("1.0s");

  const iconOffsets = await transcript.evaluate((element) => {
    const summary = element.querySelector<HTMLElement>("[data-transcript-action-summary-icon]");
    const rows = [...element.querySelectorAll<HTMLElement>("[data-transcript-action-icon-slot]")];
    return {
      summaryX: summary?.getBoundingClientRect().x ?? null,
      rowXs: rows.map((row) => row.getBoundingClientRect().x),
      skillColor: rows[0] ? getComputedStyle(rows[0].querySelector("[data-transcript-action-icon]")!).color : null,
    };
  });
  expect(iconOffsets.summaryX).not.toBeNull();
  expect(iconOffsets.rowXs.length).toBeGreaterThanOrEqual(2);
  for (const rowX of iconOffsets.rowXs) {
    expect(Math.abs(rowX - iconOffsets.summaryX!)).toBeLessThanOrEqual(1);
  }
  expect(iconOffsets.skillColor).not.toBe("rgb(47, 128, 237)");

  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.screenshot({ path: "/tmp/rudder-codex-activity-expanded.png", fullPage: true });
});

test("keeps Messenger process activity inside the reading column on wide screens", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Chat-Transcript-Reading-Column-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: "Reading Column Agent",
    command: E2E_CODEX_STUB,
  });
  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Transcript reading column",
      preferredAgentId: agent.id,
      issueCreationMode: "manual_approval",
      planMode: false,
      initialMessage: { body: "Check wide process activity." },
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
    body: "The reading column is ready.",
    structuredPayload: {
      __chatTranscript: [
        {
          kind: "assistant",
          ts: "2026-07-23T00:00:01.000Z",
          text: "Inspecting a wide Messenger layout before rendering the final response.",
        },
        {
          kind: "tool_call",
          ts: "2026-07-23T00:00:02.000Z",
          name: "command_execution",
          toolUseId: "command-wide-1",
          input: { command: "pnpm test:run" },
        },
        {
          kind: "tool_result",
          ts: "2026-07-23T00:00:03.000Z",
          toolUseId: "command-wide-1",
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
  await transcript.getByRole("button", { name: /Worked for/i }).click();
  const readingColumns = transcript.locator('[data-transcript-chat-column="reading"]');
  await expect(readingColumns).toHaveCount(2);

  const [transcriptBox, firstColumnBox, secondColumnBox] = await Promise.all([
    transcript.boundingBox(),
    readingColumns.nth(0).boundingBox(),
    readingColumns.nth(1).boundingBox(),
  ]);
  expect(transcriptBox).not.toBeNull();
  expect(firstColumnBox).not.toBeNull();
  expect(secondColumnBox).not.toBeNull();
  expect(transcriptBox!.width).toBeGreaterThan(820);
  for (const columnBox of [firstColumnBox!, secondColumnBox!]) {
    expect(columnBox.width).toBeLessThanOrEqual(770);
    expect(columnBox.width).toBeLessThan(transcriptBox!.width - 100);
    expect(columnBox.x).toBeGreaterThanOrEqual(transcriptBox!.x);
  }

  await page.screenshot({ path: "/tmp/rudder-chat-transcript-reading-column.png", fullPage: true });
});
