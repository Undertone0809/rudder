import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { asc, eq, inArray } from "../../packages/db/node_modules/drizzle-orm/index.js";
import {
  chatMessageTranscriptEntries,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  nativeSegments,
  runRuntimeSpans,
} from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_DATABASE_URL, E2E_ROOT } from "./support/e2e-env";

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

function visibleSkillDayIndex(dateKey: string): number {
  const firstVisibleDateKey = utcDateKey(makeUtcDate(6, 0));
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.round((Date.parse(`${dateKey}T00:00:00.000Z`) - Date.parse(`${firstVisibleDateKey}T00:00:00.000Z`)) / dayMs);
}

test.describe("Agent dashboard skills analytics", () => {
  test("shows native-only skill usage from persisted Run transcripts without legacy log data", async ({ page, request }, testInfo) => {
    const createNativeAgent = async (name: string) => {
      const orgRes = await request.post("/api/orgs", { data: { name: `${name}-${Date.now()}` } });
      expect(orgRes.ok()).toBe(true);
      const org = await orgRes.json() as { id: string; urlKey: string };
      const agent = await createE2EChatAgent(request, org.id, {
        name,
        command: path.join(E2E_ROOT, "fixtures/codex-native-session.mjs"),
      });
      return { org, agent };
    };

    const sendSkillTurn = async (skill: string, reply: string) => {
      await page.locator(".rudder-mdxeditor-content").first().fill(`Native skill telemetry: ${skill}`);
      const stream = page.waitForResponse((response) => response.request().method() === "POST"
        && response.url().endsWith("/messages/stream"));
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await (await stream).finished();
      await expect(page.getByTestId("chat-assistant-message").last()).toContainText(reply, { timeout: 30_000 });
    };

    const first = await createNativeAgent("Native Skills Primary");
    const other = await createNativeAgent("Native Skills Other Org");

    await page.goto("/");
    await page.evaluate((orgId) => localStorage.setItem("rudder.selectedOrganizationId", orgId), first.org.id);
    await page.goto(`/${first.org.urlKey}/messenger/chat?agentId=${first.agent.id}`);
    await sendSkillTurn("build-advisor", "Native reply 1");
    await sendSkillTurn("pua", "Native reply 2");
    const conversationId = new URL(page.url()).pathname.split("/").at(-1)!;

    const nativeRuns = await e2eDb.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.chatConversationId, conversationId))
      .orderBy(asc(heartbeatRuns.createdAt));
    expect(nativeRuns).toHaveLength(2);
    const nativeRunIds = nativeRuns.map((run) => run.id);
    const spans = await e2eDb.select().from(runRuntimeSpans)
      .where(inArray(runRuntimeSpans.runId, nativeRunIds));
    expect(spans).toHaveLength(2);
    expect(spans.every((span) => span.selectorJson.kind === "codex_turn" && span.state === "sealed")).toBe(true);
    expect(new Set(spans.map((span) => span.nativeExecutionRef)).size).toBe(2);
    const segments = await e2eDb.select().from(nativeSegments)
      .where(inArray(nativeSegments.id, spans.map((span) => span.segmentId)));
    expect(segments.length).toBeGreaterThan(0);
    expect(spans.every((span) => segments.some((segment) => segment.id === span.segmentId
      && segment.orgId === first.org.id))).toBe(true);

    for (const [run, skill] of nativeRuns.map((run, index) => [run, ["build-advisor", "pua"][index]!] as const)) {
      expect(run.orgId).toBe(first.org.id);
      expect(run.logRef).toBeNull();
      expect(run.logBytes ?? 0).toBe(0);
      expect(run.stdoutExcerpt).toBeNull();
      expect(run.stderrExcerpt).toBeNull();
      const transcriptResponse = await page.request.get(`/api/run-intelligence/runs/${run.id}/transcript`);
      expect(transcriptResponse.ok()).toBe(true);
      const transcript = await transcriptResponse.json();
      expect(transcript).toMatchObject({ source: "native", availability: "available", completeness: "complete" });
      expect(transcript.rows.some((row: { kind: string }) => row.kind === "tool_call"
        && JSON.stringify(row).includes(`/${skill}/SKILL.md`))).toBe(true);
    }

    const runEvents = await e2eDb.select().from(heartbeatRunEvents)
      .where(inArray(heartbeatRunEvents.runId, nativeRunIds));
    expect(runEvents.filter((event) => event.eventType === "adapter.skill_usage")).toHaveLength(0);
    expect(runEvents.every((event) => event.eventType !== "adapter.invoke"
      || !JSON.stringify(event.payload ?? {}).includes(".agents/skills/"))).toBe(true);
    expect(await e2eDb.select().from(chatMessageTranscriptEntries)
      .where(eq(chatMessageTranscriptEntries.orgId, first.org.id))).toHaveLength(0);

    await page.goto("/");
    await page.evaluate((orgId) => localStorage.setItem("rudder.selectedOrganizationId", orgId), other.org.id);
    await page.goto(`/${other.org.urlKey}/messenger/chat?agentId=${other.agent.id}`);
    await sendSkillTurn("private-only", "Native reply 1");
    const otherConversationId = new URL(page.url()).pathname.split("/").at(-1)!;
    const otherRuns = await e2eDb.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.chatConversationId, otherConversationId));
    expect(otherRuns).toHaveLength(1);
    expect(otherRuns[0]!.orgId).toBe(other.org.id);

    const agentAnalyticsResponse = await page.request.get(`/api/agents/${first.agent.id}/skills/analytics?windowDays=7`);
    expect(agentAnalyticsResponse.ok()).toBe(true);
    const agentAnalytics = await agentAnalyticsResponse.json();
    expect(agentAnalytics).toMatchObject({ orgId: first.org.id, totalCount: 2, totalRunsWithSkills: 2 });
    expect(agentAnalytics.skills.map((skill: { key: string }) => skill.key).sort()).toEqual(["build-advisor", "pua"]);

    const organizationAnalyticsResponse = await page.request.get(`/api/orgs/${first.org.id}/dashboard/skills/analytics?windowDays=7`);
    expect(organizationAnalyticsResponse.ok()).toBe(true);
    const organizationAnalytics = await organizationAnalyticsResponse.json();
    expect(organizationAnalytics).toMatchObject({ orgId: first.org.id, totalCount: 2, totalRunsWithSkills: 2 });
    expect(organizationAnalytics.skills.map((skill: { key: string }) => skill.key).sort()).toEqual(["build-advisor", "pua"]);

    await page.goto(`/${first.org.urlKey}/agents/${first.agent.urlKey}/dashboard`);
    const mainContent = page.locator("#main-content");
    await expect(mainContent.locator("h3").filter({ hasText: "Skills" })).toBeVisible();
    await expect(mainContent.getByText("2 skill uses")).toBeVisible();
    await expect(mainContent.getByText("2 runs with skill usage")).toBeVisible();
    const usageChart = mainContent.locator('[data-testid="skills-usage-area-chart"]');
    await expect(usageChart.getByText("build-advisor")).toBeVisible();
    await expect(usageChart.getByText("pua")).toBeVisible();
    await expect(usageChart.getByText("private-only")).toHaveCount(0);

    const firstOrgRunsAfterOtherOrg = await e2eDb.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.orgId, first.org.id));
    expect(firstOrgRunsAfterOtherOrg.map((run) => run.id).sort()).toEqual(nativeRunIds.sort());
    const otherOrgRuns = await e2eDb.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.orgId, other.org.id));
    expect(otherOrgRuns.map((run) => run.id)).toEqual([otherRuns[0]!.id]);
    await mainContent.screenshot({ path: testInfo.outputPath("native-only-skills-dashboard.png") });
  });

  test("shows a 7-day skill usage chart when all recent activity is within the last week", async ({ page, request }, testInfo) => {
    const orgRes = await request.post("/api/orgs", {
      data: {
        name: `Agent-Skills-Analytics-${Date.now()}`,
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
        invocationSource: "timer",
        triggerDetail: "system",
        status: "succeeded",
        contextSnapshot: { wakeReason: "heartbeat_timer" },
        createdAt: recentMorning,
        updatedAt: new Date(recentMorning.getTime() + 5 * 60 * 1000),
      },
      {
        id: runTwoId,
        orgId: organization.id,
        agentId: agent.id,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "succeeded",
        contextSnapshot: { wakeReason: "issue_comment_mentioned", wakeSource: "comment.mention" },
        createdAt: recentAfternoon,
        updatedAt: new Date(recentAfternoon.getTime() + 5 * 60 * 1000),
      },
      {
        id: runThreeId,
        orgId: organization.id,
        agentId: agent.id,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "succeeded",
        contextSnapshot: { wakeReason: "issue_assigned" },
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
          usedSkills: [
            { key: "rudder/build-advisor", runtimeName: "build-advisor", name: "Build Advisor" },
            { key: "screenshot", runtimeName: "screenshot", name: "Screenshot" },
          ],
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
          prompt: "Use [$build-advisor](/workspace/.agents/skills/build-advisor/SKILL.md), [$pua](/workspace/.agents/skills/pua/SKILL.md), and [$unused-requested](/workspace/.agents/skills/unused-requested/SKILL.md)",
          loadedSkills: [
            { key: "rudder/build-advisor", runtimeName: "build-advisor", name: "Build Advisor" },
            { key: "pua", runtimeName: "pua", name: "PUA" },
            { key: "unused-requested", runtimeName: "unused-requested", name: "Unused Requested" },
          ],
        },
        createdAt: new Date(recentAfternoon.getTime() + 5 * 1000),
      },
      {
        orgId: organization.id,
        runId: runTwoId,
        agentId: agent.id,
        seq: 2,
        eventType: "adapter.skill_usage",
        stream: "system",
        level: "info",
        message: "skill usage inferred from transcript",
        payload: {
          source: "transcript.skill_file_read",
          usedSkills: [
            { key: "rudder/build-advisor", label: "build-advisor" },
            { key: "pua", label: "pua" },
          ],
        },
        createdAt: new Date(recentAfternoon.getTime() + 10 * 1000),
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
    await expect(mainContent.getByText("Skill usage per run for Last 7 days. Hover a day to inspect the breakdown.")).toBeVisible();
    await expect(mainContent.getByText("4 skill uses")).toBeVisible();
    await expect(mainContent.getByText("2 runs with skill usage")).toBeVisible();
    await expect(mainContent.getByText("Skill Usage Distribution")).toHaveCount(0);
    await expect(mainContent.getByText("Skill Usage Timeline")).toHaveCount(0);

    const usageChart = mainContent.locator('[data-testid="skills-usage-area-chart"]');
    await expect(usageChart).toBeVisible();
    await expect(usageChart.getByRole("heading", { name: "Skills used", exact: true })).toBeVisible();
    await expect(usageChart.getByRole("img", { name: /Skill usage area chart: 4 skill uses across 2 runs/ })).toBeVisible();
    await expect(usageChart.locator('[data-testid="dashboard-chart-scale"]').filter({ hasText: "4" })).toBeVisible();
    await expect(usageChart.locator('[data-testid="dashboard-chart-scale"]').filter({ hasText: "0" })).toBeVisible();
    await expect(usageChart.locator("svg path")).toHaveCount(4);
    await expect(usageChart.locator("svg path").first()).toHaveAttribute("d", /\S/);
    const agentChartPathData = await usageChart.locator("svg path").evaluateAll((paths) =>
      paths.map((path) => path.getAttribute("d") ?? ""),
    );
    expect(agentChartPathData.every((path) => path.includes(" C "))).toBe(true);
    await expect(usageChart.getByText("build-advisor")).toBeVisible();
    await expect(usageChart.getByText("screenshot")).toBeVisible();
    await expect(usageChart.getByText("pua")).toBeVisible();

    const recentDayColumn = usageChart.locator("button").nth(visibleSkillDayIndex(recentDateKey));
    await expect(recentDayColumn).toBeVisible();
    await recentDayColumn.hover();
    await expect(page.getByText(formatDayTitle(recentDateKey)).first()).toBeVisible();
    await expect(page.getByText("4 skill uses across 2 runs").first()).toBeVisible();
    await expect(page.getByText("build-advisor").first()).toBeVisible();
    await expect(page.getByText("screenshot").first()).toBeVisible();
    await expect(page.getByText("pua").first()).toBeVisible();
    await expect(page.getByText("Total").first()).toBeVisible();
    await expect(page.getByText("unused-requested")).toHaveCount(0);
    await expect(page.getByText("Prompt requested")).toHaveCount(0);
    await expect(page.getByText("Loaded only")).toHaveCount(0);
    await page.keyboard.press("Escape");

    await mainContent.screenshot({
      path: testInfo.outputPath("agent-dashboard-skills-analytics.png"),
      animations: "disabled",
    });
  });

  test("shows organization-wide skill usage analytics on the dashboard", async ({ page, request }, testInfo) => {
    const orgRes = await request.post("/api/orgs", {
      data: {
        name: `Dashboard-Skills-Analytics-${Date.now()}`,
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
          usedSkills: [
            { key: "rudder/build-advisor", runtimeName: "build-advisor", name: "Build Advisor" },
            { key: "screenshot", runtimeName: "screenshot", name: "Screenshot" },
          ],
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
          prompt: "Use [$build-advisor](/workspace/.agents/skills/build-advisor/SKILL.md), [$deep-research](/workspace/.agents/skills/deep-research/SKILL.md), and [$unused-requested](/workspace/.agents/skills/unused-requested/SKILL.md)",
          loadedSkills: [
            { key: "rudder/build-advisor", runtimeName: "build-advisor", name: "Build Advisor" },
            { key: "deep-research", runtimeName: "deep-research", name: "Deep Research" },
            { key: "unused-requested", runtimeName: "unused-requested", name: "Unused Requested" },
          ],
        },
        createdAt: new Date(secondRunAt.getTime() + 5 * 1000),
      },
      {
        orgId: organization.id,
        runId: secondRunId,
        agentId: secondAgent.id,
        seq: 2,
        eventType: "adapter.skill_usage",
        stream: "system",
        level: "info",
        message: "skill usage inferred from transcript",
        payload: {
          source: "transcript.skill_file_read",
          usedSkills: [
            { key: "rudder/build-advisor", label: "build-advisor" },
            { key: "deep-research", label: "deep-research" },
          ],
        },
        createdAt: new Date(secondRunAt.getTime() + 10 * 1000),
      },
    ]);

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/dashboard`, {
      waitUntil: "domcontentloaded",
    });

    const mainContent = page.locator("#main-content");
    await expect(mainContent.getByRole("heading", { name: "Skills", exact: true })).toBeVisible();
    await expect(mainContent.getByText("Skill usage per run for Last 7 days across all agents. Hover a day to inspect the breakdown.")).toBeVisible();
    await expect(mainContent.getByText("4 skill uses")).toBeVisible();
    await expect(mainContent.getByText("2 runs with skill usage")).toBeVisible();
    await expect(mainContent.getByText("Skill Usage Distribution")).toHaveCount(0);
    await expect(mainContent.getByText("Skill Usage Timeline")).toHaveCount(0);

    const usageChart = mainContent.locator('[data-testid="skills-usage-area-chart"]');
    await expect(usageChart).toBeVisible();
    await expect(usageChart.getByRole("heading", { name: "Skills used", exact: true })).toBeVisible();
    await expect(usageChart.getByRole("img", { name: /Skill usage area chart: 4 skill uses across 2 runs/ })).toBeVisible();
    await expect(usageChart.locator('[data-testid="dashboard-chart-scale"]').filter({ hasText: "4" })).toBeVisible();
    await expect(usageChart.locator('[data-testid="dashboard-chart-scale"]').filter({ hasText: "0" })).toBeVisible();
    await expect(usageChart.locator("svg path")).toHaveCount(4);
    await expect(usageChart.locator("svg path").first()).toHaveAttribute("d", /\S/);
    const dashboardChartPathData = await usageChart.locator("svg path").evaluateAll((paths) =>
      paths.map((path) => path.getAttribute("d") ?? ""),
    );
    expect(dashboardChartPathData.every((path) => path.includes(" C "))).toBe(true);
    await expect(usageChart.getByText("build-advisor")).toBeVisible();
    await expect(usageChart.getByText("screenshot")).toBeVisible();
    await expect(usageChart.getByText("deep-research")).toBeVisible();

    const recentDayColumn = usageChart.locator("button").nth(visibleSkillDayIndex(recentDateKey));
    await expect(recentDayColumn).toBeVisible();
    await recentDayColumn.hover();
    await expect(page.getByText(formatDayTitle(recentDateKey)).first()).toBeVisible();
    await expect(page.getByText("4 skill uses across 2 runs").first()).toBeVisible();
    await expect(page.getByText("build-advisor").first()).toBeVisible();
    await expect(page.getByText("screenshot").first()).toBeVisible();
    await expect(page.getByText("deep-research").first()).toBeVisible();
    await expect(page.getByText("Total").first()).toBeVisible();
    await expect(page.getByText("unused-requested")).toHaveCount(0);
    await expect(page.getByText("Prompt requested")).toHaveCount(0);
    await expect(page.getByText("Loaded only")).toHaveCount(0);
    await page.keyboard.press("Escape");

    await mainContent.screenshot({
      path: testInfo.outputPath("dashboard-skills-analytics.png"),
      animations: "disabled",
    });
  });

  test("hides the skills section for a new agent without skill usage", async ({ page, request }) => {
    const orgRes = await request.post("/api/orgs", {
      data: {
        name: `Agent-Skills-Hidden-${Date.now()}`,
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
    await expect(mainContent.getByText(/skill usage/i)).toHaveCount(0);
  });
});
