import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { activityLog, createDb, heartbeatRuns } from "../../packages/db/src/index.ts";
import { E2E_CODEX_STUB, E2E_DATABASE_URL } from "./support/e2e-env";

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

  await expect(page.getByRole("region", { name: "Activity", exact: true })).toBeVisible();
  await expect(page.getByText(`queued passive follow-up (1/2) as run ${followupRunId.slice(0, 8)}`)).toBeVisible();

  await page.goto(`/agents/${agent.id}/runs/${followupRunId}`);
  await expect(page.getByText("Passive follow-up", { exact: true })).toBeVisible();
  await expect(page.getByText("attempt 1/2")).toBeVisible();
  await expect(page.getByRole("link", { name: originRunId }).first()).toBeVisible();
});

test("preserves current issue metadata in a generated passive follow-up invocation", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");

  const organization = await createOrganization(page);
  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Metadata Runner",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        model: "gpt-5.4",
        command: E2E_CODEX_STUB,
      },
    },
  });
  expect(agentRes.ok()).toBe(true);
  const agent = await agentRes.json() as { id: string };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Preserve passive follow-up metadata",
      description: "The generated prompt must include current issue timestamps.",
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; createdAt: string };

  const assignRes = await page.request.patch(`/api/issues/${issue.id}`, {
    data: { assigneeAgentId: agent.id, assigneeUserId: null },
  });
  expect(assignRes.ok()).toBe(true);

  let passiveRunValue: {
    id: string;
    status: string;
    contextSnapshot?: Record<string, unknown> | null;
  } | null = null;

  await expect.poll(async () => {
    const runsRes = await page.request.get(`/api/orgs/${organization.id}/agent-runs?agentId=${agent.id}&limit=20`);
    if (!runsRes.ok()) return null;
    const runs = await runsRes.json() as Array<{
      id: string;
      status: string;
      contextSnapshot?: Record<string, unknown> | null;
    }>;
    passiveRunValue = runs.find((run) =>
      (run.contextSnapshot as Record<string, unknown> | null)?.wakeReason === "issue_passive_followup",
    ) ?? null;
    return passiveRunValue;
  }, { timeout: 45_000 }).toBeTruthy();

  expect(passiveRunValue).not.toBeNull();
  if (!passiveRunValue) throw new Error("Expected a generated passive follow-up run");
  const issueContext = passiveRunValue.contextSnapshot?.issue as Record<string, unknown>;
  expect(issueContext).toMatchObject({
    createdAt: issue.createdAt,
    assigneeLabel: "Metadata Runner (agent)",
    reviewerLabel: "none",
  });
  expect(issueContext.updatedAt).toEqual(expect.any(String));
  expect(issueContext.updatedAt).not.toBe("unknown");

  await expect.poll(async () => {
    const runsRes = await page.request.get(`/api/orgs/${organization.id}/agent-runs?agentId=${agent.id}&limit=20`);
    if (!runsRes.ok()) return null;
    const runs = await runsRes.json() as Array<{ id: string; status: string }>;
    return runs.find((run) => run.id === passiveRunValue?.id)?.status ?? null;
  }, { timeout: 180_000, intervals: [2_000, 5_000, 10_000] }).toBe("succeeded");

  await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/runs/${passiveRunValue.id}`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("tab", { name: "Metadata" }).click();
  const invocationPrompt = page.getByTestId("invocation-prompt");
  await expect(invocationPrompt).toContainText(`Assignee: Metadata Runner (agent)`);
  await expect(invocationPrompt).toContainText(`Reviewer: none`);
  await expect(invocationPrompt).toContainText(`Created At: ${issue.createdAt}`);
  await expect(invocationPrompt).toContainText(`Updated At: ${issueContext.updatedAt}`);
});
