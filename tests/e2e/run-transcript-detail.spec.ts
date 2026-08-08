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
      window.localStorage.setItem("rudder.theme", "dark");
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
    await rudderMcpRow.hover();
    await expect(rudderDisclosure).toHaveCSS("opacity", "1");
    const rudderDuration = rudderMcpRow.locator("[data-transcript-action-duration='true']");
    const durationBox = await rudderDuration.boundingBox();
    const disclosureBox = await rudderDisclosure.boundingBox();
    expect(durationBox).not.toBeNull();
    expect(disclosureBox).not.toBeNull();
    expect(Math.abs(
      ((durationBox?.y ?? 0) + (durationBox?.height ?? 0) / 2)
      - ((disclosureBox?.y ?? 0) + (disclosureBox?.height ?? 0) / 2),
    )).toBeLessThanOrEqual(1);
    await page.mouse.move(0, 0);
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
    await expect(page.getByText("Transcript renderer discussion", { exact: false })).toBeVisible();
    await rudderMcpRow.click();
    await expect(page.getByText("eeb73ad1-e000-4dce-9d47-23106fa36bbc", { exact: false })).toBeVisible();
    await expect(page.getByText("Transcript loaded", { exact: false })).toBeVisible();
    await expect(page.getByText("rudder-tools", { exact: false })).toHaveCount(0);
    await expect(page.getByText("structuredContent", { exact: false })).toHaveCount(0);
    await expect(page.getByText("_meta", { exact: false })).toHaveCount(0);
    await page.mouse.move(0, 0);
    await rudderMcpRow.blur();
    await expect(rudderDisclosure).toHaveCSS("opacity", "0");

    const skillSummary = page.getByTitle("/Users/zeeland/.codex/skills/flomo-local-api/SKILL.md");
    await expect(skillSummary).toBeVisible();
    const skillUseRow = page.getByRole("button", { name: /tool details: Use flomo-local-api skill/ });
    await expect(skillUseRow).toHaveCount(0);
    await expect(page.getByText("/Users/zeeland/.codex/skills/flomo-local-api/SKILL.md", { exact: false })).toHaveCount(0);
    await expect(skillSummary.locator("xpath=..").locator("[data-transcript-action-row-disclosure='true']")).toHaveCount(0);

    await expect(page.getByText("Agent memory updated", { exact: false })).toBeVisible();
    await expect(page.getByText("Gabriel updated stable memory instructions.", { exact: false })).toBeVisible();
    await expect(page.getByText("Stable instructions", { exact: false })).toBeVisible();
    await expect(page.getByText("Effective next run", { exact: false })).toBeVisible();
    await expect(page.getByText("/workspaces/agents/gabriel--fixture/instructions/MEMORY.md", { exact: false })).toHaveCount(0);
    await page.getByRole("button", { name: "Expand memory update details" }).first().click();
    await expect(page.getByText("/workspaces/agents/gabriel--fixture/instructions/MEMORY.md", { exact: false })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /Memory update failed, Gabriel, Knowledge graph, expanded/ })).toBeVisible();
    await expect(page.getByText("Knowledge graph", { exact: false })).toBeVisible();
    await expect(page.getByText("permission denied", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("/workspaces/agents/gabriel--fixture/life/preferences.yml", { exact: false })).toHaveCount(1);
    await expect(page.getByText("Raw event", { exact: true })).toHaveCount(0);
    await expect(page.getByText("memory update failed:", { exact: false })).toHaveCount(0);

    await page.screenshot({
      path: "/tmp/rudder-run-transcript-detail-expanded.png",
      fullPage: true,
    });
  });

  test("merges transcript and invocation into one card with tabs on the real run detail page", async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1440, height: 1050 });
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
      {
        kind: "system",
        text: "file changes: update /Users/zeeland/.rudder/instances/e2e/organizations/org/workspaces/agents/transcript-tester--e2e/instructions/MEMORY.md",
      },
      {
        kind: "system",
        text: "memory update failed: update /Users/zeeland/.rudder/instances/e2e/organizations/org/workspaces/agents/transcript-tester--e2e/life/preferences.yml permission denied",
      },
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
      window.localStorage.setItem("rudder.theme", "dark");
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
    await expect(detailPane.getByText("Agent memory updated", { exact: false })).toBeVisible();
    await detailPane.getByRole("button", { name: "Expand memory update details" }).click();
    await expect(
      detailPane.getByText("/workspaces/agents/transcript-tester--e2e/instructions/MEMORY.md", {
        exact: false,
      }),
    ).toHaveCount(1);
    await expect(
      detailPane.getByText("/workspaces/agents/transcript-tester--e2e/life/preferences.yml", {
        exact: false,
      }),
    ).toHaveCount(1);
    await expect(detailPane.getByText("Failure", { exact: true })).toBeVisible();
    await expect(detailPane.getByText("permission denied", { exact: true }).first()).toBeVisible();
    await expect(detailPane.getByText("Raw event", { exact: true })).toHaveCount(0);
    await expect(detailPane.getByText("memory update failed:", { exact: false })).toHaveCount(0);
    await page.screenshot({
      path: "/tmp/rudder-run-transcript-detail-real-dark.png",
      fullPage: true,
    });

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
    await expect(detailPane.getByText("chat transcript entry", { exact: true })).toHaveCount(0);
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

  test("adds annotation-only feedback across runs while preserving the side panel and project lock", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1050 });
    const organization = await createOrganization(page, `Run-Annotation-${Date.now()}`);
    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Annotation Run Tester",
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
    const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Annotation Review Project",
        description: "Project context for run feedback.",
        status: "in_progress",
      },
    });
    expect(projectRes.ok()).toBe(true);
    const project = await projectRes.json() as { id: string };

    const runOneId = randomUUID();
    const runTwoId = randomUUID();
    const runOneStartedAt = new Date("2026-07-30T08:00:00.000Z");
    const runTwoStartedAt = new Date("2026-07-30T09:00:00.000Z");
    await e2eDb.insert(heartbeatRuns).values([
      {
        id: runOneId,
        orgId: organization.id,
        agentId: agent.id,
        invocationSource: "scheduled",
        triggerDetail: "Annotation run one",
        status: "succeeded",
        startedAt: runOneStartedAt,
        finishedAt: new Date(runOneStartedAt.getTime() + 60_000),
        createdAt: runOneStartedAt,
        updatedAt: new Date(runOneStartedAt.getTime() + 60_000),
      },
      {
        id: runTwoId,
        orgId: organization.id,
        agentId: agent.id,
        invocationSource: "scheduled",
        triggerDetail: "Annotation run two",
        status: "succeeded",
        startedAt: runTwoStartedAt,
        finishedAt: new Date(runTwoStartedAt.getTime() + 60_000),
        createdAt: runTwoStartedAt,
        updatedAt: new Date(runTwoStartedAt.getTime() + 60_000),
      },
    ]);
    await e2eDb.insert(heartbeatRunEvents).values([
      {
        orgId: organization.id,
        runId: runOneId,
        agentId: agent.id,
        seq: 1,
        eventType: "transcript.entry",
        stream: "system",
        level: "info",
        message: "chat transcript entry",
        payload: {
          kind: "assistant",
          text: "Run one completed the deployment review.",
          sourceEntryId: "run-one-assistant",
          ts: new Date(runOneStartedAt.getTime() + 30_000).toISOString(),
        },
        createdAt: new Date(runOneStartedAt.getTime() + 30_000),
      },
      {
        orgId: organization.id,
        runId: runOneId,
        agentId: agent.id,
        seq: 2,
        eventType: "transcript.entry",
        stream: "system",
        level: "info",
        message: "chat transcript thinking entry",
        payload: {
          kind: "thinking",
          text: "Reasoning checked the deployment diff.",
          sourceEntryId: "run-one-thinking",
          ts: new Date(runOneStartedAt.getTime() + 31_000).toISOString(),
        },
        createdAt: new Date(runOneStartedAt.getTime() + 31_000),
      },
      {
        orgId: organization.id,
        runId: runOneId,
        agentId: agent.id,
        seq: 3,
        eventType: "transcript.entry",
        stream: "system",
        level: "info",
        message: "chat transcript tool call entry",
        payload: {
          kind: "tool_call",
          name: "shell",
          input: { command: "pnpm test:run" },
          toolUseId: "run-one-tool",
          sourceEntryId: "run-one-tool-call",
          ts: new Date(runOneStartedAt.getTime() + 32_000).toISOString(),
        },
        createdAt: new Date(runOneStartedAt.getTime() + 32_000),
      },
      {
        orgId: organization.id,
        runId: runOneId,
        agentId: agent.id,
        seq: 4,
        eventType: "transcript.entry",
        stream: "system",
        level: "info",
        message: "chat transcript tool result entry",
        payload: {
          kind: "tool_result",
          toolUseId: "run-one-tool",
          toolName: "shell",
          content: "123 tests passed",
          isError: false,
          sourceEntryId: "run-one-tool-result",
          ts: new Date(runOneStartedAt.getTime() + 33_000).toISOString(),
        },
        createdAt: new Date(runOneStartedAt.getTime() + 33_000),
      },
      {
        orgId: organization.id,
        runId: runTwoId,
        agentId: agent.id,
        seq: 1,
        eventType: "transcript.entry",
        stream: "system",
        level: "info",
        message: "chat transcript entry",
        payload: {
          kind: "assistant",
          text: "Run two found a follow-up regression.",
          sourceEntryId: "run-two-assistant",
          ts: new Date(runTwoStartedAt.getTime() + 30_000).toISOString(),
        },
        createdAt: new Date(runTwoStartedAt.getTime() + 30_000),
      },
    ]);

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
      window.localStorage.setItem("rudder.theme", "dark");
    }, organization.id);
    await page.goto(`/agents/${agent.id}/runs/${runOneId}`, { waitUntil: "domcontentloaded" });

    const detailPane = page.getByTestId("agent-runs-detail-pane");
    await expect(detailPane.getByText("Run one completed the deployment review.", { exact: false })).toBeVisible({ timeout: 15_000 });
    const firstTrigger = detailPane.getByTestId("run-transcript-annotation-trigger").first();
    await firstTrigger.hover();
    await expect(firstTrigger).toHaveCSS("opacity", "1");
    await firstTrigger.click();

    const sidePanel = page.getByTestId("chat-side-panel");
    const annotationEditor = page.locator("[data-testid='chat-response-annotation-editor'][data-state='open']");
    await expect(annotationEditor).toBeVisible();
    await expect(sidePanel).toBeHidden();
    await annotationEditor.getByRole("textbox", { name: "Comment" }).fill("Review the completed transition.");
    await annotationEditor.getByRole("button", { name: "Save" }).click();
    const feedbackPanel = page.getByTestId("run-feedback-chat-panel");
    await expect(sidePanel).toBeVisible();
    await expect(feedbackPanel).toBeVisible();
    await expect(feedbackPanel.getByText("Run feedback", { exact: true })).toBeVisible();
    await expect.poll(() => page.locator("[data-testid='workspace-context-card']").evaluate((element) => (
      element.getBoundingClientRect().width
    ))).toBe(0);

    const projectSelector = feedbackPanel.getByRole("combobox", { name: "Project" });

    const thinkingBlock = detailPane.locator('[data-run-transcript-block-type="thinking"]');
    await expect(thinkingBlock.getByTestId("run-transcript-annotation-trigger")).toBeVisible();
    await thinkingBlock.getByTestId("run-transcript-annotation-trigger").click();
    await expect(annotationEditor).toBeVisible();
    await annotationEditor.getByRole("button", { name: "Cancel" }).click();
    await expect(feedbackPanel.getByRole("button", { name: /(?:Show|Hide) 1 annotation/ })).toBeVisible();
    const toolBlock = detailPane.locator('[data-run-transcript-block-type="tool"], [data-run-transcript-block-type="command_group"]');
    await expect(toolBlock.getByTestId("run-transcript-annotation-trigger")).toBeVisible();

    const selectableText = detailPane.getByText("Run one completed the deployment review.", { exact: false }).first();
    await selectableText.selectText();
    await page.evaluate(() => document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));
    const selectionToolbar = page.getByRole("toolbar", { name: "Response annotation actions" });
    await expect(selectionToolbar).toBeVisible();
    await selectionToolbar.getByRole("button", { name: "Add to chat" }).click();
    await expect(annotationEditor).toBeVisible();
    await annotationEditor.getByRole("textbox", { name: "Comment" }).fill("Keep this transcript excerpt.");
    await annotationEditor.getByRole("button", { name: "Save" }).click();
    await expect(feedbackPanel.getByRole("button", { name: /(?:Show|Hide) 2 annotations?/ })).toBeVisible();

    await projectSelector.selectOption(project.id);
    await expect(projectSelector).toHaveValue(project.id);

    const secondRunRow = page.locator('[role="link"][aria-label^="Open run"]').filter({ hasText: runTwoId.slice(0, 8) });
    await expect(secondRunRow).toBeVisible();
    await secondRunRow.click();
    // Agent detail routes canonicalize UUIDs to the stable agent ref slug.
    await expect(page).toHaveURL(new RegExp(`/agents/[^/]+/runs/${runTwoId}$`));
    await expect(detailPane.getByText("Run two found a follow-up regression.", { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(sidePanel).toBeVisible();
    await expect(projectSelector).toHaveValue(project.id);
    await expect(projectSelector).toBeEnabled();

    await detailPane.getByTestId("run-transcript-annotation-trigger").first().click();
    await expect(annotationEditor).toBeVisible();
    await annotationEditor.getByRole("button", { name: "Save" }).click();
    await expect(feedbackPanel.getByRole("button", { name: /(?:Show|Hide) 3 annotations?/ })).toBeVisible();
    await expect(feedbackPanel.getByText("Run two found a follow-up regression.", { exact: false })).toHaveCount(0);

    const sendFeedback = feedbackPanel.getByRole("button", { name: "Send feedback" });
    await expect(sendFeedback).toBeEnabled();
    const stopResponsePromise = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && response.url().includes("/messages/stream/stop")
    ));
    await sendFeedback.click();
    const stopFeedback = feedbackPanel.getByRole("button", { name: "Stop feedback" });
    await expect(stopFeedback).toBeVisible({ timeout: 15_000 });
    await stopFeedback.click();
    const stopResponse = await stopResponsePromise;
    expect(stopResponse.ok(), await stopResponse.text()).toBe(true);
    const stopRequest = stopResponse.request().postDataJSON() as Record<string, unknown>;
    expect(stopRequest.expectedGenerationId).toEqual(expect.any(String));
    expect(stopRequest.expectedAttemptEpoch).toEqual(expect.any(Number));
    expect(stopRequest.expectedControlVersion).toEqual(expect.any(Number));
    expect(stopRequest.lastCommittedRenderSeq).toEqual(expect.any(Number));
    expect(stopRequest.renderedBodyHash).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/));
    const stopPayload = await stopResponse.json() as { stopped?: boolean; disposition?: string };
    expect(
      stopPayload.stopped === true
      || ["stopping", "stop_requested", "stopped", "interrupted_unverified"].includes(stopPayload.disposition ?? ""),
    ).toBe(true);
    await expect.poll(async () => (
      await feedbackPanel.getByRole("button", { name: "Send feedback" }).count()
      + await feedbackPanel.getByRole("button", { name: "Stop status pending" }).count()
    ), { timeout: 15_000 }).toBeGreaterThan(0);
    await expect(feedbackPanel.getByText("Annotation-only feedback", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(projectSelector).toBeDisabled();

    let conversationId: string | null = null;
    await expect.poll(async () => {
      const response = await page.request.get(`/api/orgs/${organization.id}/chats?status=all&limit=100`);
      if (!response.ok()) return null;
      const candidates = await response.json() as Array<{ id: string; preferredAgentId?: string | null }>;
      conversationId = candidates.find((chat) => chat.preferredAgentId === agent.id)?.id ?? null;
      return conversationId;
    }, { timeout: 30_000 }).toBeTruthy();
    expect(conversationId).toBeTruthy();
    const persistedFeedbackTarget = await page.evaluate(({ orgId, agentId }) => {
      const raw = window.localStorage.getItem(`rudder.run-feedback-draft:${orgId}:${agentId}`);
      return raw ? JSON.parse(raw) as {
        conversationId?: string | null;
        projectId?: string | null;
        projectLocked?: boolean;
      } : null;
    }, { orgId: organization.id, agentId: agent.id });
    expect(persistedFeedbackTarget).toEqual(expect.objectContaining({
      conversationId,
      projectId: project.id,
      projectLocked: true,
    }));
    const messagesResponse = await page.request.get(`/api/chats/${conversationId}/messages?orgId=${organization.id}`);
    expect(messagesResponse.ok()).toBe(true);
    const messages = await messagesResponse.json() as Array<{
      role: string;
      body: string;
      structuredPayload?: {
        inlineAnnotations?: Array<{
          sourceRunId?: string;
          anchorKind?: string;
          selectedText?: string;
          comment?: string | null;
        }>;
      } | null;
    }>;
    const firstUserMessage = messages.find((message) => message.role === "user");
    expect(firstUserMessage?.body).toBe("");
    expect(firstUserMessage?.structuredPayload?.inlineAnnotations).toHaveLength(3);
    expect(firstUserMessage?.structuredPayload?.inlineAnnotations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceRunId: runOneId,
        anchorKind: "transition",
        selectedText: "Run one completed the deployment review.",
        comment: "Review the completed transition.",
      }),
      expect.objectContaining({
        sourceRunId: runOneId,
        anchorKind: "text",
        selectedText: "Run one completed the deployment review.",
        comment: "Keep this transcript excerpt.",
      }),
      expect.objectContaining({
        sourceRunId: runTwoId,
        anchorKind: "transition",
        selectedText: "Run two found a follow-up regression.",
      }),
    ]));

    await expect(feedbackPanel.getByText("Annotation-only feedback", { exact: true })).toBeVisible();
    await expect(projectSelector).toBeDisabled();
    await sidePanel.getByTestId("chat-side-panel-collapse").click();
    await expect(sidePanel).toBeHidden();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("agent-runs-detail-pane").getByText("Run two found a follow-up regression.", { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(sidePanel).toBeHidden();

    const reloadedDetailPane = page.getByTestId("agent-runs-detail-pane");
    await reloadedDetailPane.getByTestId("run-transcript-annotation-trigger").first().click();
    await expect(annotationEditor).toBeVisible();
    await annotationEditor.getByRole("button", { name: "Save" }).click();
    await expect(feedbackPanel.getByRole("button", { name: /(?:Show|Hide) 1 annotation/ })).toBeVisible();
    await expect(feedbackPanel.getByText("Annotation-only feedback", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(feedbackPanel.getByText("late output", { exact: false })).toHaveCount(0);
    await expect(feedbackPanel.getByText("late final", { exact: false })).toHaveCount(0);
    await expect(projectSelector).toBeDisabled();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(sidePanel).toBeVisible();
    await expect.poll(async () => {
      const box = await sidePanel.boundingBox();
      return Boolean(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844);
    }, { timeout: 3_000 }).toBe(true);
    const mobilePanelBox = await sidePanel.boundingBox();
    expect(mobilePanelBox).not.toBeNull();
    expect(mobilePanelBox!.x).toBeGreaterThanOrEqual(0);
    expect(mobilePanelBox!.y).toBeGreaterThanOrEqual(0);
    expect(mobilePanelBox!.x + mobilePanelBox!.width).toBeLessThanOrEqual(390);
    expect(mobilePanelBox!.y + mobilePanelBox!.height).toBeLessThanOrEqual(844);
    await page.screenshot({
      path: "/tmp/rudder-agent-run-feedback-mobile.png",
      fullPage: true,
    });
  });

  test("loads a complete conversation transcript across multiple event pages", async ({ page }) => {
    const organization = await createOrganization(page, `Run-Detail-Long-Conversation-${Date.now()}`);

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Long Conversation Transcript Tester",
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
    const conversationId = randomUUID();
    const createdAt = new Date("2026-07-26T08:00:00.000Z");
    await e2eDb.insert(chatConversations).values({
      id: conversationId,
      orgId: organization.id,
      title: "Long conversation transcript",
      preferredAgentId: agent.id,
      routedAgentId: agent.id,
      createdAt,
      updatedAt: createdAt,
    });
    await e2eDb.insert(heartbeatRuns).values({
      id: runId,
      orgId: organization.id,
      agentId: agent.id,
      invocationSource: "chat",
      triggerDetail: "chat_assistant_reply_stream",
      status: "succeeded",
      startedAt: createdAt,
      finishedAt: new Date(createdAt.getTime() + 60_000),
      contextSnapshot: {
        scene: "chat",
        targetType: "chat_conversation",
        conversationId,
        messageId: randomUUID(),
      },
      createdAt,
      updatedAt: new Date(createdAt.getTime() + 60_000),
    });

    const transcriptEntries = Array.from({ length: 1_205 }, (_, index) => ({
      orgId: organization.id,
      runId,
      agentId: agent.id,
      seq: index + 1,
      eventType: "transcript.entry",
      stream: "system" as const,
      level: "info" as const,
      message: "chat transcript entry",
      payload: {
        kind: index === 0 || index === 1_204 ? "assistant" : "system",
        text: index === 0 || index === 1_204
          ? `Conversation transcript marker ${index + 1}`
          : "reasoning started",
        ts: new Date(createdAt.getTime() + index).toISOString(),
      },
      createdAt: new Date(createdAt.getTime() + index),
    }));
    await e2eDb.insert(heartbeatRunEvents).values(transcriptEntries);

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
      window.localStorage.setItem("rudder.theme", "dark");
    }, organization.id);

    await page.goto(`/agents/${agent.id}/runs/${runId}`, { waitUntil: "domcontentloaded" });

    const detailPane = page.getByTestId("agent-runs-detail-pane");
    await expect(detailPane.getByText("1205 entries", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(detailPane).toContainText("Conversation transcript marker 1");
    await expect(detailPane).toContainText("Conversation transcript marker 1205");

    await page.screenshot({
      path: "/tmp/rudder-agent-run-complete-conversation-transcript.png",
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
    await e2eDb.insert(heartbeatRunEvents).values({
      orgId: organization.id,
      runId,
      agentId: agent.id,
      seq: 100,
      eventType: "transcript.entry",
      stream: "system",
      level: "info",
      message: "chat transcript entry",
      payload: {
        kind: "assistant",
        text: "Partial assistant output preserved before the recoverable failure.",
        ts: "2026-06-26T06:16:30.946Z",
      },
      createdAt: new Date("2026-06-26T06:16:30.946Z"),
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
    await expect(detailPane.getByText("Transcript", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(detailPane.getByRole("button", { name: "Raw" })).toBeVisible();
    await expect(detailPane.getByText("Failure details", { exact: true })).toHaveCount(0);

    const listPane = page.getByTestId("agent-runs-list-pane");
    await expect(listPane.getByText("The run hit a system-level execution problem.", { exact: false })).toBeVisible();
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
