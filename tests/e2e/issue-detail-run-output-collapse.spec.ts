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

test("collapses failed issue run output by default and keeps non-failed output expanded", async ({ page }) => {
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

  const succeededRunId = randomUUID();
  const failedRunId = randomUUID();
  const now = new Date("2026-05-07T00:02:00.000Z");
  const later = new Date("2026-05-07T00:03:00.000Z");

  await e2eDb.insert(heartbeatRuns).values([
    {
      id: succeededRunId,
      orgId: organization.id,
      agentId: agent.id,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "succeeded",
      startedAt: now,
      finishedAt: now,
      contextSnapshot: {
        issueId: issue.id,
        issue: { id: issue.id, title: "Review failed run folding", status: "in_progress", priority: "medium" },
      },
      createdAt: now,
      updatedAt: now,
    },
    {
      id: failedRunId,
      orgId: organization.id,
      agentId: agent.id,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      startedAt: later,
      finishedAt: later,
      error: "Runtime stopped before final deliverables.",
      errorCode: "adapter_failed",
      contextSnapshot: {
        issueId: issue.id,
        issue: { id: issue.id, title: "Review failed run folding", status: "in_progress", priority: "medium" },
      },
      createdAt: later,
      updatedAt: later,
    },
  ]);

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`);

  const succeededRunCard = page
    .getByLabel("Agent run output")
    .filter({ hasText: succeededRunId.slice(0, 8) });
  await expect(succeededRunCard.getByRole("button", { name: "Hide details" })).toBeVisible({ timeout: 15_000 });
  await expect(succeededRunCard).toContainText("No run output captured.");

  const failedRunCard = page
    .getByLabel("Agent run output")
    .filter({ hasText: failedRunId.slice(0, 8) });
  await expect(failedRunCard.getByRole("button", { name: "Show details" })).toBeVisible();
  await expect(failedRunCard).not.toContainText("No run output captured.");
  const collapsedRunBox = await failedRunCard.boundingBox();
  expect(collapsedRunBox?.height).toBeLessThan(48);

  await failedRunCard.getByRole("button", { name: "Show details" }).click();
  await expect(failedRunCard.getByRole("button", { name: "Hide details" })).toBeVisible();
  await expect(failedRunCard).toContainText("No run output captured.");
  const expandedRunBox = await failedRunCard.boundingBox();
  expect(expandedRunBox?.height).toBeGreaterThan((collapsedRunBox?.height ?? 0) + 24);
});
