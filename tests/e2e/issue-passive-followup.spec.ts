import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { activityLog, createDb, heartbeatRuns } from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

async function createOrganization(page: Page) {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Passive-Followup-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json();
}

test("surfaces passive issue follow-up lineage on issue and run detail", async ({ page }) => {
  await page.goto("/");

  const organization = await createOrganization(page);
  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Closeout Runner",
      role: "engineer",
      agentRuntimeType: "process",
      agentRuntimeConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
    },
  });
  expect(agentRes.ok()).toBe(true);
  const agent = await agentRes.json();

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Needs passive closeout",
      description: "The run finished without a close-out signal.",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agent.id,
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json();

  const originRunId = randomUUID();
  const followupRunId = randomUUID();
  const startedAt = new Date("2026-04-24T08:00:00.000Z");
  const finishedAt = new Date("2026-04-24T08:01:00.000Z");
  const queuedAt = new Date("2026-04-24T08:02:00.000Z");

  await e2eDb.insert(heartbeatRuns).values([
    {
      id: originRunId,
      orgId: organization.id,
      agentId: agent.id,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "succeeded",
      startedAt,
      finishedAt,
      contextSnapshot: {
        issueId: issue.id,
        issue: { id: issue.id, title: issue.title, status: issue.status, priority: issue.priority },
      },
      createdAt: startedAt,
      updatedAt: finishedAt,
    },
    {
      id: followupRunId,
      orgId: organization.id,
      agentId: agent.id,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: {
        issueId: issue.id,
        taskId: issue.id,
        taskKey: issue.id,
        wakeReason: "issue_passive_followup",
        wakeSource: "passive_issue_followup",
        issue: { id: issue.id, title: issue.title, status: issue.status, priority: issue.priority },
        passiveFollowup: {
          originRunId,
          previousRunId: originRunId,
          attempt: 1,
          maxAttempts: 2,
          reason: "missing_closure",
          queuedAt: queuedAt.toISOString(),
        },
      },
      createdAt: queuedAt,
      updatedAt: queuedAt,
    },
  ]);

  await e2eDb.insert(activityLog).values({
    orgId: organization.id,
    actorType: "system",
    actorId: "issue_closure_governance",
    action: "issue.passive_followup_queued",
    entityType: "issue",
    entityId: issue.id,
    agentId: agent.id,
    runId: originRunId,
    details: {
      issueId: issue.id,
      issueTitle: issue.title,
      followupRunId,
      originRunId,
      previousRunId: originRunId,
      attempt: 1,
      maxAttempts: 2,
      reason: "missing_closure",
      requestedAt: queuedAt.toISOString(),
    },
    createdAt: queuedAt,
  });

  await page.goto(`/issues/${issue.identifier ?? issue.id}`);
  await expect(page.getByText("Passive follow-up 1/2")).toBeVisible();

  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page.getByText(`queued passive follow-up (1/2) as run ${followupRunId.slice(0, 8)}`)).toBeVisible();

  await page.goto(`/agents/${agent.id}/runs/${followupRunId}`);
  await expect(page.getByText("Passive follow-up", { exact: true })).toBeVisible();
  await expect(page.getByText("attempt 1/2")).toBeVisible();
  await expect(page.getByRole("link", { name: originRunId }).first()).toBeVisible();
});
