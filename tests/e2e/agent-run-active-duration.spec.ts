import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq } from "../../packages/db/node_modules/drizzle-orm/index.js";
import { createDb, heartbeatRunEvents, heartbeatRuns } from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

test("keeps an inactive Agent Run alive and warns after 24 hours", async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  const orgResponse = await page.request.post("/api/orgs", {
    data: { name: `Active-Agent-Run-${Date.now()}` },
  });
  expect(orgResponse.ok()).toBe(true);
  const organization = await orgResponse.json() as { id: string };

  const agentResponse = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Long Running Operator",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: { model: "gpt-5.4" },
    },
  });
  expect(agentResponse.ok()).toBe(true);
  const agent = await agentResponse.json() as { id: string };

  const now = new Date();
  const runId = randomUUID();
  const executionOwnerToken = randomUUID();
  const startedAt = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  await e2eDb.insert(heartbeatRuns).values({
    id: runId,
    orgId: organization.id,
    agentId: agent.id,
    invocationSource: "on_demand",
    triggerDetail: "manual",
    status: "running",
    startedAt,
    executionOwnerToken,
    executionLeaseExpiresAt: new Date(now.getTime() + 10 * 60 * 1000),
    stdoutExcerpt: "Still making progress after 24 hours",
    createdAt: startedAt,
    updatedAt: startedAt,
  });
  await e2eDb.insert(heartbeatRunEvents).values({
    orgId: organization.id,
    agentId: agent.id,
    runId,
    seq: 1,
    eventType: "adapter.progress",
    stream: "stdout",
    level: "info",
    message: "Agent Run started",
    createdAt: startedAt,
  });

  await page.addInitScript((orgId: string) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/agents/${agent.id}/runs/${runId}`, { waitUntil: "domcontentloaded" });

  const summary = page.getByTestId("run-summary-card");
  await expect(summary).toContainText("running");
  await expect(page.getByTestId("run-stdout-excerpt")).toContainText("Still making progress after 24 hours");

  // The recovery watchdog runs every 30 seconds in the E2E server. Waiting for
  // a full cycle proves default inactivity handling warns without terminating.
  await page.waitForTimeout(35_000);
  await page.reload({ waitUntil: "domcontentloaded" });

  await expect(page.getByTestId("run-summary-card")).toContainText("running", { timeout: 30_000 });
  await expect(page.getByText("Run has had no recorded activity for 24h 0m; it remains running")).toBeVisible();
  const persistedRun = await e2eDb
    .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .then((rows) => rows[0] ?? null);
  expect(persistedRun).toEqual({ status: "running", errorCode: null });
  await testInfo.attach("long-running-agent-run", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});
