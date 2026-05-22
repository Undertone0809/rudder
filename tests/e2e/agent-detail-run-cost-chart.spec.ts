import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createDb, heartbeatRuns } from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

function makeRunDate(daysAgo: number, hour: number): Date {
  const now = new Date();
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - daysAgo,
    hour,
    0,
    0,
    0,
  ));
}

test.describe("Agent detail run cost chart", () => {
  test("shows stacked token rows with keyboard tooltip and run navigation", async ({ page, request }) => {
    const orgRes = await request.post("/api/orgs", {
      data: {
        name: `Agent-Run-Cost-Chart-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const agentRes = await request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Run Cost Analyst",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    const largerRunId = randomUUID();
    const smallerRunId = randomUUID();
    const newerRunDate = makeRunDate(0, 15);
    const olderRunDate = makeRunDate(1, 10);

    await e2eDb.insert(heartbeatRuns).values([
      {
        id: largerRunId,
        orgId: organization.id,
        agentId: agent.id,
        invocationSource: "on_demand",
        status: "succeeded",
        usageJson: {
          inputTokens: 1000,
          cachedInputTokens: 500,
          outputTokens: 250,
          costUsd: 0.4321,
          billingType: "metered_api",
        },
        createdAt: newerRunDate,
        updatedAt: new Date(newerRunDate.getTime() + 60_000),
      },
      {
        id: smallerRunId,
        orgId: organization.id,
        agentId: agent.id,
        invocationSource: "on_demand",
        status: "succeeded",
        usageJson: {
          inputTokens: 120,
          cachedInputTokens: 30,
          outputTokens: 50,
          costUsd: 0.0123,
          billingType: "metered_api",
        },
        createdAt: olderRunDate,
        updatedAt: new Date(olderRunDate.getTime() + 60_000),
      },
    ]);

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/dashboard`, {
      waitUntil: "domcontentloaded",
    });

    const mainContent = page.locator("#main-content");
    await expect(mainContent.getByRole("heading", { name: "Run Cost Analyst", exact: true })).toBeVisible();
    const chart = mainContent.getByTestId("agent-run-cost-chart");
    await expect(chart).toBeVisible();
    await expect(chart.getByText("Recent run token mix")).toBeVisible();
    const legend = chart.getByTestId("agent-run-cost-legend");
    await expect(legend.getByText("Input", { exact: true })).toBeVisible();
    await expect(legend.getByText("Cached", { exact: true })).toBeVisible();
    await expect(legend.getByText("Output", { exact: true })).toBeVisible();
    await expect(chart.locator("table")).toHaveCount(0);

    const rows = chart.getByTestId("agent-run-cost-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText(largerRunId.slice(0, 8));
    await expect(rows.first()).toContainText("1,000");
    await expect(rows.first()).toContainText("500");
    await expect(rows.first()).toContainText("250");
    await expect(rows.first()).toContainText("1.8k tok");
    await expect(rows.first()).toContainText("1.0k / 500 / 250");
    await expect(rows.first()).toContainText("$0.4321");
    await expect(chart.getByText("875")).toBeVisible();

    await rows.first().focus();
    await expect(page.getByRole("tooltip").getByText(largerRunId)).toBeVisible();
    await expect(page.getByRole("tooltip").getByText("1,750")).toBeVisible();
    await expect(page.getByRole("tooltip").getByText("500")).toBeVisible();

    await rows.first().click();
    await expect(page).toHaveURL(new RegExp(`/agents/[^/]+/runs/${largerRunId}$`));
  });
});
