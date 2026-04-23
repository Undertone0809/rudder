import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createDb, heartbeatRunEvents, heartbeatRuns } from "../../packages/db/src/index.ts";

const E2E_DATABASE_URL = process.env.RUDDER_E2E_DATABASE_URL?.trim() || "postgres://rudder:rudder@127.0.0.1:54339/rudder";
const e2eDb = createDb(E2E_DATABASE_URL);

test.describe("Agent dashboard skills analytics", () => {
  test("shows a 7-day loaded-skills chart when all recent activity is within the last week", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
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

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
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

    await e2eDb.insert(heartbeatRuns).values([
      {
        id: runOneId,
        orgId: organization.id,
        agentId: agent.id,
        invocationSource: "on_demand",
        status: "succeeded",
        createdAt: new Date("2026-04-20T08:00:00.000Z"),
        updatedAt: new Date("2026-04-20T08:05:00.000Z"),
      },
      {
        id: runTwoId,
        orgId: organization.id,
        agentId: agent.id,
        invocationSource: "on_demand",
        status: "succeeded",
        createdAt: new Date("2026-04-20T16:00:00.000Z"),
        updatedAt: new Date("2026-04-20T16:05:00.000Z"),
      },
      {
        id: runThreeId,
        orgId: organization.id,
        agentId: agent.id,
        invocationSource: "on_demand",
        status: "succeeded",
        createdAt: new Date("2026-04-18T10:00:00.000Z"),
        updatedAt: new Date("2026-04-18T10:05:00.000Z"),
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
        createdAt: new Date("2026-04-20T08:00:05.000Z"),
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
        createdAt: new Date("2026-04-20T16:00:05.000Z"),
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
        createdAt: new Date("2026-04-18T10:00:05.000Z"),
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
    await expect(mainContent.getByText("Loaded skills per run over the last 7 days. Hover a day to inspect the breakdown.")).toBeVisible();
    await expect(mainContent.getByText("5 skill loads")).toBeVisible();
    await expect(mainContent.getByText("3 runs with skill metadata")).toBeVisible();

    const april20Column = mainContent.getByLabel(/Apr 20, 2026: 4 skill loads across 2 runs/);
    await expect(april20Column).toBeVisible();
    await april20Column.hover();

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

  test("hides the skills section for a new agent without skill metadata", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
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

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
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
