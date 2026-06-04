import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createDb, heartbeatRunEvents, heartbeatRuns } from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

function formatDateTimeLocal(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const hours = String(value.getHours()).padStart(2, "0");
  const minutes = String(value.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

test.describe("Agent runs filter menu", () => {
  test("opens a floating filter menu and preserves the selected run when filters exclude it", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Agent-Runs-Filter-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string };

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Run Filter Operator",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { model: "gpt-5.4" },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    const selectedRunId = randomUUID();
    const failedRunId = randomUUID();
    const newestShortRunId = randomUUID();
    await e2eDb.insert(heartbeatRuns).values([
      {
        id: selectedRunId,
        orgId: organization.id,
        agentId: agent.id,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "succeeded",
        startedAt: new Date("2026-05-22T08:00:00.000Z"),
        finishedAt: new Date("2026-05-22T08:03:00.000Z"),
        usageJson: {
          inputTokens: 10_000,
          outputTokens: 1_000,
        },
        stdoutExcerpt: "Selected run should stay open",
        resultJson: { summary: "Selected run should stay open" },
        createdAt: new Date("2026-05-22T08:00:00.000Z"),
        updatedAt: new Date("2026-05-22T08:03:00.000Z"),
      },
      {
        id: failedRunId,
        orgId: organization.id,
        agentId: agent.id,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "failed",
        startedAt: new Date("2026-05-23T09:00:00.000Z"),
        finishedAt: new Date("2026-05-23T09:45:00.000Z"),
        error: "Process lost",
        errorCode: "process_lost",
        retryOfRunId: selectedRunId,
        usageJson: {
          inputTokens: 450_000,
          cachedInputTokens: 75_000,
          outputTokens: 30_000,
        },
        resultJson: { summary: "Process lost on launch" },
        contextSnapshot: {
          issueId: "issue-filter-e2e",
          recovery: { failureKind: "process_lost" },
        },
        createdAt: new Date("2026-05-23T09:00:00.000Z"),
        updatedAt: new Date("2026-05-23T09:45:00.000Z"),
      },
      {
        id: newestShortRunId,
        orgId: organization.id,
        agentId: agent.id,
        invocationSource: "timer",
        triggerDetail: "system",
        status: "succeeded",
        startedAt: new Date("2026-05-24T10:00:00.000Z"),
        finishedAt: new Date("2026-05-24T10:01:00.000Z"),
        usageJson: {
          inputTokens: 2_000,
          outputTokens: 200,
        },
        stdoutExcerpt: "Newest short run",
        resultJson: { summary: "Newest short run" },
        contextSnapshot: {
          wakeReason: "heartbeat_timer",
        },
        createdAt: new Date("2026-05-24T10:00:00.000Z"),
        updatedAt: new Date("2026-05-24T10:01:00.000Z"),
      },
    ]);
    await e2eDb.insert(heartbeatRunEvents).values({
      orgId: organization.id,
      agentId: agent.id,
      runId: failedRunId,
      seq: 1,
      eventType: "adapter.skill_usage",
      stream: "system",
      level: "info",
      message: "skill usage inferred from transcript",
      payload: {
        usedSkillCount: 1,
        usedSkillKeys: ["build-advisor"],
        usedSkills: [{ key: "build-advisor", runtimeName: "build-advisor", name: "Build Advisor" }],
        skillEvidenceType: "used",
        skillEvidenceCount: 1,
        skillEvidenceKeys: ["build-advisor"],
        skillEvidenceSkills: [{ key: "build-advisor", runtimeName: "build-advisor", name: "Build Advisor" }],
      },
      createdAt: new Date("2026-05-23T09:30:00.000Z"),
    });

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/agents/${agent.id}/runs/${selectedRunId}`, { waitUntil: "domcontentloaded" });

    const mainContent = page.locator("#main-content");
    await expect(mainContent.getByTestId("run-filter-floating-toolbar")).toBeVisible();
    await expect(mainContent.getByTestId("agent-runs-detail-pane").getByText("Selected run should stay open")).toBeVisible();

    const listPane = mainContent.getByTestId("agent-runs-list-pane");
    await expect(listPane.getByRole("link").first()).toContainText(newestShortRunId.slice(0, 8));

    await mainContent.getByRole("button", { name: "Sort runs: Newest" }).click();
    const sortPopover = page.getByTestId("run-sort-popover");
    await expect(sortPopover).toBeVisible();
    await expect(sortPopover.getByRole("menuitemradio", { name: "Created ↓" })).toBeVisible();
    await sortPopover.getByRole("menuitemradio", { name: "Duration" }).click();
    await expect(page).toHaveURL(/runSort=duration_asc/);
    await expect(sortPopover.getByRole("menuitemradio", { name: "Duration ↑" })).toBeVisible();
    await expect(listPane.getByRole("link").first()).toContainText(newestShortRunId.slice(0, 8));
    await sortPopover.getByRole("menuitemradio", { name: "Duration ↑" }).click();
    await expect(page).toHaveURL(/runSort=duration_desc/);
    await expect(sortPopover.getByRole("menuitemradio", { name: "Duration ↓" })).toBeVisible();
    await expect(listPane.getByRole("link").first()).toContainText(failedRunId.slice(0, 8));

    await mainContent.getByRole("button", { name: "Filter" }).click();
    const popover = page.getByTestId("run-filter-popover");
    await expect(popover).toBeVisible();
    await expect(popover.getByText("Filter runs")).toBeVisible();

    await popover.getByText("Failed").click();
    await expect(page).toHaveURL(/runStatus=failed/);
    await expect(popover.getByText("Used skill")).toBeVisible();
    await popover.getByRole("button", { name: /build-advisor/ }).click();
    await expect(page).toHaveURL(/runSkill=build-advisor/);

    await expect(listPane.getByText("Selected run is outside the current filters.")).toBeVisible();
    await expect(listPane.getByText(failedRunId.slice(0, 8))).toBeVisible();
    await expect(mainContent.getByTestId("agent-runs-detail-pane").getByText("Selected run should stay open")).toBeVisible();

    await mainContent.getByRole("button", { name: "Clear run filters" }).click();
    await expect(page).not.toHaveURL(/runStatus=failed/);
    await expect(page).not.toHaveURL(/runSkill=build-advisor/);

    await mainContent.getByRole("button", { name: "Filter" }).click();
    const customPopover = page.getByTestId("run-filter-popover");
    await expect(customPopover).toBeVisible();
    await customPopover.getByRole("button", { name: "Custom" }).click();
    const customFrom = formatDateTimeLocal(new Date("2026-05-23T08:30:00.000Z"));
    const customTo = formatDateTimeLocal(new Date("2026-05-23T09:30:00.000Z"));
    await customPopover.getByLabel("Custom run start time").fill(customFrom);
    await customPopover.getByLabel("Custom run end time").fill(customTo);
    await expect(page).toHaveURL(/runDate=custom/);
    await expect(page).toHaveURL(new RegExp(`runFrom=${encodeURIComponent(customFrom)}`));
    await expect(page).toHaveURL(new RegExp(`runTo=${encodeURIComponent(customTo)}`));
    await expect(listPane.getByText(failedRunId.slice(0, 8))).toBeVisible();
    await expect(listPane.getByText(newestShortRunId.slice(0, 8))).toHaveCount(0);
    await expect(listPane.getByText("Selected run is outside the current filters.")).toBeVisible();
    await expect(mainContent.getByText(/Custom:/)).toBeVisible();
  });
});
