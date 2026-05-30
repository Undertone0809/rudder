import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createDb, heartbeatRuns } from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

async function createOrganization(page: Page) {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Issue-Run-Collapse-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json() as Promise<{ id: string; issuePrefix: string }>;
}

test("collapses inactive issue runs by default and keeps active runs expanded", async ({ page }) => {
  const organization = await createOrganization(page);

  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Holden",
      role: "engineer",
      agentRuntimeType: "process",
      agentRuntimeConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
    },
  });
  expect(agentRes.ok()).toBe(true);
  const agent = await agentRes.json() as { id: string };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Review failed run folding",
      description: "Failed issue runs should not show transcript details until expanded.",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agent.id,
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier: string | null };

  const runningRunId = randomUUID();
  const succeededRunId = randomUUID();
  const failedRunId = randomUUID();
  const now = new Date("2026-05-07T00:02:00.000Z");
  const later = new Date("2026-05-07T00:03:00.000Z");
  const latest = new Date("2026-05-07T00:04:00.000Z");

  await e2eDb.insert(heartbeatRuns).values([
    {
      id: runningRunId,
      orgId: organization.id,
      agentId: agent.id,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      startedAt: now,
      finishedAt: null,
      contextSnapshot: {
        issueId: issue.id,
        issue: { id: issue.id, title: "Review failed run folding", status: "in_progress", priority: "medium" },
      },
      createdAt: now,
      updatedAt: now,
    },
    {
      id: succeededRunId,
      orgId: organization.id,
      agentId: agent.id,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "succeeded",
      startedAt: later,
      finishedAt: later,
      contextSnapshot: {
        issueId: issue.id,
        issue: { id: issue.id, title: "Review failed run folding", status: "in_progress", priority: "medium" },
      },
      createdAt: later,
      updatedAt: later,
    },
    {
      id: failedRunId,
      orgId: organization.id,
      agentId: agent.id,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      startedAt: latest,
      finishedAt: latest,
      error: "Runtime stopped before final deliverables.",
      errorCode: "adapter_failed",
      contextSnapshot: {
        issueId: issue.id,
        issue: { id: issue.id, title: "Review failed run folding", status: "in_progress", priority: "medium" },
      },
      createdAt: latest,
      updatedAt: latest,
    },
  ]);

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  const issueUrl = `/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`;
  await page.goto(issueUrl);

  await expect(page.getByText("Live Runs")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(runningRunId.slice(0, 8))).toBeVisible();
  await expect(page.getByText("Waiting for run output...").first()).toBeVisible();

  const succeededRunCard = page.locator(`[data-run-id="${succeededRunId}"]`);
  await expect(succeededRunCard.getByRole("button", { name: "Show details" })).toBeVisible();
  await expect(succeededRunCard).not.toContainText("No run output captured.");
  const succeededRunBox = await succeededRunCard.boundingBox();
  expect(succeededRunBox?.height).toBeLessThan(42);
  await expect(succeededRunCard).not.toContainText(succeededRunId.slice(0, 8));
  await succeededRunCard.getByRole("link", { name: "Open succeeded run details" }).click();
  await expect(page).toHaveURL(new RegExp(`/agents/[^/]+/runs/${succeededRunId}$`));

  await page.goto(issueUrl);
  const failedRunCard = page.locator(`[data-run-id="${failedRunId}"]`);
  await expect(failedRunCard.getByRole("button", { name: "Show details" })).toBeVisible();
  await expect(failedRunCard).not.toContainText("No run output captured.");
  const collapsedRunBox = await failedRunCard.boundingBox();
  expect(collapsedRunBox?.height).toBeLessThan(42);
  await expect(failedRunCard).not.toContainText(failedRunId.slice(0, 8));
  await failedRunCard.click({ position: { x: 420, y: 20 } });
  await expect(page).toHaveURL(new RegExp(`/agents/[^/]+/runs/${failedRunId}$`));

  await page.goto(issueUrl);
  const failedRunCardForExpand = page.locator(`[data-run-id="${failedRunId}"]`);
  await failedRunCardForExpand.getByRole("button", { name: "Show details" }).click();
  await expect(failedRunCardForExpand.getByRole("button", { name: "Hide details" })).toBeVisible();
  await expect(failedRunCardForExpand).toContainText("No run output captured.");
  const expandedRunBox = await failedRunCardForExpand.boundingBox();
  expect(expandedRunBox?.height).toBeGreaterThan((collapsedRunBox?.height ?? 0) + 24);
});
