import { expect, test, type Page } from "@playwright/test";
import { and, eq } from "../../packages/db/node_modules/drizzle-orm/index.js";
import { agentWakeupRequests, createDb, heartbeatRuns } from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

async function listIssueWakeRuns(page: Page, orgId: string, agentId: string, issueId: string) {
  const response = await page.request.get(
    `/api/orgs/${orgId}/heartbeat-runs?agentId=${agentId}&limit=100`,
  );
  expect(response.ok(), await response.text()).toBe(true);
  const runs = await response.json() as Array<{ contextSnapshot?: Record<string, unknown> | null }>;
  return runs.filter((run) => run.contextSnapshot?.issueId === issueId);
}

async function listIssueWakeRecords(orgId: string, agentId: string, issueId: string) {
  const [runs, wakeups] = await Promise.all([
    e2eDb.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.orgId, orgId),
      eq(heartbeatRuns.agentId, agentId),
    )),
    e2eDb.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.orgId, orgId),
      eq(agentWakeupRequests.agentId, agentId),
    )),
  ]);
  return {
    runs: runs.filter((run) => run.contextSnapshot?.issueId === issueId),
    wakeups: wakeups.filter((wakeup) => (
      typeof wakeup.payload === "object" &&
      wakeup.payload !== null &&
      (wakeup.payload as Record<string, unknown>).issueId === issueId
    )),
  };
}

test.describe("Issue cancellation routing", () => {
  test("cancelling a backlog issue does not enqueue an agent run", async ({ page }) => {
    test.setTimeout(120_000);

    const organizationResponse = await page.request.post("/api/orgs", {
      data: { name: `Issue-Cancel-No-Wakeup-${Date.now()}` },
    });
    expect(organizationResponse.ok(), await organizationResponse.text()).toBe(true);
    const organization = await organizationResponse.json() as { id: string; issuePrefix: string };

    const agentResponse = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Cancellation routing agent",
        role: "engineer",
        agentRuntimeType: "process",
        agentRuntimeConfig: {
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
        },
      },
    });
    expect(agentResponse.ok(), await agentResponse.text()).toBe(true);
    const agent = await agentResponse.json() as { id: string };

    const issueResponse = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Cancelled backlog issue must stay stopped",
        description: "Cancelling this issue must not create a compensating Agent Run.",
        status: "backlog",
        priority: "medium",
        assigneeAgentId: agent.id,
      },
    });
    expect(issueResponse.ok(), await issueResponse.text()).toBe(true);
    const issue = await issueResponse.json() as { id: string; identifier: string | null };

    expect(await listIssueWakeRuns(page, organization.id, agent.id, issue.id)).toHaveLength(0);

    await page.goto(`/issues/${issue.identifier ?? issue.id}`);
    const properties = page.getByRole("region", { name: "Issue properties" });
    const statusTrigger = properties.getByRole("button", { name: "Backlog", exact: true });
    await expect(statusTrigger).toBeVisible({ timeout: 20_000 });
    await statusTrigger.click();

    const statusMenu = page.getByRole("menu", { name: "Issue status" });
    await expect(statusMenu).toBeVisible();
    const statusResponse = page.waitForResponse((response) =>
      (response.url().endsWith(`/api/issues/${issue.id}`)
        || (issue.identifier !== null && response.url().endsWith(`/api/issues/${issue.identifier}`))) &&
      response.request().method() === "PATCH" &&
      response.ok(),
    );
    await statusMenu.getByRole("menuitemradio", { name: "Cancelled", exact: true }).click();
    await statusResponse;

    await expect(properties.getByRole("button", { name: "Cancelled", exact: true })).toBeVisible();
    await page.waitForTimeout(1_500);
    expect(await listIssueWakeRuns(page, organization.id, agent.id, issue.id)).toHaveLength(0);
    const wakeRecords = await listIssueWakeRecords(organization.id, agent.id, issue.id);
    expect(wakeRecords.runs).toHaveLength(0);
    expect(wakeRecords.wakeups).toHaveLength(0);

    const refreshedIssueResponse = await page.request.get(`/api/issues/${issue.id}`);
    expect(refreshedIssueResponse.ok(), await refreshedIssueResponse.text()).toBe(true);
    expect((await refreshedIssueResponse.json()).status).toBe("cancelled");
  });
});
