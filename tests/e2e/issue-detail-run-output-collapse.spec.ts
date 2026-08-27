import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createDb, heartbeatRuns } from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL, E2E_INSTANCE_ROOT } from "./support/e2e-env";

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

async function writeRunLog(logRef: string, chunks: Array<{ ts: string; stream: "stdout" | "stderr" | "system"; chunk: string }>) {
  const logPath = path.join(E2E_INSTANCE_ROOT, "data", "run-logs", logRef);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(
    logPath,
    chunks.map((chunk) => JSON.stringify(chunk)).join("\n") + "\n",
    "utf8",
  );
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
  const succeededFinishedAt = new Date("2026-05-07T00:35:00.000Z");

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
      finishedAt: succeededFinishedAt,
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
  await expect(succeededRunCard).toContainText("Ran for 32m");
  await expect(succeededRunCard.getByText("Run", { exact: true })).toHaveCount(0);
  await expect(succeededRunCard).not.toContainText("Show details");
  await expect(succeededRunCard).not.toContainText("No run output captured.");
  const succeededRunBox = await succeededRunCard.boundingBox();
  expect(succeededRunBox?.height).toBeLessThan(42);
  await expect(succeededRunCard).not.toContainText(succeededRunId.slice(0, 8));
  await succeededRunCard.getByRole("link", { name: "Open succeeded run details" }).click();
  await expect(page).toHaveURL(new RegExp(`/agents/[^/]+/runs/${succeededRunId}$`));

  await page.goto(issueUrl);
  const failedRunCard = page.locator(`[data-run-id="${failedRunId}"]`);
  await expect(failedRunCard.getByRole("button", { name: "Show details" })).toBeVisible();
  await expect(failedRunCard).not.toContainText("Show details");
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
  await expect(failedRunCardForExpand).not.toContainText("Hide details");
  await expect(failedRunCardForExpand).toContainText("No run output captured.");
  const expandedRunBox = await failedRunCardForExpand.boundingBox();
  expect(expandedRunBox?.height).toBeGreaterThan((collapsedRunBox?.height ?? 0) + 24);
});

test("shows issue run transcript tool responses without exposing runtime-loaded user instructions", async ({ page }) => {
  const organization = await createOrganization(page);

  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Claude Transcript Agent",
      role: "engineer",
      agentRuntimeType: "claude_local",
      agentRuntimeConfig: {
        model: "claude-sonnet-4-20250514",
        command: "claude",
      },
    },
  });
  expect(agentRes.ok()).toBe(true);
  const agent = await agentRes.json() as { id: string };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Ask what skill do you have",
      description: "The transcript should render runtime output like chat.",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agent.id,
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier: string | null };

  const runId = randomUUID();
  const startedAt = new Date("2026-06-17T08:00:00.000Z");
  const finishedAt = new Date("2026-06-17T08:00:04.000Z");
  const logRef = path.join(organization.id, agent.id, `${runId}.ndjson`);
  await writeRunLog(logRef, [
    {
      ts: "2026-06-17T08:00:01.000Z",
      stream: "stdout",
      chunk: JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "text",
              text: [
                "<rudder_agent_operating_contract>",
                "",
                "Your home directory is $AGENT_HOME. Everything personal to you lives there.",
                "",
                "Use these paths consistently:",
                "- Personal instructions live under $AGENT_HOME/instructions.",
                "</rudder_agent_operating_contract>",
              ].join("\n"),
            },
          ],
        },
      }) + "\n",
    },
    {
      ts: "2026-06-17T08:00:02.000Z",
      stream: "stdout",
      chunk: JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "Tool response visible to the operator.",
              is_error: false,
            },
          ],
        },
      }) + "\n",
    },
    {
      ts: "2026-06-17T08:00:03.000Z",
      stream: "stdout",
      chunk: JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: "I can use the enabled Rudder skills.",
            },
          ],
        },
      }) + "\n",
    },
  ]);

  await e2eDb.insert(heartbeatRuns).values({
    id: runId,
    orgId: organization.id,
    agentId: agent.id,
    invocationSource: "assignment",
    triggerDetail: "system",
    status: "succeeded",
    startedAt,
    finishedAt,
    logStore: "local_file",
    logRef,
    contextSnapshot: {
      issueId: issue.id,
      issue: { id: issue.id, title: "Ask what skill do you have", status: "in_progress", priority: "medium" },
    },
    createdAt: startedAt,
    updatedAt: finishedAt,
  });

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
  const runCard = page.locator(`[data-run-id="${runId}"]`);
  await expect(runCard.getByRole("button", { name: "Show details" })).toBeVisible({ timeout: 15_000 });
  await runCard.getByRole("button", { name: "Show details" }).click();

  await expect(runCard.getByText("Tool response visible to the operator.", { exact: false })).toBeVisible({ timeout: 15_000 });
  await expect(runCard.getByText("I can use the enabled Rudder skills.", { exact: false })).toBeVisible({ timeout: 15_000 });
  await expect(runCard.getByText("Rudder Agent Operating Contract", { exact: false })).toHaveCount(0);
  await expect(runCard.getByText("Use these paths consistently", { exact: false })).toHaveCount(0);
  await expect(runCard.getByText("User", { exact: true })).toHaveCount(0);
});
