import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createDb, heartbeatRunEvents, heartbeatRuns } from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

function makeUtcDate(daysAgo: number, hour: number, minute = 0): Date {
  const now = new Date();
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - daysAgo,
    hour,
    minute,
    0,
    0,
  ));
}

function utcDateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function formatDayTitle(dateKey: string): string {
  return new Date(`${dateKey}T12:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test.describe("Agent dashboard skills analytics", () => {
  test("shows a 7-day loaded-skills chart when all recent activity is within the last week", async ({ page, request }, testInfo) => {
    const orgRes = await request.post("/api/orgs", {
      data: {
        name: `Agent-Skills-Analytics-${Date.now()}`,
        defaultChatAgentRuntimeType: "codex_local",
        defaultChatAgentRuntimeConfig: {
          model: "gpt-5.4",
        },
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as {
      id: string;
      issuePrefix: string;
    };

    const agentRes = await request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Penelope",
        role: "ceo",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    const runOneId = randomUUID();
    const runTwoId = randomUUID();
    const runThreeId = randomUUID();
    const recentMorning = makeUtcDate(2, 8);
    const recentAfternoon = makeUtcDate(2, 16);
    const earlierRecent = makeUtcDate(4, 10);
    const recentDateKey = utcDateKey(recentMorning);

    await e2eDb.insert(heartbeatRuns).values([
      {
        id: runOneId,
        orgId: organization.id,
        agentId: agent.id,
        invocationSource: "on_demand",
        status: "succeeded",
        createdAt: recentMorning,
        updatedAt: new Date(recentMorning.getTime() + 5 * 60 * 1000),
      },
      {
        id: runTwoId,
        orgId: organization.id,
        agentId: agent.id,
        invocationSource: "on_demand",
        status: "succeeded",
        createdAt: recentAfternoon,
        updatedAt: new Date(recentAfternoon.getTime() + 5 * 60 * 1000),
      },
      {
        id: runThreeId,
        orgId: organization.id,
        agentId: agent.id,
        invocationSource: "on_demand",
        status: "succeeded",
        createdAt: earlierRecent,
        updatedAt: new Date(earlierRecent.getTime() + 5 * 60 * 1000),
      },
    ]);

    await e2eDb.insert(heartbeatRunEvents).values([
      {
        orgId: organization.id,
        runId: runOneId,
        agentId: agent.id,
        seq: 1,
        eventType: "adapter.invoke",
        stream: "system",
        level: "info",
        message: "adapter invocation",
        payload: {
          loadedSkills: [
            { key: "rudder/build-advisor", runtimeName: "build-advisor", name: "Build Advisor" },
            { key: "screenshot", runtimeName: "screenshot", name: "Screenshot" },
          ],
        },
        createdAt: new Date(recentMorning.getTime() + 5 * 1000),
      },
      {
        orgId: organization.id,
        runId: runTwoId,
        agentId: agent.id,
        seq: 1,
        eventType: "adapter.invoke",
        stream: "system",
        level: "info",
        message: "adapter invocation",
        payload: {
          loadedSkills: [
            { key: "rudder/build-advisor", runtimeName: "build-advisor", name: "Build Advisor" },
            { key: "pua", runtimeName: "pua", name: "PUA" },
          ],
        },
        createdAt: new Date(recentAfternoon.getTime() + 5 * 1000),
      },
      {
        orgId: organization.id,
        runId: runThreeId,
        agentId: agent.id,
        seq: 1,
        eventType: "adapter.invoke",
        stream: "system",
        level: "info",
        message: "adapter invocation",
        payload: {
          loadedSkills: [
            { key: "screenshot", runtimeName: "screenshot", name: "Screenshot" },
          ],
        },
        createdAt: new Date(earlierRecent.getTime() + 5 * 1000),
      },
    ]);

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/dashboard`, {
      waitUntil: "domcontentloaded",
    });

    const mainContent = page.locator("#main-content");
    await expect(mainContent.getByRole("heading", { name: "Penelope", exact: true })).toBeVisible();
    await expect(mainContent.locator("h3").filter({ hasText: "Skills" })).toBeVisible();
    await expect(page.getByRole("button", { name: "7D" })).toBeVisible();
    await expect(page.getByRole("button", { name: "15D" })).toBeVisible();
    await expect(page.getByRole("button", { name: "1M" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Custom/ })).toBeVisible();
    await expect(mainContent.getByText("Loaded skills per run for Last 7 days. Hover a day to inspect the breakdown.")).toBeVisible();
    await expect(mainContent.getByText("5 skill loads")).toBeVisible();
    await expect(mainContent.getByText("3 runs with skill metadata")).toBeVisible();
    await expect(mainContent.getByText("Skill Distribution")).toBeVisible();
    await expect(mainContent.getByText("Skill Usage Timeline")).toBeVisible();
    const distributionPie = mainContent.getByRole("button", { name: /Skill distribution: 5 skill loads across 3 skills/ });
    await expect(distributionPie).toBeVisible();
    await distributionPie.hover();
    await expect(page.getByText("Skill distribution")).toBeVisible();
    await expect(page.getByText("5 skill loads across 3 runs")).toBeVisible();

    const recentDayColumn = mainContent.getByLabel(new RegExp(`${escapeRegExp(formatDayTitle(recentDateKey))}: 4 skill loads across 2 runs`));
    await expect(recentDayColumn).toBeVisible();
    await recentDayColumn.hover();

    await expect(page.getByText("Skill loads")).toBeVisible();
    await expect(page.getByText("Runs with skills")).toBeVisible();
    await expect(page.getByText("build-advisor")).toBeVisible();
    await expect(page.getByText("screenshot")).toBeVisible();
    await expect(page.getByText("pua")).toBeVisible();

    await mainContent.screenshot({
      path: testInfo.outputPath("agent-dashboard-skills-analytics.png"),
      animations: "disabled",
    });
  });

  test("hides the skills section for a new agent without skill metadata", async ({ page, request }) => {
    const orgRes = await request.post("/api/orgs", {
      data: {
        name: `Agent-Skills-Hidden-${Date.now()}`,
        defaultChatAgentRuntimeType: "codex_local",
        defaultChatAgentRuntimeConfig: {
          model: "gpt-5.4",
        },
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as {
      id: string;
      issuePrefix: string;
    };

    const agentRes = await request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "New Agent",
        role: "ceo",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/dashboard`, {
      waitUntil: "domcontentloaded",
    });

    const mainContent = page.locator("#main-content");
    await expect(mainContent.getByRole("heading", { name: "New Agent", exact: true })).toBeVisible();
    await expect(mainContent.locator("h3").filter({ hasText: "Skills" })).toHaveCount(0);
    await expect(mainContent.getByText(/skill metadata/i)).toHaveCount(0);
  });
});
