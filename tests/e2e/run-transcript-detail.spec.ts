import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatConversations, createDb, heartbeatRunEvents, heartbeatRuns } from "../../packages/db/src/index.ts";
import { E2E_CODEX_STUB, E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

async function createOrganization(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name,
    },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json();
}

async function installRunTranscriptFilePreviewStub(page: Page, expectedPaths: string[]) {
  await page.addInitScript((paths) => {
    const previewCalls: string[] = [];
    Object.defineProperty(window, "__rudderTranscriptPreviewCalls", {
      configurable: true,
      value: previewCalls,
    });
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: {
        openPath: async () => {},
        previewLocalFile: async (filePath: string) => {
          previewCalls.push(filePath);
          if (!paths.includes(filePath)) throw new Error(`Unexpected transcript file path: ${filePath}`);
          const fileName = filePath.split("/").at(-1) ?? filePath;
          return {
            canonicalPath: filePath,
            fileName,
            parentPath: filePath.slice(0, filePath.lastIndexOf("/")),
            contentType: "text/plain; charset=utf-8",
            previewKind: "text",
            content: fileName === "SKILL.md"
              ? "# systematic-debugging\n\nUse evidence before fixes."
              : "export const runTranscriptEvidence = true;",
            base64: null,
            sizeBytes: 54,
            modifiedAt: "2026-07-24T00:00:00.000Z",
            truncated: false,
          };
        },
        setSidePanelCloseShortcutActive: async () => {},
      },
    });
  }, expectedPaths);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatRunOccurrenceForTest(date: Date, now: Date) {
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (sameDay) return time;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = date.getFullYear() === yesterday.getFullYear()
    && date.getMonth() === yesterday.getMonth()
    && date.getDate() === yesterday.getDate();
  if (isYesterday) return `Yesterday ${time}`;
  const dateLabel = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(date);
  return `${dateLabel} ${time}`;
}

test.describe("Run transcript detail", () => {
  test("renders detail transcripts as readable progress chunks with collapsed grouped tool activity", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    const organization = await createOrganization(page, `Run-Detail-${Date.now()}`);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/tests/ux/runs");

    await expect(page.getByRole("heading", { name: "Run Detail" })).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: "Show settled state" }).click();
    await expect(page.getByRole("button", { name: "Show streaming state" })).toBeVisible({ timeout: 15_000 });

    const firstProgressChunk = page.getByRole("button", { name: /Expand tool activity group 1/ }).filter({ hasText: "Read 2 files" });
    await expect(firstProgressChunk).toHaveCount(1);
    await expect(page.getByText("Model turn", { exact: false })).toHaveCount(0);
    await expect(page.getByText("Read", { exact: true })).toHaveCount(0);
    await expect(page.getByText("doc/product/GOAL.md", { exact: true })).toHaveCount(0);
    await expect(page.getByText("doc/archive/SPEC-implementation.md", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Marked PAP-473 done", { exact: false })).toBeVisible();
    await expect(page.getByText("added file-backed comment", { exact: false })).toBeVisible();
    await expect(page.getByText("Ran rudder issue done", { exact: false })).toHaveCount(0);

    await firstProgressChunk.click();
    await expect(page.getByRole("button", { name: "Open file GOAL.md", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open file SPEC-implementation.md", exact: true })).toBeVisible();

    const externalToolGroup = page.getByRole("button", { name: /Expand tool activity group 2/ }).filter({ hasText: "Searched 2 times, used 2 tools" });
    await expect(externalToolGroup).toHaveCount(1);
    await externalToolGroup.click();
    await expect(page.getByText("Web searched \"transcript UI rendering examples\"", { exact: false })).toBeVisible();
    const githubMcpRow = page.getByRole("button", { name: /tool details: Call fetch PR/ });
    const rudderMcpRow = page.getByRole("button", { name: /tool details: Call Rudder chat transcript/ });
    await expect(githubMcpRow).toHaveCount(1);
    await expect(rudderMcpRow).toHaveCount(1);
    await expect(githubMcpRow).toHaveAccessibleName("Expand tool details: Call fetch PR");
    await expect(rudderMcpRow).toHaveAccessibleName("Expand tool details: Call Rudder chat transcript");
    await expect(githubMcpRow.locator('img[src="/brands/github-logo.svg"]')).toBeVisible();
    await expect(rudderMcpRow.locator('img[src="/rudder-logo.png"]')).toBeVisible();

    const expandedExternalToolGroup = page.getByRole("button", { name: /Collapse tool activity group 2/ });
    const groupIconBox = await expandedExternalToolGroup.locator('[data-transcript-action-summary-icon="true"]').boundingBox();
    const githubIconBox = await githubMcpRow.locator('[data-transcript-action-icon-slot="true"]').boundingBox();
    expect(groupIconBox).not.toBeNull();
    expect(githubIconBox).not.toBeNull();
    expect(Math.abs((groupIconBox?.x ?? 0) - (githubIconBox?.x ?? 0))).toBeLessThanOrEqual(1);

    await expect(page.getByText("repo_full_name Undertone0809/rudder", { exact: false })).toHaveCount(0);
    await expect(page.getByText("eeb73ad1-e000-4dce-9d47-23106fa36bbc", { exact: false })).toHaveCount(0);
    await expect(page.getByText("rudder-tools", { exact: false })).toHaveCount(0);

    const rudderDisclosure = rudderMcpRow.locator('[data-transcript-action-row-disclosure="true"]');
    await expect(rudderDisclosure).toHaveCSS("opacity", "0");

    await githubMcpRow.focus();
    await page.keyboard.press("Tab");
    await expect(rudderMcpRow).toBeFocused();
    await expect(rudderDisclosure).toHaveCSS("opacity", "1");
    await rudderMcpRow.blur();
    await page.mouse.move(0, 0);
    await expect(rudderDisclosure).toHaveCSS("opacity", "0");

    await page.screenshot({
      path: "/tmp/rudder-run-transcript-mcp-idle.png",
      fullPage: true,
    });
    await rudderMcpRow.hover();
    await page.screenshot({
      path: "/tmp/rudder-run-transcript-mcp-hover.png",
      fullPage: true,
    });

    await githubMcpRow.click();
    await expect(page.getByText("Undertone0809/rudder", { exact: false })).toBeVisible();
    await rudderMcpRow.click();
    await expect(page.getByText("eeb73ad1-e000-4dce-9d47-23106fa36bbc", { exact: false })).toBeVisible();
    await expect(page.getByText("rudder-tools", { exact: false }).first()).toBeVisible();
    await page.mouse.move(0, 0);
    await rudderMcpRow.blur();
    await expect(rudderDisclosure).toHaveCSS("opacity", "0");

    const skillUseRow = page.getByRole("button", { name: "Expand tool details: Use flomo-local-api skill" });
    await expect(skillUseRow).toHaveCount(1);
    await expect(page.getByText("/Users/zeeland/.codex/skills/flomo-local-api/SKILL.md", { exact: false })).toHaveCount(0);
    await skillUseRow.click();
    await expect(page.getByText("/Users/zeeland/.codex/skills/flomo-local-api/SKILL.md", { exact: false })).toBeVisible();

    await expect(page.getByText("Agent memory updated", { exact: false })).toBeVisible();
    await expect(page.getByText("Gabriel updated stable memory instructions.", { exact: false })).toBeVisible();
    await expect(page.getByText("Stable instructions", { exact: false })).toBeVisible();
    await expect(page.getByText("Effective next run", { exact: false })).toBeVisible();
    await expect(page.getByText("/workspaces/agents/gabriel--fixture/instructions/MEMORY.md", { exact: false })).toHaveCount(0);
    await page.getByRole("button", { name: "Expand memory update details" }).first().click();
    await expect(page.getByText("/workspaces/agents/gabriel--fixture/instructions/MEMORY.md", { exact: false })).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Memory update failed, Gabriel, Knowledge graph" })).toBeVisible();
    await expect(page.getByText("Knowledge graph", { exact: false })).toBeVisible();
    await expect(page.getByText("permission denied", { exact: false }).first()).toBeVisible();

    await page.screenshot({
      path: "/tmp/rudder-run-transcript-detail-expanded.png",
      fullPage: true,
    });
  });

  test("merges transcript and invocation into one card with tabs on the real run detail page", async ({ page, baseURL }) => {
    const organization = await createOrganization(page, `Run-Detail-Agent-${Date.now()}`);

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Transcript Tester",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json();

    const runRes = await page.request.post(`/api/agents/${agent.id}/heartbeat/invoke?orgId=${organization.id}`);
    expect(runRes.ok()).toBe(true);
    const run = await runRes.json();
    expect(run.id).toBeTruthy();

    const transcriptStartedAt = Date.now() + 1_000;
    const transcriptEntries = [
      { kind: "system", text: "reasoning started" },
      { kind: "assistant", text: "Progress update." },
      { kind: "system", text: "reasoning completed" },
      { kind: "system", text: "reasoning started" },
      { kind: "assistant", text: "I read AG", delta: true },
      { kind: "assistant", text: "ENTS", delta: true },
      { kind: "assistant", text: ".md and added E", delta: true },
      { kind: "assistant", text: "2E coverage.", delta: true },
      { kind: "system", text: "reasoning completed" },
    ];
    await e2eDb.insert(heartbeatRunEvents).values(transcriptEntries.map((entry, index) => ({
      orgId: organization.id,
      runId: run.id,
      agentId: agent.id,
      seq: 10_000 + index,
      eventType: "transcript.entry",
      stream: "system",
      level: "info",
      message: "chat transcript entry",
      payload: {
        ...entry,
        ts: new Date(transcriptStartedAt + index).toISOString(),
      },
      createdAt: new Date(transcriptStartedAt + index),
    })));

    await expect.poll(async () => {
      const runDetailRes = await page.request.get(`/api/agent-runs/${run.id}`);
      if (!runDetailRes.ok()) return null;
      return ((await runDetailRes.json()) as { status?: string }).status ?? null;
    }, { timeout: 15_000 }).toBe("succeeded");

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/agents/${agent.id}/runs/${run.id}`);

    const mainContent = page.locator("#main-content");
    const agentRunsTab = mainContent.getByRole("tab", { name: "Runs" });
    await expect(mainContent.getByRole("tab", { name: "Dashboard" })).toBeVisible({ timeout: 15_000 });
    await expect(mainContent.getByRole("tab", { name: "Configuration" })).toBeVisible();
    await expect(mainContent.getByRole("tab", { name: "Instructions" })).toBeVisible();
    await expect(mainContent.getByRole("tab", { name: "Skills" })).toBeVisible();
    await expect(mainContent.getByRole("tab", { name: "Integrations" })).toBeVisible();
    await expect(agentRunsTab).toBeVisible();
    await expect(mainContent.getByRole("tab", { name: "Budget" })).toBeVisible();
    await expect(agentRunsTab).toHaveAttribute("data-state", "active");

    const transcriptTab = page.getByRole("tab", { name: "Transcript" });
    const invocationTab = page.getByRole("tab", { name: "Invocation" });
    await expect(transcriptTab).toBeVisible({ timeout: 15_000 });
    await expect(invocationTab).toBeVisible({ timeout: 15_000 });
    const detailPane = page.getByTestId("agent-runs-detail-pane");
    const listPane = page.getByTestId("agent-runs-list-pane");
    await expect(detailPane).toBeVisible();
    await expect(listPane).toBeVisible();
    const detailBox = await detailPane.boundingBox();
    const listBox = await listPane.boundingBox();
    expect(detailBox).not.toBeNull();
    expect(listBox).not.toBeNull();
    if (Math.abs(detailBox!.y - listBox!.y) <= 2) {
      expect(detailBox!.x).toBeLessThan(listBox!.x);
    } else {
      expect(listBox!.y).toBeLessThan(detailBox!.y);
      expect(Math.abs(detailBox!.width - listBox!.width)).toBeLessThan(2);
    }
    await expect(transcriptTab).toHaveAttribute("data-state", "active");
    await expect(page.getByRole("button", { name: "nice" })).toBeVisible();
    await expect(detailPane.getByText(/Progress update\.\s+I read AGENTS\.md and added E2E coverage\./)).toBeVisible();
    await expect(detailPane.getByText(/reasoning started/i)).toHaveCount(0);
    await expect(detailPane.getByText(/reasoning completed/i)).toHaveCount(0);

    await page.getByRole("button", { name: "raw" }).click();
    await expect(detailPane.getByText(/reasoning started/i).first()).toBeVisible();
    await expect(detailPane.getByText(/reasoning completed/i).first()).toBeVisible();
    const coalescedRawMessage = detailPane.locator("pre").filter({ hasText: "I read AGENTS.md and added E2E coverage." });
    await expect(coalescedRawMessage).toHaveCount(1);
    await expect(detailPane.getByText("I read AG", { exact: true })).toHaveCount(0);
    await coalescedRawMessage.locator("..").screenshot({
      path: "/tmp/rudder-run-transcript-raw-coalesced.png",
    });
    await page.getByRole("button", { name: "nice" }).click();

    await page.getByRole("button", { name: "Expand transcript" }).click();
    const transcriptDialog = page.getByRole("dialog", { name: "Transcript" });
    await expect(transcriptDialog).toBeVisible();
    await expect(transcriptDialog).toHaveClass(/transcript-modal-content/);
    await expect(page.locator(".transcript-modal-overlay")).toBeVisible();
    await page.waitForFunction(() => {
      const dialog = document.querySelector(".transcript-modal-content");
      if (!dialog) return false;
      return dialog
        .getAnimations()
        .every((animation) => animation.playState === "finished" || animation.playState === "idle");
    });
    const transcriptDialogBox = await transcriptDialog.boundingBox();
    const viewport = page.viewportSize();
    expect(transcriptDialogBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(transcriptDialogBox!.x).toBeGreaterThanOrEqual(0);
    expect(transcriptDialogBox!.y).toBeGreaterThanOrEqual(0);
    expect(transcriptDialogBox!.x + transcriptDialogBox!.width).toBeLessThanOrEqual(viewport!.width);
    expect(transcriptDialogBox!.y + transcriptDialogBox!.height).toBeLessThanOrEqual(viewport!.height);
    await expect(transcriptDialog.getByText(/Progress update\.\s+I read AGENTS\.md and added E2E coverage\./)).toBeVisible();
    await expect(transcriptDialog.getByRole("button", { name: "raw" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(transcriptDialog).toBeHidden();

    await invocationTab.click();
    await expect(invocationTab).toHaveAttribute("data-state", "active");
    await expect(page.getByText("Exact adapter invocation and Agent Instruction stack")).toHaveClass(/invisible/);
    await expect(page.getByText("Runtime:", { exact: false })).toBeVisible();
    await expect(page.getByText("Command:", { exact: false })).toBeVisible();
    await expect(page.getByText(/^Events \(\d+\)$/)).toBeVisible();
    await expect(page.getByText("adapter invocation", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "nice" })).toBeHidden();

    const promptBlock = page.getByTestId("invocation-prompt");
    await expect(promptBlock).toBeVisible();
    const promptText = await promptBlock.textContent();
    expect(promptText?.trim()).toBeTruthy();

    if (baseURL) {
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
    }
    await page.getByRole("button", { name: "Copy agent instruction stack" }).click();
    await expect
      .poll(async () => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(promptText);

    await invocationTab.hover();
    await expect(page.getByText("Exact adapter invocation and Agent Instruction stack")).toBeVisible();

    await transcriptTab.click();
    await expect(transcriptTab).toHaveAttribute("data-state", "active");
    await expect(page.getByRole("button", { name: "nice" })).toBeVisible();

    await page.screenshot({
      path: "tests/e2e/test-results/agent-run-detail-tabs.png",
      fullPage: true,
    });
  });

  test("does not promote long stderr excerpts into the run detail summary", async ({ page }) => {
    const organization = await createOrganization(page, `Run-Detail-Long-Stderr-${Date.now()}`);

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Stderr Layout Tester",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    const runId = randomUUID();
    await e2eDb.insert(heartbeatRuns).values({
      id: runId,
      orgId: organization.id,
      agentId: agent.id,
      invocationSource: "scheduled",
      triggerDetail: "Scheduled heartbeat",
      status: "failed",
      startedAt: new Date("2026-05-14T08:33:42.000Z"),
      finishedAt: new Date("2026-05-14T08:33:43.000Z"),
      error: "Runtime hook failed",
      errorCode: "runtime_hook_failed",
      stderrExcerpt:
        "2026-05-14T08:33:42.273612Z WARN codex_core::session::turn: after_agent hook failed; continuing " +
        `turn_id=${"019e2597-e63f-7520-9143-4bf97a7bfefc".repeat(8)} hook_name=legacy_notify error=No such file or directory (os error 2)`,
      createdAt: new Date("2026-05-14T08:33:42.000Z"),
      updatedAt: new Date("2026-05-14T08:33:43.000Z"),
    });

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/agents/${agent.id}/runs/${runId}`, { waitUntil: "domcontentloaded" });

    const detailPane = page.getByTestId("agent-runs-detail-pane");
    const summaryCard = detailPane.getByTestId("run-summary-card");
    await expect(summaryCard.getByText("The run hit a system-level execution problem.", { exact: false })).toBeVisible({
      timeout: 15_000,
    });
    await expect(detailPane.getByTestId("run-stderr-excerpt")).toHaveCount(0);
    await expect(detailPane.getByText("turn_id=019e2597", { exact: false })).toHaveCount(0);

    await page.screenshot({
      path: "/tmp/rudder-agent-run-stderr-contained.png",
      fullPage: true,
    });
  });

  test("shows recoverable chat failure guidance in run detail and list summaries", async ({ page }) => {
    const organization = await createOrganization(page, `Run-Detail-Chat-Failure-${Date.now()}`);

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Chat Failure Tester",
        role: "engineer",
        agentRuntimeType: "claude_local",
        agentRuntimeConfig: {},
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    const runId = randomUUID();
    const conversationId = randomUUID();
    const userMessage = "The assistant finished without a final Rudder reply. Rudder saved the attempt and transcript; retry when ready.";
    const failureResult = {
      outcome: "failed",
      errorCode: "chat_result_missing_sentinel",
      recoverable: true,
      userMessage,
    };
    await e2eDb.insert(chatConversations).values({
      id: conversationId,
      orgId: organization.id,
      title: "Recoverable chat failure",
      preferredAgentId: agent.id,
      routedAgentId: agent.id,
      createdAt: new Date("2026-06-26T06:15:55.226Z"),
      updatedAt: new Date("2026-06-26T06:16:31.946Z"),
    });
    await e2eDb.insert(heartbeatRuns).values({
      id: runId,
      orgId: organization.id,
      agentId: agent.id,
      invocationSource: "chat",
      triggerDetail: "chat_assistant_reply_stream",
      status: "failed",
      startedAt: new Date("2026-06-26T06:15:55.226Z"),
      finishedAt: new Date("2026-06-26T06:16:31.946Z"),
      error: "Chat adapter completed without the required Rudder result sentinel",
      errorCode: "chat_result_missing_sentinel",
      resultJson: failureResult,
      resultSummaryJson: failureResult,
      contextSnapshot: {
        scene: "chat",
        targetType: "chat_conversation",
        conversationId,
        messageId: randomUUID(),
      },
      createdAt: new Date("2026-06-26T06:15:55.226Z"),
      updatedAt: new Date("2026-06-26T06:16:31.946Z"),
    });

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/agents/${agent.id}/runs/${runId}`, { waitUntil: "domcontentloaded" });

    const detailPane = page.getByTestId("agent-runs-detail-pane");
    const summaryCard = detailPane.getByTestId("run-summary-card");
    await expect(summaryCard.getByText("Run failed")).toBeVisible({ timeout: 15_000 });
    await expect(summaryCard.getByText(userMessage)).toBeVisible();
    await expect(summaryCard.getByText("The run hit a system-level execution problem.", { exact: false })).toHaveCount(0);

    const listPane = page.getByTestId("agent-runs-list-pane");
    await expect(listPane.getByText("The assistant finished without a final Rudder reply", { exact: false })).toBeVisible();
  });

  test("shows an explicit empty state when only operator-hidden run events were persisted", async ({ page }) => {
    const organization = await createOrganization(page, `Run-Detail-Empty-Transcript-${Date.now()}`);

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Empty Transcript Tester",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };
    const runId = randomUUID();
    const startedAt = new Date("2026-07-24T09:00:00.000Z");

    await e2eDb.insert(heartbeatRuns).values({
      id: runId,
      orgId: organization.id,
      agentId: agent.id,
      invocationSource: "scheduled",
      triggerDetail: "Scheduled heartbeat",
      status: "succeeded",
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 1_000),
      resultJson: { summary: "The run has no operator-visible transcript." },
      resultSummaryJson: { summary: "The run has no operator-visible transcript." },
      createdAt: startedAt,
      updatedAt: new Date(startedAt.getTime() + 1_000),
    });
    await e2eDb.insert(heartbeatRunEvents).values({
      orgId: organization.id,
      runId,
      agentId: agent.id,
      seq: 1,
      eventType: "issue.execution_released",
      stream: "system",
      level: "info",
      message: null,
      payload: null,
      createdAt: new Date(startedAt.getTime() + 500),
    });

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/agents/${agent.id}/runs/${runId}`, { waitUntil: "domcontentloaded" });

    const detailPane = page.getByTestId("agent-runs-detail-pane");
    await expect(detailPane.getByText("Transcript", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(detailPane.getByText("No persisted transcript for this run.", { exact: true })).toBeVisible();
    await expect(detailPane.getByRole("button", { name: "Expand transcript" })).toBeVisible();
  });

  test("does not promote stderr excerpts for failed or successful run detail pages", async ({ page }) => {
    const organization = await createOrganization(page, `Run-Detail-Stderr-Status-${Date.now()}`);

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Stderr Status Tester",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    const timedOutRunId = randomUUID();
    const succeededRunId = randomUUID();
    const stderrExcerpt = "WARN rmcp::transport::worker: worker quit with fatal transport channel closed";
    await e2eDb.insert(heartbeatRuns).values([
      {
        id: timedOutRunId,
        orgId: organization.id,
        agentId: agent.id,
        invocationSource: "scheduled",
        triggerDetail: "Scheduled heartbeat",
        status: "timed_out",
        startedAt: new Date("2026-05-14T09:33:42.000Z"),
        finishedAt: new Date("2026-05-14T09:34:42.000Z"),
        error: "Runtime timed out",
        errorCode: "runtime_timed_out",
        stderrExcerpt,
        createdAt: new Date("2026-05-14T09:33:42.000Z"),
        updatedAt: new Date("2026-05-14T09:34:42.000Z"),
      },
      {
        id: succeededRunId,
        orgId: organization.id,
        agentId: agent.id,
        invocationSource: "scheduled",
        triggerDetail: "Scheduled heartbeat",
        status: "succeeded",
        startedAt: new Date("2026-05-14T10:33:42.000Z"),
        finishedAt: new Date("2026-05-14T10:33:43.000Z"),
        error: null,
        errorCode: null,
        stderrExcerpt,
        createdAt: new Date("2026-05-14T10:33:42.000Z"),
        updatedAt: new Date("2026-05-14T10:33:43.000Z"),
      },
    ]);

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/agents/${agent.id}/runs/${timedOutRunId}`, { waitUntil: "domcontentloaded" });
    const timedOutDetailPane = page.getByTestId("agent-runs-detail-pane");
    await expect(timedOutDetailPane.getByTestId("run-summary-card").getByText("timed out", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(timedOutDetailPane.getByTestId("run-stderr-excerpt")).toHaveCount(0);

    await page.goto(`/agents/${agent.id}/runs/${succeededRunId}`, { waitUntil: "domcontentloaded" });
    const succeededDetailPane = page.getByTestId("agent-runs-detail-pane");
    await expect(succeededDetailPane.getByTestId("run-summary-card").getByText("succeeded", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(succeededDetailPane.getByTestId("run-stderr-excerpt")).toHaveCount(0);
  });

  test("copies the full run id from the runs list without navigating away", async ({ page, baseURL }) => {
    const organization = await createOrganization(page, `Run-Copy-${Date.now()}`);

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Run Copy Tester",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json();

    const runRes = await page.request.post(`/api/agents/${agent.id}/heartbeat/invoke?orgId=${organization.id}`);
    expect(runRes.ok()).toBe(true);
    const run = await runRes.json();
    expect(run.id).toBeTruthy();

    if (baseURL) {
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
    }

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/agents/${agent.id}/runs/${run.id}`);
    const urlBeforeCopy = new URL(page.url());

    const copyButton = page.getByRole("button", { name: `Copy run ID ${run.id.slice(0, 8)}` });
    await expect(copyButton).toBeVisible({ timeout: 15_000 });

    await copyButton.click();

    await expect(page.getByText("Run ID copied")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/agents/[^/]+/runs/${run.id}$`));
    const urlAfterCopy = new URL(page.url());
    expect(urlAfterCopy.origin).toBe(urlBeforeCopy.origin);
    expect(urlAfterCopy.pathname.endsWith(`/runs/${run.id}`)).toBe(true);
    await expect
      .poll(async () => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(run.id);

    await page.screenshot({
      path: "tests/e2e/test-results/agent-run-id-copied.png",
      fullPage: true,
    });
  });

  test("shows run occurrence times in the compact runs list", async ({ page }) => {
    const organization = await createOrganization(page, `Run-List-Time-${Date.now()}`);

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Run Time Tester",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    const now = new Date();
    const todayStartedAt = new Date(now);
    todayStartedAt.setMinutes(now.getMinutes() - 20, 0, 0);
    const todayFinishedAt = new Date(todayStartedAt.getTime() + 92_000);
    const olderStartedAt = new Date(now);
    olderStartedAt.setDate(now.getDate() - 2);
    olderStartedAt.setHours(8, 5, 0, 0);
    const olderFinishedAt = new Date(olderStartedAt.getTime() + 4 * 60_000);
    const todayRunId = randomUUID();
    const olderRunId = randomUUID();

    await e2eDb.insert(heartbeatRuns).values([
      {
        id: todayRunId,
        orgId: organization.id,
        agentId: agent.id,
        invocationSource: "scheduled",
        triggerDetail: "Scheduled heartbeat",
        status: "succeeded",
        startedAt: todayStartedAt,
        finishedAt: todayFinishedAt,
        resultJson: { summary: "Today run should show clock time" },
        createdAt: new Date(todayStartedAt.getTime() - 30_000),
        updatedAt: todayFinishedAt,
      },
      {
        id: olderRunId,
        orgId: organization.id,
        agentId: agent.id,
        invocationSource: "mention",
        triggerDetail: "Mentioned",
        status: "succeeded",
        startedAt: olderStartedAt,
        finishedAt: olderFinishedAt,
        resultJson: { summary: "Older run should show date and time" },
        createdAt: new Date(olderStartedAt.getTime() - 30_000),
        updatedAt: olderFinishedAt,
      },
    ]);

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/agents/${agent.id}/runs/${todayRunId}`, { waitUntil: "domcontentloaded" });

    const listPane = page.getByTestId("agent-runs-list-pane");
    await expect(listPane).toBeVisible({ timeout: 15_000 });

    const expectedTodayLabel = formatRunOccurrenceForTest(todayStartedAt, now);
    const expectedOlderLabel = formatRunOccurrenceForTest(olderStartedAt, now);
    const todayRow = listPane.getByRole("link", {
      name: new RegExp(`Open run ${todayRunId.slice(0, 8)} from ${escapeRegExp(expectedTodayLabel)}`),
    });
    const olderRow = listPane.getByRole("link", {
      name: new RegExp(`Open run ${olderRunId.slice(0, 8)} from ${escapeRegExp(expectedOlderLabel)}`),
    });

    await expect(todayRow).toBeVisible();
    await expect(olderRow).toBeVisible();
    await expect(todayRow.getByTestId("run-list-timing")).toContainText(expectedTodayLabel);
    await expect(todayRow.getByTestId("run-list-timing")).toContainText("Ran for 1m 32s");
    await expect(olderRow.getByTestId("run-list-timing")).toContainText(expectedOlderLabel);
    await expect(olderRow.getByTestId("run-list-timing")).toContainText("Ran for 4m");
    await expect(todayRow.getByTestId("run-list-timing")).toHaveAttribute("title", /Created/);

    const listBox = await listPane.boundingBox();
    const todayTimingBox = await todayRow.getByTestId("run-list-timing").boundingBox();
    const olderTimingBox = await olderRow.getByTestId("run-list-timing").boundingBox();
    expect(listBox).not.toBeNull();
    expect(todayTimingBox).not.toBeNull();
    expect(olderTimingBox).not.toBeNull();
    expect(todayTimingBox!.x + todayTimingBox!.width).toBeLessThanOrEqual(listBox!.x + listBox!.width + 1);
    expect(olderTimingBox!.x + olderTimingBox!.width).toBeLessThanOrEqual(listBox!.x + listBox!.width + 1);

    await page.screenshot({
      path: "/tmp/rudder-agent-run-list-occurrence-times.png",
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/agents/${agent.id}/runs`, { waitUntil: "domcontentloaded" });
    const mobileListPane = page.getByTestId("agent-runs-list-pane");
    await expect(mobileListPane).toBeVisible();
    const mobileTodayRow = mobileListPane.getByRole("link", {
      name: new RegExp(`Open run ${todayRunId.slice(0, 8)} from ${escapeRegExp(expectedTodayLabel)}`),
    });
    const mobileOlderRow = mobileListPane.getByRole("link", {
      name: new RegExp(`Open run ${olderRunId.slice(0, 8)} from ${escapeRegExp(expectedOlderLabel)}`),
    });
    await expect(mobileTodayRow).toBeVisible();
    await expect(mobileOlderRow).toBeVisible();
    const mobileListBox = await mobileListPane.boundingBox();
    const mobileOlderTimingBox = await mobileOlderRow.getByTestId("run-list-timing").boundingBox();
    expect(mobileListBox).not.toBeNull();
    expect(mobileOlderTimingBox).not.toBeNull();
    expect(mobileOlderTimingBox!.x + mobileOlderTimingBox!.width).toBeLessThanOrEqual(mobileListBox!.x + mobileListBox!.width + 1);
    await page.screenshot({
      path: "/tmp/rudder-agent-run-list-occurrence-times-mobile.png",
      fullPage: true,
    });
  });

  test("opens transcript Read and Skill artifacts in the global Side Panel from the real run page", async ({ page }) => {
    test.setTimeout(120_000);
    const organization = await createOrganization(page, `Run-Transcript-Artifacts-${Date.now()}`);
    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Transcript Artifact Tester",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };
    const runId = randomUUID();
    const sourcePath = "/workspace/rudder/ui/src/components/transcript/RunTranscriptView.tsx";
    const skillPath = "/workspace/rudder/.agents/skills/systematic-debugging/SKILL.md";
    await installRunTranscriptFilePreviewStub(page, [sourcePath, skillPath]);

    const startedAt = new Date("2026-07-24T08:00:00.000Z");
    await e2eDb.insert(heartbeatRuns).values({
      id: runId,
      orgId: organization.id,
      agentId: agent.id,
      invocationSource: "scheduled",
      triggerDetail: "Scheduled heartbeat",
      status: "succeeded",
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 4_000),
      resultJson: { summary: "Inspected transcript artifacts." },
      createdAt: startedAt,
      updatedAt: new Date(startedAt.getTime() + 4_000),
    });
    const transcriptEntries = [
      { kind: "system", text: "turn started" },
      { kind: "assistant", text: "I will inspect the implementation evidence." },
      {
        kind: "tool_call",
        name: "read",
        toolUseId: "read-source",
        input: { path: sourcePath, cwd: "/workspace/rudder" },
      },
      {
        kind: "tool_result",
        toolUseId: "read-source",
        content: "export function RunTranscriptView() {}",
        isError: false,
      },
      {
        kind: "tool_call",
        name: "command_execution",
        toolUseId: "read-skill",
        input: {
          command: "sed -n '1,240p' .agents/skills/systematic-debugging/SKILL.md",
          cwd: "/workspace/rudder",
        },
      },
      {
        kind: "tool_result",
        toolUseId: "read-skill",
        content: "# systematic-debugging",
        isError: false,
      },
    ];
    await e2eDb.insert(heartbeatRunEvents).values(transcriptEntries.map((entry, index) => ({
      orgId: organization.id,
      runId,
      agentId: agent.id,
      seq: 100 + index,
      eventType: "transcript.entry",
      stream: "system",
      level: "info",
      message: "chat transcript entry",
      payload: {
        ...entry,
        ts: new Date(startedAt.getTime() + 1_000 + index).toISOString(),
      },
      createdAt: new Date(startedAt.getTime() + 1_000 + index),
    })));

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/agents/${agent.id}/runs/${runId}`, { waitUntil: "domcontentloaded" });
    const detailPane = page.getByTestId("agent-runs-detail-pane");
    await expect(detailPane.getByText("Transcript", { exact: true })).toBeVisible({ timeout: 15_000 });

    const activity = detailPane.getByRole("button", { name: /Expand tool activity/ }).first();
    await expect(activity).toContainText(/Used 1 skill/i);
    await expect(activity).toContainText(/read 1 file/i);
    await expect(detailPane.locator("[data-transcript-file-target]")).toHaveCount(0);
    await activity.click();

    const sourceTarget = detailPane.locator(`[data-transcript-file-target="${sourcePath}"]`);
    const skillTarget = detailPane.locator(`[data-transcript-file-target="${skillPath}"]`);
    await expect(sourceTarget).toHaveText("RunTranscriptView.tsx");
    await expect(skillTarget).toHaveText("systematic-debugging");
    await expect(detailPane.getByText(sourcePath, { exact: true })).toHaveCount(0);
    await expect(detailPane.getByText(skillPath, { exact: true })).toHaveCount(0);

    const contextCard = page.getByTestId("workspace-context-card");
    await expect(contextCard).toHaveAttribute("aria-hidden", "false");
    const runUrl = page.url();
    await sourceTarget.click();
    await expect(page).toHaveURL(runUrl);
    const sidePanel = page.getByRole("complementary", { name: "Side Panel" });
    await expect(sidePanel).toBeVisible();
    await expect(contextCard).toHaveAttribute("data-auto-collapsed", "true");
    await expect(contextCard).toHaveAttribute("aria-hidden", "true");
    await expect.poll(async () => contextCard.evaluate((node) => node.getBoundingClientRect().width)).toBeLessThanOrEqual(2);
    await expect(page.getByRole("button", { name: "Assign Task" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Chat" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Run heartbeat" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect(sidePanel.getByRole("tab", { name: "RunTranscriptView.tsx" })).toBeVisible();
    const localPreview = sidePanel.getByTestId("chat-side-panel-local-file-view");
    await expect(localPreview.getByText("RunTranscriptView.tsx", { exact: true })).toBeVisible();
    await expect(localPreview.getByText("/workspace/rudder/ui/src/components/transcript", { exact: true })).toHaveCount(0);

    const runListPane = page.getByTestId("agent-runs-list-pane");
    const stackedLayout = await Promise.all([
      runListPane.boundingBox(),
      detailPane.boundingBox(),
      page.getByTestId("run-filter-floating-toolbar").boundingBox(),
      page.getByTestId("workspace-main-card").boundingBox(),
    ]);
    expect(stackedLayout.every(Boolean)).toBe(true);
    const [listBox, detailBox, toolbarBox, mainBox] = stackedLayout;
    expect(listBox!.y).toBeLessThan(detailBox!.y);
    expect(Math.abs(listBox!.width - detailBox!.width)).toBeLessThan(2);
    expect(toolbarBox!.x).toBeGreaterThanOrEqual(mainBox!.x);
    expect(toolbarBox!.x + toolbarBox!.width).toBeLessThanOrEqual(mainBox!.x + mainBox!.width + 1);

    await page.getByRole("button", { name: "Expand transcript" }).click();
    const transcriptDialog = page.getByRole("dialog", { name: "Transcript" });
    await expect(transcriptDialog).toBeVisible();
    const modalActivity = transcriptDialog.getByRole("button", { name: /Expand tool activity/ }).first();
    await modalActivity.click();
    await transcriptDialog.locator(`[data-transcript-file-target="${skillPath}"]`).click();
    await expect(transcriptDialog).toBeHidden();
    await expect(page).toHaveURL(runUrl);
    await expect(sidePanel.getByRole("tab", { name: "systematic-debugging" })).toBeVisible();
    await expect(sidePanel.getByTestId("chat-side-panel-local-file-view").getByText("SKILL.md", { exact: true })).toBeVisible();
    await expect(sidePanel.getByText("/workspace/rudder/.agents/skills/systematic-debugging", { exact: true })).toHaveCount(0);

    await page.screenshot({
      path: "/tmp/rudder-agent-run-side-panel-responsive.png",
      fullPage: true,
    });

    await page.getByRole("button", { name: "Close Side Panel" }).click();
    await expect(sidePanel).toBeHidden();
    await expect(contextCard).not.toHaveAttribute("data-auto-collapsed", "true");
    await expect(contextCard).toHaveAttribute("aria-hidden", "false");
    await expect.poll(async () => contextCard.evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThan(0);
  });
});
