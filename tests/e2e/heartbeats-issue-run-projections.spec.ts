import { expect, test, type Page } from "@playwright/test";
import { createDb, heartbeatRuns } from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

async function createOrganizationWithAgents(page: Page, suffix: string) {
  const orgResponse = await page.request.post("/api/orgs", {
    data: { name: `Perf-Projections-${suffix}-${Date.now()}` },
  });
  expect(orgResponse.ok()).toBe(true);
  const organization = await orgResponse.json() as { id: string; issuePrefix: string };

  const createAgent = async (name: string) => {
    const response = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name,
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { model: "gpt-5.4" },
      },
    });
    expect(response.ok()).toBe(true);
    return await response.json() as { id: string };
  };

  return {
    organization,
    busyAgent: await createAgent("Busy overview agent"),
    inactiveAgent: await createAgent("Inactive overview agent"),
  };
}

async function selectOrganization(page: Page, orgId: string) {
  await page.addInitScript((selectedOrgId: string) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

test.describe("Heartbeats and issue run projections", () => {
  test.describe.configure({ timeout: 120_000 });

  test("keeps inactive agent history while bounding the Heartbeats overview", async ({ page }) => {
    const { organization, busyAgent, inactiveAgent } = await createOrganizationWithAgents(page, "heartbeats");
    const now = Date.now();
    const busyRuns = Array.from({ length: 7 }, (_, index) => ({
      orgId: organization.id,
      agentId: busyAgent.id,
      invocationSource: "timer" as const,
      status: "succeeded" as const,
      resultSummaryJson: { summary: `Busy recent run ${index + 1}` },
      createdAt: new Date(now - (6 - index) * 1_000),
      updatedAt: new Date(now - (6 - index) * 1_000),
    }));
    await e2eDb.insert(heartbeatRuns).values([
      {
        orgId: organization.id,
        agentId: inactiveAgent.id,
        invocationSource: "on_demand",
        status: "succeeded",
        resultSummaryJson: { summary: "Old inactive run remains visible." },
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
        updatedAt: new Date("2025-01-01T00:01:00.000Z"),
      },
      ...busyRuns,
    ]);
    await selectOrganization(page, organization.id);

    const requestedUrls: string[] = [];
    page.on("request", (request) => requestedUrls.push(request.url()));
    const overviewResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith(`/api/orgs/${organization.id}/agent-runs/overview`),
    );
    await page.goto(`/${organization.issuePrefix}/heartbeats`, { waitUntil: "domcontentloaded" });
    const overviewResponse = await overviewResponsePromise;
    const overviewBody = await overviewResponse.body();

    await expect(page.getByTestId("org-heartbeat-row")).toHaveCount(2);
    await expect(page.getByText("Old inactive run remains visible.")).toBeVisible();
    await expect(page.getByText("Busy recent run 7").first()).toBeVisible();
    expect(overviewBody.byteLength).toBeLessThan(100_000);
    expect(requestedUrls.some((url) => url.includes("agent-runs?limit=1000"))).toBe(false);

    const screenshotPath = process.env.RUDDER_PERF_HEARTBEATS_SCREENSHOT?.trim();
    if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });
  });

  test("stops terminal issue-run polling without losing summary and billing evidence", async ({ page }) => {
    const { organization, busyAgent } = await createOrganizationWithAgents(page, "terminal-issue");
    const issueResponse = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Compact terminal run evidence",
        description: "Keep the timeline and cost evidence while bounding transport.",
        status: "done",
        priority: "medium",
      },
    });
    expect(issueResponse.ok()).toBe(true);
    const issue = await issueResponse.json() as { id: string; identifier: string };
    const [run] = await e2eDb.insert(heartbeatRuns).values({
      orgId: organization.id,
      agentId: busyAgent.id,
      invocationSource: "on_demand",
      status: "succeeded",
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: { issueId: issue.id },
      usageJson: {
        inputTokens: 120,
        cachedInputTokens: 20,
        outputTokens: 40,
      },
      resultSummaryJson: {
        summary: "Terminal compact summary remains inspectable.",
        costUsd: 1.25,
      },
      resultJson: {
        summary: "Terminal compact summary remains inspectable.",
        provider: "openai",
        biller: "chatgpt",
        model: "gpt-5.6",
        billingType: "subscription_overage",
        costUsd: 1.25,
        internalAdapterState: "x".repeat(2_000_000),
      },
    }).returning({ id: heartbeatRuns.id });
    await selectOrganization(page, organization.id);

    let linkedRunRequestCount = 0;
    page.on("request", (request) => {
      if (request.url().endsWith(`/api/issues/${issue.identifier}/runs`)) linkedRunRequestCount += 1;
    });
    const linkedResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith(`/api/issues/${issue.identifier}/runs`),
    );
    await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier}`, { waitUntil: "domcontentloaded" });
    const linkedResponse = await linkedResponsePromise;
    const linkedBody = await linkedResponse.body();
    const runCard = page.locator(`[data-run-id="${run.id}"]`);

    await expect(runCard).toBeVisible();
    await runCard.getByRole("button", { name: "Show details" }).click();
    await expect(runCard.getByText("Terminal compact summary remains inspectable.")).toBeVisible();
    await expect(page.getByText("$1.2500")).toBeVisible();
    expect(linkedBody.byteLength).toBeLessThan(20_000);
    expect(linkedBody.toString()).not.toContain("internalAdapterState");
    await page.waitForTimeout(6_000);
    expect(linkedRunRequestCount).toBe(1);

    const screenshotPath = process.env.RUDDER_PERF_ISSUE_SCREENSHOT?.trim();
    if (screenshotPath) {
      await page.getByTestId("comment-thread-fixed-composer").evaluate((element) => {
        element.style.display = "none";
      });
      await runCard.screenshot({ path: screenshotPath });
    }
  });

  test("reconciles final issue-run evidence once when a live run becomes terminal", async ({ page }) => {
    const { organization, busyAgent } = await createOrganizationWithAgents(page, "live-issue");
    const issueResponse = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Live run reconciliation",
        description: "Final evidence must survive the transition.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueResponse.ok()).toBe(true);
    const issue = await issueResponse.json() as { id: string; identifier: string };
    const [run] = await e2eDb.insert(heartbeatRuns).values({
      orgId: organization.id,
      agentId: busyAgent.id,
      invocationSource: "on_demand",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId: issue.id },
      resultSummaryJson: { summary: "Working on final evidence." },
    }).returning({ id: heartbeatRuns.id });
    await selectOrganization(page, organization.id);

    let linkedRunRequestCount = 0;
    page.on("request", (request) => {
      if (request.url().endsWith(`/api/issues/${issue.identifier}/runs`)) linkedRunRequestCount += 1;
    });
    await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Live", { exact: true })).toBeVisible();

    const finalEvidence = {
      summary: "Final reconciled evidence is visible.",
      provider: "openai",
      billingType: "subscription_included",
      internalAdapterState: "y".repeat(1_000_000),
    };
    await (e2eDb as unknown as {
      $client: { unsafe: (text: string, params: unknown[]) => Promise<unknown> };
    }).$client.unsafe(
      `update heartbeat_runs
       set status = 'succeeded', finished_at = now(), result_summary_json = $1::jsonb,
           result_json = $2::jsonb, updated_at = now()
       where id = $3`,
      [
        JSON.stringify({ summary: "Final reconciled evidence is visible." }),
        JSON.stringify(finalEvidence),
        run.id,
      ],
    );

    const runCard = page.locator(`[data-run-id="${run.id}"]`);
    await expect(runCard.getByRole("link", { name: "Open succeeded run details" })).toBeVisible({ timeout: 15_000 });
    await runCard.getByRole("button", { name: "Show details" }).click();
    await expect(runCard.getByText("Final reconciled evidence is visible.")).toBeVisible();
    const countAfterReconciliation = linkedRunRequestCount;
    await page.waitForTimeout(6_000);
    expect(linkedRunRequestCount).toBe(countAfterReconciliation);
  });
});
