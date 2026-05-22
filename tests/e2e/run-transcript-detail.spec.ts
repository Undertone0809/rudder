import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createDb, heartbeatRuns } from "../../packages/db/src/index.ts";
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

test.describe("Run transcript detail", () => {
  test("renders detail transcripts as readable progress chunks with collapsed grouped tool activity", async ({ page }) => {
    const organization = await createOrganization(page, `Run-Detail-${Date.now()}`);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/tests/ux/runs");

    await expect(page.getByRole("heading", { name: "Run Detail" })).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: "Show settled state" }).click();
    await expect(page.getByRole("button", { name: "Show streaming state" })).toBeVisible({ timeout: 15_000 });

    const firstProgressChunk = page.getByRole("button", { name: /Expand tool activity group 1/ }).filter({ hasText: "Explored 2 files" });
    await expect(firstProgressChunk).toHaveCount(1);
    await expect(page.getByText("Model turn", { exact: false })).toHaveCount(0);
    await expect(page.getByText("Read", { exact: true })).toHaveCount(0);
    await expect(page.getByText("doc/GOAL.md", { exact: true })).toHaveCount(0);
    await expect(page.getByText("doc/SPEC-implementation.md", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Marked PAP-473 done", { exact: false })).toBeVisible();
    await expect(page.getByText("added review summary comment", { exact: false })).toBeVisible();
    await expect(page.getByText("Ran rudder issue done", { exact: false })).toHaveCount(0);

    await firstProgressChunk.click();
    await expect(page.getByText("Read doc/GOAL.md", { exact: false })).toBeVisible();
    await expect(page.getByText("Read doc/SPEC-implementation.md", { exact: false })).toBeVisible();

    const externalToolGroup = page.getByRole("button", { name: /Expand tool activity group 2/ }).filter({ hasText: "2 searches, used 1 tool" });
    await expect(externalToolGroup).toHaveCount(1);
    await externalToolGroup.click();
    await expect(page.getByText("Web searched \"transcript UI rendering examples\"", { exact: false })).toBeVisible();
    await expect(page.getByText("Called fetch_pr via github", { exact: false })).toBeVisible();
    await expect(page.getByText("repo_full_name Undertone0809/rudder", { exact: false })).toBeVisible();

    const skillUseRow = page.getByRole("button", { name: /Expand tool details/ }).filter({ hasText: "Use flomo-local-api skill" });
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
    await expect(page.getByRole("button", { name: /Memory update failed, Failed/ })).toBeVisible();
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

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/agents/${agent.id}/runs/${run.id}`);

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
    expect(detailBox!.x).toBeLessThan(listBox!.x);
    await expect(transcriptTab).toHaveAttribute("data-state", "active");
    await expect(page.getByRole("button", { name: "nice" })).toBeVisible();
    await expect(page.getByText("adapter invocation")).toBeVisible();

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
    await expect(transcriptDialog.getByText("adapter invocation")).toBeVisible();
    await expect(transcriptDialog.getByRole("button", { name: "raw" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(transcriptDialog).toBeHidden();

    await invocationTab.click();
    await expect(invocationTab).toHaveAttribute("data-state", "active");
    await expect(page.getByText("Exact adapter invoke payload")).toHaveClass(/invisible/);
    await expect(page.getByText("Runtime:", { exact: false })).toBeVisible();
    await expect(page.getByText("Command:", { exact: false })).toBeVisible();
    await expect(page.getByText(/^Events \(\d+\)$/)).toBeVisible();
    await expect(page.getByText("adapter invocation")).toBeVisible();
    await expect(page.getByRole("button", { name: "nice" })).toBeHidden();

    const promptBlock = page.getByTestId("invocation-prompt");
    await expect(promptBlock).toBeVisible();
    const promptText = await promptBlock.textContent();
    expect(promptText?.trim()).toBeTruthy();

    if (baseURL) {
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
    }
    await page.getByRole("button", { name: "Copy invocation prompt" }).click();
    await expect
      .poll(async () => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(promptText);

    await invocationTab.hover();
    await expect(page.getByText("Exact adapter invoke payload")).toBeVisible();

    await transcriptTab.click();
    await expect(transcriptTab).toHaveAttribute("data-state", "active");
    await expect(page.getByRole("button", { name: "nice" })).toBeVisible();

    await page.screenshot({
      path: "tests/e2e/test-results/agent-run-detail-tabs.png",
      fullPage: true,
    });
  });

  test("keeps long stderr excerpts inside the run detail pane", async ({ page }) => {
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
    const listPane = page.getByTestId("agent-runs-list-pane");
    const stderrExcerpt = detailPane.getByTestId("run-stderr-excerpt");
    await expect(stderrExcerpt).toBeVisible({ timeout: 15_000 });

    const detailBox = await detailPane.boundingBox();
    const listBox = await listPane.boundingBox();
    const stderrBox = await stderrExcerpt.boundingBox();
    expect(detailBox).not.toBeNull();
    expect(listBox).not.toBeNull();
    expect(stderrBox).not.toBeNull();
    expect(stderrBox!.x).toBeGreaterThanOrEqual(detailBox!.x);
    expect(stderrBox!.x + stderrBox!.width).toBeLessThanOrEqual(detailBox!.x + detailBox!.width + 1);
    expect(stderrBox!.x + stderrBox!.width).toBeLessThan(listBox!.x);

    await page.screenshot({
      path: "/tmp/rudder-agent-run-stderr-contained.png",
      fullPage: true,
    });
  });

  test("only promotes stderr excerpts for failure-status run detail pages", async ({ page }) => {
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
    await expect(timedOutDetailPane.getByTestId("run-stderr-excerpt")).toBeVisible();

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
});
