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
  test("shows a 7-day used-skills chart when all recent activity is within the last week", async ({ page, request }, testInfo) => {
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
          prompt: "Use [$build-advisor](/workspace/.agents/skills/build-advisor/SKILL.md) and [$screenshot](/workspace/.agents/skills/screenshot/SKILL.md)",
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
          prompt: "Use [$build-advisor](/workspace/.agents/skills/build-advisor/SKILL.md) and [$pua](/workspace/.agents/skills/pua/SKILL.md)",
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
          prompt: "Use [$screenshot](/workspace/.agents/skills/screenshot/SKILL.md)",
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
    await expect(mainContent.getByText("Explicitly used skills per run for Last 7 days. Hover a day to inspect the breakdown.")).toBeVisible();
    await expect(mainContent.getByText("5 skill uses")).toBeVisible();
    await expect(mainContent.getByText("3 runs with skill use")).toBeVisible();
    await expect(mainContent.getByText("Skill Use Distribution")).toBeVisible();
    await expect(mainContent.getByText("Skill Use Timeline")).toBeVisible();
    const distributionPie = mainContent.getByRole("button", { name: /Skill use distribution: 5 skill uses across 3 skills/ });
    await expect(distributionPie).toBeVisible();
    await distributionPie.hover();
    await expect(page.getByText("Skill use distribution")).toBeVisible();
    await expect(page.getByText("5 skill uses across 3 runs")).toBeVisible();

    const recentDayColumn = mainContent.getByLabel(new RegExp(`${escapeRegExp(formatDayTitle(recentDateKey))}: 4 skill uses across 2 runs`));
    await expect(recentDayColumn).toBeVisible();
    await recentDayColumn.hover();

    await expect(page.getByText("Skill uses")).toBeVisible();
    await expect(page.getByText("Runs with skills")).toBeVisible();
    await expect(page.getByText("build-advisor")).toBeVisible();
    await expect(page.getByText("screenshot")).toBeVisible();
    await expect(page.getByText("pua")).toBeVisible();

    await mainContent.screenshot({
      path: testInfo.outputPath("agent-dashboard-skills-analytics.png"),
      animations: "disabled",
    });
  });

  test("shows organization-wide used-skills analytics on the dashboard", async ({ page, request }, testInfo) => {
    const orgRes = await request.post("/api/orgs", {
      data: {
        name: `Dashboard-Skills-Analytics-${Date.now()}`,
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

    const firstAgentRes = await request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Penelope",
        role: "ceo",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
        },
      },
    });
    expect(firstAgentRes.ok()).toBe(true);
    const firstAgent = await firstAgentRes.json() as { id: string };

    const secondAgentRes = await request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Blake",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
        },
      },
    });
    expect(secondAgentRes.ok()).toBe(true);
    const secondAgent = await secondAgentRes.json() as { id: string };

    const firstRunId = randomUUID();
    const secondRunId = randomUUID();
    const firstRunAt = makeUtcDate(1, 8);
    const secondRunAt = makeUtcDate(1, 14);
    const recentDateKey = utcDateKey(firstRunAt);

    await e2eDb.insert(heartbeatRuns).values([
      {
        id: firstRunId,
        orgId: organization.id,
        agentId: firstAgent.id,
        invocationSource: "on_demand",
        status: "succeeded",
        createdAt: firstRunAt,
        updatedAt: new Date(firstRunAt.getTime() + 5 * 60 * 1000),
      },
      {
        id: secondRunId,
        orgId: organization.id,
        agentId: secondAgent.id,
        invocationSource: "on_demand",
        status: "succeeded",
        createdAt: secondRunAt,
        updatedAt: new Date(secondRunAt.getTime() + 5 * 60 * 1000),
      },
    ]);

    await e2eDb.insert(heartbeatRunEvents).values([
      {
        orgId: organization.id,
        runId: firstRunId,
        agentId: firstAgent.id,
        seq: 1,
        eventType: "adapter.invoke",
        stream: "system",
        level: "info",
        message: "adapter invocation",
        payload: {
          prompt: "Use [$build-advisor](/workspace/.agents/skills/build-advisor/SKILL.md) and [$screenshot](/workspace/.agents/skills/screenshot/SKILL.md)",
          loadedSkills: [
            { key: "rudder/build-advisor", runtimeName: "build-advisor", name: "Build Advisor" },
            { key: "screenshot", runtimeName: "screenshot", name: "Screenshot" },
          ],
        },
        createdAt: new Date(firstRunAt.getTime() + 5 * 1000),
      },
      {
        orgId: organization.id,
        runId: secondRunId,
        agentId: secondAgent.id,
        seq: 1,
        eventType: "adapter.invoke",
        stream: "system",
        level: "info",
        message: "adapter invocation",
        payload: {
          prompt: "Use [$build-advisor](/workspace/.agents/skills/build-advisor/SKILL.md) and [$deep-research](/workspace/.agents/skills/deep-research/SKILL.md)",
          loadedSkills: [
            { key: "rudder/build-advisor", runtimeName: "build-advisor", name: "Build Advisor" },
            { key: "deep-research", runtimeName: "deep-research", name: "Deep Research" },
          ],
        },
        createdAt: new Date(secondRunAt.getTime() + 5 * 1000),
      },
    ]);

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/dashboard`, {
      waitUntil: "domcontentloaded",
    });

    const mainContent = page.locator("#main-content");
    await expect(mainContent.getByRole("heading", { name: "Skills" })).toBeVisible();
    await expect(mainContent.getByText("Explicitly used skills per run for Last 7 days across all agents. Hover a day to inspect the breakdown.")).toBeVisible();
    await expect(mainContent.getByText("4 skill uses")).toBeVisible();
    await expect(mainContent.getByText("2 runs with skill use")).toBeVisible();

    const distributionPie = mainContent.getByRole("button", { name: /Skill use distribution: 4 skill uses across 3 skills/ });
    await expect(distributionPie).toBeVisible();
    await distributionPie.hover();
    await expect(page.getByText("Skill use distribution")).toBeVisible();
    await expect(page.getByText("4 skill uses across 2 runs")).toBeVisible();

    const recentDayColumn = mainContent.getByLabel(new RegExp(`${escapeRegExp(formatDayTitle(recentDateKey))}: 4 skill uses across 2 runs`));
    await expect(recentDayColumn).toBeVisible();
    await recentDayColumn.hover();
    await expect(page.getByText("build-advisor")).toBeVisible();
    await expect(page.getByText("screenshot")).toBeVisible();
    await expect(page.getByText("deep-research")).toBeVisible();

    await mainContent.screenshot({
      path: testInfo.outputPath("dashboard-skills-analytics.png"),
      animations: "disabled",
    });
  });

  test("hides the skills section for a new agent without skill use", async ({ page, request }) => {
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
    await expect(mainContent.getByText(/skill use/i)).toHaveCount(0);
  });
});
