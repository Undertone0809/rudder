import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq } from "../../packages/db/node_modules/drizzle-orm/index.js";
import { createDb, heartbeatRunEvents, heartbeatRuns, issues } from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

test.describe("Agent dashboard one-day view", () => {
  test("switches the four activity cards and skill usage to pie distributions", async ({ page, request }, testInfo) => {
    const orgRes = await request.post("/api/orgs", {
      data: { name: `Agent-One-Day-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const agentRes = await request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "One Day Analyst",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { model: "gpt-5.4" },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    const issueIds: string[] = [];
    for (const issue of [
      { title: "Today high-priority work", status: "in_progress", priority: "high" },
      { title: "Today completed work", status: "done", priority: "low" },
    ]) {
      const issueRes = await request.post(`/api/orgs/${organization.id}/issues`, {
        data: { ...issue, assigneeAgentId: agent.id },
      });
      expect(issueRes.ok()).toBe(true);
      issueIds.push(((await issueRes.json()) as { id: string }).id);
    }

    const now = new Date();
    for (const [index, issueId] of issueIds.entries()) {
      const createdAt = new Date(now.getTime() - (30 - index) * 60_000);
      await e2eDb.update(issues).set({ createdAt, updatedAt: createdAt }).where(eq(issues.id, issueId));
    }
    const succeededRunId = randomUUID();
    const failedRunId = randomUUID();
    await e2eDb.insert(heartbeatRuns).values([
      {
        id: succeededRunId,
        orgId: organization.id,
        agentId: agent.id,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "succeeded",
        contextSnapshot: { wakeReason: "issue_assigned" },
        createdAt: new Date(now.getTime() - 20 * 60_000),
        updatedAt: new Date(now.getTime() - 15 * 60_000),
      },
      {
        id: failedRunId,
        orgId: organization.id,
        agentId: agent.id,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "failed",
        contextSnapshot: { wakeReason: "automation" },
        createdAt: new Date(now.getTime() - 10 * 60_000),
        updatedAt: new Date(now.getTime() - 5 * 60_000),
      },
    ]);
    await e2eDb.insert(heartbeatRunEvents).values([
      {
        orgId: organization.id,
        runId: succeededRunId,
        agentId: agent.id,
        seq: 1,
        eventType: "adapter.skill_usage",
        stream: "system",
        level: "info",
        message: "skill usage inferred from transcript",
        payload: {
          source: "transcript.skill_file_read",
          usedSkills: [
            { key: "rudder-docs", label: "rudder-docs" },
            { key: "browser", label: "browser" },
          ],
        },
        createdAt: new Date(now.getTime() - 19 * 60_000),
      },
      {
        orgId: organization.id,
        runId: failedRunId,
        agentId: agent.id,
        seq: 1,
        eventType: "adapter.skill_usage",
        stream: "system",
        level: "info",
        message: "skill usage inferred from transcript",
        payload: {
          source: "transcript.skill_file_read",
          usedSkills: [{ key: "browser", label: "browser" }],
        },
        createdAt: new Date(now.getTime() - 9 * 60_000),
      },
    ]);

    const costRes = await request.post(`/api/orgs/${organization.id}/cost-events`, {
      data: {
        agentId: agent.id,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5.4",
        inputTokens: 1_000,
        cachedInputTokens: 600,
        outputTokens: 200,
        costCents: 12,
        occurredAt: new Date(now.getTime() - 8 * 60_000).toISOString(),
      },
    });
    expect(costRes.ok()).toBe(true);

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/dashboard`, {
      waitUntil: "domcontentloaded",
    });

    const mainContent = page.locator("#main-content");
    await mainContent.getByRole("button", { name: "1D" }).click();

    await expect(mainContent.getByText("Today · run outcome distribution")).toBeVisible();
    await expect(mainContent.getByText("Today · priority distribution")).toBeVisible();
    await expect(mainContent.getByText("Today · status distribution")).toBeVisible();
    await expect(mainContent.getByText("Today · token type distribution")).toBeVisible();
    await expect(mainContent.locator('[data-testid="run-activity-pie-chart"]')).toBeVisible();
    await expect(mainContent.locator('[data-testid="issue-priority-pie-chart"]')).toBeVisible();
    await expect(mainContent.locator('[data-testid="issue-status-pie-chart"]')).toBeVisible();
    await expect(mainContent.locator('[data-testid="token-usage-pie-chart"]')).toBeVisible();
    await expect(mainContent.locator('[data-testid="skills-usage-pie-chart"]')).toBeVisible();
    await expect(mainContent.getByText("Skill usage distribution for today.")).toBeVisible();
    await expect(mainContent.getByText("browser")).toBeVisible();
    await expect(mainContent.getByText("rudder-docs")).toBeVisible();
    await mainContent.screenshot({
      path: testInfo.outputPath("agent-dashboard-one-day-desktop.png"),
      animations: "disabled",
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await mainContent.getByRole("button", { name: "1D" }).click();
    await expect(mainContent.locator('[data-testid="run-activity-pie-chart"]')).toBeVisible();
    await expect(mainContent.locator('[data-testid="skills-usage-pie-chart"]')).toBeVisible();
    const horizontalOverflow = await mainContent.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(horizontalOverflow).toBeLessThanOrEqual(1);
    await mainContent.screenshot({
      path: testInfo.outputPath("agent-dashboard-one-day-narrow.png"),
      animations: "disabled",
    });

    await mainContent.getByRole("button", { name: "7D" }).click();
    await expect(mainContent.locator('[data-testid="run-activity-pie-chart"]')).toHaveCount(0);
    await expect(mainContent.locator('[data-testid="skills-usage-area-chart"]')).toBeVisible();
  });
});
